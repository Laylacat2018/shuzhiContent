"""M0 交付包的可离线验证部分（不需要 GPU）。Blender 用例需设置 SCW_BPY_PYTHON 指向装有 bpy 的 Python。"""
import json, os, pathlib, subprocess, sys
import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
M0 = ROOT / 'ops' / 'm0'


def test_comfy_workflow_structure():
    r = subprocess.run([sys.executable, str(M0 / 'samples' / 'comfy_qwen_image.py'), '--dry-run', '--seed', '1', '--size', '1024'], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    wf = json.loads(r.stdout)
    types = {n['class_type'] for n in wf.values()}
    assert types == {'UNETLoader', 'CLIPLoader', 'VAELoader', 'ModelSamplingAuraFlow', 'CLIPTextEncode', 'EmptySD3LatentImage', 'KSampler', 'VAEDecode', 'SaveImage'}
    assert wf['2']['inputs']['type'] == 'qwen_image' and wf['4']['inputs']['shift'] == 3.1
    ks = wf['8']['inputs']
    assert (ks['steps'], ks['cfg'], ks['sampler_name'], ks['scheduler']) == (20, 4.0, 'euler', 'simple')
    for node in wf.values():  # 所有引用指向存在的节点
        for v in node['inputs'].values():
            if isinstance(v, list):
                assert v[0] in wf


def test_check_env_runs(tmp_path):
    r = subprocess.run([sys.executable, str(M0 / 'check_env.py'), '--data', str(tmp_path), '--out', str(tmp_path), '--no-net'], capture_output=True, text=True, timeout=120)
    rep = json.loads((tmp_path / 'env_report.json').read_text('utf-8'))
    assert rep['verdict'] in ('PASS', 'WARN', 'FAIL')
    names = {i['name'] for i in rep['items']}
    assert {'操作系统', '内存', 'Docker'} <= names
    assert (r.returncode == 0) == (rep['verdict'] != 'FAIL')


@pytest.mark.skipif(not os.environ.get('SCW_BPY_PYTHON'), reason='需要 Blender bpy（设置 SCW_BPY_PYTHON）')
def test_blender_optimize(tmp_path):
    raw = tmp_path / 'raw.glb'
    subprocess.run(['node', '-e', f"""require('{ROOT}/web/src/geometry.js'); const G=globalThis.Geo;
      (async()=>{{ const m=G.buildMesh({{category:'lantern',seed:3,defects:{{origin:[0.03,0.05,0]}}}},120000);
      require('fs').writeFileSync('{raw}', await G.writeGLB([{{mesh:m,name:'x',category:'lantern',seed:3}}],{{texture:false}})); }})()"""], check=True)
    out = tmp_path / 'q3.glb'
    r = subprocess.run([os.environ['SCW_BPY_PYTHON'], str(M0 / 'samples' / 'blender_optimize.py'), '--in', str(raw), '--out', str(out), '--tris', '20000', '--draco'], capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    res = json.loads((tmp_path / 'q3.json').read_text('utf-8'))
    assert res['before']['tris'] > 100000 and res['after']['tris'] <= 20000
    assert res['after']['origin_offset_cm'] < 0.5 and res['before']['origin_offset_cm'] > 3
    v = subprocess.run(['node', str(ROOT / 'tests' / 'validate_gltf.js'), str(out)], capture_output=True, text=True)
    assert v.returncode == 0, v.stdout
