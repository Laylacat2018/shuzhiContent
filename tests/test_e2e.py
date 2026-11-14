"""空间内容工场 · 端到端验收测试（Playwright + Chromium）

每个用例都是一个全新浏览器上下文（独立的演示数据）。
UI 关键路径用真实点击完成；等待模型执行时用 Engine.fastForward 快进模拟时钟。
"""
import io, json, pathlib, subprocess, zipfile, tempfile, re
import pytest
from playwright.sync_api import expect

ROOT = pathlib.Path(__file__).resolve().parent.parent
ROLES = {'pm': 1, 'artist': 2, 'reviewer': 3, 'admin': 4}


def login(pg, role='pm'):
    pg.click(f'.role-pick button:nth-child({ROLES[role]})')
    pg.click('#login-btn')
    pg.wait_for_selector('.shell')


def ev(pg, js, arg=None):
    return pg.evaluate(js, arg)


def ff(pg, sec):
    ev(pg, 's => { Engine.fastForward(s); SCW.st.rev++; }', sec)
    pg.wait_for_timeout(250)


def as_user(pg, role):
    uid = {'pm': 'u_pm', 'artist': 'u_art', 'reviewer': 'u_rev', 'admin': 'u_admin'}[role]
    pg.select_option('#user-switch', uid)
    pg.wait_for_timeout(150)


def nav(pg, route):
    pg.click(f'[data-route="{route}"]')
    pg.wait_for_timeout(400)


def no_errors(pg):
    errs = [e for e in pg.errors if 'favicon' not in e and 'GL Driver' not in e]
    assert not errs, errs


def validate_glb(paths):
    r = subprocess.run(['node', str(ROOT / 'tests' / 'validate_gltf.js'), *map(str, paths)], capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout or '[]')


# ---------------------------------------------------------------- 基础
def test_health(server):
    import urllib.request
    assert json.loads(urllib.request.urlopen(server + '/healthz').read())['status'] == 'ok'
    info = json.loads(urllib.request.urlopen(server + '/api/v1/info').read())
    assert info['pages'] == 14


def test_all_pages_render_without_errors(page):
    login(page, 'admin')
    for r in ['workbench', 'jobs', 'concepts', 'gen3d', 'optimize', 'scenes', 'recon', 'character', 'assembly', 'review', 'library', 'export', 'queue', 'system']:
        nav(page, r)
        page.wait_for_timeout(500)
        assert page.locator('.page-head h1').count() == 1, r
        assert page.locator('.toast.err').count() == 0, (r, page.locator('.toast.err').all_inner_texts())
    no_errors(page)


