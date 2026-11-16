"""Resume the complete V1 public model plan, then gated models only with user access."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from ops.m0.download_verified import download
from ops.production.model_plan import PUBLIC,GATED,QWEN_REPO,QWEN_FILES


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--workers',type=int,default=32)
    p.add_argument('--with-gated',action='store_true',help='Requires your own HF login and approved access')
    a=p.parse_args()
    root=Path(os.getenv('HF_HOME','/data/models/hf'));cache=root/'hub'
    for repo,files in PUBLIC+([(repo,['*.json','*.safetensors','*.py']) for repo in GATED] if a.with_gated else []):
        snapshot=download(repo,cache,min(32,max(1,a.workers)),8*1024*1024,files)
        if repo==QWEN_REPO:
            models=Path(os.getenv('SCW_MODEL_DIR','/data/models/comfyui'))
            for filename in QWEN_FILES:
                source=snapshot/filename;target=models/Path(filename).parent.name/Path(filename).name
                target.parent.mkdir(parents=True,exist_ok=True)
                if target.exists() or target.is_symlink():
                    if target.resolve()!=source.resolve(): raise RuntimeError('Existing model path belongs to another file: '+str(target))
                else:target.symlink_to(source)
    print(json.dumps({'public_models':'complete','gated_models':'complete' if a.with_gated else 'pending_user_access','gated_repositories':GATED}),flush=True)


if __name__=='__main__':main()
