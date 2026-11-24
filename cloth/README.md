# 衣冠·AI复原工作台 v2.0

依据《衣冠·AI复原工作台 产品需求文档 PRD v2.0》实现：PC 专家工作台（P01–P09、P11）+ 观众手机合拍 H5（P10）。

## 结构

| 路径 | 内容 |
| --- | --- |
| `app/core.py` | 配置、文件存储（SHA-256）、登录会话、角色权限、审计日志、密钥加密（Fernet）、SM3 存证 |
| `app/store.py` | SQLite 文档存储，带 rev 乐观锁（多人同时编辑冲突检测）；结构可直接迁移到 PostgreSQL JSONB |
| `app/routes_project.py` | 登录、成员、P01 项目、P02 史料（上传、白名单检索、链接抓取、AI 初读、观察记录、文献） |
| `app/routes_spec.py` | P03 规格书：逐字段编辑、证据等级、关联史料、审核状态、批注 @、版本、签署与复核、差异、提示词预览 |
| `app/routes_flow.py` | P04 生成任务、P05 多专家评审（模板、盲评、标注、汇总分歧、AI 预评）、P06 推荐与决定、P07 修订、P08 定稿存证 |
| `app/routes_photo.py` | P09 合拍模板与活动、P10 观众合拍接口、P11 模型接入 / 白名单 / 审计 |
| `app/ai.py` | 模型适配层：Gemini（Nano Banana）、火山方舟（Seedream）、OpenAI（GPT Image）、本地 ComfyUI（Qwen-Image-Edit-2509）、OpenAI 兼容视觉模型；AIGC 标识 |
| `app/museum.py` | 大都会、克利夫兰开放接口检索；白名单藏品页抓取 |
| `app/worker.py` | 生成任务调度：云端并发，本地 GPU 单独排队，单个模型失败不影响其他 |
| `static/` | 前端（Vue 3，无构建步骤）；`m.html` 为手机合拍页 |
| `tests/test_workflow.py` | 按 PRD 各页验收点的端到端测试 |
| `seed.py` | 演示数据：史氏像项目、专家账号、此前各模型真实生成图 |

## 本地运行

```bash
pip install -r cloth/requirements.txt
CLOTH_DATA=./cloth/data CLOTH_DEMO=1 python3 -m cloth.seed --password demo12345
CLOTH_DATA=./cloth/data CLOTH_DEMO=1 python3 -m uvicorn cloth.app.main:app --port 8791
```

打开 http://127.0.0.1:8791 ，账号 `wang`（主审）、`li` / `zhang`（评审专家）、`chen`（运营）、`admin`（技术，演示模式密码 `cloth2026`）。

`CLOTH_DEMO=1` 时，未配置密钥的模型输出带“模拟生成”字样的占位图，仅用于演示流程；正式环境不要设置该变量，未配置密钥的模型会直接报“未配置”。

## 测试

```bash
python3 -m pytest cloth/tests -q
```

## 正式部署（腾讯云主机）

推荐一条命令：`sudo bash cloth/deploy/install.sh --sample`，完整步骤、API 密钥说明和跑通流程见 [deploy/部署与跑通手册.md](deploy/部署与跑通手册.md)。下面是手动步骤。

1. `sudo mkdir -p /opt/cloth-v2 && sudo cp -r cloth /opt/cloth-v2/ && sudo python3 -m venv /opt/cloth-v2/venv && sudo /opt/cloth-v2/venv/bin/pip install -r /opt/cloth-v2/cloth/requirements.txt`
2. `sudo cp cloth/deploy/cloth-v2.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now cloth-v2`
3. 首次启动会生成管理员初始密码，保存在 `/var/lib/cloth-v2/admin-initial-password.txt`（权限 600）；登录后在“系统设置 → 成员与角色”添加专家账号。也可设置环境变量 `CLOTH_ADMIN_PASSWORD`。
4. Caddy 反向代理到 `127.0.0.1:8791`，设置 `request_body max_size 60MB`。工作台有自己的登录，不需要 basic_auth；`/m/*` 与 `/api/m*` 为观众公开路径。
5. 在“系统设置 → 模型接入”填写各模型密钥并点“连通测试”；本地 Qwen 需把接口地址指向可访问的 ComfyUI。

## 与 PRD 的差异（一期实现说明）

- 数据库：一期使用 SQLite 文档存储（单机、WAL），文档结构可直接迁移到 PostgreSQL JSONB；任务队列为进程内线程池（Redis 后续接入）。
- 博物馆检索：大都会、克利夫兰走开放接口；国内馆无公开检索接口，通过“粘贴链接”抓取，检索框会提示。
- 复原报告：以网页形式输出，浏览器“打印 → 另存为 PDF”。
- 合拍：采用“多图编辑”方式（观众照片 + 模板交给已配置的图像模型）；如接入已备案的第三方人像融合服务，需按其接口增加一个适配器。人脸数量检测需安装 OpenCV，未安装时由模型侧处理。
- 登录：账号密码；短信二次验证待接入短信服务。
