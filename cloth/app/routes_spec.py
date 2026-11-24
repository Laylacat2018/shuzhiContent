"""形制规格书（P03）：逐字段编辑、证据等级、关联史料、审核状态、批注、版本、签署、差异、提示词预览。"""
from __future__ import annotations

import re
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import ai, defaults
from .core import audit, current_user, need_lead, project_for, store
from .routes_project import guard_archived, touch
from .store import Conflict
from .worker import primary_source, spec_fields

r = APIRouter(prefix="/api")


def versions(pid: str) -> list[dict]:
    return sorted(store.list("spec_versions", project_id=pid), key=lambda v: v["no"])


def ensure_v1(p: dict, by: str):
    if versions(p["id"]):
        return
    v = store.insert("spec_versions", {"project_id": p["id"], "no": 1, "status": "draft", "created_by": by})
    tpl = defaults.SPEC_TEMPLATES.get(p["category"], defaults.SPEC_TEMPLATES["通用"])
    for code, name, content, level in tpl:
        store.insert("spec_fields", {"version_id": v["id"], "project_id": p["id"], "code": code, "name": name, "content": content,
                                     "level": level, "source_ids": [], "status": "pending", "na": False, "custom": False})


def version_view(v: dict) -> dict:
    fields = spec_fields(v["id"])
    users = {x["id"]: x["name"] for x in store.list("users")}
    open_comments = {}
    for c in store.list("comments", version_id=v["id"]):
        if not c.get("resolved"):
            open_comments[c["field_code"]] = open_comments.get(c["field_code"], 0) + 1
    for f in fields:
        f["open_comments"] = open_comments.get(f["code"], 0)
        f["checked_by_name"] = users.get(f.get("checked_by"))
    blockers = [f"{f['code']} {defaults.FIELD_STATUS[f['status']]}" for f in fields if not f.get("na") and f["status"] != "checked"]
    blockers += [f"{c} 有 {n} 条未解决批注" for c, n in open_comments.items()]
    return dict(v, fields=fields, blockers=blockers, signer_name=users.get(v.get("signed_by")), cosigner_name=users.get(v.get("cosigner_id")))


@r.get("/projects/{pid}/spec")
def get_spec(pid: str, u=Depends(current_user)):
    p = project_for(pid, u)
    ensure_v1(p, u["id"])
    vs = versions(pid)
    return {"versions": [version_view(v) for v in vs], "levels": defaults.LEVELS, "status": defaults.FIELD_STATUS}


def editable(v: dict):
    if v["status"] != "draft":
        raise HTTPException(400, "该版本已签署锁定；请在修订页生成新版本草稿")


class FieldPatch(BaseModel):
    rev: int
    content: str | None = None
    level: str | None = None
    source_ids: list[str] | None = None
    status: str | None = None
    na: bool | None = None
    name: str | None = None


@r.patch("/spec-fields/{fid}")
def patch_field(fid: str, body: FieldPatch, u=Depends(current_user)):
    f = store.get("spec_fields", fid) or {}
    if not f:
        raise HTTPException(404, "字段不存在")
    p = project_for(f["project_id"], u)
    guard_archived(p)
    if u["role"] not in ("expert", "lead"):
        raise HTTPException(403, "仅专家可编辑规格书")
    v = store.get("spec_versions", f["version_id"])
    editable(v)
    ch = {k: val for k, val in body.model_dump().items() if val is not None and k != "rev"}
    if "level" in ch and ch["level"] not in defaults.LEVELS:
        raise HTTPException(400, "证据等级无效")
    if "status" in ch and ch["status"] not in defaults.FIELD_STATUS:
        raise HTTPException(400, "审核状态无效")
    level = ch.get("level", f["level"])
    srcs = ch.get("source_ids", f.get("source_ids", []))
    valid = {s["id"] for s in store.list("sources", project_id=f["project_id"])}
    if any(s not in valid for s in srcs):
        raise HTTPException(400, "依据只能选择本项目已入库的史料")
    if level in ("L1", "L2", "L3") and not srcs:
        raise HTTPException(400, "证据等级 L1–L3 至少关联一条史料")
    content_changed = any(k in ch and ch[k] != f.get(k) for k in ("content", "level", "source_ids", "name"))
    if content_changed:
        ch["status"] = "pending"   # 内容一改，状态回到待审
        ch["checked_by"] = None
    elif ch.get("status") == "checked":
        ch["checked_by"] = u["id"]
    ch["updated_by"] = u["name"]
    try:
        n = store.update("spec_fields", fid, ch, if_rev=body.rev)
    except Conflict as c:
        raise HTTPException(409, {"message": f"{f['code']} 已被 {c.current.get('updated_by', '他人')} 修改，请刷新后再改", "current": c.current})
    audit(u, "编辑规格书字段", f"V{v['no']} {f['code']} {f['name']}", before={k: f.get(k) for k in ch}, after=ch, project=f["project_id"])
    touch(f["project_id"])
    return n


