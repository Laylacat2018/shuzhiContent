"""衣冠·AI复原工作台 · 应用入口。运行：uvicorn cloth.app.main:app --host 127.0.0.1 --port 8790"""
from __future__ import annotations

import contextlib
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import routes_flow, routes_photo, routes_project, routes_spec
from .core import DEMO, bootstrap, current_user, delete_file, file_bytes, store

STATIC = Path(__file__).resolve().parents[1] / "static"
VUE = Path(__file__).resolve().parents[2] / "node_modules" / "vue" / "dist" / "vue.global.prod.js"

@contextlib.asynccontextmanager
async def lifespan(app):
    startup()
    yield


app = FastAPI(title="衣冠·AI复原工作台", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
for router in (routes_project.r, routes_spec.r, routes_flow.r, routes_photo.r):
    app.include_router(router)


@app.middleware("http")
async def headers(request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    return resp


@app.get("/api/info")
def info():
    return {"name": "衣冠·AI复原工作台", "version": "2.0.0", "demo": DEMO}


@app.get("/api/files/{fid}")
def files(fid: str, u=Depends(current_user)):
    f = store.get("files", fid)
    if not f:
        raise HTTPException(404, "文件不存在")
    return Response(file_bytes(fid), media_type=f["mime"], headers={"Cache-Control": "private, max-age=86400"})


@app.get("/vendor/vue.js")
def vue():
    local = STATIC / "vendor" / "vue.global.prod.js"
    return FileResponse(local if local.exists() else VUE, media_type="application/javascript")


@app.get("/m/{token}")
def mobile(token: str):
    return FileResponse(STATIC / "m.html")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.exception_handler(HTTPException)
async def http_error(request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"message": exc.detail}
    return JSONResponse(detail, status_code=exc.status_code)


def _janitor():
    """每 10 分钟清理过期合拍结果与过期会话。"""
    while True:
        now = time.time()
        for j in store.list("photo_jobs"):
            if j.get("result_file") and j.get("expires", now + 1) < now:
                delete_file(j["result_file"])
                store.update("photo_jobs", j["id"], {"result_file": None})
        for s in store.list("sessions"):
            if s["expires"] < now:
                store.delete("sessions", s["id"])
        time.sleep(600)


def startup():
    bootstrap()
    for t in store.list("gen_tasks"):
        if t["status"] in ("queued", "running"):      # 重启前未完成的任务标为失败，可重试
            store.update("gen_tasks", t["id"], {"status": "failed", "error": "服务重启，任务中断，请重试"})
    threading.Thread(target=_janitor, daemon=True).start()
