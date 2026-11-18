"""Verify the public release version and published GLB bytes; never prints credentials."""
import argparse
import hashlib
import json
import urllib.request
from pathlib import Path


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--base',default='https://space.migucomi.com');a=ap.parse_args();base=a.base.rstrip('/')
    version = (Path(__file__).resolve().parents[1] / 'VERSION').read_text().strip()
    def get(path):
        with urllib.request.urlopen(base+path,timeout=30) as r:return r.read()
    health=json.loads(get('/healthz'));assert health['version']==version,f"Expected {version}, got {health.get('version')}"
    catalog=json.loads(get('/showcase/catalog'));assert catalog['version']==version
    for item in catalog['files']:
        assert '/' not in item['name'] and '\\' not in item['name']
        data=get('/showcase/assets/'+item['name'])
        assert len(data)==item['bytes'] and hashlib.sha256(data).hexdigest()==item['sha256'],item['name']
    print(json.dumps({'base':base,'version':health['version'],'published_files_verified':len(catalog['files']),'status':'pass'}))


if __name__=='__main__':main()
