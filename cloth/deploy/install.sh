#!/usr/bin/env bash
# 衣冠·AI复原工作台 v2 一键安装 / 更新（腾讯云主机，root 运行，在仓库根目录执行）
#   sudo bash cloth/deploy/install.sh                         安装到 cloth.migucomi.com
#   sudo bash cloth/deploy/install.sh --domain x.migucomi.com 指定域名
#   sudo bash cloth/deploy/install.sh --demo                  演示模式：未配置密钥的模型输出“模拟”占位图
#   sudo bash cloth/deploy/install.sh --sample                首次安装时导入史氏像演示项目和专家账号
# 做的事：安装 Python 依赖到 /opt/cloth-v2/venv，系统用户 cloth，systemd 服务 cloth-v2（127.0.0.1:8791），
# 数据在 /var/lib/cloth-v2；写入 Caddy 站点 /etc/caddy/cloth.caddy（先备份），校验通过才 reload，失败自动恢复。
set -euo pipefail

DOMAIN=cloth.migucomi.com
DEMO=0
SAMPLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --demo) DEMO=1; shift ;;
    --sample) SAMPLE=1; shift ;;
    *) echo "未知参数 $1"; exit 1 ;;
  esac
done

APP=/opt/cloth-v2
DATA=/var/lib/cloth-v2
ENVF=/etc/cloth-v2.env
PORT=8791
CADDYFILE=/etc/caddy/Caddyfile
SITE_FILE=/etc/caddy/cloth.caddy
SRC="$(cd "$(dirname "$0")/.." && pwd)"   # 仓库里的 cloth 目录

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n[失败] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0"
[ -f "$SRC/app/main.py" ] || die "请在仓库根目录运行：sudo bash cloth/deploy/install.sh"
command -v systemctl >/dev/null || die "缺少 systemd"
command -v caddy >/dev/null || die "缺少 caddy"
[ -f "$CADDYFILE" ] || die "找不到 $CADDYFILE"

# ---------------------------------------------------------------- 1. Python
say "1/6 检查 Python（需要 3.10 及以上）"
PY=""
for c in python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then PY="$(command -v "$c")"; break; fi
done
if [ -z "$PY" ]; then
  if command -v apt-get >/dev/null; then
    apt-get update -q && apt-get install -y -q python3.11 python3.11-venv || die "自动安装 Python 3.11 失败，请手动安装后重试"
    PY="$(command -v python3.11)"
  else
    die "未找到 Python 3.10+，请先安装（如 dnf install python3.11）"
  fi
fi
echo "使用 $PY（$("$PY" --version)）"
if ! "$PY" -m venv --help >/dev/null 2>&1 && command -v apt-get >/dev/null; then
  apt-get install -y -q "python3-venv" || apt-get install -y -q "$(basename "$PY")-venv"
fi
if command -v apt-get >/dev/null && ! fc-list 2>/dev/null | grep -qi "wenquanyi\|noto sans cjk"; then
  apt-get install -y -q fonts-wqy-zenhei >/dev/null 2>&1 || echo "（中文字体未安装，合拍图标识将显示英文 AI Generated）"
fi

# ---------------------------------------------------------------- 2. 程序
say "2/6 安装程序到 $APP"
id cloth >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin cloth
mkdir -p "$APP" "$DATA"
rm -rf "$APP/cloth.new"
cp -r "$SRC" "$APP/cloth.new"
rm -rf "$APP/cloth.new/data" "$APP/cloth" && mv "$APP/cloth.new" "$APP/cloth"
find "$APP/cloth" -name __pycache__ -prune -exec rm -rf {} +
[ -x "$APP/venv/bin/python" ] || "$PY" -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q --upgrade pip
"$APP/venv/bin/pip" install -q -r "$APP/cloth/requirements.txt"
chown -R root:root "$APP" && chmod -R a+rX "$APP"
chown -R cloth:cloth "$DATA" && chmod 750 "$DATA"

