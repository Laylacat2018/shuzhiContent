/* 空间内容工场 · 前端外壳与公共组件（Vue 3） */
(function (global) {
  'use strict';
  const { reactive, ref, computed, watch, onMounted, onUnmounted, nextTick, h } = Vue;
  const E = global.Engine, Geo = global.Geo, V = global.Viewers, D = E.dict;
  const st = reactive({ rev: 0, route: 'workbench', params: {}, toasts: [], modal: null, logged: false, drawer: null, booting: true, theme: '' });
  global.SCW = { st };

  // ---------- 工具 ----------
  const U = {
    n: (x) => x == null ? '—' : Number(x).toLocaleString('zh-CN'),
    k: (x) => x == null ? '—' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e4 ? (x / 1e3).toFixed(1) + 'K' : String(x),
    pct: (x) => x == null ? '—' : Math.round(x * 100) + '%',
    time: (t) => t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—',
    dt: (t) => t ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—',
    ago: (t) => { if (!t) return '—'; const s = (E.S.clock - t) / 1000; if (s < 60) return '刚刚'; if (s < 3600) return Math.floor(s / 60) + ' 分钟前'; if (s < 86400) return Math.floor(s / 3600) + ' 小时前'; return Math.floor(s / 86400) + ' 天前'; },
    dur: (s) => E.fmtDur(s || 0),
    taskPill: (s) => ({ queued: 'info', running: 'run', paused: 'plain', failed: 'err', manual: 'warn', done: 'ok', canceled: 'plain' }[s] || ''),
    assetPill: (s) => ({ generating: 'run', generated: 'info', optimizing: 'run', qa: 'run', review: 'warn', rework: 'warn', manual: 'err', library: 'ok', exported: 'ok', discarded: 'plain' }[s] || ''),
    jobPill: (s) => ({ draft: 'plain', submitted: 'info', producing: 'run', done: 'ok', canceled: 'plain' }[s] || ''),
    licTag: (m, project) => { const r = E.modelAllowed(m, project); const mm = typeof m === 'string' ? E.model(m) : m; return { cls: r.ok ? 'lic-ok' : (mm && mm.allowed_scope === 'disabled' ? 'lic-err' : 'lic-warn'), text: (mm ? mm.license_type : '—'), ok: r.ok, reason: r.reason }; },
    loc: (m) => ({ local: '本地 GPU', 'local-cpu': '本地 CPU', cloud: '云 GPU', api: '商业 API' }[m.location] || m.location),
    color: (key) => { const h = Geo.hash(key || 'x') % 360; return `hsl(${h} 42% 42%)`; },
    stats: (v) => v ? (v.opt || v.raw || {}) : {},
    thumbOf: (a) => { if (!a) return ''; const v = E.cur(a); if (!v) return ''; if (a.type === 'prop') { const s = v.opt || v.raw; return V.thumbnail({ category: v.category, seed: v.seed, tris: s.tris, texture: 256 }); } if (a.type === 'world' && v.pano_id) { const p = E.S.panoramas.find(x => x.id === v.pano_id); return p ? V.panoCanvas(p, 512).toDataURL('image/jpeg', 0.7) : ''; } return reconThumb(a); },
  };
  let reconThumbUrl = null;
  function reconThumb() {
    if (reconThumbUrl) return reconThumbUrl;
    const c = document.createElement('canvas'); c.width = c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#1d2624'; x.fillRect(0, 0, 200, 200);
    const sp = Geo.buildSplats(7, 6000, false, true); for (let i = 0; i < sp.count; i++) { const px = sp.positions[i * 3], py = sp.positions[i * 3 + 1], pz = sp.positions[i * 3 + 2]; const sx = 100 + (px - pz * 0.5) * 17, sy = 160 - py * 30 - pz * 6; x.fillStyle = `rgb(${sp.colors[i * 3] * 255 | 0},${sp.colors[i * 3 + 1] * 255 | 0},${sp.colors[i * 3 + 2] * 255 | 0})`; x.fillRect(sx, sy, 1.6, 1.6); }
    reconThumbUrl = c.toDataURL(); return reconThumbUrl;
  }
  global.U = U;
  function toast(msg, kind) { const t = { id: Math.random(), msg, kind: kind || '' }; st.toasts.push(t); setTimeout(() => { const i = st.toasts.indexOf(t); if (i >= 0) st.toasts.splice(i, 1); }, kind === 'err' ? 6000 : 3200); }
  // 执行业务动作：统一捕获业务规则异常并提示
  function act(fn, okMsg) { try { const r = fn(); st.rev++; E.save(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; } catch (e) { if (e instanceof E.BizError) toast(e.message, 'err'); else { console.error(e); toast('操作失败：' + e.message, 'err'); } return undefined; } }
  function go(route, params) { st.route = route; st.params = params || {}; try { if (location.hash !== '#' + route) history.replaceState(null, '', '#' + route); } catch (e) { location.hash = route; } const m = document.querySelector('.main'); if (m) m.scrollTop = 0; }
  function confirmBox(o) { return new Promise(res => { st.modal = Object.assign({ ok: '确认', cancel: '取消' }, o, { resolve: (v) => { st.modal = null; res(v); } }); }); }
  const ARTIFACT = global.SCW_MODE === 'artifact';
  async function saveFile(name, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    if (ARTIFACT) {
      // 在线验收环境：通过 downloads 能力保存；非白名单格式（glb / hdr / bvh / ply）打包为 zip
      let dl = null; try { dl = global.claude && global.claude.use ? await global.claude.use('downloads') : null; } catch (e) { dl = null; }
      if (!dl) { toast(`当前查看方式不支持下载，已生成「${name}」（${(blob.size / 1024).toFixed(1)} KB）。部署到服务器后可直接下载。`, 'warn'); return blob; }
      const ok = /\.(zip|png|json|txt|md|csv|html|pdf)$/i.test(name);
      let fname = name, data = blob;
      if (!ok) { const z = new JSZip(); z.file(name, blob); data = await z.generateAsync({ type: 'blob' }); fname = name + '.zip'; }
      try { await dl.save({ filename: fname, data }); toast('已保存 ' + fname); }
      catch (e) { if (e && e.code !== 'declined') toast('保存失败：' + (e.message || e.code), 'err'); }
      return blob;
    }
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000); toast('已下载 ' + name); return blob;
  }
  // ---------- 服务端模式：业务引擎在服务端运行，页面写操作经 /api/v1/rpc，状态每秒同步 ----------
  const SERVER = global.SCW_MODE === 'server';
  const RPC_FNS = ['createJob', 'updateJob', 'submitJob', 'cancelJob', 'deleteJob', 'taskAction', 'review', 'manualResolve', 'rollback', 'generateConcepts', 'selectConcepts', 'discardConcepts', 'regenerate3d', 'discardAsset', 'optimize', 'sendToQA', 'tagAssets', 'deleteAsset', 'generatePanoramas', 'fixSeam', 'upscalePano', 'submitWorld', 'createDataset', 'appendPhotos', 'solvePoses', 'trainGS', 'cleanRecon', 'finishRecon', 'createCharacter', 'rigCharacter', 'confirmWeights', 'genMotion', 'addClip', 'updateClip', 'removeClip', 'createScene', 'agentSend', 'agentConfirm', 'sceneConfirm', 'addStill', 'moveItem', 'scaleItem', 'addSceneItem', 'createExport', 'updateModel', 'registerModel', 'uploadLicense', 'confirmLicense', 'updateSettings', 'setRelease', 'setSpeed', 'autoFix', 'runQA', 'enqueue', 'audit', 'patch', 'togglePanoUse', 'readAlerts', 'stopCloudNode', 'setViewport', 'createProject'];
  const net = { token: '', uid: '', pid: '', ws: '', rev: -1, busy: false, password: '' };
  try { net.token = sessionStorage.getItem('scw.token') || ''; net.uid = sessionStorage.getItem('scw.uid') || ''; net.pid = sessionStorage.getItem('scw.pid') || ''; net.ws = sessionStorage.getItem('scw.ws') || ''; } catch (e) { }
  function persistNet() { try { sessionStorage.setItem('scw.token', net.token); sessionStorage.setItem('scw.uid', net.uid); sessionStorage.setItem('scw.pid', net.pid); sessionStorage.setItem('scw.ws', net.ws); } catch (e) { } }
  // 同步请求：页面动作需要立即拿到返回值（例如新建对象的编号），与浏览器内引擎的调用方式一致
  function xhr(method, url, body) {
    const x = new XMLHttpRequest(); x.open(method, url, false);
    x.setRequestHeader('Content-Type', 'application/json');
    if (net.token) x.setRequestHeader('Authorization', 'Bearer ' + net.token);
    if (net.pid) x.setRequestHeader('X-SCW-Project', net.pid);
    try { x.send(body ? JSON.stringify(body) : null); } catch (e) { throw new E.BizError('无法连接服务器，请检查网络', 'network'); }
    let data = null; try { data = x.responseText ? JSON.parse(x.responseText) : null; } catch (e) { }
    if (x.status === 401) { net.token = ''; persistNet(); st.logged = false; throw new E.BizError('登录已过期，请重新登录', 'auth'); }
    if (x.status >= 400) throw new E.BizError((data && data.detail) || ('服务器错误 ' + x.status), (data && data.code) || 'server');
    return data;
  }
  function applyState(S) {
    if (!S) return;
    if (net.pid && S.projects.some(p => p.id === net.pid)) S.currentProjectId = net.pid; else net.pid = S.currentProjectId;
    if (net.uid) S.currentUserId = net.uid;
    E.S = S; st.rev++;
  }
  function serverLogin(uid, password, ws) {
    const r = xhr('POST', '/api/v1/auth/login', { user_id: uid, password, workspace: ws || net.ws || undefined });
    net.token = r.token; net.uid = uid; net.ws = r.workspace; net.password = password; persistNet();
    pull(true);
    return r;
  }
  function pull(sync) {
    if (sync) { const x = new XMLHttpRequest(); x.open('GET', '/api/v1/state', false); x.setRequestHeader('Authorization', 'Bearer ' + net.token); x.send(); if (x.status === 401) { st.logged = false; return false; } if (x.status !== 200) return false; net.rev = +x.getResponseHeader('X-SCW-Rev'); applyState(JSON.parse(x.responseText)); return true; }
    if (net.busy || !net.token) return;
    net.busy = true;
    fetch('/api/v1/state?since=' + net.rev, { headers: { Authorization: 'Bearer ' + net.token } })
      .then(r => { if (r.status === 401) { st.logged = false; return null; } net.rev = +(r.headers.get('X-SCW-Rev') || -1); return r.status === 200 ? r.json() : null; })
      .then(S => { if (S) applyState(S); }).catch(() => { }).finally(() => { net.busy = false; });
  }
  function installServerEngine() {
    RPC_FNS.forEach(fn => {
      E[fn] = function () {
        const r = xhr('POST', '/api/v1/rpc', { fn, args: Array.prototype.slice.call(arguments) });
        net.rev = r.rev; applyState(r.state);
        return r.result;
      };
    });
    E.reset = function () { const r = xhr('POST', '/api/v1/rpc', { fn: 'reset', args: [] }); net.rev = r.rev; applyState(r.state); };
    E.save = function () { };
    E.tick = function () { };
  }
  Object.assign(global.SCW, { toast, act, go, confirmBox, saveFile, U, ARTIFACT, SERVER, net, serverLogin });

  // ---------- 公共组件 ----------
  const C = {};
  C.Pill = { props: ['kind', 'text'], template: `<span class="pill" :class="kind">{{ text }}</span>` };
  C.Switch = { props: ['modelValue', 'disabled'], emits: ['update:modelValue'], template: `<label class="switch"><input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit('update:modelValue', $event.target.checked)"><span></span></label>` };
  C.Steps = { props: ['steps', 'cur', 'click'], emits: ['go'], template: `<div class="steps" :class="{click}"><button type="button" v-for="(s,i) in steps" :key="i" class="st" :class="{done:i<cur,cur:i===cur}" @click="click && $emit('go',i)"><b>{{ i < cur ? '✓' : i+1 }}</b>{{ s }}</button></div>` };
  C.Progress = { props: ['v', 'kind'], template: `<div class="progress" :class="kind"><i :style="{width: Math.round((v||0)*100)+'%'}"></i></div>` };
  C.PageHead = { props: ['code', 'title', 'goal', 'ver'], template: `<div class="page-head"><div><span class="pcode">{{ code }} · {{ ver }}</span><h1>{{ title }}</h1><div class="goal">{{ goal }}</div></div><div class="actions"><slot></slot></div></div>` };
  C.VramChart = {
    props: ['history', 'height', 'minutes'],
    setup(p) {
      const W = 640;
      const model = computed(() => {
        const H = p.height || 120, hist = p.history || [], mins = p.minutes || 30, t1 = E.S.clock, t0 = t1 - mins * 60000;
        const pts = hist.filter(x => x.t >= t0);
        const X = (t) => 34 + (t - t0) / (t1 - t0) * (W - 44), Y = (v) => 8 + (1 - v / 24) * (H - 26);
        const line = pts.map((x, i) => (i ? 'L' : 'M') + X(x.t).toFixed(1) + ' ' + Y(x.vram).toFixed(1)).join(' ');
        const area = pts.length ? line + ` L${X(pts[pts.length - 1].t).toFixed(1)} ${Y(0)} L${X(pts[0].t).toFixed(1)} ${Y(0)} Z` : '';
        const last = pts[pts.length - 1];
        const ticks = []; for (let m = 0; m <= mins; m += mins / 3) ticks.push({ x: X(t0 + m * 60000), label: m === mins ? '现在' : '-' + (mins - m) + ' 分' });
        return { H, line, area, last, ticks, Y, X };
      });
      return { model, W };
    },
    template: `<svg class="mini-chart" :viewBox="'0 0 '+W+' '+model.H" role="img" aria-label="GPU 显存曲线">
      <g v-for="g in [0,8,16,24]" :key="g"><line :x1="34" :x2="W-10" :y1="model.Y(g)" :y2="model.Y(g)" stroke="var(--line)" stroke-width="1"/><text :x="28" :y="model.Y(g)+3" text-anchor="end">{{ g }}G</text></g>
      <line :x1="34" :x2="W-10" :y1="model.Y(24)" :y2="model.Y(24)" stroke="var(--err)" stroke-dasharray="4 3" stroke-width="1.2"/>
      <text :x="W-12" :y="model.Y(24)-3" text-anchor="end" style="fill:var(--err)">上限 24GB</text>
      <path :d="model.area" fill="var(--accent)" fill-opacity=".14"/>
      <path :d="model.line" fill="none" stroke="var(--accent)" stroke-width="1.6"/>
      <circle v-if="model.last" :cx="model.X(model.last.t)" :cy="model.Y(model.last.vram)" r="3.2" fill="var(--accent)"/>
      <text v-for="t in model.ticks" :key="t.label" :x="t.x" :y="model.H-4" text-anchor="middle">{{ t.label }}</text>
    </svg>`,
  };
  C.LineChart = {
    props: ['values', 'height', 'unit', 'max', 'min'],
    setup(p) {
      const W = 320;
      const m = computed(() => { const H = p.height || 80; const vs = p.values || []; const mx = p.max ?? Math.max(1, ...vs), mn = p.min ?? 0; const X = (i) => 26 + i / Math.max(1, vs.length - 1) * (W - 34), Y = (v) => 6 + (1 - (v - mn) / (mx - mn || 1)) * (H - 18); return { H, d: vs.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' '), Y, mx, mn, last: vs.length ? { x: X(vs.length - 1), y: Y(vs[vs.length - 1]), v: vs[vs.length - 1] } : null }; });
      return { m, W };
    },
    template: `<svg class="mini-chart" :viewBox="'0 0 '+W+' '+m.H"><line x1="26" :x2="W-8" :y1="m.Y(m.mn)" :y2="m.Y(m.mn)" stroke="var(--line)"/><line x1="26" :x2="W-8" :y1="m.Y(m.mx)" :y2="m.Y(m.mx)" stroke="var(--line)" stroke-dasharray="3 3"/><text x="22" :y="m.Y(m.mx)+3" text-anchor="end">{{ m.mx }}</text><text x="22" :y="m.Y(m.mn)+3" text-anchor="end">{{ m.mn }}</text><path :d="m.d" fill="none" stroke="var(--bronze)" stroke-width="1.6"/><circle v-if="m.last" :cx="m.last.x" :cy="m.last.y" r="3" fill="var(--bronze)"/></svg>`,
  };
  // 单件资产视口
  C.AssetView = {
    props: ['info', 'mode', 'height', 'syncWith'],
    emits: ['ready'],
    setup(p, { emit }) {
      const el = ref(null); let vw = null; const meta = ref(null);
      const draw = () => { if (!vw || !p.info) return; const m = vw.show(p.info, p.mode || 'solid'); meta.value = { tris: m.tris, verts: m.verts }; };
      onMounted(() => { try { vw = new V.AssetViewer(el.value, {}); emit('ready', vw); draw(); } catch (e) { console.error(e); } });
      onUnmounted(() => { vw && vw.dispose(); });
      watch(() => p.info && JSON.stringify(p.info), () => draw());
      watch(() => p.mode, () => vw && p.info && vw.setMode(p.mode));
      return { el, meta, reset: () => vw && vw.reset(), get vw() { return vw; } };
    },
    template: `<div class="viewport" :style="{height: (height||360)+'px'}"><div ref="el" style="position:absolute;inset:0"></div><div v-if="!info" class="vp-empty">选择一件资产以在视口中查看</div><slot :meta="meta"></slot></div>`,
  };
  C.Modal = {
    setup() { return { st }; },
    template: `<template v-if="st.modal"><div class="drawer-mask" @click="st.modal.resolve(false)"></div><div class="modal" role="dialog" aria-modal="true"><header>{{ st.modal.title }}</header><div class="mbody"><div v-if="st.modal.html" v-html="st.modal.html"></div><div v-else style="white-space:pre-wrap">{{ st.modal.text }}</div><pre v-if="st.modal.code" class="code">{{ st.modal.code }}</pre><div v-if="st.modal.input!==undefined" class="field"><label>{{ st.modal.inputLabel }}</label><textarea class="inp" v-model="st.modal.input" id="modal-input"></textarea></div></div><footer><button class="btn" @click="st.modal.resolve(false)">{{ st.modal.cancel }}</button><button class="btn" :class="st.modal.danger?'danger':'primary'" @click="st.modal.resolve(st.modal.input!==undefined ? st.modal.input : true)">{{ st.modal.ok }}</button></footer></div></template>`,
  };
  C.Toasts = { setup() { return { st }; }, template: `<div class="toasts" aria-live="polite"><div v-for="t in st.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.msg }}</div></div>` };
  C.Locked = { props: ['ver'], setup() { return { E, go }; }, template: `<div class="panel locked"><h3 style="margin-bottom:6px">本页面属于 {{ ver }} 范围，当前发布范围为 {{ E.S.release }}</h3><p>管理员可在「系统设置 → 演示控制」中调整发布范围。</p></div>` };

  // ---------- 导航 ----------
  const NAV = [
    { g: '总览', items: [{ r: 'workbench', code: 'P01', name: '工作台', ver: 'V1.0' }, { r: 'jobs', code: 'P02', name: '需求单', ver: 'V1.0' }] },
    { g: '生产', items: [{ r: 'concepts', code: 'P03', name: '概念图', ver: 'V1.0' }, { r: 'gen3d', code: 'P04', name: '3D 资产生成', ver: 'V1.0' }, { r: 'optimize', code: 'P05', name: '资产优化', ver: 'V1.0' }, { r: 'scenes', code: 'P06', name: '场景生成', ver: 'V1.1' }, { r: 'recon', code: 'P07', name: '实景重建', ver: 'V1.1' }, { r: 'character', code: 'P08', name: '角色与动画', ver: 'V1.2' }, { r: 'assembly', code: 'P09', name: '场景组装', ver: 'V1.1' }] },
    { g: '交付', items: [{ r: 'review', code: 'P10', name: '质检审核', ver: 'V1.0' }, { r: 'library', code: 'P11', name: '资产库', ver: 'V1.0' }, { r: 'export', code: 'P12', name: '导出发布', ver: 'V1.0' }] },
    { g: '系统', items: [{ r: 'queue', code: 'P13', name: '任务队列', ver: 'V1.0' }, { r: 'system', code: 'P14', name: '系统设置', ver: 'V1.0', admin: true }] },
  ];
  const ROUTES = NAV.flatMap(g => g.items);

  const Shell = {
    setup() {
      const pageComp = computed(() => 'page-' + st.route);
      const item = computed(() => ROUTES.find(r => r.r === st.route) || ROUTES[0]);
      const top = computed(() => { st.rev; const g = E.S.gpu; const last = g.history[g.history.length - 1] || { vram: 0 }; const s = E.stats(); return { vram: last.vram, model: g.swapping ? '换载中 → ' + E.model(g.swapping.to).name : g.loaded ? E.model(g.loaded).name : '无', queue: s.queue, review: s.pendingReview, gpuQ: s.queueGpu }; });
      const alerts = computed(() => { st.rev; return E.S.alerts.filter(a => !a.read).length; });
      const locked = computed(() => D.VERSION_ORDER[item.value.ver] > D.VERSION_ORDER[E.S.release]);
      const role = computed(() => { st.rev; return E.user().role; });
      const switchUser = (uid) => { if (SERVER) { try { serverLogin(uid, net.password || 'demo-2026'); } catch (e) { toast(e.message, 'err'); return; } toast('已切换为 ' + E.user().name + '（' + D.ROLES[E.user().role] + '）'); return; } E.S.currentUserId = uid; E.audit('切换账号', E.user().name, D.ROLES[E.user().role]); st.rev++; E.save(); toast('已切换为 ' + E.user().name + '（' + D.ROLES[E.user().role] + '）'); };
      const switchProject = (pid) => { if (SERVER) { net.pid = pid; persistNet(); } E.S.currentProjectId = pid; st.rev++; E.save(); toast('已切换项目：' + E.project().name); };
      const logout = () => { st.logged = false; net.token = ''; persistNet(); try { sessionStorage.removeItem('scw.logged'); } catch (e) { } };
      const theme = () => { const cur = document.documentElement.getAttribute('data-theme'); const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark'); };
      return { st, E, D, NAV, pageComp, item, top, alerts, locked, role, go, switchUser, switchProject, logout, theme, U };
    },
    template: `
    <div class="shell" :data-r="st.rev">
      <header class="topbar">
        <div class="brand"><div class="brand-mark"></div><div>空间内容工场<br><small>AIGC SPATIAL CONTENT WORKS</small></div></div>
        <div class="top-stats">
          <select class="inp" style="width:auto;max-width:240px" :value="E.S.currentProjectId" @change="switchProject($event.target.value)" aria-label="当前项目" id="project-switch">
            <option v-for="p in E.S.projects" :key="p.id" :value="p.id">{{ p.name }} · {{ D.SCOPES[p.usage_scope] }}</option>
          </select>
          <span class="chip" title="RTX 4090 24GB"><span>GPU</span><span class="vram-bar"><i :style="{width: (top.vram/24*100)+'%', background: top.vram>22?'var(--err)':''}"></i></span><b class="num">{{ top.vram.toFixed(1) }}/24GB</b></span>
          <span class="chip hide-sm">已加载 <b>{{ top.model }}</b></span>
          <button class="chip" style="cursor:pointer" @click="go('queue')">队列 <b class="num">{{ top.queue }}</b></button>
          <button class="chip" style="cursor:pointer" @click="go('workbench')">提醒 <b class="num" :style="{color: alerts ? 'var(--err)' : ''}">{{ alerts }}</b></button>
        </div>
        <div class="top-right">
          <select class="inp" style="width:auto" :value="E.S.currentUserId" @change="switchUser($event.target.value)" aria-label="切换账号" id="user-switch">
            <option v-for="u in E.S.users" :key="u.id" :value="u.id">{{ u.name }} · {{ D.ROLES[u.role] }}</option>
          </select>
          <button class="btn sm ghost" @click="theme" title="切换明暗">◐</button>
          <button class="btn sm ghost" @click="logout">退出</button>
        </div>
      </header>
      <nav class="sidebar" aria-label="页面导航">
        <div class="nav-group" v-for="g in NAV" :key="g.g"><div>{{ g.g }}</div>
          <button v-for="it in g.items" :key="it.r" class="nav-item" :class="{active: st.route===it.r}" @click="go(it.r)" v-show="!it.admin || role==='admin'" :data-route="it.r">
            <span class="code">{{ it.code }}</span>{{ it.name }}
            <span v-if="it.r==='review' && top.review" class="cnt">{{ top.review }}</span>
            <span v-else class="ver">{{ it.ver }}</span>
          </button>
        </div>
      </nav>
      <main class="main">
        <c-locked v-if="locked" :ver="item.ver" style="margin:18px"></c-locked>
        <div v-else-if="item.admin && role!=='admin'" class="page"><div class="panel locked"><h3>仅管理员可访问系统设置</h3><p>请在右上角切换为管理员账号。</p></div></div>
        <component v-else :is="pageComp" :key="st.route"></component>
      </main>
    </div>`,
  };

  const Login = {
    setup() {
      const uid = ref('u_pm'); const canvas = ref(null); let raf; const pw = ref('demo-2026'); const wsName = ref(net.ws || 'default'); const err = ref('');
      const enter = () => { if (SERVER) { err.value = ''; try { serverLogin(uid.value, pw.value, wsName.value.trim().toLowerCase()); st.logged = true; } catch (e) { err.value = e.message; } return; } E.S.currentUserId = uid.value; E.audit('登录', E.user().name, D.ROLES[E.user().role] + '（演示账号，JWT 由部署版后端签发）'); st.logged = true; try { sessionStorage.setItem('scw.logged', '1'); } catch (e) { } E.save(); };
      onMounted(() => {
        const c = canvas.value; const x = c.getContext('2d'); const pts = []; const R = Geo.rng(42);
        for (let i = 0; i < 900; i++) pts.push([R() * 2 - 1, R() * 2 - 1, R() * 2 - 1, R()]);
        const loop = (t) => { raf = requestAnimationFrame(loop); const w = c.width = c.clientWidth, hh = c.height = c.clientHeight; x.fillStyle = '#10201b'; x.fillRect(0, 0, w, hh); const a = t / 9000; for (const p of pts) { const X = p[0] * Math.cos(a) - p[2] * Math.sin(a), Z = p[0] * Math.sin(a) + p[2] * Math.cos(a) + 2.6; const sx = w / 2 + X / Z * w * 0.6, sy = hh * 0.42 + p[1] * 0.55 / Z * w * 0.6; x.fillStyle = p[3] > 0.7 ? 'rgba(212,155,85,.85)' : 'rgba(79,179,157,.6)'; const s = 2.4 / Z; x.fillRect(sx, sy, s, s); } };
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) raf = requestAnimationFrame(loop); else loop(0);
      });
      onUnmounted(() => cancelAnimationFrame(raf));
      return { uid, enter, canvas, E, D, pw, wsName, err, SERVER };
    },
    template: `<div class="login">
      <div class="art"><canvas ref="canvas" aria-hidden="true"></canvas>
        <span class="tag ver" style="align-self:flex-start;background:rgba(0,0,0,.3)">V1.0 · 道具资产闭环 / V1.1 / V1.2</span>
        <h1>空间内容工场</h1>
        <p>面向文旅与沉浸式项目团队的本地化 AIGC 空间内容生产平台：需求单 → 概念图 → 3D 资产 → 优化 → 质检 → 入库 → 组装 → 导出。单张 RTX 4090 自动排程，许可证、文博准确性与 AIGC 标识贯穿全流程。</p>
      </div>
      <form class="form" @submit.prevent="enter">
        <h2 style="font-family:var(--f-display);font-size:22px">登录</h2>
        <div class="note">{{ SERVER ? '选择账号登录（演示密码 demo-2026，可由管理员通过环境变量修改）。登录后可在右上角切换账号，体验不同角色的权限。' : '演示环境：选择一个角色登录，可随时在右上角切换账号，体验不同角色的权限。' }}</div>
        <div class="role-pick">
          <button type="button" v-for="u in E.S.users" :key="u.id" :class="{on: uid===u.id}" @click="uid=u.id"><b>{{ u.name }}</b><span>{{ D.ROLES[u.role] }}</span></button>
        </div>
        <div class="field"><label for="pw">密码</label><input id="pw" class="inp" type="password" v-model="pw" autocomplete="off"></div>
        <div class="field" v-if="SERVER"><label for="ws">工作区</label><input id="ws" class="inp" v-model="wsName" placeholder="default"><span class="faint small">同一工作区的同事共享需求单、资产库与任务队列；对外演示可另开工作区（如 demo-zhang），互不干扰。</span></div>
        <div class="note err" v-if="err">{{ err }}</div>
        <button class="btn primary" type="submit" id="login-btn" style="padding:9px">进入平台</button>
        <p class="faint small">局域网访问 · 账号登录 · 角色权限（PRD 第 2 章权限矩阵）</p>
      </form>
    </div>`,
  };

  // ---------- 启动 ----------
  global.SCW.boot = function (pages) {
    const app = Vue.createApp({
      setup() { return { st }; },
      template: `<div v-if="st.booting" class="boot">正在初始化演示数据…</div><template v-else><c-login v-if="!st.logged"></c-login><c-shell v-else></c-shell></template><c-modal></c-modal><c-toasts></c-toasts>`,
    });
    const reg = (name, c) => app.component(name, c);
    reg('c-pill', C.Pill); reg('c-switch', C.Switch); reg('c-steps', C.Steps); reg('c-progress', C.Progress); reg('c-head', C.PageHead); reg('c-vram', C.VramChart); reg('c-line', C.LineChart); reg('c-asset-view', C.AssetView); reg('c-modal', C.Modal); reg('c-toasts', C.Toasts); reg('c-locked', C.Locked); reg('c-shell', Shell); reg('c-login', Login);
    Object.entries(pages).forEach(([k, c]) => reg('page-' + k, c));
    app.config.globalProperties.st = st; app.config.globalProperties.E = E; app.config.globalProperties.D = D; app.config.globalProperties.U = U; app.config.globalProperties.go = go;
    app.config.errorHandler = (err) => { console.error(err); toast('页面错误：' + err.message, 'err'); };
    app.mount('#app');
    setTimeout(() => {
      const h = (location.hash || '').replace('#', ''); if (ROUTES.some(r => r.r === h)) st.route = h;
      if (SERVER) {
        installServerEngine();
        E.S = { users: [{ id: 'u_pm', name: '林策划', role: 'pm' }, { id: 'u_art', name: '周美术', role: 'artist' }, { id: 'u_rev', name: '陈审核', role: 'reviewer' }, { id: 'u_admin', name: '王管理', role: 'admin' }] };
        st.logged = !!net.token && pull(true);
        st.booting = false;
        setInterval(() => { if (st.logged) pull(false); }, 1000);
      } else {
        E.init();
        try { st.logged = sessionStorage.getItem('scw.logged') === '1'; } catch (e) { }
        st.booting = false;
        let last = performance.now(), lastSave = 0;
        setInterval(() => { const now = performance.now(); E.tick(now - last); last = now; st.rev++; if (now - lastSave > 4000) { E.save(); lastSave = now; } }, 500);
      }
      window.addEventListener('hashchange', () => { const r = location.hash.replace('#', ''); if (ROUTES.some(x => x.r === r) && r !== st.route) st.route = r; });
    }, 30);
  };
  global.SCW.C = C; global.SCW.NAV = NAV;
})(window);
