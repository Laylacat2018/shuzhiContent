# Enter the token only in this terminal, after your own account has approved access.
wsl -d Ubuntu-22.04 -- env HF_HOME=/data/models/hf /opt/scw/miniforge3/envs/trellis2/bin/hf auth login