# ---------------------------------------------------------------- UC-01 全流程（从 0 到 1）
def test_uc01_full_flow_ui(page, tmp_path):
    login(page, 'pm')
    # P02 新建需求单（五步向导）
    nav(page, 'jobs')
    page.click('#btn-new-job')
    page.fill('#job-title', '验收 · 20 件青铜器与宫灯')
    page.fill('#job-qty', '3')
    page.fill('#job-desc', '商周青铜鼎与明清宫灯，写实 PBR')
    page.click('#btn-next')
    page.check('#her-no')
    page.click('#btn-next')
    page.click('#btn-next')
    # 管线预览：对外商用项目，不出现未登记授权的模型
    preview = page.locator('.panel', has=page.locator('h3', has_text='管线预览')).inner_text()
    assert 'TRELLIS.2-4B' in preview and 'Qwen-Image fp8' in preview
    assert 'FLUX' not in preview and 'Hunyuan3D' not in preview
    excluded = page.locator('.panel', has=page.locator('h3', has_text='许可证检查')).inner_text()
    assert 'FLUX.1-dev' in excluded and 'Hunyuan3D' in excluded
    page.click('#btn-next')
    page.click('#btn-submit-job')
    expect(page.locator('.toast').last).to_contain_text('已提交')
    job = ev(page, "() => Engine.S.jobs[0]")
    assert job['status'] == 'producing' and job['precheck']['preset'] == 'webxr'  # Quest 3 + WebXR 取最严格
    ff(page, 400)
    # P03 选图 → 送入 3D（3D 美术）
    as_user(page, 'artist')
    page.evaluate("id => SCW.go('concepts', {job: id})", job['id'])
    page.wait_for_selector('#concept-grid .thumb')
    thumbs = page.locator('#concept-grid .thumb')
    assert thumbs.count() >= 8
    for i in range(3):
        thumbs.nth(i).click()
    page.click('#btn-send-3d')
    expect(page.locator('.toast').last).to_contain_text('已送入 3D 生成')
    # 等待 3D 生成 → 自动优化 → 自动质检
    ff(page, 2400)
    assets = ev(page, "id => Engine.S.assets.filter(a => a.job_id === id).map(a => ({id:a.id, status:a.status, code:a.code}))", job['id'])
    assert len(assets) == 3 and all(a['status'] == 'review' for a in assets), assets
    # 质检：九项检查
    qa = ev(page, "id => Engine.qaOf(Engine.cur(Engine.asset(id))).items.map(i => i.rule)", assets[0]['id'])
    assert qa == ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09']
    # P10 审核：键盘快捷键
    as_user(page, 'reviewer')
    for a in assets:
        ev(page, "id => { const v = Engine.cur(Engine.asset(id)); v.defects.nonManifold = 0; v.defects.flipped = 0; v.defects.origin = [0,0,0]; v.defects.scaleOff = false; Engine.runQA(v.id); }", a['id'])
    page.evaluate("id => SCW.go('review', {asset: id})", assets[0]['id'])
    page.wait_for_selector('#btn-pass')
    page.click('#btn-pass')
    page.wait_for_timeout(300)
    page.click(f'#review-list [data-id="{assets[1]["id"]}"]')
    page.keyboard.press('a')
    page.wait_for_timeout(300)
    # 返工必须选择原因
    page.click(f'#review-list [data-id="{assets[2]["id"]}"]')
    page.click('#btn-rework')
    expect(page.locator('.toast.err').last).to_contain_text('返工必须选择原因')
    page.select_option('#rw-reason', 'texture')
    page.click('#btn-rework')
    st = ev(page, "id => Engine.S.assets.filter(a => a.job_id === id).map(a => a.status).sort()", job['id'])
    assert st.count('library') == 2 and st.count('optimizing') + st.count('rework') == 1, st
    ff(page, 300)
    st = ev(page, "id => Engine.S.assets.filter(a => a.job_id === id).map(a => a.status).sort()", job['id'])
    assert st.count('review') == 1  # 返工到资产优化后重新进入待审核
    # 返工生成新版本
    vers = ev(page, "id => Engine.S.assets.filter(a => a.job_id === id && a.status === 'review')[0].versions.length", job['id'])
    assert vers == 2
    # 通过率与审核表一致
    s = ev(page, "() => { const s = Engine.stats(); return [s.pass, s.rework, s.discard, s.passRate]; }")
    assert abs(s[3] - s[0] / (s[0] + s[1] + s[2])) < 1e-9
    # P11 资产库 → 下载 GLB → glTF 校验
    as_user(page, 'pm')
    nav(page, 'library')
    page.fill('#lib-search', '验收')  # 名称/标签/提示词检索
    page.fill('#lib-search', '')
    lib_codes = [a['code'] for a in ev(page, "id => Engine.S.assets.filter(a => a.job_id === id && a.status==='library')", job['id'])]
    page.locator(f'#lib-grid [data-id]').filter(has_text=lib_codes[0]).first.click()
    with page.expect_download() as dl:
        page.click('text=下载 GLB')
    glb = tmp_path / dl.value.suggested_filename
    dl.value.save_as(glb)
    code, out = validate_glb([glb])
    assert code == 0, out
    tris = ev(page, "c => { const a = Engine.S.assets.find(x => x.code === c); return Engine.cur(a).opt.tris; }", lib_codes[0])
    assert out[0]['triangles'] == tris  # 面数与导出文件一致
    gj = json.loads(glb.read_bytes()[20:20 + int.from_bytes(glb.read_bytes()[12:16], 'little')])
    assert gj['asset']['extras']['AIGC']['label'].endswith('AI 生成')  # 隐式标识写入 GLB extras
    # P12 导出 WebXR
    page.keyboard.press('Escape')
    page.evaluate("ids => SCW.go('export', {assets: ids})", ev(page, "id => Engine.S.assets.filter(a => a.job_id === id && a.status==='library').map(a=>a.id)", job['id']))
    page.wait_for_selector('#btn-export')
    checks = page.locator('text=发布前检查').locator('xpath=../..').inner_text()
    assert '全部资产已通过质检' in checks
    page.click('#btn-export')
    expect(page.locator('.toast').last).to_contain_text('已创建导出')
    ff(page, 200)
    ex = ev(page, "() => Engine.S.exports[0]")
    assert ex['status'] == 'done' and ex['manifest']['device_note'] == '未经真机验证'
    assert len(ex['manifest']['assets']) == 2
    with page.expect_download() as dl:
        page.locator('tr', has_text=ex['code']).locator('text=下载').click()
    zp = tmp_path / 'pkg.zip'
    dl.value.save_as(zp)
    z = zipfile.ZipFile(zp)
    names = z.namelist()
    assert 'manifest.json' in names and 'index.html' in names and 'scene.glb' in names and '交付说明.txt' in names
    man = json.loads(z.read('manifest.json'))
    assert len(man['assets']) == len([n for n in names if n.startswith('assets/') and n.endswith('.glb')])  # 清单资产数与包内一致
    for a in man['assets']:
        assert a['license_types'] and a['aigc']['implicit'] and a['seed'] is not None
    paths = []
    for n in names:
        if n.endswith('.glb'):
            p = tmp_path / n.replace('/', '_'); p.write_bytes(z.read(n)); paths.append(p)
    code, out = validate_glb(paths)
    assert code == 0, out
    assert '未经真机验证' in z.read('交付说明.txt').decode()
    no_errors(page)


