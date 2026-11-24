"""模型适配层：统一 generate(prompt, refs, seed) -> PNG/JPEG 字节；vision(prompt, images) -> 文本。

未配置密钥的模型直接报错“未配置”；只有演示模式（CLOTH_DEMO=1）下的 mock 适配器会生成带“模拟”字样的占位图。
"""
from __future__ import annotations

import base64
import io
import json
import random
import time
import uuid

import httpx
from PIL import Image, ImageDraw, ImageFont


class ModelError(Exception):
    pass


def _font(size: int):
    for p in ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
              "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", "C:/Windows/Fonts/msyh.ttc", "/System/Library/Fonts/PingFang.ttc"):
        try:
            return ImageFont.truetype(p, size), True
        except OSError:
            continue
    return ImageFont.load_default(), False


def to_png(data: bytes) -> bytes:
    im = Image.open(io.BytesIO(data))
    out = io.BytesIO()
    im.convert("RGB").save(out, "PNG")
    return out.getvalue()


def data_uri(data: bytes, mime="image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(data).decode()


# ---------------------------------------------------------------- 提示词

def build_prompt(fields: list, stage: str, view: str, has_ref: bool, revisions: list | None = None, group: str | None = None) -> tuple[str, str]:
    """由规格书字段生成提示词与反向提示词。"""
    if group == "E0":
        return "明代服饰复原图，全身，正面", ""
    by = {f["code"]: f for f in fields if not f.get("na")}
    forbid = by.get("F12", {}).get("content", "")
    lines = []
    for f in fields:
        if f.get("na") or f["code"] == "F12" or f.get("level") == "miss":
            continue
        lines.append(f"- {f['name']}：{f['content']}")
    view_txt = {"front": "正面，人台正对镜头，左右对称", "side": "右侧 90 度侧面，表现宽袖垂坠与霞帔厚度",
                "back": "背面；背面形制画像不可见处按规格书推定"}.get(view, "正面")
    head = ""
    if stage == "revise":
        head = "参考图是上一版复原结果。请只做下列修改，其他部分保持不变。\n"
    elif has_ref and view == "front":
        head = ("参考图是复原依据的文物画像。请严格依据画像中人物所穿服装，复原成穿在无头白色人台上的实物服装照片；"
                "保留服装颜色、纹样布局和各层相对位置；去掉人物、面部、冠饰、椅子、地毯和背景。\n")
    elif has_ref:
        head = "参考图是同一件复原服装的正面图。请保持完全相同的服装、颜色和纹样，生成另一视角。\n"
    body = ("【呈现方式】博物馆文物复原图风格的真实摄影：服装穿在站立的无头白色人台上，浅灰纯色背景，写实丝绸质感，均匀柔光，全身完整入画；"
            "不要人物、文字、水印、椅子或地毯；不是绘画。\n【服装形制】\n" + "\n".join(lines))
    if revisions:
        body += "\n【专家评审修订，必须执行】\n" + "\n".join(f"{i+1}. {r}" for i, r in enumerate(revisions))
    if forbid:
        body += f"\n【禁止出现】{forbid}"
    body += f"\n【视角】{view_txt}"
    neg = "人物, 人脸, 文字, 水印, 绘画, 工笔画, 纸张纹理, 地毯, 椅子, 坐姿, " + forbid.replace("、", ", ")
    return head + body, neg


# ---------------------------------------------------------------- 适配器

class Adapter:
    def __init__(self, cfg: dict, key: str | None):
        self.cfg, self.key = cfg, key
        self.timeout = float(cfg.get("timeout") or 120)

    def need_key(self):
        if not self.key:
            raise ModelError(f"{self.cfg['name']} 未配置密钥（系统设置 → 模型接入）")

    def generate(self, prompt: str, negative: str, refs: list[bytes], seed: int) -> bytes:
        raise NotImplementedError

    def test(self) -> str:
        self.need_key()
        return "已配置密钥"


class GeminiAdapter(Adapter):
    def generate(self, prompt, negative, refs, seed):
        self.need_key()
        parts = [{"text": prompt + (f"\n避免：{negative}" if negative else "")}]
        parts += [{"inline_data": {"mime_type": "image/png", "data": base64.b64encode(to_png(r)).decode()}} for r in refs]
        url = f"{self.cfg['endpoint'].rstrip('/')}/v1beta/models/{self.cfg['model']}:generateContent"
        r = httpx.post(url, headers={"x-goog-api-key": self.key}, timeout=self.timeout,
                       json={"contents": [{"parts": parts}], "generationConfig": {"responseModalities": ["IMAGE"], "seed": seed}})
        if r.status_code >= 400:
            raise ModelError(f"Gemini 返回 {r.status_code}：{r.text[:300]}")
        for cand in r.json().get("candidates", []):
            for p in cand.get("content", {}).get("parts", []):
                blob = p.get("inline_data") or p.get("inlineData")
                if blob:
                    return base64.b64decode(blob["data"])
        raise ModelError("Gemini 没有返回图片")

    def test(self):
        self.need_key()
        r = httpx.get(f"{self.cfg['endpoint'].rstrip('/')}/v1beta/models/{self.cfg['model']}", headers={"x-goog-api-key": self.key}, timeout=20)
        if r.status_code >= 400:
            raise ModelError(f"连通失败 {r.status_code}")
        return "连通正常"


class ArkAdapter(Adapter):
    """火山方舟 Seedream 图像生成接口。"""

    def generate(self, prompt, negative, refs, seed):
        self.need_key()
        body = {"model": self.cfg["model"], "prompt": prompt, "size": "1728x2304", "response_format": "b64_json",
                "seed": seed, "watermark": False}
        if refs:
            body["image"] = [data_uri(to_png(r)) for r in refs]
        r = httpx.post(self.cfg["endpoint"].rstrip("/") + "/images/generations", json=body,
                       headers={"Authorization": f"Bearer {self.key}"}, timeout=self.timeout)
        if r.status_code >= 400:
            raise ModelError(f"Seedream 返回 {r.status_code}：{r.text[:300]}")
        data = r.json().get("data") or []
        if not data:
            raise ModelError("Seedream 没有返回图片")
        if data[0].get("b64_json"):
            return base64.b64decode(data[0]["b64_json"])
        return httpx.get(data[0]["url"], timeout=60).content


class OpenAIAdapter(Adapter):
    def generate(self, prompt, negative, refs, seed):
        self.need_key()
        base = self.cfg["endpoint"].rstrip("/")
        h = {"Authorization": f"Bearer {self.key}"}
        if refs:
            files = [("image[]", (f"ref{i}.png", to_png(b), "image/png")) for i, b in enumerate(refs)]
            r = httpx.post(base + "/images/edits", headers=h, timeout=self.timeout, files=files,
                           data={"model": self.cfg["model"], "prompt": prompt, "size": "1024x1536"})
        else:
            r = httpx.post(base + "/images/generations", headers=h, timeout=self.timeout,
                           json={"model": self.cfg["model"], "prompt": prompt, "size": "1024x1536"})
        if r.status_code >= 400:
            raise ModelError(f"GPT Image 返回 {r.status_code}：{r.text[:300]}")
        return base64.b64decode(r.json()["data"][0]["b64_json"])


class ComfyAdapter(Adapter):
    """本地 ComfyUI + Qwen-Image-Edit-2509（沿用 2026-11-23 测试通过的工作流）。"""

    def need_key(self):
        pass

    def _http(self, path, data=None, headers=None, raw=False):
        url = self.cfg["endpoint"].rstrip("/") + path
        r = httpx.post(url, content=data, headers=headers, timeout=60) if data is not None else httpx.get(url, timeout=60)
        if r.status_code >= 400:
            raise ModelError(f"ComfyUI 返回 {r.status_code}：{r.text[:300]}")
        return r.content if raw else r.json()

    def test(self):
        info = self._http("/system_stats")
        dev = (info.get("devices") or [{}])[0]
        return f"连通正常 · {dev.get('name', 'GPU')}"

    def generate(self, prompt, negative, refs, seed):
        if not refs:
            raise ModelError("Qwen-Image-Edit 需要参考图（请先设置主史料）")
        boundary = uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"cloth_{uuid.uuid4().hex[:8]}.png\"\r\n"
                f"Content-Type: image/png\r\n\r\n").encode() + to_png(refs[0]) + f"\r\n--{boundary}--\r\n".encode()
        up = self._http("/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        img = (up.get("subfolder") + "/" if up.get("subfolder") else "") + up["name"]
        unet = self.cfg.get("model") or "qwen_image_edit_2509_fp8_e4m3fn.safetensors"
        wf = {
            "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
            "shift": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["unet", 0], "shift": 3.1}},
            "cfgnorm": {"class_type": "CFGNorm", "inputs": {"model": ["shift", 0], "strength": 1.0}},
            "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image"}},
            "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
            "img": {"class_type": "LoadImage", "inputs": {"image": img}},
            "scale": {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": ["img", 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 1}},
            "pos": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["clip", 0], "prompt": prompt, "vae": ["vae", 0], "image1": ["scale", 0]}},
            "neg": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["clip", 0], "prompt": negative, "vae": ["vae", 0], "image1": ["scale", 0]}},
            "latent": {"class_type": "VAEEncode", "inputs": {"pixels": ["scale", 0], "vae": ["vae", 0]}},
            "ks": {"class_type": "KSampler", "inputs": {"model": ["cfgnorm", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["latent", 0],
                                                        "seed": seed, "steps": 30, "cfg": 4.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
            "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
            "save": {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": "cloth"}},
        }
        r = self._http("/prompt", json.dumps({"prompt": wf, "client_id": uuid.uuid4().hex}).encode(), {"Content-Type": "application/json"})
        if r.get("node_errors"):
            raise ModelError("ComfyUI 工作流错误：" + json.dumps(r["node_errors"], ensure_ascii=False)[:300])
        pid, t0 = r["prompt_id"], time.time()
        while time.time() - t0 < self.timeout:
            h = self._http(f"/history/{pid}")
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error":
                    raise ModelError("ComfyUI 执行失败")
                for node in h[pid].get("outputs", {}).values():
                    for im in node.get("images", []):
                        q = httpx.QueryParams({"filename": im["filename"], "subfolder": im["subfolder"], "type": im["type"]})
                        return self._http("/view?" + str(q), raw=True)
                raise ModelError("ComfyUI 未输出图片")
            time.sleep(2)
        raise ModelError("ComfyUI 超时")


class MockAdapter(Adapter):
    """演示模式专用：在参考图上叠加“模拟”字样，绝不冒充真实模型输出。"""

    def need_key(self):
        pass

    def test(self):
        return "演示模式 · 模拟输出"

    def generate(self, prompt, negative, refs, seed):
        rnd = random.Random(seed)
        if refs:
            im = Image.open(io.BytesIO(refs[0])).convert("RGB")
            im.thumbnail((768, 1024))
        else:
            im = Image.new("RGB", (768, 1024), (200 + rnd.randint(0, 40), 60, 50))
        overlay = Image.new("RGB", im.size, (rnd.randint(150, 220), rnd.randint(40, 90), rnd.randint(30, 70)))
        im = Image.blend(im, overlay, 0.25)
        d = ImageDraw.Draw(im)
        f, _ = _font(max(18, im.width // 18))
        d.rectangle([0, 0, im.width, im.width // 9], fill=(20, 20, 20))
        d.text((12, 8), f"模拟生成 · {self.cfg['name']} · seed {seed}", fill=(255, 255, 255), font=f)
        out = io.BytesIO()
        im.save(out, "PNG")
        time.sleep(0.2)
        return out.getvalue()


class VisionAdapter(Adapter):
    """OpenAI 兼容的多模态对话接口（如通义千问 VL 兼容模式）。"""

    def ask(self, prompt: str, images: list[bytes]) -> str:
        self.need_key()
        content = [{"type": "text", "text": prompt}] + [{"type": "image_url", "image_url": {"url": data_uri(to_png(b))}} for b in images]
        r = httpx.post(self.cfg["endpoint"].rstrip("/") + "/chat/completions", headers={"Authorization": f"Bearer {self.key}"},
                       json={"model": self.cfg["model"], "messages": [{"role": "user", "content": content}]}, timeout=self.timeout)
        if r.status_code >= 400:
            raise ModelError(f"视觉模型返回 {r.status_code}：{r.text[:300]}")
        return r.json()["choices"][0]["message"]["content"]


ADAPTERS = {"gemini": GeminiAdapter, "ark": ArkAdapter, "openai": OpenAIAdapter, "comfyui": ComfyAdapter, "mock": MockAdapter, "openai_chat": VisionAdapter}


def parse_json_block(text: str):
    """从模型回答中取出第一个 JSON 对象或数组。"""
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1]
        s = s[s.find("\n") + 1:] if s.lstrip().startswith("json") else s
    start = min([i for i in (s.find("{"), s.find("[")) if i >= 0] or [0])
    return json.loads(s[start:s.rfind("]" if s[start] == "[" else "}") + 1])


# ---------------------------------------------------------------- 合拍图后处理

def watermark(img_bytes: bytes, label: str, meta: dict) -> bytes:
    """可见标识（右下角）+ 隐式标识（PNG 文本块 AIGC）。"""
    from PIL import PngImagePlugin
    im = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    d = ImageDraw.Draw(im)
    f, cjk = _font(max(14, im.width // 32))
    text = label if cjk else "AI Generated"
    tw, th = d.textbbox((0, 0), text, font=f)[2:]
    pad = 8
    x, y = im.width - tw - pad * 3, im.height - th - pad * 3
    d.rectangle([x - pad, y - pad, x + tw + pad, y + th + pad], fill=(0, 0, 0))
    d.text((x, y), text, fill=(255, 255, 255), font=f)
    info = PngImagePlugin.PngInfo()
    info.add_text("AIGC", json.dumps(meta, ensure_ascii=False))
    out = io.BytesIO()
    im.save(out, "PNG", pnginfo=info)
    return out.getvalue()


def add_aigc_meta(img_bytes: bytes, meta: dict) -> bytes:
    from PIL import PngImagePlugin
    im = Image.open(io.BytesIO(img_bytes))
    info = PngImagePlugin.PngInfo()
    info.add_text("AIGC", json.dumps(meta, ensure_ascii=False))
    out = io.BytesIO()
    im.convert("RGB").save(out, "PNG", pnginfo=info)
    return out.getvalue()


def face_count(img_bytes: bytes) -> int | None:
    """若安装了 OpenCV 则检测人脸数；否则返回 None，由合拍服务端二次校验。"""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    arr = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_GRAYSCALE)
    if arr is None:
        return 0
    casc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    return len(casc.detectMultiScale(arr, 1.1, 5, minSize=(60, 60)))
