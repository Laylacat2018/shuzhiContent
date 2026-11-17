# 空间内容工场 · AIGC 沉浸式空间内容生产管线平台

当前版本：**v1.1.0**（2026-11-17，见 [CHANGELOG.md](CHANGELOG.md)）。版本号以仓库根目录 `VERSION` 文件为准；页面中的 V1.0 / V1.1 / V1.2 指 PRD 的功能范围，与发布版本号无关。

基于原 PRD 原型 SPEC 和本次真实产出更新，[PRD v1.1](docs/PRD-v1.1.md) 与 Word 版本位于 docs。默认云端演示保留 14 页业务流程，并持续标记“流程演示”；独立的 `/showcase` 页面展示实际花瓶文件，支持原 WebXR 版和精细展示母版切换、旋转和下载。

另提供 **V1.0 真实道具生产模式**：上传真实文件、ComfyUI/TRELLIS.2 执行适配、Blender 加工、文件质检、审核入库及 Draco/KTX2 交付。启动和限制见 [真实模式说明](ops/production/README.md)。全部推理权重已下载并校验，RTX 4090 已跑通单件真实闭环：Qwen 概念图 → BiRefNet → TRELLIS.2 → 优化 → Q01–Q09 → 审核 → 压缩交付。结果见 [验收记录](reports/v1-real-prop-acceptance-2026-11-16.md)。百件压测、头显验证和正式生产运维仍未完成。以下功能表和演示说明仍描述默认 demo 模式。

## 页面

| 编号 | 页面 | 版本 | 演示要点 |
| --- | --- | --- | --- |
| P01 | 工作台 | V1.0 | 指标卡、管线看板（点击带筛选跳转）、运行任务、显存曲线（24GB 上限）、提醒（阻断类在前）、待审核、按模型 / 需求单的返工统计 |
| P02 | 需求单 | V1.0 | 五步向导；管线预览与预算即时重算；许可证预检与被排除模型；文物本体锁定实景重建；多平台取最严格预算 |
| P03 | 概念图 | V1.0 | 提示词预填；GPU 被占用时“加入队列”并显示预计开始时间；多选送 3D；seed 可复现；三视图；未选图 7 天清理 |
| P04 | 3D 资产生成 | V1.0 | 模型列表含许可标签 / 显存 / 部署位置，不合规置灰；六种显示模式；关闭预览渲染；OOM 降一档重试 1 次 |
| P05 | 资产优化 | V1.0 | 前后同步对比视口、逐项对照预算、五步流水、应用到同批、转人工重拓扑 |
| P06 | 场景生成 | V1.1 | 360 全景、经纬网、接缝检查与修复、360 查看器、HDRI（Radiance .hdr）与 domemaster 导出、云端世界生成（费用确认） |
| P07 | 实景重建 | V1.1 | 素材上传与模糊剔除、注册率 < 90% 提示补拍、训练进度 / PSNR、超过 60 分钟排入夜间、框选删除浮点 / 裁剪盒、采集记录必填、精度报告 |
| P08 | 角色与动画 | V1.2 | 自动绑骨（UniRig 受许可限制）/ 导入绑定、权重自检确认、文生动作（云 API）、动作库、三轨时间线与融合过渡、BVH 导出 |
| P09 | 场景组装 | V1.1 | Agent 对话布景（只用已入库且合规资产）、工具调用流式展示与审计、执行 Python 前确认、六步确认、预算条、视口手动调整 |
| P10 | 质检审核 | V1.0 | Q01–Q09、问题高亮、自动修复并重检、许可链、放行理由、返工必选原因、A / R / D 与方向键 |
| P11 | 资产库 | V1.0 | 全文检索、仅可商用 / 仅文物本体、批量标签 / 加入场景 / 导出、版本历史与回退、被引用资产不可删除 |
| P12 | 导出发布 | V1.0 起 | 六项发布前检查（前五项阻断）、真机测试标记、交付清单 manifest.json、GLB / 查看页 / Blender 导入脚本打包 |
| P13 | 任务队列 | V1.0 | 本地 GPU / CPU 池 / 云节点三条时间线（灰色为换载）、置顶 / 暂停 / 取消 / 重试 / 日志、云节点空闲自动关机 |
| P14 | 系统设置 | V1.0 | 模型登记与允许范围、授权文件上传与确认、许可证规则矩阵、云 GPU、LLM 与 Agent、质检预设、存储、权限、审计日志、演示控制 |

