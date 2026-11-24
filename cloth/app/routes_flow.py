"""AI 生成（P04）、专家评审（P05）、对比选择（P06）、修订（P07）、定稿存证（P08）。"""
from __future__ import annotations

import json
import re
import statistics
import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from . import ai, defaults, worker
from .core import DEMO, audit, current_user, file_bytes, need_lead, project_for, save_file, sm3, store
from .routes_project import guard_archived, round_complete, touch
from .routes_spec import new_draft, version_view, versions
from .worker import spec_fields

r = APIRouter(prefix="/api")
GEN_MODELS = ["nb2", "sd", "gpt", "qwen"]


def users_map():
    return {x["id"]: x["name"] for x in store.list("users")}


# ================================================================ P04 生成

class NewJob(BaseModel):
    stage: str = "draft"
    view: str = "front"
    per_model: int = 2
    models: list[str] = GEN_MODELS
    ref_run_id: str | None = None
    group: str | None = None           # 仅实验模式
    seed: int | None = None            # 仅实验模式
    prompt_override: str | None = None  # 仅实验模式


def latest_signed(pid: str) -> dict | None:
    return next((v for v in reversed(versions(pid)) if v["status"] == "signed"), None)


def decided_run(pid: str) -> str | None:
    ds = sorted(store.list("decisions", project_id=pid), key=lambda d: d["_created"])
    return ds[-1]["run_id"] if ds else None


@r.post("/projects/{pid}/jobs")
def create_job(pid: str, body: NewJob, u=Depends(current_user)):
    p = project_for(pid, u)
    guard_archived(p)
    experiment = bool(body.group or body.seed or body.prompt_override) or body.stage == "experiment"
    if experiment and u["role"] != "tech":
        raise HTTPException(403, "实验模式仅技术角色可用")
    if body.stage not in ("draft", "revise", "experiment"):
        raise HTTPException(400, "展示应用请到合拍模板页")
    if body.view not in defaults.VIEW_NAME or not 1 <= body.per_model <= 4:
        raise HTTPException(400, "视角或张数无效")
    models = [m for m in body.models if m in GEN_MODELS]
    if not models:
        raise HTTPException(400, "至少选择一个模型")
    v = latest_signed(pid)
    if not v:
        raise HTTPException(400, "规格书尚未签署，不能生成")
    ref, revisions = body.ref_run_id, []
    if body.stage == "draft" and v["no"] != 1 and not experiment:
        v = next(x for x in versions(pid) if x["no"] == 1 and x["status"] == "signed")
    if body.stage == "revise":
        if v["no"] < 2:
            raise HTTPException(400, "修订重生成需要已签署的 V2 及以上规格书")
        ref = ref or decided_run(pid)
        if not ref:
            raise HTTPException(400, "请先在对比选择页确定入选版本")
        revisions = [x.get("final_text") or x["change"] for x in store.list("revisions", project_id=pid)
                     if x["status"] in ("accepted", "modified") and x.get("version_no") == v["no"]]
    if body.view != "front" and not ref:
        ref = decided_run(pid)
        if not ref:
            raise HTTPException(400, "侧面、背面以正面入选图为参考，请先确定入选版本")
    group = body.group or defaults.GROUP_OF_STAGE[body.stage]
    job = store.insert("gen_jobs", {"project_id": pid, "stage": body.stage, "group": group, "view": body.view, "per_model": body.per_model,
                                    "models": models, "spec_version_id": v["id"], "spec_version_no": v["no"], "ref_run_id": ref,
                                    "revisions": revisions, "seed": body.seed, "prompt_override": body.prompt_override,
                                    "created_by": u["id"], "created_by_name": u["name"]})
    for m in models:
        t = store.insert("gen_tasks", {"job_id": job["id"], "project_id": pid, "model": m, "status": "queued", "done": 0, "total": body.per_model})
        worker.submit(t["id"])
    audit(u, "发起生成", f"{defaults.STAGE_NAME[body.stage]} · {defaults.VIEW_NAME[body.view]} · {len(models)} 个模型", project=pid)
    touch(pid)
    return job


@r.get("/models-available")
def models_available(u=Depends(current_user)):
    """可用于生成的模型：已启用，且已配置密钥（本地 ComfyUI 无需密钥；演示模式下全部可用）。"""
    from .core import model_cfg
    out = []
    for code in GEN_MODELS:
        m = model_cfg(code)
        if m and m.get("enabled", True) and (m.get("key") or m["kind"] == "comfyui" or DEMO):
            out.append(code)
    return out


