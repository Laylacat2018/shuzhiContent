"""登录、成员、项目（P01）、史料汇集（P02）。"""
from __future__ import annotations

import json
import secrets
import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel

from . import ai, defaults, museum
from .core import (ROLES, SESSION_HOURS, audit, check_pw, current_user, file_bytes, hash_pw, need_lead, project_for, public_user,
                   require, save_file, store)
from .worker import adapter_for

r = APIRouter(prefix="/api")
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/tiff"}
MAX_UPLOAD = 50 * 1024 * 1024


# ---------------------------------------------------------------- 登录与成员

class Login(BaseModel):
    username: str
    password: str


@r.post("/login")
def login(body: Login, resp: Response):
    u = next((x for x in store.list("users") if x["username"] == body.username), None)
    if not u or not check_pw(body.password, u["pw"]) or not u.get("active", True):
        raise HTTPException(401, "账号或密码错误")
    token = secrets.token_urlsafe(32)
    store.insert("sessions", {"user_id": u["id"], "expires": time.time() + SESSION_HOURS * 3600}, id=token)
    resp.set_cookie("cloth_session", token, httponly=True, samesite="lax", max_age=SESSION_HOURS * 3600)
    audit(u, "登录", "会话")
    return public_user(u)


@r.post("/logout")
def logout(resp: Response, u=Depends(current_user)):
    for s in store.list("sessions", user_id=u["id"]):
        store.delete("sessions", s["id"])
    resp.delete_cookie("cloth_session")
    return {"ok": True}


@r.get("/me")
def me(u=Depends(current_user)):
    return public_user(u)


@r.get("/users")
def users(u=Depends(current_user)):
    return [public_user(x) for x in store.list("users")]


class NewUser(BaseModel):
    username: str
    name: str
    role: str
    password: str
    org: str = ""


@r.post("/users")
def add_user(body: NewUser, u=Depends(require("tech"))):
    if body.role not in ROLES:
        raise HTTPException(400, "角色无效")
    if any(x["username"] == body.username for x in store.list("users")):
        raise HTTPException(409, "账号已存在")
    if len(body.password) < 8:
        raise HTTPException(400, "密码至少 8 位")
    nu = store.insert("users", {"username": body.username, "name": body.name, "role": body.role, "org": body.org,
                                "pw": hash_pw(body.password), "active": True})
    audit(u, "新增成员", f"成员 {body.name}", after={"role": body.role})
    return public_user(nu)


class UserPatch(BaseModel):
    role: str | None = None
    active: bool | None = None
    password: str | None = None
    name: str | None = None


@r.patch("/users/{uid}")
def patch_user(uid: str, body: UserPatch, u=Depends(require("tech"))):
    x = store.get("users", uid) or {}
    if not x:
        raise HTTPException(404, "成员不存在")
    ch = {k: v for k, v in body.model_dump().items() if v is not None and k != "password"}
    if "role" in ch and ch["role"] not in ROLES:
        raise HTTPException(400, "角色无效")
    if body.password:
        ch["pw"] = hash_pw(body.password)
    store.update("users", uid, ch)
    if body.active is False:
        for s in store.list("sessions", user_id=uid):
            store.delete("sessions", s["id"])
    audit(u, "修改成员", f"成员 {x['name']}", before={k: x.get(k) for k in ch if k != "pw"}, after={k: v for k, v in ch.items() if k != "pw"})
    return public_user(store.get("users", uid))


# ---------------------------------------------------------------- 项目

def step_state(p: dict) -> dict:
    pid = p["id"]
    versions = store.list("spec_versions", project_id=pid)
    signed = [v for v in versions if v["status"] == "signed"]
    rounds = store.list("review_rounds", project_id=pid)
    finals = [f for f in store.list("finals", project_id=pid) if not f.get("revoked")]
    done = {
        1: bool(p.get("sources_confirmed")),
        2: bool(signed),
        3: bool(store.list("runs", project_id=pid)),
        4: any(round_complete(rd) for rd in rounds),
        5: bool(store.list("decisions", project_id=pid)),
        6: any(v["no"] > 1 for v in signed),
        7: any(f.get("status") == "active" for f in finals),
    }
    current = next((i for i in range(1, 8) if not done[i]), 7)
    return {"done": done, "current": current}


