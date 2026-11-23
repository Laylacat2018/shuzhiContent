#!/usr/bin/env python3
"""用本机 ComfyUI + Qwen 模型复原国博《李言恭配临淮侯夫人史氏像》中的命妇礼服。

只用 Python 标准库。自动探测本机已安装的 Qwen 模型文件和节点：
  - 有 Qwen-Image-Edit：以画像为参考图做“画像 → 人台复原照”（E2 组，推荐）
  - 有 Qwen-Image：按规格书文生图（E1 组）
用法：
  python comfy_qwen_restore.py --image 史氏像_国博官网.jpg
  python comfy_qwen_restore.py --image 史氏像_国博官网.jpg --seeds 3 --mode both
  python comfy_qwen_restore.py --probe          # 只看本机有哪些模型和节点
结果保存在 ./outputs/，文件名符合实验台命名规则，可直接拖进实验台上传。
"""
import argparse, json, os, random, sys, time, urllib.request, urllib.parse, uuid

SPEC_V2 = """【复原对象】明代万历年间临淮侯夫人史氏所着命妇礼服，依据中国国家博物馆藏《李言恭配临淮侯夫人史氏像》。
【呈现方式】服装穿在无头、无手臂的白色人台上，浅灰色纯色背景，博物馆文物复原图风格，写实丝绸织物质感，均匀柔光，全身完整入画。画面中不要人物、不要文字、不要水印、不要椅子或地毯。
【服装结构，由外到内】
1. 外层大衫：鲜亮的正红色素面丝绸，无任何纹样，不偏暗红、不偏橙；对襟，前襟边缘有细金边；袖子极其宽大，垂至膝下；衣长及地。
2. 霞帔：两条金地带子自颈后经两肩绕到胸前，在胸前并合后垂于身前正中，左右对称，一直垂到接近地面，末端收成尖角；单条宽度不超过肩宽的三分之一，不做成覆盖双肩的背心，不斜挂单肩。霞帔纹样以成对的翟鸟和五彩云纹为主，下段为海水江崖纹；尖角末端悬挂一枚金色水滴形坠子，宽度约为霞帔宽度的三分之一。
3. 内袍：明代蟒袍，金色地，胸前一条青绿色大蟒，两袖有通袖襕，膝部有膝襕；在大衫领口、胸前霞帔两带之间和两侧下摆露出。
4. 领口为交领白色护领，不做立领。
5. 腰前自然垂下一条白色长带。
【禁止出现】清代马蹄袖、盘扣、清式大襟立领、背心式霞帔、云肩、旗装、唐代齐胸襦裙、日式和服元素、拉链和现代纽扣；大衫上不能有刺绣图案。"""

EDIT_HEAD = "参考图是中国国家博物馆藏《李言恭配临淮侯夫人史氏像》。请严格依据画像中人物所穿的服装，把它复原成穿在无头白色人台上的实物服装照片。保留画像中服装的颜色、纹样布局和各层的相对位置；去掉画像中的人物、面部、冠饰、椅子、地毯和背景。\n"
VIEW = "【视角】正面，人台正对镜头。"
NEG = "人物, 人脸, 手, 冠饰, 椅子, 地毯, 文字, 水印, 马蹄袖, 盘扣, 立领, 背心, 云肩, 旗装, 斜挂, 暗红, 橙色, 低清晰度, 模糊, 变形"


