/* P10–P14 */
(function (global) {
  'use strict';
  const { ref, shallowRef, reactive, computed, watch, onMounted, onUnmounted, nextTick } = Vue;
  const E = global.Engine, Geo = global.Geo, V = global.Viewers, D = E.dict, { st, act, go, toast, confirmBox, saveFile, U } = global.SCW;
  const P = global.SCW_PAGES = global.SCW_PAGES || {};

  // ---------- GLB / 交付包 ----------
  async function assetGLB(a, opts) {
    const v = E.cur(a); const s = v.opt || v.raw;
    if (v.file_url) { const r = await fetch(v.file_url); if (!r.ok) throw new Error('真实文件读取失败'); return new Uint8Array(await r.arrayBuffer()); }
    if (st.production) throw new Error('该版本缺少真实文件');
    const mesh = Geo.buildMesh({ category: v.category, seed: v.seed, defects: v.defects || {} }, s.target || s.tris);
    let avgM = 0, avgR = 0; for (let i = 0; i < mesh.verts; i++) { avgM += mesh.mr[i * 2]; avgR += mesh.mr[i * 2 + 1]; } avgM /= mesh.verts; avgR /= mesh.verts;
    const mark = a.source === '生成' && v.aigc_mark ? { AIGC: { label: (a.ai_restore ? 'AI 复原 · ' : '') + 'AI 生成', model: v.aigc_mark.model, time: v.aigc_mark.time, platform: '空间内容工场' } } : {};
    const extras = Object.assign({ asset_code: a.code, version: v.version, seed: v.seed, license_chain: v.license_chain.map(c => `${c.stage}:${c.model_name}(${c.license})`) }, mark);
    return Geo.writeGLB([{ mesh, name: a.code, category: v.category, seed: v.seed, textureSize: (opts && opts.texture) || Math.min(s.texture || 1024, 1024), metallic: avgM, roughness: avgR, extras }], { assetExtras: extras, sceneName: a.name });
  }
  async function sceneGLB(sc) {
    const items = [];
    for (const it of sc.items) { const v = E.version(it.version_id); const s = v.opt || v.raw; const mesh = Geo.buildMesh({ category: v.category, seed: v.seed, defects: {} }, s.target || s.tris); const a = E.asset(it.asset_id); items.push({ mesh, name: it.name, category: v.category, seed: v.seed, textureSize: 512, translation: it.pos, rotationY: it.rotY, scale: it.scale, extras: a.source === '生成' ? { AIGC: { label: 'AI 生成', model: v.aigc_mark.model, asset_code: a.code } } : { asset_code: a.code } }); }
    return Geo.writeGLB(items, { sceneName: sc.name, sceneExtras: { scene_code: sc.code }, assetExtras: { AIGC: { contains_generated: true, platform: '空间内容工场' } } });
  }
  // 轻量结构校验（完整 glTF-Validator 在部署版 / 自测脚本中执行）
  function glbCheck(bytes) {
    const issues = []; const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x46546C67) issues.push('magic 不是 glTF'); if (dv.getUint32(4, true) !== 2) issues.push('版本不是 2');
    if (dv.getUint32(8, true) !== bytes.byteLength) issues.push('长度不一致');
    const j = Geo.readGLBJson(bytes); const binLen = dv.getUint32(20 + dv.getUint32(12, true), true);
    j.bufferViews.forEach((bv, i) => { if (bv.byteOffset + bv.byteLength > binLen) issues.push('bufferView ' + i + ' 越界'); if (bv.byteOffset % 4) issues.push('bufferView ' + i + ' 未对齐'); });
    j.accessors.forEach((ac, i) => { const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[ac.type] * 4 * ac.count; if (n > j.bufferViews[ac.bufferView].byteLength) issues.push('accessor ' + i + ' 越界'); });
    return { ok: !issues.length, issues, json: j, tris: j.accessors.filter((a, i) => j.meshes.some(m => m.primitives.some(p => p.indices === i))).reduce((s, a) => s + a.count / 3, 0) };
  }
  global.SCW.assetGLB = assetGLB; global.SCW.sceneGLB = sceneGLB; global.SCW.glbCheck = glbCheck;
  function viewerHTML(name) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} · WebXR 查看页</title>