# ---------------------------------------------------------------- 许可证规则
def test_license_block_submit_and_export(page):
    login(page, 'admin')
    # 管理员禁用所有对外可用的图生 3D 模型 → 对外商用需求单提交被拒并写审计
    for m in ['trellis2-4b', 'direct3d-s2', 'triposg', 'step1x-3d', 'hunyuan-api']:
        ev(page, "m => Engine.updateModel(m, {allowed_scope: 'disabled'})", m)
    r = ev(page, """() => { const j = Engine.createJob({title:'许可阻断', content_type:'prop', platforms:['quest3'], quantity:2, is_heritage:false});
        try { Engine.submitJob(j.id); return 'ok'; } catch (e) { return e.message; } }""")
    assert '提交被拒' in r and '3D 生成' in r
    assert ev(page, "() => Engine.S.audit.some(a => a.action === '需求单提交被拒')")
    # 内部原型项目可以使用 Hunyuan3D（未授权模型仅内部可用）
    ok = ev(page, "() => Engine.modelAllowed('hunyuan3d-21', {usage_scope:'internal'}).ok")
    assert ok
    # 出海项目排除地域限制模型
    ev(page, "() => { Engine.S.models.find(m=>m.id==='hunyuan3d-21').license_status='已登记授权'; Engine.S.models.find(m=>m.id==='hunyuan3d-21').allowed_scope='all'; }")
    assert ev(page, "() => Engine.modelAllowed('hunyuan3d-21', {usage_scope:'commercial_cn'}).ok")
    assert not ev(page, "() => Engine.modelAllowed('hunyuan3d-21', {usage_scope:'commercial_overseas'}).ok")
    # 导出阻断：资产许可链含未授权模型
    r = ev(page, """() => { const a = Engine.S.assets.find(a => a.project_id==='p_lz' && a.status==='library' && a.type==='prop');
        Engine.cur(a).license_chain.push({stage:'3D 生成', model_id:'flux-dev', model_name:'FLUX.1-dev', license:'FLUX.1-dev 非商用许可'});
        try { Engine.createExport({object_type:'assets', asset_ids:[a.id], targets:['webxr'], settings:{}}); return 'ok'; } catch (e) { return e.message; } }""")
    assert '导出被阻断' in r and '许可证' in r
    assert ev(page, "() => Engine.S.audit.some(a => a.action === '导出被阻断')")


def test_settings_scope_syncs_to_p02_p04(page):
    login(page, 'admin')
    nav(page, 'system')
    # 未上传授权文件时不能改为“全部项目”
    page.locator('[data-model="hunyuan3d-21"] select').select_option('all')
    expect(page.locator('.toast.err').last).to_contain_text('需先上传授权文件')
    # 禁用 TRELLIS.2 → P04 中置灰
    page.locator('[data-model="trellis2-4b"] select').select_option('disabled')
    nav(page, 'gen3d')
    row = page.locator('label.li', has_text='TRELLIS.2-4B')
    expect(row).to_contain_text('管理员已禁用')
    assert row.locator('input').is_disabled()
    # P02 管线自动换成其他合规模型
    pre = ev(page, "() => Engine.precheck({project_id:'p_lz', content_type:'prop', platforms:['quest3'], quantity:1, is_heritage:false})")
    gen = [n for n in pre['nodes'] if n['type'] == 'image_to_3d'][0]
    assert gen['model'] != 'trellis2-4b'
    assert any(x['model'] == 'TRELLIS.2-4B' for x in pre['excluded'])
    # 仅管理员可访问系统设置
    as_user(page, 'pm')
    assert page.locator('[data-route="system"]').is_hidden()


