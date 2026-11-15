/* P06–P09 */
(function (global) {
  'use strict';
  const { ref, shallowRef, reactive, computed, watch, onMounted, onUnmounted, nextTick } = Vue;
  const E = global.Engine, Geo = global.Geo, V = global.Viewers, D = E.dict, { st, act, go, toast, confirmBox, saveFile, U } = global.SCW;
  const P = global.SCW_PAGES = global.SCW_PAGES || {};

  // 通用：three.js 视口挂载
  function useViewer(Ctor, opts) { const el = ref(null); const vw = shallowRef(null); onMounted(() => { vw.value = new Ctor(el.value, opts); }); onUnmounted(() => { vw.value && vw.value.dispose(); }); return { el, vw }; }

  // ====================== P06 场景生成 ======================
  P.scenes = {
    setup() {
      const tab = ref('pano');
      const list = computed(() => { st.rev; return E.S.panoramas.filter(p => p.project_id === E.S.currentProjectId); });
      const selId = ref(list.value[0] && list.value[0].id);
      const pano = computed(() => { st.rev; return selId.value && E.S.panoramas.find(p => p.id === selId.value); });
      const f = reactive({ prompt: '星空下的敦煌月牙泉与鸣沙山，远处驼队剪影', width: 4096, count: 4, seam_fix: true, upscale: false });
      const grid = ref(true); const viewer360 = ref(false);
      const flat = ref(null);
      const tasks = computed(() => { st.rev; return E.S.tasks.filter(t => ['panorama', 'world_gen', 'upscale'].includes(t.node) && t.project_id === E.S.currentProjectId).slice(0, 8); });
      const seam = computed(() => { const p = pano.value; if (!p) return null; const c = V.panoCanvas(p, 1024); const s = Geo.seamScore(c); p.seam_ok = s < 6; return { score: s.toFixed(1), ok: s < 6 }; });
      const drawFlat = () => { const p = pano.value; if (!p || !flat.value) return; const src = V.panoCanvas(p, 1024); const c = flat.value; c.width = 1024; c.height = 512; const x = c.getContext('2d'); x.drawImage(src, 0, 0); if (grid.value) { x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1; for (let i = 1; i < 12; i++) { x.beginPath(); x.moveTo(i * 1024 / 12, 0); x.lineTo(i * 1024 / 12, 512); x.stroke(); } for (let j = 1; j < 6; j++) { x.beginPath(); x.moveTo(0, j * 512 / 6); x.lineTo(1024, j * 512 / 6); x.stroke(); } x.strokeStyle = 'rgba(255,220,120,.7)'; x.beginPath(); x.moveTo(0, 256); x.lineTo(1024, 256); x.stroke(); } if (seam.value && !seam.value.ok) { x.strokeStyle = '#ff5a4a'; x.lineWidth = 3; x.strokeRect(1004, 2, 18, 508); } };
      watch([pano, grid, () => pano.value && pano.value.seam_defect], () => nextTick(drawFlat));
      onMounted(drawFlat);
      const pv = shallowRef(null); const pvEl = ref(null);
      watch(viewer360, async (on) => { await nextTick(); if (on && pvEl.value && !pv.value) { pv.value = new V.PanoViewer(pvEl.value); } if (pv.value && pano.value) pv.value.show(V.panoCanvas(pano.value, 2048)); });
      watch(pano, () => { if (pv.value && pano.value) pv.value.show(V.panoCanvas(pano.value, 2048)); });
      onUnmounted(() => pv.value && pv.value.dispose());
      const gen = () => act(() => E.generatePanoramas(f), '已提交全景生成');
      const fix = () => act(() => E.fixSeam(pano.value.id), '接缝已修复并通过检查');
      const exportHDR = () => { const p = pano.value; if (seam.value && !seam.value.ok) return toast('接缝检查未通过，请先执行接缝修复', 'err'); const c = V.panoCanvas(p, 2048); const bytes = Geo.canvasToHDR(c, 1.2); E.audit('导出 HDRI', p.code, '2048×1024 Radiance HDR'); saveFile(p.code + '_2k.hdr', bytes, 'image/vnd.radiance'); };
      const exportDome = () => { const p = pano.value; if (seam.value && !seam.value.ok) return toast('接缝检查未通过，请先执行接缝修复', 'err'); const d = Geo.equirectToDome(V.panoCanvas(p, 2048), 1024); d.toBlob(b => saveFile(p.code + '_domemaster.png', b)); E.audit('导出 domemaster', p.code); };
      const engines = computed(() => { st.rev; return E.modelsFor('world_gen', E.project()); });
      const wf = reactive({ engine: 'marble-api', formats: ['3DGS', '网格'], splats: 500000 });
      const eng = computed(() => E.model(wf.engine));
      const submitWorld = async () => { const m = eng.value; const cost = m.cost ? `¥${m.cost} / 次` : `约 ¥${(m.cost_per_hour * m.unit_s / 3600).toFixed(1)}（${m.engine} ¥${m.cost_per_hour}/小时 × ${U.dur(m.unit_s)}）`; const ok = await confirmBox({ title: '提交云端世界生成', text: `引擎：${m.name}\n预计费用：${cost}\n预计耗时：${U.dur(m.unit_s)}\n输出：${wf.formats.join('、')}\n完成后结果自动回传并进入质检。`, ok: '提交' }); if (ok) act(() => E.submitWorld(pano.value.id, wf.engine, { formats: wf.formats, splats: wf.splats }), '已提交世界生成'); };
      const worlds = computed(() => { st.rev; return E.S.assets.filter(a => a.type === 'world' && a.project_id === E.S.currentProjectId); });
      const toggleFmt = (x) => { const i = wf.formats.indexOf(x); i >= 0 ? wf.formats.splice(i, 1) : wf.formats.push(x); };
      const uses = ['天空盒', 'HDRI', '球幕背景', '世界生成'];
      const toggleUse = (u) => act(() => E.togglePanoUse(pano.value.id, u));
      const clip = reactive({ prompt: '云海翻涌，镜头缓慢环绕', sec: 6 });
      const seamView = () => pv.value && pv.value.lookAtSeam();
      return { seamView, tab, list, selId, pano, f, grid, viewer360, flat, tasks, seam, gen, fix, exportHDR, exportDome, engines, wf, eng, submitWorld, worlds, toggleFmt, pvEl, uses, toggleUse, clip, V, E, D, U, st, go };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P06" ver="V1.1" title="场景生成" goal="生成 360 全景用于天空盒、HDRI 和球幕背景，或提交世界生成得到可漫游场景。">
        <div class="seg"><button :class="{on:tab==='pano'}" @click="tab='pano'">全景图</button><button :class="{on:tab==='world'}" @click="tab='world'">世界生成</button><button :class="{on:tab==='video'}" @click="tab='video'">360 视频片段 <span class="tag ver">V1.2</span></button></div>
      </c-head>
      <div class="split">
        <div class="stack" style="min-width:0">
          <div class="panel"><header><h3>全景预览</h3><span class="sub" v-if="pano">{{ pano.code }} · {{ pano.width }}×{{ pano.height }}{{ pano.upscaled ? ' · 已超分 8K' : '' }}</span>
            <span class="right"><label class="check small"><c-switch v-model="grid"></c-switch>经纬网</label><button class="btn sm" @click="viewer360=!viewer360">{{ viewer360 ? '平面视图' : '360 查看器' }}</button><button class="btn sm" v-if="viewer360" @click="seamView">旋转到接缝</button></span></header>
            <div class="body">
              <div v-show="!viewer360" class="viewport" style="aspect-ratio:2/1;min-height:0"><canvas ref="flat" style="width:100%;height:100%" aria-label="等距柱状全景"></canvas><div v-if="!pano" class="vp-empty">还没有全景图</div></div>
              <div v-show="viewer360" class="viewport" style="height:420px"><div ref="pvEl" style="position:absolute;inset:0"></div><div class="vp-overlay"><span>拖动查看 · 初始视角正对接缝位置</span></div></div>
              <div class="row" style="margin-top:10px" v-if="pano && seam">
                <span>接缝检查：</span><c-pill :kind="seam.ok?'ok':'err'" :text="seam.ok?'通过':'未通过'"></c-pill><span class="small muted">首末列平均色差 {{ seam.score }}（阈值 6）</span>
                <span class="spacer"></span><button class="btn sm" v-if="!seam.ok" @click="fix" id="btn-fix-seam">执行接缝修复</button>
              </div>
              <div class="row" style="margin-top:8px" v-if="pano"><span class="lbl">输出用途：</span><label v-for="u in uses" :key="u" class="check small"><input type="checkbox" :checked="pano.uses.includes(u)" @change="toggleUse(u)">{{ u }}</label></div>
            </div></div>
          <div class="panel"><header><h3>候选全景</h3><span class="sub">单选送入世界生成</span></header><div class="body"><div class="thumbs" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
            <button class="thumb" v-for="p in list" :key="p.id" :class="{sel: selId===p.id}" @click="selId=p.id"><img class="img" style="aspect-ratio:2/1" :src="V.panoCanvas(p,512).toDataURL('image/jpeg',.7)" alt=""><div class="cap"><span class="mono">{{ p.code }}</span><span class="small" :style="{color: p.seam_defect ? 'var(--err)' : 'var(--ok)'}">{{ p.seam_defect ? '接缝待修' : '接缝正常' }}</span></div></button>
          </div></div></div>
        </div>
        <div class="stack">
          <template v-if="tab==='pano'">
            <div class="panel"><header><h3>全景参数</h3></header><div class="body stack">
              <div class="field"><label for="pn-prompt">提示词</label><textarea id="pn-prompt" class="inp" v-model="f.prompt"></textarea></div>
              <div class="kv small"><div>模型</div><div>Qwen-Image int4 + Qwen 360 LoRA <span class="tag lic-ok">已核对</span></div><div>显存</div><div>约 22 GB</div></div>
              <div class="grid g2"><div class="field"><label>分辨率</label><select class="inp" v-model.number="f.width"><option :value="4096">4096 × 2048</option><option :value="8192">8192 × 4096</option></select></div><div class="field"><label>数量</label><select class="inp" v-model.number="f.count"><option v-for="n in [1,2,4,6]" :key="n" :value="n">{{ n }}</option></select></div></div>
              <label class="check"><c-switch v-model="f.seam_fix"></c-switch>接缝修复</label><label class="check"><c-switch v-model="f.upscale"></c-switch>超分到 8K</label>
              <button class="btn primary" @click="gen" id="btn-gen-pano">生成全景</button>
            </div></div>
            <div class="panel"><header><h3>导出</h3></header><div class="body row"><button class="btn" :disabled="!pano" @click="exportHDR">导出 HDRI</button><button class="btn" :disabled="!pano" @click="exportDome">导出 domemaster</button><button class="btn" :disabled="!pano || pano.upscaled" @click="act(()=>E.upscalePano(pano.id),'已提交超分')">超分到 8K</button><button class="btn" :disabled="!pano" @click="tab='world'">送入世界生成</button></div></div>
          </template>
          <template v-if="tab==='world'">
            <div class="panel"><header><h3>世界生成引擎</h3></header><div class="list">
              <label class="li" style="opacity:.5;cursor:not-allowed"><input type="radio" disabled><div class="grow"><div class="t1">本地世界引擎</div><div class="t2" style="color:var(--warn)">受许可证规则限制，需管理员登记授权后可用</div></div></label>
              <label v-for="o in engines" :key="o.m.id" class="li" :style="{opacity:o.ok?1:.5}"><input type="radio" :value="o.m.id" v-model="wf.engine" :disabled="!o.ok"><div class="grow"><div class="t1">{{ o.m.name }}</div><div class="t2">{{ U.loc(o.m) }} · {{ o.m.vram_gb ? o.m.vram_gb+'GB' : '—' }} · 约 {{ U.dur(o.m.unit_s) }} · {{ o.m.cost ? '¥'+o.m.cost+'/次' : '¥'+o.m.cost_per_hour+'/小时' }}</div><div class="t2" v-if="!o.ok" style="color:var(--warn)">{{ o.reason }}</div></div><span class="tag" :class="o.ok?'lic-ok':'lic-warn'">{{ o.m.license_type }}</span></label></div>
              <div class="body stack"><div class="row"><span class="lbl">输出格式</span><label v-for="x in ['3DGS','网格','碰撞网格']" :key="x" class="check small"><input type="checkbox" :checked="wf.formats.includes(x)" @change="toggleFmt(x)">{{ x }}</label></div>
              <div class="field"><label>splat 档位</label><select class="inp" v-model.number="wf.splats"><option :value="500000">约 50 万（一体机）</option><option :value="2000000">约 200 万（PC）</option></select></div>
              <div class="note warn small" v-if="pano && seam && !seam.ok">接缝检查未通过的全景不能提交，需先执行接缝修复。</div>
              <button class="btn primary" :disabled="!pano" @click="submitWorld" id="btn-submit-world">提交世界生成</button></div></div>
            <div class="panel"><header><h3>世界生成结果</h3></header><div class="list"><button class="li" v-for="a in worlds" :key="a.id" @click="go('review',{asset:a.id})"><img :src="U.thumbOf(a)" alt=""><div class="grow"><div class="t1">{{ a.code }} · {{ a.name }}</div><div class="t2">{{ U.n(E.cur(a).splats) }} splat · {{ (E.cur(a).formats||[]).join('、') }}</div></div><c-pill :kind="U.assetPill(a.status)" :text="D.ASSET_STATUS[a.status]"></c-pill></button><div v-if="!worlds.length" class="body muted small">暂无结果</div></div></div>
          </template>
          <template v-if="tab==='video'">
            <div class="panel"><header><h3>360 视频片段</h3><span class="tag ver">V1.2</span></header><div class="body stack">
              <div class="field"><label>镜头描述</label><input class="inp" v-model="clip.prompt"></div>
              <div class="field"><label>时长 {{ clip.sec }} 秒</label><input type="range" class="range" min="3" max="12" v-model.number="clip.sec"></div>
              <div class="note small">以选中全景为首帧生成 360 视频片段，超分后可导出球幕视频（ffmpeg v360）。</div>
              <button class="btn primary" :disabled="!pano" @click="act(()=>E.enqueue({project_id:E.S.currentProjectId,node:'panorama',model_id:'qwen-360',params:{prompt:clip.prompt+'（360 视频 '+clip.sec+' 秒）',width:4096,height:2048,count:1,seed:pano.seed+1}}),'已提交 360 视频片段生成')">生成片段</button>
            </div></div>
          </template>
          <div class="panel"><header><h3>相关任务</h3></header><div class="list"><div class="li" v-for="t in tasks" :key="t.id"><div class="grow"><div class="t1 mono">{{ t.code }} · {{ D.NODE_NAMES[t.node] }}</div><div class="t2">{{ (E.model(t.model_id)||{}).name }}<template v-if="t.cost"> · ¥{{ t.cost }}</template></div></div><c-pill :kind="U.taskPill(t.status)" :text="D.TASK_STATUS[t.status]"></c-pill></div></div></div>
        </div>
      </div>
    </div>`,
  };

  // ====================== P07 实景重建 ======================
  P.recon = {
    setup() {
      const list = computed(() => { st.rev; return E.S.recon.filter(d => d.project_id === E.S.currentProjectId); });
      const selId = ref(list.value[0] && list.value[0].id);
      const d = computed(() => { st.rev; return selId.value && E.S.recon.find(x => x.id === selId.value); });
      const { el, vw } = useViewer(V.SplatViewer, {});
      const vmode = ref('splat'); const shown = ref(0);
      const redraw = () => { if (vw.value && d.value) shown.value = vw.value.show(d.value.status === 'uploaded' || d.value.status === 'solving' ? Object.assign({}, d.value, { registered: 0, floaters: false }) : d.value, d.value.step < 2 ? 'points' : vmode.value); };
      watch([vw, () => d.value && [d.value.id, d.value.step, d.value.floaters, d.value.cropped, d.value.registered].join(), vmode], () => nextTick(redraw));
      const task = computed(() => { st.rev; return d.value && E.S.tasks.find(t => t.recon_id === d.value.id && ['queued', 'running'].includes(t.status)); });
      const psnr = reactive({}); watch(() => task.value && task.value.metrics && task.value.metrics.psnr, (v) => { if (v && d.value) { (psnr[d.value.id] = psnr[d.value.id] || []).push(v); } });
      const jobs = computed(() => { st.rev; return E.S.jobs.filter(j => j.project_id === E.S.currentProjectId && j.content_type === 'recon'); });
      const nf = reactive({ name: '新展厅数据集', job_id: st.params.job || '', count: 0, sample: true });
      const onFiles = (e) => { nf.count = e.target.files.length; nf.sample = false; };
      const create = () => { const n = nf.sample ? 412 : nf.count; if (!n) return toast('请选择照片或使用示例素材集', 'err'); const r = act(() => E.createDataset({ name: nf.name, job_id: nf.job_id || null, photo_count: n, resolution: '6000×4000', device: nf.sample ? 'Sony A7R V + 24mm' : '本地上传', overlap: '约 75%' }), '素材已上传，已剔除模糊照片'); if (r) selId.value = r.id; };
      const est = computed(() => { if (!d.value) return 0; const m = E.model('lichtfeld'); return Math.round(m.unit_s * d.value.photo_count / 400 * d.value.iterations / 30000); });
      const mode = ref('auto');
      const train = () => act(() => E.trainGS(d.value.id, { iterations: d.value.iterations, sh: d.value.sh, splat_limit: d.value.splat_limit, platform: d.value.platform, mode: mode.value === 'auto' ? undefined : mode.value }), est.value > 3600 && mode.value === 'auto' ? '预计超过 60 分钟，已排入夜间窗口' : '已开始训练');
      const patch = (path, v) => act(() => E.patch('recon', d.value.id, path, v));
      const stepNames = ['上传素材', '位姿求解', '3DGS 训练', '清理浮点', '导出'];
      const exportFmt = ref('spz');
      const doExport = () => { const r = act(() => E.finishRecon(d.value.id), (a) => `已导出并送入质检：${a.code}`); if (r) { const sp = Geo.buildSplats(Geo.hash(d.value.code), 20000, false, true); const head = `ply\nformat ascii 1.0\ncomment SpatialContentWorks 3DGS export (demo, ${sp.count} pts)\nelement vertex ${sp.count}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`; let body = ''; for (let i = 0; i < sp.count; i++) body += `${sp.positions[i * 3].toFixed(3)} ${sp.positions[i * 3 + 1].toFixed(3)} ${sp.positions[i * 3 + 2].toFixed(3)} ${sp.colors[i * 3] * 255 | 0} ${sp.colors[i * 3 + 1] * 255 | 0} ${sp.colors[i * 3 + 2] * 255 | 0}\n`; if (exportFmt.value === 'ply') saveFile(d.value.code + '.ply', head + body, 'text/plain'); } };
      const capOk = computed(() => d.value && E.captureComplete(d.value));
      return { patch, list, selId, d, el, vmode, shown, task, psnr, jobs, nf, onFiles, create, est, mode, train, stepNames, exportFmt, doExport, capOk, E, D, U, st, go, act };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P07" ver="V1.1" title="实景重建（3DGS）" goal="用照片或视频重建真实空间和文物，输出 3DGS。本页不调用任何生成模型。"></c-head>
      <div class="panel" style="margin-bottom:12px" v-if="d"><div class="body"><c-steps :steps="stepNames" :cur="d.step"></c-steps></div></div>
      <div class="split3">
        <div class="stack">
          <div class="panel"><header><h3>素材集</h3></header><div class="list"><button class="li" v-for="x in list" :key="x.id" :class="{sel: selId===x.id}" @click="selId=x.id"><div class="grow"><div class="t1">{{ x.name }}</div><div class="t2">{{ x.code }} · {{ x.photo_count }} 张 · {{ {uploaded:'已上传',solving:'求解中',posed:'已求解',reshoot:'需补拍',training:'训练中',trained:'已训练',exported_qa:'已导出'}[x.status] }}</div></div></button></div>
            <div class="body stack"><div class="divider"></div><b class="small">新建素材集</b>
              <input class="inp" v-model="nf.name" aria-label="名称"><select class="inp" v-model="nf.job_id" aria-label="关联需求单"><option value="">不关联需求单</option><option v-for="j in jobs" :key="j.id" :value="j.id">{{ j.code }} {{ j.title }}</option></select>
              <input class="inp" type="file" multiple accept="image/*,video/*" @change="onFiles" aria-label="上传照片"><label class="check small"><input type="checkbox" v-model="nf.sample">使用示例素材集（412 张）</label>
              <button class="btn" @click="create" id="btn-create-ds">上传并剔除模糊</button></div></div>
          <div class="panel" v-if="d"><header><h3>文博采集记录</h3><c-pill :kind="capOk?'ok':'warn'" :text="capOk?'完整':'未完整'"></c-pill></header><div class="body stack">
            <div class="field"><label class="req">采集人</label><input class="inp" :value="d.capture_record.collector" @change="patch('capture_record.collector', $event.target.value)" id="cap-collector"></div>
            <div class="field"><label class="req">采集日期</label><input class="inp" type="date" :value="d.capture_record.date" @change="patch('capture_record.date', $event.target.value)" id="cap-date"></div>
            <div class="field"><label class="req">标尺 / 控制点</label><input class="inp" :value="d.capture_record.control" @change="patch('capture_record.control', $event.target.value)" placeholder="例：8 个控制点 + 1 m 标尺" id="cap-control"></div>
            <div class="field"><label class="req">色卡</label><input class="inp" :value="d.capture_record.colorChart" @change="patch('capture_record.colorChart', $event.target.value)" placeholder="例：X-Rite ColorChecker" id="cap-color"></div>
            <div class="kv small"><div>精度报告</div><div>{{ d.accuracy_report ? '已生成' : '训练完成后生成' }}</div></div>
          </div></div>
        </div>
        <div class="stack" style="min-width:0">
          <div class="viewport" style="height:460px"><div ref="el" style="position:absolute;inset:0"></div>
            <div class="vp-tools" v-if="d"><div class="seg"><button :class="{on:vmode==='splat'}" @click="vmode='splat'">Splat</button><button :class="{on:vmode==='points'}" @click="vmode='points'">点云</button></div><span class="spacer"></span>
              <button class="btn sm" :disabled="!d || d.status!=='trained' || !d.floaters" @click="act(()=>E.cleanRecon(d.id,'floaters'),'已框选删除浮点')">框选删除浮点</button><button class="btn sm" :disabled="!d || d.status!=='trained' || d.cropped" @click="act(()=>E.cleanRecon(d.id,'crop'),'已应用裁剪盒')">裁剪盒</button></div>
            <div class="vp-overlay" v-if="d"><span>已注册相机 {{ d.registered || 0 }} / {{ d.photo_count }}</span><span>splat {{ U.n(d.splats || 0) }}</span><span>显示 {{ U.n(shown) }} 点（演示抽样）</span></div>
            <div v-if="!d" class="vp-empty">新建素材集开始重建</div></div>
          <div class="panel" v-if="d"><header><h3>素材统计</h3></header><div class="body"><div class="grid g5 small">
            <div><div class="lbl">照片数</div><b class="num">{{ d.photo_count }}</b></div><div><div class="lbl">分辨率</div><b>{{ d.resolution }}</b></div><div><div class="lbl">设备</div><b>{{ d.device }}</b></div><div><div class="lbl">重叠度估计</div><b>{{ d.overlap }}</b></div><div><div class="lbl">模糊剔除</div><b class="num">{{ d.blurred }} 张</b></div></div>
            <div class="row" style="margin-top:10px"><span>相机注册率：</span><b class="num" :style="{color: d.registered_ratio!=null && d.registered_ratio<0.9 ? 'var(--err)' : ''}">{{ d.registered_ratio!=null ? (d.registered_ratio*100).toFixed(1)+'%' : '—' }}</b><span class="faint small">（低于 90% 提示补拍，不进入训练）</span><span class="spacer"></span>
              <button class="btn sm" v-if="d.status==='reshoot'" @click="act(()=>E.appendPhotos(d.id,60),'已追加 60 张补拍照片')">追加补拍素材</button>
              <label class="check small" v-if="d.status==='uploaded'"><input type="checkbox" :checked="d.forceLowRatio" @change="patch('forceLowRatio', $event.target.checked)">演示：模拟注册率不足</label>
              <button class="btn sm primary" :disabled="!['uploaded','reshoot'].includes(d.status) || d.status==='reshoot'" @click="act(()=>E.solvePoses(d.id),'已提交位姿求解（COLMAP）')" id="btn-solve">位姿求解</button></div>
            <div class="note warn" v-if="d.status==='reshoot'" style="margin-top:8px">相机注册率低于 90%，请补拍覆盖不足的区域后重新求解。</div>
          </div></div>
          <div class="panel" v-if="d && d.accuracy_report"><header><h3>精度报告</h3></header><div class="body"><div class="grid g5 small"><div><div class="lbl">重投影 RMSE</div><b>{{ d.accuracy_report.rmse_mm }} mm</b></div><div><div class="lbl">尺度误差</div><b>{{ d.accuracy_report.scale_error_pct }}%</b></div><div><div class="lbl">色差 ΔE</div><b>{{ d.accuracy_report.color_delta_e }}</b></div><div><div class="lbl">PSNR</div><b>{{ d.accuracy_report.psnr }} dB</b></div><div><div class="lbl">控制点</div><b>{{ d.accuracy_report.control_points }}</b></div></div></div></div>
        </div>
        <div class="stack" v-if="d">
          <div class="panel"><header><h3>训练参数</h3></header><div class="body stack">
            <div class="grid g2"><div class="field"><label>位姿求解</label><select class="inp" :value="d.solver" @change="patch('solver', $event.target.value)"><option value="colmap">COLMAP</option></select></div><div class="field"><label>训练引擎</label><select class="inp" :value="d.engine" @change="patch('engine', $event.target.value)"><option value="lichtfeld">LichtFeld Studio CLI</option><option value="gsplat">gsplat</option></select></div>
              <div class="field"><label>迭代次数</label><select class="inp" :value="d.iterations" @change="patch('iterations', +$event.target.value)"><option :value="7000">7,000</option><option :value="30000">30,000</option><option :value="60000">60,000</option></select></div><div class="field"><label>SH 阶数</label><select class="inp" :value="d.sh" @change="patch('sh', +$event.target.value)"><option :value="0">0</option><option :value="1">1</option><option :value="3">3</option></select></div>
              <div class="field"><label>目标平台档位</label><select class="inp" :value="d.platform" @change="patch('platform', $event.target.value)"><option value="quest3">一体机（Quest / PICO）</option><option value="xr_space">PC 串流</option><option value="webxr">WebXR</option></select></div><div class="field"><label>splat 上限</label><input class="inp" type="number" :value="d.splat_limit" @change="patch('splat_limit', +$event.target.value)"></div></div>
            <div class="kv small"><div>预计训练</div><div>{{ U.dur(est) }}</div><div>执行方式</div><div><select class="inp" v-model="mode"><option value="auto">{{ est>3600 ? '自动（超过 60 分钟排入夜间窗口）' : '自动（立即执行）' }}</option><option value="now">立即执行</option><option value="night">夜间窗口 22:00–07:00</option><option value="cloud">云端</option></select></div></div>
            <button class="btn primary" :disabled="d.status!=='posed'" @click="train" id="btn-train">开始训练</button>
          </div></div>
          <div class="panel"><header><h3>训练进度</h3><span class="sub" v-if="task">{{ task.code }} · {{ D.TASK_STATUS[task.status] }}{{ task.priority==='night'?'（夜间）':'' }}</span></header><div class="body stack">
            <template v-if="task && task.node==='gs_train'"><c-progress :v="task.progress"></c-progress><div class="kv small"><div>迭代</div><div class="num">{{ U.n(task.metrics.iteration||0) }} / {{ U.n(task.params.iterations) }}</div><div>PSNR</div><div class="num">{{ task.metrics.psnr || '—' }} dB</div><div>显存</div><div>{{ task.vram_peak ? task.vram_peak.toFixed(1)+' GB' : '—' }}</div><div>剩余</div><div>{{ U.dur(task.duration-task.elapsed) }}</div></div><c-line :values="psnr[d.id]||[]" :min="15" :max="32" :height="70"></c-line></template>
            <template v-else-if="task"><c-progress :v="task.progress"></c-progress><span class="small">{{ D.NODE_NAMES[task.node] }} {{ Math.round(task.progress*100) }}%</span></template>
            <div v-else-if="d.psnr" class="small">训练完成 · PSNR {{ d.psnr }} dB · {{ U.n(d.splats) }} splat</div><div v-else class="faint small">尚未开始</div>
          </div></div>
          <div class="panel"><header><h3>导出</h3></header><div class="body stack">
            <div class="seg"><button v-for="x in [['spz','SPZ'],['ply','PLY'],['gltf','glTF + KHR_gaussian_splatting']]" :key="x[0]" :class="{on: exportFmt===x[0]}" @click="exportFmt=x[0]">{{ x[1] }}</button></div>
            <div class="note warn small" v-if="!capOk">采集记录未填写完整时不能导出。</div>
            <button class="btn primary" :disabled="d.status!=='trained'" @click="doExport" id="btn-recon-export">导出并送入质检</button>
          </div></div>
        </div>
      </div>
    </div>`,
  };

  // ====================== P08 角色与动画 ======================
  P.character = {
    setup() {
      const list = computed(() => { st.rev; return E.S.characters.filter(c => c.project_id === E.S.currentProjectId); });
      const selId = ref(list.value[0] && list.value[0].id);
      const c = computed(() => { st.rev; return selId.value && E.S.characters.find(x => x.id === selId.value); });
      const { el, vw } = useViewer(V.CharacterViewer);
      const mode = ref('mesh'); const playing = ref(false); const selClip = ref(null);
      watch([vw, () => c.value && c.value.id, () => c.value && c.value.status, mode], () => { if (!vw.value || !c.value) return; vw.value.rigged = ['rigged', 'weights'].includes(c.value.status); vw.value.setMode(mode.value, c.value.issues); });
      const play = () => { if (!c.value.clips.length) return toast('时间线为空', 'err'); vw.value.play(c.value.clips); playing.value = true; };
      const stop = () => { vw.value.stop(); playing.value = false; };
      const mg = reactive({ text: '讲解员抬起右手指向展柜，介绍文物', engine: 'hunyuan-motion-api', duration: 3, fmt: 'fbx' });
      const engines = computed(() => { st.rev; return E.modelsFor('motion_gen', E.project()); });
      const rigOk = computed(() => { st.rev; return E.modelAllowed('unirig'); });
      const total = computed(() => c.value ? c.value.clips.reduce((s, x) => s + x.duration, 0) : 0);
      const head = ref(0); let raf; const loop = () => { raf = requestAnimationFrame(loop); if (vw.value && playing.value) head.value = vw.value.clipT || 0; }; onMounted(loop); onUnmounted(() => cancelAnimationFrame(raf));
      const tasks = computed(() => { st.rev; return c.value ? E.S.tasks.filter(t => t.char_id === c.value.id && ['queued', 'running'].includes(t.status)) : []; });
      const newChar = () => { const r = act(() => E.createCharacter({ name: '新角色 ' + (list.value.length + 1) }), '已创建角色（生成网格，待绑骨）'); if (r) selId.value = r.id; };
      const exportAnim = () => { const x = c.value; if (!x.clips.length) return toast('时间线为空', 'err'); const bvh = Geo.toBVH(x.clips); E.audit('导出动作', x.code, mg.fmt.toUpperCase()); if (mg.fmt === 'bvh') saveFile(x.code + '.bvh', bvh, 'text/plain'); else saveFile(x.code + '_anim.bvh', bvh, 'text/plain').then(() => toast('FBX 由部署版 Blender 无头进程由 BVH + 网格合成，演示版提供 BVH', 'warn')); };
      const removeClip = (i) => act(() => E.removeClip(c.value.id, i));
      return { list, selId, c, el, mode, playing, selClip, play, stop, mg, engines, rigOk, total, head, tasks, newChar, exportAnim, removeClip, Geo, E, D, U, st, act };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P08" ver="V1.2" title="角色与动画" goal="为角色模型绑骨并生成或拼接动作。"><button class="btn" @click="newChar">新建角色</button></c-head>
      <div class="note warn" style="margin-bottom:12px">生成角色不支持表情动画。面部表情需在 DCC 工具中手工制作或使用外部绑定。</div>
      <div class="split3">
        <div class="panel"><header><h3>角色列表</h3></header><div class="list"><button class="li" v-for="x in list" :key="x.id" :class="{sel: selId===x.id}" @click="selId=x.id"><div class="grow"><div class="t1">{{ x.name }}</div><div class="t2">{{ x.code }} · {{ U.n(x.tris) }} 面 · {{ x.bones || 0 }} 骨骼</div></div><c-pill :kind="{unrigged:'plain',rigging:'run',weights:'warn',rigged:'ok'}[x.status]" :text="{unrigged:'待绑骨',rigging:'绑骨中',weights:'权重需修',rigged:'已绑骨'}[x.status]"></c-pill></button><div v-if="!list.length" class="body muted small">当前项目没有角色</div></div></div>
        <div class="stack" style="min-width:0">
          <div class="viewport" style="height:420px"><div ref="el" style="position:absolute;inset:0"></div>
            <div class="vp-tools"><div class="seg"><button v-for="m in [['mesh','网格'],['bones','骨骼'],['weights','权重']]" :key="m[0]" :class="{on:mode===m[0]}" @click="mode=m[0]">{{ m[1] }}</button></div><span class="spacer"></span><button class="btn sm" @click="playing ? stop() : play()" :disabled="!c || c.status!=='rigged'">{{ playing ? '停止' : '播放时间线' }}</button></div>
            <div class="vp-overlay" v-if="c"><span>骨骼 {{ c.bones || 0 }}</span><span>面数 {{ U.n(c.tris) }}</span><span v-if="playing">{{ head.toFixed(1) }} / {{ total.toFixed(1) }} 秒</span></div></div>
          <div class="panel" v-if="c"><header><h3>时间线</h3><span class="sub">相邻动作自动插入融合过渡</span><span class="right"><select class="inp" v-model="mg.fmt" style="width:auto"><option value="fbx">FBX</option><option value="bvh">BVH</option></select><button class="btn sm primary" @click="exportAnim">导出</button></span></header>
            <div class="body timeline">
              <div class="tl-track"><span>动作</span><div class="tl-row"><div v-for="(cl,i) in c.clips" :key="cl.id" class="tl-clip" :class="{sel: selClip===i}" :style="{width: (cl.duration/Math.max(total,1)*100)+'%', background: U.color(cl.motion)}" @click="selClip=i">{{ cl.name }}</div><div class="tl-head" v-if="playing" :style="{left: (head/Math.max(total,1)*100)+'%'}"></div></div></div>
              <div class="tl-track"><span>过渡</span><div class="tl-row"><template v-for="(cl,i) in c.clips" :key="'b'+cl.id"><div :style="{width: ((cl.duration-(i<c.clips.length-1?cl.blend:0))/Math.max(total,1)*100)+'%'}"></div><div v-if="i<c.clips.length-1" class="tl-blend" :style="{width:(cl.blend/Math.max(total,1)*100)+'%'}" :title="'融合 '+cl.blend+' 秒'"></div></template></div></div>
              <div class="tl-track"><span>修帧标记</span><div class="tl-row"><div v-for="(cl,i) in c.clips" :key="'m'+cl.id" :style="{width:(cl.duration/Math.max(total,1)*100)+'%', position:'relative'}"><span v-if="cl.source && cl.source.includes('文生')" style="position:absolute;left:40%;top:6px;color:var(--warn)">▲</span></div></div></div>
              <div v-if="selClip!=null && c.clips[selClip]" class="row" style="margin-top:6px"><b class="small">{{ c.clips[selClip].name }}</b><span class="small muted">来源 {{ c.clips[selClip].source }}</span><label class="small">时长 <input class="inp" style="width:70px" type="number" step="0.5" min="0.5" @change="act(()=>E.updateClip(c.id, selClip, {duration: $event.target.value}))" :value="c.clips[selClip].duration"></label><label class="small">融合过渡 <input class="inp" style="width:70px" type="number" step="0.1" min="0" max="1.5" @change="act(()=>E.updateClip(c.id, selClip, {blend: $event.target.value}))" :value="c.clips[selClip].blend"> 秒</label><button class="btn sm danger" @click="removeClip(selClip); selClip=null">移除</button></div>
            </div></div>
        </div>
        <div class="stack" v-if="c">
          <div class="panel"><header><h3>自动绑骨</h3></header><div class="body stack">
            <div class="kv small"><div>骨骼模板</div><div>人形 17 骨骼（Mixamo 命名兼容）</div><div>绑定方式</div><div>{{ c.rig_by || '—' }}</div></div>
            <div class="note warn small" v-if="!rigOk.ok">UniRig：{{ rigOk.reason }}。可改用外部导入绑定。</div>
            <div class="row"><button class="btn primary" :disabled="c.status!=='unrigged' || !rigOk.ok" @click="act(()=>E.rigCharacter(c.id,'unirig'),'已提交 UniRig 自动绑骨')">UniRig 自动绑骨</button><button class="btn" :disabled="c.status==='rigging'" @click="act(()=>E.rigCharacter(c.id,'import'),'已导入外部绑定')">导入外部绑定</button></div>
            <div v-if="c.issues && c.issues.length"><div class="lbl">权重自检</div><div v-for="i in c.issues" :key="i.bone" class="small" style="color:var(--err)">● {{ i.note }}（{{ i.bone }}）</div>
              <button class="btn sm" style="margin-top:6px" v-if="c.status==='weights'" @click="act(()=>E.confirmWeights(c.id),'已确认穿插处理，可进入场景')">人工确认已处理</button></div>
            <div v-for="t in tasks" :key="t.id" class="row small"><span class="mono">{{ t.code }}</span>{{ D.NODE_NAMES[t.node] }}<c-progress :v="t.progress" style="flex:1"></c-progress></div>
          </div></div>
          <div class="panel"><header><h3>动作生成</h3></header><div class="body stack">
            <div class="field"><label>动作描述</label><textarea class="inp" v-model="mg.text" rows="2"></textarea></div>
            <div class="field"><label>引擎</label><select class="inp" v-model="mg.engine"><option v-for="o in engines" :key="o.m.id" :value="o.m.id" :disabled="!o.ok">{{ o.m.name }}{{ o.ok ? '' : '（'+o.reason+'）' }}</option></select><span class="faint small">文生动作默认使用云 API；本地模型受许可证规则限制</span></div>
            <div class="field"><label>时长 {{ mg.duration }} 秒</label><input type="range" class="range" min="1" max="8" step="0.5" v-model.number="mg.duration"></div>
            <button class="btn primary" :disabled="c.status!=='rigged'" @click="act(()=>E.genMotion(c.id,mg.text,mg.engine,mg.duration),'已提交文生动作（云 API）')">生成动作</button>
            <div class="divider"></div><div class="lbl">动作库</div>
            <div class="row"><button class="btn sm" v-for="(m,k) in Geo.MOTIONS" :key="k" :disabled="c.status!=='rigged'" @click="act(()=>E.addClip(c.id,k))">+ {{ m.name }}</button></div>
          </div></div>
        </div>
      </div>
    </div>`,
  };

  // ====================== P09 场景组装 ======================
  P.assembly = {
    setup() {
      const list = computed(() => { st.rev; return E.S.scenes.filter(s => s.project_id === E.S.currentProjectId); });
      const selId = ref(st.params.scene || (list.value[0] && list.value[0].id));
      const sc = computed(() => { st.rev; return selId.value && E.S.scenes.find(s => s.id === selId.value); });
      const { el, vw } = useViewer(V.SceneViewer, {});
      const selItem = ref(null);
      watch([vw, () => sc.value && (sc.value.id + ':' + (sc.value.rev || 0) + ':' + sc.value.items.length)], () => { if (vw.value && sc.value) { vw.value.sync(sc.value, (id) => E.version(id)); vw.value.onSelect = (iid) => { selItem.value = iid; }; vw.value.refreshBox(); } });
      onMounted(() => { act(() => E.setViewport(true)); }); onUnmounted(() => { act(() => E.setViewport(false)); });
      const input = ref(''); const chat = ref(null);
      watch(() => sc.value && sc.value.messages.length + ':' + (sc.value.messages[sc.value.messages.length - 1] || {}).text, () => nextTick(() => { if (chat.value) chat.value.scrollTop = chat.value.scrollHeight; }));
      const send = () => { if (act(() => E.agentSend(sc.value.id, input.value)) !== undefined || true) input.value = ''; };
      const examples = ['中央放一个青铜鼎，两侧各放一盏宫灯，后方放两件编钟', '在前方放一排三件瓷瓶，打暖色主光', '设置主相机', '用 Python 脚本把展品对齐到地面', '删除所有宫灯'];
      const budget = computed(() => { st.rev; return sc.value ? E.sceneBudget(sc.value) : null; });
      const item = computed(() => sc.value && selItem.value && sc.value.items.find(i => i.id === selItem.value));
      const nudge = (axis, d) => { const it = item.value; const p = it.pos.slice(); p[axis] = +(p[axis] + d).toFixed(2); act(() => { E.moveItem(sc.value.id, it.id, p); E.audit('视口手动调整（写回 Blender 会话）', sc.value.code, `${it.name} → ${p.join(', ')}`); }); };
      const rot = (d) => { const it = item.value; act(() => E.moveItem(sc.value.id, it.id, null, (it.rotY || 0) + d)); };
      const scale = (d) => { const it = item.value; act(() => E.scaleItem(sc.value.id, it.id, +((it.scale || 1) + d).toFixed(2))); };
      const snap = () => { const it = item.value; const p = it.pos.slice(); p[1] = 0; act(() => E.moveItem(sc.value.id, it.id, p)); };
      const still = () => { const url = vw.value.snapshot(); act(() => E.addStill(sc.value.id, url), '静帧已渲染'); };
      const preview = async () => { toast('播放短预览（相机环绕 6 秒）'); await vw.value.orbit(6); };
      const view = ref('persp'); watch(view, (v) => vw.value && vw.value.setView(v));
      const newScene = () => { const r = act(() => E.createScene({ name: '新场景 ' + (list.value.length + 1), platform: 'quest3' }), '已创建场景与 Blender 会话'); if (r) selId.value = r.id; };
      const confirmPending = async (ok) => { act(() => E.agentConfirm(sc.value.id, ok)); };
      const stepItems = computed(() => { const s = sc.value; if (!s) return []; const b = budget.value; return [
        [['布局中有资产', s.items.length > 0], ['已布置主光', s.lights.some(l => l.type === 'directional')]],
        [['已渲染静帧', s.stills.length > 0]],
        [['预算全部 ≤ 100%', !b.over], ['无对象穿插', !(s.audit && s.audit.overlaps && s.audit.overlaps.length)]],
        [['无角色，可跳过', true]],
        [['已播放短预览', true]],
        [['预算全部 ≤ 100%', !b.over]]][s.step] || []; });
      const assets = computed(() => { st.rev; return E.sceneAssets(); });
      const addManual = (a) => act(() => E.addSceneItem(sc.value.id, a.id), '已加入场景');
      return { list, selId, sc, el, selItem, input, chat, send, examples, budget, item, nudge, rot, scale, snap, still, preview, view, newScene, confirmPending, stepItems, assets, addManual, E, D, U, st, act };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P09" ver="V1.1" title="场景组装" goal="用文字指令让 Agent 从资产库取件布景，人工分步确认。">
        <select class="inp" style="width:auto" v-model="selId"><option v-for="s in list" :key="s.id" :value="s.id">{{ s.code }} · {{ s.name }}</option></select><button class="btn" @click="newScene">新建场景</button>
      </c-head>
      <div v-if="!sc" class="panel"><div class="body muted">还没有场景，点击“新建场景”。</div></div>
      <template v-else>
        <div class="panel" style="margin-bottom:12px"><div class="body row"><c-steps :steps="D.STEPS" :cur="sc.final ? 6 : sc.step"></c-steps><span class="spacer"></span><span class="small muted">平台预算：</span><select class="inp" style="width:auto" :value="sc.platform" @change="act(()=>E.patch('scene', sc.id, 'platform', $event.target.value))"><option v-for="(n,k) in {quest3:'Quest 3',webxr:'WebXR',xr_space:'XR 大空间'}" :key="k" :value="k">{{ n }}</option></select></div></div>
        <div class="split3">
          <div class="panel" style="display:flex;flex-direction:column;height:640px"><header><h3>Agent 对话</h3><span class="sub">{{ E.model(E.S.settings.llm.orchestrator).name }}</span></header>
            <div class="chat" ref="chat" style="flex:1">
              <div v-for="(m,i) in sc.messages" :key="i" class="msg" :class="m.role">{{ m.text }}<div v-for="(t,j) in (m.tools||[])" :key="j" class="toolcall"><span class="nm">{{ t.name }}</span> <span>{{ JSON.stringify(t.args) }}</span><div class="rs" v-if="t.result">→ {{ t.result }} <span class="faint">{{ t.ms }}ms</span></div></div></div>
            </div>
            <div class="body stack" style="border-top:1px solid var(--line)">
              <div class="row"><button class="btn sm ghost" v-for="x in examples" :key="x" @click="input=x" style="white-space:normal;text-align:left">{{ x }}</button></div>
              <div class="row nowrap"><input class="inp" v-model="input" @keydown.enter="send" placeholder="描述布景，例如：中央放一个青铜鼎…" id="agent-input"><button class="btn primary" @click="send" id="agent-send">发送</button></div>
            </div></div>
          <div class="stack" style="min-width:0">
            <div class="viewport" style="height:440px"><div ref="el" style="position:absolute;inset:0"></div>
              <div class="vp-tools"><div class="seg"><button v-for="v in [['persp','透视'],['top','顶视'],['main','主相机']]" :key="v[0]" :class="{on:view===v[0]}" @click="view=v[0]">{{ v[1] }}</button></div><span class="spacer"></span><button class="btn sm" @click="still" id="btn-still">渲染静帧</button><button class="btn sm" @click="preview">短预览</button></div>
              <div class="vp-overlay"><span>Blender 会话同步 · {{ sc.blend_path }}</span><span>对象 {{ sc.items.length }}</span></div></div>
            <div class="panel" v-if="item"><header><h3>{{ item.name }}</h3><span class="sub">手动调整，写回 Blender 会话</span><span class="right"><button class="btn sm ghost" @click="selItem=null">关闭</button></span></header><div class="body row">
              <span class="small">移动</span><button class="btn sm" @click="nudge(0,-0.25)">X−</button><button class="btn sm" @click="nudge(0,0.25)">X+</button><button class="btn sm" @click="nudge(2,-0.25)">Z−</button><button class="btn sm" @click="nudge(2,0.25)">Z+</button><button class="btn sm" @click="nudge(1,0.1)">Y+</button>
              <span class="small">旋转</span><button class="btn sm" @click="rot(-Math.PI/8)">↺</button><button class="btn sm" @click="rot(Math.PI/8)">↻</button>
              <span class="small">缩放</span><button class="btn sm" @click="scale(-0.1)">−</button><button class="btn sm" @click="scale(0.1)">+</button><button class="btn sm" @click="snap">吸附地面</button>
              <span class="mono small muted">{{ item.pos.map(x=>x.toFixed(2)).join(', ') }}</span></div></div>
            <div class="panel"><header><h3>待确认区</h3><span class="sub">第 {{ Math.min(sc.step+1,6) }} 步 · {{ D.STEPS[sc.step] }}</span></header><div class="body stack">
              <div v-if="sc.pending" class="note warn"><b>Agent 请求执行 {{ sc.pending.tool }}，需要人工确认：</b><pre class="code" style="margin-top:6px">{{ sc.pending.code }}</pre><div class="row" style="margin-top:6px"><button class="btn sm" @click="confirmPending(false)">拒绝</button><button class="btn sm primary" @click="confirmPending(true)" id="btn-confirm-python">确认执行</button></div></div>
              <div v-for="ci in stepItems" :key="ci[0]" class="row small"><span :class="ci[1]?'res-pass':'res-fail'">{{ ci[1] ? '✓' : '✗' }}</span>{{ ci[0] }}</div>
              <div class="row" v-if="sc.stills.length"><img v-for="(s,i) in sc.stills" :key="i" :src="s.url" style="width:30%;border-radius:4px;border:1px solid var(--line)" alt="静帧"></div>
              <div class="row" v-if="!sc.final"><button class="btn" @click="act(()=>E.sceneConfirm(sc.id,true),'已退回，Agent 保留上下文继续修改')">退回修改</button><button class="btn primary" @click="act(()=>E.sceneConfirm(sc.id),'已确认')" id="btn-step-confirm">确认{{ sc.step===5 ? '最终输出' : '，进入下一步' }}</button></div>
              <div v-else class="row"><c-pill kind="ok" text="六步流程已完成"></c-pill><button class="btn primary sm" @click="go('export',{scene:sc.id})">去导出发布</button></div>
            </div></div>
          </div>
          <div class="stack">
            <div class="panel"><header><h3>性能预算</h3><span class="sub">{{ budget.preset }}</span></header><div class="body stack">
              <div v-for="r in budget.rows" :key="r.key" class="budget-row" :class="{over: r.pct>1, near: r.pct>0.85 && r.pct<=1}"><span>{{ r.name }}</span><c-progress :v="Math.min(1,r.pct)"></c-progress><span class="num small" style="text-align:right">{{ U.k(r.used) }}{{ r.unit||'' }} / {{ U.k(r.limit) }}{{ r.unit||'' }} · {{ Math.round(r.pct*100) }}%</span></div>
              <div v-if="budget.over" class="note err small">预算有超过 100% 的项，不能进入最终输出。</div></div></div>
            <div class="panel"><header><h3>场景大纲</h3><span class="sub">{{ sc.items.length }} 个对象</span></header><div class="list" style="max-height:260px;overflow-y:auto">
              <button class="li" v-for="it in sc.items" :key="it.id" :class="{sel: selItem===it.id}" @click="selItem=it.id"><div class="grow"><div class="t1">{{ it.name }}</div><div class="t2 mono">{{ it.pos.map(x=>x.toFixed(1)).join(', ') }}</div></div><span class="small num">{{ U.n(U.stats(E.version(it.version_id)).tris) }} 面</span></button>
              <div class="li" v-for="l in sc.lights" :key="l.type"><div class="grow"><div class="t1">{{ l.type==='ambient' ? '环境光' : '主光（太阳）' }}</div><div class="t2">{{ l.color }} · {{ l.intensity }}</div></div></div>
              <div class="li"><div class="grow"><div class="t1">主相机</div><div class="t2 mono">{{ sc.camera.pos.join(', ') }}</div></div></div></div></div>
            <div class="panel"><header><h3>可用资产</h3><span class="sub">已入库且许可合规</span></header><div class="list" style="max-height:220px;overflow-y:auto"><button class="li" v-for="a in assets" :key="a.id" @click="addManual(a)"><img :src="U.thumbOf(a)" alt=""><div class="grow"><div class="t1">{{ a.name }}</div><div class="t2">{{ a.code }}</div></div><span class="small">+ 加入</span></button><div v-if="!assets.length" class="body small muted">资产库中还没有可用资产</div></div></div>
          </div>
        </div>
      </template>
    </div>`,
  };
})(window);
