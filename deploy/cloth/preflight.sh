#!/usr/bin/env bash
# 只读检查：确认主机、Caddy、Docker、端口 8790 和域名解析。不修改任何配置。
set -u
hostname; uname -m
command -v caddy && caddy version
systemctl is-active caddy
test -r /etc/caddy/Caddyfile && sha256sum /etc/caddy/Caddyfile
grep -n "import" /etc/caddy/Caddyfile || true
grep -rn "cloth.migucomi.com" /etc/caddy 2>/dev/null && echo "注意：已有 cloth 配置，请先核对" || echo "未发现 cloth 站点配置"
command -v docker && docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
ss -ltn '( sport = :80 or sport = :443 or sport = :8790 )'
echo "cloth.migucomi.com 当前解析：$(getent hosts cloth.migucomi.com || echo 未解析)"
echo "本机公网地址：$(curl -s --max-time 5 https://ifconfig.me || echo 未知)"
