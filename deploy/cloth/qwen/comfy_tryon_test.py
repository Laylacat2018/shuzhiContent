#!/usr/bin/env python3
"""本机 ComfyUI + Qwen-Image-Edit-2509 换装 / 换脸测试（国博史氏命妇礼服）。

只用 Python 标准库。与云端测试用同一套素材，三类测试：
  A 真换装      图1=观众全身照，图2=礼服  → 观众穿上礼服，姿势背景不变
  B 本人穿礼服  图1=礼服，图2=观众自拍    → 观众本人穿礼服站在园林里（Liblib“换装+脸部参考”的思路）
  C 模板换脸    图1=礼服模板，图2=观众自拍 → BFS-V3 换头 LoRA；另跑一组不加 LoRA 的对照 C0
用法（在 WSL 里，ComfyUI 已启动）：
  python3 comfy_tryon_test.py --probe              # 看本机模型和 LoRA
  python3 comfy_tryon_test.py                      # 默认三类各 2 张，30 步
  python3 comfy_tryon_test.py --only C --seeds 3   # 只跑换脸
结果和参数记录在 ./outputs_tryon/。
"""
import argparse, json, os, random, sys, time, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
INPUTS = {  # 素材在脚本同目录的 tryon_inputs/ 下
    "garment": "garment.jpg", "v1": "v1_woman_full.jpg", "v2": "v2_man_full.jpg",
    "v3": "v3_girl_selfie.jpg", "tpl": "template_garden.jpg",
}
GARMENT = "整套明代命妇礼服：大红色大袖衫（金色滚边）、身前垂挂的金色织绣霞帔及底端金色水滴形坠子、里面的织金云龙纹长袍、白色交领和白色系带"
PROMPT_A = ("让图1中的人物穿上图2中的" + GARMENT + "。服饰的形制、颜色、纹样必须与图2一致。"
            "保持图1人物的脸、发型、姿势、手势、身材比例和背景完全不变。光影自然，照片真实感。")
PROMPT_B = ("图2中的这个人穿上图1中的" + GARMENT + "，服饰的形制、颜色、纹样与图1一致。她的脸、五官、脸型、眼镜和发型与图2完全一致，看起来就是图2这个人本人。"
            "她站在江南园林的月洞门前，身旁有梅花与竹子，膝盖以上七分身构图，正面，双手在身前交握，微笑看镜头，傍晚柔光，照片真实感。")
PROMPT_C = ("head_swap: start with Picture1 as the base image, keeping its lighting, environment, and background. "
            "Remove the head from Picture1 completely and replace it with the head from Picture2. Ensure the head and body have correct "
            "anatomical proportions, and blend the skin tones, shadows, and lighting naturally so the final result appears as one coherent, realistic person.")
NEG = "低清晰度, 模糊, 变形, 多余的手指, 文字, 水印"
TESTS = {  # key: (图片列表, 提示词, 是否用 BFS LoRA)
    "A_v1": (["v1", "garment"], PROMPT_A, False),
    "A_v2": (["v2", "garment"], PROMPT_A.replace("姿势、手势", "姿势"), False),
    "B_v3": (["garment", "v3"], PROMPT_B, False),
    "C_v3": (["tpl", "v3"], PROMPT_C, True),
    "C0_v3": (["tpl", "v3"], PROMPT_C, False),
}


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
    f = {
        "unet": pick(unets, "qwen", "edit", "2509", avoid=("svdq", "nunchaku", "gguf", "int4")) or pick(unets, "qwen", "edit", avoid=("svdq", "nunchaku", "gguf", "int4", "2511")),
        "clip": pick(clips, "qwen", "2.5", "vl") or pick(clips, "qwen"),
        "vae": pick(vaes, "qwen"),
        "bfs": pick(loras, "bfs", "v3") or pick(loras, "bfs", "2509"),
        "lightning": pick(loras, "lightning", "edit", "2509", "8step") or pick(loras, "lightning", "edit", "2509"),
        "node": "TextEncodeQwenImageEditPlus" if "TextEncodeQwenImageEditPlus" in info else None,
        "has_cfgnorm": "CFGNorm" in info, "has_auraflow": "ModelSamplingAuraFlow" in info,
    }
    return info, f, {"unet": unets, "clip": clips, "vae": vaes, "lora": loras}


def fill_defaults(info, wf):
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