@r.get("/projects/{pid}/jobs")
def jobs(pid: str, u=Depends(current_user)):
    project_for(pid, u)
    out = []
    for j in sorted(store.list("gen_jobs", project_id=pid), key=lambda j: -j["_created"]):
        if j["stage"] == "experiment" and u["role"] != "tech":
            continue
        out.append(dict(j, tasks=store.list("gen_tasks", job_id=j["id"])))
    return out


@r.post("/gen-tasks/{tid}/retry")
def retry(tid: str, u=Depends(current_user)):
    t = store.get("gen_tasks", tid) or {}
    project_for(t["project_id"], u)
    if t.get("status") != "failed":
        raise HTTPException(400, "只有失败的任务可以重试")
    store.update("gen_tasks", tid, {"status": "queued", "error": None, "done": 0})
    worker.submit(tid)
    return {"ok": True}


def run_view(x: dict, u: dict, blind_ids: set | None = None) -> dict:
    d = dict(x)
    if blind_ids is not None and x["id"] in blind_ids:
        for k in ("model", "model_name", "model_version", "prompt", "negative", "seed"):
            d.pop(k, None)
    if x.get("stage") == "experiment" and u["role"] != "tech":
        return None
    if u["role"] != "tech":
        d.pop("prompt", None), d.pop("negative", None)
    return d


@r.get("/projects/{pid}/runs")
def runs(pid: str, u=Depends(current_user)):
    project_for(pid, u)
    out = [run_view(x, u) for x in sorted(store.list("runs", project_id=pid), key=lambda x: x["_created"])]
    return [x for x in out if x]


NAME_RE = re.compile(r"(E[0-4])_(nb2|nbpro|sd|gpt|qwen)_(front|side|back)", re.I)


@r.post("/projects/{pid}/runs/upload")
async def upload_runs(pid: str, files: list[UploadFile] = File(...), stage: str = Form("draft"), model: str = Form("qwen"),
                      view: str = Form("front"), variant: str = Form(""), seconds: float | None = Form(None), u=Depends(current_user)):
    p = project_for(pid, u)
    guard_archived(p)
    v = latest_signed(pid)
    out = []
    stage_of = {"E1": "draft", "E2": "draft", "E3": "revise", "E0": "experiment"}
    for f in files:
        if f.content_type not in ("image/png", "image/jpeg", "image/webp"):
            continue
        data = await f.read()
        m = NAME_RE.search(f.filename or "")
        st, md, vw, grp = stage, model, view, defaults.GROUP_OF_STAGE.get(stage, "E2")
        if m:
            grp, md, vw = m.group(1).upper(), m.group(2).lower().replace("nbpro", "nb2"), m.group(3).lower()
            st = stage_of.get(grp, "draft")
        fr = save_file(data, f.content_type, u["id"], f.filename or "")
        names = {"nb2": "Nano Banana", "sd": "Seedream", "gpt": "GPT Image", "qwen": "Qwen-Image-Edit（本地）"}
        out.append(store.insert("runs", {"project_id": pid, "stage": st, "group": grp, "model": md, "model_name": names.get(md, md),
                                         "model_version": variant, "view": vw, "spec_version_id": v["id"] if v else None,
                                         "spec_version": v["no"] if v else None, "file_id": fr["id"], "seconds": seconds,
                                         "source": "upload", "file_name": f.filename, "by": u["id"]}))
    audit(u, "手动上传生成图", f"{len(out)} 张", project=pid)
    return out


# ================================================================ P05 评审

class TemplateBody(BaseModel):
    name: str
    category: str
    dims: list[dict]


@r.get("/review-templates")
def templates(u=Depends(current_user)):
    return store.list("review_templates")


@r.post("/review-templates")
def save_template(body: TemplateBody, u=Depends(current_user)):
    if u["role"] != "lead":
        raise HTTPException(403, "仅主审专家可维护评审模板")
    for d in body.dims:
        if not d.get("code") or not d.get("name") or d.get("scale") not in (2, 5) or float(d.get("weight", 0)) <= 0:
            raise HTTPException(400, "每个维度需有编号、名称、正权重，分制为 0–2 或 0–5")
    same = [t for t in store.list("review_templates") if t["name"] == body.name]
    version = max([t["version"] for t in same] + [0]) + 1
    t = store.insert("review_templates", {"name": body.name, "category": body.category, "dims": body.dims, "version": version, "locked": False})
    audit(u, "保存评审模板", f"{body.name} v{version}")
    return t


