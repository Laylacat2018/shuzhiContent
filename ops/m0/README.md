# M0 · 环境（第 1 周）

PRD 里程碑：硬件核对与补齐；操作系统、驱动、Docker；模型下载；ComfyUI、TRELLIS.2、Blender 单独跑通。
**验收物：各引擎单件产出样例** → 运行 `run_m0.py` 生成的 `m0_report_<时间>.zip`。

| 文件 | 作用 |
| --- | --- |
| `check_env.py` | 按 SPEC 第四部分 §1 核对 GPU、驱动 / CUDA、CPU、内存、磁盘、Docker、容器内 GPU、网络 |
| `setup_gpu_host.sh` | 安装系统包、`/data` 目录、Docker + NVIDIA Container Toolkit、CUDA 12.4、Miniforge、ComfyUI、TRELLIS.2、Blender 4.2 LTS（bpy） |
| `download_models.py` | 下载 Qwen-Image（ComfyUI 拆分文件）与 TRELLIS.2-4B，并自动解析下载其依赖模型 |
| `samples/comfy_qwen_image.py` | ComfyUI HTTP API 提交 Qwen-Image 工作流，出一张概念图（N1） |
| `samples/trellis2_run.py` | TRELLIS.2 图生 3D，关闭预览渲染，OOM 降级重试（N2） |
| `samples/blender_optimize.py` | Blender 无头减面、原点归位、统计、可选 Draco 导出（N3 第一步） |
| `run_m0.py` | 一键跑完上面全部步骤，生成验收报告与 zip |

## 一、准备 GPU 主机

TRELLIS.2 官方只支持 Linux。主机是 Windows 时按 SPEC 的方案使用 **Windows 11 + WSL2 Ubuntu 22.04**：

1. Windows 侧安装最新 NVIDIA 驱动（Game Ready 或 Studio，需支持 CUDA 12.8 及以上）。**不要**在 WSL 里装显卡驱动。
2. PowerShell（管理员）：`wsl --install -d Ubuntu-22.04`，重启后设置 Linux 用户名和密码。
3. 给 WSL 分配足够内存：在 `C:\Users\<你>\.wslconfig` 写入
   ```
   [wsl2]
   memory=56GB
   swap=16GB
   ```
   然后 PowerShell 执行 `wsl --shutdown`，再打开 Ubuntu。
4. 在 **WSL 的 Linux 目录**里获取代码（不要放在 WPS 云盘或 `/mnt/c` 下，跨文件系统访问会慢数倍，云盘同步也可能损坏仓库）：
   ```
   cd ~ && git clone https://github.com/Laylacat2018/shuzhiContent.git && cd shuzhiContent
   ```

## 二、安装与下载（约 1–2 小时，取决于网速）

```
bash ops/m0/setup_gpu_host.sh --all
python3 ops/m0/check_env.py --container
/opt/scw/miniforge3/envs/trellis2/bin/python ops/m0/download_models.py
```

- 国内网络访问 Hugging Face 慢时，在命令前加 `HF_ENDPOINT=https://hf-mirror.com`。
- `download_models.py` 若提示某个依赖模型“需要授权”（例如 DINOv3），按提示在 Hugging Face 页面同意许可协议并 `huggingface-cli login` 后重跑。**该模型的许可条款需由管理员核对后登记**（PRD 6.1），它会进入 TRELLIS.2 产出资产的许可链。
- 首批模型约 60GB；全部模型按 300GB 以上预留（SPEC §1）。

## 三、一键验收

```
python3 ops/m0/run_m0.py
```

依次执行：环境核对 → 启动 ComfyUI 生成概念图（含首张加载耗时与加载后单张耗时）→ 释放显存 → TRELLIS.2 生成 GLB → Blender 优化为 Quest 3（20,000 三角形）与 WebXR（10,000 三角形 + Draco）两个版本。
全程每 0.5 秒采样显存，报告列出每一步的用时、显存峰值和 SPEC 目标。

结束后把 `reports/m0/m0_report_<时间>.zip` 发回即可验收。单独重跑某一步：

```
python3 ops/m0/run_m0.py --skip env comfyui --image 某张图.png     # 只跑 3D 与优化
python3 ops/m0/run_m0.py --skip env comfyui trellis2 --glb 某个.glb # 只跑 Blender
```

## 验收标准

| 项目 | 标准 | 依据 |
| --- | --- | --- |
| 环境核对 | 无 FAIL 项（WARN 需说明） | SPEC 第四部分 §1 |
| 容器内 GPU | `nvidia-smi` 在容器内可见 | SPEC 5.3 第 1 步 |
| ComfyUI 概念图 | 产出 PNG；模型已加载后单张约 10 秒 | SPEC §2 N1 |
| TRELLIS.2 | 产出带 PBR 贴图的 GLB；1024³ 单件 ≤ 2 分钟；显存峰值 ≤ 24GB | PRD P04 验收、SPEC §2 N2 |
| Blender 优化 | 优化后三角形 ≤ 预设上限；单件 ≤ 5 分钟 | PRD P05 验收、SPEC §2 N3 |

## 在开发环境中已验证 / 需在 GPU 主机上验证

| 项目 | 开发环境（无 GPU）验证结果 |
| --- | --- |
| Blender 优化 | **已实测**：Blender 4.2.23 LTS 将 137,476 三角形高模减到 19,999（Quest 3）/ 9,999（WebXR + Draco），原点偏移 9.43cm → 0，导出 GLB 经 Khronos glTF-Validator 0 错误，单件约 1.5 秒 |
| ComfyUI 工作流 | **已实测**：在真实 ComfyUI 0.45（CPU 模式）中提交，10 个节点全部通过校验并进入执行；因开发环境没有模型权重，在加载权重处停止（预期）；`/free` 释放接口可用 |
| 环境核对 / 一键验收 | **已实测**：脚本在开发环境运行正常，正确识别缺少 GPU、内存不足等问题，报告与 zip 生成正常 |
| TRELLIS.2 | 依据官方 README 与源码（`pipeline_type`、`o_voxel.postprocess.to_glb`）编写，**需在 GPU 主机上验证** |
| 安装脚本、模型下载 | 需在 GPU 主机上验证（开发环境无法访问 Hugging Face，也没有 GPU） |
