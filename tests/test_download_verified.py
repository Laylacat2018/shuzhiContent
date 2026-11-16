import hashlib
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace

import pytest
from ops.m0.download_verified import download, SafeRedirect


def source(monkeypatch, payload=b'abcdefghijkl'):
    sha=hashlib.sha256(payload).hexdigest()
    sibling=SimpleNamespace(rfilename='weights.bin',size=len(payload),lfs=SimpleNamespace(sha256=sha))
    info=SimpleNamespace(sha='commit',siblings=[sibling]);calls=[]
    class Reply:
        def __init__(self,start,end):
            self.status=206;self.headers={'Content-Range':f'bytes {start}-{end}/{len(payload)}'};self.data=payload[start:end+1]
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def read(self,n):return self.data[:n]
    class Opener:
        def open(self,request,timeout):
            start,end=map(int,re.findall(r'\d+',request.get_header('Range')))
            calls.append((start,end));return Reply(start,end)
    monkeypatch.setitem(sys.modules,'huggingface_hub',SimpleNamespace(HfApi=lambda:SimpleNamespace(model_info=lambda *a,**kw:info),hf_hub_url=lambda *a,**kw:'https://huggingface.co/test',hf_hub_download=lambda *a,**kw:None,get_token=lambda:None))
    monkeypatch.setattr('urllib.request.build_opener',lambda *args:Opener())
    return sha,calls


def test_ranges_are_verified_before_hf_snapshot_is_registered(tmp_path,monkeypatch):
    sha,calls=source(monkeypatch)
    download('test/public',tmp_path,2,4)
    root=tmp_path/'models--test--public';f=root/'snapshots/commit/weights.bin'
    assert f.read_bytes()==b'abcdefghijkl'
    assert f.resolve()==root/'blobs'/sha
    assert len(calls)==3
    manifest=json.loads((root/'verified-manifest.json').read_text())
    assert manifest['status']=='complete' and len(manifest['files'])==1
    download('test/public',tmp_path,2,4)
    assert len(calls)==3


def test_existing_partial_prefix_is_resumed_and_whole_hash_checked(tmp_path,monkeypatch):
    sha,calls=source(monkeypatch)
    blobs=tmp_path/'models--test--public/blobs';blobs.mkdir(parents=True)
    (blobs/(sha+'.old.incomplete')).write_bytes(b'abcd')
    download('test/public',tmp_path,2,4)
    assert len(calls)==2 and (blobs/sha).read_bytes()==b'abcdefghijkl'


def test_corrupt_prefix_is_never_registered_as_complete(tmp_path,monkeypatch):
    sha,calls=source(monkeypatch)
    blobs=tmp_path/'models--test--public/blobs';blobs.mkdir(parents=True)
    (blobs/(sha+'.old.incomplete')).write_bytes(b'xxxx')
    with pytest.raises(RuntimeError,match='SHA-256'):
        download('test/public',tmp_path,2,4)
    assert not (blobs/sha).exists()
    assert not (tmp_path/'models--test--public/snapshots/commit/weights.bin').exists()


def test_missing_requested_dependency_fails_without_downloading(tmp_path,monkeypatch):
    _,calls=source(monkeypatch)
    with pytest.raises(ValueError,match='absent'):
        download('test/public',tmp_path,2,4,['missing.safetensors'])
    assert not calls