<style>html,body{margin:0;height:100%;background:#1b2321;color:#e3ebe8;font-family:system-ui,sans-serif}#info{position:fixed;left:12px;bottom:12px;font-size:12px;opacity:.8}</style>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script><script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script><script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script><script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/webxr/VRButton.js"></script></head>
<body><div id="info">${name} · 空间内容工场导出 · 含 AIGC 生成内容</div><script>
const r=new THREE.WebGLRenderer({antialias:true});r.setSize(innerWidth,innerHeight);r.outputEncoding=THREE.sRGBEncoding;r.xr.enabled=true;document.body.appendChild(r.domElement);document.body.appendChild(VRButton.createButton(r));
const s=new THREE.Scene();s.add(new THREE.HemisphereLight(0xffffff,0x444444,1.1));const d=new THREE.DirectionalLight(0xffffff,1.2);d.position.set(3,5,4);s.add(d);
const c=new THREE.PerspectiveCamera(50,innerWidth/innerHeight,0.01,100);c.position.set(3,2,4);const o=new THREE.OrbitControls(c,r.domElement);o.target.set(0,0.5,0);
new THREE.GLTFLoader().load('scene.glb',g=>s.add(g.scene));r.setAnimationLoop(()=>{o.update();r.render(s,c)});addEventListener('resize',()=>{c.aspect=innerWidth/innerHeight;c.updateProjectionMatrix();r.setSize(innerWidth,innerHeight)});
</script></body></html>`;
  }
  function blenderScript(files) {
    return `# 空间内容工场 · 原始工程导入脚本\n# 用法：blender -b -P blender_import.py -- 输出.blend\nimport bpy, sys, os\nhere = os.path.dirname(os.path.abspath(__file__))\nbpy.ops.wm.read_factory_settings(use_empty=True)\nfor f in ${JSON.stringify(files)}:\n    bpy.ops.import_scene.gltf(filepath=os.path.join(here, f))\nout = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(here, 'project.blend')\nbpy.ops.wm.save_as_mainfile(filepath=out)\nprint('saved', out)\n`;
  }
  async function buildPackage(ex) {
    if (ex.download_url) { const r = await fetch(ex.download_url); if (!r.ok) throw new Error('交付包读取失败'); return r.blob(); }
    if (E.S.runtime?.mode === 'production') throw new Error('真实导出任务尚未完成');
    const zip = new JSZip(); const list = [];
    const assets = ex.asset_ids.map(i => E.asset(i));
    for (const a of assets) { if (a.type === 'prop') { const b = await assetGLB(a); const n = `assets/${a.code}_v${E.cur(a).version}.glb`; zip.file(n, b); list.push(n); } else { const sp = Geo.buildSplats(Geo.hash(a.code), 5000, false, true); let ply = `ply\nformat ascii 1.0\nelement vertex ${sp.count}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`; for (let i = 0; i < sp.count; i++) ply += `${sp.positions[i * 3].toFixed(3)} ${sp.positions[i * 3 + 1].toFixed(3)} ${sp.positions[i * 3 + 2].toFixed(3)} ${sp.colors[i * 3] * 255 | 0} ${sp.colors[i * 3 + 1] * 255 | 0} ${sp.colors[i * 3 + 2] * 255 | 0}\n`; zip.file(`splats/${a.code}.ply`, ply); } }
    if (ex.object_type === 'scene') zip.file('scene.glb', await sceneGLB(E.scene(ex.object_id)));
    else if (assets.some(a => a.type === 'prop')) { const items = []; let x = 0; for (const a of assets.filter(a => a.type === 'prop')) { const v = E.cur(a); const s = v.opt || v.raw; items.push({ mesh: Geo.buildMesh({ category: v.category, seed: v.seed, defects: {} }, s.target || s.tris), name: a.code, category: v.category, seed: v.seed, textureSize: 512, translation: [x, 0, 0] }); x += 1.0; } zip.file('scene.glb', await Geo.writeGLB(items, { sceneName: ex.code })); }
    if (ex.targets.includes('webxr')) zip.file('index.html', viewerHTML(ex.code));
    if (ex.targets.includes('raw')) { zip.file('blender_import.py', blenderScript(list)); zip.file('project.json', JSON.stringify({ code: ex.code, assets: list }, null, 2)); }
    if (ex.targets.includes('quest')) zip.file('unity/Assets/SCW/ImportSettings.cs', '// 演示版：Unity 导入设置脚本（贴图 ASTC、网格压缩、XR 性能设置）\nusing UnityEditor;\npublic class SCWImport : AssetPostprocessor { void OnPreprocessTexture(){ var t=(TextureImporter)assetImporter; t.maxTextureSize=1024; } }\n');
    if (ex.targets.includes('xr_space')) zip.file('ue/Content/SCW/README.txt', '按 UE 命名规范整理的资产包：SM_<资产编号>，T_<资产编号>_BaseColor\n');
    if (ex.targets.includes('dome')) { const pn = E.S.panoramas.find(p => p.project_id === ex.project_id); if (pn) { const c = Geo.equirectToDome(V.panoCanvas(pn, 2048), 1024); const b = await new Promise(r => c.toBlob(r)); zip.file('domemaster.png', b); } }
    zip.file('manifest.json', JSON.stringify(ex.manifest, null, 2));
    const visible = ex.settings.aigcVisible !== false;
    zip.file('交付说明.txt', `交付包 ${ex.code}\n项目：${ex.manifest.project.name}（${ex.manifest.project.usage_scope}）\n导出目标：${ex.manifest.targets.join('、')}\n资产数：${ex.manifest.assets.length}\n${visible ? '本交付包包含人工智能生成内容（AIGC），已按规定添加隐式与显式标识。\n' : ''}${ex.deviceTested ? '已完成真机测试。' : '【未经真机验证】'}\n`);
    return zip.generateAsync({ type: 'blob' });
  }
  global.SCW.buildPackage = buildPackage;

  // ====================== P10 质检审核 ======================
  P.review = {
    setup() {
      const tab = ref('all');
      const list = computed(() => { st.rev; const base = E.S.assets.filter(a => a.project_id === E.S.currentProjectId && ['review', 'rework', 'manual', 'qa'].includes(a.status)); const L = tab.value === 'fail' ? base.filter(a => a.status === 'review' && E.qaOf(E.cur(a)) && !E.qaOf(E.cur(a)).passed) : tab.value === 'rework' ? base.filter(a => a.status === 'rework' || a.rework_count > 0 || a.status === 'manual') : base; return L.sort((a, b) => (a.review_since || 0) - (b.review_since || 0)); });
      const selId = ref(st.params.asset || (list.value[0] && list.value[0].id));
      watch(list, (l) => { if (!l.find(a => a.id === selId.value) && l[0]) selId.value = l[0].id; });
      const asset = computed(() => { st.rev; return selId.value && E.S.assets.find(a => a.id === selId.value); });
      const ver = computed(() => asset.value && E.cur(asset.value));
      const qa = computed(() => { st.rev; return ver.value && E.qaOf(ver.value); });
      const mode = ref('solid');
      const info = computed(() => { const v = ver.value; if (!v || asset.value.type !== 'prop') return null; const s = v.opt || v.raw; return { file_url: v.file_url, category: v.category, seed: v.seed, tris: s.target || s.tris, texture: s.texture, defects: v.defects }; });
      const reason = ref(''); const comment = ref('');
      const idx = computed(() => list.value.findIndex(a => a.id === selId.value));
      const step = (d) => { const l = list.value; if (!l.length) return; const i = (idx.value + d + l.length) % l.length; selId.value = l[i].id; reason.value = ''; comment.value = ''; };
      const failed = computed(() => qa.value ? qa.value.items.filter(i => i.result === 'fail') : []);
      const decide = async (dec) => {
        if (!asset.value) return;
        if (dec === 'rework' && !reason.value) return toast('返工必须选择原因', 'err');
        let c = comment.value;
        if (dec === 'pass' && failed.value.length && !c.trim()) { const r = await confirmBox({ title: '放行理由', text: `存在 ${failed.value.length} 项自动检查未通过：${failed.value.map(f => f.rule + ' ' + f.name).join('、')}。通过需要填写放行理由。`, input: '', inputLabel: '放行理由', ok: '通过并入库' }); if (!r) return; c = r; }
        const cur = asset.value.id;
        const ok = act(() => E.review(cur, dec, reason.value, c), { pass: '已通过并写入资产库', rework: '已返工，系统按原因重新排队', discard: '已废弃' }[dec]);
        if (ok) { reason.value = ''; comment.value = ''; }
      };
      const autofix = () => act(() => E.autoFix(asset.value.id), (r) => r.fixed ? (r.fixed.length ? `已修复：${r.fixed.join('、')}，已重检` : '没有可自动修复的项') : '已提交真实文件修复与重检');
      const onKey = (e) => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || st.modal) return; const k = e.key.toLowerCase(); if (k === 'a') decide('pass'); else if (k === 'r') { if (!reason.value) { toast('请先选择返工原因', 'warn'); document.getElementById('rw-reason') && document.getElementById('rw-reason').focus(); } else decide('rework'); } else if (k === 'd') decide('discard'); else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { step(1); e.preventDefault(); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { step(-1); e.preventDefault(); } };
      onMounted(() => window.addEventListener('keydown', onKey)); onUnmounted(() => window.removeEventListener('keydown', onKey));
      const job = computed(() => asset.value && asset.value.job_id && E.S.jobs.find(j => j.id === asset.value.job_id));
      const canReview = computed(() => { st.rev; return E.can('review'); });
      const canManual = computed(() => { st.rev; return E.can('manual.handle'); });
      const finishManual = async () => {
        if (E.S.runtime?.mode !== 'production') return act(() => E.manualResolve(asset.value.id, '人工修复后重新提交'), '已重新提交质检');
        try { const f = await global.SCW.chooseUpload('.glb'); if (f) act(() => E.manualResolve(asset.value.id, '上传人工修复 GLB', f), '已提交真实文件质检'); } catch (e) { toast(e.message, 'err'); }
      };
      const vref = shallowRef(null);
      return { tab, list, selId, asset, ver, qa, mode, info, reason, comment, idx, step, failed, decide, autofix, finishManual, job, canReview, canManual, vref, E, D, U, st, act };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P10" ver="V1.0" title="质检审核" goal="查看自动检查结果，对资产做通过、返工或废弃的决定。快捷键 A 通过 / R 返工 / D 废弃，方向键切换。"></c-head>
      <div class="note" v-if="!canReview" style="margin-bottom:12px">当前角色不能做审核结论（审核人、管理员可审核；3D 美术可处理返工与转人工）。</div>
      <div class="split3">
        <div class="panel"><header><div class="seg"><button v-for="t in [['all','全部'],['fail','未过'],['rework','返工']]" :key="t[0]" :class="{on:tab===t[0]}" @click="tab=t[0]">{{ t[1] }}</button></div><span class="sub right">{{ list.length }} 件</span></header>
          <div class="list" style="max-height:700px;overflow-y:auto" id="review-list"><button class="li" v-for="a in list" :key="a.id" :class="{sel: a.id===selId}" @click="selId=a.id" :data-id="a.id"><img :src="U.thumbOf(a)" alt=""><div class="grow"><div class="t1">{{ a.name }}</div><div class="t2">{{ a.code }} · <template v-if="E.qaOf(E.cur(a))">自动检查 {{ E.qaOf(E.cur(a)).items.filter(i=>i.result!=='fail').length }}/{{ E.qaOf(E.cur(a)).items.length }}</template><template v-else>质检中</template><template v-if="a.rework_count"> · 返工 {{ a.rework_count }}</template></div></div><c-pill :kind="U.assetPill(a.status)" :text="D.ASSET_STATUS[a.status]"></c-pill></button>
          <div v-if="!list.length" class="body muted">没有待审核资产</div></div></div>
        <div class="stack" style="min-width:0" v-if="asset">
          <c-asset-view v-if="asset.type==='prop'" :info="info" :mode="mode" :height="430" @ready="v=>vref=v">
            <template #default="{meta}"><div class="vp-tools"><div class="seg"><button v-for="m in [['solid','实体'],['wire','线框'],['uv','UV'],['issues','问题高亮']].filter(m=>!st.production || m[0]!=='issues')" :key="m[0]" :class="{on:mode===m[0]}" @click="mode=m[0]">{{ m[1] }}</button></div><span class="spacer"></span><button class="btn sm" @click="step(-1)">上一件</button><button class="btn sm" @click="step(1)">下一件</button></div>
            <div class="vp-overlay"><span>{{ asset.code }} · v{{ ver.version }}</span><span>{{ U.n(meta ? meta.tris : 0) }} 三角形</span><span v-if="mode==='issues'" style="color:var(--err)">红色：法线翻转　橙色：非流形边</span></div></template></c-asset-view>
          <div v-else class="viewport" style="height:300px"><img :src="U.thumbOf(asset)" style="width:100%;height:100%;object-fit:cover" alt=""><div class="vp-overlay"><span>{{ asset.type==='recon' ? '实景重建 3DGS' : '世界生成 3DGS' }} · {{ U.n(ver.splats) }} splat</span></div></div>
          <div class="panel"><header><h3>自动检查</h3><span class="sub" v-if="qa">{{ E.S.settings.presets[qa.preset_id].name }} · 用时 {{ qa.duration_s }} 秒</span><span class="right"><button class="btn sm" :disabled="!canReview || asset.status!=='review'" @click="autofix" id="btn-autofix">自动修复非流形并重检</button></span></header>
            <div class="tbl-wrap" v-if="qa"><table class="tbl"><thead><tr><th>规则</th><th>检查项</th><th>实测</th><th>阈值</th><th>级别</th><th>结果</th></tr></thead><tbody>
              <tr v-for="i in qa.items" :key="i.rule"><td class="mono">{{ i.rule }}</td><td>{{ i.name }}</td><td class="small">{{ typeof i.measured==='number' ? U.n(i.measured) : i.measured }}</td><td class="small muted">{{ i.limit }}</td><td><span class="tag">{{ i.level }}</span></td><td><span :class="'res-'+i.result">{{ {pass:'通过',fail:'未通过',warn:'警告'}[i.result] }}</span></td></tr></tbody></table></div>
            <div v-else class="body muted">质检中…</div></div>
        </div>
        <div class="stack" v-if="asset">
          <div class="panel"><header><h3>来源与许可链</h3></header><div class="body stack">
            <div v-for="c in ver.license_chain" :key="c.stage" class="row nowrap small" style="justify-content:space-between;border-bottom:1px dashed var(--line);padding-bottom:4px"><span class="muted" style="width:68px;flex:none">{{ c.stage }}</span><span style="flex:1;min-width:0">{{ c.model_name }}</span><span class="tag" :class="c.tool || E.modelAllowed(c.model_id, E.scopeOf(asset.project_id, asset.job_id)).ok ? 'lic-ok' : 'lic-err'">{{ c.license }}</span></div>
            <div class="kv small"><div>AIGC 标识</div><div><span v-if="ver.aigc_mark" class="tag ai">{{ asset.ai_restore ? 'AI 复原 · ' : '' }}AI 生成 · {{ ver.aigc_mark.model }}</span><span v-else class="muted">{{ asset.source }}类，不写入</span></div><div>需求单</div><div>{{ job ? job.code + ' ' + job.title : '—' }}</div><div>文物本体</div><div>{{ asset.heritage ? '是' : '否' }}</div><div>来源</div><div>{{ asset.source }}</div><div>seed</div><div class="mono">{{ ver.seed ?? '—' }}</div></div>
          </div></div>
          <div class="panel"><header><h3>人工审核</h3><span class="sub">返工 {{ asset.rework_count }} 次（超过 2 次自动转人工）</span></header><div class="body stack">
            <template v-if="asset.status==='manual'"><div class="note warn">{{ asset.manual_note || '重试仍失败，已转人工' }}</div><div class="row" v-if="ver.blend_file_id"><a class="btn" :href="'/api/v1/files/'+ver.blend_file_id" download>下载 .blend</a><a class="btn" :href="'/api/v1/files/'+ver.raw_file_id" download>下载高模</a><a class="btn" :href="ver.file_url" download>下载低模</a></div><button class="btn primary" :disabled="!canManual" @click="finishManual">人工处理完成，上传并提交</button></template>
            <template v-else-if="asset.status==='review'">
              <div class="field"><label for="rw-reason">返工原因（返工必选）</label><select id="rw-reason" class="inp" v-model="reason"><option value="">请选择</option><option v-for="(n,k) in D.REWORK_REASONS" :key="k" :value="k">{{ n }}（回到{{ ['geometry','style'].includes(k) ? '3D 生成' : '资产优化' }}）</option></select></div>
              <div class="field"><label for="rw-comment">备注{{ failed.length ? ' / 放行理由（有未通过项时通过必填）' : '' }}</label><textarea id="rw-comment" class="inp" v-model="comment" rows="2"></textarea></div>
              <div v-if="failed.some(f=>f.rule==='Q08'||f.rule==='Q09')" class="note err small">Q08 / Q09 未通过，不可放行。</div>
              <div class="row"><button class="btn danger" :disabled="!canReview" @click="decide('discard')" id="btn-discard">废弃 <kbd>D</kbd></button><button class="btn" :disabled="!canReview" @click="decide('rework')" id="btn-rework">返工 <kbd>R</kbd></button><button class="btn primary" :disabled="!canReview" @click="decide('pass')" id="btn-pass">通过并入库 <kbd>A</kbd></button></div>
            </template>
            <div v-else class="muted small">当前状态：{{ D.ASSET_STATUS[asset.status] }}，等待系统处理。</div>
            <div v-if="asset.history.length"><div class="lbl">审核记录</div><div v-for="(h,i) in asset.history.slice().reverse()" :key="i" class="small" style="padding:3px 0;border-bottom:1px dashed var(--line)"><b>{{ h.action }}</b> · v{{ h.version }} · {{ h.by }} · {{ U.dt(h.time) }}<div class="muted">{{ h.detail }}</div></div></div>
          </div></div>
        </div>
      </div>
    </div>`,
  };

  // ====================== P11 资产库 ======================
  P.library = {
    setup() {
      const f = reactive({ q: '', type: '', source: '', platform: '', license: '', status: st.params.filter === 'exported' ? 'exported' : '', commercialOnly: false, heritageOnly: false, sort: 'new' });
      const t0 = ref(0);
      const list = computed(() => { st.rev; const s = performance.now(); const r = E.libraryQuery(f); t0.value = performance.now() - s; return r; });
      const sel = reactive(new Set()); const detail = ref(null);
      const cur = computed(() => { st.rev; return detail.value && E.S.assets.find(a => a.id === detail.value); });
      const tag = async () => { const t = await confirmBox({ title: '批量加标签', text: `为 ${sel.size} 件资产添加标签`, input: '', inputLabel: '标签', ok: '添加' }); if (t) act(() => E.tagAssets([...sel], t.trim()), '已添加标签'); };
      const scenes = computed(() => { st.rev; return E.S.scenes.filter(s => s.project_id === E.S.currentProjectId); });
      const addToScene = async (ids) => { const sc = scenes.value[0]; if (!sc) return toast('请先在场景组装中创建场景', 'err'); const props = ids.filter(id => E.asset(id).type === 'prop'); act(() => props.forEach((id, i) => E.addSceneItem(sc.id, id, [i * 0.9 - props.length * 0.45, 0, 1.6])), `已加入场景 ${sc.code}`); };
      const exportSel = () => go('export', { assets: [...sel] });
      const download = async (a) => { try { const b = await assetGLB(a); if(st.production){await saveFile(`${a.code}_v${E.cur(a).version}.glb`,b,'model/gltf-binary');return;} const chk = glbCheck(b); E.audit('下载资产', a.code, 'GLB'); saveFile(`${a.code}_v${E.cur(a).version}.glb`, b, 'model/gltf-binary'); if (!chk.ok) toast('GLB 结构校验发现问题：' + chk.issues.join('；'), 'err'); } catch(e){toast(e.message,'err');} };
      const del = async (a) => { const ok = await confirmBox({ title: '删除资产', text: `确认删除 ${a.code}？删除后保留 30 天。`, ok: '删除', danger: true }); if (ok) act(() => E.deleteAsset(a.id), '已删除'); };
      const versions = computed(() => cur.value ? cur.value.versions.map(id => E.version(id)).filter(Boolean).reverse() : []);
      return { f, t0, list, sel, detail, cur, tag, scenes, addToScene, exportSel, download, del, versions, E, D, U, st, act };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P11" ver="V1.0" title="资产库" goal="检索、查看和复用已入库资产。"></c-head>
      <div class="panel" style="margin-bottom:12px"><div class="body row">
        <input class="inp" style="max-width:280px" v-model="f.q" placeholder="搜索名称、标签、生成提示词" id="lib-search">
        <select class="inp" style="width:auto" v-model="f.type"><option value="">全部类型</option><option value="prop">道具</option><option value="recon">实景重建</option><option value="world">世界生成</option></select>
        <select class="inp" style="width:auto" v-model="f.source"><option value="">全部来源</option><option>生成</option><option>重建</option><option>人工</option></select>
        <select class="inp" style="width:auto" v-model="f.platform"><option value="">全部平台</option><option v-for="(n,k) in D.PLATFORMS" :key="k" :value="k">{{ n }} 可用</option></select>
        <select class="inp" style="width:auto" v-model="f.status"><option value="">已入库 + 已导出</option><option value="library">已入库</option><option value="exported">已导出</option><option value="discarded">已废弃（30 天内）</option></select>
        <label class="check"><c-switch v-model="f.commercialOnly"></c-switch>仅可对外商用</label><label class="check"><c-switch v-model="f.heritageOnly"></c-switch>仅文物本体</label>
      </div></div>
      <div class="panel"><header><h3>{{ list.length }} 件</h3><span class="sub">筛选用时 {{ t0.toFixed(1) }} ms</span><span class="right">
        <select class="inp" style="width:auto" v-model="f.sort"><option value="new">最新</option><option value="name">名称</option><option value="tris">面数</option></select>
        <button class="btn sm" :disabled="!sel.size" @click="tag">批量加标签</button><button class="btn sm" :disabled="!sel.size" @click="addToScene([...sel])">批量加入场景</button><button class="btn sm primary" :disabled="!sel.size" @click="exportSel" id="btn-lib-export">批量导出（{{ sel.size }}）</button></span></header>
        <div class="body"><div class="thumbs" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))" id="lib-grid">
          <div class="thumb" v-for="a in list" :key="a.id" :class="{sel: sel.has(a.id)}" @click="detail=a.id" :data-id="a.id" role="button" tabindex="0" @keydown.enter="detail=a.id">
            <img class="img" :src="U.thumbOf(a)" alt=""><span class="tick" @click.stop="sel.has(a.id)?sel.delete(a.id):sel.add(a.id)" role="checkbox" :aria-checked="sel.has(a.id)">{{ sel.has(a.id) ? '✓' : '' }}</span>
            <span class="badge" v-if="a.source==='生成'"><span class="tag ai">AI</span></span>
            <div class="cap" style="flex-direction:column;align-items:flex-start;gap:2px"><b style="font-weight:500">{{ a.name }}</b><span class="faint">{{ a.code }} · {{ a.type==='prop' ? U.n(U.stats(E.cur(a)).tris)+' 面' : U.n(E.cur(a).splats)+' splat' }}</span>
              <span class="row" style="gap:4px"><span class="tag" :class="E.commercialOk(E.cur(a)) ? 'lic-ok' : 'lic-warn'">{{ E.commercialOk(E.cur(a)) ? '可商用' : '仅内部' }}</span><span class="tag">{{ a.source }}</span><c-pill :kind="U.assetPill(a.status)" :text="D.ASSET_STATUS[a.status]"></c-pill></span></div>
          </div></div><div v-if="!list.length" class="muted" style="padding:30px;text-align:center">没有符合条件的资产</div></div></div>
      <template v-if="cur"><div class="drawer-mask" @click="detail=null"></div><aside class="drawer" aria-label="资产详情"><header><b>{{ cur.name }}</b><span class="mono faint">{{ cur.code }}</span><span class="spacer"></span><button class="btn sm ghost" @click="detail=null">关闭</button></header>
        <div class="dbody">
          <img :src="U.thumbOf(cur)" style="width:100%;max-height:260px;object-fit:contain;background:var(--viewport);border-radius:6px" alt="">
          <div class="kv"><div>资产编号</div><div class="mono">{{ cur.code }}</div><div>当前版本</div><div>v{{ E.cur(cur).version }}</div><template v-if="cur.type==='prop'"><div>面数</div><div>{{ U.n(U.stats(E.cur(cur)).tris) }}</div><div>贴图</div><div>{{ U.stats(E.cur(cur)).texture }} px · {{ U.stats(E.cur(cur)).materials }} 材质</div><div>格式</div><div>GLB（{{ U.stats(E.cur(cur)).file_mb }} MB）</div></template><template v-else><div>splat</div><div>{{ U.n(E.cur(cur).splats) }}</div><div>格式</div><div>SPZ / PLY / glTF</div></template>
            <div>生成模型</div><div>{{ (E.cur(cur).license_chain.find(c=>c.stage==='3D 生成'||c.stage==='世界生成')||{}).model_name || '—' }}</div><div>seed</div><div class="mono">{{ E.cur(cur).seed ?? '—' }}</div><div>标签</div><div><span class="tag" v-for="t in cur.tags" :key="t">{{ t }}</span></div><div>提示词</div><div class="small">{{ cur.prompt || '—' }}</div>
            <div>AIGC 标识</div><div><span v-if="E.cur(cur).aigc_mark" class="tag ai">{{ cur.ai_restore ? 'AI 复原 · ' : '' }}AI 生成</span><span v-else class="muted">不写入（{{ cur.source }}类）</span></div>
            <div>被引用场景</div><div>{{ cur.scenes.length ? cur.scenes.map(s=>(E.S.scenes.find(x=>x.id===s)||{}).code).join('、') : '无' }}</div></div>
          <div><div class="lbl">许可链</div><div v-for="c in E.cur(cur).license_chain" :key="c.stage" class="small">{{ c.stage }}：{{ c.model_name }} <span class="tag">{{ c.license }}</span></div></div>
          <div><div class="lbl">版本历史</div><div v-for="v in versions" :key="v.id" class="row small" style="border-bottom:1px dashed var(--line);padding:4px 0"><b>v{{ v.version }}</b><span>{{ U.dt(v.created_at) }}</span><span class="tag">{{ (E.S.settings.presets[v.preset]||{}).name || '原始版本' }}</span><a v-if="v.approved && v.file_url" class="btn sm" :href="v.file_url" :download="cur.code+'_v'+v.version+'.glb'">下载此版本</a><c-pill :kind="v.approved?'ok':'plain'" :text="v.approved?'通过':v.rework_of?'返工版本':'候选'"></c-pill><span class="spacer"></span><button class="btn sm" v-if="v.approved && v.id!==cur.current_version" @click="act(()=>E.rollback(cur.id,v.id),'已回退')">回退</button></div>
            <div v-for="(h,i) in cur.history" :key="'h'+i" class="small muted">{{ U.dt(h.time) }} · {{ h.action }} · {{ h.detail }}</div></div>
          <div class="row"><button class="btn primary" v-if="cur.type==='prop'" @click="download(cur)">下载 GLB</button><button class="btn" @click="addToScene([cur.id])">加入场景</button><button class="btn danger" @click="del(cur)">删除</button></div>
        </div></aside></template>
    </div>`,
  };

  // ====================== P12 导出发布 ======================
  P.export = {
    setup() {
      const kind = ref(st.params.scene ? 'scene' : 'assets');
      const sceneId = ref(st.params.scene || (E.S.scenes.find(s => s.project_id === E.S.currentProjectId) || {}).id);
      const lib = computed(() => { st.rev; return E.S.assets.filter(a => a.project_id === E.S.currentProjectId && !['discarded'].includes(a.status) && ['library', 'exported', 'review'].includes(a.status)); });
      const pick = reactive(new Set(st.params.assets || lib.value.filter(a => a.status === 'library').slice(0, 4).map(a => a.id)));
      const targets = reactive(new Set(['webxr']));
      const settings = reactive({ texCompress: 'KTX2', meshCompress: 'Draco', aigcVisible: true, outDir: '/data/export/', manifest: true });
      const deviceTested = ref(false);
      const opts = computed(() => ({ object_type: kind.value, object_id: sceneId.value, asset_ids: [...pick], targets: [...targets], settings: Object.assign({}, settings), deviceTested: deviceTested.value }));
      const chk = computed(() => { st.rev; try { return E.exportChecks(opts.value); } catch (e) { return null; } });
      const scenes = computed(() => { st.rev; return E.S.scenes.filter(s => s.project_id === E.S.currentProjectId); });
      const records = computed(() => { st.rev; return E.S.exports.filter(x => x.project_id === E.S.currentProjectId); });
      const togT = (t) => targets.has(t) ? targets.delete(t) : targets.add(t);
      const run = () => act(() => E.createExport(opts.value), (ex) => `已创建导出 ${ex.code}${deviceTested.value ? '' : '（标记未经真机验证）'}`);
      const view = ref(null);
      const dl = async (ex) => { toast('正在打包交付包…'); const blob = await buildPackage(ex); saveFile(ex.code + '.zip', blob, 'application/zip'); };
      const validate = async (ex) => { if(st.production){return confirmBox({title:'真实压缩校验 · '+ex.code,text:ex.status==='done'?ex.manifest.assets.map(a=>a.file+'\nSHA-256: '+a.sha256+'\n'+JSON.stringify(a.validation)).join('\n\n'):'真实导出尚未完成',ok:'关闭',cancel:'返回'});} const assets = ex.asset_ids.map(i => E.asset(i)).filter(a => a.type === 'prop'); const out = []; for (const a of assets) { const b = await assetGLB(a); const c = glbCheck(b); out.push(`${a.code}: ${c.ok ? '通过' : c.issues.join('；')}（${c.tris} 三角形，与资产记录 ${U.stats(E.cur(a)).tris} ${c.tris === U.stats(E.cur(a)).tris ? '一致' : '不一致'}）`); } confirmBox({ title: 'GLB 结构校验 · ' + ex.code, text: out.join('\n') || '没有 GLB 资产', ok: '关闭', cancel: '返回' }); };
      return { kind, sceneId, lib, pick, targets, settings, deviceTested, chk, scenes, records, togT, run, view, dl, validate, E, D, U, st };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P12" ver="V1.0 起" title="导出发布" goal="把场景或资产按目标平台打包，并在导出前做合规和预算检查。"></c-head>
      <div class="split">
        <div class="stack" style="min-width:0">
          <div class="panel"><header><h3>导出对象</h3><div class="seg right"><button :class="{on:kind==='assets'}" @click="kind='assets'">资产集合</button><button :class="{on:kind==='scene'}" @click="kind='scene'">场景</button></div></header>
            <div class="body stack">
              <template v-if="kind==='scene'"><select class="inp" v-model="sceneId"><option v-for="s in scenes" :key="s.id" :value="s.id">{{ s.code }} · {{ s.name }}（{{ s.items.length }} 件{{ s.final ? ' · 已完成六步' : '' }}）</option></select></template>
              <template v-else><div class="thumbs" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))"><button class="thumb" v-for="a in lib" :key="a.id" :class="{sel: pick.has(a.id)}" @click="pick.has(a.id)?pick.delete(a.id):pick.add(a.id)"><img class="img" :src="U.thumbOf(a)" alt=""><span class="tick">{{ pick.has(a.id)?'✓':'' }}</span><div class="cap"><span class="small">{{ a.code }}</span><c-pill :kind="U.assetPill(a.status)" :text="D.ASSET_STATUS[a.status]"></c-pill></div></button></div></template>
              <div class="grid g3 small" v-if="chk"><div><div class="lbl">资产数</div><b class="num">{{ chk.summary.count }}</b></div><div><div class="lbl">三角形</div><b class="num">{{ U.n(chk.summary.tris) }}</b></div><div><div class="lbl">Draw call</div><b class="num">{{ chk.summary.drawcalls }}</b></div></div>
            </div></div>
          <div class="panel"><header><h3>导出目标</h3><span class="sub">当前发布范围 {{ E.S.release }}</span></header><div class="body grid g3">
            <label v-for="(t,k) in D.EXPORT_TARGETS" :key="k" class="check panel" style="padding:10px" :class="{disabled: D.VERSION_ORDER[t.ver] > D.VERSION_ORDER[E.S.release]}"><input type="checkbox" :checked="targets.has(k)" @change="togT(k)" :disabled="D.VERSION_ORDER[t.ver] > D.VERSION_ORDER[E.S.release]" :id="'tg-'+k"><span><b>{{ t.name }}</b> <span class="tag ver">{{ t.ver }}</span><br><span class="small muted">{{ t.fmt }}</span></span></label>
          </div></div>
          <div class="panel"><header><h3>导出记录</h3></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>编号</th><th>时间</th><th>对象</th><th>目标</th><th class="r">大小</th><th>操作人</th><th>状态</th><th></th></tr></thead><tbody>
            <tr v-for="x in records" :key="x.id"><td class="mono">{{ x.code }}</td><td class="small">{{ U.dt(x.created_at) }}</td><td>{{ x.object_type==='scene' ? (E.S.scenes.find(s=>s.id===x.object_id)||{}).code : x.asset_ids.length+' 件资产' }}</td><td class="small">{{ x.targets.map(t=>D.EXPORT_TARGETS[t].name).join('、') }}</td><td class="r">{{ x.size_mb!=null ? x.size_mb+' MB' : '—' }}</td><td>{{ x.created_by }}</td><td><c-pill :kind="U.taskPill(x.status)" :text="x.status==='done' ? (x.deviceTested?'已完成':'已完成 · 未经真机验证') : (D.TASK_STATUS[x.status] || '打包中')"></c-pill><div v-if="x.error" class="small res-fail">{{x.error}}</div></td><td class="row nowrap"><button class="btn sm" @click="view=x">交付清单</button><button class="btn sm" :disabled="x.status!=='done'" @click="validate(x)">校验</button><button class="btn sm" :disabled="x.status!=='done'" @click="dl(x)">下载</button></td></tr>
            <tr v-if="!records.length"><td colspan="8" class="muted" style="text-align:center;padding:16px">暂无导出记录</td></tr></tbody></table></div></div>
        </div>
        <div class="stack">
          <div class="panel"><header><h3>发布前检查</h3><span class="sub">前五项任一未通过则阻断导出</span></header><div class="body stack" v-if="chk">
            <div v-for="c in chk.checks" :key="c.id" class="row nowrap" style="align-items:flex-start"><span :class="c.ok ? 'res-pass' : c.soft ? 'res-warn' : 'res-fail'" style="width:16px">{{ c.ok ? '✓' : c.soft ? '!' : '✗' }}</span><div style="min-width:0"><b class="small">{{ c.name }}</b><div class="small muted">{{ c.detail }}</div></div></div>
            <div v-if="!chk.verOk" class="note err small">所选目标在当前发布范围未开放</div>
          </div></div>
          <div class="panel"><header><h3>导出设置</h3></header><div class="body stack">
            <div class="grid g2"><div class="field"><label>贴图压缩</label><select class="inp" v-model="settings.texCompress"><option>KTX2</option><option>不压缩</option></select></div><div class="field"><label>网格压缩</label><select class="inp" v-model="settings.meshCompress"><option>Draco</option><option>不压缩</option></select></div></div>
            <label class="check"><c-switch v-model="settings.aigcVisible"></c-switch>AIGC 显式标识（场景角标 / 交付说明文字，默认开启）</label>
            <div class="field"><label>输出目录</label><input class="inp mono" v-model="settings.outDir"></div>
            <label class="check"><c-switch v-model="settings.manifest"></c-switch>生成交付清单 manifest.json</label>
            <label class="check"><c-switch v-model="deviceTested"></c-switch>已完成真机测试（未完成可导出，交付包标记“未经真机验证”）</label>
            <button class="btn primary" :disabled="!chk || chk.blocked" @click="run" id="btn-export">导出</button>
          </div></div>
        </div>
      </div>
      <template v-if="view"><div class="drawer-mask" @click="view=null"></div><aside class="drawer"><header><b>交付清单 · {{ view.code }}</b><span class="spacer"></span><button class="btn sm ghost" @click="view=null">关闭</button></header><div class="dbody">
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>资产</th><th>来源</th><th>模型</th><th>许可类型</th><th>AIGC</th></tr></thead><tbody><tr v-for="a in view.manifest.assets" :key="a.code"><td class="mono">{{ a.code }} {{ a.version }}</td><td>{{ a.source }}</td><td class="small">{{ a.model }}</td><td class="small">{{ a.license_types.join(' / ') }}</td><td class="small">{{ a.aigc.label }}</td></tr></tbody></table></div>
        <div v-if="view.files.length"><div class="lbl">文件</div><div v-for="f in view.files" :key="f.name" class="row small mono" style="justify-content:space-between"><span>{{ f.name }}</span><span>{{ f.mb }} MB</span></div></div>
        <pre class="code" style="max-height:360px">{{ JSON.stringify(view.manifest, null, 2) }}</pre></div></aside></template>
    </div>`,
  };

  // ====================== P13 任务队列 ======================
  P.queue = {
    setup() {
      const f = reactive({ status: '', queue: '' });
      const tasks = computed(() => { st.rev; return E.S.tasks.filter(t => (!f.status || t.status === f.status) && (!f.queue || t.queue === f.queue)).slice(0, 120); });
      const mins = ref(30);
      const lanes = computed(() => { st.rev; const t1 = E.S.clock, t0 = t1 - mins.value * 60000; const seg = E.S.schedule.filter(s => s.end > t0); const pos = (s) => ({ left: Math.max(0, (s.start - t0) / (t1 - t0) * 100) + '%', width: Math.max(0.4, (Math.min(s.end, t1) - Math.max(s.start, t0)) / (t1 - t0) * 100) + '%' }); return ['gpu', 'cpu', 'cloud'].map(l => ({ l, name: { gpu: '本地 GPU', cpu: 'CPU 池', cloud: '云节点' }[l], segs: seg.filter(s => s.lane === l).map(s => Object.assign({ style: pos(s), color: s.kind === 'swap' ? '' : U.color(s.model) }, s)) })); });
      const models = computed(() => { st.rev; return [...new Set(E.S.schedule.filter(s => s.model).map(s => s.model))]; });
      const log = ref(null);
      const doAct = (t, a) => act(() => E.taskAction(t.id, a), { pause: '已暂停', resume: '已恢复', cancel: '已取消（显存已释放）', retry: '已重新排队（沿用原参数）', pin: '已置顶：当前批次结束后优先执行', now: '已改为立即执行' }[a]);
      const g = computed(() => { st.rev; const h = E.S.gpu.history[E.S.gpu.history.length - 1] || {}; return Object.assign({ model: E.S.gpu.loaded ? E.model(E.S.gpu.loaded).name : '无' }, h); });
      const nextOrder = computed(() => { st.rev; return E.S.tasks.filter(t => t.queue === 'gpu' && t.status === 'queued').sort((a, b) => (b.priority === 'pin') - (a.priority === 'pin') || (a.model_id === E.S.gpu.loaded ? -1 : 0) - (b.model_id === E.S.gpu.loaded ? -1 : 0) || a.created_at - b.created_at).slice(0, 6); });
      const stopNode = (n) => act(() => E.stopCloudNode(n.id), '已关机');
      const disk = computed(() => E.S.settings.storage);
      return { f, tasks, mins, lanes, models, log, doAct, g, nextOrder, stopNode, disk, E, D, U, st };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P13" ver="V1.0" title="任务队列" :goal="st.production?'查看真实执行排程、日志和任务状态。GPU 并发 1，CPU 并发 3；支持置顶和夜间队列。':'查看 GPU 排程和全部任务，处理排队、失败和云端任务。GPU 队列并发 1，同模型合批（≤ 20 件 / 30 分钟），置顶任务在当前批次结束后执行。'"><div class="seg"><button v-for="m in [10,30,60]" :key="m" :class="{on:mins===m}" @click="mins=m">{{ m }} 分钟</button></div></c-head>
      <div class="panel" style="margin-bottom:12px"><header><h3>GPU 排程</h3><span class="sub">色块为模型批次，灰色斜纹为换载</span><span class="right legend"><span v-for="m in models" :key="m"><i :style="{background:U.color(m)}"></i>{{ (E.model(m)||{}).name }}</span><span><i style="background:#a9b1ad"></i>换载</span></span></header>
        <div class="body gantt"><div class="lane" v-for="ln in lanes" :key="ln.l"><span>{{ ln.name }}</span><div class="track"><div v-for="(s,i) in ln.segs" :key="i" class="seg-block" :class="s.kind" :style="Object.assign({}, s.style, s.kind==='swap'?{}:{background:s.color})" :title="s.label">{{ s.label }}</div></div></div>
          <div class="gantt-axis"><span></span><div><span>-{{ mins }} 分钟</span><span>-{{ mins/2 }} 分钟</span><span>现在</span></div></div>
          <div class="small muted" style="margin-top:8px">接下来 GPU 执行顺序：<span v-for="(t,i) in nextOrder" :key="t.id" class="mono">{{ i?' → ':'' }}{{ t.code }}（{{ (E.model(t.model_id)||{}).name }}{{ t.priority==='pin'?'·置顶':'' }}）</span><span v-if="!nextOrder.length">无</span></div></div></div>
      <div class="split">
        <div class="panel"><header><h3>任务列表</h3><span class="right"><select class="inp" style="width:auto" v-model="f.queue"><option value="">全部队列</option><option value="gpu">gpu</option><option value="cpu">cpu</option><option value="cloud">cloud</option></select><select class="inp" style="width:auto" v-model="f.status"><option value="">全部状态</option><option v-for="(n,k) in D.TASK_STATUS" :key="k" :value="k">{{ n }}</option></select></span></header>
          <div class="tbl-wrap" style="max-height:620px"><table class="tbl" id="task-table"><thead><tr><th>任务号</th><th>需求单</th><th>节点</th><th>模型 / 工具</th><th>位置</th><th class="r">显存</th><th class="r">耗时</th><th>状态</th><th>操作</th></tr></thead><tbody>
            <tr v-for="t in tasks" :key="t.id" :data-code="t.code"><td class="mono">{{ t.code }}</td><td class="mono small">{{ t.job_id ? (E.S.jobs.find(j=>j.id===t.job_id)||{}).code : '—' }}</td><td>{{ D.NODE_NAMES[t.node] }}</td><td class="small">{{ (E.model(t.model_id)||{}).name }}</td><td>{{ t.queue }}</td><td class="r">{{ t.vram_peak ? t.vram_peak.toFixed(1)+'G' : '—' }}</td><td class="r small">{{ t.status==='running' ? Math.round(t.progress*100)+'%' : t.elapsed ? U.dur(t.elapsed) : U.dur(t.duration)+'（预计）' }}</td>
              <td><c-pill :kind="U.taskPill(t.status)" :text="(t.priority==='pin'&&t.status==='queued'?'置顶 · ':t.priority==='night'&&t.status==='queued'?'夜间 · ':'') + D.TASK_STATUS[t.status]"></c-pill></td>
              <td class="row nowrap"><button class="btn sm" v-if="t.status==='queued'" @click="doAct(t,'pin')">置顶</button><button class="btn sm" v-if="t.status==='queued' && t.priority==='night'" @click="doAct(t,'now')">立即执行</button><button class="btn sm" v-if="t.status==='queued'" @click="doAct(t,'pause')">暂停</button><button class="btn sm" v-if="t.status==='paused'" @click="doAct(t,'resume')">恢复</button><button class="btn sm danger" v-if="['queued','paused','running'].includes(t.status)" @click="doAct(t,'cancel')">取消</button><button class="btn sm" v-if="['failed','manual','canceled'].includes(t.status)" @click="doAct(t,'retry')">重试</button><button class="btn sm ghost" @click="log=t">日志</button></td></tr></tbody></table></div></div>
        <div class="stack">
          <div class="panel"><header><h3>本地 GPU</h3><span class="sub">RTX 4090 24GB</span></header><div class="body stack"><c-vram :history="E.S.gpu.history" :height="110" :minutes="10"></c-vram>
            <div class="grid g4 small"><div><div class="lbl">利用率</div><b class="num">{{ g.util||0 }}%</b></div><div><div class="lbl">温度</div><b class="num" :style="{color:g.temp>85?'var(--err)':''}">{{ g.temp||0 }}℃</b></div><div><div class="lbl">功耗</div><b class="num">{{ g.power==null?'—':g.power+'W' }}</b></div><div><div class="lbl">显存</div><b class="num">{{ (g.vram||0).toFixed(1) }}G</b></div></div><div class="small">当前模型：<b>{{ g.model }}</b></div></div></div>
          <div v-if="st.production" class="panel"><header><h3>执行范围</h3></header><div class="body small muted">当前使用本机 Worker。云 GPU 和同模型常驻合批尚未接入。</div></div>
          <div v-else class="panel"><header><h3>云 GPU 节点</h3><span class="sub">空闲 {{ E.S.settings.cloud.idleShutdownMin }} 分钟自动关机</span></header><div class="list"><div class="li" v-for="n in E.S.cloudNodes.slice(0,6)" :key="n.id"><div class="grow"><div class="t1">{{ n.name }}</div><div class="t2">运行 {{ U.dur(n.runSec) }} · ¥{{ n.cost }} · {{ n.state==='off' ? '已关机' : n.state==='booting' ? '开机中' : n.task ? '执行中' : '空闲 '+U.dur(n.idleSec)+'，'+U.dur(E.S.settings.cloud.idleShutdownMin*60-n.idleSec)+' 后自动关机' }}</div></div><button class="btn sm" v-if="n.state!=='off'" @click="stopNode(n)">关机</button><button class="btn sm ghost" @click="log={code:n.name,log:['ssh root@'+n.type.toLowerCase().split(' ').join('-')+'.autodl.com','nvidia-smi: A800 80GB · '+(n.task?'busy':'idle'),'worker-cloud: heartbeat ok']}">SSH 日志</button></div><div v-if="!E.S.cloudNodes.length" class="body small muted">没有云节点。显存超过 23GB 的模型会自动路由到云端。</div></div></div>
          <div class="panel"><header><h3>磁盘</h3></header><div class="body stack small"><div v-for="d in [['模型盘',disk.models],['资产与工程盘',disk.assets]]" :key="d[0]"><div class="row" style="justify-content:space-between"><span>{{ d[0] }} <span class="mono faint">{{ d[1].path }}</span></span><span class="num">{{ d[1].usedGb }} / {{ d[1].totalGb }} GB</span></div><c-progress :v="d[1].usedGb/d[1].totalGb" :kind="d[1].usedGb/d[1].totalGb>disk.alertPct/100?'bronze':''"></c-progress></div></div></div>
        </div>
      </div>
      <template v-if="log"><div class="drawer-mask" @click="log=null"></div><aside class="drawer"><header><b>日志 · {{ log.code }}</b><span class="spacer"></span><button class="btn sm ghost" @click="log=null">关闭</button></header><div class="dbody"><pre class="code">{{ (log.log||[]).join(String.fromCharCode(10)) }}</pre><div v-if="log.params" class="small"><div class="lbl">参数（重试沿用）</div><pre class="code">{{ JSON.stringify(log.params, null, 2) }}</pre></div></div></aside></template>
    </div>`,
  };

  // ====================== P14 系统设置 ======================
  P.system = {
    setup() {
      const tab = ref('models');
      const production = E.S.runtime?.mode === 'production';
      const tabs = [['models', '模型与许可证'], ['rules', '许可证规则'], ['cloud', '云 GPU'], ['llm', 'LLM 与 Agent'], ['presets', '质检预设'], ['storage', '存储'], ['users', '用户与权限'], ['audit', '审计日志'], ['demo', '演示控制']].filter(t => !production || !['cloud','llm','demo'].includes(t[0]));
      const engineStatus = ref(null), engineError = ref(''), checking = ref(false);
      const checkEngines = async () => {
        checking.value=true; engineError.value='';
        try { const r=await fetch('/api/v1/system/engines'); if(!r.ok)throw new Error('引擎检查失败'); engineStatus.value=await r.json(); }
        catch(e) { engineError.value=e.message; } finally { checking.value=false; }
      };
      onMounted(() => { if(production)checkEngines(); });
      const licenseDates=reactive({});
      const confirmRealLicense=l=>act(()=>E.confirmLicense(l.id,licenseDates[l.id] || ''),'已确认授权');
      const setScope = (m, v) => act(() => E.updateModel(m.id, { allowed_scope: v }), '允许范围已更新，需求单与 3D 生成中的可选状态同步变化');
      const nm = reactive({ name: '', purpose: '图生 3D', node: 'image_to_3d', license_type: 'MIT', vram_gb: 12, location: 'local', disk_gb: 10, file_name: '' });
      const reg = () => act(() => E.registerModel(Object.assign({}, nm)), '已登记新模型（许可待核对，默认仅内部原型可用）');
      const up = reactive({ model: 'hunyuan3d-21', file: '' });
      const upload = () => { if (!up.file) return toast('请选择授权文件', 'err'); act(() => E.uploadLicense(up.model, up.file), '授权文件已上传，等待管理员确认'); up.file = ''; };
      const onFile = async (e) => { try { up.file = E.S.runtime?.mode === 'production' ? (await global.SCW.uploadFiles(e.target.files))[0] : e.target.files[0]?.name || ''; } catch (err) { toast(err.message, 'err'); } };
      const scopeMatrix = computed(() => { st.rev; return Object.entries(D.SCOPES).map(([k, n]) => ({ k, n, models: E.S.models.filter(m => !['lora', 'tool', 'rembg', 'llm'].includes(m.node)).map(m => ({ m, r: E.modelAllowed(m, { usage_scope: k }) })) })); });
      const setRule = (k, v) => act(() => E.updateSettings('rules.' + k, v), '规则已变更并写入审计日志，对变更后新提交的需求单生效');
      const setSet = (p, v) => act(() => E.updateSettings(p, v), '已保存');
      const auditQ = ref('');
      const audits = computed(() => { st.rev; const q = auditQ.value; return E.S.audit.filter(a => !q || (a.action + a.object + a.detail + a.actor).includes(q)).slice(0, 200); });
      const reset = async () => { const ok = await confirmBox({ title: '重置演示数据', text: '将清空本浏览器中的全部演示数据并重新生成初始数据。', ok: '重置', danger: true }); if (ok) { E.reset(); st.rev++; toast('演示数据已重置'); } };
      const presetKeys = ['quest3', 'pico4', 'quest2', 'webxr', 'xr_space', 'custom'];
      const VERSION = window.SCW_VERSION || ''; const MODE = window.SCW_MODE || '';
      return { VERSION, MODE, production, engineStatus, engineError, checking, checkEngines, licenseDates, confirmRealLicense, tab, tabs, setScope, nm, reg, up, upload, onFile, scopeMatrix, setRule, setSet, auditQ, audits, reset, presetKeys, E, D, U, st, act };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P14" ver="V1.0" title="系统设置" goal="管理模型、许可证、规则和外部服务。仅管理员可访问。"></c-head>
      <div class="seg" style="margin-bottom:12px"><button v-for="t in tabs" :key="t[0]" :class="{on:tab===t[0]}" @click="tab=t[0]" :data-tab="t[0]">{{ t[1] }}</button></div>
      <template v-if="tab==='models'">
        <div v-if="production" class="panel" style="margin-bottom:12px" id="engine-readiness"><header><h3>真实引擎检查</h3><button class="btn sm" :disabled="checking" @click="checkEngines">{{checking?'检查中…':'刷新检查'}}</button></header><div class="body stack">
          <div v-if="engineError" class="res-fail">{{engineError}}</div><template v-if="engineStatus"><div v-for="(item,key) in engineStatus.engines" :key="key"><b>{{({concept_image:'概念图生成',image_to_3d:'TRELLIS.2 图生 3D',remove_bg:'BiRefNet 去背景',mesh:'Blender 加工与质检',export:'Draco/KTX2 导出'})[key]}}</b> · <span :class="item.ready?'res-pass':'res-fail'">{{item.ready?'依赖已就绪':'尚未就绪'}}</span><div class="small muted" v-for="message in item.missing" :key="message">{{message}}</div></div>
          <div class="small muted">依赖就绪后仍需真实推理验收。当前检查不代表 GPU 生成或头显测试已通过。</div></template></div></div>
        <div class="panel" style="margin-bottom:12px"><header><h3>模型登记表</h3><span class="sub">许可字段为“待核对”的模型默认仅内部原型可用</span></header><div class="tbl-wrap"><table class="tbl" id="model-table"><thead><tr><th>模型</th><th>用途</th><th>许可</th><th>授权登记</th><th class="r">显存</th><th class="r">磁盘</th><th>位置</th><th>状态</th><th>允许范围</th></tr></thead><tbody>
          <tr v-for="m in E.S.models" :key="m.id" :data-model="m.id"><td><b>{{ m.name }}</b><div class="faint small">{{ m.version }} · {{ m.engine }}</div></td><td>{{ m.purpose }}</td><td><span class="tag">{{ m.license_type }}</span><span v-if="m.region_restricted" class="tag lic-warn">地域限制</span></td><td><c-pill :kind="{'已登记授权':'ok','无需登记':'plain','待核对':'warn','待授权':'warn','授权待确认':'info'}[m.license_status]" :text="m.license_status"></c-pill></td><td class="r">{{ m.vram_gb }}G</td><td class="r">{{ m.disk_gb }}G</td><td>{{ U.loc(m) }}</td><td>{{ m.status }}</td>
            <td><select class="inp" style="width:auto" :value="m.allowed_scope" @change="setScope(m,$event.target.value); $event.target.value=m.allowed_scope"><option v-for="(n,k) in D.ALLOWED" :key="k" :value="k">{{ n }}</option></select></td></tr></tbody></table></div></div>
        <div class="grid g2">
          <div class="panel"><header><h3>上传授权文件</h3><span class="sub">管理员确认后，允许范围才能改为“全部项目”</span></header><div class="body stack">
            <div class="grid g2"><select class="inp" v-model="up.model"><option v-for="m in E.S.models.filter(x=>x.license_status!=='无需登记')" :key="m.id" :value="m.id">{{ m.name }}</option></select><input class="inp" type="file" @change="onFile" aria-label="授权文件"></div>
            <button class="btn" @click="upload">上传</button>
            <div class="tbl-wrap"><table class="tbl"><thead><tr><th>模型</th><th>文件</th><th>确认人</th><th>有效期</th><th></th></tr></thead><tbody><tr v-for="l in E.S.licenses" :key="l.id"><td>{{ E.model(l.model_id).name }}</td><td class="small">{{ l.file_name }}</td><td>{{ l.confirmed_by || '—' }}</td><td><input v-if="production && !l.confirmed_by" class="inp" type="date" v-model="licenseDates[l.id]" aria-label="授权有效期"><span v-else>{{ l.valid_until || '—' }}</span></td><td><button class="btn sm primary" v-if="!l.confirmed_by" @click="production?confirmRealLicense(l):act(()=>E.confirmLicense(l.id,'2027-12-31'),'已确认授权')">确认</button></td></tr></tbody></table></div>
          </div></div>
          <div class="panel"><header><h3>登记新模型</h3><span class="sub">通过登记表和 Worker 适配器接入，不改动前端页面</span></header><div class="body stack">
            <div class="grid g2"><div class="field"><label>模型名称</label><input class="inp" v-model="nm.name" placeholder="例：Hi3DGen"></div><div class="field"><label>用途节点</label><select class="inp" v-model="nm.node"><option v-for="(n,k) in D.NODE_NAMES" :key="k" :value="k">{{ n }}</option></select></div>
              <div class="field"><label>许可类型</label><input class="inp" v-model="nm.license_type"></div><div class="field"><label>显存（GB）</label><input class="inp" type="number" v-model.number="nm.vram_gb"></div>
              <div class="field"><label>部署位置</label><select class="inp" v-model="nm.location"><option value="local">本地</option><option value="cloud">云 GPU</option><option value="api">商业 API</option></select></div><div class="field"><label>磁盘（GB）</label><input class="inp" type="number" v-model.number="nm.disk_gb"></div></div>
            <div class="field" v-if="production && nm.node==='lora'"><label>已部署的 LoRA 文件名</label><input class="inp" v-model="nm.file_name" placeholder="例：my_style.safetensors"><div class="small muted">先将权重放入服务器模型目录的 loras 文件夹，再登记其文件名与许可。</div></div>
            <button class="btn primary" @click="reg">登记</button></div></div>
        </div>
      </template>
      <template v-if="tab==='rules'">
        <div class="panel" style="margin-bottom:12px"><header><h3>强制规则</h3></header><div class="body stack">
          <label class="check"><c-switch :model-value="E.S.settings.rules.submitCheck" @update:model-value="v=>setRule('submitCheck',v)"></c-switch>提交检查：需求单提交时执行许可证检查</label>
          <label class="check"><c-switch :model-value="E.S.settings.rules.exportCheck" @update:model-value="v=>setRule('exportCheck',v)"></c-switch>导出检查：任一资产许可链不满足项目使用范围时阻断导出</label>
          <label class="check"><c-switch :model-value="E.S.settings.rules.heritageLock" @update:model-value="v=>setRule('heritageLock',v)"></c-switch>文物本体限制：只能使用实景重建模板</label>
          <div class="faint small">许可证信息由管理员登记，平台不自动判断条款内容；每季度复核一次。</div></div></div>
        <div class="panel"><header><h3>使用范围 × 可用模型</h3></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>模型</th><th v-for="s in scopeMatrix" :key="s.k">{{ s.n }}</th></tr></thead><tbody><tr v-for="(row,i) in scopeMatrix[0].models" :key="row.m.id"><td>{{ row.m.name }}</td><td v-for="s in scopeMatrix" :key="s.k"><span :class="s.models[i].r.ok?'res-pass':'res-fail'">{{ s.models[i].r.ok ? '可用' : '不可用' }}</span><div class="faint small" v-if="!s.models[i].r.ok">{{ s.models[i].r.reason }}</div></td></tr></tbody></table></div></div>
      </template>
      <template v-if="tab==='cloud'"><div class="panel"><header><h3>云 GPU</h3></header><div class="body stack" style="max-width:560px">
        <div class="kv"><div>服务商</div><div>{{ E.S.settings.cloud.provider }}（A800 ¥5.59/小时 · H800 ¥10/小时 · 4090 ¥1.9/小时）</div><div>镜像</div><div class="mono">{{ E.S.settings.cloud.image }}</div><div>账号密钥</div><div>{{ E.S.settings.cloud.keySet ? '已配置（存于 .env，不入库）' : '未配置' }}</div><div>腾讯云 API 密钥</div><div>{{ E.S.settings.cloud.tencentKeySet ? '已配置' : '未配置' }}</div><div>Marble API 密钥</div><div>{{ E.S.settings.cloud.marbleKeySet ? '已配置' : '未配置' }}</div></div>
        <div class="field"><label>空闲自动关机（分钟）</label><input class="inp" type="number" :value="E.S.settings.cloud.idleShutdownMin" @change="setSet('cloud.idleShutdownMin', +$event.target.value)"></div>
        <div class="field"><label>单节点最长运行（小时，超过告警）</label><input class="inp" type="number" :value="E.S.settings.cloud.maxRunHours" @change="setSet('cloud.maxRunHours', +$event.target.value)"></div>
        <label class="check"><c-switch :model-value="E.S.settings.cloud.keySet" @update:model-value="v=>setSet('cloud.keySet',v)"></c-switch>启用云端路由（关闭后显存超过 23GB 的模型将被拒绝）</label></div></div></template>
      <template v-if="tab==='llm'"><div class="panel"><header><h3>LLM 与 Agent</h3></header><div class="body stack" style="max-width:620px">
        <div class="field"><label>编排模型</label><select class="inp" :value="E.S.settings.llm.orchestrator" @change="setSet('llm.orchestrator',$event.target.value)"><option v-for="m in E.S.models.filter(x=>x.node==='llm')" :key="m.id" :value="m.id">{{ m.name }}</option></select></div>
        <div class="field"><label>离线备用模型</label><input class="inp" :value="E.model(E.S.settings.llm.offline).name" disabled></div>
        <div class="field"><label>MCP 服务</label><div v-for="s in E.S.settings.llm.mcp" :key="s" class="mono small">● {{ s }}</div></div>
        <div class="field"><label>单条指令最多工具调用次数</label><input class="inp" type="number" :value="E.S.settings.llm.maxToolCalls" @change="setSet('llm.maxToolCalls', +$event.target.value)"></div>
        <label class="check"><c-switch :model-value="E.S.settings.llm.pythonConfirm" @update:model-value="v=>setSet('llm.pythonConfirm',v)"></c-switch>执行任意 Python 前人工确认</label>
        <label class="check"><c-switch :model-value="E.S.settings.llm.dataLocal" @update:model-value="v=>setSet('llm.dataLocal',v)"></c-switch>素材不出域（云端 LLM 只接收文字指令和场景结构）</label></div></div></template>
      <template v-if="tab==='presets'"><div class="panel"><header><h3>质检预设</h3><span class="sub">场景级预算采用 Meta 开发者文档推荐值；单件预算为平台默认值，可修改</span></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>预设</th><th>单件三角形</th><th>贴图</th><th>材质</th><th>文件 MB</th><th>场景三角形</th><th>Draw call</th><th>来源</th></tr></thead><tbody>
        <tr v-for="k in presetKeys" :key="k"><td>{{ E.S.settings.presets[k].name }}</td><td v-for="f in ['tris','tex','materials','size_mb','scene_tris','drawcalls']" :key="f"><input class="inp num" style="width:100px" type="number" :value="E.S.settings.presets[k][f]" @change="setSet('presets.'+k+'.'+f, +$event.target.value)"></td><td class="small muted">{{ E.S.settings.presets[k].src }}</td></tr></tbody></table></div></div></template>
      <template v-if="tab==='storage' && production"><div class="panel"><header><h3>真实存储</h3></header><div class="body stack"><div>数据目录：{{E.S.settings.storage.assets.path || '等待采样'}}</div><div>已用 / 总量：{{E.S.settings.storage.assets.usedGb}} / {{E.S.settings.storage.assets.totalGb}} GB</div><div>业务状态：workspaces/；不可变文件和索引：files/；执行日志及中间产物：runs/。</div><div class="muted">自动备份、保留期清理与外部介质备份尚未启用。</div></div></div></template>
      <template v-if="tab==='storage' && !production"><div class="panel"><header><h3>存储</h3></header><div class="body stack" style="max-width:640px"><pre class="code">/data
├── models/            # 模型仓库
├── assets/
│   ├── uploads/       # 参考图、采集素材
│   ├── concepts/      # 概念图
│   ├── raw3d/         # 生成高模
│   ├── library/       # 已入库资产（按资产编号 / 版本）
│   ├── scenes/        # .blend 工程与场景文件
│   └── recon/         # 重建数据集、位姿、splat
├── export/            # 导出包与交付清单
├── pg/  backup/  logs/</pre>
        <div class="field"><label>磁盘告警阈值（%）</label><input class="inp" type="number" :value="E.S.settings.storage.alertPct" @change="setSet('storage.alertPct', +$event.target.value)"></div>
        <div class="kv"><div>数据库备份</div><div>每日全量，保留 {{ E.S.settings.storage.backupDays }} 天</div><div>资产备份</div><div>/data/assets/library 每周增量备份到资产盘以外的介质</div><div>未选概念图</div><div>保留 7 天后清理</div><div>废弃资产</div><div>保留 30 天</div></div></div></div></template>
      <template v-if="tab==='users'"><div class="grid g2"><div class="panel"><header><h3>用户</h3></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>姓名</th><th>角色</th></tr></thead><tbody><tr v-for="u in E.S.users" :key="u.id"><td>{{ u.name }}</td><td>{{ D.ROLES[u.role] }}</td></tr></tbody></table></div></div>
        <div class="panel"><header><h3>权限矩阵</h3><span class="sub">接口按角色控制</span></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>操作</th><th v-for="(n,k) in D.ROLES" :key="k">{{ n }}</th></tr></thead><tbody><tr v-for="(roles,p) in D.PERM" :key="p"><td>{{ D.PERM_NAMES[p] }}</td><td v-for="(n,k) in D.ROLES" :key="k"><span :class="roles.includes(k)?'res-pass':'faint'">{{ roles.includes(k) ? '✓' : '—' }}</span></td></tr></tbody></table></div></div></div></template>
      <template v-if="tab==='audit'"><div class="panel"><header><h3>审计日志</h3><span class="sub">登录、需求单提交、模型与规则变更、审核结论、导出、Agent 工具调用</span><span class="right"><input class="inp" v-model="auditQ" placeholder="筛选" style="width:200px"></span></header><div class="tbl-wrap" style="max-height:640px"><table class="tbl"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody><tr v-for="a in audits" :key="a.id"><td class="small">{{ U.dt(a.time) }}</td><td>{{ a.actor }}</td><td>{{ a.action }}</td><td class="mono small">{{ a.object }}</td><td class="small" style="max-width:520px;overflow-wrap:anywhere">{{ a.detail }}</td></tr></tbody></table></div></div></template>
      <template v-if="tab==='demo'"><div class="panel"><header><h3>演示控制</h3><span class="sub">仅演示版提供</span></header><div class="body stack" style="max-width:600px">
        <div class="note">演示版以确定性模拟代替模型推理：任务耗时按加速倍率压缩，几何、贴图、全景、点云由程序化生成，seed 可复现。业务规则（许可证、文博、AIGC 标识、质检、调度、状态机）与正式版一致。</div>
        <div class="field"><label>演示加速倍率：{{ E.S.speed }}×（1 秒 = {{ E.S.speed }} 秒模拟时间）</label><input type="range" class="range" min="1" max="60" :value="E.S.speed" @change="act(()=>E.setSpeed($event.target.value))" id="speed"></div>
        <div class="field"><label>发布范围</label><div class="seg"><button v-for="r in ['V1.0','V1.1','V1.2']" :key="r" :class="{on:E.S.release===r}" @click="act(()=>E.setRelease(r),'发布范围：'+r)">{{ r }}</button></div><span class="faint small">V1.0：道具资产闭环；V1.1：场景、重建、Agent 组装；V1.2：角色动画与引擎工程包</span></div>
        <div class="kv small"><div>发布版本</div><div class="mono">v{{ VERSION }}</div><div>运行形态</div><div>{{ ({server:'服务端版', local:'单机版', artifact:'在线验收版'})[MODE] || MODE }}</div></div>
        <button class="btn danger" @click="reset" id="btn-reset">重置演示数据</button></div></div></template>
    </div>`,
  };
})(window);
