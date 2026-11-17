"""Production contracts. These tests never count generated fixtures as AI inference."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from server.engine_host import EngineHost, BizError
from server.files import Files

ROOT=Path(__file__).resolve().parent.parent


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv('SCW_MODE','production')
    import server.app as app
    from server.production import Runtime
    monkeypatch.setattr(app,'DATA',tmp_path)
    monkeypatch.setattr(Runtime,'start',lambda self:None)
    # Contract/CPU fixtures inject no model inference; readiness is tested separately.
    monkeypatch.setattr(Runtime,'require_ready',lambda self,*a,**kw:None)
    with TestClient(app.app) as client:
        yield client, app


def login(client, user='u_admin', ws='real-test'):
    r=client.post('/api/v1/auth/login',json=dict(user_id=user,password='demo-2026',workspace=ws))
    assert r.status_code==200,r.text
    return {'Authorization':'Bearer '+r.json()['token']}


def test_production_has_no_seeded_assets_and_cannot_fastforward(api):
    client,app=api;h=login(client)
    s=client.get('/api/v1/state',headers=h).json()
    assert s['runtime']['mode']=='production'
    assert not s['assets'] and not s['tasks'] and not s['licenses']
    assert s['release']=='V1.0'
    assert s['settings']['presets']['hero']['tris']==60000
    for fn,args in [('enqueue',[{'node':'image_to_3d'}]),('reset',[]),('patch',['asset','x','status','library']),('audit',[])]:
        assert client.post('/api/v1/rpc',headers=h,json={'fn':fn,'args':args}).status_code==403


def test_published_showcase_is_real_and_separate_from_workspace_files(api):
    import hashlib
    client,app=api
    catalog=client.get('/showcase/catalog').json()
    assert catalog['version']=='1.1.0' and catalog['sample_kind']=='actual_artifact'
    assert {v['id'] for v in catalog['variants']}=={'hero','webxr'}
    for entry in catalog['files']:
        response=client.get('/showcase/assets/'+entry['name'])
        assert response.status_code==200
        assert len(response.content)==entry['bytes']
        assert hashlib.sha256(response.content).hexdigest()==entry['sha256']
    assert client.get('/api/v1/state').status_code==401
    assert client.get('/showcase/assets/runtime.env').status_code==404
    assert '真实成果' in client.get('/showcase').text


def test_quality_profile_migration_keeps_old_presets_and_files(api):
    client,app=api;login(client);host=app.H()
    before=json.loads(host.state('real-test'))
    host.query('real-test','u_admin',None,"(delete E.S.settings.presets.hero, E.ensureQualityProfiles(E.S), true)")
    after=json.loads(host.state('real-test'))
    assert after['settings']['presets']['webxr']==before['settings']['presets']['webxr']
    assert after['assets']==before['assets']
    assert after['settings']['presets']['hero']['tex']==2048


def test_real_upload_is_workspace_scoped_and_byte_preserving(api):
    client,app=api;h=login(client)
    b=io.BytesIO();Image.new('RGB',(32,32),'red').save(b,format='PNG');data=b.getvalue()
    r=client.post('/api/v1/files',headers=h,files={'file':('ref.png',data,'image/png')})
    assert r.status_code==200,r.text
    file=r.json();assert client.get(file['url'],headers=h).content==data
    other=login(client,ws='other')
    assert client.get(file['url'],headers=other).status_code==404
    assert client.post('/api/v1/files',headers=h,files={'file':('bad.png',b'not an image','image/png')}).status_code==400
    app.runtime.files.path('real-test',file['file_id']).write_bytes(b'changed')
    with pytest.raises(ValueError):app.runtime.files.verify('real-test',file['file_id'])
    assert client.post('/api/v1/auth/logout').status_code==200
    assert client.get('/api/v1/state').status_code==401


def test_https_session_cookie_is_secure_and_local_http_still_works(api):
    client,app=api
    body={'user_id':'u_admin','password':'demo-2026','workspace':'real-test'}
    local=client.post('/api/v1/auth/login',json=body)
    assert local.status_code==200 and '; Secure' not in local.headers['set-cookie']
    cloud=client.post('https://testserver/api/v1/auth/login',json=body)
    assert cloud.status_code==200 and '; Secure' in cloud.headers['set-cookie']


def test_unsupported_gpu_power_does_not_discard_memory_metrics(api,monkeypatch):
    client,app=api
    monkeypatch.setattr('subprocess.check_output',lambda *a,**kw:'3072, 24564, 7, 47, [N/A]\n')
    gpu=app.runtime.metrics()['gpu']
    assert gpu['vram']==3 and gpu['total']>23
    assert gpu['util']==7 and gpu['power'] is None


def test_reviewer_cannot_cancel_job_and_client_cannot_inject_fields(api):
    client,app=api;admin=login(client)
    req={'title':'道具','is_heritage':False,'platforms':['quest3'],'quantity':1}
    j=client.post('/api/v1/jobs',headers=admin,json=req).json()
    reviewer=login(client,'u_rev')
    r=client.post('/api/v1/rpc',headers=reviewer,json={'fn':'cancelJob','args':[j['id']]})
    assert r.status_code==403,r.text
    assert client.post('/api/v1/jobs',headers=admin,json=dict(req,status='done')).status_code==400
    r=client.post('/api/v1/rpc',headers=admin,json={'fn':'updateJob','args':[j['id'],{'id':'injected'}]})
    assert r.status_code==400


def test_real_task_does_not_complete_on_clock_and_oom_has_one_retry(api):
    client,app=api;h=login(client)
    j=client.post('/api/v1/jobs',headers=h,json={'title':'道具','is_heritage':False,'platforms':['quest3'],'quantity':1}).json()
    r=client.post(f"/api/v1/jobs/{j['id']}/submit",headers=h);assert r.status_code==200,r.text
    host=app.H();state=json.loads(host.state('real-test'));t=state['tasks'][0]
    host.tick(1000000);assert json.loads(host.state('real-test'))['tasks'][0]['status']=='queued'
    host.call('real-test','u_admin',None,'productionClaim',[t['id']])
    host.call('real-test','u_admin',None,'productionFail',[t['id'],'network',False])
    host.call('real-test','u_admin',None,'productionClaim',[t['id']])
    host.call('real-test','u_admin',None,'productionFail',[t['id'],'network',False])
    assert json.loads(host.state('real-test'))['tasks'][0]['status']=='failed'


def test_production_state_saved_on_each_write_and_mode_mismatch_fails(api, tmp_path):
    client,app=api;h=login(client)
    client.post('/api/v1/jobs',headers=h,json={'title':'断电恢复','is_heritage':False,'platforms':['quest3']})
    data=json.loads((app.DATA/'workspaces/real-test.json').read_text('utf-8'))
    assert data['jobs'][0]['title']=='断电恢复'
    demo_data=tmp_path/'demo-mode'
    with pytest.MonkeyPatch.context() as env:
        env.setenv('SCW_MODE','demo')
        demo=EngineHost(ROOT/'dist',demo_data)
        demo.ensure('demo');demo.stop()
    original=(demo_data/'workspaces/demo.json').read_bytes()
    with pytest.raises(RuntimeError,match='恢复失败'):
        EngineHost(ROOT/'dist',demo_data)
    assert (demo_data/'workspaces/demo.json').read_bytes()==original


def test_quantity_100_is_not_capped_at_48_concepts(api):
    client,app=api;h=login(client)
    job=client.post('/api/v1/jobs',headers=h,json={'title':'100 件排程测试','is_heritage':False,'platforms':['webxr'],'quantity':100}).json()
    r=client.post(f"/api/v1/jobs/{job['id']}/submit",headers=h)
    assert r.status_code==200,r.text
    state=json.loads(app.H().state('real-test'))
    tasks=[t for t in state['tasks'] if t['job_id']==job['id']]
    assert sum(t['params']['batch'] for t in tasks)>=100


def test_missing_models_block_submission_without_spending_retries(tmp_path,monkeypatch):
    monkeypatch.setenv('SCW_MODE','production');monkeypatch.setenv('HF_HOME',str(tmp_path/'empty-models'))
    import server.app as app
    from server.production import Runtime
    monkeypatch.setattr(app,'DATA',tmp_path)
    monkeypatch.setattr(Runtime,'start',lambda self:None)
    with TestClient(app.app) as client:
        h=login(client)
        response=client.post('/api/v1/jobs',headers=h,json={'title':'未就绪检查','is_heritage':False,'platforms':['webxr'],'quantity':1})
        assert response.status_code==200,response.text
        job=response.json()
        report=client.get('/api/v1/system/engines',headers=h).json()
        assert not report['ready'] and not report['engines']['image_to_3d']['ready']
        r=client.post(f"/api/v1/jobs/{job['id']}/submit",headers=h)
        assert r.status_code==409 and '权重' in r.json()['detail']
        state=client.get('/api/v1/state',headers=h).json()
        assert state['jobs'][0]['status']=='draft' and not state['tasks']


@pytest.mark.skipif(os.name=='nt',reason='Production process groups run on Linux/WSL')
def test_cancel_really_terminates_the_worker_process(api,tmp_path):
    """A controlled sleeping child tests cancellation, never AI inference."""
    from server.production import Cancelled
    client,app=api;h=login(client);rt=app.runtime
    job=client.post('/api/v1/jobs',headers=h,json={'title':'取消进程测试','is_heritage':False,'platforms':['webxr'],'quantity':1}).json()
    client.post(f"/api/v1/jobs/{job['id']}/submit",headers=h)
    task=json.loads(app.H().state('real-test'))['tasks'][0]
    rt.event('real-test','productionClaim',task['id'])
    with ThreadPoolExecutor(max_workers=1) as pool:
        future=pool.submit(rt.command,'real-test',task,[sys.executable,'-c',"import os,time;print(os.getpid(),flush=True);time.sleep(60)"],tmp_path)
        deadline=time.monotonic()+8
        pid=None
        while time.monotonic()<deadline:
            logs=list(tmp_path.glob('process-*.log'))
            if logs and logs[0].read_text().strip():pid=int(logs[0].read_text().strip());break
            time.sleep(.05)
        try:
            assert pid is not None,'Controlled child did not start'
        finally:
            response=client.post(f"/api/v1/tasks/{task['id']}/cancel",headers=h)
            assert response.status_code==200,response.text
        with pytest.raises(Cancelled):future.result(timeout=8)
        with pytest.raises(ProcessLookupError):os.kill(pid,0)


@pytest.mark.skipif(not os.getenv('SCW_BPY_PYTHON'),reason='requires actual Blender bpy')
@pytest.mark.parametrize('open_surface,target,texture',[(False,5000,256),(True,5000,256),(False,60000,2048)])
def test_mesh_processing_and_qa_use_real_glb(tmp_path,open_surface,target,texture):
    script=ROOT/'tests/fixtures/create_mesh.py';py=os.environ['SCW_BPY_PYTHON']
    source=tmp_path/'source.glb'
    r=subprocess.run([py,str(script),str(source)]+(['--open-sheet'] if open_surface else []),capture_output=True,text=True,timeout=120)
    assert r.returncode==0,r.stdout+r.stderr
    request={'input':str(source),'output':str(tmp_path/'low.glb'),'blend':str(tmp_path/'low.blend'),'report':str(tmp_path/'report.json'),'operation':'optimize','preset':{'tris':target,'tex':texture,'materials':1},'mark':{'generated':True,'model':'TEST FIXTURE','seed':1,'time':'2026-11-16T00:00:00Z'}}
    req=tmp_path/'request.json';req.write_text(json.dumps(request),'utf-8')
    r=subprocess.run([py,str(ROOT/'ops/production/mesh_pipeline.py'),str(req)],capture_output=True,text=True,timeout=240)
    assert r.returncode==0,(r.stdout+r.stderr)[-8000:]
    result=json.loads((tmp_path/'report.json').read_text('utf-8'))
    assert result['stats']['tris']<=target
    assert result['stats']['texture']==texture and result['stats']['materials']==1
    assert result['stats']['origin_offset_m']<.005
    assert result['stats']['nonmanifold']==0
    assert result['mark_valid']
    assert 'QuadriFlow 已实际生成新拓扑' in r.stdout
    assert (tmp_path/'low.blend').stat().st_size>0
    assert [i['rule'] for i in result['items']]==['Q01','Q02','Q03','Q04','Q05','Q06','Q07']


@pytest.mark.skipif(not os.getenv('SCW_BPY_PYTHON'),reason='requires actual Blender bpy')
def test_mesh_fix_removes_isolated_open_fragment_without_changing_main_surface(tmp_path):
    py=os.environ['SCW_BPY_PYTHON'];source=tmp_path/'source.glb'
    made=subprocess.run([py,str(ROOT/'tests/fixtures/create_mesh.py'),str(source),'--open-fragment'],capture_output=True,text=True,timeout=120)
    assert made.returncode==0,made.stdout+made.stderr
    request={'input':str(source),'output':str(tmp_path/'fixed.glb'),'blend':str(tmp_path/'fixed.blend'),'report':str(tmp_path/'fixed.json'),'operation':'fix','preset':{'tris':20000,'tex':256,'materials':1}}
    req=tmp_path/'request.json';req.write_text(json.dumps(request),'utf-8')
    fixed=subprocess.run([py,str(ROOT/'ops/production/mesh_pipeline.py'),str(req)],capture_output=True,text=True,timeout=120)
    assert fixed.returncode==0,(fixed.stdout+fixed.stderr)[-4000:]
    result=json.loads((tmp_path/'fixed.json').read_text('utf-8'))
    assert result['stats']['nonmanifold']==0
    assert result['stats']['flipped']==0
    assert result['stats']['size_m']==[1.0,1.0,1.0]
    assert '已移除 1 个小型孤立开放碎面' in fixed.stdout


@pytest.mark.skipif(not os.getenv('SCW_BPY_PYTHON') or not os.getenv('SCW_KTX_BIN'),reason='requires Blender and KTX tools')
def test_actual_file_review_library_and_compressed_delivery(api, tmp_path):
    """Exercise the complete file-processing half with an explicitly marked test fixture.

    AI inference is not replaced or credited: only trusted internal completion hooks
    seed the fixture. Every downstream subprocess, measurement and ZIP is real.
    """
    import zipfile
    client,app=api;h=login(client);host=app.H();rt=app.runtime;ws='real-test'
    job=client.post('/api/v1/jobs',headers=h,json={'title':'CPU fixture only','is_heritage':False,'platforms':['webxr'],'quantity':1}).json()
    client.post(f"/api/v1/jobs/{job['id']}/submit",headers=h)
    s=lambda:json.loads(host.state(ws))
    invoke=lambda fn,*args:host.call(ws,'u_admin',None,fn,list(args))
    concept=s()['tasks'][0]
    b=io.BytesIO();Image.new('RGB',(32,32),'red').save(b,format='PNG')
    f=rt.files.put(ws,'test-fixture.png',b.getvalue(),'image/png')
    invoke('productionClaim',concept['id'])
    invoke('productionComplete',concept['id'],{'images':[dict(file_id=f['file_id'],url=f['url'])],'license_chain':[]})
    c=s()['concepts'][0]
    tasks=invoke('selectConcepts',[c['id']],{})
    gen=tasks[0];invoke('productionClaim',gen['id'])
    source=tmp_path/'fixture.glb'
    r=subprocess.run([os.environ['SCW_BPY_PYTHON'],str(ROOT/'tests/fixtures/create_mesh.py'),str(source)],capture_output=True,text=True,timeout=120)
    assert r.returncode==0,r.stdout+r.stderr
    folder=tmp_path/'inspect';folder.mkdir()
    mark={'generated':True,'model':'TEST FIXTURE NOT AI INFERENCE','seed':1,'time':'2026-11-16T00:00:00Z'}
    measured=rt.mesh(ws,gen,folder,source,'inspect',s()['settings']['presets']['webxr'],mark)
    invoke('productionComplete',gen['id'],dict(stats=measured['stats'],file=rt.file_result(ws,folder/'mesh.glb'),aigc_mark=mark))
    for node in ['mesh_optimize','auto_qa']:
        task=next(t for t in s()['tasks'] if t['node']==node and t['status']=='queued')
        invoke('productionClaim',task['id']);rt.execute(ws,task)
        state=s();done=next(t for t in state['tasks'] if t['id']==task['id'])
        assert done['status']=='done',done.get('error')
    state=s();asset=state['assets'][0];v=next(v for v in state['versions'] if v['id']==asset['current_version'])
    assert len(set(asset['versions']))==len(asset['versions'])==2
    assert asset['status']=='review'
    qa=next(q for q in state['qa'] if q['id']==v['qa_id'])
    assert len(qa['items'])==9 and qa['passed'],qa
    reviewer=login(client,'u_rev')
    r=client.post(f"/api/v1/qa/{v['id']}/review",headers=reviewer,json={'decision':'pass'})
    assert r.status_code==200,r.text
    assert s()['assets'][0]['status']=='library'
    r=client.post('/api/v1/exports',headers=h,json={'object_type':'assets','asset_ids':[asset['id']],'targets':['webxr','raw'],'settings':{'texCompress':'KTX2','meshCompress':'Draco','aigcVisible':True},'deviceTested':False})
    assert r.status_code==200,r.text
    ex=r.json();task=next(t for t in s()['tasks'] if t['node']=='export')
    invoke('productionClaim',task['id']);rt.execute(ws,task)
    state=s();export=state['exports'][0]
    assert export['status']=='done',state['tasks'][0].get('error')
    response=client.get(export['download_url'],headers=h);assert response.status_code==200
    with zipfile.ZipFile(io.BytesIO(response.content)) as z:
        manifest=json.loads(z.read('manifest.json'))
        assert manifest['production'] is True
        assert manifest['device_tested'] is False
        assert manifest['assets'][0]['source_sha256']==v['file_sha256']
        assert 'index.html' in z.namelist()
        assert any(n.endswith('.blend') for n in z.namelist())
        assert 'vendor/three/draco/draco_decoder.wasm' in z.namelist()
        data=z.read(manifest['assets'][0]['file']);length=int.from_bytes(data[12:16],'little');doc=json.loads(data[20:20+length])
        assert {'KHR_draco_mesh_compression','KHR_texture_basisu'}<=set(doc['extensionsRequired'])

    # A license revoked after enqueue must still block delivery at execution time.
    body={'object_type':'assets','asset_ids':[asset['id']],'targets':['webxr'],'settings':{'texCompress':'KTX2','meshCompress':'Draco','aigcVisible':True},'deviceTested':False}
    pending=client.post('/api/v1/exports',headers=h,json=body)
    assert pending.status_code==200,pending.text
    ex2=pending.json();task=next(t for t in s()['tasks'] if t.get('export_id')==ex2['id'])
    invoke('updateModel','trellis2-4b',{'allowed_scope':'disabled'})
    invoke('productionClaim',task['id']);rt.execute(ws,task)
    denied=next(t for t in s()['tasks'] if t['id']==task['id'])
    assert denied['status']!='done' and '许可链' in denied['error']
    assert not next(e for e in s()['exports'] if e['id']==ex2['id']).get('file_id')