def workflow(f, imgs, prompt, use_bfs, use_lightning, seed, steps, cfg, prefix):
    wf = {"unet": {"class_type": "UNETLoader", "inputs": {"unet_name": f["unet"], "weight_dtype": "default"}}}
    m = ["unet", 0]
    for key, name, on in (("bfs", f["bfs"], use_bfs), ("light", f["lightning"], use_lightning)):
        if on:
            wf[key] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": m, "lora_name": name, "strength_model": 1.0}}
            m = [key, 0]
    if f["has_auraflow"]:
        wf["shift"] = {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": m, "shift": 3.1}}
        m = ["shift", 0]
    if f["has_cfgnorm"]:
        wf["cfgnorm"] = {"class_type": "CFGNorm", "inputs": {"model": m, "strength": 1.0}}
        m = ["cfgnorm", 0]
    wf["clip"] = {"class_type": "CLIPLoader", "inputs": {"clip_name": f["clip"], "type": "qwen_image"}}
    wf["vae"] = {"class_type": "VAELoader", "inputs": {"vae_name": f["vae"]}}
    refs = {}
    for i, name in enumerate(imgs, 1):
        wf[f"img{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        wf[f"sc{i}"] = {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": [f"img{i}", 0], "upscale_method": "lanczos", "megapixels": 1.0}}
        refs[f"image{i}"] = [f"sc{i}", 0]
    for key, text in (("pos", prompt), ("neg", NEG)):
        wf[key] = {"class_type": f["node"], "inputs": dict(refs, clip=["clip", 0], prompt=text, vae=["vae", 0])}
    wf["latent"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["sc1", 0], "vae": ["vae", 0]}}
    wf["ks"] = {"class_type": "KSampler", "inputs": {"model": m, "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["latent", 0],
                "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}}
    wf["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}}
    wf["save"] = {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix}}
    return wf


def upload(base, path):
    boundary = uuid.uuid4().hex
    with open(path, "rb") as fh:
        content = fh.read()
    name = "guobo_tryon_" + os.path.basename(path)
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + content + \
           (f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n").encode()
    r = http(base, "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return (r.get("subfolder") + "/" if r.get("subfolder") else "") + r["name"]


def run(base, info, wf, out_path):
    r = http(base, "/prompt", json.dumps({"prompt": fill_defaults(info, wf), "client_id": uuid.uuid4().hex}).encode(), {"Content-Type": "application/json"})
    if r.get("node_errors"):
        raise RuntimeError(json.dumps(r["node_errors"], ensure_ascii=False))
    pid, t0 = r["prompt_id"], time.time()
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
    ap.add_argument("--inputs", default=os.path.join(HERE, "tryon_inputs"))
    ap.add_argument("--only", default="", help="只跑某几类，如 A,C 或 C_v3")
    ap.add_argument("--seeds", type=int, default=2)
    ap.add_argument("--fast", action="store_true", help="用 2509 Lightning LoRA（8 步）；默认 30 步完整质量")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--out", default="outputs_tryon")
    a = ap.parse_args()
    info, f, all_opts = probe(a.host)
    print("探测结果：", json.dumps(f, ensure_ascii=False, indent=1))
    if a.probe:
        print("全部候选：", json.dumps(all_opts, ensure_ascii=False, indent=1))
        return
    if not (f["unet"] and f["clip"] and f["vae"] and f["node"]):
        sys.exit("缺少 Qwen-Image-Edit 模型、文本编码器、VAE 或 TextEncodeQwenImageEditPlus 节点，请先用 --probe 查看")
    if a.fast and not f["lightning"]:
        sys.exit("--fast 需要 models/loras 里有 Qwen-Image-Edit-2509 的 Lightning LoRA")
    wanted = [t for t in TESTS if not a.only or any(t == o or t.split("_")[0] == o for o in a.only.split(","))]
    if any(TESTS[t][2] for t in wanted) and not f["bfs"]:
        print("没有找到 BFS LoRA（models/loras/bfs_head_v3_qwen_image_edit_2509.safetensors），跳过 C 组")
        wanted = [t for t in wanted if not TESTS[t][2]]
    os.makedirs(a.out, exist_ok=True)
    names = {k: upload(a.host, os.path.join(a.inputs, v)) for k, v in INPUTS.items()}
    steps, cfg = (8, 1.0) if a.fast else (30, 4.0)
    seeds = [random.randint(1, 2**31 - 1) for _ in range(a.seeds)]
    log = []
    for t in wanted:
        imgs, prompt, use_bfs = TESTS[t]
        for i, seed in enumerate(seeds, 1):
            out = os.path.join(a.out, f"{t}_{i}.png")
            print(f"生成 {out}  seed={seed} steps={steps} cfg={cfg} …", flush=True)
            try:
                sec = run(a.host, info, workflow(f, [names[x] for x in imgs], prompt, use_bfs, a.fast, seed, steps, cfg, "guobo_tryon_" + t), out)
            except Exception as e:
                print("  失败：", str(e)[:500]); log.append({"test": t, "seed": seed, "error": str(e)[:2000]}); continue
            print(f"  完成，用时 {sec:.0f} 秒")
            log.append({"test": t, "file": out, "seed": seed, "steps": steps, "cfg": cfg, "seconds": round(sec), "unet": f["unet"],
                        "bfs": f["bfs"] if use_bfs else None, "lightning": f["lightning"] if a.fast else None, "inputs": imgs})
    with open(os.path.join(a.out, "run_log.json"), "w", encoding="utf-8") as fh:
        json.dump(log, fh, ensure_ascii=False, indent=1)
    print("全部完成，结果与参数记录在 " + a.out + "；把整个文件夹打包发回即可")


if __name__ == "__main__":
    main()
