#!/usr/bin/env python3
"""M0 样例 · TRELLIS.2 图生 3D（N2 节点）。在 conda 环境 trellis2 中运行：

    conda activate trellis2
    HF_HOME=/data/models/hf python ops/m0/samples/trellis2_run.py --image out/concept.png --out out/raw.glb

按 SPEC 实现：
  - 不做预览渲染（官方示例中的 render_video 会把显存峰值推到约 30GB，P04“关闭预览渲染”默认开启）
  - 显存溢出时释放显存，按节点降级参数（1024 → 512）重试 1 次，仍失败返回非零退出码（转人工）
调用方式依据官方 README 与 trellis2/pipelines/trellis2_image_to_3d.py（pipeline_type：'512' / '1024_cascade'）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
REPO = os.environ.get("TRELLIS2_HOME", "/opt/scw/TRELLIS.2")
if os.path.isdir(REPO):
    sys.path.insert(0, REPO)

PIPELINE_TYPE = {512: "512", 1024: "1024_cascade", 1536: "1536_cascade"}


def generate(pipeline, image, resolution: int, seed: int, steps: int | None):
    import torch
    sampler = {"steps": steps} if steps else {}
    torch.cuda.reset_peak_memory_stats()
    outputs = pipeline.run(image, seed=seed, pipeline_type=PIPELINE_TYPE[resolution],
                           sparse_structure_sampler_params=dict(sampler), shape_slat_sampler_params=dict(sampler), tex_slat_sampler_params=dict(sampler))
    return outputs[0], torch.cuda.max_memory_allocated() / 2**30


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", default="out/raw.glb")
    ap.add_argument("--resolution", type=int, default=1024, choices=[512, 1024, 1536])
    ap.add_argument("--texture", type=int, default=2048)
    ap.add_argument("--decimate", type=int, default=500000, help="导出前的面数目标（官方示例为 1,000,000）")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--steps", type=int, default=None, help="各阶段采样步数；不填用模型默认")
    ap.add_argument("--model", default="microsoft/TRELLIS.2-4B")
    ap.add_argument("--no-retry", action="store_true", help="由平台调度器统一管理一次 OOM 重试")
    a = ap.parse_args()

    import torch
    from PIL import Image
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    import o_voxel

    meta = {"engine": "TRELLIS.2", "model": a.model, "image": a.image, "seed": a.seed, "preview_render": False, "attempts": []}
    t_load = time.time()
    pipeline = Trellis2ImageTo3DPipeline.from_pretrained(a.model)
    pipeline.cuda()
    meta["load_seconds"] = round(time.time() - t_load, 1)
    image = Image.open(a.image)

    mesh, res = None, a.resolution
    for attempt in range(1 if a.no_retry else 2):
        t0 = time.time()
        try:
            mesh, peak = generate(pipeline, image, res, a.seed, a.steps)
            meta["attempts"].append({"resolution": res, "ok": True, "seconds": round(time.time() - t0, 1), "vram_peak_gb": round(peak, 2)})
            break
        except torch.cuda.OutOfMemoryError as e:
            meta["attempts"].append({"resolution": res, "ok": False, "error": "CUDA OOM", "seconds": round(time.time() - t0, 1)})
            torch.cuda.empty_cache()
            if not a.no_retry and attempt == 0 and res > 512:
                res = 512  # SPEC：OOM 降一档重试 1 次
                continue
            meta["status"] = "manual"
            print(json.dumps(meta, ensure_ascii=False)); return 2

    t0 = time.time()
    mesh.simplify(16777216)  # nvdiffrast 上限（官方示例）
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords, attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size, aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=a.decimate, texture_size=a.texture, remesh=True, remesh_band=1, remesh_project=0, verbose=False)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    glb.export(a.out, extension_webp=False)  # PNG 贴图，便于后续 Blender / glTF 校验通用读取
    meta.update(status="done", resolution=res, export_seconds=round(time.time() - t0, 1), file=a.out,
                file_mb=round(os.path.getsize(a.out) / 2**20, 2), vram_peak_gb=max(x.get("vram_peak_gb", 0) for x in meta["attempts"]),
                gpu=torch.cuda.get_device_name(0))
    with open(os.path.splitext(a.out)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
