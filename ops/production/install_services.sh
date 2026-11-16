#!/usr/bin/env bash
# Installs only SCW-owned local services; does not modify other GPU applications.
set -euo pipefail
cd "$(dirname "$0")/../.."
SCW_CODE_DIR="$(pwd)"
mkdir -p /data/logs
for name in scw-real-platform scw-real-comfy scw-trellis-download; do
  if [[ -f "/etc/systemd/system/$name.service" ]] && ! grep -q 'Managed by SCW real pipeline' "/etc/systemd/system/$name.service"; then
    echo "Service name already exists: $name" >&2; exit 1
  fi
done
cat > /etc/systemd/system/scw-real-platform.service <<EOF
# Managed by SCW real pipeline
[Unit]
Description=SCW real prop pipeline
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$SCW_CODE_DIR
ExecStart=/bin/bash $SCW_CODE_DIR/ops/production/start.sh
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/scw-real-comfy.service <<EOF
# Managed by SCW real pipeline
[Unit]
Description=SCW local ComfyUI
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$SCW_CODE_DIR
ExecStart=/bin/bash $SCW_CODE_DIR/ops/production/start_comfy.sh
Restart=on-failure
RestartSec=10
TimeoutStopSec=20
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/scw-trellis-download.service <<EOF
# Managed by SCW real pipeline
[Unit]
Description=SCW verified public V1 model downloads
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$SCW_CODE_DIR
Environment=HF_HOME=/data/models/hf
Environment=HF_HUB_DISABLE_XET=1
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/scw/miniforge3/envs/trellis2/bin/python $SCW_CODE_DIR/ops/production/download_models.py --workers 32
StandardOutput=append:/data/logs/scw-download-trellis-service.log
StandardError=append:/data/logs/scw-download-trellis-service.log
Restart=on-failure
RestartSec=120
TimeoutStopSec=10
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
echo 'Installed: scw-real-platform, scw-real-comfy, scw-trellis-download'
echo 'Start with: systemctl enable --now scw-real-platform scw-real-comfy scw-trellis-download'
