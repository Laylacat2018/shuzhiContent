"""观众换装：规格书驱动的提示词、自动质检、主备模型切换。

三种玩法（活动 mode）：
  tryon     真换装：观众照片 + 定稿服饰图 → 观众本人穿上服饰，姿势和背景不变（线上玩法）
  swap      模板合影：专家审过的模板 + 观众自拍 → 把模板人物的脸换成观众（展厅现场）
  portrait  本人穿礼服：定稿服饰图 + 观众自拍 → 观众本人穿服饰出现在指定场景中
提示词全部由定稿所依据的规格书字段生成，版本号随结果一起记录，便于追溯。
"""
from __future__ import annotations

import random
import time

from . import ai

PROMPT_VERSION = "tryon-v1"
MODES = {"tryon": "真换装", "swap": "模板合影", "portrait": "本人穿礼服"}

# 默认策略（系统设置 → 模型接入 → 换装策略 可改）
DEFAULT_POLICY = {
    "tryon_chain": ["sdpro", "sd55"],      # 实测：Seedream 5.0 Pro 90 分；5.5 为备用（82 分，速度快）
    "swap_chain": ["sd55", "qimg3"],       # 实测：Seedream 5.5 82 分 / 28 秒；Qwen-Image 3.0 Pro 83 分但约 160 秒
    "portrait_chain": ["sdpro", "sd55"],
    "template_model": "sdpro",             # 生成合拍模板用的模型
    "qc": True,                            # 出图后用视觉模型逐项检查服饰要点
    "qc_model": "qc",
    "qc_pass": 70,                         # 质检分 ≥ 该值且人脸数为 1 才算合格
    "qc_floor": 55,                        # 全部尝试都不合格时，最好一张 ≥ 该值才返回给观众，否则报失败
    "tries_per_model": 2,                  # 每个模型最多试几次（第二次换随机种子）
    "deadline": 150,                       # 单次请求总时长上限（秒），超时不再发起新尝试
}

_HUMAN_FIELDS_SKIP = {"F1", "F10", "F11", "F12"}  # 款式（含“人台”）、背面、尺寸、禁用元素另行处理


def _clean(text: str) -> str:
    for w in ("服装穿在无头、无手臂的白色人台上", "穿在无头白色人台上", "；服装穿在无头白色人台上", "人台"):
        text = text.replace(w, "")
    return text.strip("；;，, ")


def garment_points(fields: list[dict]) -> tuple[list[str], str]:
    """规格书字段 → 形制要点（按字段顺序，每条一句）和禁用元素。"""
    pts, forbid = [], ""
    for f in fields:
        if f.get("na") or f.get("level") == "miss":
            continue
        if f["code"] == "F12":
            forbid = f.get("content", "")
            continue
        if f["code"] in _HUMAN_FIELDS_SKIP:
            continue
        c = _clean(f.get("content", ""))
        if c:
            pts.append(f"{f['name']}：{c}")
    style = next((f for f in fields if f["code"] == "F1" and not f.get("na")), None)
    if style:
        s = _clean(style.get("content", ""))
        if s and s != "待考":
            pts.insert(0, f"款式：{s}")
    return pts, forbid