class NewRound(BaseModel):
    run_ids: list[str]
    expert_ids: list[str]
    template_id: str
    deadline: float | None = None
    blind: bool = False


@r.post("/projects/{pid}/rounds")
def create_round(pid: str, body: NewRound, u=Depends(current_user)):
    p = project_for(pid, u)
    need_lead(p, u)
    t = store.get("review_templates", body.template_id)
    if not t or not body.run_ids or not body.expert_ids:
        raise HTTPException(400, "请选择候选图、评审专家和评审模板")
    allowed = set(p.get("expert_ids", [])) | {p["lead_id"]}
    if any(e not in allowed for e in body.expert_ids):
        raise HTTPException(400, "评审专家须为本项目成员")
    store.update("review_templates", t["id"], {"locked": True})
    rd = store.insert("review_rounds", {"project_id": pid, "run_ids": body.run_ids, "expert_ids": body.expert_ids,
                                        "template_id": t["id"], "template": {"name": t["name"], "version": t["version"], "dims": t["dims"]},
                                        "deadline": body.deadline, "blind": body.blind, "created_by": u["id"]})
    audit(u, "发起评审", f"{len(body.run_ids)} 张 × {len(body.expert_ids)} 位专家", project=pid)
    return rd


def blind_label(rd: dict, run_id: str) -> str:
    return "候选 " + chr(65 + rd["run_ids"].index(run_id)) if run_id in rd["run_ids"] else "候选"


def weighted(scores: dict, dims: list[dict]) -> float | None:
    if any(scores.get(d["code"]) is None for d in dims if d.get("required", True)):
        return None
    num = sum(float(d["weight"]) * float(scores.get(d["code"]) or 0) for d in dims)
    den = sum(float(d["weight"]) * d["scale"] for d in dims)
    return round(num / den * 100, 1) if den else None


def summary(rd: dict) -> dict:
    """每张图、每个维度的专家平均分、标准差、分歧；只统计已提交的评审。"""
    dims = rd["template"]["dims"]
    names = users_map()
    out = {}
    for run_id in rd["run_ids"]:
        revs = [x for x in store.list("reviews", round_id=rd["id"], run_id=run_id) if x.get("submitted")]
        per_dim = []
        for d in dims:
            vals = [x["scores"].get(d["code"]) for x in revs if x["scores"].get(d["code"]) is not None]
            per_dim.append({"code": d["code"], "name": d["name"], "mean": round(statistics.mean(vals), 2) if vals else None,
                            "std": round(statistics.pstdev(vals), 2) if len(vals) > 1 else 0,
                            "by": {names.get(x["expert_id"]): x["scores"].get(d["code"]) for x in revs},
                            "divergent": len(vals) > 1 and max(vals) - min(vals) >= 2})
        verdicts = [x.get("verdict") for x in revs]
        means = {pd["code"]: pd["mean"] for pd in per_dim}
        base = weighted(means, dims) if revs else None
        forbid = {}
        for x in revs:
            for item in x.get("forbidden", []):
                forbid[item] = forbid.get(item, 0) + 1
        confirmed = [k for k, n in forbid.items() if n * 2 > len(revs)]
        score = None if base is None else round(max(0, base - 15 * len(confirmed)), 1)
        out[run_id] = {"n": len(revs), "dims": per_dim, "score": score, "forbidden": confirmed, "verdicts": verdicts,
                       "verdict_divergent": len(set(verdicts)) > 1}
    return out


@r.get("/projects/{pid}/rounds")
def rounds(pid: str, u=Depends(current_user)):
    p = project_for(pid, u)
    names = users_map()
    out = []
    for rd in sorted(store.list("review_rounds", project_id=pid), key=lambda x: -x["_created"]):
        prog = {}
        for e in rd["expert_ids"]:
            prog[names.get(e, e)] = len([x for x in store.list("reviews", round_id=rd["id"], expert_id=e) if x.get("submitted")])
        complete = round_complete(rd)
        visible = complete
        d = dict(rd, progress=prog, complete=complete, total=len(rd["run_ids"]), mine=u["id"] in rd["expert_ids"])
        if visible:
            d["summary"] = summary(rd)
        out.append(d)
    return out


