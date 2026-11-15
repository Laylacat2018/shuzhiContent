"""服务端模式验收：REST 接口（SPEC 7.1）、WebSocket 事件（7.2）、JWT 与权限、多人共享、持久化与重启恢复、前端服务端模式。"""
import json, os, pathlib, subprocess, sys, tempfile, time, urllib.request, urllib.error
import pytest
from playwright.sync_api import expect
from conftest import start_server

ROOT = pathlib.Path(__file__).resolve().parent.parent


def http(base, method, path, body=None, token=None, ok=True):
    r = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Content-Type': 'application/json'})
    if token:
        r.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')


def login(base, uid='u_pm', ws='t-api'):
    s, r = http(base, 'POST', '/api/v1/auth/login', {'user_id': uid, 'password': 'demo-2026', 'workspace': ws})
    assert s == 200, r
    return r['token']


def test_smoke_script(server):
    r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'smoke_test.py'), server, '--workspace', 'smoke'], capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stdout + r.stderr
    assert '冒烟测试通过' in r.stdout


def test_auth_and_permissions(server):
    s, _ = http(server, 'GET', '/api/v1/jobs')
    assert s == 401
    s, _ = http(server, 'POST', '/api/v1/auth/login', {'user_id': 'u_pm', 'password': 'wrong'})
    assert s == 401
    s, _ = http(server, 'GET', '/api/v1/jobs', token='a.b.c')
    assert s == 401
    rev = login(server, 'u_rev')
    s, r = http(server, 'POST', '/api/v1/jobs', {'title': 'x', 'platforms': ['quest3'], 'is_heritage': False}, token=rev)
    assert s == 403 and '无权' in r['detail']
    pm = login(server, 'u_pm')
    s, r = http(server, 'PUT', '/api/v1/models/trellis2-4b', {'allowed_scope': 'disabled'}, token=pm)
    assert s == 403
    s, r = http(server, 'POST', '/api/v1/rpc', {'fn': 'reset', 'args': []}, token=pm)
    assert s == 403
    s, r = http(server, 'POST', '/api/v1/rpc', {'fn': 'S', 'args': []}, token=pm)
    assert s == 400   # 非白名单操作


def test_rest_rules(server):
    pm, admin = login(server, 'u_pm', 't-rules'), login(server, 'u_admin', 't-rules')
    # 文物本体：生成类节点接口拒绝
    s, job = http(server, 'POST', '/api/v1/jobs', {'title': '文物', 'platforms': ['quest3'], 'is_heritage': True}, token=pm)
    assert s == 200 and job['content_type'] == 'recon'
    http(server, 'POST', f"/api/v1/jobs/{job['id']}/submit", token=pm)
    s, r = http(server, 'POST', '/api/v1/concepts/generate', {'job_id': job['id'], 'prompt': '玉琮', 'model_id': 'qwen-image-fp8'}, token=pm)
    assert s == 422 and '文物本体' in r['detail']
    # 许可证：禁用全部可商用 3D 模型后，对外商用需求单提交被拒，审计有记录
    for m in ['trellis2-4b', 'direct3d-s2', 'triposg', 'step1x-3d', 'hunyuan-api']:
        assert http(server, 'PUT', f'/api/v1/models/{m}', {'allowed_scope': 'disabled'}, token=admin)[0] == 200
    s, job = http(server, 'POST', '/api/v1/jobs', {'title': '许可', 'platforms': ['quest3'], 'is_heritage': False}, token=pm)
    s, pre = http(server, 'POST', f"/api/v1/jobs/{job['id']}/precheck", token=pm)
    assert pre['ok'] is False and any(x['model'] == 'TRELLIS.2-4B' for x in pre['excluded'])
    s, r = http(server, 'POST', f"/api/v1/jobs/{job['id']}/submit", token=pm)
    assert s == 422 and '提交被拒' in r['detail']
    # 未上传授权文件不能改为“全部项目”
    s, r = http(server, 'PUT', '/api/v1/models/hunyuan3d-21', {'allowed_scope': 'all'}, token=admin)
    assert s == 422 and '授权文件' in r['detail']
    s, lic = http(server, 'POST', '/api/v1/models/hunyuan3d-21/license', {'file_name': '混元授权.pdf'}, token=admin)
    assert s == 200
    # 资产 / 任务 / 系统接口
    for path in ['/api/v1/assets', '/api/v1/tasks?status=done', '/api/v1/models', '/api/v1/system/gpu', '/api/v1/system/disk', '/api/v1/system/cloud', '/api/v1/exports', '/api/v1/projects']:
        s, r = http(server, 'GET', path, token=pm)
        assert s == 200, path
    s, assets = http(server, 'GET', '/api/v1/assets?commercial_only=true', token=pm)
    assert assets and all(a['status'] in ('library', 'exported') for a in assets)
    s, a = http(server, 'GET', f"/api/v1/assets/{assets[0]['id']}", token=pm)
    assert a['current'] and 'license_chain' in a['current']
    s, vs = http(server, 'GET', f"/api/v1/assets/{assets[0]['id']}/versions", token=pm)
    assert s == 200 and len(vs) >= 1


