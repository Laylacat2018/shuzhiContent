# V1.0 真实道具闭环：实施与验收记录

日期：2026-11-16。分支：`codex/v1-real-prop-pipeline`。

当前结论：真实文件加工、审核入库和压缩交付链已经实测通过；AI 生成端已接入执行代码和本机服务，完整 GPU 端到端验收仍未通过。TRELLIS.2 及其他公开依赖正在继续下载；DINOv3、RMBG-2.0 尚待用户自己的 Hugging Face 账号获准访问。

## 逐项状态

| 环节 | 本次落实内容 | 验证情况 |
|---|---|---|
| 真实模式入口 | 空白工作区、仅开放 V1.0 道具；禁止演示时钟生成资产 | 测试通过 |
| 需求单与参考图 | 上传实际图片字节，按工作区保存文件索引、大小和 SHA-256 | API 测试通过 |
| 概念图 | 实际 ComfyUI Qwen 工作流，支持参考图 img2img | 服务在线，待权重和 GPU 生成验收 |
| 风格与去背景 | LoRA 真实文件登记和加载；BiRefNet 去背景；不提供模拟三视图 | 接口已接入，待真实样本验收 |
| 人工选图 | 仅允许带真实文件的候选图进入 3D；保留 seed 和来源 | 状态与权限测试通过 |
| 图生 3D | TRELLIS.2 子进程执行、真实 GLB、一次 OOM 降档重试、禁用预览渲染 | CUDA 与类导入已验证；模型推理待完整权重及授权 |
| 自动加工 | Blender CPU 减面、QuadriFlow、UV、PBR 烘焙、底部中心原点、GLB/.blend | 真实测试文件通过；12,096 → 9,140 三角形示例 |
| 加工进度 | 从实际阶段日志更新；保存 GLB/.blend 与交付压缩分开显示 | 文件链路实测通过 |
| 真实质检 | Q01–Q07 从实际网格和贴图测量；Q08 许可链；Q09 文件标识一致性 | 9 项检查通过的 CPU 样本已留证 |
| 审核返工 | 审核绑定版本和文件哈希，Q08/Q09 阻断，人工 GLB 交接入口 | 审核入库实测；人工修复视觉质量仍需人工验收 |
| 资产库 | 不可变文件、版本记录、已批准版本、真实 GLB 下载 | 浏览器下载字节与版本 SHA-256 一致 |
| 材质与预览 | 加载实际 GLB；实体、线框、法线、Base Color、Metallic、Roughness | 浏览器六种模式通过，未发现脚本错误 |
| 导出 | 实际 Draco/KTX2，独立 Draco 解码检查，KTX2 头检查，版本/许可再次复核 | 实际 ZIP 下载与包内资产 SHA-256 通过 |
| 交付清单 | manifest 含来源/交付哈希、许可链、实际压缩校验记录、真机状态 | 集成测试通过；许可在排队后被撤销时交付被阻断 |
| WebXR 查看页 | 模型、模块、Draco/Basis 解码器全部随包交付 | 桌面 Chromium 阻断外网时加载成功；头显未测 |
| 调度与取消 | 单 GPU、三个 CPU、跨工作区置顶、夜间窗口、进程组取消 | 受控真实子进程取消测试通过；GPU 取消待生成实测 |
| 账号 | 四种角色独立随机密码和 scrypt 哈希；Cookie 登录和退出 | 权限和 Cookie 退出测试通过；账号管理 CRUD 未做 |
| 持久化 | 真实模式每次写操作原子保存/fsync；模式混用时拒绝覆盖 | 逐写落盘与模式混用保护测试通过 |
| 就绪检查 | 显示 ComfyUI、权重、Blender、压缩器状态；未就绪提交返回 409 | 不创建无效任务、不消耗重试次数的测试通过 |

## 测试记录

| 验证组 | 结果 |
|---|---|
| `tests/test_production.py` 与 `tests/test_download_verified.py` | WSL：14 passed |
| 原有 `tests/test_e2e.py` | Windows Chromium：15 项前端用例通过 |
| 原有服务端 REST、权限、冒烟、重启恢复 | WSL：4 passed |
| 原有协作 WebSocket、服务端全页面 | Windows Chromium：2 passed |
| `tests/real_ui_smoke.cjs` | 实际 GLB 加载、六种材质模式、GLB 下载哈希、ZIP 下载及包内资产哈希均通过 |
| 本机生产空白工作区 | 10 个 V1.0 页面无脚本错误；系统页准确显示未就绪依赖 |
| 随包查看器 | 压缩模型加载成功，无外网请求、无加载错误 |

新测试明确使用 `TEST FIXTURE NOT AI INFERENCE` 标识的模型，不作为 AI 推理或美术质量验收。原有回归按实际运行环境拆分：Windows 原演示模式强制结束进程的恢复测试曾失败；WSL 对应恢复测试通过。真实模式采用逐写落盘，目标运行环境为 WSL/Linux。

质检有采样边界：UV 重叠为 512 网格像素采样；法线采用拓扑一致性及体积方向检查；薄壁、细节、风格和美术质量仍需目检。当前 Khronos 校验器对压缩扩展存在不支持警告，故另执行解码检查并做浏览器加载验证。

## 下载与本机运行

- 真实平台：`http://localhost:8780`；ComfyUI：`http://localhost:8188`。
- 数据：WSL `/data/scw-production`。四个账号初始密码只保存在该目录权限 600 的 `initial-credentials.json` 中。
- 受管服务：`scw-real-platform`、`scw-real-comfy`、`scw-trellis-download`。公开模型下载服务已启用，支持失败重启和断点续传。
- 已从本机已有文件核对并复用 Qwen 文本编码器和 VAE，合计约 9.6 GB；原文件保留。
- TRELLIS.2 主仓约 16.24 GB，下载以完整文件 SHA-256 校验通过为准，不能把部分分块算作完整权重。实时进度见 `/data/logs/scw-download-trellis-service.log`。
- 下载计划包含 TRELLIS.2 主仓、旧 TRELLIS sparse decoder、Qwen 三个拆分文件、BiRefNet；受限模型不绕过账号访问许可。
- Windows 保持 WSL 会话可运行 `ops/production/start-windows.ps1`。安装和详细命令见 `ops/production/README.md`。

用户注册并获准访问 DINOv3、RMBG-2.0 后，在本机执行 `ops/production/login-hf.ps1`；Token 只输入终端，不发送到聊天。该脚本将凭据保存到服务使用的 `HF_HOME=/data/models/hf`。

## 仍未完成的验收和范围

1. 全部权重下载、受限模型访问，以及一次“需求 → 真概念图 → TRELLIS.2 → 加工 → 审核 → 交付”的完整 GPU 验收。
2. 使用真实业务道具检验质量、GPU 峰值、耗时、OOM 降档与 GPU 取消；100 件/日压测和头显实测。
3. 三视图一致性、质检缺陷的逐面高亮、同模型常驻合批、云 GPU 执行尚未接入。
4. PostgreSQL/Celery/Redis 迁移、正式账号管理、自动备份和恢复演练、外部介质备份、按保留期自动清理尚未完成。
5. 当前商业许可仍需核对；TRELLIS 依赖默认只用于内部验证。下载成功不会自动赋予商用许可。

因此，本分支可以审查和继续进行真实 GPU 验收，不能标记为“V1.0 已全部完成”或“已正式上线”。
