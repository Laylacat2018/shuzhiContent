/* P01–P05 */
(function (global) {
  'use strict';
  const { ref, shallowRef, reactive, computed, watch, onMounted, onUnmounted } = Vue;
  const E = global.Engine, Geo = global.Geo, V = global.Viewers, D = E.dict, { st, act, go, toast, confirmBox, U } = global.SCW;
  const P = global.SCW_PAGES = global.SCW_PAGES || {};

  // ====================== P01 工作台 ======================
  P.workbench = {
    setup() {
      const s = computed(() => { st.rev; return E.stats(); });
      const running = computed(() => { st.rev; return E.S.tasks.filter(t => ['running', 'queued', 'paused'].includes(t.status)).sort((a, b) => (b.status === 'running') - (a.status === 'running') || a.created_at - b.created_at).slice(0, 8); });
      const sevOrder = { error: 0, warn: 1, info: 2, ok: 3 };
      const alerts = computed(() => { st.rev; return E.S.alerts.slice(0, 30).sort((a, b) => sevOrder[a.level] - sevOrder[b.level] || b.time - a.time).slice(0, 8); });
      const pending = computed(() => { st.rev; return E.S.assets.filter(a => a.project_id === E.S.currentProjectId && a.status === 'review').sort((a, b) => a.review_since - b.review_since).slice(0, 10); });
      const rw = computed(() => { st.rev; return E.reworkStats(); });
      const readAll = () => act(() => E.readAlerts());
      const board = [['jobs', '需求单', 'jobs'], ['concepts', '概念图', 'concepts'], ['gen3d', '3D 生成', 'gen3d'], ['optimize', '优化', 'optimize'], ['review', '质检审核', 'review'], ['library', '已入库', 'library'], ['exported', '已导出', 'library']];
      return { s, running, alerts, pending, rw, readAll, board, U, E, D, go, st, act };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P01" ver="V1.0" title="工作台" goal="查看产能、待办和异常，决定下一步处理什么。指标按当前项目统计。">
        <button class="btn primary" @click="go('jobs',{create:true})">新建需求单</button>
      </c-head>
      <div class="grid g5" style="margin-bottom:12px">
        <button class="kpi" @click="go('review')"><span class="k">今日候选资产</span><span class="v">{{ s.candidatesToday }}<small>件</small></span><span class="d">目标 ≥ 100 件 / 日（完成自动质检）</span></button>
        <button class="kpi" @click="go('review')"><span class="k">待人工审核</span><span class="v" :style="{color: s.pendingReview ? 'var(--bronze)' : ''}">{{ s.pendingReview }}<small>件</small></span><span class="d">点击进入质检审核</span></button>
        <button class="kpi" @click="go('queue')"><span class="k">队列中任务</span><span class="v">{{ s.queue }}</span><span class="d">GPU {{ s.queueGpu }} · CPU {{ s.queueCpu }} · 云 {{ s.queueCloud }}</span></button>
        <button class="kpi" @click="go('review')"><span class="k">今日审核通过率</span><span class="v">{{ U.pct(s.passRate) }}</span><span class="d">通过 {{ s.pass }} / (通过 {{ s.pass }} + 返工 {{ s.rework }} + 废弃 {{ s.discard }})</span></button>
        <button class="kpi" @click="go('queue')"><span class="k">云 GPU 本月费用</span><span class="v">¥{{ s.cloudMonth.toFixed(2) }}</span><span class="d">预算参考 ¥500–2,000 / 月</span></button>
      </div>
      <div class="panel" style="margin-bottom:12px"><header><h3>管线看板</h3><span class="sub">各环节在制数量，点击跳转并带筛选条件</span></header>
        <div class="board"><button v-for="b in board" :key="b[0]" @click="go(b[2], {filter: b[0]})" :data-stage="b[0]"><div class="n">{{ s.board[b[0]] }}</div><div class="s">{{ b[1] }}</div></button></div>
      </div>
      <div class="split" style="margin-bottom:12px">
        <div class="stack">
          <div class="panel"><header><h3>运行中与排队任务</h3><span class="right"><button class="btn sm" @click="go('queue')">全部任务</button></span></header>
            <div class="tbl-wrap"><table class="tbl"><thead><tr><th>任务号</th><th>节点</th><th>模型</th><th>执行位置</th><th>状态</th><th style="width:140px">进度</th></tr></thead>
              <tbody><tr v-for="t in running" :key="t.id"><td class="mono">{{ t.code }}</td><td>{{ D.NODE_NAMES[t.node] }}</td><td>{{ (E.model(t.model_id)||{}).name }}</td><td>{{ {local:'本地', 'local-cpu':'本地 CPU', cloud:'云'}[t.executor] }}</td><td><c-pill :kind="U.taskPill(t.status)" :text="t.priority==='night'&&t.status==='queued'?'夜间排队':D.TASK_STATUS[t.status]"></c-pill></td><td><div class="row nowrap"><c-progress :v="t.progress" style="flex:1"></c-progress><span class="small num">{{ Math.round(t.progress*100) }}%</span></div></td></tr>
              <tr v-if="!running.length"><td colspan="6" class="muted" style="text-align:center;padding:18px">当前没有排队任务</td></tr></tbody></table></div>
          </div>
          <div class="panel"><header><h3>GPU 显存</h3><span class="sub">近 30 分钟 · RTX 4090 24GB · 每 2 秒推送</span></header><div class="body"><c-vram :history="E.S.gpu.history" :height="150"></c-vram></div></div>
        </div>
        <div class="stack">
          <div class="panel"><header><h3>提醒</h3><span class="sub">阻断类在前</span><span class="right"><button class="btn sm ghost" @click="readAll">全部已读</button></span></header>
            <div><div v-for="a in alerts" :key="a.id" class="alert-li" :style="{opacity: a.read ? .6 : 1}"><span class="sev" :class="a.level"></span><div style="flex:1;min-width:0">{{ a.message }}<div class="faint small">{{ U.ago(a.time) }}</div></div><button v-if="a.link" class="btn sm ghost" @click="act(()=>E.readAlerts(a.id)); go(a.link==='settings'?'system':a.link)">查看</button></div></div>
          </div>
          <div class="panel"><header><h3>待审核</h3><span class="sub">按等待时间排序</span></header>
            <div class="body"><div class="thumbs" style="grid-template-columns:repeat(auto-fill,minmax(78px,1fr))"><button class="thumb" v-for="a in pending" :key="a.id" @click="go('review',{asset:a.id})" :title="a.name"><img class="img" :src="U.thumbOf(a)" alt=""><div class="cap"><span class="small">{{ U.ago(a.review_since) }}</span></div></button></div><div v-if="!pending.length" class="muted small">没有待审核资产</div></div>
          </div>
        </div>
      </div>
      <div class="grid g2">
        <div class="panel"><header><h3>返工原因与通过率 · 按模型</h3></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>模型</th><th class="r">通过</th><th class="r">返工</th><th class="r">废弃</th><th class="r">通过率</th><th>主要返工原因</th></tr></thead><tbody><tr v-for="(v,k) in rw.byModel" :key="k"><td>{{ k }}</td><td class="r">{{ v.pass }}</td><td class="r">{{ v.rework }}</td><td class="r">{{ v.discard }}</td><td class="r">{{ U.pct(v.pass/(v.pass+v.rework+v.discard)) }}</td><td class="small">{{ Object.entries(v.reasons).map(([r,n])=>D.REWORK_REASONS[r]+' '+n).join('，') || '—' }}</td></tr></tbody></table></div></div>
        <div class="panel"><header><h3>返工原因与通过率 · 按需求单</h3></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>需求单</th><th class="r">通过</th><th class="r">返工</th><th class="r">废弃</th><th class="r">通过率</th><th>主要返工原因</th></tr></thead><tbody><tr v-for="(v,k) in rw.byJob" :key="k"><td class="mono">{{ k }}</td><td class="r">{{ v.pass }}</td><td class="r">{{ v.rework }}</td><td class="r">{{ v.discard }}</td><td class="r">{{ U.pct(v.pass/(v.pass+v.rework+v.discard)) }}</td><td class="small">{{ Object.entries(v.reasons).map(([r,n])=>D.REWORK_REASONS[r]+' '+n).join('，') || '—' }}</td></tr></tbody></table></div></div>
      </div>
    </div>`,
  };

  // ====================== P02 需求单 ======================
  P.jobs = {
    setup() {
      const mode = ref(st.params.create ? 'new' : 'list');
      const sel = ref(null);
      const step = ref(0);
      const blank = () => ({ title: '', project_id: E.S.currentProjectId, quantity: 20, description: '', ref_images: [], content_type: 'prop', platforms: (E.project().default_platforms || ['quest3']).slice(), usage_scope: E.project().usage_scope, style_lora: '', is_heritage: null, models: {} });
      const f = reactive(blank());
      const editing = ref(null);
      const pre = computed(() => { st.rev; try { return E.precheck(Object.assign({}, f, { is_heritage: !!f.is_heritage })); } catch (e) { return null; } });
      watch(() => f.is_heritage, (v) => { if (v) f.content_type = 'recon'; });
      watch(() => f.project_id, (pid) => { const p = E.project(pid); f.usage_scope = p.usage_scope; });
      const jobs = computed(() => { st.rev; const fl = st.params.filter; return E.S.jobs.filter(j => j.project_id === E.S.currentProjectId && (fl !== 'jobs' || ['submitted', 'producing'].includes(j.status))); });
      const cur = computed(() => { st.rev; return sel.value && E.S.jobs.find(j => j.id === sel.value); });
      const curTasks = computed(() => { st.rev; return cur.value ? E.S.tasks.filter(t => t.job_id === cur.value.id) : []; });
      const curAssets = computed(() => { st.rev; return cur.value ? E.S.assets.filter(a => a.job_id === cur.value.id) : []; });
      const loras = computed(() => E.S.models.filter(m => m.node === 'lora'));
      const stepNames = ['基本信息', '内容类型', '目标平台', '管线模板', '确认提交'];
      const next = () => { if (step.value === 0 && !f.title) return toast('请填写需求名称', 'err'); if (step.value === 1 && f.is_heritage === null) return toast('“是否文物本体”为必填项', 'err'); if (step.value === 2 && !f.platforms.length) return toast('请至少选择一个目标平台', 'err'); step.value = Math.min(4, step.value + 1); };
      const togglePlat = (p) => { const i = f.platforms.indexOf(p); i >= 0 ? f.platforms.splice(i, 1) : f.platforms.push(p); };
      const onRef = async (e) => { try { f.ref_images = E.S.runtime?.mode === 'production' ? await global.SCW.uploadFiles(e.target.files) : [...e.target.files].map(x => x.name); } catch (err) { toast(err.message, 'err'); } };
      const save = (submit) => {
        const payload = JSON.parse(JSON.stringify(f));
        const j = act(() => { let job; if (editing.value) job = E.updateJob(editing.value, payload); else job = E.createJob(payload); if (submit) E.submitJob(job.id); return job; }, submit ? (j) => `已提交 ${j.code}，任务已拆分进入队列` : '已存为草稿');
        if (j) { mode.value = 'list'; sel.value = j.id; Object.assign(f, blank()); step.value = 0; editing.value = null; }
      };
      const newJob = () => { Object.assign(f, blank()); step.value = 0; editing.value = null; mode.value = 'new'; };
      const editDraft = (j) => { Object.assign(f, JSON.parse(JSON.stringify(j))); f.models = j.models || {}; editing.value = j.id; step.value = 0; mode.value = 'new'; };
      const submitDraft = (j) => act(() => E.submitJob(j.id), '已提交并拆分任务');
      const nodeOptions = (type) => E.modelsFor(type, Object.assign({}, E.project(f.project_id), { usage_scope: f.usage_scope }));
      const templateExample = 'concept → pick(人工) → gen3d → optimize → qa → review(人工)';
      return { mode, sel, step, f, pre, jobs, cur, curTasks, curAssets, loras, stepNames, next, togglePlat, onRef, save, newJob, editDraft, submitDraft, nodeOptions, templateExample, E, D, U, st, go, act };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P02" ver="V1.0" title="需求单" goal="用表单描述要生产的内容，由平台匹配管线并做合规预检。">
        <button class="btn" v-if="mode==='new'" @click="mode='list'">返回列表</button>
        <button class="btn primary" v-else @click="newJob" id="btn-new-job">新建需求单</button>
      </c-head>
      <template v-if="mode==='new'">
        <div class="panel" style="margin-bottom:12px"><div class="body"><c-steps :steps="stepNames" :cur="step" click @go="i=>step=i"></c-steps></div></div>
        <div class="split">
          <div class="panel"><div class="body stack">
            <template v-if="step===0">
              <div class="grid g2">
                <div class="field"><label class="req" for="job-title">需求名称</label><input id="job-title" class="inp" v-model="f.title" placeholder="例：展厅陪衬道具 · 青铜器与宫灯"></div>
                <div class="field"><label for="job-project">所属项目</label><select id="job-project" class="inp" v-model="f.project_id"><option v-for="p in E.S.projects" :value="p.id" :key="p.id">{{ p.name }}</option></select></div>
                <div class="field"><label for="job-qty">数量（件）</label><input id="job-qty" class="inp" type="number" min="1" max="500" v-model.number="f.quantity"></div>
                <div class="field"><label for="job-ref">参考图上传</label><input id="job-ref" class="inp" type="file" multiple accept="image/*" @change="onRef"><span class="faint small" v-if="f.ref_images.length">{{ f.ref_images.map(x=>x.name||x).join('、') }}</span></div>
              </div>
              <div class="field"><label for="job-desc">需求描述（将预填为概念图提示词）</label><textarea id="job-desc" class="inp" rows="4" v-model="f.description" placeholder="例：商周风格青铜鼎与明清宫灯，陪衬展柜两侧，写实 PBR 材质"></textarea></div>
            </template>
            <template v-if="step===1">
              <div class="field"><label class="req">是否文物本体</label><div class="row"><label class="check"><input type="radio" name="her" :value="false" v-model="f.is_heritage" id="her-no">否</label><label class="check"><input type="radio" name="her" :value="true" v-model="f.is_heritage" id="her-yes">是（仅允许实景重建）</label></div></div>
              <div class="note warn" v-if="f.is_heritage">文物本体只能使用实景重建模板，生成类节点不可用。内容类型已锁定为“实景重建”。</div>
              <div class="field"><label>内容类型</label><div class="grid g3">
                <label v-for="(n,k) in D.CONTENT_TYPES" :key="k" class="check panel" :class="{disabled: f.is_heritage && k!=='recon'}" style="padding:10px 12px"><input type="radio" name="ct" :value="k" v-model="f.content_type" :disabled="f.is_heritage && k!=='recon'" :id="'ct-'+k">{{ n }}</label>
              </div></div>
              <div class="grid g2">
                <div class="field"><label for="job-scope">使用范围</label><select id="job-scope" class="inp" v-model="f.usage_scope"><option v-for="(n,k) in D.SCOPES" :value="k" :key="k">{{ n }}</option></select><span class="faint small">默认取项目使用范围，决定许可证规则</span></div>
                <div class="field"><label for="job-lora">风格 LoRA</label><select id="job-lora" class="inp" v-model="f.style_lora" :disabled="f.is_heritage"><option value="">不使用</option><option v-for="m in loras" :value="m.id" :key="m.id">{{ m.name }}（{{ m.license_type }}）</option></select></div>
              </div>
            </template>
            <template v-if="step===2">
              <div class="field"><label>目标平台（多选，决定性能预算和导出格式；多个平台时单件预算取最严格的一个）</label>
                <div class="row"><label v-for="(n,k) in D.PLATFORMS" :key="k" class="check panel" style="padding:8px 12px"><input type="checkbox" :checked="f.platforms.includes(k)" @change="togglePlat(k)" :id="'plat-'+k">{{ n }}</label></div></div>
              <div class="tbl-wrap"><table class="tbl"><thead><tr><th>平台</th><th>预设</th><th class="r">单件三角形</th><th class="r">贴图</th><th class="r">材质</th><th class="r">场景三角形</th><th class="r">Draw call</th><th>来源</th></tr></thead>
                <tbody><tr v-for="p in f.platforms" :key="p" :class="{sel: pre && pre.preset===({quest3:'quest3',pico4:'pico4',webxr:'webxr',xr_space:'xr_space',dome:'dome'})[p]}"><td>{{ D.PLATFORMS[p] }}</td><td>{{ E.S.settings.presets[p].name }}</td><td class="r">≤ {{ U.n(E.S.settings.presets[p].tris) }}</td><td class="r">≤ {{ E.S.settings.presets[p].tex }}</td><td class="r">{{ E.S.settings.presets[p].materials }}</td><td class="r">{{ U.n(E.S.settings.presets[p].scene_tris) }}</td><td class="r">{{ E.S.settings.presets[p].drawcalls }}</td><td class="small muted">{{ E.S.settings.presets[p].src }}</td></tr></tbody></table></div>
            </template>
            <template v-if="step===3 && pre">
              <div class="row"><b>{{ pre.template_name }}</b><span class="tag mono">{{ pre.template }}</span><span class="faint small">按内容类型与目标平台自动匹配</span></div>
              <div class="tbl-wrap"><table class="tbl"><thead><tr><th>节点</th><th>模型 / 工具</th><th>队列</th><th class="r">显存</th><th class="r">单件耗时</th></tr></thead><tbody>
                <tr v-for="n in pre.nodes" :key="n.id"><td>{{ n.name }}<span v-if="n.human" class="tag" style="margin-left:6px">人工节点</span></td>
                  <td><template v-if="!n.human && n.model && nodeOptions(n.type).length>1"><select class="inp" style="max-width:280px" :value="n.model" @change="f.models[n.type]=$event.target.value"><option v-for="o in nodeOptions(n.type)" :key="o.m.id" :value="o.m.id" :disabled="!o.ok">{{ o.m.name }}{{ o.ok ? '' : '（不可用：'+o.reason+'）' }}</option></select></template><template v-else>{{ n.model_name || (n.human ? '—' : '无可用模型') }}</template></td>
                  <td>{{ n.queue || '—' }}</td><td class="r">{{ n.vram ? n.vram+' GB' : '—' }}</td><td class="r">{{ n.unit_s ? U.dur(n.unit_s) : '—' }}</td></tr></tbody></table></div>
            </template>
            <template v-if="step===4 && pre">
              <div class="kv"><div>需求名称</div><div>{{ f.title }}</div><div>项目</div><div>{{ E.project(f.project_id).name }}</div><div>使用范围</div><div>{{ D.SCOPES[f.usage_scope] }}</div><div>内容类型</div><div>{{ D.CONTENT_TYPES[pre.content_type] }}</div><div>文物本体</div><div>{{ f.is_heritage ? '是' : '否' }}</div><div>目标平台</div><div>{{ f.platforms.map(p=>D.PLATFORMS[p]).join('、') }}</div><div>数量</div><div>{{ f.quantity }} 件</div><div>单件预算</div><div>{{ pre.preset_name }}（≤ {{ U.n(pre.budget.tris) }} 三角形）</div></div>
              <div v-if="!pre.ok" class="note err">不能提交：{{ pre.blocked.join('；') }}</div>
              <div class="row"><button class="btn" @click="save(false)" id="btn-save-draft">存为草稿</button><button class="btn primary" @click="save(true)" :disabled="!pre.ok && E.S.settings.rules.submitCheck" id="btn-submit-job">确认提交</button></div>
            </template>
            <div class="row" v-if="step<4"><span class="spacer"></span><button class="btn" v-if="step>0" @click="step--">上一步</button><button class="btn primary" @click="next" id="btn-next">下一步</button></div>
          </div></div>
          <div class="stack" v-if="pre">
            <div class="panel"><header><h3>管线预览</h3><span class="sub">即时重算</span></header>
              <div class="body stack">
                <div v-for="n in pre.nodes" :key="n.id" class="row nowrap" style="justify-content:space-between"><span><span class="tag" v-if="n.human">人工</span> {{ n.name }}</span><span class="small muted" style="text-align:right">{{ n.model_name || (n.human?'':'—') }}<template v-if="n.vram"> · {{ n.vram }}GB</template><template v-if="n.unit_s"> · {{ U.dur(n.unit_s) }}</template></span></div>
                <div class="divider"></div>
                <div class="kv"><div>预估 GPU 耗时</div><div class="num"><b>{{ U.dur(pre.est_gpu_s) }}</b><span class="faint small">（{{ f.quantity }} × 各 GPU 节点单件耗时之和）</span></div><div>预估总耗时</div><div class="num">{{ U.dur(pre.est_total_s) }}</div><div>人工节点</div><div>{{ pre.humanGates }} 个</div><div>显存峰值</div><div>{{ pre.peak_vram }} GB</div><div>单件预算</div><div>{{ pre.preset_name }} · ≤ {{ U.n(pre.budget.tris) }} 三角形 · {{ pre.budget.tex }} 贴图</div></div>
              </div></div>
            <div class="panel"><header><h3>许可证检查</h3><c-pill :kind="pre.ok ? 'ok' : 'err'" :text="pre.ok ? '通过' : '不通过'"></c-pill></header>
              <div class="body stack">
                <div class="small muted">使用范围：{{ D.SCOPES[f.usage_scope] }}</div>
                <div v-for="b in pre.blocked" :key="b" class="note err">{{ b }}</div>
                <div v-if="pre.excluded.length"><div class="lbl" style="margin-bottom:4px">被排除的模型（不出现在管线中）</div><div v-for="x in pre.excluded" :key="x.model+x.node" class="small" style="padding:3px 0;border-bottom:1px dashed var(--line)"><b>{{ x.model }}</b> <span class="faint">{{ x.node }}</span><br><span class="muted">{{ x.reason }}</span></div></div>
                <div v-else class="small muted">没有被排除的模型</div>
              </div></div>
          </div>
        </div>
      </template>
      <template v-else>
        <div class="split">
          <div class="panel"><header><h3>需求单列表</h3><span class="sub">{{ E.project().name }}</span><span class="right" v-if="st.params.filter"><button class="btn sm ghost" @click="st.params={}">清除筛选</button></span></header>
            <div class="tbl-wrap"><table class="tbl"><thead><tr><th>编号</th><th>名称</th><th>内容类型</th><th>平台</th><th class="r">数量</th><th>状态</th><th>创建人</th><th>时间</th></tr></thead>
              <tbody><tr v-for="j in jobs" :key="j.id" class="click" :class="{sel: sel===j.id}" @click="sel=j.id"><td class="mono">{{ j.code }}</td><td>{{ j.title }}<span v-if="j.is_heritage" class="tag" style="margin-left:6px">文物本体</span></td><td>{{ D.CONTENT_TYPES[j.content_type] }}</td><td class="small">{{ j.platforms.map(p=>D.PLATFORMS[p]).join('、') }}</td><td class="r">{{ j.quantity }}</td><td><c-pill :kind="U.jobPill(j.status)" :text="D.JOB_STATUS[j.status]"></c-pill></td><td>{{ j.created_by }}</td><td class="small">{{ U.dt(j.created_at) }}</td></tr>
              <tr v-if="!jobs.length"><td colspan="8" class="muted" style="text-align:center;padding:20px">当前项目还没有需求单</td></tr></tbody></table></div>
          </div>
          <div class="panel" v-if="cur"><header><h3>{{ cur.code }}</h3><c-pill :kind="U.jobPill(cur.status)" :text="D.JOB_STATUS[cur.status]"></c-pill></header>
            <div class="body stack">
              <b>{{ cur.title }}</b><div class="muted small">{{ cur.description }}</div>
              <div class="kv"><div>使用范围</div><div>{{ D.SCOPES[cur.usage_scope || E.project(cur.project_id).usage_scope] }}</div><div>管线模板</div><div>{{ cur.precheck ? cur.precheck.template_name : '—' }}</div><div>单件预算</div><div>{{ cur.precheck ? cur.precheck.preset_name : '—' }}</div><div>进度</div><div>{{ curAssets.filter(a=>['library','exported'].includes(a.status)).length }} / {{ cur.quantity }} 件入库</div><div>任务</div><div>{{ curTasks.length }} 个（运行 {{ curTasks.filter(t=>t.status==='running').length }}）</div></div>
              <c-progress :v="curAssets.filter(a=>['library','exported'].includes(a.status)).length / cur.quantity"></c-progress>
              <div class="row">
                <template v-if="cur.status==='draft'"><button class="btn" @click="editDraft(cur)">编辑</button><button class="btn primary" @click="submitDraft(cur)">提交</button><button class="btn danger" @click="act(()=>E.deleteJob(cur.id),'草稿已删除'); sel=null">删除</button></template>
                <template v-else-if="cur.status==='submitted' || cur.status==='producing'"><button class="btn primary" v-if="cur.content_type==='prop'" @click="go('concepts',{job:cur.id})">去选概念图</button><button class="btn" v-if="cur.content_type==='recon'" @click="go('recon',{job:cur.id})">去实景重建</button><button class="btn danger" @click="act(()=>E.cancelJob(cur.id),'需求单已取消')">取消</button></template>
              </div>
            </div></div>
          <div class="panel" v-else><div class="body muted">选择一个需求单查看详情。</div></div>
        </div>
      </template>
    </div>`,
  };

  // ====================== P03 概念图 ======================
  P.concepts = {
    setup() {
      const jobList = computed(() => { st.rev; return E.S.jobs.filter(j => j.project_id === E.S.currentProjectId && j.content_type === 'prop' && j.status !== 'draft'); });
      const jobId = ref(st.params.job || (jobList.value[0] && jobList.value[0].id) || '');
      const job = computed(() => jobId.value && E.S.jobs.find(j => j.id === jobId.value));
      const f = reactive({ prompt: '', negative: '模糊，低清，多余物体，文字水印', model_id: 'qwen-image-fp8', lora: '', lora_weight: 0.8, size: 1024, batch: 8, remove_bg: true, three_view: false, seed: '' });
      watch(job, (j) => { if (j) { f.prompt = j.description || j.title; f.lora = j.style_lora || ''; if (j.nodeModels && j.nodeModels.concept_image) f.model_id = j.nodeModels.concept_image; } }, { immediate: true });
      const scope = computed(() => job.value ? E.scopeOf(job.value.project_id, job.value.id) : E.project());
      const models = computed(() => { st.rev; return E.modelsFor('concept_image', scope.value); });
      const loras = computed(() => E.S.models.filter(m => m.node === 'lora'));
      const batches = computed(() => { st.rev; const ids = [...new Set(E.S.concepts.filter(c => c.job_id === jobId.value).map(c => c.batch_task))]; return ids.map(tid => ({ tid, task: E.S.tasks.find(t => t.id === tid), items: E.S.concepts.filter(c => c.batch_task === tid) })); });
      const curBatch = ref(null);
      const shown = computed(() => { const b = batches.value.find(x => x.tid === curBatch.value) || batches.value[0]; return b ? b.items : []; });
      const pendingTasks = computed(() => { st.rev; return E.S.tasks.filter(t => t.node === 'concept_image' && t.job_id === jobId.value && ['queued', 'running'].includes(t.status)); });
      const selected = reactive(new Set());
      const detail = ref(null);
      const busy = computed(() => { st.rev; return E.gpuBusyWith(f.model_id); });
      const eta = computed(() => { st.rev; return E.etaFor('gpu'); });
      const m = computed(() => E.model(f.model_id));
      const est = computed(() => m.value ? m.value.unit_s * f.batch * (f.three_view ? 1.6 : 1) : 0);
      const toggle = (c) => { if (c.status !== 'candidate') { detail.value = c; return; } selected.has(c.id) ? selected.delete(c.id) : selected.add(c.id); detail.value = c; };
      const gen = () => act(() => E.generateConcepts(Object.assign({}, f, { job_id: jobId.value || null })), busy.value ? `已加入队列，预计 ${U.dur(eta.value)} 后开始` : '已提交生成');
      const selectAll = () => shown.value.filter(c => c.status === 'candidate').forEach(c => selected.add(c.id));
      const send = () => { const ids = [...selected]; const r = act(() => E.selectConcepts(ids, {}), (t) => `已送入 3D 生成：${t.length} 件`); if (r) { selected.clear(); } };
      const regenUnselected = () => { const un = shown.value.filter(c => c.status === 'candidate' && !selected.has(c.id)); act(() => { E.discardConcepts(un.map(c => c.id)); return E.generateConcepts(Object.assign({}, f, { job_id: jobId.value || null, batch: Math.max(1, un.length), seed: '' })); }, `已重新生成 ${un.length} 张未选图`); };
      const discardUnselected = () => { const un = shown.value.filter(c => c.status === 'candidate' && !selected.has(c.id)); act(() => E.discardConcepts(un.map(c => c.id)), `已丢弃 ${un.length} 张未选图（7 天后清理）`); };
      const inpaint = () => { if (!detail.value) return; const c = detail.value; act(() => E.generateConcepts(Object.assign({}, f, { job_id: jobId.value || null, batch: 1, seed: (c.seed + 3) % 99999, prompt: c.prompt + '（局部重绘）' })), '已提交局部重绘'); };
      return { jobList, jobId, job, f, models, loras, batches, curBatch, shown, pendingTasks, selected, detail, busy, eta, m, est, toggle, gen, selectAll, send, regenUnselected, discardUnselected, inpaint, V, E, D, U, st };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P03" ver="V1.0" title="概念图" goal="批量生成候选概念图并选出送入 3D 生成的图片。">
        <select class="inp" style="width:auto" v-model="jobId" id="concept-job"><option value="">（不关联需求单）</option><option v-for="j in jobList" :key="j.id" :value="j.id">{{ j.code }} · {{ j.title }}</option></select>
      </c-head>
      <div class="note err" v-if="job && job.is_heritage" style="margin-bottom:12px">该需求单为文物本体，概念图生成不可用。</div>
      <div class="split3">
        <div class="panel"><header><h3>参数</h3></header><div class="body stack">
          <div class="field"><label for="c-prompt">提示词</label><textarea id="c-prompt" class="inp" rows="4" v-model="f.prompt"></textarea></div>
          <div class="field"><label for="c-neg">反向提示词</label><input id="c-neg" class="inp" v-model="f.negative"></div>
          <div class="field"><label>模型</label>
            <label v-for="o in models" :key="o.m.id" class="check" :class="{disabled:!o.ok}" :title="o.reason"><input type="radio" :value="o.m.id" v-model="f.model_id" :disabled="!o.ok">{{ o.m.name }} <span class="tag" :class="o.ok?'lic-ok':'lic-warn'">{{ o.m.license_type }}</span></label>
            <span v-for="o in models.filter(x=>!x.ok)" :key="'r'+o.m.id" class="faint small">{{ o.m.name }}：{{ o.reason }}</span>
          </div>
          <div class="grid g2"><div class="field"><label for="c-lora">风格 LoRA</label><select id="c-lora" class="inp" v-model="f.lora"><option value="">无</option><option v-for="l in loras" :value="l.id" :key="l.id">{{ l.name.replace('风格 LoRA · ','') }}</option></select></div>
            <div class="field"><label>强度 {{ f.lora_weight }}</label><input type="range" class="range" min="0" max="1.2" step="0.05" v-model.number="f.lora_weight" :disabled="!f.lora"></div></div>
          <div class="grid g2"><div class="field"><label for="c-size">尺寸</label><select id="c-size" class="inp" v-model.number="f.size"><option :value="1024">1024 × 1024</option><option :value="1328">1328 × 1328</option><option :value="768">768 × 768</option></select></div>
            <div class="field"><label for="c-batch">批量数</label><select id="c-batch" class="inp" v-model.number="f.batch"><option v-for="n in [1,2,4,8,12,16]" :key="n" :value="n">{{ n }}</option></select></div></div>
          <div class="field"><label for="c-seed">seed（留空随机）</label><input id="c-seed" class="inp mono" v-model="f.seed" placeholder="随机"></div>
          <label class="check"><c-switch v-model="f.remove_bg"></c-switch>自动去背景（透明 PNG，供 3D 生成）</label>
          <label class="check"><c-switch v-model="f.three_view"></c-switch>生成正 / 侧 / 背三视图</label>
          <div class="kv small"><div>预计显存</div><div>{{ m ? m.vram_gb : 0 }} GB + 去背景 2 GB</div><div>预计耗时</div><div>{{ U.dur(est) }}</div></div>
          <div v-if="busy" class="note warn">GPU 正被其他模型占用，将加入队列，预计 {{ U.dur(eta) }} 后开始。</div>
          <button class="btn primary" @click="gen" :disabled="job && job.is_heritage" id="btn-gen-concepts">{{ busy ? '加入队列' : '生成' }}</button>
          <div v-for="t in pendingTasks" :key="t.id" class="row small"><span class="mono">{{ t.code }}</span><c-pill :kind="U.taskPill(t.status)" :text="D.TASK_STATUS[t.status]"></c-pill><c-progress :v="t.progress" style="flex:1"></c-progress></div>
        </div></div>
        <div class="stack" style="min-width:0">
          <div class="panel"><header><h3>候选图</h3><span class="sub">已选 {{ selected.size }} 张</span>
            <span class="right"><button class="btn sm" @click="selectAll">全选</button><button class="btn sm" @click="regenUnselected">重新生成未选</button><button class="btn sm" @click="discardUnselected">丢弃未选</button><button class="btn sm primary" :disabled="!selected.size" @click="send" id="btn-send-3d">送入 3D 资产生成</button></span></header>
            <div class="body"><div class="thumbs" id="concept-grid">
              <button v-for="c in shown" :key="c.id" class="thumb" :class="{sel: selected.has(c.id), dim: c.status!=='candidate'}" @click="toggle(c)" :data-id="c.id"><img class="img" :class="{alpha:c.remove_bg}" :src="V.conceptURL(c,256)" alt=""><span class="tick">{{ selected.has(c.id) ? '✓' : '' }}</span><span class="badge" v-if="c.status!=='candidate'"><c-pill :kind="c.status==='sent'?'ok':'plain'" :text="c.status==='sent'?'已送 3D':'已丢弃'"></c-pill></span><div class="cap"><span class="mono">{{ c.code }}</span><span class="faint mono">#{{ c.seed }}</span></div></button>
            </div><div v-if="!shown.length" class="muted" style="padding:20px;text-align:center">还没有候选图，填写参数后点击“生成”。</div></div></div>
          <div class="panel"><header><h3>历史批次</h3><span class="sub">同一需求单下的历史结果</span></header><div class="list">
            <button class="li" v-for="b in batches" :key="b.tid" :class="{sel: (curBatch||batches[0].tid)===b.tid}" @click="curBatch=b.tid"><img :src="V.conceptURL(b.items[0],96)" alt=""><div class="grow"><div class="t1">{{ b.task ? b.task.code : '批次' }} · {{ b.items.length }} 张</div><div class="t2">{{ U.dt(b.items[0].created_at) }} · 已送 3D {{ b.items.filter(i=>i.status==='sent').length }} 张</div></div></button></div></div>
        </div>
        <div class="panel"><header><h3>详情</h3></header><div class="body stack" v-if="detail">
          <img :src="V.conceptURL(detail,320)" :class="{alpha:detail.remove_bg}" class="thumb img" style="border-radius:6px" alt="概念图">
          <div class="row" v-if="detail.three_view"><img v-for="vw in ['front','side','back']" :key="vw" :src="V.conceptURL(detail,96,vw)" style="width:31%;border-radius:4px;background:var(--viewport)" :alt="vw"></div>
          <div class="kv"><div>编号</div><div class="mono">{{ detail.code }}</div><div>seed</div><div class="mono">{{ detail.seed }}</div><div>模型</div><div>{{ E.model(detail.model_id).name }}</div><div>LoRA</div><div>{{ detail.lora ? E.model(detail.lora).name + ' × ' + detail.lora_weight : '无' }}</div><div>尺寸</div><div>{{ detail.size }} px</div><div>许可</div><div><span class="tag lic-ok">{{ E.model(detail.model_id).license_type }}</span></div><div>标签</div><div><span class="tag" v-for="t in detail.tags" :key="t">{{ t }}</span></div><div>提示词</div><div class="small">{{ detail.prompt }}</div></div>
          <div class="note small">AIGC 标识：图片元数据与资产库记录写入生成模型、时间和“AI 生成”标记。可凭 seed 与参数复现。</div>
          <div class="row"><button class="btn sm" @click="inpaint">局部重绘</button></div>
        </div><div class="body muted" v-else>点击候选图查看 seed、模型、LoRA、许可与标签。</div></div>
      </div>
    </div>`,
  };

  // ====================== P04 3D 资产生成 ======================
  P.gen3d = {
    setup() {
      const tasks = computed(() => { st.rev; return E.S.tasks.filter(t => t.node === 'image_to_3d' && (t.project_id === E.S.currentProjectId)).slice(0, 40); });
      const assets = computed(() => { st.rev; return E.S.assets.filter(a => a.project_id === E.S.currentProjectId && a.type === 'prop' && a.status !== 'discarded').slice(0, 60); });
      const selId = ref(st.params.asset || (assets.value[0] && assets.value[0].id));
      const asset = computed(() => { st.rev; return selId.value && E.S.assets.find(a => a.id === selId.value); });
      const ver = computed(() => asset.value && E.cur(asset.value));
      const mode = ref('solid');
      const info = computed(() => { const v = ver.value; if (!v || !v.raw) return null; return { file_url: v.raw_file_id ? '/api/v1/files/' + v.raw_file_id : v.file_url, category: v.category, seed: v.seed, tris: v.raw.target || v.raw.tris, texture: v.raw.texture, defects: {} }; });
      const multi = reactive(new Set());
      const scope = computed(() => asset.value ? E.scopeOf(asset.value.project_id, asset.value.job_id) : E.project());
      const models = computed(() => { st.rev; return E.modelsFor('image_to_3d', scope.value); });
      const f = reactive({ model_id: 'trellis2-4b', resolution: 1024, texture: 2048, steps: 25, seed: '', preview_off: true, oom_demo: false });
      watch(ver, (v) => { if (v && v.params) { f.resolution = v.params.resolution || 1024; f.texture = v.params.texture || 2048; f.seed = v.seed; f.model_id = v.model_id; } }, { immediate: true });
      const m = computed(() => E.model(f.model_id));
      const role = computed(() => { st.rev; return E.user().role; });
      const canEdit = computed(() => E.can('gen3d', role.value));
      const regen = () => act(() => E.regenerate3d(asset.value.id, { model_id: f.model_id, params: { resolution: f.resolution, texture: f.texture, steps: f.steps, seed: f.seed ? +f.seed : undefined, preview_render: !f.preview_off, force_oom: f.oom_demo } }), '已提交重新生成');
      const toOpt = () => { const ids = multi.size ? [...multi] : [asset.value.id]; go('optimize', { asset: ids[0], batch: ids }); };
      const discard = () => act(() => E.discardAsset(asset.value.id), '已丢弃');
      const cloudHint = computed(() => { const mm = m.value; if (!mm || (mm.location !== 'cloud' && mm.location !== 'api')) return null; return mm.location === 'api' ? `商业 API，约 ¥${mm.cost}/次，预计排队 ${U.dur(E.etaFor('cloud') / 3)}` : `云 GPU ${mm.engine}，¥${mm.cost_per_hour}/小时，单件约 ¥${(mm.cost_per_hour * mm.unit_s / 3600).toFixed(2)}，开机约 1 分钟`; });
      const route = (mm) => E.routeQueue('image_to_3d', mm);
      const modes = [['solid', '实体'], ['wire', '线框'], ['normal', '法线'], ['basecolor', 'Base Color'], ['metal', 'Metallic'], ['rough', 'Roughness']];
      const vref = shallowRef(null);
      return { tasks, assets, selId, asset, ver, mode, info, multi, models, f, m, canEdit, regen, toOpt, discard, cloudHint, route, modes, vref, E, D, U, st, V };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P04" ver="V1.0" title="3D 资产生成" goal="把选中的概念图批量转为带 PBR 贴图的 3D 模型，并初步筛选。"></c-head>
      <div class="note" v-if="!canEdit" style="margin-bottom:12px">当前角色对 3D 生成为“查看”权限。</div>
      <div class="split3">
        <div class="panel"><header><h3>输入队列</h3><span class="sub">{{ tasks.length }} 件</span></header><div class="list" style="max-height:640px;overflow-y:auto">
          <button class="li" v-for="t in tasks" :key="t.id" :class="{sel: t.asset_id && t.asset_id===selId}" @click="t.asset_id && (selId=t.asset_id)">
            <img :src="t.concept_id && E.S.concepts.find(c=>c.id===t.concept_id) ? V.conceptURL(E.S.concepts.find(c=>c.id===t.concept_id),96) : ''" alt="">
            <div class="grow"><div class="t1 mono">{{ t.code }}<span v-if="t.rework" class="tag" style="margin-left:4px">返工</span></div><div class="t2">{{ (E.model(t.model_id)||{}).name }}<template v-if="t.status==='running'"> · {{ Math.round(t.progress*100) }}%</template><template v-if="t.error"> · {{ t.error }}</template><template v-if="t.oom_retry"> · OOM 降级重试</template></div><c-progress v-if="t.status==='running'" :v="t.progress" style="margin-top:3px"></c-progress></div>
            <c-pill :kind="U.taskPill(t.status)" :text="D.TASK_STATUS[t.status]"></c-pill></button>
          <div v-if="!tasks.length" class="muted small" style="padding:14px">在「概念图」页选图并送入 3D 生成后，任务会出现在这里。</div>
        </div></div>
        <div class="stack" style="min-width:0">
          <c-asset-view :info="info" :mode="mode" :height="420" @ready="v=>vref=v">
            <template #default="{meta}">
              <div class="vp-tools"><div class="seg"><button v-for="md in modes" :key="md[0]" :class="{on: mode===md[0]}" @click="mode=md[0]">{{ md[1] }}</button></div><span class="spacer"></span><button class="btn sm" @click="vref && vref.reset()">重置视角</button></div>
              <div class="vp-overlay" v-if="ver && ver.raw"><span>面数 {{ U.n(meta ? meta.tris : ver.raw.tris) }}</span><span>顶点 {{ U.n(meta ? meta.verts : ver.raw.verts) }}</span><span>贴图 {{ ver.raw.texture ? ver.raw.texture + '²' : '无（仅几何）' }}</span><span>文件 {{ ver.raw.file_mb }} MB</span><span>{{ E.model(ver.model_id).name }}</span></div>
            </template>
          </c-asset-view>
          <div class="panel"><header><h3>同批结果</h3><span class="sub">可多选后批量送入优化</span><span class="right"><button class="btn sm primary" :disabled="!asset || !ver || !ver.raw" @click="toOpt" id="btn-to-opt">送入资产优化{{ multi.size ? '（'+multi.size+'）' : '' }}</button></span></header>
            <div class="body"><div class="thumbs" style="grid-template-columns:repeat(auto-fill,minmax(112px,1fr))">
              <button class="thumb" v-for="a in assets" :key="a.id" :class="{sel: a.id===selId}" @click="selId=a.id" :data-id="a.id"><img class="img" :src="U.thumbOf(a)" alt=""><span class="tick" @click.stop="multi.has(a.id)?multi.delete(a.id):multi.add(a.id)">{{ multi.has(a.id) ? '✓' : '' }}</span><div class="cap"><span class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ a.name }}</span><span class="faint small">{{ E.cur(a).raw ? E.cur(a).raw.gen_s+'s' : '' }}</span></div></button>
            </div></div></div>
        </div>
        <div class="stack">
          <div class="panel"><header><h3>生成模型</h3></header><div class="list">
            <label v-for="o in models" :key="o.m.id" class="li" :style="{opacity: o.ok ? 1 : .5, cursor: o.ok ? 'pointer' : 'not-allowed'}"><input type="radio" :value="o.m.id" v-model="f.model_id" :disabled="!o.ok || !canEdit" style="accent-color:var(--accent)">
              <div class="grow"><div class="t1">{{ o.m.name }}</div><div class="t2">{{ U.loc(o.m) }}{{ route(o.m)==='cloud' && o.m.location==='local' ? '（显存超限，路由到云端）' : '' }} · {{ o.m.vram_gb ? o.m.vram_gb+'GB' : '—' }} · {{ U.dur(o.m.unit_s) }} · {{ o.m.pbr ? '带 PBR' : '仅几何' }}</div><div class="t2" v-if="!o.ok" style="color:var(--warn)">{{ o.reason }}</div></div>
              <span class="tag" :class="o.ok?'lic-ok':'lic-warn'">{{ o.m.license_type }}</span></label></div></div>
          <div class="panel"><header><h3>参数</h3></header><div class="body stack">
            <div class="note small" v-if="cloudHint">{{ cloudHint }}</div>
            <div class="grid g2"><div class="field"><label for="g-res">体素分辨率</label><select id="g-res" class="inp" v-model.number="f.resolution"><option :value="1024">1024³</option><option :value="512">512³</option></select></div>
              <div class="field"><label for="g-tex">贴图尺寸</label><select id="g-tex" class="inp" v-model.number="f.texture"><option :value="2048">2048</option><option :value="1024">1024</option></select></div>
              <div class="field"><label for="g-steps">采样步数</label><input id="g-steps" class="inp" type="number" v-model.number="f.steps" min="8" max="50"></div>
              <div class="field"><label for="g-seed">seed</label><input id="g-seed" class="inp mono" v-model="f.seed"></div></div>
            <label class="check"><c-switch v-model="f.preview_off"></c-switch>关闭预览渲染（默认开启，避免显存峰值近 30GB 溢出）</label>
            <label class="check"><c-switch v-model="f.oom_demo"></c-switch><span>演示：模拟显存溢出（验证自动降一档重试 1 次）</span></label>
            <div class="kv small" v-if="ver && ver.raw"><div>本件显存峰值</div><div>{{ ver.raw.vram_peak || '—' }} GB</div><div>本件耗时</div><div>{{ ver.raw.gen_s }} 秒（模拟）</div><div>实际模型</div><div>{{ E.model(ver.model_id).name }}</div><div>实际参数</div><div class="mono">{{ ver.params ? (ver.params.resolution+'³ / '+ver.params.texture+' / seed '+ver.seed) : '' }}</div></div>
            <div class="row"><button class="btn" :disabled="!asset || !canEdit" @click="regen">重新生成当前件</button><button class="btn danger" :disabled="!asset || !canEdit" @click="discard">丢弃</button></div>
          </div></div>
        </div>
      </div>
    </div>`,
  };

  // ====================== P05 资产优化 ======================
  P.optimize = {
    setup() {
      const list = computed(() => { st.rev; return E.S.assets.filter(a => a.project_id === E.S.currentProjectId && a.type === 'prop' && E.cur(a) && E.cur(a).raw && !['discarded'].includes(a.status)); });
      const selId = ref(st.params.asset || (list.value[0] && list.value[0].id));
      const batch = ref(st.params.batch || null);
      const asset = computed(() => { st.rev; return selId.value && E.S.assets.find(a => a.id === selId.value); });
      const ver = computed(() => asset.value && E.cur(asset.value));
      const preset = ref('quest3'); const manual = ref(false); const wire = ref(false);
      const custom = reactive(Object.assign({}, E.S.settings.presets.custom));
      watch(ver, (v) => { if (v) preset.value = v.preset || (asset.value && asset.value.preset) || 'quest3'; }, { immediate: true });
      const P_ = computed(() => preset.value === 'custom' ? custom : E.S.settings.presets[preset.value]);
      const rawInfo = computed(() => ver.value && ver.value.raw ? { file_url: ver.value.raw_file_id ? '/api/v1/files/' + ver.value.raw_file_id : ver.value.file_url, category: ver.value.category, seed: ver.value.seed, tris: ver.value.raw.target || ver.value.raw.tris, texture: ver.value.raw.texture } : null);
      const optInfo = computed(() => ver.value && ver.value.opt ? { file_url: ver.value.file_url, category: ver.value.category, seed: ver.value.seed, tris: ver.value.opt.target || ver.value.opt.tris, texture: ver.value.opt.texture } : null);
      const task = computed(() => { st.rev; return asset.value && E.S.tasks.find(t => t.node === 'mesh_optimize' && t.asset_id === asset.value.id && ['queued', 'running'].includes(t.status)); });
      const steps = ['减面', '重拓扑', 'UV 展开', '贴图烘焙', st.production?'保存 GLB / .blend':'压缩导出'];
      const stepState = (i) => { const t = task.value; if (t) { if (t.status === 'queued') return 'queued'; const s = Math.floor(t.progress * 5); return i < s ? 'done' : i === s ? 'run' : 'wait'; } return ver.value && ver.value.opt ? 'done' : 'wait'; };
      const rows = computed(() => { const v = ver.value; if (!v) return []; const r = v.raw, o = v.opt, p = P_.value; return [
        ['三角形', U.n(r.tris), o ? U.n(o.tris) : '—', '≤ ' + U.n(p.tris), o ? o.tris <= p.tris : null],
        ['顶点', U.n(r.verts), o ? U.n(o.verts) : '—', '—', null],
        ['材质数', r.materials, o ? o.materials : '—', '≤ ' + p.materials, o ? o.materials <= p.materials : null],
        ['贴图', r.texture ? r.texture + '²' : '—', o ? o.texture + '²' : '—', '≤ ' + p.tex, o ? o.texture <= p.tex : null],
        ['文件大小', r.file_mb + ' MB', o ? o.file_mb + ' MB' : '—', '≤ ' + p.size_mb + ' MB', o ? o.file_mb <= p.size_mb : null],
        ['法线细节保留', '—', o ? '需目检' : '—', '不参与自动判定', 'eye']]; });
      const canEdit = computed(() => { st.rev; return E.can('optimize'); });
      const run = (ids) => { act(() => E.optimize(ids, { preset: preset.value, manual: manual.value, custom: preset.value === 'custom' ? { tris: custom.tris, tex: custom.tex } : null }), (t) => `已提交优化 ${t.length} 件（Blender 无头，CPU 并发 3）`); };
      const sameBatch = computed(() => { const a = asset.value; if (!a) return []; return list.value.filter(x => x.job_id === a.job_id && x.id !== a.id); });
      const toQA = () => act(() => E.sendToQA(asset.value.id), '已送入质检');
      // 同步旋转
      let L = null, R = null; const onL = (v) => { L = v; link(); }, onR = (v) => { R = v; link(); };
      function link() { if (!L || !R) return; let lock = false; const cp = (a, b) => { if (lock) return; lock = true; b.camera.position.copy(a.camera.position); b.controls.target.copy(a.controls.target); b.camera.updateMatrixWorld(); lock = false; }; L.controls.addEventListener('change', () => cp(L, R)); R.controls.addEventListener('change', () => cp(R, L)); }
      return { list, selId, batch, asset, ver, preset, manual, wire, custom, P_, rawInfo, optInfo, task, steps, stepState, rows, canEdit, run, sameBatch, toQA, onL, onR, E, D, U, st };
    },
    template: `<div class="page" :data-r="st.rev">
      <c-head code="P05" ver="V1.0" title="资产优化" goal="把高面数生成结果处理成符合目标平台预算的可用资产。五个步骤在 Blender 无头进程中顺序执行，不占用 GPU。">
        <select class="inp" style="width:auto;max-width:300px" v-model="selId" id="opt-asset"><option v-for="a in list" :key="a.id" :value="a.id">{{ a.code }} · {{ a.name }} · {{ D.ASSET_STATUS[a.status] }}</option></select>
      </c-head>
      <div v-if="!asset" class="panel"><div class="body muted">还没有可优化的生成结果。</div></div>
      <div v-else class="split">
        <div class="stack" style="min-width:0">
          <div class="panel"><header><h3>对比视口</h3><span class="sub">左：优化前　右：优化后　同步旋转</span><span class="right"><label class="check small"><c-switch v-model="wire"></c-switch>线框</label></span></header>
            <div class="body grid g2">
              <c-asset-view :info="rawInfo" :mode="wire?'wire':'solid'" :height="340" @ready="onL"><template #default><div class="vp-overlay" v-if="ver.raw"><span>优化前 {{ U.n(ver.raw.tris) }} 三角形</span></div></template></c-asset-view>
              <c-asset-view :info="optInfo" :mode="wire?'wire':'solid'" :height="340" @ready="onR"><template #default><div class="vp-empty" v-if="!optInfo">尚未优化</div><div class="vp-overlay" v-if="ver.opt"><span>优化后 {{ U.n(ver.opt.tris) }} 三角形</span><span>{{ E.S.settings.presets[ver.opt.preset].name }}</span></div></template></c-asset-view>
            </div></div>
          <div class="panel"><header><h3>前后对比</h3><span class="sub">逐项对照预算</span></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>指标</th><th class="r">优化前</th><th class="r">优化后</th><th class="r">预算（{{ P_.name }}）</th><th>结果</th></tr></thead><tbody>
            <tr v-for="r in rows" :key="r[0]"><td>{{ r[0] }}</td><td class="r">{{ r[1] }}</td><td class="r">{{ r[2] }}</td><td class="r">{{ r[3] }}</td><td><span v-if="r[4]===true" class="res-pass">通过</span><span v-else-if="r[4]===false" class="res-fail">超出</span><span v-else-if="r[4]==='eye'" class="res-warn">需目检</span><span v-else class="faint">—</span></td></tr></tbody></table></div></div>
        </div>
        <div class="stack">
          <div class="panel"><header><h3>目标预设</h3><span class="sub">默认来自需求单目标平台</span></header><div class="body stack">
            <div class="seg"><button v-for="k in ['quest3','webxr','xr_space','custom']" :key="k" :class="{on: preset===k}" @click="preset=k">{{ E.S.settings.presets[k].name }}</button></div>
            <div v-if="preset==='custom'" class="grid g2"><div class="field"><label>三角形上限</label><input class="inp" type="number" v-model.number="custom.tris"></div><div class="field"><label>贴图上限</label><select class="inp" v-model.number="custom.tex"><option :value="512">512</option><option :value="1024">1024</option><option :value="2048">2048</option></select></div></div>
            <div class="kv small"><div>三角形</div><div>≤ {{ U.n(P_.tris) }}</div><div>贴图</div><div>≤ {{ P_.tex }} px</div><div>材质</div><div>{{ P_.materials }} 个</div><div>文件</div><div>≤ {{ P_.size_mb }} MB</div></div>
          </div></div>
          <div class="panel"><header><h3>处理步骤</h3><span class="sub" v-if="task">{{ task.code }} · {{ D.TASK_STATUS[task.status] }}</span></header><div class="body stack">
            <div v-for="(s,i) in steps" :key="s" class="row nowrap"><span class="mono faint">{{ i+1 }}</span><span style="flex:1">{{ s }}</span><c-pill :kind="{done:'ok',run:'run',queued:'info',wait:'plain'}[stepState(i)]" :text="{done:'完成',run:'执行中',queued:'排队',wait:'待执行'}[stepState(i)]"></c-pill></div>
            <div class="faint small">{{st.production?'Blender CPU 加工；Draco/KTX2 压缩在导出发布中执行。':'工具：Blender 4.2 无头 · Instant Meshes · xatlas · gltf-transform'}}</div>
          </div></div>
          <div class="panel"><header><h3>操作</h3></header><div class="body stack">
            <label class="check"><c-switch v-model="manual"></c-switch>主视觉资产：转人工重拓扑（输出高模、自动低模和 .blend）</label>
            <div class="note warn small" v-if="asset.status==='manual'">{{ asset.manual_note }}</div>
            <button class="btn primary" :disabled="!canEdit || !!task" @click="run([asset.id])" id="btn-run-opt">按预设优化当前件</button>
            <button class="btn" :disabled="!canEdit || !sameBatch.length" @click="run([asset.id, ...sameBatch.map(a=>a.id)])">应用到同批（{{ sameBatch.length + 1 }} 件）</button>
            <button class="btn" :disabled="!ver.opt || !!task || ['qa','review','library','exported'].includes(asset.status)" @click="toQA">送入质检</button>
            <div class="faint small">资产状态：{{ D.ASSET_STATUS[asset.status] }}</div>
          </div></div>
        </div>
      </div>
    </div>`,
  };
})(window);