右上角可切换四种角色（产品 / 策划、3D 美术、审核人、管理员），权限按 PRD 第 2 章矩阵控制。

## 三种运行形态

| 形态 | 地址 | 业务引擎 | 数据 | 用途 |
| --- | --- | --- | --- | --- |
| **服务端版**（推荐，绑定域名） | `/` | 服务端 V8 中运行（FastAPI 托管） | 服务器 `$SCW_DATA`，同一工作区的同事共享，重启自动恢复 | 商务对外演示、团队协作 |
| 单机版 | `/standalone` | 浏览器内 | 访问者自己的浏览器 | 离线演示、断网备用 |
| 在线验收版 | claude.ai Artifact 链接 | 浏览器内 | 访问者自己的浏览器 | 验收 |

前后端用的是**同一份业务引擎**（`web/src/engine.js`）：服务端用 V8（mini-racer）执行它，因此规则不会出现前后端不一致。

- 登录：JWT（HS256）；四个演示账号对应 PRD 第 2 章四种角色，权限在服务端判定（越权返回 403）。
- 工作区：登录时可填工作区名称。同一工作区的人看到同一份需求单、资产库和任务队列；每位商务可以给客户单独开一个工作区（如 `demo-zhang`），互不干扰。
- 实时：页面每秒同步一次状态；`/ws/events` 按 SPEC 7.2 推送 `task.state`、`task.progress`、`gpu.metrics`、`agent.delta`、`qa.result`、`system.alert`。
- 持久化：每 5 秒落盘到 `$SCW_DATA/workspaces/<工作区>.json`；服务重启后运行中的任务回到排队（SPEC 第 13 章“断电恢复”）。

### 接口（SPEC 7.1，前缀 `/api/v1`）

交互式文档：`/api/docs`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/login` | `{user_id, password, workspace}` → `{token}` |
| GET / POST | `/projects` | 项目列表、创建（管理员） |
| GET / POST | `/jobs` | 需求单列表、创建草稿 |
| POST | `/jobs/{id}/precheck`、`/jobs/{id}/submit` | 许可证与预算预检、提交并拆分任务 |
| GET | `/tasks?status=&job_id=` | 任务列表 |
| POST | `/tasks/{id}/{pause\|resume\|cancel\|retry\|pin\|now}` | 任务操作 |
| GET / POST | `/concepts`、`/concepts/generate`、`/concepts/select` | 概念图 |
| POST | `/assets/generate3d`、`/assets/{id}/optimize` | 3D 生成、优化 |
| GET | `/assets`、`/assets/{id}`、`/assets/{id}/versions` | 资产检索、详情、版本 |
| POST | `/qa/{version_id}/run`、`/qa/{version_id}/review` | 自动质检、审核结论 |
| POST | `/panoramas/generate`、`/worlds/generate` | 全景、世界生成 |
| POST | `/recon/datasets`、`/recon/{id}/train` | 实景重建 |
| POST | `/scenes`、`/scenes/{id}/agent/messages`、`/scenes/{id}/confirm` | 场景组装 |
| GET / POST | `/exports`、`/exports/{id}` | 导出 |
| GET / PUT | `/models`、`/models/{id}`；POST `/models/{id}/license` | 模型登记、授权文件 |
| GET | `/system/gpu`、`/system/disk`、`/system/cloud` | 资源状态 |
| GET | `/state` | 工作区完整状态（前端同步用） |
| POST | `/rpc` | 前端页面写操作（白名单） |

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCW_DEMO_PASSWORD` | `demo-2026` | 演示账号登录密码，**对外部署请修改** |
| `SCW_JWT_SECRET` | 每次启动随机 | JWT 签名密钥；固定后重启不需要重新登录 |
| `SCW_DATA` | `./data` | 工作区数据目录 |
| `SCW_WORKSPACE` | `default` | 默认工作区 |
| `SCW_ALLOW_FASTFORWARD` | 未开启 | 仅自测：开启 `/api/v1/debug/fastforward` |