def round_complete(rd: dict) -> bool:
    revs = [x for x in store.list("reviews", round_id=rd["id"]) if x.get("submitted")]
    return len(revs) >= len(rd["expert_ids"]) * len(rd["run_ids"]) or (rd.get("deadline") and rd["deadline"] < time.time())


def todos_for(u: dict, p: dict) -> list[dict]:
    out = []
    pid = p["id"]
    if u["id"] == p["lead_id"] and not p.get("sources_confirmed") and store.list("sources", project_id=pid):
        out.append({"step": 1, "text": "确认史料范围"})
    for v in store.list("spec_versions", project_id=pid):
        if v["status"] == "draft":
            pend = [f for f in store.list("spec_fields", version_id=v["id"]) if f["status"] != "checked" and not f.get("na")]
            if pend and u["role"] in ("expert", "lead"):
                out.append({"step": 2, "text": f"规格书 V{v['no']} 有 {len(pend)} 个字段待审"})
        if v["status"] == "signing" and v.get("cosigner_id") == u["id"]:
            out.append({"step": 2, "text": f"规格书 V{v['no']} 待你复核签署"})
    for c in store.list("comments", project_id=pid):
        if u["id"] in c.get("mentions", []) and not c.get("resolved"):
            out.append({"step": 2, "text": f"{c['user']} 在批注中 @ 了你"})
    for rd in store.list("review_rounds", project_id=pid):
        if u["id"] in rd["expert_ids"] and not round_complete(rd):
            mine = [x for x in store.list("reviews", round_id=rd["id"], expert_id=u["id"]) if x.get("submitted")]
            left = len(rd["run_ids"]) - len(mine)
            if left > 0:
                out.append({"step": 4, "text": f"还有 {left} 张候选图待评审"})
        if u["id"] == p["lead_id"] and round_complete(rd) and not store.list("decisions", project_id=pid, round_id=rd["id"]):
            out.append({"step": 5, "text": "专家已全部提交，请确定入选版本"})
    for f in store.list("finals", project_id=pid):
        if f.get("status") == "cosigning" and u["id"] in f.get("cosigners", {}) and not f["cosigners"][u["id"]]:
            out.append({"step": 7, "text": "定稿待你会签"})
    return out


def project_view(p: dict, u: dict) -> dict:
    users = {x["id"]: x["name"] for x in store.list("users")}
    ps = next((s for s in store.list("sources", project_id=p["id"]) if s.get("primary")), None)
    return dict(p, lead_name=users.get(p["lead_id"]), experts=[{"id": e, "name": users.get(e)} for e in p.get("expert_ids", [])],
                steps=step_state(p), todos=todos_for(u, p), cover=ps["file_id"] if ps else None, is_lead=u["id"] == p["lead_id"])


@r.get("/projects")
def list_projects(u=Depends(current_user)):
    out = []
    for p in store.list("projects"):
        try:
            project_for(p["id"], u)
        except HTTPException:
            continue
        out.append(project_view(p, u))
    return sorted(out, key=lambda x: -x["_updated"])


@r.get("/todos")
def todos(u=Depends(current_user)):
    out = []
    for p in list_projects(u):
        out += [dict(t, project_id=p["id"], project=p["name"]) for t in p["todos"]]
    return out


class NewProject(BaseModel):
    name: str
    category: str
    dynasty: str = ""
    lead_id: str
    expert_ids: list[str] = []
    artifact: str = ""
    museum: str = ""


@r.post("/projects")
def create_project(body: NewProject, u=Depends(current_user)):
    if u["role"] not in ("lead", "ops"):
        raise HTTPException(403, "仅主审专家或运营可新建项目")
    if not body.name.strip() or not body.category or not body.lead_id:
        raise HTTPException(400, "项目名称、服饰类别、主审专家为必填")
    lead = store.get("users", body.lead_id)
    if not lead or lead["role"] != "lead":
        raise HTTPException(400, "主审专家无效")
    p = store.insert("projects", {"name": body.name.strip(), "category": body.category, "dynasty": body.dynasty,
                                  "lead_id": body.lead_id, "expert_ids": [e for e in body.expert_ids if e != body.lead_id],
                                  "artifact": body.artifact, "museum": body.museum, "archived": False, "sources_confirmed": False,
                                  "created_by": u["id"]})
    for code, part in enumerate(defaults.OBSERVATION_PARTS.get(body.category, defaults.OBSERVATION_PARTS["通用"])):
        store.insert("observations", {"project_id": p["id"], "part": part, "seen": "", "question": "", "status": "empty", "order": code})
    audit(u, "新建项目", p["name"], project=p["id"])
    return project_view(p, u)


