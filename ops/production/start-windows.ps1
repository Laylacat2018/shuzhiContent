# Run in a terminal: keeps this WSL session alive while local services run.
$ErrorActionPreference = 'Stop'
wsl -d Ubuntu-22.04 -- bash -lc 'systemctl start scw-real-platform scw-real-comfy scw-trellis-download; journalctl -f -u scw-real-platform -u scw-real-comfy --no-pager -n 12'
