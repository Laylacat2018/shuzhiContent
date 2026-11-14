# 空间内容工场 · AIGC 沉浸式空间内容生产管线平台（演示版 V1.0）

依据《02-AIGC 沉浸式空间内容生产管线平台 PRD · 页面原型 · SPEC》开发的**商务演示版**。
14 个页面全部可操作，PRD 第二部分的业务规则与 SPEC 的调度、状态机、质检、导出规格按文档实现；
模型推理（Qwen-Image、TRELLIS.2、3DGS 训练等）由**确定性模拟**代替，便于没有 GPU 的环境对外演示。

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

## 演示版与正式版的差异

| 项目 | 演示版 | 正式版（SPEC 第 4、5 章） |
| --- | --- | --- |
| 业务引擎 | 浏览器内 `web/src/engine.js`，数据存于本浏览器 localStorage | FastAPI + PostgreSQL + Celery / Redis |
| 模型推理 | 确定性程序化生成（同 seed 必得同结果），耗时按加速倍率压缩（系统设置 → 演示控制） | ComfyUI、TRELLIS.2 推理服务、Blender 无头、LichtFeld Studio |
| GLB | 真实 glTF 2.0 二进制，含 PBR 贴图与 AIGC extras，通过 Khronos glTF-Validator | 同左，另加 Draco / KTX2 压缩 |
| 3DGS / FBX | 导出 PLY 点云与 BVH 动作 | SPZ / glTF + KHR_gaussian_splatting、FBX |
| Agent | 本地规则解析指令，调用同名工具（library.search 等） | Claude API + MCP for Blender + pipeline-mcp |

每位访问者的数据只保存在自己的浏览器中，互不影响；在「系统设置 → 演示控制」可一键重置。

## 运行

只需要 Python 3.10+（`dist/` 已构建好并提交在仓库中）：

```bash
pip install -r requirements.txt
uvicorn server.app:app --host 0.0.0.0 --port 8000
```

浏览器打开 `http://<服务器>:8000`。健康检查：`/healthz`。

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
server/app.py         FastAPI 服务
tests/                Playwright 端到端测试、glTF 校验脚本
```