@r.get("/rounds/{rid}/sheet/{run_id}")
def sheet(rid: str, run_id: str, u=Depends(current_user)):
    """评审单：本人评分；全部提交后附他人评分与汇总；盲评隐藏模型名。"""
    rd = store.get("review_rounds", rid) or {}
    p = project_for(rd["project_id"], u)
    run = store.get("runs", run_id)
    blind = rd.get("blind") and not round_complete(rd)
    rv = run_view(run, u, {run_id} if blind else None)
    if blind:
        rv["label"] = blind_label(rd, run_id)
    mine = next(iter(store.list("reviews", round_id=rid, run_id=run_id, expert_id=u["id"])), None)
    ai_rev = next(iter(store.list("ai_reviews", run_id=run_id)), None)
    data = {"round": {k: rd[k] for k in ("id", "template", "blind", "deadline", "expert_ids", "run_ids")}, "run": rv, "mine": mine,
            "ai": ai_rev, "complete": round_complete(rd)}
    if round_complete(rd):
        names = users_map()
        data["others"] = [dict(x, expert=names.get(x["expert_id"])) for x in store.list("reviews", round_id=rid, run_id=run_id) if x.get("submitted")]
        data["summary"] = summary(rd)[run_id]
    return data


class ReviewBody(BaseModel):
    scores: dict
    notes: dict = {}
    annotations: list = []
    forbidden: list = []
    opinion: str = ""
    suggestions: list = []
    verdict: str | None = None
    submit: bool = False


@r.put("/rounds/{rid}/reviews/{run_id}")
def save_review(rid: str, run_id: str, body: ReviewBody, u=Depends(current_user)):
    rd = store.get("review_rounds", rid) or {}
    p = project_for(rd["project_id"], u)
    if u["id"] not in rd["expert_ids"]:
        raise HTTPException(403, "你不在本轮评审名单中")
    if run_id not in rd["run_ids"]:
        raise HTTPException(400, "候选图不在本轮评审中")
    if rd.get("deadline") and rd["deadline"] < time.time():
        raise HTTPException(400, "评审已截止")
    dims = {d["code"]: d for d in rd["template"]["dims"]}
    for k, v in body.scores.items():
        if k not in dims or (v is not None and not 0 <= v <= dims[k]["scale"]):
            raise HTTPException(400, f"{k} 分值超出范围")
    if body.submit:
        missing = [c for c, d in dims.items() if d.get("required", True) and body.scores.get(c) is None]
        if missing:
            raise HTTPException(400, "还有必评项未打分：" + "、".join(missing))
        if body.verdict not in ("通过", "重新生成", "退回改规格书"):
            raise HTTPException(400, "请给出结论")
    for s in body.suggestions:
        if not re.match(r"^F\d+$", str(s.get("field", ""))) or not s.get("change"):
            raise HTTPException(400, "修订建议需注明字段编号和内容")
    data = dict(body.model_dump(exclude={"submit"}), round_id=rid, run_id=run_id, expert_id=u["id"], project_id=p["id"],
                submitted=body.submit, submitted_at=time.time() if body.submit else None)
    cur = next(iter(store.list("reviews", round_id=rid, run_id=run_id, expert_id=u["id"])), None)
    rev = store.update("reviews", cur["id"], data) if cur else store.insert("reviews", data)
    if body.submit:
        for s in body.suggestions:
            dup = [x for x in store.list("revisions", project_id=p["id"]) if x.get("review_id") == rev["id"] and x["field"] == s["field"]]
            if not dup:
                store.insert("revisions", {"project_id": p["id"], "field": s["field"], "change": s["change"], "reason": s.get("reason", ""),
                                           "proposer_id": u["id"], "proposer": u["name"], "run_id": run_id, "review_id": rev["id"], "status": "pending"})
        audit(u, "提交评审", run_id, after={"verdict": body.verdict}, project=p["id"])
    return rev


@r.post("/rounds/{rid}/reviews/{run_id}/withdraw")
def withdraw(rid: str, run_id: str, u=Depends(current_user)):
    rd = store.get("review_rounds", rid) or {}
    project_for(rd["project_id"], u)
    if rd.get("deadline") and rd["deadline"] < time.time():
        raise HTTPException(400, "已过截止时间，不能撤回")
    cur = next(iter(store.list("reviews", round_id=rid, run_id=run_id, expert_id=u["id"])), None)
    if not cur:
        raise HTTPException(404, "没有可撤回的评审")
    if round_complete(rd):
        raise HTTPException(400, "全部专家已提交，不能撤回")
    store.update("reviews", cur["id"], {"submitted": False})
    return {"ok": True}