class NewField(BaseModel):
    name: str
    content: str = ""
    level: str = "miss"


@r.post("/spec-versions/{vid}/fields")
def add_field(vid: str, body: NewField, u=Depends(current_user)):
    v = store.get("spec_versions", vid) or {}
    p = project_for(v["project_id"], u)
    editable(v)
    if u["role"] not in ("expert", "lead"):
        raise HTTPException(403, "仅专家可新增字段")
    nums = [int(f["code"][1:]) for f in store.list("spec_fields", version_id=vid) if f["code"][1:].isdigit()]
    code = f"F{max(nums + [12]) + 1}"
    f = store.insert("spec_fields", {"version_id": vid, "project_id": p["id"], "code": code, "name": body.name, "content": body.content,
                                     "level": body.level, "source_ids": [], "status": "pending", "na": False, "custom": True, "updated_by": u["name"]})
    audit(u, "新增自定义字段", f"{code} {body.name}", project=p["id"])
    return f


@r.delete("/spec-fields/{fid}")
def delete_field(fid: str, u=Depends(current_user)):
    f = store.get("spec_fields", fid) or {}
    p = project_for(f["project_id"], u)
    editable(store.get("spec_versions", f["version_id"]))
    if not f.get("custom"):
        raise HTTPException(400, "默认字段不能删除，可标为“不适用”")
    store.delete("spec_fields", fid)
    audit(u, "删除自定义字段", f["code"], project=p["id"])
    return {"ok": True}


class Sign(BaseModel):
    cosigner_id: str | None = None


@r.post("/spec-versions/{vid}/sign")
def sign(vid: str, body: Sign, u=Depends(current_user)):
    v = store.get("spec_versions", vid) or {}
    p = project_for(v["project_id"], u)
    need_lead(p, u)
    editable(v)
    view = version_view(v)
    if view["blockers"]:
        raise HTTPException(400, "还不能签署：" + "；".join(view["blockers"]))
    if body.cosigner_id:
        if body.cosigner_id not in p.get("expert_ids", []):
            raise HTTPException(400, "复核专家须为本项目专家")
        store.update("spec_versions", vid, {"status": "signing", "signed_by": u["id"], "signed_at": time.time(), "cosigner_id": body.cosigner_id})
    else:
        store.update("spec_versions", vid, {"status": "signed", "signed_by": u["id"], "signed_at": time.time()})
    audit(u, "签署规格书", f"V{v['no']}", project=p["id"])
    touch(p["id"])
    return version_view(store.get("spec_versions", vid))


@r.post("/spec-versions/{vid}/cosign")
def cosign(vid: str, u=Depends(current_user)):
    v = store.get("spec_versions", vid) or {}
    p = project_for(v["project_id"], u)
    if v.get("status") != "signing" or v.get("cosigner_id") != u["id"]:
        raise HTTPException(403, "你不是该版本的复核专家")
    store.update("spec_versions", vid, {"status": "signed", "cosigned_at": time.time()})
    audit(u, "复核签署规格书", f"V{v['no']}", project=p["id"])
    return version_view(store.get("spec_versions", vid))


