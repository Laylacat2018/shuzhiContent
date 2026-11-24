"""公共能力：配置、文件存储、登录会话、权限、审计、密钥加密、初始化数据。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import mimetypes
import os
import secrets
import time
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi import Cookie, Depends, HTTPException

from . import defaults
from .store import Store, new_id

DATA = Path(os.environ.get("CLOTH_DATA", Path(__file__).resolve().parents[1] / "data"))
DEMO = os.environ.get("CLOTH_DEMO") == "1"
SESSION_HOURS = 12
ROLES = {"expert": "评审专家", "lead": "主审专家", "ops": "咪咕运营", "tech": "咪咕技术"}

DATA.mkdir(parents=True, exist_ok=True)
(DATA / "files").mkdir(exist_ok=True)
store = Store(DATA / "cloth.db")


# ---------------------------------------------------------------- 密钥与口令

def _secret() -> bytes:
    p = DATA / "secret.key"
    if not p.exists():
        p.write_bytes(Fernet.generate_key())
        p.chmod(0o600)
    return p.read_bytes()


FERNET = Fernet(_secret())


def enc(s: str) -> str:
    return FERNET.encrypt(s.encode()).decode()


def dec(s: str | None) -> str | None:
    return FERNET.decrypt(s.encode()).decode() if s else None


def hash_pw(pw: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(8)
    return salt + "$" + hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200_000).hex()


def check_pw(pw: str, stored: str) -> bool:
    salt = stored.split("$", 1)[0]
    return hmac.compare_digest(hash_pw(pw, salt), stored)


def sm3(data: bytes) -> tuple[str, str]:
    try:
        return "SM3", hashlib.new("sm3", data).hexdigest()
    except ValueError:  # OpenSSL 未编译 SM3 时退回 SHA-256，并在存证中注明
        return "SHA-256", hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- 文件

def save_file(data: bytes, mime: str | None, by: str | None, name: str = "") -> dict:
    digest = hashlib.sha256(data).hexdigest()
    ext = mimetypes.guess_extension(mime or "") or Path(name).suffix or ".bin"
    fid = new_id("f")
    (DATA / "files" / (fid + ext)).write_bytes(data)
    return store.insert("files", {"sha256": digest, "mime": mime or "application/octet-stream", "size": len(data),
                                  "path": fid + ext, "name": name, "by": by}, id=fid)


def file_bytes(fid: str) -> bytes:
    f = store.get("files", fid)
    if not f:
        raise HTTPException(404, "文件不存在")
    return (DATA / "files" / f["path"]).read_bytes()


def delete_file(fid: str):
    f = store.get("files", fid)
    if f:
        (DATA / "files" / f["path"]).unlink(missing_ok=True)
        store.delete("files", fid)


# ---------------------------------------------------------------- 会话与权限

def current_user(cloth_session: str | None = Cookie(default=None)) -> dict:
    if not cloth_session:
        raise HTTPException(401, "请先登录")
    s = store.get("sessions", cloth_session)
    if not s or s["expires"] < time.time():
        raise HTTPException(401, "登录已过期")
    u = store.get("users", s["user_id"])
    if not u or not u.get("active", True):
        store.delete("sessions", cloth_session)
        raise HTTPException(401, "账号已停用")
    return u


def require(*roles):
    def dep(u=Depends(current_user)):
        if roles and u["role"] not in roles:
            raise HTTPException(403, "当前角色无权进行此操作")
        return u
    return dep


def project_for(pid: str, u: dict) -> dict:
    p = store.get("projects", pid)
    if not p:
        raise HTTPException(404, "项目不存在")
    if u["role"] in ("ops", "tech") or u["id"] == p["lead_id"] or u["id"] in p.get("expert_ids", []):
        return p
    raise HTTPException(403, "你没有被邀请参与这个项目")


def is_lead(p: dict, u: dict) -> bool:
    return u["id"] == p["lead_id"]


def need_lead(p: dict, u: dict):
    if not is_lead(p, u):
        raise HTTPException(403, "仅本项目主审专家可操作")


def audit(u: dict | None, action: str, obj: str, before=None, after=None, project: str | None = None):
    store.insert("audit", {"user_id": u["id"] if u else None, "user": u["name"] if u else "系统", "action": action,
                           "object": obj, "before": before, "after": after, "project": project, "at": time.time()})


def public_user(u: dict) -> dict:
    return {"id": u["id"], "name": u["name"], "role": u["role"], "role_name": ROLES[u["role"]], "org": u.get("org", ""),
            "username": u["username"], "active": u.get("active", True)}


def model_cfg(code: str) -> dict | None:
    for m in store.list("models"):
        if m["code"] == code:
            return m
    return None


# ---------------------------------------------------------------- 初始化

def bootstrap():
    if not store.list("users"):
        pw = os.environ.get("CLOTH_ADMIN_PASSWORD") or ("cloth2026" if DEMO else secrets.token_urlsafe(10))
        store.insert("users", {"username": "admin", "name": "系统管理员", "role": "tech", "org": "咪咕", "pw": hash_pw(pw), "active": True})
        if not DEMO and not os.environ.get("CLOTH_ADMIN_PASSWORD"):
            (DATA / "admin-initial-password.txt").write_text(f"admin / {pw}\n")
            (DATA / "admin-initial-password.txt").chmod(0o600)
    if not store.list("whitelist"):
        for name, level, domain, method, lic in defaults.WHITELIST:
            store.insert("whitelist", {"name": name, "level": level, "domain": domain, "method": method, "license": lic, "enabled": True})
    if not store.list("models"):
        for m in defaults.MODELS:
            store.insert("models", dict(m, enabled=True, key=None, used=0))
    if not store.list("review_templates"):
        store.insert("review_templates", {"name": "命妇礼服", "category": "女子服饰 · 命妇礼服", "version": 1, "locked": False,
                                          "dims": [{"code": c, "name": n, "fields": f, "weight": w, "scale": s, "required": True}
                                                   for c, n, f, w, s in defaults.REVIEW_TEMPLATE]})
