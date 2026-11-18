"""Upgrade the identified existing demo container; preserve the old container for rollback.

Run on the Tencent host: python3 deploy/tencent/update_existing_demo.py --apply
Without --apply this only reports candidate containers and makes no changes.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


def docker(*args):
    return subprocess.check_output(['docker',*args],text=True).strip()


def info(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/v1/info',timeout=5) as r:return json.load(r)


def wait_ready(port, version):
    for _ in range(40):
        try:
            data=info(port)
            if data['version']==version:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/showcase/catalog',timeout=8) as r:catalog=json.load(r)
                assert catalog['version']==version and len(catalog['variants'])==2
                return
        except (OSError,ValueError,AssertionError):pass
        time.sleep(.5)
    raise RuntimeError('New instance did not pass version and showcase checks')


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--apply',action='store_true');ap.add_argument('--container');ap.add_argument('--preview-port',type=int,default=18781);a=ap.parse_args()
    candidates=[]
    for cid in docker('ps','-q').splitlines():
        item=json.loads(docker('inspect',cid))[0]
        for key,bindings in (item['NetworkSettings'].get('Ports') or {}).items():
            if key!='8000/tcp' or not bindings:continue
            port=int(bindings[0]['HostPort'])
            try:
                data=info(port)
                if data.get('name','').startswith('空间内容工场'):candidates.append((item,port))
            except OSError:pass
    if a.container:candidates=[x for x in candidates if a.container in (x[0]['Id'],x[0]['Name'].lstrip('/'))]
    print(json.dumps([{'container':c['Name'],'image':c['Config']['Image'],'port':p} for c,p in candidates],ensure_ascii=False))
    if not a.apply:return
    if len(candidates)!=1:raise RuntimeError('Exactly one verified SCW container is required; use --container NAME')
    old,port=candidates[0];oldid=old['Id'];env=dict(e.split('=',1) for e in old['Config'].get('Env',[]) if '=' in e)
    if env.get('SCW_MODE','demo')!='demo':raise RuntimeError('This updater only supports the demo instance, not the GPU production node')
    if env.get('SCW_DATA','/data')!='/data':raise RuntimeError('Nonstandard data directory needs explicit deployment review')
    if any(m['Destination']!='/data' for m in old.get('Mounts',[])):raise RuntimeError('Extra mounts require explicit deployment review; nothing was changed')
    network=old['HostConfig'].get('NetworkMode','default')
    aliases=[]
    if network not in ('default','bridge'):
        net=json.loads(docker('network','inspect',network))[0]
        if net.get('Driver')!='bridge':raise RuntimeError('Only isolated bridge networks are supported; nothing was changed')
        aliases=old['NetworkSettings'].get('Networks',{}).get(network,{}).get('Aliases') or []
    if any('\n' in v or '\r' in v for v in env.values()):raise RuntimeError('Multiline environment values require explicit deployment review')
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S');root=Path('/opt/scw-upgrades')/stamp
    root.mkdir(parents=True,mode=0o700);os.chmod(root,0o700)
    (root/'previous-container.json').write_text(json.dumps(old));os.chmod(root/'previous-container.json',0o600)
    env['SCW_MODE']='demo'
    envfile=root/'runtime.env';envfile.write_text('\n'.join(k+'='+v for k,v in env.items())+'\n');os.chmod(envfile,0o600)
    code=Path(__file__).resolve().parents[2]
    version = (code / 'VERSION').read_text().strip()
    image=f'spatial-content-works:{version}-{stamp}'
    subprocess.run(['docker','build','-t',image,str(code)],check=True)
    preview='scw-preview-'+stamp;final='scw-v110-'+stamp;switched=False;stopped=False;created=False
    def create(name,folder,bindings):
        args=['create','--name',name,'--restart','unless-stopped','--env-file',str(envfile),'--mount',f'type=bind,src={folder},dst=/data']
        if network not in ('default','bridge'):args+=['--network',network]
        if name==final:
            for alias in aliases:args+=['--network-alias',alias]
        for binding in bindings:args+=['-p',binding]
        args+=[image];docker(*args)
    try:
        # Preview a copy so migrations cannot touch the live data.
        previewdata=root/'preview-data';docker('cp',oldid+':/data',str(previewdata))
        create(preview,previewdata,[f'127.0.0.1:{a.preview_port}:8000']);docker('start',preview);wait_ready(a.preview_port, version)
        docker('stop',preview)
        # Stop before the final copy, producing a consistent backup and leaving old data untouched.
        docker('stop',oldid);stopped=True
        data=root/'data';docker('cp',oldid+':/data',str(data))
        ports=old['HostConfig'].get('PortBindings') or {}
        bindings=[]
        for container_port,values in ports.items():
            if container_port!='8000/tcp':raise RuntimeError('Extra exposed ports require explicit review')
            for value in values or []:
                ip=value.get('HostIp') or '0.0.0.0'
                if ':' in ip:ip='['+ip+']'
                bindings.append(f"{ip}:{value['HostPort']}:8000")
        create(final,data,bindings);created=True;docker('start',final);wait_ready(port, version);switched=True
        rollback=root/'rollback.sh';rollback.write_text('#!/bin/sh\nset -eu\ndocker stop '+final+'\ndocker start '+oldid+'\n');os.chmod(rollback,0o700)
        print(json.dumps({'version':version,'container':final,'rollback':str(rollback),'domain_verification':'Run tools/verify_public_demo.py after the switch'}))
    finally:
        subprocess.run(['docker','stop',preview],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if stopped and not switched:
            if created:
                subprocess.run(['docker','stop',final],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            docker('start',oldid)


if __name__=='__main__':main()