def build(mode: str, fields: list[dict], scene: str = "") -> tuple[str, str]:
    """返回 (提示词, 反向提示词)。图片顺序由 refs_for() 决定，与提示词中的“图1/图2”一一对应。"""
    pts, forbid = garment_points(fields)
    spec = "\n".join(f"{i + 1}. {p}" for i, p in enumerate(pts))
    keep_strict = "数量、颜色、位置不得改变：例如只有一枚坠子就只画一枚，霞帔两带在下端并合成一个尖角。"
    forbid_line = f"\n【禁止】{forbid}；不要改变人物的年龄和性别特征；不要文字和水印。" if forbid else "\n【禁止】不要改变人物的年龄和性别特征；不要文字和水印。"
    if mode == "tryon":
        head = ("【图片】图1是观众本人的照片；图2是专家定稿的复原服饰（服饰参考）。\n"
                "【任务】让图1中的人物穿上图2中的整套服饰，像真的穿在身上一样。\n")
        keep = "【保持不变】图1人物的脸、五官、发型、表情、姿势、手势、身材比例、背景和光线完全不变。"
    elif mode == "swap":
        head = ("【图片】图1是合拍模板（已审定的服饰与场景）；图2是观众本人的照片。\n"
                "【任务】把图1中人物的脸换成图2中人物的脸：五官、脸型、肤色、眼镜（如有）与图2一致，看起来就是图2这个人本人。\n")
        keep = "【保持不变】图1的服饰、发髻、姿势、手势、背景、光线和构图完全不变；脸部与身体的光影、肤色自然融合。"
    elif mode == "portrait":
        head = ("【图片】图1是专家定稿的复原服饰；图2是观众本人的照片。\n"
                f"【任务】生成图2这个人本人穿着图1整套服饰的写实照片：脸、五官、脸型、眼镜和发型与图2一致。场景：{scene or '江南园林的月洞门前，身旁有梅花与竹子'}；"
                "半身或七分身构图，正面，微笑看镜头，自然柔光。\n")
        keep = "【保持不变】人物身份与图2一致，服饰与图1一致。"
    else:
        raise ValueError(mode)
    garment = f"【服饰形制要点（必须全部符合，{keep_strict}）】\n{spec}\n" if mode != "swap" else ""
    prompt = head + garment + keep + forbid_line + "\n照片真实感，清晰。"
    neg = "文字, 水印, 变形, 多余的手指, 模糊, " + forbid.replace("、", ", ")
    return prompt, neg


def refs_for(mode: str, selfie: bytes, garment: bytes | None, template: bytes | None) -> list[bytes]:
    if mode == "tryon":
        return [selfie, garment]
    if mode == "swap":
        return [template, selfie]
    return [garment, selfie]


def size_for(mode: str, selfie: bytes, template: bytes | None) -> str:
    if mode == "tryon":
        return ai.size_for(selfie)
    if mode == "swap" and template:
        return ai.size_for(template)
    return "1536x2048"


# ---------------------------------------------------------------- 质检

def qc_prompt(mode: str, fields: list[dict]) -> str:
    pts, forbid = garment_points(fields)
    checks = [{"id": f"G{i + 1}", "rule": p} for i, p in enumerate(pts)]
    checks.append({"id": "FORBID", "rule": f"没有出现禁用元素：{forbid or '无'}；没有文字水印"})
    checks.append({"id": "IMAGE", "rule": "画面清晰，人物没有明显畸形（多余手指、五官扭曲、肢体断裂）"})
    if mode != "portrait":
        checks.append({"id": "KEEP", "rule": "图2中人物的姿势、背景与原照片相比没有被大幅改变（若无法判断记为 true）"})
    import json
    return ("你是服饰复原质检员。图1是专家定稿的标准服饰，图2是 AI 生成的观众照片。请逐条检查图2是否符合规则，"
            "数量和颜色要严格核对（例如坠子数量、内袍底色）。只输出 JSON：\n"
            '{"image2_faces": 只数图2（生成结果）中清晰人脸的数量，不要把图1计算在内, "checks": [{"id": "…", "ok": true 或 false, "why": "不符合时简述原因"}], "score": 0到100的整数}\n'
            "规则：" + json.dumps(checks, ensure_ascii=False))


def qc_parse(text: str, pass_score: int) -> dict:
    try:
        d = ai.parse_json_block(text)
    except Exception:
        return {"ok": False, "score": 0, "faces": None, "failed": ["质检结果无法解析"]}
    checks = d.get("checks") or []
    failed = [f"{c.get('id')}{('：' + c['why']) if c.get('why') else ''}" for c in checks if c.get("ok") is False]
    total = len(checks) or 1
    rule_score = round(100 * (total - len(failed)) / total)
    score = min(int(d.get("score", rule_score) or 0), rule_score) if "score" in d else rule_score
    faces = d.get("image2_faces", d.get("faces"))
    critical = any(str(x).startswith(("IMAGE", "FORBID")) for x in failed)
    ok = score >= pass_score and faces in (1, None) and not critical
    return {"ok": ok, "score": score, "faces": faces, "failed": failed}


