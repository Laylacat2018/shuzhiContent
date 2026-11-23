#!/usr/bin/env python3
"""衣冠复原实验台 · 自部署服务（只用 Python 标准库）。

提供页面静态文件，以及替代 claude.ai 的两项能力：
  /api/db/<集合>[/<文档>]  GET / PUT / DELETE，JSON 文档存储（集合限 runs、meta）
  /api/assets             POST 图片，返回 {"id", "url"}；/_blob/<id> 读取
首次启动时若数据目录为空，从 seed/ 复制初始数据（含已导入的 18 条结果）。
访问控制由前置的 Caddy basic_auth 负责；本服务默认只监听 127.0.0.1。

环境变量：CLOTH_DATA（默认 /data/cloth）、CLOTH_BIND（默认 127.0.0.1）、CLOTH_PORT（默认 8790）
"""
import json
import mimetypes
import os
import re
import shutil
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
SITE = HERE / "site"
SEED = HERE / "seed"
DATA = Path(os.environ.get("CLOTH_DATA", "/data/cloth"))
COLLECTIONS = {"runs", "meta"}
STATIC = {"/": "index.html", "/index.html": "index.html", "/claude-shim.js": "claude-shim.js", "/shi.jpg": "shi.jpg"}
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
ID_RE = re.compile(r"^[A-Za-z0-9_\-][A-Za-z0-9_\-.]{0,119}$")
BLOB_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_DOC = 1 << 20
MAX_IMAGE = 25 << 20
LOCK = threading.Lock()


def init_data():
    (DATA / "db").mkdir(parents=True, exist_ok=True)
    (DATA / "blobs").mkdir(parents=True, exist_ok=True)
    marker = DATA / ".seeded"
    if marker.exists() or not SEED.exists():
        return
    for col in COLLECTIONS:
        src = SEED / "db" / col
        if src.is_dir():
            (DATA / "db" / col).mkdir(exist_ok=True)
            for f in src.glob("*.json"):
                dst = DATA / "db" / col / f.name
                if not dst.exists():
                    shutil.copy2(f, dst)
    for f in (SEED / "blobs").glob("*"):
        dst = DATA / "blobs" / f.name
        if not dst.exists():
            shutil.copy2(f, dst)
    marker.write_text("seeded\n")


def atomic_write(path: Path, data: bytes):
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


class Handler(BaseHTTPRequestHandler):
    server_version = "cloth-lab"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ---------- helpers ----------
    def send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def fail(self, code, msg):
        self.send(code, {"error": msg})

    def body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            return None
        return self.rfile.read(n)

    def route(self):
        path = unquote(urlsplit(self.path).path)
        parts = [p for p in path.split("/") if p]
        return path, parts

    def doc_path(self, parts):
        col = parts[2] if len(parts) > 2 else None
        doc = parts[3] if len(parts) > 3 else None
        if col not in COLLECTIONS or len(parts) > 4 or (doc is not None and not ID_RE.match(doc)):
            return None, None
        return DATA / "db" / col, doc

    # ---------- GET ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path, parts = self.route()
        if path in STATIC:
            f = SITE / STATIC[path]
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            return self.send(200, f.read_bytes(), ctype, {"Cache-Control": "no-cache"})
        if path == "/healthz":
            return self.send(200, {"ok": True})
        if len(parts) == 2 and parts[0] == "_blob" and BLOB_RE.match(parts[1]):
            hits = list((DATA / "blobs").glob(parts[1] + ".*"))
            if not hits:
                return self.fail(404, "not found")
            f = hits[0]
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            return self.send(200, f.read_bytes(), ctype, {"Cache-Control": "private, max-age=31536000, immutable"})
        if parts[:2] == ["api", "db"]:
            folder, doc = self.doc_path(parts)
            if folder is None:
                return self.fail(400, "bad path")
            if doc is None:
                out = []
                if folder.is_dir():
                    for f in sorted(folder.glob("*.json")):
                        try:
                            out.append({"id": f.stem, "data": json.loads(f.read_text("utf-8"))})
                        except (OSError, ValueError):
                            continue
                return self.send(200, out, extra={"Cache-Control": "no-store"})
            f = folder / (doc + ".json")
            # 文档不存在时返回 null（页面会轮询 meta/final 等尚未创建的文档）
            body = f.read_bytes() if f.exists() else b"null"
            return self.send(200, body, extra={"Cache-Control": "no-store"})
        self.fail(404, "not found")

    # ---------- writes ----------
    def do_PUT(self):
        path, parts = self.route()
        if parts[:2] != ["api", "db"]:
            return self.fail(404, "not found")
        folder, doc = self.doc_path(parts)
        if folder is None or doc is None:
            return self.fail(400, "bad path")
        raw = self.body(MAX_DOC)
        if raw is None:
            return self.fail(413, "empty or too large")
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self.fail(400, "invalid json")
        if not isinstance(data, dict):
            return self.fail(400, "document must be an object")
        with LOCK:
            folder.mkdir(parents=True, exist_ok=True)
            atomic_write(folder / (doc + ".json"), json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8"))
        self.send(204)

    def do_DELETE(self):
        path, parts = self.route()
        if parts[:2] != ["api", "db"]:
            return self.fail(404, "not found")
        folder, doc = self.doc_path(parts)
        if folder is None or doc is None:
            return self.fail(400, "bad path")
        with LOCK:
            f = folder / (doc + ".json")
            if f.exists():
                f.unlink()
        self.send(204)

    def do_POST(self):
        path, parts = self.route()
        if parts != ["api", "assets"]:
            return self.fail(404, "not found")
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        ext = IMAGE_TYPES.get(ctype)
        if not ext:
            return self.fail(415, "only png, jpeg, webp")
        raw = self.body(MAX_IMAGE)
        if raw is None:
            return self.fail(413, "empty or larger than 25MB")
        blob_id = uuid.uuid4().hex
        with LOCK:
            atomic_write(DATA / "blobs" / (blob_id + ext), raw)
        self.send(200, {"id": blob_id, "url": "/_blob/" + blob_id})


def main():
    init_data()
    bind = os.environ.get("CLOTH_BIND", "127.0.0.1")
    port = int(os.environ.get("CLOTH_PORT", "8790"))
    httpd = ThreadingHTTPServer((bind, port), Handler)
    print(f"衣冠复原实验台已启动：http://{bind}:{port}  数据目录 {DATA}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
