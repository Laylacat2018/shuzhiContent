"""生成任务调度：云端模型并发执行，本地 GPU（ComfyUI）单独排队；一个模型失败不影响其他模型。"""
from __future__ import annotations

import concurrent.futures
import random
import threading
import time

from . import ai, defaults
from .core import DEMO, dec, file_bytes, model_cfg, save_file, store

POOL = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="gen")
GPU_LOCK = threading.Lock()


def adapter_for(code: str):
    cfg = model_cfg(code)
    if not cfg:
        raise ai.ModelError(f"未找到模型 {code}")
    if not cfg.get("enabled", True):
        raise ai.ModelError(f"{cfg['name']} 已停用")
    key = dec(cfg.get("key"))
    kind = cfg["kind"]
    if DEMO and not key and kind not in ("comfyui",):
        kind = "mock"
    if DEMO and kind == "comfyui" and cfg.get("demo_mock", True):
        kind = "mock"
    return ai.ADAPTERS[kind](cfg, key), cfg, kind == "mock"


def spec_fields(version_id: str) -> list[dict]:
    fs = store.list("spec_fields", version_id=version_id)
    return sorted(fs, key=lambda f: (int(f["code"][1:]) if f["code"][1:].isdigit() else 99, f["code"]))


def primary_source(pid: str) -> dict | None:
    for s in store.list("sources", project_id=pid):
        if s.get("primary") and s.get("file_id"):
            return s
    return None


def run_task(task_id: str):
    t = store.get("gen_tasks", task_id)
    job = store.get("gen_jobs", t["job_id"])
    store.update("gen_tasks", task_id, {"status": "running", "started": time.time()})
    try:
        adapter, cfg, mocked = adapter_for(t["model"])
        lock = GPU_LOCK if cfg["kind"] == "comfyui" else None
        fields = spec_fields(job["spec_version_id"])
        refs, ref_file = [], None
        if job.get("ref_run_id"):
            rr = store.get("runs", job["ref_run_id"])
            ref_file = rr["file_id"]
        elif job["stage"] in ("draft", "experiment") and job.get("group") != "E1":
            ps = primary_source(job["project_id"])
            ref_file = ps["file_id"] if ps else None
        if ref_file and job.get("group") != "E0":
            refs = [file_bytes(ref_file)]
        prompt, neg = ai.build_prompt(fields, job["stage"], job["view"], bool(refs), job.get("revisions"), job.get("group"))
        if job.get("prompt_override"):
            prompt = job["prompt_override"]
        for i in range(job["per_model"]):
            seed = job.get("seed") or random.randint(1, 2**31 - 1)
            if job.get("seed"):
                seed = job["seed"] + i
            t0 = time.time()
            if lock:
                with lock:
                    img = adapter.generate(prompt, neg, refs, seed)
            else:
                img = adapter.generate(prompt, neg, refs, seed)
            secs = round(time.time() - t0, 1)
            meta = {"label": "AI 生成", "platform": "衣冠·AI复原工作台", "model": cfg["name"], "seed": seed, "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
            f = save_file(ai.add_aigc_meta(img, meta), "image/png", job["created_by"], f"{job['group']}_{t['model']}_{job['view']}_{i+1}.png")
            store.insert("runs", {"project_id": job["project_id"], "job_id": job["id"], "stage": job["stage"], "group": job["group"],
                                  "model": t["model"], "model_name": cfg["name"], "model_version": cfg.get("model"), "view": job["view"],
                                  "seed": seed, "prompt": prompt, "negative": neg, "spec_version_id": job["spec_version_id"],
                                  "spec_version": job.get("spec_version_no"), "ref_file_id": ref_file, "file_id": f["id"],
                                  "seconds": secs, "source": "api", "mock": mocked, "by": job["created_by"]})
            store.update("gen_tasks", task_id, {"done": i + 1})
            m = model_cfg(t["model"])
            store.update("models", m["id"], {"used": int(m.get("used", 0)) + 1})
        store.update("gen_tasks", task_id, {"status": "done", "finished": time.time()})
    except Exception as e:  # 记录失败原因，可单独重试
        store.update("gen_tasks", task_id, {"status": "failed", "error": str(e)[:400], "finished": time.time()})


def submit(task_id: str):
    return POOL.submit(run_task, task_id)


def tryon_policy() -> dict:
    from .tryon import DEFAULT_POLICY
    cfg = model_cfg("fusion") or {}
    return dict(DEFAULT_POLICY, **(cfg.get("policy") or {}))


def qc_adapter(policy: dict):
    """质检视觉模型；未配置密钥或已停用时返回 None（跳过质检，不阻塞出图）。"""
    if not policy.get("qc"):
        return None
    try:
        a, cfg, mocked = adapter_for(policy.get("qc_model") or "qc")
    except ai.ModelError:
        return None
    return None if mocked else a


def tryon_generate(mode: str, selfie: bytes, garment: bytes | None, template: bytes | None, fields: list, scene: str = "") -> tuple[bytes, dict]:
    """观众换装：规格书提示词 + 主备模型 + 自动质检，见 tryon.run。"""
    from . import tryon
    pol = tryon_policy()
    img, info = tryon.run(mode, selfie, garment, template, fields, pol, adapter_for, qc_adapter(pol), scene)
    for a in info["attempts"]:                     # 用量与成本统计
        if a.get("error") and "seconds" not in a:
            continue
        m = model_cfg(a["model"])
        if m:
            store.update("models", m["id"], {"used": int(m.get("used", 0)) + 1})
    info["cost"] = round(sum(float((model_cfg(a["model"]) or {}).get("price") or 0) for a in info["attempts"] if "seconds" in a and not a.get("error")), 3)
    return img, info


def final_context(final: dict) -> tuple[bytes, list]:
    """定稿 → (服饰图, 所依据规格书版本的字段)。"""
    run = store.get("runs", final["run_ids"][0])
    return file_bytes(run["file_id"]), spec_fields(run["spec_version_id"]) if run.get("spec_version_id") else []


def fusion_generate(selfie: bytes, template_png: bytes, mode: str, fields: list | None = None) -> bytes:
    """模板合影（兼容旧调用）：等同 tryon_generate("swap")。"""
    return tryon_generate("swap", selfie, None, template_png, fields or [])[0]


def template_generate(final_png: bytes, gender: str, pose: str, bg: str) -> tuple[bytes, dict, bool]:
    cfg = model_cfg("fusion")
    code = tryon_policy().get("template_model") or cfg.get("model") or "sd"
    try:
        adapter, gcfg, mocked = adapter_for(code)
    except ai.ModelError:
        adapter, gcfg, mocked = adapter_for(cfg.get("model") or "sd")
    who = {"女": "一位虚构的年轻中国女性", "男": "一位虚构的年轻中国男性", "儿童": "一位虚构的中国儿童"}.get(gender, "一位虚构人物")
    prompt = (f"参考图是专家定稿的明代服饰复原件。请生成{who}（不是任何真实人物）穿着这件服装的写实全身照片，"
              f"姿势：{pose}；背景：{bg}（不要宫殿、城楼、宫门等建筑）。膝盖以上七分身构图，人物充满画面，脸部正对镜头、清晰无遮挡、面部宽度不小于画面宽度的五分之一；"
              "服装的颜色、纹样、结构必须与参考图完全一致，霞帔与坠子完整可见；"
              "不要冠饰，发型为简单的明式发髻；不要文字。")
    img = adapter.generate(prompt, "文字, 水印, 真实名人", [final_png], random.randint(1, 2**31 - 1))
    return img, {"model": gcfg["name"], "prompt": prompt}, mocked
