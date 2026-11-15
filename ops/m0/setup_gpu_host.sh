#!/usr/bin/env bash
# M0 · GPU 主机环境安装（Ubuntu 22.04 / Windows 11 + WSL2 Ubuntu 22.04）
#
# 用法（在 GPU 主机上，以有 sudo 权限的用户执行；可重复运行）：
#   bash ops/m0/setup_gpu_host.sh --all
#   bash ops/m0/setup_gpu_host.sh --base --dirs --blender      # 只装部分
#
# 组件：
#   --base      系统包：git、curl、ffmpeg、编译工具、Python venv
#   --dirs      SPEC 5.2 目录结构 /data/...（属主为当前用户）
#   --docker    Docker Engine + NVIDIA Container Toolkit（WSL2 若已用 Docker Desktop 可跳过）
#   --cuda      CUDA Toolkit 12.4（编译 TRELLIS.2 扩展需要；WSL2 自动使用 wsl-ubuntu 仓库）
#   --conda     Miniforge（conda-forge 社区发行版，BSD 许可，避免 Anaconda 默认频道的商用条款）
#   --comfyui   ComfyUI（独立 venv，PyTorch CUDA 12.4），模型目录指向 /data/models/comfyui
#   --trellis2  TRELLIS.2（官方 setup.sh 创建 conda 环境 trellis2）
#   --blender   Blender 4.2 LTS 无头模块 bpy（Python 3.11 venv，由 uv 安装）
#
# 环境变量：SCW_HOME（默认 /opt/scw）、SCW_DATA（默认 /data）
set -euo pipefail

SCW_HOME="${SCW_HOME:-/opt/scw}"
SCW_DATA="${SCW_DATA:-/data}"
CONDA_DIR="${CONDA_DIR:-$SCW_HOME/miniforge3}"
LOG() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
WSL=0; grep -qi microsoft /proc/version 2>/dev/null && WSL=1

trap 'echo -e "\n\033[1;31m❌ 安装中断：第 $LINENO 行执行失败：$BASH_COMMAND\033[0m\n   把这一屏截图发给开发者；修好后重跑同一条命令即可，已完成的部分会自动跳过。" >&2' ERR

# 开始前检查网络：DNS 解析失败时 apt / 下载会全部失败
for h in github.com developer.download.nvidia.com; do
  if ! getent hosts "$h" >/dev/null; then
    echo -e "\033[1;31m❌ 无法解析 $h（DNS 不可用）\033[0m"
    echo "   WSL 中可执行：rm -f /etc/resolv.conf; printf 'nameserver 223.5.5.5\\nnameserver 114.114.114.114\\n' > /etc/resolv.conf"
    echo "   并在 /etc/wsl.conf 的 [network] 段加入 generateResolvConf=false，防止重启后被覆盖。"
    exit 1
  fi
done

