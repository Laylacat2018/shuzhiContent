"""空间内容工场 · Web 服务（FastAPI）

- 托管前端单页与本地化第三方库（局域网可离线访问）
- 业务引擎在服务端 V8 中运行（与前端同一份 engine.js），所有用户共享同一工作区的数据
- SPEC 第 7.1 章 REST 接口（前缀 /api/v1）、第 7.2 章 WebSocket 事件（/ws/events）
- JWT 登录与按角色的接口权限（权限判定在引擎内执行，与前端一致）
- 状态持久化与重启恢复（见 engine_host.py）
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth
from .engine_host import BizError, EngineHost

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = pathlib.Path(os.environ.get("SCW_DIST", ROOT / "dist"))
DATA = pathlib.Path(os.environ.get("SCW_DATA", ROOT / "data"))
DEFAULT_WS = os.environ.get("SCW_WORKSPACE", "default")
VERSION = (ROOT / "VERSION").read_text("utf-8").strip() if (ROOT / "VERSION").exists() else "1.0.0"
log = logging.getLogger("scw")

# 前端可通过 /api/v1/rpc 调用的引擎写操作（权限仍由引擎按当前登录角色判定）
RPC_ALLOWED = {
    "createJob", "updateJob", "submitJob", "cancelJob", "deleteJob", "taskAction", "review", "manualResolve", "rollback",
    "generateConcepts", "selectConcepts", "discardConcepts", "regenerate3d", "discardAsset", "optimize", "sendToQA",
    "tagAssets", "deleteAsset", "generatePanoramas", "fixSeam", "upscalePano", "submitWorld", "createDataset", "appendPhotos",
    "solvePoses", "trainGS", "cleanRecon", "finishRecon", "createCharacter", "rigCharacter", "confirmWeights", "genMotion",
    "addClip", "updateClip", "removeClip", "createScene", "agentSend", "agentConfirm", "sceneConfirm", "addStill", "moveItem",
    "scaleItem", "addSceneItem", "createExport", "updateModel", "registerModel", "uploadLicense", "confirmLicense",
    "updateSettings", "setRelease", "setSpeed", "autoFix", "runQA", "enqueue", "audit", "patch", "togglePanoUse",
    "readAlerts", "stopCloudNode", "setViewport",
}

host: EngineHost | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global host
    host = EngineHost(DIST, DATA)
    host.ensure(DEFAULT_WS)
    host.start()
    log.info("引擎已启动，工作区：%s", host.workspaces())
    try:
        yield
    finally:
        host.stop()


app = FastAPI(title="空间内容工场 API", version=VERSION, docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.exception_handler(BizError)
async def biz_error(_: Request, e: BizError):
    status = {"forbidden": 403, "bad_request": 400, "limit": 429}.get(e.code, 422)
    return JSONResponse({"detail": e.message, "code": e.code}, status_code=status)


# ---------------------------------------------------------------- 身份
class Ctx(BaseModel):
    uid: str
    ws: str
    pid: str | None = None


def ctx(authorization: str = Header(default=""), x_scw_project: str | None = Header(default=None)) -> Ctx:
    token = authorization.removeprefix("Bearer ").strip()
    claims = auth.verify(token) if token else None
    if not claims:
        raise HTTPException(401, "未登录或登录已过期")
    return Ctx(uid=claims["sub"], ws=claims["ws"], pid=x_scw_project)


def H() -> EngineHost:
    assert host is not None
    return host


def call(c: Ctx, fn: str, *args: Any) -> Any:
    return H().call(c.ws, c.uid, c.pid, fn, list(args))


def q(c: Ctx, expr: str) -> Any:
    return H().query(c.ws, c.uid, c.pid, expr)


# ---------------------------------------------------------------- 基础
@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "version": VERSION, "dist": (DIST / "index.html").exists(), "workspaces": len(H().workspaces())}


@app.get("/api/v1/info")
def info() -> dict:
    return {"name": "空间内容工场 Spatial Content Works", "version": VERSION, "mode": "server", "engine": "server-v8", "pages": 14,
            "workspace": DEFAULT_WS, "users": [{"id": k, **v} for k, v in auth.USERS.items()],
            "note": "模型推理由确定性模拟代替；业务规则、状态与权限由服务端统一执行。"}


class LoginIn(BaseModel):
    user_id: str
    password: str
    workspace: str | None = None


@app.post("/api/v1/auth/login")
def login(body: LoginIn) -> dict:
    if not auth.check_password(body.user_id, body.password):
        raise HTTPException(401, "账号或密码错误")
    ws = H().ensure((body.workspace or DEFAULT_WS).strip().lower())
    H().call(ws, body.user_id, None, "audit", ["登录", auth.USERS[body.user_id]["name"], auth.USERS[body.user_id]["role"]])
    return {"token": auth.issue(body.user_id, ws), "user": {"id": body.user_id, **auth.USERS[body.user_id]}, "workspace": ws}


@app.get("/api/v1/state")
def state(c: Ctx = Depends(ctx), since: int | None = Query(default=None)) -> Response:
    rev = H().rev(c.ws)
    if since is not None and since == rev:
        return Response(status_code=204, headers={"X-SCW-Rev": str(rev)})
    return Response(H().state(c.ws), media_type="application/json", headers={"X-SCW-Rev": str(rev)})


class RpcIn(BaseModel):
    fn: str
    args: list = Field(default_factory=list)


@app.post("/api/v1/rpc")
def rpc(body: RpcIn, c: Ctx = Depends(ctx)) -> Response:
    """前端页面的写操作入口：执行后返回结果与最新状态（一次往返保持界面同步）。"""
    if body.fn == "reset":
        if auth.USERS[c.uid]["role"] != "admin":
            raise BizError("当前角色无权执行：重置演示数据", "forbidden")
        H().reset(c.ws)
        result: Any = None
    elif body.fn in RPC_ALLOWED:
        result = call(c, body.fn, *body.args)
    else:
        raise BizError("不支持的操作：" + body.fn, "bad_request")
    payload = '{"result":' + json.dumps(result, ensure_ascii=False) + ',"rev":' + str(H().rev(c.ws)) + ',"state":' + H().state(c.ws) + "}"
    return Response(payload, media_type="application/json")


# ---------------------------------------------------------------- SPEC 7.1 REST 接口
@app.get("/api/v1/projects")
def projects(c: Ctx = Depends(ctx)) -> list:
    return q(c, "E.S.projects")


class ProjectIn(BaseModel):
    name: str
    usage_scope: str = "internal"
    default_platforms: list[str] = ["quest3"]


@app.post("/api/v1/projects")
def create_project(body: ProjectIn, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "createProject", body.model_dump())


@app.get("/api/v1/jobs")
def jobs(c: Ctx = Depends(ctx)) -> list:
    return q(c, "E.S.jobs")


@app.post("/api/v1/jobs")
def create_job(body: dict, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "createJob", body)


@app.post("/api/v1/jobs/{jid}/precheck")
def precheck(jid: str, c: Ctx = Depends(ctx)) -> dict:
    return q(c, f"E.precheck(E.job({json.dumps(jid)}))")


@app.post("/api/v1/jobs/{jid}/submit")
def submit(jid: str, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "submitJob", jid)


@app.get("/api/v1/tasks")
def tasks(c: Ctx = Depends(ctx), status: str | None = None, job_id: str | None = None) -> list:
    return q(c, f"E.S.tasks.filter(t => (!{json.dumps(status)} || t.status === {json.dumps(status)}) && (!{json.dumps(job_id)} || t.job_id === {json.dumps(job_id)}))")


@app.post("/api/v1/tasks/{tid}/{action}")
def task_action(tid: str, action: str, c: Ctx = Depends(ctx)) -> dict:
    if action not in {"pause", "resume", "cancel", "retry", "pin", "now"}:
        raise BizError("action 取值：pause、resume、cancel、retry、pin、now", "bad_request")
    return call(c, "taskAction", tid, action)


@app.post("/api/v1/concepts/generate")
def concepts_generate(body: dict, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "generateConcepts", body)


class SelectIn(BaseModel):
    ids: list[str]
    model_id: str | None = None
    params: dict | None = None


@app.post("/api/v1/concepts/select")
def concepts_select(body: SelectIn, c: Ctx = Depends(ctx)) -> list:
    return call(c, "selectConcepts", body.ids, {k: v for k, v in {"model_id": body.model_id, "params": body.params}.items() if v})


@app.get("/api/v1/concepts")
def concepts(c: Ctx = Depends(ctx), job_id: str | None = None) -> list:
    return q(c, f"E.S.concepts.filter(x => !{json.dumps(job_id)} || x.job_id === {json.dumps(job_id)})")


class Gen3dIn(BaseModel):
    asset_id: str | None = None
    concept_ids: list[str] | None = None
    model_id: str | None = None
    params: dict | None = None


@app.post("/api/v1/assets/generate3d")
def generate3d(body: Gen3dIn, c: Ctx = Depends(ctx)) -> Any:
    opts = {k: v for k, v in {"model_id": body.model_id, "params": body.params}.items() if v}
    if body.concept_ids:
        return call(c, "selectConcepts", body.concept_ids, opts)
    if body.asset_id:
        return call(c, "regenerate3d", body.asset_id, opts)
    raise BizError("需要 concept_ids 或 asset_id", "bad_request")


class OptimizeIn(BaseModel):
    preset: str = "quest3"
    manual: bool = False


@app.post("/api/v1/assets/{aid}/optimize")
def optimize(aid: str, body: OptimizeIn, c: Ctx = Depends(ctx)) -> list:
    return call(c, "optimize", [aid], body.model_dump())


@app.get("/api/v1/assets")
def assets(c: Ctx = Depends(ctx), q_: str | None = Query(default=None, alias="q"), status: str | None = None, type: str | None = None,
           source: str | None = None, platform: str | None = None, commercial_only: bool = False, heritage_only: bool = False) -> list:
    f = {"q": q_, "status": status, "type": type, "source": source, "platform": platform, "commercialOnly": commercial_only, "heritageOnly": heritage_only}
    return H().read(c.ws, c.uid, c.pid, "libraryQuery", [{k: v for k, v in f.items() if v}])


@app.get("/api/v1/assets/{aid}")
def asset(aid: str, c: Ctx = Depends(ctx)) -> dict:
    return q(c, f"(a => Object.assign({{}}, a, {{current: E.cur(a), qa: E.qaOf(E.cur(a))}}))(E.asset({json.dumps(aid)}))")


@app.get("/api/v1/assets/{aid}/versions")
def versions(aid: str, c: Ctx = Depends(ctx)) -> list:
    return q(c, f"E.asset({json.dumps(aid)}).versions.map(v => E.version(v))")


@app.post("/api/v1/qa/{vid}/run")
def qa_run(vid: str, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "runQA", vid)


class ReviewIn(BaseModel):
    decision: str
    reason_code: str | None = None
    comment: str | None = None


@app.post("/api/v1/qa/{vid}/review")
def qa_review(vid: str, body: ReviewIn, c: Ctx = Depends(ctx)) -> dict:
    aid = q(c, f"(E.version({json.dumps(vid)}) || {{}}).asset_id || null")
    if not aid:
        raise BizError("版本不存在", "bad_request")
    if q(c, f"E.asset({json.dumps(aid)}).current_version") != vid:
        raise BizError("只能审核资产的当前版本", "bad_request")
    return call(c, "review", aid, body.decision, body.reason_code, body.comment)


@app.post("/api/v1/panoramas/generate")
def panoramas(body: dict, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "generatePanoramas", body)


class WorldIn(BaseModel):
    pano_id: str
    model_id: str = "marble-api"
    formats: list[str] = ["3DGS", "网格"]
    splats: int = 500000


@app.post("/api/v1/worlds/generate")
def worlds(body: WorldIn, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "submitWorld", body.pano_id, body.model_id, {"formats": body.formats, "splats": body.splats})


@app.post("/api/v1/recon/datasets")
def recon_dataset(body: dict, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "createDataset", body)


@app.post("/api/v1/recon/{rid}/train")
def recon_train(rid: str, body: dict | None = None, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "trainGS", rid, body or {})


@app.post("/api/v1/scenes")
def scenes(body: dict, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "createScene", body)


class MsgIn(BaseModel):
    text: str


@app.post("/api/v1/scenes/{sid}/agent/messages")
def agent(sid: str, body: MsgIn, c: Ctx = Depends(ctx)) -> dict:
    call(c, "agentSend", sid, body.text)
    return {"accepted": True, "stream": "/ws/events（agent.delta）"}


class ConfirmIn(BaseModel):
    back: bool = False


@app.post("/api/v1/scenes/{sid}/confirm")
def scene_confirm(sid: str, body: ConfirmIn, c: Ctx = Depends(ctx)) -> dict:
    call(c, "sceneConfirm", sid, body.back)
    return q(c, f"(s => ({{step: s.step, final: !!s.final}}))(E.scene({json.dumps(sid)}))")


@app.get("/api/v1/exports")
def exports(c: Ctx = Depends(ctx)) -> list:
    return q(c, "E.S.exports")


@app.post("/api/v1/exports")
def create_export(body: dict, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "createExport", body)


@app.get("/api/v1/exports/{eid}")
def export_one(eid: str, c: Ctx = Depends(ctx)) -> dict:
    r = q(c, f"E.S.exports.find(x => x.id === {json.dumps(eid)}) || null")
    if not r:
        raise HTTPException(404, "导出记录不存在")
    return r


@app.get("/api/v1/models")
def models(c: Ctx = Depends(ctx)) -> list:
    return q(c, "E.S.models")


@app.put("/api/v1/models/{mid}")
def update_model(mid: str, body: dict, c: Ctx = Depends(ctx)) -> dict:
    call(c, "updateModel", mid, body)
    return q(c, f"E.model({json.dumps(mid)})")


class LicenseIn(BaseModel):
    file_name: str


@app.post("/api/v1/models/{mid}/license")
def upload_license(mid: str, body: LicenseIn, c: Ctx = Depends(ctx)) -> dict:
    return call(c, "uploadLicense", mid, body.file_name)


@app.get("/api/v1/system/gpu")
def system_gpu(c: Ctx = Depends(ctx)) -> dict:
    return q(c, "({loaded: E.S.gpu.loaded, swapping: E.S.gpu.swapping, latest: E.S.gpu.history[E.S.gpu.history.length - 1] || null, history: E.S.gpu.history.slice(-900)})")


@app.get("/api/v1/system/disk")
def system_disk(c: Ctx = Depends(ctx)) -> dict:
    return q(c, "E.S.settings.storage")


@app.get("/api/v1/system/cloud")
def system_cloud(c: Ctx = Depends(ctx)) -> dict:
    return q(c, "({nodes: E.S.cloudNodes, month_cost: E.S.cloudCostMonth, settings: E.S.settings.cloud})")


if os.environ.get("SCW_ALLOW_FASTFORWARD") == "1":
    class FFIn(BaseModel):
        seconds: float = 60

    @app.post("/api/v1/debug/fastforward")
    def fastforward(body: FFIn, c: Ctx = Depends(ctx)) -> dict:
        """仅自测环境：把工作区模拟时钟快进若干秒（需显式设置环境变量开启）。"""
        q(c, f"(E.fastForward({float(body.seconds)}), true)")
        return {"ok": True}


@app.api_route("/api/v1/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
def not_found(path: str) -> JSONResponse:
    return JSONResponse({"detail": f"未知接口 /api/v1/{path}"}, status_code=404)


# ---------------------------------------------------------------- SPEC 7.2 WebSocket
@app.websocket("/ws/events")
async def ws_events(ws: WebSocket, token: str = Query(default="")):
    claims = auth.verify(token)
    if not claims:
        await ws.close(code=4401)
        return
    await ws.accept()
    since = 0
    try:
        evs = H().events(claims["ws"], 0)
        since = evs[-1]["seq"] if evs else 0
        while True:
            evs = await asyncio.to_thread(H().events, claims["ws"], since)
            for e in evs:
                await ws.send_text(json.dumps(e, ensure_ascii=False))
                since = e["seq"]
            await asyncio.sleep(0.5)
    except (WebSocketDisconnect, RuntimeError):
        return


# ---------------------------------------------------------------- 前端
if (DIST / "vendor").exists():
    app.mount("/vendor", StaticFiles(directory=DIST / "vendor"), name="vendor")


@app.get("/favicon.ico")
def favicon() -> Response:
    return Response(status_code=204)


@app.get("/standalone")
def standalone() -> FileResponse:
    return FileResponse(DIST / "standalone.html", media_type="text/html; charset=utf-8")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(DIST / "index.html", media_type="text/html; charset=utf-8")
