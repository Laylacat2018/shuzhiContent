# 更新日志

版本号遵循语义化版本（MAJOR.MINOR.PATCH），以仓库根目录 `VERSION` 文件为准，每个发布版本在 Git 上打 `vX.Y.Z` 标签。

## v1.0.0 — 2026-11-15

首个发布版本，依据《AIGC 沉浸式空间内容生产管线平台 PRD · 页面原型 · SPEC》开发的商务演示版。

### 功能
- 14 个页面全部可操作（P01 工作台 … P14 系统设置），覆盖 PRD 的 V1.0 / V1.1 / V1.2 功能范围，管理员可切换发布范围。
- 业务规则：许可证规则（提交时 / 导出时）、文博准确性规则、AIGC 隐式与显式标识、Q01–Q09 质检、审核与返工（返工超过 2 次转人工）、导出前 6 项检查与交付清单。
- GPU 调度：单卡互斥、同模型合批（20 件 / 30 分钟）、置顶、夜间窗口、显存超限路由云端、OOM 降级重试、云节点空闲自动关机。
- 场景组装 Agent：从资产库取件布景、工具调用审计、执行 Python 前确认、六步确认流程、性能预算。
- 导出：真实 glTF 2.0 GLB（含 PBR 贴图与 AIGC extras，通过 Khronos glTF-Validator）、WebXR 查看页、Blender 导入脚本、manifest.json；HDRI（.hdr）、domemaster、PLY、BVH。

### 服务端
- FastAPI 服务；业务引擎在服务端 V8 中运行，与前端同一份 `engine.js`。
- SPEC 7.1 REST 接口（`/api/v1`）、7.2 WebSocket 事件（`/ws/events`）、JWT 登录与角色权限。
- 工作区：同一工作区多人共享数据；数据每 5 秒落盘，重启后运行中任务回到排队。
- 运行形态：服务端版（`/`）、单机版（`/standalone`）、在线验收版（Artifact）。
- 冒烟测试脚本 `tools/smoke_test.py`；Dockerfile、docker-compose、Nginx 示例配置。

### 测试
- 21 项端到端测试（Playwright + Chromium）：单机版规则用例 15 项、服务端用例 6 项。

### 已知限制
- 模型推理由确定性模拟代替，任务耗时按加速倍率压缩。
- Draco / KTX2 压缩未实际执行；3DGS 以 PLY、动作以 BVH 导出（正式版为 SPZ / glTF + KHR_gaussian_splatting、FBX）。
- Docker 镜像未在本开发环境构建验证（无 Docker 守护进程）；以全新 Python 虚拟环境部署验证通过。