@r.get("/projects/{pid}")
def get_project(pid: str, u=Depends(current_user)):
    return project_view(project_for(pid, u), u)


class ProjectPatch(BaseModel):
    archived: bool | None = None
    expert_ids: list[str] | None = None
    name: str | None = None


@r.patch("/projects/{pid}")
def patch_project(pid: str, body: ProjectPatch, u=Depends(current_user)):
    p = project_for(pid, u)
    if u["id"] != p["lead_id"] and u["role"] != "ops":
        raise HTTPException(403, "仅主审或运营可修改项目")
    ch = {k: v for k, v in body.model_dump().items() if v is not None}
    if ch.get("archived") and not step_state(p)["done"][7]:
        raise HTTPException(400, "只有已定稿的项目可以归档")
    store.update("projects", pid, ch)
    audit(u, "修改项目", p["name"], after=ch, project=pid)
    return project_view(store.get("projects", pid), u)


def touch(pid: str):
    store.update("projects", pid, {})


def guard_archived(p: dict):
    if p.get("archived"):
        raise HTTPException(400, "项目已归档，只读")


# ---------------------------------------------------------------- 史料

@r.get("/projects/{pid}/sources")
def sources(pid: str, u=Depends(current_user)):
    project_for(pid, u)
    return store.list("sources", project_id=pid)


@r.post("/projects/{pid}/sources/upload")
async def upload_sources(pid: str, files: list[UploadFile] = File(...), part: str = Form("全图"), kind: str = Form("画像"),
                         u=Depends(current_user)):
    p = project_for(pid, u)
    guard_archived(p)
    if u["role"] == "tech":
        raise HTTPException(403, "技术角色只读")
    out, errors = [], []
    has_primary = any(s.get("primary") for s in store.list("sources", project_id=pid))
    for f in files:
        data = await f.read()
        if f.content_type not in IMAGE_TYPES:
            errors.append(f"{f.filename}：只支持 JPG、PNG、WebP、TIFF")
            continue
        if len(data) > MAX_UPLOAD:
            errors.append(f"{f.filename}：超过 50 MB")
            continue
        fr = save_file(data, f.content_type, u["id"], f.filename or "")
        s = store.insert("sources", {"project_id": pid, "origin": "上传", "title": f.filename, "museum": p.get("museum", ""),
                                     "license": "仅研究", "level": "L2", "part": part, "kind": kind, "file_id": fr["id"],
                                     "sha256": fr["sha256"], "primary": not has_primary and not out, "by": u["name"],
                                     "after_confirm": bool(p.get("sources_confirmed"))})
        out.append(s)
    if out:
        audit(u, "上传史料", f"{len(out)} 个文件", project=pid)
        touch(pid)
    return {"added": out, "errors": errors}


class Search(BaseModel):
    q: str


@r.post("/projects/{pid}/sources/search")
def search_sources(pid: str, body: Search, u=Depends(current_user)):
    project_for(pid, u)
    results, notes = museum.search(body.q, store.list("whitelist"))
    return {"results": results, "notes": notes}


class ImportSource(BaseModel):
    title: str
    museum: str
    level: str = ""
    url: str
    image: str | None = None
    license: str = "仅研究"
    dating: str | None = None
    accession: str | None = None


@r.post("/projects/{pid}/sources/import")
def import_source(pid: str, body: ImportSource, u=Depends(current_user)):
    p = project_for(pid, u)
    guard_archived(p)
    w = museum.host_allowed(body.url, store.list("whitelist"))
    if not w:
        raise HTTPException(400, "该网址不在检索白名单内，请联系技术人员在系统设置中添加")
    fid = sha = None
    if body.image:
        try:
            data, mime = museum.download(body.image)
            fr = save_file(data, mime, u["id"], body.title)
            fid, sha = fr["id"], fr["sha256"]
        except Exception as e:
            raise HTTPException(502, f"图片下载失败：{type(e).__name__}")
    s = store.insert("sources", {"project_id": pid, "origin": "检索", "title": body.title, "museum": body.museum, "url": body.url,
                                 "license": body.license, "level": "L2" if w["level"] == "国家级" else "L3", "part": "全图", "kind": "画像",
                                 "dating": body.dating, "accession": body.accession, "file_id": fid, "sha256": sha,
                                 "fetched_at": time.time(), "primary": False, "by": u["name"], "after_confirm": bool(p.get("sources_confirmed"))})
    audit(u, "检索入库", body.title, after={"url": body.url}, project=pid)
    touch(pid)
    return s