# ---------------------------------------------------------------- 文博规则
def test_heritage_rules(page):
    login(page, 'pm')
    nav(page, 'jobs')
    page.click('#btn-new-job')
    page.fill('#job-title', '玉琮本体')
    page.click('#btn-next')
    page.check('#her-yes')
    assert page.locator('#ct-prop').is_disabled() and page.locator('#ct-recon').is_checked()
    r = ev(page, """() => { const j = Engine.createJob({title:'文物', content_type:'prop', platforms:['quest3'], quantity:1, is_heritage:true});
        Engine.submitJob(j.id);
        try { Engine.generateConcepts({job_id:j.id, prompt:'玉琮', model_id:'qwen-image-fp8'}); return 'ok'; } catch (e) { return e.message; } }""")
    assert '文物本体' in r
    j = ev(page, "() => Engine.S.jobs[0]")
    assert j['content_type'] == 'recon' and j['precheck']['template'] == 'recon_3dgs_v1'
    # 采集记录不完整不能导出；注册率 < 90% 不进入训练
    as_user(page, 'artist')
    r = ev(page, """() => { const d = Engine.createDataset({name:'t', photo_count:400, forceLowRatio:true}); Engine.solvePoses(d.id); Engine.fastForward(1400, 10);
        let m1; try { Engine.trainGS(d.id); m1='ok'; } catch(e) { m1 = e.message; }
        return [d.status, m1]; }""")
    assert r[0] == 'reshoot' and '90%' in r[1]
    r = ev(page, """() => { const d = Engine.createDataset({name:'t2', photo_count:400}); Engine.solvePoses(d.id); Engine.fastForward(1400, 10); Engine.trainGS(d.id, {mode:'now'}); Engine.fastForward(3000, 10);
        let m; try { Engine.finishRecon(d.id); m='ok'; } catch(e) { m = e.message; }
        d.capture_record = {collector:'a', date:'2026-11-14', control:'8 点', colorChart:'X-Rite'}; const a = Engine.finishRecon(d.id); Engine.fastForward(30);
        return [m, d.accuracy_report !== null, a.source, Engine.cur(a).aigc_mark, a.status]; }""")
    assert '采集记录未填写完整' in r[0] and r[1] and r[2] == '重建' and r[3] is None and r[4] == 'review'


# ---------------------------------------------------------------- 审核返工规则
def test_rework_over_two_goes_manual(page):
    login(page, 'reviewer')
    r = ev(page, """() => { const a = Engine.S.assets.find(a => a.status === 'review' && a.type==='prop'); const res = [];
        for (let i = 0; i < 3; i++) { Engine.fastForward(600); if (a.status !== 'review') { res.push('not-review:' + a.status); break; } Engine.review(a.id, 'rework', 'scale', 'x'); res.push(a.status); }
        return [res, a.rework_count, a.status, Engine.S.tasks.filter(t => t.asset_id === a.id && t.status === 'queued').length]; }""")
    assert r[1] == 3 and r[2] == 'manual' and r[3] == 0, r
    # 有自动未通过项时通过需放行理由；Q08 未通过不可放行
    r = ev(page, """() => { const a = Engine.S.assets.find(a => a.status === 'review' && a.type==='prop'); const v = Engine.cur(a);
        v.defects.nonManifold = 3; Engine.runQA(v.id); let m1; try { Engine.review(a.id, 'pass'); m1 = 'ok'; } catch (e) { m1 = e.message; }
        v.license_chain.push({stage:'x', model_id:'flux-dev', model_name:'FLUX', license:'nc'}); Engine.runQA(v.id); let m2; try { Engine.review(a.id, 'pass', null, '理由'); m2='ok'; } catch (e) { m2 = e.message; }
        return [m1, m2]; }""")
    assert '放行理由' in r[0] and '不可放行' in r[1]


