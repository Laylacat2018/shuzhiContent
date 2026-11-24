"""合拍模板（P09）、观众手机合拍（P10）、系统设置（P11）。"""
from __future__ import annotations

import io
import secrets
import threading
import time

import segno
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from . import ai, defaults, worker
from .core import (DEMO, audit, current_user, dec, delete_file, enc, file_bytes, model_cfg, project_for, require, save_file, store)

r = APIRouter(prefix="/api")
RESULT_HOURS = 24
RATE = {}  # 设备 -> 时间戳列表（10 分钟最多 5 次）
RATE_LOCK = threading.Lock()


# ================================================================ P09 模板

def shareable_finals():
    return [f for f in store.list("finals") if f.get("status") == "active" and f["license"] in ("可对外展示", "可商业授权")]


@r.get("/finals-shareable")
def finals_shareable(u=Depends(current_user)):
    out = []
    for f in shareable_finals():
        p = store.get("projects", f["project_id"])
        out.append({"id": f["id"], "asset_no": f["asset_no"], "project": p["name"], "license": f["license"], "file_id": store.get("runs", f["run_ids"][0])["file_id"]})
    return out


class NewTemplates(BaseModel):
    final_id: str
    gender: str = "女"
    pose: str = "站姿正面"
    bg: str = "展厅"
    count: int = 4


def _gen_template(tid: str, final_png: bytes):
    t = store.get("templates", tid)
    try:
        img, meta, mocked = worker.template_generate(final_png, t["gender"], t["pose"], t["bg"])
        f = save_file(ai.add_aigc_meta(img, {"label": "AI 生成", "use": "合拍模板"}), "image/png", t["by"], "template.png")
        store.update("templates", tid, {"file_id": f["id"], "status": "pending", "model": meta["model"], "mock": mocked})
    except Exception as e:
        store.update("templates", tid, {"status": "failed", "error": str(e)[:300]})


@r.post("/templates")
def create_templates(body: NewTemplates, u=Depends(require("ops", "tech"))):
    f = next((x for x in shareable_finals() if x["id"] == body.final_id), None)
    if not f:
        raise HTTPException(400, "只能选择授权等级为“可对外展示”及以上的有效定稿")
    if body.gender not in ("女", "男", "儿童") or not 1 <= body.count <= 8:
        raise HTTPException(400, "参数无效")
    png = file_bytes(store.get("runs", f["run_ids"][0])["file_id"])
    out = []
    for _ in range(body.count):
        t = store.insert("templates", {"final_id": f["id"], "gender": body.gender, "pose": body.pose, "bg": body.bg, "status": "generating", "by": u["id"]})
        worker.POOL.submit(_gen_template, t["id"], png)
        out.append(t)
    audit(u, "生成合拍模板", f"{f['asset_no']} × {body.count}")
    return out


@r.get("/templates")
def list_templates(u=Depends(current_user)):
    out = []
    for t in sorted(store.list("templates"), key=lambda t: -t["_created"]):
        f = store.get("finals", t["final_id"]) or {}
        stats = [x for x in store.list("photo_jobs") if x.get("template_id") == t["id"]]
        ok = [x for x in stats if x["status"] == "done"]
        out.append(dict(t, asset_no=f.get("asset_no"), final_file=store.get("runs", f["run_ids"][0])["file_id"] if f else None,
                        uses=len(stats), success=round(len(ok) / len(stats) * 100, 1) if stats else None))
    return out


class TemplateReview(BaseModel):
    ok: bool
    reason: str = ""
    marks: list = []


@r.post("/templates/{tid}/review")
def review_template(tid: str, body: TemplateReview, u=Depends(require("expert", "lead"))):
    t = store.get("templates", tid) or {}
    if t.get("status") not in ("pending", "approved", "rejected"):
        raise HTTPException(400, "模板尚未生成完成")
    if not body.ok and not body.reason.strip():
        raise HTTPException(400, "不通过须填写原因")
    store.update("templates", tid, {"status": "approved" if body.ok else "rejected", "review": {"by": u["name"], "ok": body.ok, "reason": body.reason, "marks": body.marks, "at": time.time()}})
    audit(u, "审核合拍模板", tid, after={"ok": body.ok, "reason": body.reason})
    return store.get("templates", tid)