class Link(BaseModel):
    url: str


@r.post("/projects/{pid}/sources/link")
def link_source(pid: str, body: Link, u=Depends(current_user)):
    p = project_for(pid, u)
    guard_archived(p)
    w = museum.host_allowed(body.url, store.list("whitelist"))
    if not w:
        raise HTTPException(400, "该网址不在检索白名单内，请联系技术人员在系统设置中添加")
    try:
        info = museum.fetch_page(body.url, w)
    except Exception as e:
        raise HTTPException(502, f"抓取失败：{type(e).__name__}")
    return import_source(pid, ImportSource(**{k: info.get(k) for k in ImportSource.model_fields if k in info}), u)


class SourcePatch(BaseModel):
    primary: bool | None = None
    part: str | None = None
    kind: str | None = None
    level: str | None = None
    license: str | None = None
    title: str | None = None


@r.patch("/sources/{sid}")
def patch_source(sid: str, body: SourcePatch, u=Depends(current_user)):
    s = store.get("sources", sid) or {}
    if not s:
        raise HTTPException(404, "史料不存在")
    p = project_for(s["project_id"], u)
    guard_archived(p)
    ch = {k: v for k, v in body.model_dump().items() if v is not None}
    if ch.get("primary"):
        if not s.get("file_id"):
            raise HTTPException(400, "没有图像的史料不能设为主史料")
        for o in store.list("sources", project_id=s["project_id"]):
            if o.get("primary"):
                store.update("sources", o["id"], {"primary": False})
    store.update("sources", sid, ch)
    audit(u, "修改史料", s["title"], after=ch, project=s["project_id"])
    return store.get("sources", sid)


@r.delete("/sources/{sid}")
def delete_source(sid: str, u=Depends(current_user)):
    s = store.get("sources", sid) or {}
    p = project_for(s["project_id"], u)
    guard_archived(p)
    if p.get("sources_confirmed") and not s.get("after_confirm"):
        raise HTTPException(400, "史料范围已确认，不能删除确认前的史料")
    store.delete("sources", sid)
    audit(u, "删除史料", s["title"], project=s["project_id"])
    return {"ok": True}


@r.post("/projects/{pid}/sources/confirm")
def confirm_sources(pid: str, u=Depends(current_user)):
    p = project_for(pid, u)
    need_lead(p, u)
    if not any(s.get("primary") for s in store.list("sources", project_id=pid)):
        raise HTTPException(400, "请先设置主史料")
    store.update("projects", pid, {"sources_confirmed": True, "sources_confirmed_at": time.time()})
    audit(u, "确认史料范围", p["name"], project=pid)
    return project_view(store.get("projects", pid), u)


# ---------------------------------------------------------------- 观察记录与文献

@r.get("/projects/{pid}/observations")
def observations(pid: str, u=Depends(current_user)):
    project_for(pid, u)
    return sorted(store.list("observations", project_id=pid), key=lambda o: o.get("order", 99))


class Obs(BaseModel):
    part: str
    seen: str = ""
    question: str = ""
    rev: int | None = None


@r.post("/projects/{pid}/observations")
def add_obs(pid: str, body: Obs, u=Depends(current_user)):
    p = project_for(pid, u)
    guard_archived(p)
    o = store.insert("observations", {"project_id": pid, "part": body.part, "seen": body.seen, "question": body.question,
                                      "status": "confirmed", "editor": u["name"], "order": 50})
    audit(u, "新增观察部位", body.part, project=pid)
    return o


