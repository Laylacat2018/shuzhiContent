#!/usr/bin/env bash
set -euo pipefail
export HF_HOME="${HF_HOME:-/data/models/hf}"
SCW_MODEL_DIR="${SCW_MODEL_DIR:-/data/models/comfyui}"
SCW_CONFIG_DIR="${SCW_DATA:-/data/scw-production}/config"
mkdir -p "$SCW_CONFIG_DIR"
export SCW_MODEL_DIR SCW_CONFIG_DIR
SCW_CODE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
/opt/scw/platform/bin/python -c 'import json,os;from pathlib import Path;d=dict(base_path=os.environ["SCW_MODEL_DIR"],is_default=True,diffusion_models="diffusion_models",text_encoders="text_encoders",vae="vae",loras="loras");(Path(os.environ["SCW_CONFIG_DIR"])/"comfy-model-paths.yaml").write_text(json.dumps({"scw":d}))'
cd "${SCW_COMFY_HOME:-/opt/scw/ComfyUI}"
exec venv/bin/python "$SCW_CODE_DIR/ops/production/comfy_entry.py" --listen 127.0.0.1 --port 8188 --extra-model-paths-config "$SCW_CONFIG_DIR/comfy-model-paths.yaml"
