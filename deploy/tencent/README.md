# space.migucomi.com 腾讯云入口

2026-11-16：用户选择自行处理域名部署。以下仅为保留的准备材料；未修改腾讯云主机或 DNS，本机通道未启用。

2026-11-17 更新：用户重新要求同步部署。目前域名已在线，公网检测为 v1.0.0 模拟业务环境。v1.1.0 的云端演示直接包含已发布真实样件，不依赖本机 GPU 或 SSH 反向通道。下面原反向通道方案仅供未来实时生产接入，不能视为本次必需步骤。

## 现有云端演示实例升级

在服务器上获取本次固定提交后，先运行 `python3 deploy/tencent/update_existing_demo.py` 只读识别当前实例。确认只识别一个空间内容工场实例后，运行 `python3 deploy/tencent/update_existing_demo.py --apply`。

升级器只处理经 /api/v1/info 验证的 Docker 演示实例；自定义挂载、非标准数据目录、GPU 生产模式或非桥接网络会中止并要求核对。它保留旧容器和旧数据，在独立回环端口对复制数据预览新版，检查版本与真实成果目录，通过后停旧容器取得一致副本，以原端口启动新实例；失败自动启动旧容器。备份配置包含敏感值，只保存在服务器权限 700 的升级目录中，不应发送到聊天或提交代码。

成功后执行 `python3 tools/verify_public_demo.py` 从公网检查版本及全部公开文件哈希，再验证账号登录、双版本切换和下载。回退使用升级记录输出的 rollback.sh。升级器不修改 Caddy 或其他域名，不删除旧容器或数据。若当前实例不是 Docker 部署，应保留只读检查结果，按现有 systemd 或其他部署方式另行准备切换。

运行方案：腾讯云现有主机提供 Caddy HTTPS 入口；本机 WSL 提供真实 FastAPI、文件存储与 GPU 执行。独立 SSH 通道把云端 `127.0.0.1:18780` 转发到本机 `127.0.0.1:8780`。业务数据与模型保存在本机，本机必须保持开机联网。

历史部署记录中的现有主机为香港 `43.161.232.185`，已有其他站点使用 Caddy。实际部署前必须登录并运行 `preflight.sh`，确认当前主机、Caddy 配置及端口；不覆盖其他站点。

## 本机持续运行

执行 `ops/production/install-windows-startup.ps1` 安装当前 Windows 用户的 `SCW-Real-Platform` 登录启动任务。该任务等待真实平台服务退出，从而保持 WSL 会话。任务使用当前用户身份，不改变其他软件的启动设置。

四个账号的实际密码及哈希在 WSL `/data/scw-production`，不随源码上传。本次账号密码按用户要求统一设置；安装器保留已有账号文件。

## 云端部署步骤

1. 登录现有主机，运行只读 `preflight.sh`；备份 `/etc/caddy/Caddyfile` 与拟修改的 SSH 配置，记录现有站点健康状态。
2. 本机运行 `setup-tencent-tunnel.py --known-hosts /mnt/c/Users/admin/.ssh/known_hosts --install-service`，只生成专用通道密钥、已验证服务器 host key 和本机服务定义。
3. 云端建立专用 `scw-tunnel` 用户和本机公钥，限制为远程转发到 `127.0.0.1:18780`，禁止终端、密码认证及其他用途；检查有效 SSH 配置并验证后再加载。私钥留在本机。
4. 启动本机 `scw-space-tunnel`，在云端通过 `http://127.0.0.1:18780/healthz` 检查真实后端，并确认监听地址仅为回环地址。
5. 将 `space.caddy` 安装为独立站点文件，在现有 Caddyfile 添加该文件的 import；执行 `caddy validate`，通过后 reload。若校验或现有站点检查失败，恢复配置备份。
6. 在 DNSPod 给 `migucomi.com` 增加主机记录 `space`，类型 `A`，值为实际核实后的服务器地址；仅修改该主机记录。Caddy 自动申请 HTTPS 证书。
7. 从公网验证 DNS、HTTPS、登录、真实模式标记、上传、GLB/ZIP 下载与 WebSocket，复核已有站点仍正常。未完成这些步骤不能报告已上线。

## 验证与回退

- TLS 后的会话 Cookie 自动带 Secure；本机 HTTP 继续可用。
- 公网入口关闭独立演示页与 API 文档；ComfyUI、模型文件和本机数据目录不作为网站目录公开。
- 通道离线时返回明确的 503 状态，自动重连由本机独立 systemd 服务执行。
- 需要回退时恢复 Caddy 备份、仅撤回 `space` DNS 记录、停止 `scw-space-tunnel`。保留业务数据和原有站点配置。

当前仓库中是准备好的部署材料，是否已上线必须以实际部署验收记录为准。