@r.post("/templates/{tid}/trial")
async def trial(tid: str, photo: UploadFile = File(...), u=Depends(require("ops", "tech"))):
    t = store.get("templates", tid) or {}
    if not t.get("file_id"):
        raise HTTPException(400, "模板尚未生成")
    selfie = await photo.read()
    try:
        img = worker.fusion_generate(selfie, file_bytes(t["file_id"]), "edit")
    except ai.ModelError as e:
        raise HTTPException(503, str(e))
    finally:
        del selfie
    out = ai.watermark(img, "AI 生成 · 试跑", {"label": "AI 生成", "trial": True})
    return Response(out, media_type="image/png")


# ================================================================ 活动

class Activity(BaseModel):
    name: str
    hall: str = ""
    start: str
    end: str
    daily_limit: int = 3000
    template_ids: list[str]
    mode: str = "swap"


@r.get("/activities")
def activities(u=Depends(current_user)):
    out = []
    today = time.strftime("%Y-%m-%d")
    for a in store.list("activities"):
        jobs = store.list("photo_jobs", activity_id=a["id"])
        tj = [j for j in jobs if j["day"] == today]
        done = [j for j in jobs if j["status"] == "done"]
        out.append(dict(a, today=len(tj), total=len(jobs), success=round(len(done) / len(jobs) * 100, 1) if jobs else None,
                        avg_seconds=round(sum(j.get("seconds", 0) for j in done) / len(done), 1) if done else None,
                        saved=round(sum(1 for j in done if j.get("saved")) / len(done) * 100, 1) if done else None))
    return out


@r.post("/activities")
def create_activity(body: Activity, u=Depends(require("ops"))):
    ts = [store.get("templates", t) for t in body.template_ids]
    if not ts or any(t is None or t["status"] not in ("approved", "online") for t in ts):
        raise HTTPException(400, "只能加入专家审核通过的模板")
    a = store.insert("activities", dict(body.model_dump(), token=secrets.token_urlsafe(9), status="online", by=u["id"]))
    for t in ts:
        store.update("templates", t["id"], {"status": "online"})
    audit(u, "上线合拍活动", body.name)
    return a


class ActivityPatch(BaseModel):
    status: str | None = None
    daily_limit: int | None = None
    end: str | None = None


@r.patch("/activities/{aid}")
def patch_activity(aid: str, body: ActivityPatch, u=Depends(require("ops"))):
    a = store.get("activities", aid) or {}
    ch = {k: v for k, v in body.model_dump().items() if v is not None}
    store.update("activities", aid, ch)
    audit(u, "修改合拍活动", a.get("name"), after=ch)
    return store.get("activities", aid)


@r.get("/activities/{aid}/qr.svg")
def qr(aid: str, request: Request, u=Depends(current_user)):
    a = store.get("activities", aid) or {}
    url = str(request.base_url).rstrip("/") + "/m/" + a["token"]
    buf = io.BytesIO()
    segno.make(url, error="m").save(buf, kind="svg", scale=6, border=2)
    return Response(buf.getvalue(), media_type="image/svg+xml")


@r.get("/activities/{aid}/samples")
def samples(aid: str, u=Depends(require("ops", "tech"))):
    """抽检：只返回合拍结果，不含自拍原图（服务端从不保存）。"""
    return [{"id": j["id"], "result": j.get("result_file"), "at": j["_created"], "status": j["status"]}
            for j in store.list("photo_jobs", activity_id=aid)[-24:] if j.get("result_file")]


# ================================================================ P10 观众端（无需登录）

def live_activity(token: str) -> dict:
    a = next((x for x in store.list("activities") if x["token"] == token), None)
    today = time.strftime("%Y-%m-%d")
    if not a or a["status"] != "online":
        raise HTTPException(404, "活动不存在或已下线")
    if not a["start"] <= today <= a["end"]:
        raise HTTPException(410, "活动未开始或已结束")
    return a


