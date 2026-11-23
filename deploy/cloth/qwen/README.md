# Qwen 本地生图脚本（ComfyUI）

`comfy_qwen_restore.py`：用本机 ComfyUI + Qwen-Image / Qwen-Image-Edit-2509 复原《李言恭配临淮侯夫人史氏像》命妇礼服。只用 Python 标准库。
这是 2026-11-23 可行性测试最终使用的版本（提示词 v4）。

- 自动探测模型，排除 svdq / nunchaku / gguf / int4 等标准加载器读不了的量化文件；加速 LoRA 仅在与模型版本一致时使用，`--lightning off` 可强制关闭。
- E2（参考图）默认把画像裁剪到服装区域（`--crop 0.10,0.295,0.90,0.845`，`--crop off` 关闭），加入结构约束（霞帔金地并合单坠、内袍金地蟒纹分层）和照片化约束。
- `--seed-list` 复用种子，`--seeds N` 补足随机种子；结果与 `run_log.json` 写入 `--out`（默认 `outputs_v4`）。

在 WSL 中运行（避开 Windows 上另一个占用 8188 的 ComfyUI）：

```bash
wsl -d Ubuntu-22.04 -- python3 comfy_qwen_restore.py --image 史氏像_国博官网.jpg --mode edit --seeds 6 --seed-list 1234440434
```

文件名 `E2_qwen_front_N.png` 可直接拖进实验台第③步上传，自动识别为 Qwen 模型。