AI_REVIEW_PROMPT = """你是中国古代服饰史专家。图1是复原依据的文物画像，图2是 AI 复原候选图。按下列评分项逐项打分（只看图2可见内容），
并列出出现的禁用元素。评分项：{dims}
禁用元素：{forbid}
只回复 JSON：{{"scores":{{"C1":2}},"forbidden":["盘扣"],"summary":"两三句评价"}}"""


@r.post("/runs/{run_id}/ai-review")
def ai_review(run_id: str, template_id: str, u=Depends(current_user)):
    run = store.get("runs", run_id) or {}
    p = project_for(run["project_id"], u)
    t = store.get("review_templates", template_id)
    ps = worker.primary_source(p["id"])
    if not ps:
        raise HTTPException(400, "缺少主史料")
    f12 = next((f for f in spec_fields(run["spec_version_id"]) if f["code"] == "F12"), {}) if run.get("spec_version_id") else {}
    try:
        adapter, cfg, mocked = worker.adapter_for("vision")
        if mocked:
            raise ai.ModelError("视觉模型未配置密钥（系统设置 → 模型接入）")
        ans = ai.parse_json_block(adapter.ask(AI_REVIEW_PROMPT.format(
            dims="；".join(f"{d['code']} {d['name']}（0–{d['scale']} 分）" for d in t["dims"]), forbid=f12.get("content", "")),
            [file_bytes(ps["file_id"]), file_bytes(run["file_id"])]))
    except ai.ModelError as e:
        raise HTTPException(503, str(e))
    except (ValueError, KeyError):
        raise HTTPException(502, "视觉模型返回格式无法解析，请重试")
    for old in store.list("ai_reviews", run_id=run_id):
        store.delete("ai_reviews", old["id"])
    return store.insert("ai_reviews", {"run_id": run_id, "template_id": template_id, "scores": ans.get("scores", {}),
                                       "forbidden": ans.get("forbidden", []), "summary": ans.get("summary", ""), "model": cfg["name"]})


# ================================================================ P06 对比选择

@r.get("/projects/{pid}/compare")
def compare(pid: str, u=Depends(current_user)):
    p = project_for(pid, u)
    rds = [rd for rd in store.list("review_rounds", project_id=pid) if round_complete(rd)]
    names = users_map()
    scored = {}
    for rd in rds:
        for run_id, s in summary(rd).items():
            if s["score"] is not None:
                scored[run_id] = dict(s, round_id=rd["id"], dims_def=rd["template"]["dims"])
    runs_ = {x["id"]: x for x in store.list("runs", project_id=pid)}
    matrix = {}
    for run_id, s in scored.items():
        x = runs_[run_id]
        key = (x["stage"], x["model"])
        cell = matrix.setdefault(key, {"stage": x["stage"], "model": x["model"], "model_name": x.get("model_name"), "scores": [], "forbidden": 0, "best": None})
        cell["scores"].append(s["score"])
        cell["forbidden"] += len(s["forbidden"])
        if cell["best"] is None or s["score"] > scored[cell["best"]]["score"]:
            cell["best"] = run_id
    cells = [dict(c, mean=round(sum(c["scores"]) / len(c["scores"]), 1)) for c in matrix.values()]
    votes = store.list("votes", project_id=pid)
    tally = {}
    for v in votes:
        tally[v["first"]] = tally.get(v["first"], 0) + 1
    ranked = sorted(scored.items(), key=lambda kv: (-kv[1]["score"], -tally.get(kv[0], 0)))[:3]
    recs = []
    for run_id, s in ranked:
        best_dim = max(s["dims"], key=lambda d: (d["mean"] or 0) / next(dd["scale"] for dd in s["dims_def"] if dd["code"] == d["code"]))
        passes = s["verdicts"].count("通过")
        reason = f"{best_dim['code']} {best_dim['name']} 得分最高；" + ("无禁用元素；" if not s["forbidden"] else f"禁用元素：{'、'.join(s['forbidden'])}；") \
            + f"{s['n']} 位专家中 {passes} 位结论为通过"
        recs.append({"run": runs_[run_id], "score": s["score"], "reason": reason, "votes": tally.get(run_id, 0)})
    decisions = sorted(store.list("decisions", project_id=pid), key=lambda d: d["_created"])
    return {"matrix": cells, "recommendations": recs, "votes": [dict(v, expert=names.get(v["expert_id"])) for v in votes],
            "tally": tally, "decision": decisions[-1] if decisions else None, "scored": {k: v["score"] for k, v in scored.items()}}