def new_draft(p: dict, u: dict) -> dict:
    vs = versions(p["id"])
    draft = next((v for v in vs if v["status"] == "draft"), None)
    if draft:
        return draft
    base = next((v for v in reversed(vs) if v["status"] == "signed"), None)
    if not base:
        raise HTTPException(400, "还没有已签署的版本")
    nv = store.insert("spec_versions", {"project_id": p["id"], "no": base["no"] + 1, "status": "draft", "created_by": u["id"], "base_id": base["id"]})
    for f in spec_fields(base["id"]):
        store.insert("spec_fields", {k: f[k] for k in ("code", "name", "content", "level", "source_ids", "na", "custom")} |
                     {"version_id": nv["id"], "project_id": p["id"], "status": "checked", "checked_by": f.get("checked_by")})
    audit(u, "生成规格书新版本草稿", f"V{nv['no']}", project=p["id"])
    return nv


@r.post("/projects/{pid}/spec/new-draft")
def post_new_draft(pid: str, u=Depends(current_user)):
    p = project_for(pid, u)
    need_lead(p, u)
    return version_view(new_draft(p, u))


@r.get("/projects/{pid}/spec/diff")
def diff(pid: str, a: str, b: str, u=Depends(current_user)):
    project_for(pid, u)
    fa = {f["code"]: f for f in spec_fields(a)}
    fb = {f["code"]: f for f in spec_fields(b)}
    out = []
    for code in sorted(set(fa) | set(fb), key=lambda c: int(c[1:]) if c[1:].isdigit() else 99):
        x, y = fa.get(code), fb.get(code)
        if x and not y:
            out.append({"code": code, "kind": "删除", "name": x["name"], "before": x["content"]})
        elif y and not x:
            out.append({"code": code, "kind": "新增", "name": y["name"], "after": y["content"], "by": y.get("updated_by")})
        elif x["content"] != y["content"] or x["level"] != y["level"] or bool(x.get("na")) != bool(y.get("na")):
            out.append({"code": code, "kind": "修改", "name": y["name"], "before": x["content"], "after": y["content"],
                        "level": [x["level"], y["level"]], "by": y.get("updated_by"), "at": y["_updated"]})
    return out


@r.get("/spec-versions/{vid}/prompt")
def prompt_preview(vid: str, u=Depends(current_user)):
    v = store.get("spec_versions", vid) or {}
    project_for(v["project_id"], u)
    has_ref = bool(primary_source(v["project_id"]))
    pos, neg = ai.build_prompt(spec_fields(vid), "draft", "front", has_ref)
    return {"prompt": pos, "negative": neg}


# ---------------------------------------------------------------- 批注

class NewComment(BaseModel):
    field_code: str
    body: str


@r.get("/spec-versions/{vid}/comments")
def comments(vid: str, u=Depends(current_user)):
    v = store.get("spec_versions", vid) or {}
    project_for(v["project_id"], u)
    return store.list("comments", version_id=vid)


@r.post("/spec-versions/{vid}/comments")
def add_comment(vid: str, body: NewComment, u=Depends(current_user)):
    v = store.get("spec_versions", vid) or {}
    p = project_for(v["project_id"], u)
    if not body.body.strip():
        raise HTTPException(400, "批注不能为空")
    names = {x["name"]: x["id"] for x in store.list("users")}
    mentions = [names[m] for m in re.findall(r"@(\S+?)(?=[\s，,。:：]|$)", body.body) if m in names]
    c = store.insert("comments", {"version_id": vid, "project_id": p["id"], "field_code": body.field_code, "body": body.body.strip(),
                                  "user_id": u["id"], "user": u["name"], "mentions": mentions, "resolved": False})
    f = next((x for x in store.list("spec_fields", version_id=vid) if x["code"] == body.field_code), None)
    if f and f["status"] == "checked" and v["status"] == "draft":
        store.update("spec_fields", f["id"], {"status": "dispute"})
    audit(u, "批注", body.field_code, after=body.body, project=p["id"])
    return c


@r.post("/comments/{cid}/resolve")
def resolve(cid: str, u=Depends(current_user)):
    c = store.get("comments", cid) or {}
    p = project_for(c["project_id"], u)
    if u["id"] not in (c["user_id"], p["lead_id"]):
        raise HTTPException(403, "仅批注人或主审可标记解决")
    store.update("comments", cid, {"resolved": True, "resolved_by": u["name"]})
    return {"ok": True}
