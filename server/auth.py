"""登录与 JWT（HS256，标准库实现，无额外依赖）。

演示账号与 PRD 第 2 章的四种角色对应；演示密码由环境变量 SCW_DEMO_PASSWORD 配置（默认 demo-2026）。
签名密钥由 SCW_JWT_SECRET 配置；未配置时每次启动随机生成（重启后需重新登录）。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

SECRET = (os.environ.get("SCW_JWT_SECRET") or secrets.token_hex(32)).encode()
DEMO_PASSWORD = os.environ.get("SCW_DEMO_PASSWORD", "demo-2026")
TTL = int(os.environ.get("SCW_JWT_TTL", str(12 * 3600)))
USERS = {
    "u_pm": {"name": "林策划", "role": "pm"},
    "u_art": {"name": "周美术", "role": "artist"},
    "u_rev": {"name": "陈审核", "role": "reviewer"},
    "u_admin": {"name": "王管理", "role": "admin"},
}
CREDENTIALS = json.loads(Path(os.environ['SCW_ACCOUNTS_FILE']).read_text('utf-8')) if os.environ.get('SCW_ACCOUNTS_FILE') else None


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def issue(uid: str, ws: str) -> str:
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64(json.dumps({"sub": uid, "ws": ws, "role": USERS[uid]["role"], "exp": int(time.time()) + TTL}).encode())
    sig = _b64(hmac.new(SECRET, f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"


def verify(token: str) -> dict | None:
    try:
        head, body, sig = token.split(".")
        good = _b64(hmac.new(SECRET, f"{head}.{body}".encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, good):
            return None
        claims = json.loads(_unb64(body))
        if claims.get("exp", 0) < time.time() or claims.get("sub") not in USERS:
            return None
        return claims
    except Exception:
        return None


def check_password(uid: str, password: str) -> bool:
    if CREDENTIALS is not None:
        record = CREDENTIALS.get(uid)
        if not record or uid not in USERS: return False
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(record['salt']), n=16384, r=8, p=1).hex()
        return hmac.compare_digest(actual, record['hash'])
    return uid in USERS and hmac.compare_digest(password or "", DEMO_PASSWORD)