class Vote(BaseModel):
    first: str
    backups: list[str] = []
    reason: str = ""
    dissent: str = ""


@r.put("/projects/{pid}/vote")
def vote(pid: str, body: Vote, u=Depends(current_user)):
    p = project_for(pid, u)
    if u["id"] not in p.get("expert_ids", []) + [p["lead_id"]]:
        raise HTTPException(403, "仅本项目专家可推荐")
    if not store.get("runs", body.first):
        raise HTTPException(400, "候选图不存在")
    cur = next(iter(store.list("votes", project_id=pid, expert_id=u["id"])), None)
    data = dict(body.model_dump(), project_id=pid, expert_id=u["id"])
    v = store.update("votes", cur["id"], data) if cur else store.insert("votes", data)
    audit(u, "专家推荐", body.first, after=body.reason, project=pid)
    return v


class Decision(BaseModel):
    run_id: str
    reason: str = ""


@r.post("/projects/{pid}/decision")
def decide(pid: str, body: Decision, u=Depends(current_user)):
    p = project_for(pid, u)
    need_lead(p, u)
    c = compare(pid, u)
    if body.run_id not in c["scored"]:
        raise HTTPException(400, "入选版本须有专家评分")
    top = c["recommendations"][0]["run"]["id"] if c["recommendations"] else None
    if body.run_id != top and not body.reason.strip():
        raise HTTPException(400, "与系统推荐第一名不一致，请填写理由")
    rd = next((rd for rd in store.list("review_rounds", project_id=pid) if body.run_id in rd["run_ids"]), None)
    d = store.insert("decisions", {"project_id": pid, "run_id": body.run_id, "reason": body.reason.strip(), "system_top": top,
                                   "differs": body.run_id != top, "score": c["scored"][body.run_id], "round_id": rd["id"] if rd else None,
                                   "by": u["id"], "by_name": u["name"]})
    audit(u, "确定入选版本", body.run_id, after=body.reason, project=pid)
    touch(pid)
    return d


# ================================================================ P07 修订

@r.get("/projects/{pid}/revisions")
def revisions(pid: str, u=Depends(current_user)):
    project_for(pid, u)
    items = sorted(store.list("revisions", project_id=pid), key=lambda x: (int(x["field"][1:]) if x["field"][1:].isdigit() else 99, x["_created"]))
    groups = {}
    for x in items:
        groups.setdefault(x["field"], []).append(x)
    return [{"field": k, "items": v} for k, v in groups.items()]


class ManualRev(BaseModel):
    field: str
    change: str
    reason: str = "主审手动补充"


@r.post("/projects/{pid}/revisions")
def add_revision(pid: str, body: ManualRev, u=Depends(current_user)):
    p = project_for(pid, u)
    need_lead(p, u)
    if not re.match(r"^F\d+$", body.field):
        raise HTTPException(400, "字段编号格式为 F 加数字")
    return store.insert("revisions", dict(body.model_dump(), project_id=pid, proposer_id=u["id"], proposer=u["name"], status="pending"))


class Handle(BaseModel):
    action: str          # accept | modify | reject
    text: str = ""
    reason: str = ""


@r.post("/revisions/{xid}")
def handle_revision(xid: str, body: Handle, u=Depends(current_user)):
    x = store.get("revisions", xid) or {}
    p = project_for(x["project_id"], u)
    need_lead(p, u)
    if x["status"] != "pending":
        raise HTTPException(400, "该建议已处理")
    if body.action == "reject":
        if not body.reason.strip():
            raise HTTPException(400, "驳回须填写原因")
        store.update("revisions", xid, {"status": "rejected", "reject_reason": body.reason, "by": u["name"]})
        audit(u, "驳回修订", x["field"], after=body.reason, project=p["id"])
        return store.get("revisions", xid)
    text = body.text.strip() if body.action == "modify" else x["change"]
    if not text:
        raise HTTPException(400, "修改后采纳须填写内容")
    draft = new_draft(p, u)
    f = next((f for f in store.list("spec_fields", version_id=draft["id"]) if f["code"] == x["field"]), None)
    if f:
        store.update("spec_fields", f["id"], {"content": text, "status": "pending", "checked_by": None, "updated_by": u["name"]})
    else:
        store.insert("spec_fields", {"version_id": draft["id"], "project_id": p["id"], "code": x["field"], "name": "专家补充", "content": text,
                                     "level": "L3", "source_ids": [], "status": "pending", "na": False, "custom": True, "updated_by": u["name"]})
    store.update("revisions", xid, {"status": "accepted" if body.action == "accept" else "modified", "final_text": text,
                                    "version_no": draft["no"], "by": u["name"]})
    audit(u, "采纳修订", x["field"], after=text, project=p["id"])
    return store.get("revisions", xid)