def test_autofix_and_qa_speed(page):
    login(page, 'reviewer')
    r = ev(page, """() => { const a = Engine.S.assets.find(a => a.status === 'review' && a.type==='prop'); const v = Engine.cur(a);
        v.defects.nonManifold = 4; v.defects.flipped = 1; v.defects.origin = [0.05, 0, 0]; const q0 = Engine.runQA(v.id);
        const t0 = performance.now(); const r = Engine.autoFix(a.id); const dt = performance.now() - t0;
        return [q0.items.filter(i => i.result === 'fail').map(i => i.rule), r.qa.items.filter(i => ['Q04','Q06','Q07'].includes(i.rule)).map(i => i.result), r.qa.duration_s, dt]; }""")
    assert set(['Q04', 'Q06', 'Q07']).issubset(set(r[0]))
    assert r[1] == ['pass', 'pass', 'pass'] and r[2] <= 10 and r[3] < 10000


# ---------------------------------------------------------------- GPU 调度
def test_oom_downgrade_and_manual(page):
    login(page, 'artist')
    r = ev(page, """() => { const c = Engine.S.concepts.find(c => c.status === 'candidate'); const [t] = Engine.selectConcepts([c.id], {params:{preview_render:true}});
        for (let i = 0; i < 400 && !['done','manual','failed'].includes(t.status); i++) Engine.fastForward(5);
        return [t.status, t.oom_retry, t.params.resolution, t.log.some(l => l.includes('1024³ → 512³'))]; }""")
    assert r == ['done', 1, 512, True], r
    r = ev(page, """() => { const c = Engine.S.concepts.find(c => c.status === 'candidate'); const [t] = Engine.selectConcepts([c.id], {params:{preview_render:true, resolution:512}});
        for (let i = 0; i < 400 && !['done','manual','failed'].includes(t.status); i++) Engine.fastForward(5);
        return [t.status, t.log.filter(l => l.includes('out of memory')).length]; }""")
    assert r == ['manual', 1], r


def test_scheduler_batch_pin_and_cancel(page):
    login(page, 'artist')
    r = ev(page, """() => { Engine.fastForward(3000);  // 清空队列
        const order = []; Engine.on(e => { if (e.type === 'task.state' && e.payload.status === 'running') order.push(Engine.task(e.payload.task_id)); });
        const cs = Engine.S.concepts.filter(c => c.status === 'candidate').slice(0, 4);
        const a = Engine.generateConcepts({prompt:'宫灯', model_id:'qwen-image-fp8', batch:2});
        for (let i = 0; i < 100 && a.status !== 'running'; i++) Engine.fastForward(2);   // 当前批次已在运行
        const t3d = Engine.selectConcepts(cs.slice(0,3).map(c => c.id), {});
        const b = Engine.generateConcepts({prompt:'青铜鼎', model_id:'qwen-image-fp8', batch:1});
        const pinned = Engine.selectConcepts([cs[3].id], {})[0]; Engine.taskAction(pinned.id, 'pin');
        Engine.fastForward(3000);
        return order.filter(t => t.queue === 'gpu').map(t => t.node + ':' + (t.id === pinned.id ? 'PIN' : '') ); }""")
    # 运行中的概念图不被打断；置顶任务在其结束后优先执行；随后同模型（TRELLIS.2）任务合批连续执行，最后才换回概念图模型
    gpu = r
    assert gpu[:6] == ['concept_image:', 'image_to_3d:PIN', 'image_to_3d:', 'image_to_3d:', 'image_to_3d:', 'concept_image:'], gpu
    # 取消运行中的任务立即释放
    r = ev(page, """() => { const c = Engine.S.concepts.find(c => c.status === 'candidate'); const [t] = Engine.selectConcepts([c.id], {});
        for (let i = 0; i < 200 && t.status !== 'running'; i++) Engine.fastForward(2); Engine.taskAction(t.id, 'cancel');
        return [t.status, Engine.S.tasks.filter(x => x.queue==='gpu' && x.status==='running').length]; }""")
    assert r == ['canceled', 0]
    # 超限路由：显存 24GB 的 Direct3D-S2 走云端
    assert ev(page, "() => Engine.routeQueue('image_to_3d', Engine.model('direct3d-s2'))") == 'cloud'
    # 夜间窗口：预计超过 60 分钟的训练任务
    r = ev(page, "() => { const d = Engine.createDataset({name:'big', photo_count:1200}); d.registered_ratio = 0.95; d.status='posed'; const t = Engine.trainGS(d.id); return t.priority; }")
    assert r == 'night'


