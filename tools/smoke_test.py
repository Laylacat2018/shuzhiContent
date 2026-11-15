#!/usr/bin/env python3
"""冒烟测试（SPEC 5.3 第 6 步）：通过 REST 接口跑通
概念图 1 张 → 3D 生成 1 件 → 优化 → 质检 → 审核入库 → 导出 GLB（WebXR）。

用法：
    python3 tools/smoke_test.py http://127.0.0.1:8000 [--workspace smoke] [--password demo-2026]

服务端开启了 SCW_ALLOW_FASTFORWARD=1 时用快进推进模拟时钟；否则把演示加速调到 60× 后实时等待（约 1–2 分钟）。
只用标准库，可在部署机上直接运行。退出码 0 表示通过。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


class Api:
    def __init__(self, base: str, ws: str, password: str):
        self.base = base.rstrip("/")
        self.ws, self.password = ws, password
        self.tokens: dict[str, str] = {}
        self.ff: bool | None = None

    def req(self, method: str, path: str, body=None, user: str = "u_pm"):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        if path != "/api/v1/auth/login":
            r.add_header("Authorization", "Bearer " + self.token(user))
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method} {path} → {e.code} {e.read().decode('utf-8', 'replace')}") from None

    def token(self, user: str) -> str:
        if user not in self.tokens:
            r = self.req("POST", "/api/v1/auth/login", {"user_id": user, "password": self.password, "workspace": self.ws})
            self.tokens[user] = r["token"]
        return self.tokens[user]

    def advance(self, seconds: float) -> None:
        if self.ff is None:
            try:
                self.req("POST", "/api/v1/debug/fastforward", {"seconds": 1}, user="u_admin")
                self.ff = True
            except RuntimeError:
                self.ff = False
                self.req("POST", "/api/v1/rpc", {"fn": "setSpeed", "args": [60]}, user="u_admin")
        if self.ff:
            self.req("POST", "/api/v1/debug/fastforward", {"seconds": seconds}, user="u_admin")
        else:
            time.sleep(min(seconds / 60, 10))

    def wait(self, what: str, fn, sim_seconds: float = 3000, step: float = 120):
        waited = 0.0
        while waited <= sim_seconds:
            v = fn()
            if v:
                return v
            self.advance(step)
            waited += step
        raise RuntimeError("等待超时：" + what)


def step(msg: str) -> None:
    print("  ✓", msg, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--workspace", default="smoke")
    ap.add_argument("--password", default="demo-2026")
    a = ap.parse_args()
    api = Api(a.base, a.workspace, a.password)
    print("冒烟测试 →", a.base, "工作区", a.workspace)
    health = json.loads(urllib.request.urlopen(api.base + "/healthz", timeout=10).read())
    assert health["status"] == "ok", health
    step("服务健康检查")

    job = api.req("POST", "/api/v1/jobs", {"title": "冒烟测试 · 青铜鼎 1 件", "content_type": "prop", "platforms": ["quest3", "webxr"], "quantity": 1,
                                         "description": "商周青铜鼎，写实 PBR", "is_heritage": False})
    pre = api.req("POST", f"/api/v1/jobs/{job['id']}/precheck")
    assert pre["ok"] and pre["preset"] == "webxr", pre
    api.req("POST", f"/api/v1/jobs/{job['id']}/submit")
    step(f"需求单 {job['code']} 已提交（管线 {pre['template']}，单件预算 {pre['preset_name']}）")

    concepts = api.wait("概念图", lambda: [c for c in api.req("GET", f"/api/v1/concepts?job_id={job['id']}") if c["status"] == "candidate"])
    step(f"概念图生成 {len(concepts)} 张")
    tasks = api.req("POST", "/api/v1/assets/generate3d", {"concept_ids": [concepts[0]["id"]]}, user="u_art")
    step(f"送入 3D 生成：{tasks[0]['code']}")

    def reviewed():
        lst = [x for x in api.req("GET", "/api/v1/assets?status=review") if x["job_id"] == job["id"]]
        return lst[0] if lst else None
    asset = api.wait("3D 生成 → 优化 → 质检", reviewed, sim_seconds=6000, step=150)
    detail = api.req("GET", f"/api/v1/assets/{asset['id']}")
    v = detail["current"]
    assert v["opt"] and v["opt"]["tris"] <= 10000, v["opt"]
    assert [i["rule"] for i in detail["qa"]["items"]] == [f"Q0{i}" for i in range(1, 10)]
    step(f"{asset['code']} 生成 {v['raw']['tris']:,} → 优化 {v['opt']['tris']:,} 三角形，九项质检完成")

    failed = [i for i in detail["qa"]["items"] if i["result"] == "fail"]
    if any(i["rule"] in ("Q04", "Q06", "Q07") for i in failed):
        api.req("POST", "/api/v1/rpc", {"fn": "autoFix", "args": [asset["id"]]}, user="u_rev")
        detail = api.req("GET", f"/api/v1/assets/{asset['id']}")
        failed = [i for i in detail["qa"]["items"] if i["result"] == "fail"]
        step("自动修复可修复项并重检")
    api.req("POST", f"/api/v1/qa/{v['id']}/review", {"decision": "pass", "comment": "冒烟测试放行" if failed else ""}, user="u_rev")
    assert api.req("GET", f"/api/v1/assets/{asset['id']}")["status"] == "library"
    step("审核通过并入库")

    ex = api.req("POST", "/api/v1/exports", {"object_type": "assets", "asset_ids": [asset["id"]], "targets": ["webxr"], "settings": {"aigcVisible": True}})
    ex = api.wait("导出", lambda: (lambda e: e if e["status"] == "done" else None)(api.req("GET", f"/api/v1/exports/{ex['id']}")), step=60)
    assert ex["manifest"]["assets"][0]["aigc"]["implicit"] is True
    step(f"导出 {ex['code']} 完成：{', '.join(f['name'] for f in ex['files'][:3])}…（{ex['size_mb']} MB）")
    print("冒烟测试通过")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # 失败时给出可读原因
        print("冒烟测试失败：", e)
        sys.exit(1)
