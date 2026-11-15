#!/usr/bin/env python3
"""M0 样例 · ComfyUI + Qwen-Image 概念图（N1 节点）。只用标准库，通过 ComfyUI HTTP API 提交工作流。

前提：ComfyUI 已启动（/opt/scw/ComfyUI/venv/bin/python main.py --listen 127.0.0.1 --port 8188），
      模型已由 download_models.py 放到 /data/models/comfyui。

    python3 ops/m0/samples/comfy_qwen_image.py --prompt "商周青铜鼎，写实，白色背景" --out out/concept.png

参数默认值取自 ComfyUI 官方模板 image_qwen_image.json（非 Lightning）：20 步、CFG 4、euler/simple、
ModelSamplingAuraFlow shift 3.1、1328×1328。
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

DEFAULTS = dict(unet="qwen_image_fp8_e4m3fn.safetensors", clip="qwen_2.5_vl_7b_fp8_scaled.safetensors", vae="qwen_image_vae.safetensors",
                steps=20, cfg=4.0, sampler="euler", scheduler="simple", shift=3.1, width=1328, height=1328)


def workflow(prompt: str, negative: str, seed: int, o: dict, prefix: str) -> dict:
    """ComfyUI API 格式工作流（节点编号为字符串，输入引用为 [节点, 输出序号]）。"""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": o["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": o["clip"], "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": o["vae"]}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": o["shift"]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": negative}},
        "7": {"class_type": "EmptySD3LatentImage", "inputs": {"width": o["width"], "height": o["height"], "batch_size": o.get("batch", 1)}},
        "8": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0],
                                                    "seed": seed, "steps": o["steps"], "cfg": o["cfg"], "sampler_name": o["sampler"],
                                                    "scheduler": o["scheduler"], "denoise": 1.0}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": prefix}},
    }


class Comfy:
    def __init__(self, url: str):
        self.url = url.rstrip("/")
        self.client_id = uuid.uuid4().hex

    def _req(self, method: str, path: str, body: dict | None = None, timeout: int = 60):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.url + path, data=data, method=method, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            return json.loads(raw) if "json" in ctype else raw

    def submit(self, wf: dict) -> str:
        try:
            r = self._req("POST", "/prompt", {"prompt": wf, "client_id": self.client_id})
        except urllib.error.HTTPError as e:  # 工作流校验失败时 ComfyUI 返回 400 与 node_errors
            raise RuntimeError("ComfyUI 拒绝工作流：" + e.read().decode("utf-8", "replace")[:2000]) from None
        return r["prompt_id"]

    def wait(self, pid: str, timeout: float = 1800) -> dict:
        t0 = time.time()
        while time.time() - t0 < timeout:
            h = self._req("GET", f"/history/{pid}")
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error":
                    msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                    raise RuntimeError("ComfyUI 执行失败：" + json.dumps(msgs, ensure_ascii=False)[:2000])
                if st.get("completed") or h[pid].get("outputs"):
                    return h[pid]
            time.sleep(1)
        raise TimeoutError("等待 ComfyUI 超时")

    def images(self, hist: dict) -> list[bytes]:
        out = []
        for node in hist.get("outputs", {}).values():
            for im in node.get("images", []):
                q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                out.append(self._req("GET", "/view?" + q, timeout=120))
        return out

    def free(self) -> None:
        """释放模型与显存（SPEC 3：换载前调用 ComfyUI 的释放接口）。"""
        self._req("POST", "/free", {"unload_models": True, "free_memory": True})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8188")
    ap.add_argument("--prompt", default="商周风格青铜鼎，三足双耳，表面饕餮纹与绿色铜锈，博物馆展品摄影，纯白背景，居中，完整物体，柔和棚拍光")
    ap.add_argument("--negative", default="模糊，低清，多余物体，文字，水印，裁切")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--steps", type=int, default=DEFAULTS["steps"])
    ap.add_argument("--size", type=int, default=1024, help="边长；官方模板为 1328")
    ap.add_argument("--out", default="out/concept.png")
    ap.add_argument("--free", action="store_true", help="完成后释放显存")
    ap.add_argument("--dry-run", action="store_true", help="只打印工作流 JSON")
    a = ap.parse_args()
    seed = a.seed if a.seed is not None else random.randint(0, 2**31 - 1)
    o = dict(DEFAULTS, steps=a.steps, width=a.size, height=a.size)
    wf = workflow(a.prompt, a.negative, seed, o, "scw_m0")
    if a.dry_run:
        print(json.dumps(wf, ensure_ascii=False, indent=2)); return 0
    c = Comfy(a.url)
    t0 = time.time()
    pid = c.submit(wf)
    hist = c.wait(pid)
    imgs = c.images(hist)
    if not imgs:
        raise RuntimeError("没有输出图片")
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(imgs[0])
    meta = {"engine": "ComfyUI", "model": o["unet"], "prompt": a.prompt, "seed": seed, "steps": o["steps"], "cfg": o["cfg"],
            "size": [o["width"], o["height"]], "seconds": round(time.time() - t0, 1), "file": str(out), "prompt_id": pid}
    out.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
    if a.free:
        c.free()
    print(json.dumps(meta, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
