"""Reuse exact local Qwen files only after checking the official repository SHA-256."""
import argparse
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from huggingface_hub import HfApi
from ops.m0.download_verified import digest
from ops.production.model_plan import QWEN_REPO,QWEN_FILES


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('source',type=Path)
    a=p.parse_args();info=HfApi().model_info(QWEN_REPO,files_metadata=True)
    files={s.rfilename:s for s in info.siblings}
    base=Path(os.getenv('HF_HOME','/data/models/hf'))/'hub'/('models--'+QWEN_REPO.replace('/','--'))
    blobs=base/'blobs';blobs.mkdir(parents=True,exist_ok=True)
    lock=(base/'download.lock').open('a')
    if os.name!='nt':
        import fcntl
        fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
    for name in QWEN_FILES:
        meta=files[name]
        for local in a.source.rglob(Path(name).name):
            if not local.is_file() or local.stat().st_size!=meta.size:continue
            if digest(local)!=meta.lfs.sha256:
                print('Ignored different local weight: '+str(local),flush=True);continue
            target=blobs/meta.lfs.sha256
            if not target.exists() or target.stat().st_size!=meta.size or digest(target)!=meta.lfs.sha256:
                tmp=blobs/(meta.lfs.sha256+'.reuse.tmp');shutil.copyfile(local,tmp)
                if digest(tmp)!=meta.lfs.sha256:raise RuntimeError('Local copy verification failed')
                tmp.replace(target)
            print('Official SHA-256 matched; reused '+name,flush=True)
            break


if __name__=='__main__':main()