# ---------------------------------------------------------------- 主备切换

def run(mode: str, selfie: bytes, garment: bytes | None, template: bytes | None, fields: list[dict], policy: dict,
        adapter_for, qc_adapter=None, scene: str = "") -> tuple[bytes, dict]:
    """按策略依次尝试模型：出错 → 换下一个；质检不合格 → 同模型换种子再试，仍不合格 → 换下一个。
    返回 (图片, 记录)。全部不合格时返回质检分最高且不低于 qc_floor 的一张；否则抛 ModelError。"""
    pol = dict(DEFAULT_POLICY, **(policy or {}))
    chain = [c for c in pol.get(f"{mode}_chain") or [] if c]
    if not chain:
        raise ai.ModelError(f"未配置“{MODES.get(mode, mode)}”使用的模型")
    prompt, neg = build(mode, fields, scene)
    refs = refs_for(mode, selfie, garment, template)
    if any(r is None for r in refs):
        raise ai.ModelError("缺少服饰图或模板图")
    size = size_for(mode, selfie, template)
    t_start = time.time()
    attempts, best = [], None
    qprompt = qc_prompt(mode, fields) if pol.get("qc") and qc_adapter else None
    for code in chain:
        try:
            adapter, cfg, mocked = adapter_for(code)
        except ai.ModelError as e:
            attempts.append({"model": code, "error": str(e)[:200]})
            continue
        for k in range(int(pol.get("tries_per_model", 2))):
            # 预算：已用时间 + 最近一次尝试的耗时超过上限，就不再发起新尝试
            last = max([a.get("seconds", 0) + (a.get("qc") or {}).get("seconds", 0) for a in attempts] or [0])
            if time.time() - t_start + last > pol["deadline"]:
                break
            seed = random.randint(1, 2**31 - 1)
            rec = {"model": code, "model_name": cfg["name"], "seed": seed, "try": k + 1}
            t0 = time.time()
            try:
                img = adapter.generate(prompt, neg, refs, seed, size=size)
            except ai.ModelError as e:
                rec.update(error=str(e)[:200], seconds=round(time.time() - t0, 1))
                attempts.append(rec)
                break                                   # 接口错误：直接换下一个模型
            rec["seconds"] = round(time.time() - t0, 1)
            if qprompt and not mocked:
                t1 = time.time()
                try:
                    q = qc_parse(qc_adapter.ask(qprompt, [garment or template, img], json_mode=True), int(pol["qc_pass"]))
                except ai.ModelError as e:              # 质检服务异常不阻塞出图，记为未质检
                    q = {"ok": True, "score": None, "faces": None, "failed": [], "error": str(e)[:120]}
                q["seconds"] = round(time.time() - t1, 1)
                rec["qc"] = q
            else:
                rec["qc"] = {"ok": True, "score": None, "skipped": True}
            attempts.append(rec)
            if rec["qc"]["ok"]:
                return img, _summary(mode, rec, attempts, t_start, prompt, size, mocked)
            if best is None or (rec["qc"].get("score") or 0) > (best[1]["qc"].get("score") or 0):
                best = (img, rec)
        if time.time() - t_start > pol["deadline"]:
            break
    if best and (best[1]["qc"].get("score") or 0) >= int(pol["qc_floor"]) and best[1]["qc"].get("faces") in (1, None):
        return best[0], _summary(mode, best[1], attempts, t_start, prompt, size, False, degraded=True)
    errs = "；".join(a.get("error") or ("质检 " + str(a.get("qc", {}).get("score"))) for a in attempts)[:300]
    raise ai.ModelError(f"所有模型均未生成合格结果（{errs}）")


def _summary(mode, rec, attempts, t_start, prompt, size, mocked, degraded=False):
    return {"mode": mode, "model": rec["model"], "model_name": rec.get("model_name"), "seed": rec.get("seed"),
            "qc_score": rec.get("qc", {}).get("score"), "qc_failed": rec.get("qc", {}).get("failed", []), "degraded": degraded,
            "attempts": attempts, "seconds": round(time.time() - t_start, 1), "prompt_version": PROMPT_VERSION,
            "prompt": prompt, "size": size, "mock": mocked}
