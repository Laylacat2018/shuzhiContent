#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export SCW_MODE=production
export SCW_DATA="${SCW_DATA:-/data/scw-production}"
export SCW_KTX_BIN="${SCW_KTX_BIN:-/opt/scw/ktx/KTX-Software-4.4.2-Linux-x86_64/bin}"
export SCW_NODE="${SCW_NODE:-/usr/local/bin/node}"
export HF_HOME="${HF_HOME:-/data/models/hf}"
mkdir -p "$SCW_DATA"
if [[ -f "$SCW_DATA/runtime.env" ]]; then
  set -a; source "$SCW_DATA/runtime.env"; set +a
else
  umask 077
  /opt/scw/platform/bin/python -c 'import secrets;from pathlib import Path;import os;p=Path(os.environ["SCW_DATA"])/"runtime.env";p.write_text("SCW_DEMO_PASSWORD="+secrets.token_urlsafe(20)+"\nSCW_JWT_SECRET="+secrets.token_hex(32)+"\n")'
  set -a; source "$SCW_DATA/runtime.env"; set +a
fi
export SCW_ACCOUNTS_FILE="$SCW_DATA/accounts.json"
if [[ ! -f "$SCW_ACCOUNTS_FILE" ]]; then
  /opt/scw/platform/bin/python - <<'PY'
import hashlib,json,os,secrets
from pathlib import Path
os.umask(0o077)
passwords={uid:(os.environ['SCW_DEMO_PASSWORD'] if uid=='u_admin' else secrets.token_urlsafe(20)) for uid in ['u_pm','u_art','u_rev','u_admin']}
records={}
for uid,pw in passwords.items():
    salt=secrets.token_bytes(16)
    records[uid]=dict(salt=salt.hex(),hash=hashlib.scrypt(pw.encode(),salt=salt,n=16384,r=8,p=1).hex())
Path(os.environ['SCW_ACCOUNTS_FILE']).write_text(json.dumps(records))
(Path(os.environ['SCW_DATA'])/'initial-credentials.json').write_text(json.dumps(passwords,indent=2))
PY
fi
export TZ=Asia/Shanghai
exec /opt/scw/platform/bin/python -m uvicorn server.app:app --host 127.0.0.1 --port "${SCW_PORT:-8780}"
