# V1.0 真实道具闭环

代码分支提供真实执行模式，原演示模式保留。真实模式从空白工作区开始，不会生成演示资产、模拟显存曲线或模拟质检结论。

## 执行链

需求单与真实参考图上传 → ComfyUI Qwen 文生图或参考图 img2img → 可选 LoRA 和 BiRefNet 去背景 → 人工选图 → TRELLIS.2 → Blender CPU 减面、QuadriFlow、UV、PBR 烘焙 → 真实文件 Q01–Q07 与来源 Q08–Q09 → 人工审核/返工 → 资产版本入库 → Draco/KTX2 → 校验 → ZIP、manifest 和离线 WebXR 查看页。

V1.0 只开放非文物本体的道具资产集合。生成的历史氛围资产写入 AI 复原/AI 生成标识；没有把未接入的 V1.1/V1.2 功能当成真实能力开放。

## 环境

建议在 WSL2 Ubuntu 22.04 或 Linux 运行。先按 `ops/m0` 安装 ComfyUI、TRELLIS.2、Blender bpy，准备 RTX 4090 24GB 和完整权重。

平台 Python 环境独立于推理环境：

```bash
python3.11 -m venv /opt/scw/platform
/opt/scw/platform/bin/pip install -r requirements.txt
npm ci
/opt/scw/platform/bin/python web/build.py
```

压缩导出依赖 Node 22 和 Khronos KTX-Software 的 `toktx`。KTX 安装目录通过 `SCW_KTX_BIN` 配置，不允许“选择了压缩但实际未执行”。缺少压缩器、贴图或校验失败时，导出任务失败并保留日志。

环境变量：

| 变量 | 默认 | 用途 |
|---|---|---|
| SCW_MODE | demo | 设置 production 才启用真实 Worker |
| SCW_DATA | ./data | 必须为真实模式配置独立目录 |
| SCW_COMFY_URL | http://127.0.0.1:8188 | 本地 ComfyUI 服务 |
| SCW_TRELLIS_PYTHON | /opt/scw/miniforge3/envs/trellis2/bin/python | 图生 3D 与去背景环境 |
| SCW_BPY_PYTHON | /opt/scw/bpy/bin/python | Blender 4.2 环境 |
| TRELLIS2_HOME | /opt/scw/TRELLIS.2 | TRELLIS.2 代码目录 |
| HF_HOME | /data/models/hf | 模型缓存 |
| SCW_KTX_BIN | 启动脚本中的 KTX 目录 | toktx 目录 |
| SCW_NODE | node | Node 可执行文件 |
| SCW_UPLOAD_LIMIT_MB | 64 | 单个上传文件上限 |
| SCW_TASK_TIMEOUT | 3600 | 单个引擎进程超时 |
| SCW_COOKIE_SECURE | 未开启 | HTTPS 部署设置为 1 |

`bash ops/production/start.sh` 启动本机服务，默认 `http://localhost:8780`。第一次启动会在数据目录生成权限为 600 的 `runtime.env`（JWT 密钥）、`accounts.json`（四个账号各自的 scrypt 密码哈希）、`initial-credentials.json`（供本机管理员查看的初始密码）。不要提交或发送这些文件；切换角色需退出并使用该账号自己的密码登录。ComfyUI 使用启动脚本挂载真实模型目录：

```bash
bash ops/production/start_comfy.sh
```

本机 PyTorch 2.6 与当前 comfy-kitchen 的类型注解兼容由 `comfy_entry.py` 处理：仅在 torch 自然加载后修正注解，不修改张量计算或提前初始化 CUDA allocator。服务在线仍不代表 GPU 推理验收通过。

安装受管服务与继续下载：

```bash
bash ops/production/install_services.sh
systemctl enable --now scw-real-platform scw-real-comfy scw-trellis-download
tail -f /data/logs/scw-download-trellis-service.log
```

Windows 可运行 `ops/production/start-windows.ps1`，保持终端会话以防 WSL 空闲退出。系统设置的“真实引擎检查”显示实际服务和权重状态；依赖缺失时提交返回 409，已排队任务等待依赖，不消耗重试次数。依赖检查成功也不等同于真实推理验收。

下载器固定官方仓库的 commit，保留断点分块，对大文件完成 SHA-256 校验后才登记到标准 HF snapshot。公开下载顺序包含 TRELLIS.2 主仓、旧 TRELLIS 的 sparse decoder、Qwen 三个拆分文件、BiRefNet；不会下载整个旧 TRELLIS 仓库。DINOv3 和 RMBG-2.0 由用户自己的账号获准并在本机登录后运行：

