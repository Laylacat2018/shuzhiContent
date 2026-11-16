#!/usr/bin/env python3
"""Resumable ranged downloads from the official HF endpoint with LFS SHA-256 checks.

Does not bypass gated repositories or accept licenses. Completed chunks and existing
HF partial prefixes are preserved. Writes standard HF snapshots only after verification.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import fnmatch
import json
import os
from pathlib import Path
import shutil
import time
import urllib.error
import urllib.request
import urllib.parse


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected=super().redirect_request(req,fp,code,msg,headers,newurl)
        if redirected and urllib.parse.urlparse(req.full_url).hostname!=urllib.parse.urlparse(newurl).hostname:
            redirected.remove_header('Authorization')
        return redirected


def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while b:=f.read(8*1024*1024):h.update(b)
    return h.hexdigest()


def download(repo, cache, workers, chunk_size, include=None):
    base=cache/('models--'+repo.replace('/','--'));base.mkdir(parents=True,exist_ok=True)
    with (base/'download.lock').open('a') as lock:
        if os.name!='nt':
            import fcntl
            try:fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise RuntimeError('该模型已有下载器运行，请勿同时写入同一缓存') from None
        return _download(repo,cache,workers,chunk_size,include)


def _download(repo, cache, workers, chunk_size, include=None):
    from huggingface_hub import HfApi, hf_hub_download, hf_hub_url, get_token
    api=HfApi();info=api.model_info(repo,files_metadata=True)
    base=cache/('models--'+repo.replace('/','--'));blobs=base/'blobs';blobs.mkdir(parents=True,exist_ok=True)
    snapshot=base/'snapshots'/info.sha;snapshot.mkdir(parents=True,exist_ok=True)
    token=get_token();headers={'User-Agent':'SCW-model-download/1.0'}
    if token:headers['Authorization']='Bearer '+token
    opener=urllib.request.build_opener(SafeRedirect)
    records=[]
    siblings=[s for s in info.siblings if not include or any(fnmatch.fnmatchcase(s.rfilename,p) for p in include)]
    if include and any(not any(fnmatch.fnmatchcase(s.rfilename,p) for s in siblings) for p in include):
        raise ValueError('Requested model file is absent from the official repository')
    total=sum(s.size or 0 for s in siblings)
    manifest=base/'verified-manifest.json'
    def save_manifest(status):
        prior=[]
        if manifest.exists():
            previous=json.loads(manifest.read_text('utf-8'))
            if previous.get('commit')==info.sha: prior=previous.get('files',[])
        merged={r['file']:r for r in prior+records}
        tmp=base/'verified-manifest.tmp'
        tmp.write_text(json.dumps({'repo':repo,'commit':info.sha,'status':status,'requested':include or ['*'],'files':list(merged.values())},indent=2),'utf-8')
        tmp.replace(manifest)
    print(json.dumps({'repo':repo,'commit':info.sha,'total_bytes':total,'workers':workers}),flush=True)
    for s in siblings:
        filename=s.rfilename
        if not s.lfs:
            p=hf_hub_download(repo,filename,revision=info.sha,cache_dir=str(cache))
            records.append({'file':filename,'size':s.size,'verified':'HF git object','path':p});continue
        expected=s.lfs.sha256;size=s.size;dest=blobs/expected
        if dest.exists() and dest.stat().st_size==size and digest(dest)==expected:
            print('已校验 '+filename,flush=True)
        else:
            staging=cache/'verified_chunks'/expected;staging.mkdir(parents=True,exist_ok=True)
            count=(size+chunk_size-1)//chunk_size
            # Reuse only full chunks of a stopped HF download. The final file hash
            # remains authoritative; no partial prefix is considered verified.
            prefixes=sorted(blobs.glob(expected+'*.incomplete'),key=lambda p:p.stat().st_size,reverse=True)
            if prefixes:
                prefix=prefixes[0]
                with prefix.open('rb') as inp:
                    for i in range(min(count,prefix.stat().st_size//chunk_size)):
                        part=staging/str(i)
                        if part.exists() and part.stat().st_size==chunk_size:inp.seek(chunk_size,1);continue
                        part.write_bytes(inp.read(chunk_size))
            url=hf_hub_url(repo,filename,revision=info.sha)
            def part(i):
                target=staging/str(i);start=i*chunk_size;end=min(size,start+chunk_size)-1;length=end-start+1
                if target.exists() and target.stat().st_size==length:return length
                last=None
                for attempt in range(6):
                    try:
                        req=urllib.request.Request(url,headers=dict(headers,Range=f'bytes={start}-{end}'))
                        with opener.open(req,timeout=90) as response:
                            content_range=response.headers.get('Content-Range','')
                            if response.status!=206 or not content_range.startswith(f'bytes {start}-{end}/'):
                                raise ValueError('Server did not honor the requested byte range')
                            data=response.read(length+1)
                            if len(data)!=length:raise ValueError('Incomplete range')
                        tmp=staging/(str(i)+'.tmp');tmp.write_bytes(data);tmp.replace(target);return length
                    except (OSError,ValueError) as e:
                        last=e
                        if isinstance(e,urllib.error.HTTPError) and e.code in (401,403):
                            raise RuntimeError('访问被拒绝：请在自己的 HF 账号获准后登录；不会绕过授权') from None
                        time.sleep(min(30,2**attempt))
                raise RuntimeError(f'下载分块 {i} 失败：{type(last).__name__}')
            print(f'下载 {filename}，{size/2**30:.2f} GiB，可复用分块 {sum(1 for p in staging.iterdir() if p.name.isdigit())}/{count}',flush=True)
            complete=0;done_bytes=0;started=time.monotonic()
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures=[pool.submit(part,i) for i in range(count)]
                for future in as_completed(futures):
                    done_bytes+=future.result();complete+=1
                    if complete%16==0 or complete==count:
                        print(json.dumps({'file':filename,'chunks':complete,'of':count,'bytes_ready':done_bytes,'seconds':round(time.monotonic()-started)}),flush=True)
            tmp=blobs/(expected+'.verified.tmp')
            with tmp.open('wb') as out:
                for i in range(count):
                    with (staging/str(i)).open('rb') as inp:shutil.copyfileobj(inp,out,8*1024*1024)
                out.flush();os.fsync(out.fileno())
            if tmp.stat().st_size!=size or digest(tmp)!=expected:
                raise RuntimeError('SHA-256 不匹配；保留分块供排障，拒绝登记为完整模型：'+filename)
            tmp.replace(dest)
            print('SHA-256 通过 '+filename,flush=True)
        link=snapshot/filename;link.parent.mkdir(parents=True,exist_ok=True)
        if not link.exists():link.symlink_to(os.path.relpath(dest,link.parent))
        records.append({'file':filename,'size':size,'sha256':expected,'verified':True,'path':str(link)})
        save_manifest('downloading')
    (base/'refs').mkdir(exist_ok=True);(base/'refs/main').write_text(info.sha,'utf-8')
    save_manifest('complete')
    print(json.dumps({'repo':repo,'status':'complete','files':len(records),'bytes':total,'snapshot':str(snapshot)}),flush=True)
    return snapshot


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--repo',default='microsoft/TRELLIS.2-4B');p.add_argument('--cache',type=Path,default=Path('/data/models/hf/hub'));p.add_argument('--workers',type=int,default=16);p.add_argument('--chunk-mb',type=int,default=8);p.add_argument('--include',action='append',help='Exact file or glob; repeat for multiple files')
    a=p.parse_args();download(a.repo,a.cache,min(32,max(1,a.workers)),max(1,a.chunk_mb)*1024*1024,a.include)
