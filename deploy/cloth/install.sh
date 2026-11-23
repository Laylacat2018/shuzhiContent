#!/usr/bin/env bash
# 衣冠复原实验台一键安装（在腾讯云主机上，以 root 运行）。
#   sudo bash deploy/cloth/install.sh            安装 / 更新
#   sudo bash deploy/cloth/install.sh --password 重新设置访问账号密码
# 做的事：复制程序到 /opt/cloth-lab，安装并启动 systemd 服务 cloth-lab（127.0.0.1:8790），
# 生成带账号密码的 Caddy 站点 /etc/caddy/cloth.caddy，在 Caddyfile 末尾 import，校验通过才 reload，
# 校验失败自动恢复 Caddyfile 备份。不修改其他站点，不修改 DNS。
set -euo pipefail

DOMAIN=cloth.migucomi.com
APP=/opt/cloth-lab
PORT=8790
CADDYFILE=/etc/caddy/Caddyfile
SITE_FILE=/etc/caddy/cloth.caddy
HERE="$(cd "$(dirname "$0")" && pwd)"
RESET_PW=0
[ "${1:-}" = "--password" ] && RESET_PW=1

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n[失败] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0"
command -v python3 >/dev/null || die "缺少 python3"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)' || die "需要 Python 3.7 以上"
command -v systemctl >/dev/null || die "缺少 systemd"
command -v caddy >/dev/null || die "缺少 caddy（本脚本只支持主机上直接安装的 Caddy）"
[ -f "$CADDYFILE" ] || die "找不到 $CADDYFILE"
[ -f "$HERE/server.py" ] && [ -d "$HERE/site" ] && [ -d "$HERE/seed" ] || die "请在仓库里运行：sudo bash deploy/cloth/install.sh"

# ---------- 1. 程序与服务 ----------
say "1/4 安装程序到 $APP"
if command -v ss >/dev/null && ss -ltn "( sport = :$PORT )" | grep -q ":$PORT" && ! systemctl is-active --quiet cloth-lab; then
  die "端口 $PORT 已被其他程序占用：$(ss -ltnp "( sport = :$PORT )" | tail -n +2)"
fi
mkdir -p "$APP"
rm -rf "$APP/site.new"
cp -r "$HERE/site" "$APP/site.new"
cp "$HERE/server.py" "$APP/server.py"
rm -rf "$APP/seed" && cp -r "$HERE/seed" "$APP/seed"
rm -rf "$APP/site" && mv "$APP/site.new" "$APP/site"
chmod -R a+rX "$APP"
cp "$HERE/cloth-lab.service" /etc/systemd/system/cloth-lab.service
systemctl daemon-reload
systemctl enable cloth-lab >/dev/null 2>&1
systemctl restart cloth-lab

say "2/4 检查服务"
ok=0
for _ in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" -eq 1 ] || { journalctl -u cloth-lab -n 30 --no-pager; die "服务没有启动，见上面日志"; }
runs=$(curl -fsS "http://127.0.0.1:$PORT/api/db/runs" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
echo "服务正常，已有生成结果 $runs 条"

# ---------- 2. Caddy 站点 ----------
say "3/4 配置 Caddy 站点 $DOMAIN"
if [ ! -f "$SITE_FILE" ] || [ "$RESET_PW" -eq 1 ]; then
  read -r -p "访问账号（默认 guobo）：" user; user=${user:-guobo}
  [[ "$user" =~ ^[A-Za-z0-9_.-]{1,32}$ ]] || die "账号只能用字母、数字、_ . -"
  while true; do
    read -r -s -p "访问密码（至少 8 位）：" pw; echo
    read -r -s -p "再输入一次：" pw2; echo
    [ "$pw" = "$pw2" ] && [ ${#pw} -ge 8 ] && break
    echo "两次不一致或少于 8 位，请重输"
  done
  hash=$(caddy hash-password --plaintext "$pw")
  unset pw pw2
  # Caddy 2.8 起指令名为 basic_auth，旧版为 basicauth
  ver=$(caddy version | grep -oE 'v2\.[0-9]+' | head -1 | cut -d. -f2)
  directive=basicauth; [ "${ver:-0}" -ge 8 ] && directive=basic_auth
  tmp=$(mktemp)
  sed -e "s|^\(\s*\)basicauth {|\1$directive {|" -e "s|CLOTH_USER CLOTH_PASSWORD_HASH|$user $hash|" "$HERE/cloth.caddy" > "$tmp"
  install -m 644 -o root -g root "$tmp" "$SITE_FILE"
  rm -f "$tmp"
  echo "已写入 $SITE_FILE（账号 $user）"
else
  echo "保留已有 $SITE_FILE 与账号密码（需要改密码时加 --password）"
fi

backup="$CADDYFILE.bak-cloth-$(date +%Y%m%d%H%M%S)"
cp -p "$CADDYFILE" "$backup"
if ! grep -qE "^\s*import\s+$SITE_FILE\s*$" "$CADDYFILE"; then
  printf '\nimport %s\n' "$SITE_FILE" >> "$CADDYFILE"
fi
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/cloth-caddy-validate.log 2>&1; then
  cp -p "$backup" "$CADDYFILE"
  tail -20 /tmp/cloth-caddy-validate.log
  die "Caddy 配置校验失败，已恢复原 Caddyfile（备份 $backup）。其他站点未受影响。"
fi
systemctl reload caddy || { cp -p "$backup" "$CADDYFILE"; systemctl reload caddy || true; die "Caddy reload 失败，已恢复原配置"; }
echo "Caddy 已加载新站点（原配置备份：$backup）"

# ---------- 3. DNS 提示 ----------
say "4/4 域名解析"
ip=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || curl -fsS --max-time 5 https://ipinfo.io/ip 2>/dev/null || echo "未知")
cur=$( (getent hosts "$DOMAIN" || true) | awk '{print $1}' | head -1)
echo "本机公网地址：$ip"
echo "$DOMAIN 当前解析：${cur:-未解析}"
if [ -n "$cur" ] && [ "$cur" = "$ip" ]; then
  echo "解析已指向本机。Caddy 会自动申请 HTTPS 证书，稍等一两分钟后打开 https://$DOMAIN"
else
  echo "请在 DNSPod 为 migucomi.com 添加记录：主机记录 cloth，类型 A，记录值 $ip。生效后 Caddy 自动申请 HTTPS 证书。"
fi
echo
echo "完成。服务：systemctl status cloth-lab；日志：journalctl -u cloth-lab；数据：/var/lib/cloth-lab"