@r.get("/projects/{pid}/v-compare")
def v_compare(pid: str, u=Depends(current_user)):
    """各规格书版本的最佳图（按推荐分）。"""
    project_for(pid, u)
    c = compare(pid, u)
    best = {}
    for x in store.list("runs", project_id=pid):
        s = c["scored"].get(x["id"])
        if s is None or x.get("view") != "front":
            continue
        k = x.get("spec_version") or 1
        if k not in best or s > best[k]["score"]:
            best[k] = {"run": x, "score": s}
    return [dict(v, version=k) for k, v in sorted(best.items())]


# ================================================================ P08 定稿存证

class NewFinal(BaseModel):
    run_ids: list[str]
    license: str
    cosigner_ids: list[str] = []


def final_payload(p: dict, runs_: list[dict], decision: dict | None) -> tuple[bytes, dict]:
    v = store.get("spec_versions", runs_[0]["spec_version_id"]) if runs_[0].get("spec_version_id") else None
    reviews = [{k: x.get(k) for k in ("expert_id", "run_id", "scores", "annotations", "forbidden", "opinion", "verdict")}
               for x in store.list("reviews", project_id=p["id"]) if x.get("submitted")]
    meta = {"project": p["id"], "spec_version": v["no"] if v else None,
            "spec_fields": [{k: f[k] for k in ("code", "content", "level")} for f in spec_fields(v["id"])] if v else [],
            "reviews": sorted(reviews, key=lambda r_: (r_["run_id"], r_["expert_id"])),
            "decision": {k: decision.get(k) for k in ("run_id", "reason", "system_top")} if decision else None}
    blob = b"".join(file_bytes(x["file_id"]) for x in runs_) + json.dumps(meta, ensure_ascii=False, sort_keys=True).encode()
    return blob, meta


@r.post("/projects/{pid}/finals")
def create_final(pid: str, body: NewFinal, u=Depends(current_user)):
    p = project_for(pid, u)
    need_lead(p, u)
    if body.license not in defaults.LICENSES:
        raise HTTPException(400, "授权等级无效")
    c = compare(pid, u)
    decision = c["decision"]
    runs_ = [store.get("runs", i) for i in body.run_ids]
    if not runs_ or any(x is None or x["project_id"] != pid for x in runs_):
        raise HTTPException(400, "定稿图无效")
    if any(x["id"] not in c["scored"] and not (decision and x["id"] == decision["run_id"]) for x in runs_ if x["view"] == "front"):
        raise HTTPException(400, "正面定稿图须为已评审的入选或修订版本")
    for f in store.list("finals", project_id=pid):
        if f.get("status") in ("active", "cosigning"):
            raise HTTPException(400, "已有有效定稿，请先撤销")
    blob, meta = final_payload(p, runs_, decision)
    algo, digest = sm3(blob)
    n = len(store.list("finals")) + 1
    status = "cosigning" if body.cosigner_ids else "active"
    fin = store.insert("finals", {"project_id": pid, "run_ids": body.run_ids, "license": body.license, "algo": algo, "hash": digest,
                                  "meta": meta, "signer_id": u["id"], "signer": u["name"], "signed_at": time.time(),
                                  "cosigners": {c_: None for c_ in body.cosigner_ids}, "status": status,
                                  "asset_no": f"YG-{time.strftime('%Y')}-{n:04d}", "score": c["scored"].get(body.run_ids[0]),
                                  "nodes": ["国博节点", "咪咕节点"]})
    audit(u, "签署定稿", fin["asset_no"], after={"hash": digest, "license": body.license}, project=pid)
    touch(pid)
    return final_view(fin)


def final_view(f: dict) -> dict:
    names = users_map()
    return dict(f, runs=[store.get("runs", i) for i in f["run_ids"]], cosigner_names={names.get(k, k): v for k, v in f.get("cosigners", {}).items()})


@r.get("/projects/{pid}/finals")
def finals(pid: str, u=Depends(current_user)):
    project_for(pid, u)
    return [final_view(f) for f in sorted(store.list("finals", project_id=pid), key=lambda f: -f["_created"])]


