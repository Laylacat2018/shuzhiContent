"""空间内容工场 · 部署版 Web 服务（FastAPI）

演示版的业务引擎运行在浏览器中（web/src/engine.js），本服务负责：
  - 托管前端单页与本地化第三方库（局域网可离线访问，不依赖 CDN）
  - 健康检查与版本信息，供 Nginx / 负载均衡探活
  - 为后续接入真实 Worker 预留 /api/v1 前缀（见 SPEC 第 7 章）
"""
from __future__ import annotations

import os
import pathlib

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = pathlib.Path(os.environ.get("SCW_DIST", ROOT / "dist"))
VERSION = "1.0.0-demo"

app = FastAPI(title="空间内容工场", version=VERSION, docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "version": VERSION, "dist": (DIST / "index.html").exists()}


@app.get("/api/v1/info")
def info() -> dict:
    return {
        "name": "空间内容工场 Spatial Content Works",
        "version": VERSION,
        "mode": "demo",
        "engine": "browser",
        "pages": 14,
        "note": "演示版：模型推理由确定性模拟代替，业务规则与 PRD / SPEC 一致。",
    }


@app.get("/api/v1/{path:path}")
def not_implemented(path: str) -> JSONResponse:
    return JSONResponse({"detail": f"/api/v1/{path} 在演示版中由浏览器内引擎实现"}, status_code=501)


if (DIST / "vendor").exists():
    app.mount("/vendor", StaticFiles(directory=DIST / "vendor"), name="vendor")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(DIST / "index.html", media_type="text/html; charset=utf-8")