```bash
HF_HOME=/data/models/hf /opt/scw/miniforge3/envs/trellis2/bin/hf auth login
# 等公开下载服务完成或先停止该服务，避免两个下载器同时写缓存。
HF_HOME=/data/models/hf /opt/scw/miniforge3/envs/trellis2/bin/python ops/production/download_models.py --with-gated
```

已有本地 Qwen 文件可用 `HF_HOME=/data/models/hf /opt/scw/miniforge3/envs/trellis2/bin/python ops/production/reuse_models.py /mnt/d/ComfyUI/models` 核对并复用。仅接收大小和官方 SHA-256 一致的文件，保留源文件。Windows 登录也可运行 `login-hf.ps1`，确保凭据保存在服务实际使用的 HF_HOME。

## 数据和执行边界

- 当前真实模式使用单实例 FastAPI、1 个 GPU 执行通道和最多 3 个 CPU 通道，执行器调用实际子进程；不宣称已完成 SPEC 的 PostgreSQL/Celery/Redis 迁移。数据目录锁拒绝第二个真实实例，避免多个调度器争抢。
- 业务状态沿用现有引擎，生产写操作立即原子落盘并 fsync；文件目录保存不可变文件，SQLite 保存工作区、大小与 SHA-256。重启时运行中的任务回到队列，仍保留原输入和已有文件。
- 文件存储目录为 `$SCW_DATA/files`，运行目录为 `$SCW_DATA/runs`。运行日志包含引擎实际输出。不能仅凭页面进度或文件名判定成功。
- 取消任务会终止对应进程组；ComfyUI 仅取消本任务 prompt_id，不中断别人的任务。GPU 训练进程退出后释放 CUDA；不主动关闭用户已有的 GPU 应用。
- OOM 只由平台降为 512 重试一次，取消嵌套重试；其他执行错误最多重试一次。失败时保留日志并转人工。不能用模拟值补全缺失输出。
- 自动重拓扑、烘焙、UV 与几何质检是实际执行，但仍需要人工判断风格、法线细节、薄壁等视觉质量。UV 重叠检测使用 512 网格像素采样；法线检查使用拓扑一致性和封闭网格体积方向，不能替代目检。
- 审核报告绑定实际文件哈希，Q08/Q09 不允许人工放行。授权附件需真实上传并确认有效期。TRELLIS.2 的 DINOv3、RMBG 等依赖也记录在许可链中，默认仅内部验证，管理员核实后才能用于商用。
- 导出锁定已批准的版本；运行时再次检查文件哈希。GLB 真正执行 Draco/KTX2，要求 Khronos 校验无错误，并额外执行 Draco 解码、索引和位置检查及 KTX2 头检查后打包。当前固定版本的 Khronos 校验器会提示不支持这些压缩扩展，因此附加解码校验和浏览器加载验证必不可少。包内含本地查看器依赖、许可清单和真机状态。
- 当前尚未实现同模型常驻合批；排程页显示实际子进程起止时间。用时与显存曲线取自实际执行，不能将预估时长当作产能承诺。
- 备份与外部介质、正式用户体系、PostgreSQL/Celery/Redis 迁移、百件压测和头显实测仍应列为上线验收项，不能以本次 CPU 集成测试替代。

## 验证

```bash
SCW_BPY_PYTHON=/opt/scw/bpy/bin/python \
SCW_KTX_BIN=/opt/scw/ktx/KTX-Software-4.4.2-Linux-x86_64/bin \
SCW_NODE=/usr/local/bin/node \
/opt/scw/platform/bin/python -m pytest tests/test_production.py tests/test_download_verified.py -q
```

该套测试明确使用 TEST FIXTURE 标识的 Blender 模型验证加工、Q01–Q09、审核入库、不可变版本、压缩打包、工作区隔离、权限和持久化。不会把测试模型当作 AI 推理验收。

完整 GPU 验收必须另外保存：ComfyUI 真图、TRELLIS.2 高模、优化文件、质检报告、审批记录、交付包、用时和显存轨迹。DINOv3 和 RMBG-2.0 的访问许可由用户自己的 Hugging Face 账号申请，在本机 `hf auth login`；不要把 Token 发到聊天或写进仓库。
