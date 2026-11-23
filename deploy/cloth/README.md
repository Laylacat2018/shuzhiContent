# 衣冠复原实验台 · cloth.migucomi.com 自部署

把 claude.ai 上的“衣冠复原实验台”页面部署到腾讯云主机，域名 `cloth.migucomi.com`。

## 内容

| 文件 | 作用 |
| --- | --- |
| `site/index.html` | 实验台页面（取自 claude.ai 版本，仅做三处改动：去掉 Google Fonts 外链、加载 `claude-shim.js`、改写 AI 专家不可用提示） |
| `site/claude-shim.js` | 在 claude.ai 之外提供页面所需的 `db`、`assets` 接口，后端为本服务 |
| `site/shi.jpg` | 国博官网公开画像（复原依据） |
| `server.py` | 只用 Python 标准库的服务：静态页面、`/api/db`（集合 runs、meta）、`/api/assets` 图片上传、`/_blob/<id>` |
| `seed/` | 首次启动导入的数据：截至 2026-11-23 的 18 条生成结果（GPT 1、Nano Banana 1、Seedream 2、Qwen 14）、评审记录、规格书 V2 修订和 18 张图片 |
| `cloth-lab.service` | systemd 服务（推荐） |
| `Dockerfile` | 容器方式（备选，未在本仓库环境中构建验证） |
| `cloth.caddy` | Caddy 站点：HTTPS、basic_auth 访问控制、反向代理到 127.0.0.1:8790 |
| `preflight.sh` | 只读检查主机、Caddy、端口与解析 |

与 claude.ai 版的差异：

- 数据独立存放在服务器 `/var/lib/cloth-lab`，与 claude.ai 版不同步。
- 第④步“AI 专家评审”不可用（需要 Claude 运行环境），可手动逐项打分；已导入的评审记录照常显示。
- 整站由 Caddy basic_auth 保护，只有拿到账号密码的人能访问和上传。

## 部署步骤（在腾讯云主机上执行）

1. 获取代码（仓库已在主机上时）：

   ```bash
   git fetch origin claude/vibrant-cannon-51pg7i && git checkout FETCH_HEAD -- deploy/cloth
   ```

2. 只读检查，确认 Caddy 正常、8790 端口空闲、记录本机公网地址：

   ```bash
   bash deploy/cloth/preflight.sh
   ```

3. 安装服务并自检：

   ```bash
   sudo mkdir -p /opt/cloth-lab && sudo cp -r deploy/cloth/server.py deploy/cloth/site deploy/cloth/seed /opt/cloth-lab/
   sudo cp deploy/cloth/cloth-lab.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now cloth-lab
   curl -s 127.0.0.1:8790/healthz
   ```

   应返回 `{"ok": true}`。

4. 配置 Caddy（先备份）：

   ```bash
   sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-cloth
   caddy hash-password
   ```

   把 `deploy/cloth/cloth.caddy` 里的 `CLOTH_USER` 换成登录名、`CLOTH_PASSWORD_HASH` 换成上一步输出的哈希，复制到 `/etc/caddy/cloth.caddy`，在 `/etc/caddy/Caddyfile` 末尾加一行 `import /etc/caddy/cloth.caddy`，然后：

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
   ```

   校验失败时用备份恢复，不要 reload。Caddy 2.8 以上若提示 `basicauth` 已更名，可改为 `basic_auth`。

5. 在 DNSPod 为 `migucomi.com` 增加主机记录 `cloth`，类型 `A`，值为第 2 步记录的服务器公网地址。只改这一条记录。解析生效后 Caddy 自动申请 HTTPS 证书。

6. 验收：浏览器打开 `https://cloth.migucomi.com`，输入账号密码；第③步应看到已导入的结果，第⑤步对比矩阵应显示 Nano Banana 19.0、Seedream 17.0、GPT 17.0、Qwen 12.1（E2）。上传一张图片、改判一个分数后刷新页面，确认已保存。同时复核 `space.migucomi.com` 等原有站点仍正常。

## 运维

- 数据：`/var/lib/cloth-lab`（`db/` 为 JSON 文档，`blobs/` 为图片）。备份即打包该目录。
- 日志：`journalctl -u cloth-lab`。
- 更新页面：替换 `/opt/cloth-lab/site` 后 `sudo systemctl restart cloth-lab`；已有数据不受影响（`.seeded` 标记存在时不再导入种子）。
- 回退：从 Caddyfile 删除 import 行并 reload，`sudo systemctl disable --now cloth-lab`，撤回 DNS 记录 `cloth`。
