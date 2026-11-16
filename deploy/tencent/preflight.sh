#!/usr/bin/env bash
# Read-only checks for the existing Tencent host. Does not change websites or SSH.
set -eu
hostname
uname -m
command -v caddy
caddy version
systemctl is-active caddy
test -r /etc/caddy/Caddyfile
sha256sum /etc/caddy/Caddyfile
ss -ltn '( sport = :80 or sport = :443 or sport = :18780 )'
if getent passwd scw-tunnel >/dev/null; then
  echo 'scw-tunnel account already exists: inspect ownership before changes.'
else
  echo 'scw-tunnel account is available.'
fi
