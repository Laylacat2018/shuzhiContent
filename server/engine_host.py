"""业务引擎宿主：在 V8 中运行前后端共用的业务引擎，并负责持久化与时钟推进。

- 引擎源码：dist/engine-bundle.js（由 web/build.py 从 web/src/geometry.js + engine.js 生成）
- 状态持久化：$SCW_DATA/workspaces/<工作区>.json（每 5 秒落盘一次；进程退出时再落盘）
- 重启恢复：运行中的任务回到排队（SPEC 第 13 章“断电恢复”）
"""
from __future__ import annotations

import json
import logging
import os
import pathlib
import re
import threading
import time
from typing import Any

from py_mini_racer import MiniRacer

log = logging.getLogger("scw.engine")
ROOT = pathlib.Path(__file__).resolve().parent.parent
WS_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


class BizError(Exception):
    def __init__(self, message: str, code: str = "rule"):
        super().__init__(message)
        self.message = message
        self.code = code


class EngineHost:
    def __init__(self, dist: pathlib.Path, data_dir: pathlib.Path, max_workspaces: int = 30):
        self.lock = threading.RLock()
        self.data_dir = data_dir / "workspaces"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.max_workspaces = max_workspaces
        self.ctx = MiniRacer()
        bundle = dist / "engine-bundle.js"
        if not bundle.exists():  # 开发环境：直接读源码
            bundle_src = "\n;\n".join((ROOT / "web" / "src" / f).read_text("utf-8") for f in ("geometry.js", "engine.js"))
        else:
            bundle_src = bundle.read_text("utf-8")
        self.ctx.eval("var globalThis = this;")
        self.ctx.eval(bundle_src)
        self.ctx.eval((pathlib.Path(__file__).parent / "host.js").read_text("utf-8"))
        self._saved_rev: dict[str, int] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._load_all()

    # ---------- 工作区 ----------
    def _load_all(self) -> None:
        for f in sorted(self.data_dir.glob("*.json")):
            try:
                n = self.ctx.call("hostLoad", f.stem, f.read_text("utf-8"))
                log.info("恢复工作区 %s（%s 个运行中任务回到排队）", f.stem, n)
            except Exception as e:  # 损坏的文件不阻止启动
                log.error("工作区 %s 恢复失败：%s", f.stem, e)

    def workspaces(self) -> list[str]:
        with self.lock:
            return json.loads(self.ctx.call("hostList"))

    def ensure(self, ws: str) -> str:
        if not WS_NAME.match(ws or ""):
            raise BizError("工作区名称只能包含小写字母、数字、- 和 _（不超过 32 个字符）", "bad_request")
        with self.lock:
            if ws not in self.workspaces():
                if len(self.workspaces()) >= self.max_workspaces:
                    raise BizError("工作区数量已达上限", "limit")
                self.ctx.call("hostCreate", ws)
                self._save(ws)
        return ws

    def reset(self, ws: str) -> None:
        with self.lock:
            self.ctx.call("hostReset", ws)
            self._save(ws)

    # ---------- 调用 ----------
    def call(self, ws: str, uid: str, pid: str | None, fn: str, args: list | None = None) -> Any:
        with self.lock:
            r = json.loads(self.ctx.call("hostCall", ws, uid, pid or "", fn, json.dumps(args or [], ensure_ascii=False)))
        if not r["ok"]:
            raise BizError(r["error"], r.get("code") or "rule")
        return r["result"]

    def read(self, ws: str, uid: str, pid: str | None, fn: str, args: list | None = None) -> Any:
        with self.lock:
            r = json.loads(self.ctx.call("hostRead", ws, uid, pid or "", fn, json.dumps(args or [], ensure_ascii=False)))
        if not r["ok"]:
            raise BizError(r["error"], r.get("code") or "rule")
        return r["result"]

    def query(self, ws: str, uid: str, pid: str | None, expr: str) -> Any:
        """在工作区上下文中求值一个只读表达式（仅供本服务内部组合查询）。"""
        with self.lock:
            r = json.loads(self.ctx.call("hostEval", ws, uid, pid or "", expr))
        if not r["ok"]:
            raise BizError(r["error"], r.get("code") or "rule")
        return r["result"]

    def state(self, ws: str) -> str:
        with self.lock:
            return self.ctx.call("hostState", ws)

    def rev(self, ws: str) -> int:
        with self.lock:
            return int(self.ctx.call("hostRev", ws))

    def events(self, ws: str, since: int) -> list[dict]:
        with self.lock:
            return json.loads(self.ctx.call("hostEvents", ws, since))

    # ---------- 时钟与持久化 ----------
    def tick(self, ms: float) -> None:
        with self.lock:
            self.ctx.call("hostTick", ms)

    def _save(self, ws: str) -> None:
        data = self.ctx.call("hostState", ws)
        tmp = self.data_dir / f"{ws}.json.tmp"
        tmp.write_text(data, "utf-8")
        tmp.replace(self.data_dir / f"{ws}.json")
        self._saved_rev[ws] = int(self.ctx.call("hostRev", ws))

    def save_all(self) -> None:
        with self.lock:
            for ws in json.loads(self.ctx.call("hostList")):
                self._save(ws)

    def start(self, interval: float = 0.5, save_every: float = 5.0) -> None:
        def loop() -> None:
            last = time.monotonic()
            last_save = last
            while not self._stop.wait(interval):
                now = time.monotonic()
                try:
                    self.tick((now - last) * 1000)
                    if now - last_save >= save_every:
                        self.save_all()
                        last_save = now
                except Exception:  # 时钟线程不能因单次异常退出
                    log.exception("引擎时钟异常")
                last = now

        self._thread = threading.Thread(target=loop, name="scw-engine-clock", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        self.save_all()
        self.ctx.close()
