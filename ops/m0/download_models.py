#!/usr/bin/env python3
"""M0 · 下载首批模型到 /data/models，并生成模型登记表核对清单。

首批（M0 跑通三个引擎所需）：
  - Qwen-Image（ComfyUI 拆分文件：fp8 扩散模型、Qwen2.5-VL 文本编码器、VAE）—— Apache-2.0
  - TRELLIS.2-4B —— MIT；其 pipeline.json 引用的依赖模型（图像特征、去背景）自动解析后一并下载

依赖：pip install huggingface_hub（setup_gpu_host.sh --trellis2 已在 trellis2 环境中安装）

    python ops/m0/download_models.py --data /data            # 全部
    python ops/m0/download_models.py --only qwen-image        # 单项
    HF_ENDPOINT=https://hf-mirror.com python ops/m0/download_models.py   # 国内镜像

有些依赖模型（例如 DINOv3）在 Hugging Face 上需要先登录并同意许可协议，脚本会给出页面地址；
同意后执行 `huggingface-cli login` 再重跑。下载支持断点续传，可重复运行。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

QWEN_FILES = [  # 来源：ComfyUI 官方模板 Comfy-Org/workflow_templates · image_qwen_image.json
    ("Comfy-Org/Qwen-Image_ComfyUI", "split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors", "diffusion_models"),
    ("Comfy-Org/Qwen-Image_ComfyUI", "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors", "text_encoders"),
    ("Comfy-Org/Qwen-Image_ComfyUI", "split_files/vae/qwen_image_vae.safetensors", "vae"),
]
TRELLIS = "microsoft/TRELLIS.2-4B"
REPO_ID = re.compile(r"^[A-Za-z0-9][\w.-]*/[\w.-]+$")


def hf():
    try:
        import huggingface_hub as h  # noqa
        return h
    except ImportError:
        sys.exit("缺少 huggingface_hub：pip install huggingface_hub")


def gated_hint(repo: str, e: Exception) -> str:
    return (f"  ✗ {repo} 需要授权：{e.__class__.__name__}\n"
            f"    1) 浏览器打开 https://huggingface.co/{repo} 登录并同意许可协议\n"
            f"    2) 终端执行 huggingface-cli login（粘贴 Read 权限的 Access Token）\n"
            f"    3) 重新运行本脚本\n"
            f"    注意：该模型的许可条款需由管理员登记到模型登记表（PRD 6.1），核对前仅内部原型可用。")


def dl_qwen(root: Path) -> list[dict]:
    h = hf()
    out = []
    for repo, fn, kind in QWEN_FILES:
        dst = root / "comfyui" / kind / Path(fn).name
        if dst.exists() and dst.stat().st_size > 1_000_000:
            print(f"  ✓ 已存在 {dst}")
        else:
            print(f"  ↓ {repo}/{fn}")
            p = h.hf_hub_download(repo, fn, cache_dir=str(root / "hf" / "hub"))
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists() or dst.is_symlink():
                dst.unlink()
            os.symlink(os.path.realpath(p), dst)
        out.append({"model": "qwen-image-fp8", "file": str(dst), "gb": round(dst.stat().st_size / 1e9, 2), "license": "Apache-2.0"})
    return out


def find_repo_ids(obj, found: set) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and k in ("name", "model_name", "pretrained", "repo_id", "path") and REPO_ID.match(v) and not v.startswith(("ckpts/", "./")):
                found.add(v)
            find_repo_ids(v, found)
    elif isinstance(obj, list):
        for v in obj:
            find_repo_ids(v, found)


def dl_trellis(root: Path) -> list[dict]:
    h = hf()
    out, failed = [], []
    print(f"  ↓ {TRELLIS}")
    local = Path(h.snapshot_download(TRELLIS, cache_dir=str(root / "hf" / "hub")))
    size = sum(f.stat().st_size for f in local.rglob("*") if f.is_file())
    out.append({"model": "trellis2-4b", "repo": TRELLIS, "gb": round(size / 1e9, 2), "license": "MIT"})
    deps: set = set()
    for cfg in local.rglob("*.json"):
        try:
            find_repo_ids(json.loads(cfg.read_text("utf-8")), deps)
        except (ValueError, UnicodeDecodeError):
            pass
    deps.add("ZhengPeng7/BiRefNet")  # trellis2/pipelines/rembg/BiRefNet.py 的默认值
    deps.discard(TRELLIS)
    print(f"  依赖模型：{', '.join(sorted(deps)) or '无'}")
    for repo in sorted(deps):
        try:
            p = Path(h.snapshot_download(repo, cache_dir=str(root / "hf" / "hub")))
            size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
            info = {}
            try:
                info = h.model_info(repo).cardData or {}
            except Exception:
                pass
            out.append({"model": "trellis2-dep", "repo": repo, "gb": round(size / 1e9, 2), "license": str(info.get("license", "待核对"))})
            print(f"  ✓ {repo}")
        except Exception as e:  # GatedRepoError / RepositoryNotFoundError / 网络
            failed.append(repo)
            print(gated_hint(repo, e))
            out.append({"model": "trellis2-dep", "repo": repo, "gb": 0, "license": "待核对", "error": str(e)[:200]})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=os.environ.get("SCW_DATA", "/data"))
    ap.add_argument("--only", choices=["qwen-image", "trellis2"])
    ap.add_argument("--out", default="reports/m0")
    a = ap.parse_args()
    root = Path(a.data) / "models"
    os.environ.setdefault("HF_HOME", str(root / "hf"))
    free = shutil.disk_usage(root if root.exists() else Path(a.data).parent).free / 1e9
    print(f"模型目录 {root}（可用 {free:.0f} GB；首批约需 60 GB）")
    if free < 70:
        print("  ⚠ 可用空间不足 70GB，下载可能失败")
    items: list[dict] = []
    if a.only in (None, "qwen-image"):
        print("[1] Qwen-Image（ComfyUI）"); items += dl_qwen(root)
    if a.only in (None, "trellis2"):
        print("[2] TRELLIS.2-4B 及依赖"); items += dl_trellis(root)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    (out / "models.json").write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")
    bad = [i for i in items if i.get("error")]
    print(f"\n完成 {len(items) - len(bad)} 项，失败 {len(bad)} 项。清单：{out / 'models.json'}")
    print("运行时请设置 HF_HOME=" + str(root / "hf") + "，使 from_pretrained 直接命中本地缓存。")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
