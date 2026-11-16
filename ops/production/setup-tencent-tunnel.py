"""Prepare a dedicated SSH reverse tunnel; never disables host-key verification.

This prepares local files only. The remote operator must install the public key
on the specified Tencent host before the tunnel can be started.
"""
import argparse
import os
from pathlib import Path
import subprocess


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--known-hosts',type=Path,required=True)
    p.add_argument('--data',type=Path,default=Path('/data/scw-production'))
    p.add_argument('--host',default='43.161.232.185')
    p.add_argument('--install-service',action='store_true')
    a=p.parse_args()
    if not a.host or any(c not in '0123456789.' for c in a.host):raise ValueError('Expected the verified server IPv4 address')
    pinned=[line for line in a.known_hosts.read_text().splitlines() if line.startswith(a.host+' ssh-ed25519 ')]
    if len(pinned)!=1:raise ValueError('Expected exactly one previously verified server ed25519 host key')
    os.umask(0o077)
    folder=a.data.resolve()/'ssh';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    key=folder/'space_tunnel_ed25519'
    if not key.exists():subprocess.run(['ssh-keygen','-q','-t','ed25519','-f',str(key),'-N','','-C','scw-space-tunnel'],check=True)
    key.chmod(0o600)
    (folder/'known_hosts').write_text(pinned[0]+'\n')
    config=folder/'space.conf'
    config.write_text(f'''Host scw-space-gateway
    HostName {a.host}
    User scw-tunnel
    Port 22
    IdentityFile {key}
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    UserKnownHostsFile {folder/'known_hosts'}
    BatchMode yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    RequestTTY no
    ServerAliveInterval 15
    ServerAliveCountMax 3
    ExitOnForwardFailure yes
    RemoteForward 127.0.0.1:18780 127.0.0.1:8780
''')
    if a.install_service:
        unit=Path('/etc/systemd/system/scw-space-tunnel.service')
        if unit.exists() and 'Managed by SCW real pipeline' not in unit.read_text():raise RuntimeError('A different service owns this name')
        unit.write_text(f'''# Managed by SCW real pipeline
[Unit]
Description=SCW space.migucomi.com reverse tunnel
After=network-online.target scw-real-platform.service
Wants=network-online.target scw-real-platform.service
[Service]
Type=simple
ExecStart=/usr/bin/ssh -N -T -F {config} scw-space-gateway
Restart=always
RestartSec=10
TimeoutStopSec=10
[Install]
WantedBy=multi-user.target
''')
        subprocess.run(['systemctl','daemon-reload'],check=True)
    print('Prepared local tunnel configuration: '+str(config))
    print('Public key file for remote setup: '+str(key)+'.pub')
    print('Service is not started until the remote key and forwarding restrictions are verified.')


if __name__=='__main__':main()