# ---------------------------------------------------------------- 3. 管理员密码与环境
say "3/6 运行配置"
if [ ! -f "$ENVF" ]; then
  while true; do
    read -r -s -p "设置管理员 admin 的密码（至少 8 位）：" AP; echo
    read -r -s -p "再输入一次：" AP2; echo
    [ "$AP" = "$AP2" ] && [ ${#AP} -ge 8 ] && break
    echo "两次不一致或少于 8 位"
  done
  umask 077
  printf 'CLOTH_DATA=%s\nCLOTH_ADMIN_PASSWORD=%s\nCLOTH_DEMO=%s\n' "$DATA" "$AP" "$DEMO" > "$ENVF"
  chmod 600 "$ENVF"
else
  sed -i "s/^CLOTH_DEMO=.*/CLOTH_DEMO=$DEMO/" "$ENVF"
  AP="$(grep '^CLOTH_ADMIN_PASSWORD=' "$ENVF" | cut -d= -f2-)"
  echo "保留已有配置 $ENVF（演示模式：$([ "$DEMO" = 1 ] && echo 开 || echo 关)）"
fi

# ---------------------------------------------------------------- 4. 演示数据（可选）
if [ "$SAMPLE" -eq 1 ]; then
  say "4/6 导入史氏像演示项目"
  while true; do
    read -r -s -p "设置演示专家账号 wang / li / zhang / chen 的共同初始密码（至少 8 位）：" EP; echo
    [ ${#EP} -ge 8 ] && break
  done
  (cd "$APP" && runuser -u cloth -- env CLOTH_DATA="$DATA" CLOTH_ADMIN_PASSWORD="$AP" CLOTH_DEMO="$DEMO" \
     "$APP/venv/bin/python" -m cloth.seed --password "$EP" --admin-password "$AP")
else
  say "4/6 跳过演示数据（需要时加 --sample）"
fi

# ---------------------------------------------------------------- 5. 服务
say "5/6 启动服务 cloth-v2"
cp "$APP/cloth/deploy/cloth-v2.service" /etc/systemd/system/cloth-v2.service
systemctl daemon-reload
systemctl enable cloth-v2 >/dev/null 2>&1
systemctl restart cloth-v2
ok=0
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
[ "$ok" -eq 1 ] || { journalctl -u cloth-v2 -n 40 --no-pager; die "服务没有启动，见上面日志"; }
curl -fsS "http://127.0.0.1:$PORT/api/info"; echo

# ---------------------------------------------------------------- 6. Caddy
say "6/6 配置 Caddy 站点 $DOMAIN"
backup="$CADDYFILE.bak-cloth-$(date +%Y%m%d%H%M%S)"
cp -p "$CADDYFILE" "$backup"
[ -f "$SITE_FILE" ] && cp -p "$SITE_FILE" "$SITE_FILE.bak-$(date +%Y%m%d%H%M%S)"
sed "s/__DOMAIN__/$DOMAIN/" "$APP/cloth/deploy/cloth.caddy" > "$SITE_FILE"
chmod 644 "$SITE_FILE"
grep -qE "^\s*import\s+$SITE_FILE\s*$" "$CADDYFILE" || printf '\nimport %s\n' "$SITE_FILE" >> "$CADDYFILE"
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/cloth-v2-caddy.log 2>&1; then
  cp -p "$backup" "$CADDYFILE"; tail -20 /tmp/cloth-v2-caddy.log
  die "Caddy 校验失败，已恢复原 Caddyfile（备份 $backup）。服务本身已在 127.0.0.1:$PORT 运行。"
fi
systemctl reload caddy || { cp -p "$backup" "$CADDYFILE"; systemctl reload caddy || true; die "Caddy reload 失败，已恢复"; }

ip=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo "未知")
cur=$( (getent hosts "$DOMAIN" || true) | awk '{print $1}' | head -1)
echo
echo "完成。https://$DOMAIN"
echo "  管理员：admin（密码为刚才设置的密码）$([ "$SAMPLE" -eq 1 ] && echo '；演示专家：wang 主审 / li、zhang 评审 / chen 运营')"
echo "  本机公网地址：$ip；$DOMAIN 当前解析：${cur:-未解析}"
[ -n "$cur" ] && [ "$cur" = "$ip" ] || echo "  请在 DNSPod 为 migucomi.com 添加 A 记录：主机记录 ${DOMAIN%%.migucomi.com}，记录值 $ip"
echo "  日志：journalctl -u cloth-v2 -f    数据：$DATA    下一步：用 admin 登录 → 系统设置 → 模型接入 填写密钥"