STRUCT_V3 = """【构图与结构补充要求】
1. 人台正面正对镜头，左右严格对称，全身完整入画；两只袖子自然下垂于身体两侧，不折叠、不搭在身前、不横向撑开。
2. 霞帔为金色地，不是蓝色、绿色；两条带子平行并排垂于身前正中，在下端并合成一个尖角，只悬挂一枚金色水滴形坠子。
3. 两条霞帔之间、领口下方、大衫下摆两侧和袖口，露出金色地、青绿色大蟒纹的内袍；内袍是一整件长袍，不是方形补子，也不是条纹裙。
4. 地面上不要放任何布料，人台上方不要任何物件。"""
EDIT_HEAD_V3 = "参考图已裁剪为画像中的服装部分。画像胸前正中的金色竖条是两条并排的霞帔；领口下方和下摆两侧露出的金地青绿蟒纹属于内袍，请把霞帔和内袍分成两层表现。\n"
NEG_V3 = ", 条纹裙, 补子, 地上布料, 折叠的袖子, 侧身, 斜侧视角, 左右不对称, 蓝色霞帔, 绿色霞帔, 两个坠子"
DEFAULT_CROP = "0.10,0.295,0.90,0.845"
PHOTO_V4 = "【画面风格】真实摄影：博物馆展厅中实拍的织物照片，服装穿在站立的白色人台上，有真实的丝绸光泽、布料褶皱和柔和阴影。这不是绘画：不要保留画像的笔触、线描、平涂色块和绢本纸张质感。人台是站立的，大衫的袖子在身体两侧自然下垂，不要复制画像中坐姿时袖子堆叠在身侧的形态。"
NEG_V4 = ", 绘画, 工笔画, 国画, 线描, 平涂, 插画, 纸张纹理, 绢本, 画框, 地毯, 坐姿, 椅子"


def image_size(path):
    import struct
    b = open(path, "rb").read()
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", b[16:24])
    i = 2
    while i < len(b) - 9:
        if b[i] != 0xFF:
            i += 1
            continue
        m = b[i + 1]
        if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack(">HH", b[i + 5:i + 9])
            return w, h
        i += 2 + struct.unpack(">H", b[i + 2:i + 4])[0]
    raise ValueError("cannot read image size: " + path)


def crop_box(path, spec):
    if not spec or spec == "off":
        return None
    x0, y0, x1, y1 = [float(v) for v in spec.split(",")]
    w, h = image_size(path)
    return {"x": int(x0 * w), "y": int(y0 * h), "width": int((x1 - x0) * w), "height": int((y1 - y0) * h)}


def http(base, path, data=None, headers=None, raw=False):
    req = urllib.request.Request(base + path, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=600) as r:
        b = r.read()
    return b if raw else json.loads(b.decode("utf-8"))


def options(info, node, field):
    try:
        spec = info[node]["input"]["required"][field][0]
        return spec if isinstance(spec, list) else []
    except KeyError:
        return []


def pick(opts, *must, avoid=()):
    for o in opts:
        low = o.lower()
        if all(m in low for m in must) and not any(a in low for a in avoid):
            return o
    return None


def probe(base):
    info = http(base, "/object_info")
    unets = options(info, "UNETLoader", "unet_name")
    clips = options(info, "CLIPLoader", "clip_name")
    vaes = options(info, "VAELoader", "vae_name")
    loras = options(info, "LoraLoaderModelOnly", "lora_name")
    found = {
        "edit_unet": pick(unets, "qwen", "edit", avoid=("svdq", "nunchaku", "gguf", "int4")),
        "t2i_unet": pick(unets, "qwen", avoid=("edit", "svdq", "nunchaku", "gguf", "int4")),
        "clip": pick(clips, "qwen", "2.5", "vl") or pick(clips, "qwen"),
        "vae": pick(vaes, "qwen"),
        "edit_lightning": None,
        "t2i_lightning": None,
        "edit_node": "TextEncodeQwenImageEditPlus" if "TextEncodeQwenImageEditPlus" in info else ("TextEncodeQwenImageEdit" if "TextEncodeQwenImageEdit" in info else None),
        "has_cfgnorm": "CFGNorm" in info,
        "has_auraflow": "ModelSamplingAuraFlow" in info,
    }
    return info, found, {"unet": unets, "clip": clips, "vae": vaes, "lora": loras}


def fill_defaults(info, wf):
    """为每个节点补上 object_info 中声明了默认值、但工作流没写的必填输入。"""
    for node in wf.values():
        req = info.get(node["class_type"], {}).get("input", {}).get("required", {})
        for k, spec in req.items():
            if k in node["inputs"]:
                continue
            if len(spec) > 1 and isinstance(spec[1], dict) and "default" in spec[1]:
                node["inputs"][k] = spec[1]["default"]
            elif isinstance(spec[0], list) and spec[0]:
                node["inputs"][k] = spec[0][0]
    return wf


