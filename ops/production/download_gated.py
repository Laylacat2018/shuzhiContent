"""Download approved dependencies; a pending publisher review remains a failed download.

Used by the managed downloader's retry policy. Does not accept terms or submit
access requests, and never prints credentials or provider response URLs.
"""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from huggingface_hub import HfApi,get_token
from ops.m0.download_verified import download
from ops.production.model_plan import GATED,GATED_FILES


def main():
    if not get_token():
        print('HF credential is not configured; use login-hf.ps1 in your own terminal.',flush=True)
        return 2
    failed=[]
    for repo in GATED:
        try:
            HfApi().auth_check(repo_id=repo,repo_type='model')
            download(repo,Path(os.getenv('HF_HOME','/data/models/hf'))/'hub',24,8*1024*1024,GATED_FILES[repo])
        except Exception as error:
            failed.append(repo)
            print(json.dumps({'repo':repo,'status':'pending_or_failed','error_type':type(error).__name__}),flush=True)
    print(json.dumps({'status':'complete' if not failed else 'retry_required','pending':failed}),flush=True)
    return 1 if failed else 0


if __name__=='__main__':raise SystemExit(main())