def test_shared_state_and_ws_events(server, browser):
    """两位同事登录同一工作区：一人操作，另一人 2 秒内看到；WebSocket 推送 task.state。"""
    ws = 't-share'
    ctx_a = browser.new_context(viewport={'width': 1440, 'height': 900})
    ctx_b = browser.new_context(viewport={'width': 1440, 'height': 900})
    a, b = ctx_a.new_page(), ctx_b.new_page()
    for pg, idx in ((a, 1), (b, 3)):
        pg.goto(server + '/')
        pg.wait_for_selector('#login-btn')
        pg.click(f'.role-pick button:nth-child({idx})')
        pg.fill('#ws', ws)
        pg.click('#login-btn')
        pg.wait_for_selector('.shell')
    # 审核人页面订阅 WebSocket 事件
    token_b = b.evaluate("() => SCW.net.token")
    b.evaluate("""t => { window.__ev = []; const w = new WebSocket((location.protocol==='https:'?'wss://':'ws://') + location.host + '/ws/events?token=' + t); w.onmessage = m => window.__ev.push(JSON.parse(m.data)); window.__ws = w; }""", token_b)
    b.wait_for_function("() => window.__ws.readyState === 1")
    # 策划在界面上用向导新建并提交需求单（写操作经服务端执行）
    a.click('[data-route="jobs"]')
    a.click('#btn-new-job')
    a.fill('#job-title', '共享验证 · 宫灯 2 件')
    a.fill('#job-qty', '2')
    a.click('#btn-next'); a.check('#her-no'); a.click('#btn-next'); a.click('#btn-next'); a.click('#btn-next')
    a.click('#btn-submit-job')
    expect(a.locator('.toast').last).to_contain_text('已提交')
    t0 = time.time()
    b.wait_for_function("() => Engine.S.jobs && Engine.S.jobs.some(j => j.title === '共享验证 · 宫灯 2 件')", timeout=3000)
    assert time.time() - t0 <= 2.5
    b.wait_for_function("() => window.__ev.some(e => e.type === 'task.state')", timeout=4000)
    # 当前登录身份由令牌决定：审核人看到的是自己的角色
    assert b.evaluate("() => Engine.user().role") == 'reviewer'
    assert a.evaluate("() => Engine.user().role") == 'pm'
    # 审核人在服务端模式下审核（键盘快捷键 → 服务端执行）
    b.evaluate("() => SCW.go('review')")
    b.wait_for_selector('#btn-pass')
    aid = b.evaluate("() => Engine.S.assets.find(a => a.status === 'review' && a.type === 'prop' && !Engine.qaOf(Engine.cur(a)).items.some(i => i.result === 'fail')) ?.id")
    if aid:
        b.click(f'#review-list [data-id="{aid}"]')
        b.keyboard.press('a')
        a.wait_for_function(f"id => Engine.S.assets.find(x => x.id === id).status === 'library'", arg=aid, timeout=3000)
    errs = []
    ctx_a.close(); ctx_b.close()


def test_restart_recovery(tmp_path):
    """运行中重启：服务自动恢复工作区数据，运行中任务回到排队。"""
    port = 8797
    env = dict(os.environ, SCW_ALLOW_FASTFORWARD='1', SCW_DATA=str(tmp_path))
    p = start_server(port, env)
    base = f'http://127.0.0.1:{port}'
    try:
        art = login(base, 'u_art', 'recover')
        s, cs = http(base, 'GET', '/api/v1/concepts', token=art)
        cand = [c['id'] for c in cs if c['status'] == 'candidate'][:2]
        s, tasks = http(base, 'POST', '/api/v1/assets/generate3d', {'concept_ids': cand}, token=art)
        assert s == 200
        for _ in range(40):
            s, ts = http(base, 'GET', '/api/v1/tasks?status=running', token=art)
            if any(t['node'] == 'image_to_3d' for t in ts):
                break
            http(base, 'POST', '/api/v1/debug/fastforward', {'seconds': 10}, token=art)
        running = [t['id'] for t in ts if t['status'] == 'running']
        assert running
    finally:
        p.terminate(); p.wait(15)
    assert (tmp_path / 'workspaces' / 'recover.json').exists()
    p = start_server(port, env)
    try:
        art = login(base, 'u_art', 'recover')
        s, ts = http(base, 'GET', '/api/v1/tasks', token=art)
        by = {t['id']: t for t in ts}
        for tid in running:
            assert by[tid]['status'] in ('queued', 'running')
            assert any('服务重启' in l for l in by[tid]['log'])
        assert any(t['id'] in [x['id'] for x in tasks] for t in ts)  # 任务无丢失
    finally:
        p.terminate(); p.wait(15)


def test_server_mode_all_pages(server, browser):
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(server + '/')
    pg.wait_for_selector('#login-btn')
    pg.click('.role-pick button:nth-child(4)')
    pg.fill('#ws', 't-pages')
    pg.click('#login-btn')
    pg.wait_for_selector('.shell')
    for r in ['workbench', 'jobs', 'concepts', 'gen3d', 'optimize', 'scenes', 'recon', 'character', 'assembly', 'review', 'library', 'export', 'queue', 'system']:
        pg.click(f'[data-route="{r}"]')
        pg.wait_for_timeout(700)
        assert pg.locator('.toast.err').count() == 0, (r, pg.locator('.toast.err').all_inner_texts())
    # 服务端模式下的页面动作：P07 采集记录字段经服务端保存
    pg.click('[data-route="recon"]')
    pg.fill('#cap-collector', '服务端测试')
    pg.locator('#cap-collector').blur()
    pg.wait_for_timeout(1500)
    assert pg.evaluate("() => Engine.S.recon[0].capture_record.collector") == '服务端测试'
    # 刷新后仍保持登录与数据
    pg.reload(); pg.wait_for_selector('.shell')
    assert pg.evaluate("() => Engine.S.recon[0].capture_record.collector") == '服务端测试'
    assert not errs, errs
    ctx.close()