def model_chain(wf, f, unet, lightning):
    wf["unet"] = {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}}
    m = ["unet", 0]
    if lightning:
        wf["lora"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": m, "lora_name": lightning, "strength_model": 1.0}}
        m = ["lora", 0]
    if f["has_auraflow"]:
        wf["shift"] = {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": m, "shift": 3.1}}
        m = ["shift", 0]
    if f["has_cfgnorm"]:
        wf["cfgnorm"] = {"class_type": "CFGNorm", "inputs": {"model": m, "strength": 1.0}}
        m = ["cfgnorm", 0]
    wf["clip"] = {"class_type": "CLIPLoader", "inputs": {"clip_name": f["clip"], "type": "qwen_image"}}
    wf["vae"] = {"class_type": "VAELoader", "inputs": {"vae_name": f["vae"]}}
    return m


def edit_workflow(f, img_name, seed, steps, cfg):
    wf = {}
    m = model_chain(wf, f, f["edit_unet"], f["edit_lightning"])
    wf["img"] = {"class_type": "LoadImage", "inputs": {"image": img_name}}
    src = ["img", 0]
    if f.get("crop"):
        wf["crop"] = {"class_type": "ImageCrop", "inputs": dict(f["crop"], image=["img", 0])}
        src = ["crop", 0]
    wf["scale"] = {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": src, "upscale_method": "lanczos", "megapixels": 1.0}}
    key = "image1" if f["edit_node"].endswith("Plus") else "image"
    for name, text in (("pos", EDIT_HEAD + (EDIT_HEAD_V3 if f.get("crop") else "") + SPEC_V2 + "\n" + STRUCT_V3 + "\n" + PHOTO_V4 + "\n" + VIEW), ("neg", NEG + NEG_V3 + NEG_V4)):
        wf[name] = {"class_type": f["edit_node"], "inputs": {"clip": ["clip", 0], "prompt": text, "vae": ["vae", 0], key: ["scale", 0]}}
    wf["latent"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["scale", 0], "vae": ["vae", 0]}}
    wf["ks"] = {"class_type": "KSampler", "inputs": {"model": m, "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["latent", 0],
                "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}}
    wf["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}}
    wf["save"] = {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": "guobo_E2_qwen"}}
    return wf


def t2i_workflow(f, seed, steps, cfg):
    wf = {}
    m = model_chain(wf, f, f["t2i_unet"], f["t2i_lightning"])
    wf["pos"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": SPEC_V2 + "\n" + STRUCT_V3 + "\n" + PHOTO_V4 + "\n" + VIEW}}
    wf["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": NEG + NEG_V3 + NEG_V4}}
    wf["latent"] = {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1104, "height": 1472, "batch_size": 1}}
    wf["ks"] = {"class_type": "KSampler", "inputs": {"model": m, "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["latent", 0],
                "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}}
    wf["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}}
    wf["save"] = {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": "guobo_E1_qwen"}}
    return wf


def upload(base, path):
    boundary = uuid.uuid4().hex
    with open(path, "rb") as fh:
        content = fh.read()
    name = "guobo_" + os.path.basename(path).encode("ascii", "ignore").decode() or "guobo_portrait.jpg"
    if not name.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
        name += ".jpg"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + content + \
           (f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n").encode()
    r = http(base, "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return (r.get("subfolder") + "/" if r.get("subfolder") else "") + r["name"]


def run(base, info, wf, out_path):
    client = uuid.uuid4().hex
    r = http(base, "/prompt", json.dumps({"prompt": fill_defaults(info, wf), "client_id": client}).encode(), {"Content-Type": "application/json"})
    if r.get("node_errors"):
        raise RuntimeError(json.dumps(r["node_errors"], ensure_ascii=False))
    pid = r["prompt_id"]
    t0 = time.time()
    while True:
        h = http(base, f"/history/{pid}")
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                raise RuntimeError(json.dumps(st.get("messages", []), ensure_ascii=False)[:2000])
            for node in h[pid]["outputs"].values():
                for im in node.get("images", []):
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im["subfolder"], "type": im["type"]})
                    with open(out_path, "wb") as fh:
                        fh.write(http(base, "/view?" + q, raw=True))
                    return time.time() - t0
        time.sleep(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="http://127.0.0.1:8188")
    ap.add_argument("--image", help="国博画像文件路径")
    ap.add_argument("--mode", choices=["edit", "t2i", "both"], default="edit")
    ap.add_argument("--seeds", type=int, default=2)
    ap.add_argument("--steps", type=int, default=0, help="0 = 自动（有 Lightning LoRA 用 8 步，否则 30 步）")
    ap.add_argument("--cfg", type=float, default=0)
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--seed-list", default="", help="comma separated seeds to reuse, e.g. 1234440434,2081972815")
    ap.add_argument("--crop", default=DEFAULT_CROP, help="x0,y0,x1,y1 fractions of the portrait, or off")
    ap.add_argument("--out", default="outputs_v4", help="output folder")
    a = ap.parse_args()
    info, f, all_opts = probe(a.host)
    print("探测结果：", json.dumps(f, ensure_ascii=False, indent=1))
    if a.probe:
        print("全部候选：", json.dumps(all_opts, ensure_ascii=False, indent=1))
        return
    if not (f["clip"] and f["vae"]):
        sys.exit("没有找到 Qwen 的文本编码器或 VAE（models/text_encoders、models/vae），请先用 --probe 查看")
    os.makedirs(a.out, exist_ok=True)
    fixed = [int(v) for v in a.seed_list.split(",") if v.strip()]
    seed_plan = fixed + [random.randint(1, 2**31 - 1) for _ in range(max(0, a.seeds - len(fixed)))]
    jobs = []
    if a.mode in ("edit", "both"):
        if not (f["edit_unet"] and f["edit_node"] and a.image):
            print("跳过 E2：需要 Qwen-Image-Edit 模型、TextEncodeQwenImageEdit 节点和 --image")
        else:
            img = upload(a.host, a.image)
            f["crop"] = crop_box(a.image, a.crop)
            print("crop:", f["crop"] or "off")
            jobs += [("E2", lambda s, st, c: edit_workflow(f, img, s, st, c), f["edit_lightning"])]
    if a.mode in ("t2i", "both"):
        if not f["t2i_unet"]:
            print("跳过 E1：没有找到 Qwen-Image 文生图模型")
        else:
            jobs += [("E1", lambda s, st, c: t2i_workflow(f, s, st, c), f["t2i_lightning"])]
    log = []
    for group, build, lightning in jobs:
        steps = a.steps or (8 if lightning else 30)
        cfg = a.cfg or (1.0 if lightning else 4.0)
        for i, seed in enumerate(seed_plan, 1):
            out = os.path.join(a.out, f"{group}_qwen_front_{i}.png")
            print(f"生成 {out}  seed={seed} steps={steps} cfg={cfg} …", flush=True)
            sec = run(a.host, info, build(seed, steps, cfg), out)
            print(f"  完成，用时 {sec:.0f} 秒")
            log.append({"file": out, "group": group, "seed": seed, "steps": steps, "cfg": cfg, "seconds": round(sec),
                        "unet": f["edit_unet"] if group == "E2" else f["t2i_unet"], "lightning": lightning, "text_encoder": f["clip"], "vae": f["vae"],
                        "prompt": "v4", "crop": f.get("crop") if group == "E2" else None})
    with open(os.path.join(a.out, "run_log.json"), "w", encoding="utf-8") as fh:
        json.dump(log, fh, ensure_ascii=False, indent=1)
    print("全部完成，结果与参数记录在 " + a.out)


if __name__ == "__main__":
    main()