## 演示版与正式版的差异

| 项目 | 演示版 | 正式版（SPEC 第 4、5 章） |
| --- | --- | --- |
| 业务引擎 | FastAPI 进程内的 V8 执行 `engine.js`；状态存 JSON 文件 | FastAPI + PostgreSQL + Celery / Redis |
| 模型推理 | 确定性程序化生成（同 seed 必得同结果），耗时按加速倍率压缩（系统设置 → 演示控制） | ComfyUI、TRELLIS.2 推理服务、Blender 无头、LichtFeld Studio |
| GLB | 真实 glTF 2.0 二进制，含 PBR 贴图与 AIGC extras，通过 Khronos glTF-Validator | 同左，另加 Draco / KTX2 压缩 |
| 3DGS / FBX | 导出 PLY 点云与 BVH 动作 | SPZ / glTF + KHR_gaussian_splatting、FBX |
| Agent | 本地规则解析指令，调用同名工具（library.search 等） | Claude API + MCP for Blender + pipeline-mcp |

## 运行

只需要 Python 3.10+（`dist/` 已构建好并提交在仓库中）：

```bash
pip install -r requirements.txt
uvicorn server.app:app --host 0.0.0.0 --port 8000
```

浏览器打开 `http://<服务器>:8000`。健康检查：`/healthz`。

部署后运行冒烟测试（SPEC 5.3 第 6 步，只用标准库）：

```bash
python3 tools/smoke_test.py http://127.0.0.1:8000 --workspace smoke
```

### Docker

```bash
docker compose up -d --build
```

### 绑定域名

`deploy/nginx.conf` 是 Nginx 反向代理 + HTTPS 的示例，把 `demo.example.com` 和证书路径换成实际值即可。
前端第三方库（Vue、three.js、JSZip）随 `dist/vendor/` 本地提供，不依赖外网 CDN；
仅中文字体从 Google Fonts 加载，不可达时自动回退到系统字体。

## 开发与自测

```bash
npm ci                                 # 获取 Vue / three.js / JSZip / glTF-Validator
python3 web/build.py                   # 内联构建 dist/index.html 与 dist/artifact.html
pip install -r requirements-dev.txt
python3 -m playwright install chromium # 如本机已有 Chromium 可设置 SCW_CHROMIUM 指向它
python3 -m pytest tests -q             # 端到端验收测试
```

源码结构：

```
web/src/geometry.js   程序化几何、贴图、概念图、全景、点云、GLB 写出、HDR / domemaster、BVH
web/src/engine.js     业务引擎：许可证 / 文博 / AIGC 规则、GPU 调度、状态机、质检、导出
web/src/viewer.js     three.js 视口（资产、场景、点云、全景、角色）
web/src/app-core.js   外壳、登录、公共组件
web/src/pages-*.js    P01–P14 页面
server/app.py         FastAPI：REST / WebSocket / 静态页
server/engine_host.py 服务端引擎宿主（V8、时钟、持久化、重启恢复）
server/host.js        V8 内的工作区与事件管理
server/auth.py        登录与 JWT
tools/smoke_test.py   冒烟测试脚本
tests/                端到端测试（单机版规则用例 + 服务端模式用例）、glTF 校验脚本
```