@r.put("/observations/{oid}")
def edit_obs(oid: str, body: Obs, u=Depends(current_user)):
    o = store.get("observations", oid) or {}
    p = project_for(o["project_id"], u)
    guard_archived(p)
    if u["role"] == "tech":
        raise HTTPException(403, "技术角色只读")
    from .store import Conflict
    try:
        n = store.update("observations", oid, {"part": body.part, "seen": body.seen, "question": body.question,
                                               "status": "confirmed", "editor": u["name"]}, if_rev=body.rev)
    except Conflict as c:
        raise HTTPException(409, {"message": "该行已被他人修改，请刷新后再改", "current": c.current})
    audit(u, "编辑观察记录", o["part"], before={"seen": o["seen"]}, after={"seen": body.seen}, project=o["project_id"])
    return n


@r.delete("/observations/{oid}")
def del_obs(oid: str, u=Depends(current_user)):
    o = store.get("observations", oid) or {}
    p = project_for(o["project_id"], u)
    guard_archived(p)
    store.delete("observations", oid)
    audit(u, "删除观察部位", o["part"], project=o["project_id"])
    return {"ok": True}


AI_READ_PROMPT = """你是中国古代服饰史研究助手。请观察这张文物图像中人物所穿服饰，按部位逐条记录“画像所见”（只写看得见的颜色、纹样、形制、位置），
并为每个部位列出需要专家判断的问题。部位优先使用：{parts}。只回复 JSON 数组：[{{"part":"部位","seen":"画像所见","question":"待专家判断"}}]"""


@r.post("/projects/{pid}/observations/ai-read")
def ai_read(pid: str, u=Depends(current_user)):
    p = project_for(pid, u)
    guard_archived(p)
    ps = next((s for s in store.list("sources", project_id=pid) if s.get("primary")), None)
    if not ps:
        raise HTTPException(400, "请先设置主史料")
    parts = defaults.OBSERVATION_PARTS.get(p["category"], defaults.OBSERVATION_PARTS["通用"])
    try:
        adapter, cfg, mocked = adapter_for("vision")
        if mocked:
            raise ai.ModelError("视觉模型未配置密钥（系统设置 → 模型接入）")
        rows = ai.parse_json_block(adapter.ask(AI_READ_PROMPT.format(parts="、".join(parts)), [file_bytes(ps["file_id"])]))
    except ai.ModelError as e:
        raise HTTPException(503, str(e))
    except (ValueError, KeyError, json.JSONDecodeError):
        raise HTTPException(502, "视觉模型返回格式无法解析，请重试")
    existing = {o["part"]: o for o in store.list("observations", project_id=pid)}
    n = 0
    for i, row in enumerate(rows):
        o = existing.get(row.get("part"))
        if o and o["status"] == "confirmed":
            continue  # 不覆盖专家已确认的内容
        data = {"seen": row.get("seen", ""), "question": row.get("question", ""), "status": "ai", "editor": cfg["name"]}
        if o:
            store.update("observations", o["id"], data)
        else:
            store.insert("observations", dict(data, project_id=pid, part=row.get("part", f"部位{i+1}"), order=20 + i))
        n += 1
    audit(u, "AI 初读", f"{n} 个部位", project=pid)
    return observations(pid, u)


class Lit(BaseModel):
    title: str
    excerpt: str = ""
    edition: str = ""
    page: str = ""
    parts: str = ""


@r.get("/projects/{pid}/literature")
def literature(pid: str, u=Depends(current_user)):
    project_for(pid, u)
    return store.list("literature", project_id=pid)


@r.post("/projects/{pid}/literature")
def add_lit(pid: str, body: Lit, u=Depends(current_user)):
    p = project_for(pid, u)
    guard_archived(p)
    lit = store.insert("literature", dict(body.model_dump(), project_id=pid, status="已录入" if body.excerpt else "待录入原文", by=u["name"]))
    audit(u, "新增文献", body.title, project=pid)
    return lit


@r.put("/literature/{lid}")
def edit_lit(lid: str, body: Lit, u=Depends(current_user)):
    lit = store.get("literature", lid) or {}
    p = project_for(lit["project_id"], u)
    guard_archived(p)
    n = store.update("literature", lid, dict(body.model_dump(), status="已录入" if body.excerpt else "待录入原文"))
    audit(u, "编辑文献", body.title, project=lit["project_id"])
    return n


@r.delete("/literature/{lid}")
def del_lit(lid: str, u=Depends(current_user)):
    lit = store.get("literature", lid) or {}
    project_for(lit["project_id"], u)
    store.delete("literature", lid)
    return {"ok": True}
