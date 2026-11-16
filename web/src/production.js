/* Real execution bridge. No model output or measurements are synthesized here. */
(function (global) {
  'use strict';
  const E = global.Engine;
  const real = () => E.S && E.S.runtime && E.S.runtime.mode === 'production';
  const uid = p => p + '_' + (++E.S.seq).toString(36);
  const reject = (s, code) => { throw new E.BizError(s, code || 'rule'); };
  const perm = p => { if (!E.can(p)) reject('当前角色无权执行该操作', 'forbidden'); };
  const oldTick = E.tick;
  Object.assign(E.dict.NODE_NAMES, { mesh_fix: '真实文件修复', manual_import: '人工文件导入' });
  E.tick = function (ms) { if (!real()) return oldTick(ms); E.S.clock = Date.now(); };
  E.productionInit = function () {
    E.init({ fresh: true, empty: true });
    const S = E.S; S.runtime = { mode: 'production', workers: {}, ready: false };
    S.release = 'V1.0'; S.speed = 1; S.licenses = []; S.cloudCostMonth = 0;
    S.projects = [{ id: 'p_real', name: '道具生产', usage_scope: 'internal', default_platforms: ['quest3', 'webxr'] }];
    S.currentProjectId = 'p_real'; S.settings.cloud = { keySet: false, tencentKeySet: false, marbleKeySet: false };
    S.settings.storage.models.usedGb = null; S.settings.storage.assets.usedGb = null;
    const available = ['qwen-image-fp8', 'trellis2-4b', 'blender', 'birefnet'];
    S.models.forEach(m => {
      if (!available.includes(m.id)) { m.allowed_scope = 'disabled'; m.status = '未接入'; }
      // Dependencies must be verified before commercial delivery; no invented authorizations.
      if (['trellis2-4b'].includes(m.id)) { m.allowed_scope = 'internal'; m.license_status = '待核对'; }
    });
    S.models.push({ id: 'dinov3', name: 'DINOv3 图像特征依赖', node: 'dependency', license_type: '待核对', license_status: '待核对', allowed_scope: 'internal', status: '待下载' }, { id: 'bria-rmbg2', name: 'RMBG-2.0 推理依赖', node: 'dependency', license_type: '待核对', license_status: '待核对', allowed_scope: 'internal', status: '待下载' });
    Object.assign(E.dict.NODE_NAMES, { mesh_fix: '真实文件修复', manual_import: '人工文件导入' });
    E.alert('info', '真实生产模式：只显示真实产物和测量值。先完成系统设置中的引擎检查。', 'system');
    return S;
  };
  const oldStrictest = E.strictestPreset;
  E.strictestPreset = function (platforms) {
    if (!real()) return oldStrictest(platforms);
    const keys = (platforms || []).map(p => E.S.settings.presets[p]).filter(Boolean);
    if (keys.length < 2) return oldStrictest(platforms);
    const preset = Object.assign({}, keys[0], { name: '目标平台最严格预算' });
    ['tris','tex','materials','size_mb','scene_tris','drawcalls','tex_mem_mb','scene_materials'].forEach(k => { const ns=keys.map(p=>p[k]).filter(v=>typeof v==='number'); if(ns.length)preset[k]=Math.min(...ns); });
    const key = 'multi_' + [...platforms].sort().join('_'); E.S.settings.presets[key]=preset; return key;
  };
  function wrap(name, check) {
    const old = E[name]; E[name] = function () { if (real()) check.apply(E, arguments); return old.apply(E, arguments); };
  }
  ['updateJob', 'cancelJob', 'deleteJob'].forEach(n => wrap(n, () => perm('job.create')));
  const protectedOps = { discardConcepts: 'concept', tagAssets: 'library', rollback: 'manual.handle', updateModel: 'admin', confirmLicense: 'admin', updateSettings: 'admin' };
  Object.keys(protectedOps).forEach(n => wrap(n, () => perm(protectedOps[n])));
  wrap('confirmLicense', (id, date) => {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T23:59:59+08:00')) || Date.parse(date+'T23:59:59+08:00')<Date.now()) reject('请填写附件对应的有效授权截止日期');
  });
  wrap('createJob', d => {
    if ((d.content_type || 'prop') !== 'prop' || d.is_heritage) reject('真实 V1.0 仅开放非文物本体道具生产');
    if ((d.ref_images || []).some(x => typeof x !== 'object' || !x.file_id)) reject('参考图必须先上传到服务器');
  });
  wrap('generateConcepts', o => {
    if (o.three_view) reject('当前真实工作流尚未配置三视图，不能将普通图作为三视图');
    if (o.model_id !== 'qwen-image-fp8') reject('该概念图引擎尚未接入');
    if (o.lora && !E.model(o.lora)?.file_name) reject('请先登记真实 LoRA 文件');
    if ((o.batch || 8) > 16) reject('单批最多 16 张');
  });
  wrap('selectConcepts', ids => {
    ids.forEach(id => { const c = E.S.concepts.find(x => x.id === id); if (!c || c.status !== 'candidate' || !c.file_id) reject('只可选择尚未送入 3D 的真实概念图'); });
    if (new Set(ids.map(id => E.S.concepts.find(c => c.id === id).job_id)).size > 1) reject('请按同一需求单选择概念图');
  });
  function freeAsset(aid) { if (E.S.tasks.some(t => t.asset_id === aid && ['queued','running','paused'].includes(t.status))) reject('该资产已有任务，请先完成或取消'); }
  wrap('regenerate3d', aid => freeAsset(aid));
  wrap('optimize', ids => ids.forEach(freeAsset));
  wrap('rollback', (aid, vid) => { freeAsset(aid); if (E.version(vid)?.asset_id !== aid) reject('版本不属于当前资产'); });
  const oldTaskAction=E.taskAction;
  E.taskAction=function(tid,action){
    const result=oldTaskAction(tid,action);
    if(real()){
      const t=E.task(tid),ex=E.S.exports.find(e=>e.id===t.export_id);
      if(ex)ex.status=t.status;
      if(t.status==='canceled' && t.queue==='gpu')E.S.gpu.loaded=null;
    }
    return result;
  };
  ['generatePanoramas', 'fixSeam', 'upscalePano', 'togglePanoUse', 'submitWorld', 'createDataset', 'appendPhotos', 'solvePoses', 'trainGS', 'cleanRecon', 'finishRecon', 'createCharacter', 'rigCharacter', 'confirmWeights', 'genMotion', 'addClip', 'updateClip', 'removeClip', 'agentSend', 'agentConfirm', 'createScene', 'sceneConfirm', 'addStill', 'moveItem', 'scaleItem', 'addSceneItem', 'setSpeed', 'setRelease', 'fastForward', 'reset'].forEach(name => {
    const old = E[name]; E[name] = function () { if (real()) reject('真实 V1.0 未开放该操作'); return old.apply(E, arguments); };
  });
  const oldRules = E.updateSettings;
  E.updateSettings = function (path, value) {
    if (real() && path.startsWith('rules.') && value === false) reject('生产模式不能关闭许可或文物规则');
    return oldRules(path, value);
  };
  const oldModelAllowed = E.modelAllowed;
  E.modelAllowed = function (m, project) {
    const result = oldModelAllowed(m, project); if (!real() || !result.ok) return result;
    m = typeof m === 'string' ? E.model(m) : m;
    if (!['qwen-image-fp8', 'trellis2-4b', 'blender', 'birefnet', 'dinov3', 'bria-rmbg2'].includes(m.id) && m.node !== 'lora') return { ok: false, reason: '真实执行器尚未接入' };
    const rec = E.S.licenses.find(l => l.model_id === m.id && l.confirmed_by);
    if (m.license_status === '已登记授权' && (!rec || !rec.file_id || !rec.valid_until || !Number.isFinite(Date.parse(rec.valid_until + 'T23:59:59+08:00')) || Date.parse(rec.valid_until + 'T23:59:59+08:00') < E.S.clock)) return { ok: false, reason: '授权文件缺失或已过期' };
    return result;
  };
  const oldUploadLicense = E.uploadLicense;
  E.uploadLicense = function (mid, file) {
    if (!real()) return oldUploadLicense(mid, file);
    perm('admin'); if (!file || !file.file_id) reject('必须上传授权文件内容');
    const rec = oldUploadLicense(mid, file.name); Object.assign(rec, { file_id: file.file_id, sha256: file.sha256 }); return rec;
  };
  const oldQA = E.runQA;
  E.runQA = function (vid) {
    if (!real()) return oldQA(vid);
    perm('review'); const v = E.version(vid); if (!v) reject('版本不存在');
    return E.enqueue({ project_id: E.asset(v.asset_id).project_id, node: 'auto_qa', model_id: 'blender', asset_id: v.asset_id, version_id: vid, params: {} });
  };
  const oldFix = E.autoFix;
  E.autoFix = function (aid) {
    if (!real()) return oldFix(aid);
    perm('review'); const a = E.asset(aid); const v = E.cur(a);
    if (a.status !== 'review') reject('只可修复待审核版本');
    return E.enqueue({ project_id: a.project_id, node: 'mesh_fix', queue: 'cpu', model_id: 'blender', asset_id: aid, version_id: v.id, params: {} });
  };
  const oldManual = E.manualResolve;
  E.manualResolve = function (aid, note, file) {
    if (!real()) return oldManual(aid, note);
    perm('manual.handle'); const a = E.asset(aid); if (a.status !== 'manual') reject('资产不在转人工状态');
    if (!file || !file.file_id) reject('请上传人工修复后的 GLB');
    return E.enqueue({ project_id: a.project_id, node: 'manual_import', queue: 'cpu', model_id: 'blender', asset_id: aid, version_id: a.current_version, params: { file_id: file.file_id, note: note || '' } });
  };
  const oldReview = E.review;
  E.review = function (aid, decision, reason, comment) {
    if (real()) {
      perm('review'); const a = E.asset(aid), v = E.cur(a); const qa = E.qaOf(v);
      if (!qa || qa.file_sha256 !== v.file_sha256 || !qa.items.length) reject('该文件尚未完成真实质检');
    }
    return oldReview(aid, decision, reason, comment);
  };
  const oldExport = E.createExport;
  E.createExport = function (o) {
    if (real()) {
      if (o.object_type !== 'assets' || (o.targets || []).some(t => !['webxr', 'raw'].includes(t))) reject('真实 V1.0 仅支持资产集合的 WebXR / 原始工程导出');
      if (!o.settings || o.settings.meshCompress !== 'Draco' || o.settings.texCompress !== 'KTX2') reject('真实 WebXR 导出要求 Draco + KTX2');
      (o.asset_ids || []).forEach(aid => { const a = E.asset(aid), v = E.cur(a); if (!v.approved || !v.file_id) reject('所选文件版本尚未通过审核'); });
    }
    const ex = oldExport(o);
    if (real()) ex.version_ids = ex.asset_ids.map(aid => E.asset(aid).current_version);
    return ex;
  };
  E.productionClaim = function (tid) {
    const t = E.task(tid); if (t.status !== 'queued') reject('任务不可领取');
    if (!['concept_image', 'image_to_3d', 'mesh_optimize', 'auto_qa', 'mesh_fix', 'manual_import', 'export'].includes(t.node)) reject('真实执行器不支持此节点');
    t.status = 'running'; t.started_at = Date.now(); t.progress = 0; t.attempt = (t.attempt || 0) + 1;
    E.S.schedule.push({task_id:tid,lane:t.queue,start:t.started_at,end:t.started_at,kind:'run',model:t.model_id,label:t.code});
    E.S.schedule=E.S.schedule.slice(-1000);
    if(t.queue==='gpu')E.S.gpu.loaded=t.model_id;
    if(t.export_id)E.S.exports.find(e=>e.id===t.export_id).status='running';
    t.log.push('真实 Worker 开始执行');
    if (t.asset_id) E.asset(t.asset_id).status = ({ image_to_3d: 'generating', mesh_optimize: 'optimizing', auto_qa: 'qa', mesh_fix: 'qa', manual_import: 'qa' })[t.node] || E.asset(t.asset_id).status;
    E.emit('task.state', { task_id: tid, status: t.status }); return t;
  };
  E.productionProgress = function (tid, data) {
    const t = E.task(tid); if (t.status !== 'running') return;
    if (data.progress != null) t.progress = Math.max(0, Math.min(0.99, data.progress));
    if (data.log) { t.log.push(data.log); if (t.log.length > 300) t.log.splice(0, t.log.length - 300); }
    if (data.metrics) t.metrics = Object.assign(t.metrics || {},data.metrics);
    t.elapsed = (Date.now() - t.started_at) / 1000;
    const segment=E.S.schedule.findLast(s=>s.task_id===tid); if(segment)segment.end=Date.now();
    E.emit('task.progress', { task_id: tid, percent: Math.round(t.progress * 100), metrics: t.metrics });
  };
  function version(a, fields) {
    const v = Object.assign({}, fields, { id: uid('v'), asset_id: a.id, version: a.versions.length + 1, created_at: Date.now(), approved: false });
    a.versions.push(v.id); a.current_version = v.id; E.S.versions.unshift(v); return v;
  }
  function qa(a, v, result) {
    const chain = E.chainCheck(v.license_chain, E.scopeOf(a.project_id, a.job_id));
    const items = result.items.filter(i => !['Q08', 'Q09'].includes(i.rule));
    items.push({ rule: 'Q08', name: '许可证合规', level: '阻断', measured: chain.ok ? '许可链通过' : chain.bad.map(x => x.reason).join('；'), result: chain.ok ? 'pass' : 'fail' });
    items.push({ rule: 'Q09', name: 'AIGC 标识', level: '阻断', measured: result.mark_valid ? '真实 GLB extras 与来源记录一致' : '文件标识缺失或不匹配', result: result.mark_valid ? 'pass' : 'fail' });
    const q = { id: uid('qa'), asset_id: a.id, asset_version_id: v.id, preset_id: v.preset || a.preset, file_sha256: result.sha256, items, passed: items.every(i => i.result !== 'fail'), created_at: Date.now(), duration_s: result.seconds };
    E.S.qa.unshift(q); v.qa_id = q.id; v.file_sha256 = result.sha256;
    a.status = 'review'; a.review_since = Date.now(); E.emit('qa.result', { version_id: v.id, passed: q.passed, items }); return q;
  }
  E.productionComplete = function (tid, out) {
    const t = E.task(tid); if (t.status !== 'running') return false;
    if (t.node === 'concept_image') {
      out.images.forEach((image, i) => E.S.concepts.unshift(Object.assign({ id: uid('img'), code: 'IMG-' + E.S.seq, job_id: t.job_id, project_id: t.project_id, batch_task: t.id, batch_code: t.code, prompt: t.params.prompt, negative: t.params.negative, seed: t.params.seed + i, model_id: t.model_id, lora: t.params.lora || '', size: t.params.size, category: 'vase', remove_bg: t.params.remove_bg, selected: false, status: 'candidate', created_at: Date.now(), tags: [], license_chain: out.license_chain }, image)));
    } else if (t.node === 'image_to_3d') {
      const c = E.S.concepts.find(c => c.id === t.concept_id);
      let a = t.asset_id && E.asset(t.asset_id);
      if (!a) { a = { id: uid('a'), code: 'SC-' + E.S.seq, name: (E.job(t.job_id).title || '道具') + ' ' + E.S.seq, project_id: t.project_id || E.job(t.job_id).project_id, job_id: t.job_id, type: 'prop', source: '生成', heritage: false, ai_restore: !!E.job(t.job_id).ai_restore, category: 'vase', prompt: c.prompt, concept_id: c.id, versions: [], tags: [], scenes: [], history: [], rework_count: 0, created_at: Date.now(), preset: E.job(t.job_id).preset }; E.S.assets.unshift(a); t.asset_id = a.id; }
      const chain = (c.license_chain || []).concat([{ stage: '3D 生成', model_id: t.model_id, model_name: E.model(t.model_id).name, license: E.model(t.model_id).license_type }], ['dinov3','bria-rmbg2'].map(id => ({ stage: '3D 模型依赖', model_id: id, model_name: E.model(id).name, license: E.model(id).license_type })));
      const v = version(a, Object.assign({ stage: 'raw', raw: out.stats, opt: null, seed: t.params.seed, params: t.params, model_id: t.model_id, parent_task_id: tid, category: 'vase', license_chain: chain, aigc_mark: out.aigc_mark, defects: {}, qa_id: null }, out.file));
      a.status = 'generated'; a.model_id = t.model_id;
      if (E.S.settings.autoOptimize) E.queueOptimize(a, v, { preset: a.preset });
    } else if (['mesh_optimize', 'mesh_fix', 'manual_import'].includes(t.node)) {
      const a = E.asset(t.asset_id), base = E.version(t.version_id);
      out.stats.preset = t.params.preset || base.preset || a.preset;
      const v = version(a, Object.assign({}, base, { stage: 'optimized', raw: base.raw, raw_file_id: base.raw_file_id || base.file_id, opt: out.stats, preset: out.stats.preset, approved: false, qa_id: null, blend_file_id: out.blend_file_id, license_chain: base.license_chain, params: base.params }, out.file));
      // version() owns identity even when copying an old version.
      if (t.params.manual) { a.status = 'manual'; a.manual_note = '请下载真实高模、低模和 .blend，人工处理后上传 GLB'; }
      else { a.status = 'qa'; delete a.manual_note; E.enqueue({ project_id: a.project_id, job_id: a.job_id, node: 'auto_qa', model_id: 'blender', queue: 'cpu', asset_id: a.id, version_id: v.id, params: {} }); }
    } else if (t.node === 'auto_qa') {
      const a = E.asset(t.asset_id), v = E.version(t.version_id); qa(a, v, out);
    } else if (t.node === 'export') {
      const ex = E.S.exports.find(x => x.id === t.export_id); Object.assign(ex, out, { status: 'done', done_at: Date.now() });
      ex.asset_ids.forEach(id => { const a = E.asset(id); if (a.status === 'library') a.status = 'exported'; });
    }
    t.status = 'done'; t.progress = 1; t.finished_at = Date.now(); t.elapsed = (t.finished_at - t.started_at) / 1000;
    const segment=E.S.schedule.findLast(s=>s.task_id===tid); if(segment)segment.end=t.finished_at;
    if(t.queue==='gpu')E.S.gpu.loaded=null;
    if(out.vram_peak_gb!=null)t.vram_peak=out.vram_peak_gb;
    t.log.push('真实产物已保存，耗时 ' + t.elapsed.toFixed(1) + ' 秒'); E.emit('task.state', { task_id: tid, status: 'done' }); return true;
  };
  E.productionFail = function (tid, error, oom) {
    const t = E.task(tid); if (t.status !== 'running') return;
    t.log.push(error); t.error = error; t.finished_at = Date.now();
    const segment=E.S.schedule.findLast(s=>s.task_id===tid); if(segment)segment.end=t.finished_at;
    if(t.queue==='gpu')E.S.gpu.loaded=null;
    if (oom && t.node === 'image_to_3d' && t.oom_retry < 1 && t.params.resolution > 512) {
      t.oom_retry++; t.params.resolution = 512; t.params.preview_render = false; t.status = 'queued'; t.progress = 0;
    } else if (!oom && t.retry_count < 1 && !['mesh_fix', 'manual_import'].includes(t.node)) { t.retry_count++; t.status = 'queued'; t.progress = 0; }
    else { t.status = oom ? 'manual' : 'failed'; if (t.asset_id) { E.asset(t.asset_id).status = 'manual'; E.asset(t.asset_id).manual_note = error; } E.alert('error', t.code + '：' + error, 'queue'); }
    if(t.export_id){const ex=E.S.exports.find(e=>e.id===t.export_id);ex.status=t.status;ex.error=error;}
    E.emit('task.state', { task_id: tid, status: t.status, reason: error }); return t;
  };
  E.productionMetrics = function (data) {
    E.S.runtime = Object.assign(E.S.runtime, data.runtime || {});
    if (data.gpu) { const g = Object.assign({ t: Date.now() }, data.gpu); E.S.gpu.history.push(g); E.S.gpu.history = E.S.gpu.history.slice(-900); Object.assign(E.S.gpu, { util: g.util, temp: g.temp, power: g.power }); E.emit('gpu.metrics', g); }
    if (data.storage) E.S.settings.storage = Object.assign(E.S.settings.storage, data.storage);
  };
})(typeof window !== 'undefined' ? window : globalThis);