@r.get("/m/{token}")
def m_info(token: str):
    a = live_activity(token)
    ts = [t for t in (store.get("templates", i) for i in a["template_ids"]) if t and t["status"] == "online"]
    f = store.get("finals", ts[0]["final_id"]) if ts else None
    p = store.get("projects", f["project_id"]) if f else None
    run = store.get("runs", f["run_ids"][0]) if f else None
    used = len([j for j in store.list("photo_jobs", activity_id=a["id"]) if j["day"] == time.strftime("%Y-%m-%d")])
    return {"name": a["name"], "hall": a["hall"], "full": used >= a["daily_limit"], "project": p["name"] if p else "",
            "artifact": p.get("artifact") if p else "", "final_file": run["file_id"] if run else None,
            "templates": [{"id": t["id"], "file_id": t["file_id"], "pose": t["pose"], "bg": t["bg"]} for t in ts]}


@r.post("/m/{token}/photo")
async def m_photo(token: str, request: Request, template_id: str = Form(...), consent: bool = Form(False),
                  guardian: bool = Form(False), minor: bool = Form(False), photo: UploadFile = File(...)):
    a = live_activity(token)
    if not consent:
        raise HTTPException(400, "需要先同意人脸信息处理")
    if minor and not guardian:
        raise HTTPException(400, "未满 14 周岁需监护人同意")
    if template_id not in a["template_ids"]:
        raise HTTPException(400, "模板无效")
    t = store.get("templates", template_id)
    if not t or t["status"] != "online":
        raise HTTPException(400, "模板已下线")
    today = time.strftime("%Y-%m-%d")
    if len([j for j in store.list("photo_jobs", activity_id=a["id"]) if j["day"] == today]) >= a["daily_limit"]:
        raise HTTPException(429, "今日合拍次数已满，欢迎明天再来")
    device = request.cookies.get("cloth_dev") or (request.client.host if request.client else "x")
    with RATE_LOCK:
        hist = [x for x in RATE.get(device, []) if x > time.time() - 600]
        if len(hist) >= 5:
            raise HTTPException(429, "操作太频繁，请 10 分钟后再试")
        RATE[device] = hist + [time.time()]
    selfie = await photo.read()          # 自拍只在内存中，绝不落盘
    if photo.content_type not in ("image/jpeg", "image/png", "image/webp", "image/heic") or len(selfie) > 15 * 1024 * 1024:
        raise HTTPException(400, "请上传 15 MB 以内的照片")
    n = ai.face_count(selfie)
    if n is not None and n != 1:
        del selfie
        raise HTTPException(422, "没有检测到人脸，请正对镜头重拍" if n == 0 else "照片中有多张人脸，请只拍一个人")
    job = store.insert("photo_jobs", {"activity_id": a["id"], "template_id": template_id, "status": "running", "day": today})
    t0 = time.time()
    try:
        img = None
        for attempt in range(2):            # 失败自动重试 1 次
            try:
                img = worker.fusion_generate(selfie, file_bytes(t["file_id"]), a.get("mode", "swap"))
                break
            except ai.ModelError:
                if attempt == 1:
                    raise
        meta = {"label": "AI 生成", "platform": "衣冠·AI复原工作台", "activity": a["name"], "content_id": job["id"], "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
        out = ai.watermark(img, f"AI 生成 · {a['name']}", meta)
        rf = save_file(out, "image/png", None, "photo.png")
        store.update("photo_jobs", job["id"], {"status": "done", "result_file": rf["id"], "seconds": round(time.time() - t0, 1),
                                               "expires": time.time() + RESULT_HOURS * 3600, "key": secrets.token_urlsafe(16)})
    except ai.ModelError as e:
        store.update("photo_jobs", job["id"], {"status": "failed", "error": str(e)[:200]})
        raise HTTPException(503, "生成失败，请稍后再试")
    finally:
        selfie = None                     # 无论成功失败，自拍随请求结束释放，不写入任何存储与日志
    j = store.get("photo_jobs", job["id"])
    return {"id": j["id"], "key": j["key"], "seconds": j["seconds"], "expires": j["expires"]}


@r.get("/m/result/{jid}")
def m_result(jid: str, key: str):
    j = store.get("photo_jobs", jid) or {}
    if not j or j.get("key") != key:
        raise HTTPException(404, "结果不存在")
    if j["expires"] < time.time():
        if j.get("result_file"):
            delete_file(j["result_file"])
            store.update("photo_jobs", jid, {"result_file": None})
        raise HTTPException(410, "结果链接已过期")
    return Response(file_bytes(j["result_file"]), media_type="image/png", headers={"Cache-Control": "private, max-age=600"})


@r.post("/m/result/{jid}/saved")
def m_saved(jid: str, key: str):
    j = store.get("photo_jobs", jid) or {}
    if j.get("key") == key:
        store.update("photo_jobs", jid, {"saved": True})
    return {"ok": True}


@r.get("/m-file/{token}/{fid}")
def m_file(token: str, fid: str):
    """观众端只能读取该活动的模板图与定稿图。"""
    info = m_info(token)
    allowed = {t["file_id"] for t in info["templates"]} | {info["final_file"]}
    if fid not in allowed:
        raise HTTPException(404, "文件不存在")
    return Response(file_bytes(fid), media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})


