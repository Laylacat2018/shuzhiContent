#!/usr/bin/env bash
# A foreground service waiter keeps WSL alive while the actual platform is running.
set -euo pipefail
while true; do
    systemctl start scw-real-comfy scw-trellis-download
    if systemctl --wait start scw-real-platform; then
        echo 'Platform stopped or restarted; checking the managed service.'
    else
        echo 'Platform exited with an error; retrying the managed service.' >&2
    fi
    systemctl is-enabled --quiet scw-real-platform || exit 0
    sleep 5
done