# ---------------------------------------------------------------- 场景组装 Agent
def test_agent_assembly_six_steps(page):
    login(page, 'pm')
    nav(page, 'assembly')
    page.click('text=新建场景')
    page.fill('#agent-input', '中央放一个青铜鼎，两侧各放一盏宫灯，后方放两件编钟，前方放一排三件编钟，打暖色主光，设置主相机')
    page.click('#agent-send')
    page.wait_for_timeout(9000)
    sc = ev(page, "() => Engine.S.scenes[0]")
    assert len(sc['items']) >= 5, len(sc['items'])
    assert any(t['name'] == 'library.import_to_scene' for m in sc['messages'] for t in (m.get('tools') or []))
    assert ev(page, "() => Engine.S.audit.filter(a => a.action === 'Agent 工具调用').length") >= 6
    # Python 需确认
    page.fill('#agent-input', '用 Python 脚本把展品对齐到地面')
    page.click('#agent-send')
    page.wait_for_selector('#btn-confirm-python', timeout=8000)
    page.click('#btn-confirm-python')
    # 六步确认
    page.click('#btn-step-confirm')  # 白盒 → 静帧
    page.click('#btn-step-confirm')
    expect(page.locator('.toast.err').last).to_contain_text('请先渲染静帧')
    page.click('#btn-still')
    for _ in range(5):
        page.click('#btn-step-confirm')
        page.wait_for_timeout(200)
    assert ev(page, "() => Engine.S.scenes[0].final") is True
    # 预算超过 100% 不能进入最终输出
    r = ev(page, """() => { const sc = Engine.createScene({name:'超预算'}); const a = Engine.sceneAssets()[0]; const v = Engine.cur(a);
        for (let i = 0; i < 300; i++) sc.items.push({id:'x'+i, asset_id:a.id, version_id:v.id, name:'x', pos:[0,0,0], rotY:0, scale:1});
        sc.step = 5; try { Engine.sceneConfirm(sc.id); return 'ok'; } catch (e) { return e.message; } }""")
    assert '超过 100%' in r
    no_errors(page)


# ---------------------------------------------------------------- 权限、持久化、移动端
def test_permissions(page):
    login(page, 'reviewer')
    r = ev(page, "() => { try { Engine.createJob({title:'x', platforms:['quest3'], is_heritage:false}); return 'ok'; } catch(e) { return e.message; } }")
    assert '无权' in r
    as_user(page, 'pm')
    r = ev(page, "() => { const a = Engine.S.assets.find(a => a.status==='review'); try { Engine.review(a.id, 'pass'); return 'ok'; } catch(e) { return e.message; } }")
    assert '无权' in r
    r = ev(page, "() => { const t = Engine.S.tasks.find(t => t.created_by !== '林策划' && t.status === 'queued'); if (!t) return 'skip'; try { Engine.taskAction(t.id, 'pause'); return 'ok'; } catch(e) { return e.message; } }")
    assert r == 'skip' or '本人' in r


def test_persistence_after_reload(page):
    login(page, 'pm')
    ev(page, "() => { Engine.createJob({title:'持久化检查', platforms:['quest3'], is_heritage:false}); Engine.save(); }")
    page.reload()
    page.wait_for_selector('.shell')
    assert ev(page, "() => Engine.S.jobs.some(j => j.title === '持久化检查')")


def test_mobile_no_horizontal_scroll(browser, server):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844})
    pg = ctx.new_page()
    pg.goto(server + '/')
    pg.wait_for_selector('#login-btn')
    login(pg, 'admin')
    for r in ['workbench', 'review', 'library', 'queue']:
        pg.evaluate("r => SCW.go(r)", r)
        pg.wait_for_timeout(600)
        w = pg.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
        assert w[0] <= w[1] + 1, (r, w)
    ctx.close()


def test_library_filter_speed_1000_assets(page):
    login(page, 'pm')
    r = ev(page, """() => { const base = Engine.S.assets.find(a => a.status === 'library' && a.type==='prop');
        for (let i = 0; i < 1000; i++) Engine.S.assets.push(Object.assign({}, base, {id:'bulk'+i, code:'SC-B'+i, name:'批量 '+i, tags:['批量']}));
        const t0 = performance.now(); const r = Engine.libraryQuery({q:'批量', commercialOnly:true}); return [r.length, performance.now() - t0]; }""")
    assert r[0] >= 1000 and r[1] < 1000