# ================================================================ P11 设置

def model_view(m: dict) -> dict:
    k = dec(m.get("key"))
    return {k_: v for k_, v in m.items() if k_ != "key"} | {"key_tail": ("••••" + k[-4:]) if k else None}


@r.get("/settings/models")
def models(u=Depends(require("tech", "ops"))):
    return [model_view(m) for m in store.list("models")]


class ModelPatch(BaseModel):
    enabled: bool | None = None
    endpoint: str | None = None
    model: str | None = None
    key: str | None = None
    concurrency: int | None = None
    timeout: int | None = None
    cross_border: bool | None = None
    demo_mock: bool | None = None


@r.patch("/settings/models/{mid}")
def patch_model(mid: str, body: ModelPatch, u=Depends(require("tech"))):
    m = store.get("models", mid) or {}
    ch = {k: v for k, v in body.model_dump().items() if v is not None and k != "key"}
    if body.key:
        ch["key"] = enc(body.key.strip())
    store.update("models", mid, ch)
    audit(u, "修改模型接入", m.get("name"), after={k: v for k, v in ch.items() if k != "key"} | ({"key": "已更新"} if body.key else {}))
    return model_view(store.get("models", mid))


@r.post("/settings/models/{mid}/test")
def test_model(mid: str, u=Depends(require("tech"))):
    m = store.get("models", mid) or {}
    try:
        if m["purpose"] == "fusion":
            target = model_cfg(m.get("model") or "sd")
            return {"ok": True, "message": f"合拍使用 {target['name']}：" + worker.adapter_for(target["code"])[0].test()}
        adapter, cfg, mocked = worker.adapter_for(m["code"])
        return {"ok": True, "message": adapter.test() + ("（演示模式模拟）" if mocked else "")}
    except Exception as e:
        return {"ok": False, "message": str(e)[:300]}


class WL(BaseModel):
    name: str
    level: str
    domain: str
    method: str = "网页"
    license: str = "仅研究"
    enabled: bool = True


@r.get("/settings/whitelist")
def whitelist(u=Depends(current_user)):
    return store.list("whitelist")


@r.post("/settings/whitelist")
def add_wl(body: WL, u=Depends(require("tech"))):
    d = body.domain.lower().removeprefix("https://").removeprefix("http://").split("/")[0].removeprefix("www.")
    w = store.insert("whitelist", dict(body.model_dump(), domain=d))
    audit(u, "新增白名单", body.name, after={"domain": d})
    return w


@r.patch("/settings/whitelist/{wid}")
def patch_wl(wid: str, body: WL, u=Depends(require("tech"))):
    w = store.update("whitelist", wid, body.model_dump())
    audit(u, "修改白名单", body.name, after=body.model_dump())
    return w


@r.get("/settings/audit")
def audit_log(project: str | None = None, limit: int = 200, u=Depends(require("tech", "lead", "ops"))):
    rows = store.list("audit")
    if project:
        rows = [x for x in rows if x.get("project") == project]
    return list(reversed(rows))[:limit]


@r.get("/settings/spec-templates")
def spec_templates(u=Depends(current_user)):
    return {k: [{"code": c, "name": n, "content": t, "level": l} for c, n, t, l in v] for k, v in defaults.SPEC_TEMPLATES.items()}
