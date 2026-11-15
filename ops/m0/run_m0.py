#!/usr/bin/env python3
"""M0 一键验收：环境核对 → ComfyUI 概念图 → TRELLIS.2 图生 3D → Blender 无头优化 → 验收报告。

在 GPU 主机上（安装与模型下载完成后）运行：

    python3 ops/m0/run_m0.py

产出 reports/m0/<时间>/：report.md（验收报告）、concept.png、raw.glb、quest3.glb、webxr.glb、各步骤 JSON、
gpu_trace.csv（显存采样），并打包为同目录的 m0_report_<时间>.zip —— 把这个 zip 发回即可验收。
各步骤失败不会中断后续能独立运行的步骤；结论写在报告开头。
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGETS = {  # SPEC 第四部分 §2 管线节点规格（单件耗时）与 PRD 验收标准
    "comfyui": "单张约 10 秒（模型已加载，1024²）",
    "trellis2": "单件 ≤ 2 分钟（1024³，模型已加载），显存 ≤ 24GB",
    "blender": "单件优化 ≤ 5 分钟；优化后三角形 ≤ 预设上限",
}


class GpuTrace(threading.Thread):
    """每 0.5 秒采样 nvidia-smi，按阶段统计显存峰值。"""

    def __init__(self, path: Path):
        super().__init__(daemon=True)
        self.path, self.stage, self.rows, self.stop_ev = path, "idle", [], threading.Event()
        self.ok = shutil.which("nvidia-smi") is not None

    def run(self) -> None:
        while self.ok and not self.stop_ev.wait(0.5):
            try:
                out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,utilization.gpu,temperature.gpu,power.draw", "--format=csv,noheader,nounits"],
                                     capture_output=True, text=True, timeout=5).stdout.splitlines()[0]
                mem, util, temp, power = [x.strip() for x in out.split(",")]
                self.rows.append([round(time.time(), 1), self.stage, round(float(mem) / 1024, 2), util, temp, power])
            except Exception:
                pass

    def peak(self, stage: str) -> float | None:
        v = [r[2] for r in self.rows if r[1] == stage]
        return max(v) if v else None

    def save(self) -> None:
        self.stop_ev.set()
        with self.path.open("w", newline="") as f:
            w = csv.writer(f); w.writerow(["time", "stage", "vram_gb", "util_pct", "temp_c", "power_w"]); w.writerows(self.rows)


def sh(cmd: list[str], log: Path, env: dict | None = None, timeout: int = 3600) -> tuple[int, str]:
    t0 = time.time()
    with log.open("w", encoding="utf-8") as f:
        try:
            p = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, env=env, timeout=timeout)
            code = p.returncode
        except FileNotFoundError as e:
            f.write(str(e)); code = 127
        except subprocess.TimeoutExpired:
            code = 124
    tail = log.read_text("utf-8", "replace").strip().splitlines()[-1:] or [""]
    return code, tail[0][:300] + f"（{time.time() - t0:.0f}s）"


def comfy_alive(url: str) -> bool:
    try:
        urllib.request.urlopen(url + "/system_stats", timeout=3).read(); return True
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    home = os.environ.get("SCW_HOME", "/opt/scw")
    ap.add_argument("--data", default=os.environ.get("SCW_DATA", "/data"))
    ap.add_argument("--comfy-url", default="http://127.0.0.1:8188")
    ap.add_argument("--comfy-dir", default=f"{home}/ComfyUI")
    ap.add_argument("--trellis-python", default=f"{home}/miniforge3/envs/trellis2/bin/python")
    ap.add_argument("--bpy-python", default=f"{home}/bpy/bin/python")
    ap.add_argument("--image", help="跳过 ComfyUI，直接用这张图做 3D 生成")
    ap.add_argument("--glb", help="跳过 TRELLIS.2，直接用这个高模 GLB 做 Blender 优化")
    ap.add_argument("--skip", nargs="*", default=[], choices=["env", "comfyui", "trellis2", "blender"])
    a = ap.parse_args()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = Path("reports/m0") / stamp
    out.mkdir(parents=True, exist_ok=True)
    trace = GpuTrace(out / "gpu_trace.csv"); trace.start()
    results: list[dict] = []

    def step(key: str, title: str, fn):
        trace.stage = key
        print(f"\n▶ {title}", flush=True)
        t0 = time.time()
        try:
            r = fn()
        except Exception as e:  # 单步失败不影响后续
            r = {"ok": False, "detail": f"{e.__class__.__name__}: {e}"}
        r.update(key=key, title=title, seconds=round(time.time() - t0, 1), vram_peak_gb=trace.peak(key))
        results.append(r)
        print(("  ✅ " if r["ok"] else "  ❌ ") + r.get("detail", ""), flush=True)
        trace.stage = "idle"
        return r

    if "env" not in a.skip:
        def env():
            code, tail = sh([sys.executable, str(HERE / "check_env.py"), "--data", a.data, "--out", str(out), "--container"], out / "env.log", timeout=900)
            v = json.loads((out / "env_report.json").read_text("utf-8"))["verdict"]
            return {"ok": v != "FAIL", "detail": f"环境核对结论 {v}，详见 env_report.md"}
        step("env", "环境核对", env)

    image = a.image
    comfy_proc = None
    if "comfyui" not in a.skip and not image:
        def comfy():
            nonlocal comfy_proc, image
            if not comfy_alive(a.comfy_url):
                py = Path(a.comfy_dir) / "venv/bin/python"
                comfy_proc = subprocess.Popen([str(py), "main.py", "--listen", "127.0.0.1", "--port", a.comfy_url.rsplit(":", 1)[-1]],
                                              cwd=a.comfy_dir, stdout=(out / "comfyui_server.log").open("w"), stderr=subprocess.STDOUT)
                for _ in range(180):
                    if comfy_alive(a.comfy_url): break
                    time.sleep(1)
            sample = [sys.executable, str(HERE / "samples/comfy_qwen_image.py"), "--url", a.comfy_url, "--size", "1024", "--seed", "20261115"]
            code, tail = sh(sample + ["--out", str(out / "concept_warmup.png")], out / "comfyui_warmup.log")  # 首次含模型加载
            if code != 0:
                return {"ok": False, "detail": tail}
            code, tail = sh(sample + ["--out", str(out / "concept.png")], out / "comfyui.log")      # 模型已加载后的单张耗时
            meta = json.loads((out / "concept.json").read_text("utf-8")) if code == 0 else {}
            warm = json.loads((out / "concept_warmup.json").read_text("utf-8"))
            if code == 0:
                image = str(out / "concept.png")
                urllib.request.urlopen(urllib.request.Request(a.comfy_url + "/free", data=b'{"unload_models":true,"free_memory":true}', headers={"Content-Type": "application/json"}), timeout=30)
            return {"ok": code == 0, "detail": f"首张（含加载）{warm.get('seconds')}s，模型已加载后 {meta.get('seconds')}s，seed {meta.get('seed')}" if code == 0 else tail,
                    "metrics": {"first_seconds": warm.get("seconds"), "warm_seconds": meta.get("seconds")}}
        step("comfyui", "ComfyUI · Qwen-Image 概念图", comfy)
        if comfy_proc:
            comfy_proc.terminate()

    if "trellis2" not in a.skip and not a.glb:
        def trellis():
            if not image:
                return {"ok": False, "detail": "没有输入图片（ComfyUI 步骤失败且未指定 --image）"}
            env = dict(os.environ, HF_HOME=str(Path(a.data) / "models/hf"), TRELLIS2_HOME=f"{home}/TRELLIS.2")
            code, tail = sh([a.trellis_python, str(HERE / "samples/trellis2_run.py"), "--image", image, "--out", str(out / "raw.glb")], out / "trellis2.log", env=env)
            meta = json.loads((out / "raw.json").read_text("utf-8")) if (out / "raw.json").exists() else {}
            att = meta.get("attempts", [])
            gen = next((x["seconds"] for x in att if x.get("ok")), None)
            return {"ok": code == 0, "detail": (f"加载 {meta.get('load_seconds')}s，生成 {gen}s（{meta.get('resolution')}³），显存峰值 {meta.get('vram_peak_gb')}GB，"
                                                f"GLB {meta.get('file_mb')}MB" + ("，含一次 OOM 降级" if len(att) > 1 else "")) if code == 0 else tail,
                    "metrics": {"generate_seconds": gen, "attempts": att}}
        step("trellis2", "TRELLIS.2 · 图生 3D", trellis)

    if "blender" not in a.skip:
        def blender():
            src = Path(a.glb) if a.glb else out / "raw.glb"
            if not src.exists():
                return {"ok": False, "detail": "没有 raw.glb（上一步失败）"}
            res = []
            for name, tris, extra in (("quest3", 20000, []), ("webxr", 10000, ["--draco"])):
                code, tail = sh([a.bpy_python, str(HERE / "samples/blender_optimize.py"), "--in", str(src), "--out", str(out / f"{name}.glb"), "--tris", str(tris)] + extra,
                                out / f"blender_{name}.log")
                if code != 0:
                    return {"ok": False, "detail": f"{name}: {tail}"}
                res.append(json.loads((out / f"{name}.json").read_text("utf-8")))
            b = res[0]
            return {"ok": True, "detail": f"{b['engine']}：{b['before']['tris']:,} → Quest 3 {res[0]['after']['tris']:,} / WebXR {res[1]['after']['tris']:,} 三角形，"
                                          f"单件 {res[0]['seconds']}s，非流形边 {b['after']['non_manifold_edges']}", "metrics": res}
        step("blender", "Blender 无头 · 减面优化", blender)

    trace.save()
    ok = all(r["ok"] for r in results)
    lines = [f"# M0 验收报告（{stamp}）", "", f"结论：**{'✅ 通过' if ok else '❌ 有未通过项'}**", "",
             "| 步骤 | 结论 | 用时 | 显存峰值 | 结果 | 目标（SPEC） |", "| --- | --- | --- | --- | --- | --- |"]
    for r in results:
        lines.append(f"| {r['title']} | {'✅' if r['ok'] else '❌'} | {r['seconds']}s | {r['vram_peak_gb'] or '—'} GB | {r.get('detail', '')} | {TARGETS.get(r['key'], '')} |")
    lines += ["", "产出：concept.png（概念图）、raw.glb（TRELLIS.2 高模）、quest3.glb / webxr.glb（Blender 优化后）、gpu_trace.csv（显存采样）。",
              "这些实测值将在 M1 写回模型登记表（显存、单件耗时）。"]
    if (out / "env_report.md").exists():
        lines += ["", (out / "env_report.md").read_text("utf-8").replace("# M0 环境核对报告", "## 附：环境核对")]
    (out / "report.md").write_text("\n".join(lines) + "\n", "utf-8")
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), "utf-8")
    zp = out.parent / f"m0_report_{stamp}.zip"
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
        for f in out.iterdir():
            if f.stat().st_size < 200 * 2**20:
                z.write(f, f.name)
    print("\n" + "\n".join(lines[:4 + len(results) + 2]))
    print(f"\n报告：{out / 'report.md'}\n打包：{zp}（发回即可验收）")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