@r.post("/finals/{fid}/cosign")
def final_cosign(fid: str, u=Depends(current_user)):
    f = store.get("finals", fid) or {}
    project_for(f["project_id"], u)
    if u["id"] not in f.get("cosigners", {}):
        raise HTTPException(403, "你不是会签专家")
    cs = dict(f["cosigners"], **{u["id"]: time.time()})
    store.update("finals", fid, {"cosigners": cs, "status": "active" if all(cs.values()) else "cosigning"})
    audit(u, "会签定稿", f["asset_no"], project=f["project_id"])
    return final_view(store.get("finals", fid))


@r.post("/finals/{fid}/verify")
def verify(fid: str, u=Depends(current_user)):
    f = store.get("finals", fid) or {}
    p = project_for(f["project_id"], u)
    runs_ = [store.get("runs", i) for i in f["run_ids"]]
    decision = next((d for d in sorted(store.list("decisions", project_id=p["id"]), key=lambda d: -d["_created"])
                     if d["_created"] <= f["_created"]), None)
    blob, _ = final_payload(p, runs_, decision)
    algo, digest = sm3(blob)
    return {"ok": digest == f["hash"], "algo": algo, "hash": digest, "stored": f["hash"]}


class Revoke(BaseModel):
    reason: str


@r.post("/finals/{fid}/revoke")
def revoke(fid: str, body: Revoke, u=Depends(current_user)):
    f = store.get("finals", fid) or {}
    p = project_for(f["project_id"], u)
    need_lead(p, u)
    if not body.reason.strip():
        raise HTTPException(400, "撤销须填写原因")
    store.update("finals", fid, {"status": "revoked", "revoked": True, "revoke_reason": body.reason, "revoked_at": time.time()})
    for t in store.list("templates", final_id=fid):
        store.update("templates", t["id"], {"status": "offline", "offline_reason": "定稿已撤销"})
    audit(u, "撤销定稿", f["asset_no"], after=body.reason, project=p["id"])
    return {"ok": True}


@r.get("/finals/{fid}/report", response_class=HTMLResponse)
def report(fid: str, u=Depends(current_user)):
    """复原报告：浏览器打开后“打印 → 另存为 PDF”。"""
    import html as h
    f = store.get("finals", fid) or {}
    p = project_for(f["project_id"], u)
    srcs = store.list("sources", project_id=p["id"])
    fields = f["meta"]["spec_fields"]
    rows = "".join(f"<tr><td>{s['title']}</td><td>{s.get('museum','')}</td><td>{s.get('license','')}</td><td>{s.get('url') or s.get('sha256','')[:16]}</td></tr>" for s in srcs)
    frows = "".join(f"<tr><td>{x['code']}</td><td>{h.escape(x['content'])}</td><td>{defaults.LEVELS.get(x['level'], x['level'])}</td></tr>" for x in fields)
    imgs = "".join(f"<img src='/api/files/{x['file_id']}' style='max-width:32%;margin:4px'>" for x in final_view(f)["runs"])
    dec = f["meta"].get("decision") or {}
    return f"""<!doctype html><meta charset=utf-8><title>复原报告 {f['asset_no']}</title>
<style>body{{font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;max-width:900px;margin:24px auto;color:#16202B}}table{{width:100%;border-collapse:collapse;font-size:13px}}td,th{{border:1px solid #ccd;padding:6px}}h1{{font-family:serif}}</style>
<h1>{h.escape(p['name'])} · 复原报告</h1><p>资产 ID {f['asset_no']} · 授权等级 {f['license']} · 签署 {f['signer']} · {time.strftime('%Y-%m-%d %H:%M', time.localtime(f['signed_at']))} · AI 复原 · AI 生成</p>
{imgs}<h2>史料</h2><table><tr><th>史料</th><th>馆藏</th><th>许可</th><th>来源</th></tr>{rows}</table>
<h2>规格书 V{f['meta']['spec_version']}</h2><table><tr><th>字段</th><th>内容</th><th>证据等级</th></tr>{frows}</table>
<h2>评审与推荐</h2><p>专家评审 {len(f['meta']['reviews'])} 份；推荐分 {f.get('score')}；入选理由：{h.escape(dec.get('reason') or '与系统推荐一致')}</p>
<h2>存证</h2><p>{f['algo']}：<code>{f['hash']}</code>（{' / '.join(f['nodes'])}）</p><script>window.print&&setTimeout(()=>print(),400)</script>"""