want() { for a in "${ARGS[@]}"; do [[ "$a" == "--all" || "$a" == "$1" ]] && return 0; done; return 1; }
ARGS=("$@"); [[ ${#ARGS[@]} -eq 0 ]] && { sed -n '2,22p' "$0"; exit 0; }

sudo mkdir -p "$SCW_HOME" && sudo chown "$USER" "$SCW_HOME"

if want --base; then
  LOG "系统包"
  sudo apt-get update
  sudo apt-get install -y git git-lfs curl wget ca-certificates gnupg build-essential ninja-build ffmpeg \
       python3-venv python3-pip libgl1 libglib2.0-0 libegl1 libxrender1 libxi6 libxkbcommon0 libsm6
fi

if want --dirs; then
  LOG "数据目录 $SCW_DATA（SPEC 5.2）"
  sudo mkdir -p "$SCW_DATA"/{models/{hf,comfyui/{diffusion_models,text_encoders,vae,loras}},assets/{uploads,concepts,raw3d,library,scenes,recon},export,pg,backup,logs}
  sudo chown -R "$USER" "$SCW_DATA"
fi

if want --docker; then
  if ! command -v docker >/dev/null; then
    LOG "Docker Engine"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER" || true
  fi
  LOG "NVIDIA Container Toolkit"
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker 2>/dev/null || sudo service docker restart
fi

if want --cuda; then
  if ! command -v nvcc >/dev/null && [[ ! -x /usr/local/cuda-12.4/bin/nvcc ]]; then
    LOG "CUDA Toolkit 12.4"
    REPO=$([[ $WSL == 1 ]] && echo wsl-ubuntu || echo ubuntu2204)
    tmp=$(mktemp -d); wget -nv -O "$tmp/k.deb" "https://developer.download.nvidia.com/compute/cuda/repos/$REPO/x86_64/cuda-keyring_1.1-1_all.deb"
    sudo dpkg -i "$tmp/k.deb" && sudo apt-get update && sudo apt-get install -y cuda-toolkit-12-4
  fi
  grep -q 'cuda-12.4' ~/.bashrc || echo 'export CUDA_HOME=/usr/local/cuda-12.4; export PATH=$CUDA_HOME/bin:$PATH' >> ~/.bashrc
fi

if want --conda; then
  if [[ ! -x "$CONDA_DIR/bin/conda" ]]; then
    LOG "Miniforge → $CONDA_DIR"
    wget -nv -O /tmp/miniforge.sh https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
    bash /tmp/miniforge.sh -b -p "$CONDA_DIR"
    "$CONDA_DIR/bin/conda" init bash >/dev/null
  fi
fi

if want --comfyui; then
  LOG "ComfyUI → $SCW_HOME/ComfyUI"
  [[ -d "$SCW_HOME/ComfyUI" ]] || git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$SCW_HOME/ComfyUI"
  cd "$SCW_HOME/ComfyUI"
  [[ -d venv ]] || python3 -m venv venv
  ./venv/bin/pip install -U pip
  ./venv/bin/pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
  ./venv/bin/pip install -r requirements.txt
  cat > extra_model_paths.yaml <<EOF
scw:
    base_path: $SCW_DATA/models/comfyui
    diffusion_models: diffusion_models
    text_encoders: text_encoders
    vae: vae
    loras: loras
EOF
  cd - >/dev/null
fi

if want --trellis2; then
  LOG "TRELLIS.2 → $SCW_HOME/TRELLIS.2"
  [[ -x "$CONDA_DIR/bin/conda" ]] || { echo "需要先安装 --conda"; exit 1; }
  [[ -d "$SCW_HOME/TRELLIS.2" ]] || git clone -b main --recursive https://github.com/microsoft/TRELLIS.2.git "$SCW_HOME/TRELLIS.2"
  export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda-12.4}"
  export CONDA_ALWAYS_YES=true PIP_NO_INPUT=1   # 无人值守：conda / pip 不再停下来询问
  # shellcheck disable=SC1091
  source "$CONDA_DIR/etc/profile.d/conda.sh"
  cd "$SCW_HOME/TRELLIS.2"
  if ! conda env list | grep -q '^trellis2 '; then
    . ./setup.sh --new-env --basic --flash-attn --nvdiffrast --nvdiffrec --cumesh --o-voxel --flexgemm
  fi
  conda activate trellis2 && pip install -q huggingface_hub psutil && conda deactivate
  cd - >/dev/null
fi

if want --blender; then
  LOG "Blender 4.2 LTS 无头模块（bpy）→ $SCW_HOME/bpy"
  python3 -m pip install --user -q uv
  export PATH="$HOME/.local/bin:$PATH"
  [[ -d "$SCW_HOME/bpy" ]] || uv venv -p 3.11 "$SCW_HOME/bpy"
  uv pip install -p "$SCW_HOME/bpy/bin/python" "bpy==4.2.*"
  "$SCW_HOME/bpy/bin/python" -c "import bpy; print('Blender', bpy.app.version_string)"
fi

LOG "完成。下一步：python3 ops/m0/check_env.py --container，然后 python3 ops/m0/download_models.py"
