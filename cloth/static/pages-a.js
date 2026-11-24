/* P01 项目列表 · P02 史料汇集 · P03 形制规格书 · P04 AI 生成 · 左侧依据栏 */

const RefPanel = {
  props: ["pid"],
  setup(props) {
    const srcs = ref([]), spec = ref(null);
    const load = async () => {
      srcs.value = await api("GET", `/api/projects/${props.pid}/sources`);
      const s = await api("GET", `/api/projects/${props.pid}/spec`);
      spec.value = s.versions[s.versions.length - 1];
    };
    onMounted(load);
    watch(() => G.route.tab, load);
    const primary = computed(() => srcs.value.find((s) => s.primary));
    const parts = computed(() => srcs.value.filter((s) => !s.primary && s.file_id).slice(0, 5));
    return { primary, parts, spec, img, LEVELS };
  },
  template: `<aside class="ref">
   <section class="card"><h2>复原依据 <span class="tag L2">主史料</span></h2>
    <img v-if="primary" class="portrait" :src="img(primary.file_id)" :alt="primary.title">
    <div v-else class="empty">尚未设置主史料</div>
    <p v-if="primary" class="small muted" style="margin-top:6px">{{primary.museum}} · {{primary.license}} · SHA-256 {{(primary.sha256||'').slice(0,8)}}…</p></section>
   <section class="card" v-if="parts.length"><h3>其他史料</h3><div class="crops"><img v-for="s in parts" :key="s.id" :src="img(s.file_id)" style="width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:4px" :title="s.title"></div></section>
   <section class="card" v-if="spec"><h3>规格书 V{{spec.no}} <span class="tag" :class="spec.status==='signed'?'st-ok':'st-wait'">{{spec.status==='signed'?'已签署':spec.status==='signing'?'待复核':'草稿'}}</span></h3>
    <dl class="kv"><template v-for="f in spec.fields.slice(0,9)" :key="f.id"><dt>{{f.name}}</dt><dd>{{f.na?'不适用':f.content}}</dd></template></dl></section>
  </aside>`,
};

/* ------------------------------------------------------------ P01 */
const ProjectsPage = {
  setup() {
    const list = ref([]), todos = ref([]), q = ref(""), step = ref(0), showNew = ref(false);
    const form = reactive({ name: "", category: "女子服饰 · 命妇礼服", dynasty: "明", lead_id: "", expert_ids: [], artifact: "", museum: "" });
    const load = async () => { list.value = await api("GET", "/api/projects"); todos.value = await api("GET", "/api/todos"); };
    onMounted(load);
    const timer = setInterval(load, 5000);
    onUnmounted(() => clearInterval(timer));
    const shown = computed(() => list.value.filter((p) => (!q.value || p.name.includes(q.value)) && (!step.value || p.steps.current === +step.value)));
    const leads = computed(() => G.users.filter((u) => u.role === "lead" && u.active));
    const experts = computed(() => G.users.filter((u) => ["expert", "lead"].includes(u.role) && u.active && u.id !== form.lead_id));
    const create = async () => {
      const p = await call(() => api("POST", "/api/projects", form), "项目已创建");
      showNew.value = false; go(`#/p/${p.id}/sources`);
    };
    const canCreate = computed(() => ["lead", "ops"].includes(G.me.role));
    const archive = async (p) => { await call(() => api("PATCH", `/api/projects/${p.id}`, { archived: true }), "已归档"); load(); };
    return { list, todos, q, step, shown, showNew, form, leads, experts, create, canCreate, img, STEPS, fmtTime, archive, G, go };
  },
  template: `<div class="full">
   <div class="head"><div><h2>复原项目</h2><p>我参与的 {{list.length}} 个项目，按最近更新排序。</p></div><span class="sp"></span>
    <input class="input" v-model="q" placeholder="搜索项目名称" style="width:220px">
    <select class="input" v-model="step"><option value="0">全部步骤</option><option v-for="(s,i) in STEPS" :value="i+1">{{i+1}} {{s[0]}}</option></select>
    <button class="btn pri" v-if="canCreate" @click="showNew=true">＋ 新建复原项目</button></div>
   <div style="display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px;align-items:start">
    <div class="grid3" v-if="shown.length">
     <div class="card clickable" style="padding:0;overflow:hidden" v-for="p in shown" :key="p.id" @click="go('#/p/'+p.id+'/'+STEPS[p.steps.current-1][1])">
      <div v-if="p.cover" :style="{height:'180px',background:'url('+img(p.cover)+') center 30%/cover'}"></div><div v-else class="fake-img" style="height:180px">尚无主史料</div>
      <div style="padding:14px;display:grid;gap:8px"><b style="font-size:15px">{{p.name}}</b><span class="small muted">{{p.category}} · {{p.museum||'—'}}</span>
       <div class="row"><span class="tag L2">{{p.steps.current}} {{STEPS[p.steps.current-1][0]}}</span><span class="tag st-need" v-if="p.todos.length">待我处理 {{p.todos.length}}</span><span class="tag st-wait" v-if="p.archived">已归档</span></div>
       <div class="progress"><i :style="{width:(Object.values(p.steps.done).filter(Boolean).length/7*100)+'%'}"></i></div>
       <div class="row small muted"><span>主审 {{p.lead_name}} · 专家 {{p.experts.length}} 人</span><span class="sp"></span><span>{{fmtTime(p._updated)}}</span></div>
       <button class="btn sm" v-if="p.is_lead && p.steps.done[7] && !p.archived" @click.stop="archive(p)">归档</button></div></div>
    </div><div v-else class="empty">还没有项目。{{canCreate?'点击右上角新建。':'请等待主审专家邀请。'}}</div>
    <section class="card"><h2>待我处理 <span class="tag st-need">{{todos.length}}</span></h2>
     <div v-if="!todos.length" class="muted small">暂无待办</div>
     <div v-for="(t,i) in todos" :key="i" class="clickable" style="padding:6px 0;border-top:1px solid var(--line)" @click="go('#/p/'+t.project_id+'/'+STEPS[t.step-1][1])"><b>{{t.project}}</b><div class="muted small">{{t.text}}</div></div></section>
   </div>
   <div class="modal-bg" v-if="showNew" @click.self="showNew=false"><div class="modal"><h2>新建复原项目</h2>
    <div class="grid2"><label class="f">项目名称 *<input v-model="form.name"></label>
     <label class="f">服饰类别 *<select v-model="form.category"><option>女子服饰 · 命妇礼服</option><option>男子服饰 · 赐服</option><option>通用</option></select></label>
     <label class="f">朝代<input v-model="form.dynasty"></label><label class="f">主审专家 *<select v-model="form.lead_id"><option value="">请选择</option><option v-for="u in leads" :value="u.id">{{u.name}}</option></select></label>
     <label class="f">依据文物<input v-model="form.artifact" placeholder="如《李言恭配临淮侯夫人史氏像》"></label><label class="f">馆藏单位<input v-model="form.museum"></label></div>
    <div><div class="small muted">邀请评审专家</div><div class="chk"><label v-for="u in experts"><input type="checkbox" :value="u.id" v-model="form.expert_ids">{{u.name}}</label></div></div>
    <div class="row"><span class="sp"></span><button class="btn" @click="showNew=false">取消</button><button class="btn pri" :disabled="!form.name||!form.lead_id" @click="create">创建并进入史料汇集</button></div></div></div>
  </div>`,
};

/* ------------------------------------------------------------ P02 */
const SourcesPage = {
  props: ["pid"],
  setup(props) {
    const tab = ref("upload"), srcs = ref([]), obs = ref([]), lits = ref([]), q = ref(""), results = ref([]), notes = ref([]), url = ref("");
    const busy = ref(false), over = ref(false), editing = reactive({}), newLit = reactive({ title: "", excerpt: "", edition: "", page: "", parts: "" });
    const up = reactive({ part: "全图", kind: "画像" });
    const p = computed(() => G.project);
    const load = async () => {
      srcs.value = await api("GET", `/api/projects/${props.pid}/sources`);
      obs.value = await api("GET", `/api/projects/${props.pid}/observations`);
      lits.value = await api("GET", `/api/projects/${props.pid}/literature`);
    };
    onMounted(load);
    const upload = async (files) => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      fd.append("part", up.part); fd.append("kind", up.kind);
      const r = await call(() => api("POST", `/api/projects/${props.pid}/sources/upload`, fd, true));
      r.errors.forEach((e) => toast(e, true));
      if (r.added.length) toast(`已入库 ${r.added.length} 张`);
      await load(); refreshProject();
    };
    const onDrop = (e) => { over.value = false; upload(e.dataTransfer.files); };
    const search = async () => { busy.value = true; try { const r = await call(() => api("POST", `/api/projects/${props.pid}/sources/search`, { q: q.value })); results.value = r.results; notes.value = r.notes; } finally { busy.value = false; } };
    const imp = async (x) => { await call(() => api("POST", `/api/projects/${props.pid}/sources/import`, x), "已入库"); x._in = true; load(); };
    const link = async () => { busy.value = true; try { await call(() => api("POST", `/api/projects/${props.pid}/sources/link`, { url: url.value }), "已抓取入库"); url.value = ""; load(); } finally { busy.value = false; } };
    const setPrimary = async (s) => { await call(() => api("PATCH", `/api/sources/${s.id}`, { primary: true }), "已设为主史料"); load(); refreshProject(); };
    const delSrc = async (s) => { if (confirm("删除这条史料？")) { await call(() => api("DELETE", `/api/sources/${s.id}`)); load(); } };
    const edit = (o) => { editing[o.id] = { part: o.part, seen: o.seen, question: o.question, rev: o._rev }; };
    const save = async (o) => { await call(() => api("PUT", `/api/observations/${o.id}`, editing[o.id]), "已保存"); delete editing[o.id]; load(); };
    const addObs = async () => { const part = prompt("新增部位名称"); if (part) { await call(() => api("POST", `/api/projects/${props.pid}/observations`, { part })); load(); } };
    const aiRead = async () => { busy.value = true; try { obs.value = await call(() => api("POST", `/api/projects/${props.pid}/observations/ai-read`), "AI 初读完成"); } finally { busy.value = false; } };
    const addLit = async () => { await call(() => api("POST", `/api/projects/${props.pid}/literature`, newLit), "已添加"); Object.assign(newLit, { title: "", excerpt: "", edition: "", page: "", parts: "" }); load(); };
    const confirmScope = async () => { await call(() => api("POST", `/api/projects/${props.pid}/sources/confirm`), "史料范围已确认"); refreshProject(); };
    const ro = computed(() => G.me.role === "tech" || (p.value && p.value.archived));
    return { tab, srcs, obs, lits, q, results, notes, url, busy, over, editing, newLit, up, p, upload, onDrop, search, imp, link, setPrimary, delSrc, edit, save, addObs, aiRead, addLit, confirmScope, img, fmtTime, ro, G };
  },
  template: `<main>
   <div class="head"><div><h2>① 史料汇集</h2><p>上传或检索复原依据；AI 先读图，专家逐行确认。所有史料记录来源、许可和哈希。</p></div><span class="sp"></span>
    <span class="pill expert">专家节点 · 确认史料范围</span>
    <span class="tag st-ok" v-if="p&&p.sources_confirmed">已确认 {{fmtTime(p.sources_confirmed_at)}}</span>
    <button class="btn ok" v-else-if="p&&p.is_lead" @click="confirmScope">确认史料范围</button></div>
   <section class="card" style="display:grid;gap:12px" v-if="!ro">
    <div class="seg"><button :class="{on:tab==='upload'}" @click="tab='upload'">本地上传</button><button :class="{on:tab==='search'}" @click="tab='search'">名称检索</button><button :class="{on:tab==='link'}" @click="tab='link'">粘贴链接</button></div>
    <template v-if="tab==='upload'"><div class="formrow"><label class="f">部位<select v-model="up.part"><option>全图</option><option>局部</option><option>背面</option><option>题记</option></select></label>
      <label class="f">史料类型<select v-model="up.kind"><option>画像</option><option>实物</option><option>文献插图</option></select></label></div>
     <div class="drop" :style="over?{borderColor:'var(--blue)'}:{}" @dragover.prevent="over=true" @dragleave="over=false" @drop.prevent="onDrop">
      <b>把图片拖到这里，或</b><label class="btn pri">选择图片<input type="file" multiple accept="image/jpeg,image/png,image/webp,image/tiff" hidden @change="upload($event.target.files)"></label>
      <span class="small">JPG、PNG、WebP、TIFF，单张 50 MB 以内，可多选</span></div></template>
    <template v-if="tab==='search'"><div class="formrow"><input class="input" style="flex:1" v-model="q" placeholder="文物名或服饰名，如 Ming robe、命妇像" @keyup.enter="search"><button class="btn pri" :disabled="busy||!q" @click="search">{{busy?'检索中…':'检索'}}</button></div>
     <p class="small muted" v-for="n in notes">{{n}}</p>
     <div class="grid4" v-if="results.length"><div class="shot" v-for="x in results" :key="x.url"><div class="im" style="aspect-ratio:4/3"><img :src="x.image" referrerpolicy="no-referrer"></div>
      <div class="meta"><b>{{x.title}}</b><span class="muted">{{x.dating}} · {{x.museum}}</span><div class="row"><span class="tag L3">{{x.level}}</span><span class="tag" :class="x.license.includes('开放')?'st-ok':'st-need'">{{x.license}}</span></div>
       <div class="row"><button class="btn sm pri" :disabled="x._in" @click="imp(x)">{{x._in?'已入库':'入库'}}</button><span class="sp"></span><a :href="x.url" target="_blank" rel="noopener" class="small">原页 ↗</a></div></div></div></div></template>
    <template v-if="tab==='link'"><div class="formrow"><input class="input" style="flex:1" v-model="url" placeholder="粘贴白名单博物馆的藏品页网址"><button class="btn pri" :disabled="busy||!url" @click="link">{{busy?'抓取中…':'抓取入库'}}</button></div>
     <p class="small muted">只接受系统设置中白名单内的博物馆网址；白名单外的网址请联系技术人员添加。</p></template>
   </section>
   <div class="grid2">
    <section class="card"><h2>史料库 <span class="muted small">{{srcs.length}} 条</span></h2>
     <table><thead><tr><th></th><th>史料</th><th>类型</th><th>许可</th><th>等级</th><th></th></tr></thead><tbody>
      <tr v-for="s in srcs" :key="s.id"><td style="width:56px"><img v-if="s.file_id" :src="img(s.file_id)" style="width:48px;height:60px;object-fit:cover;border-radius:4px"></td>
       <td><b>{{s.title}}</b> <span class="tag L2" v-if="s.primary">主史料</span><span class="tag st-need" v-if="s.after_confirm">确认后新增</span>
        <div class="small muted">{{s.origin}} · {{s.museum||''}} <a v-if="s.url" :href="s.url" target="_blank" rel="noopener">原页 ↗</a></div><div class="mono muted" v-if="s.sha256">{{s.sha256.slice(0,12)}}…</div></td>
       <td>{{s.part}} · {{s.kind}}</td><td><span class="tag" :class="(s.license||'').includes('开放')?'st-ok':'st-need'">{{s.license}}</span></td><td><span class="tag" :class="s.level">{{s.level}}</span></td>
       <td><button class="btn sm" v-if="!s.primary&&s.file_id&&!ro" @click="setPrimary(s)">设为主史料</button> <button class="btn sm warn" v-if="!ro" @click="delSrc(s)">删除</button></td></tr>
     </tbody></table><div class="empty" v-if="!srcs.length">还没有史料</div></section>
    <section class="card"><h2>文献</h2>
     <table><thead><tr><th>文献</th><th>原文摘录</th><th>状态</th></tr></thead><tbody>
      <tr v-for="l in lits" :key="l.id"><td><b>{{l.title}}</b><div class="small muted">{{l.edition}} {{l.page}} {{l.parts?('· 关联 '+l.parts):''}}</div></td><td class="small">{{l.excerpt||'—'}}</td><td><span class="tag" :class="l.excerpt?'st-ok':'st-wait'">{{l.status}}</span></td></tr></tbody></table>
     <div class="grid2" style="margin-top:8px" v-if="!ro"><input class="input" v-model="newLit.title" placeholder="文献名"><input class="input" v-model="newLit.parts" placeholder="关联部位"><input class="input" v-model="newLit.edition" placeholder="版本"><input class="input" v-model="newLit.page" placeholder="页码">
      <textarea class="input" style="grid-column:1/-1" v-model="newLit.excerpt" placeholder="原文摘录"></textarea></div>
     <button class="btn sm" style="margin-top:8px" v-if="!ro" :disabled="!newLit.title" @click="addLit">＋ 添加文献</button></section>
   </div>
   <section class="card"><h2>画像观察记录 <span class="tag L3">AI 初读 {{obs.filter(o=>o.status==='ai').length}} / 专家已确认 {{obs.filter(o=>o.status==='confirmed').length}}</span><span class="sp"></span>
     <button class="btn sm" v-if="!ro" :disabled="busy" @click="aiRead">{{busy?'读图中…':'AI 初读主史料'}}</button> <button class="btn sm" v-if="!ro" @click="addObs">＋ 新增部位</button></h2>
    <table><thead><tr><th>部位</th><th>画像所见</th><th>待专家判断</th><th>状态</th><th></th></tr></thead><tbody>
     <tr v-for="o in obs" :key="o.id" :style="editing[o.id]?{background:'var(--blue-soft)'}:{}">
      <template v-if="editing[o.id]"><td><input class="input" v-model="editing[o.id].part"></td><td><textarea class="input" v-model="editing[o.id].seen"></textarea></td><td><input class="input w100" v-model="editing[o.id].question"></td><td><span class="tag st-need">编辑中</span></td><td><button class="btn sm pri" @click="save(o)">保存</button></td></template>
      <template v-else><td><b>{{o.part}}</b></td><td>{{o.seen||'—'}}</td><td class="muted">{{o.question||'—'}}</td>
       <td><span class="tag" :class="o.status==='confirmed'?'st-ok':o.status==='ai'?'L3':'st-wait'">{{o.status==='confirmed'?(o.editor+' 已确认'):o.status==='ai'?'AI 初读，待确认':'待填写'}}</span></td><td><button class="btn sm" v-if="!ro" @click="edit(o)">编辑</button></td></template></tr>
    </tbody></table></section>
  </main>`,
};

async function refreshProject() { if (G.route.pid) G.project = await api("GET", `/api/projects/${G.route.pid}`); }

/* ------------------------------------------------------------ P03 */
const SpecPage = {
  props: ["pid"],
  setup(props) {
    const data = ref(null), vi = ref(0), editing = reactive({}), comments = ref([]), open = ref(null), body = ref(""), srcs = ref([]);
    const cosigner = ref(""), promptText = ref(""), diffRows = ref(null), newField = reactive({ name: "", content: "" });
    const load = async (keep) => {
      data.value = await api("GET", `/api/projects/${props.pid}/spec`);
      if (!keep) vi.value = data.value.versions.length - 1;
      srcs.value = await api("GET", `/api/projects/${props.pid}/sources`);
      await loadComments();
    };
    const v = computed(() => data.value && data.value.versions[vi.value]);
    const loadComments = async () => { if (v.value) { comments.value = await api("GET", `/api/spec-versions/${v.value.id}/comments`); const p = await api("GET", `/api/spec-versions/${v.value.id}/prompt`); promptText.value = p.prompt; } };
    watch(vi, loadComments);
    onMounted(() => load());
    const canEdit = computed(() => v.value && v.value.status === "draft" && ["expert", "lead"].includes(G.me.role) && !G.project.archived);
    const startEdit = (f) => { editing[f.id] = { rev: f._rev, content: f.content, level: f.level, source_ids: [...(f.source_ids || [])], name: f.name }; open.value = f.code; };
    const save = async (f) => {
      try { await call(() => api("PATCH", `/api/spec-fields/${f.id}`, editing[f.id]), "已保存，状态回到待审"); delete editing[f.id]; await load(true); }
      catch (e) { if (e.status === 409) { delete editing[f.id]; await load(true); } }
    };
    const setStatus = async (f, status) => { await call(() => api("PATCH", `/api/spec-fields/${f.id}`, { rev: f._rev, status }), "已更新"); load(true); };
    const toggleNA = async (f) => { await call(() => api("PATCH", `/api/spec-fields/${f.id}`, { rev: f._rev, na: !f.na })); load(true); };
    const fieldComments = (code) => comments.value.filter((c) => c.field_code === code);
    const comment = async (f) => { await call(() => api("POST", `/api/spec-versions/${v.value.id}/comments`, { field_code: f.code, body: body.value })); body.value = ""; load(true); };
    const resolve = async (c) => { await call(() => api("POST", `/api/comments/${c.id}/resolve`)); load(true); };
    const sign = async () => { await call(() => api("POST", `/api/spec-versions/${v.value.id}/sign`, { cosigner_id: cosigner.value || null }), "已签署"); await load(true); refreshProject(); };
    const cosign = async () => { await call(() => api("POST", `/api/spec-versions/${v.value.id}/cosign`), "已复核签署"); load(true); refreshProject(); };
    const newDraft = async () => { await call(() => api("POST", `/api/projects/${props.pid}/spec/new-draft`), "已生成新版本草稿"); load(); };
    const addField = async () => { await call(() => api("POST", `/api/spec-versions/${v.value.id}/fields`, newField), "已新增字段"); newField.name = newField.content = ""; load(true); };
    const delField = async (f) => { if (confirm("删除该自定义字段？")) { await call(() => api("DELETE", `/api/spec-fields/${f.id}`)); load(true); } };
    const showDiff = async () => { const vs = data.value.versions; diffRows.value = await call(() => api("GET", `/api/projects/${props.pid}/spec/diff?a=${vs[vs.length - 2].id}&b=${vs[vs.length - 1].id}`)); };
    const srcName = (id) => (srcs.value.find((s) => s.id === id) || {}).title || "已删除";
    const experts = computed(() => (G.project.experts || []));
    return { data, vi, v, editing, open, body, srcs, cosigner, promptText, diffRows, newField, canEdit, startEdit, save, setStatus, toggleNA, fieldComments, comment, resolve, sign, cosign, newDraft, addField, delField, showDiff, srcName, experts, LEVELS, FSTATUS, G, fmtTime };
  },
  template: `<main v-if="v">
   <div class="head"><div><h2>② 形制规格书</h2><p>每个字段标证据等级并关联史料；专家逐字段编辑、校对和批注，主审签署后锁定为版本。</p></div><span class="sp"></span>
    <div class="seg"><button v-for="(x,i) in data.versions" :key="x.id" :class="{on:i===vi}" @click="vi=i">V{{x.no}} · {{x.status==='signed'?'已签署':x.status==='signing'?'待复核':'草稿'}}</button></div>
    <button class="btn" v-if="data.versions.length>1" @click="showDiff">版本对比</button>
    <button class="btn" v-if="G.project.is_lead && v.status==='signed' && vi===data.versions.length-1" @click="newDraft">生成新版本草稿</button></div>
   <div class="alert" v-if="v.status==='draft' && v.blockers.length">签署前需全部字段“已校对”且无未解决批注：{{v.blockers.join('；')}}</div>
   <div class="alert ok" v-if="v.status==='signed'">V{{v.no}} 已由 {{v.signer_name}} 于 {{fmtTime(v.signed_at)}} 签署{{v.cosigner_name?('，'+v.cosigner_name+' 复核'):''}}，内容已锁定。</div>
   <div class="alert info" v-if="v.status==='signing'">等待 {{v.cosigner_name}} 复核签署。<button class="btn sm ok" v-if="v.cosigner_id===G.me.id" @click="cosign">复核签署</button></div>
   <section class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>编号</th><th>字段</th><th style="width:34%">内容</th><th>证据等级</th><th>依据</th><th>审核状态</th><th>操作</th></tr></thead><tbody>
    <template v-for="f in v.fields" :key="f.id"><tr :style="open===f.code?{background:'#FFFBF3'}:{}">
     <td class="mono">{{f.code}}</td><td><b>{{f.name}}</b><div class="small muted" v-if="f.custom">自定义</div></td>
     <td v-if="editing[f.id]"><textarea class="input" style="height:72px" v-model="editing[f.id].content"></textarea></td>
     <td v-else :class="{muted:f.na}">{{f.na?'不适用':f.content}}<div class="small muted" v-if="f.updated_by">最近修改：{{f.updated_by}}</div></td>
     <td v-if="editing[f.id]"><select class="input" v-model="editing[f.id].level"><option v-for="(n,k) in LEVELS" :value="k">{{n}}</option></select></td>
     <td v-else><span class="tag" :class="f.level">{{LEVELS[f.level]}}</span></td>
     <td v-if="editing[f.id]"><div class="chk"><label v-for="s in srcs" :key="s.id"><input type="checkbox" :value="s.id" v-model="editing[f.id].source_ids">{{s.title}}</label></div></td>
     <td v-else><span class="chip src" v-for="id in f.source_ids" :key="id">{{srcName(id)}}</span><span v-if="!f.source_ids.length" class="muted">—</span></td>
     <td><span class="tag" :class="FSTATUS[f.status][1]">{{FSTATUS[f.status][0]}}{{f.status==='checked'&&f.checked_by_name?(' · '+f.checked_by_name):''}}</span><div class="small" style="color:var(--bad)" v-if="f.open_comments">{{f.open_comments}} 条批注</div></td>
     <td><template v-if="canEdit"><template v-if="editing[f.id]"><button class="btn sm pri" @click="save(f)">保存</button> <button class="btn sm" @click="delete editing[f.id]">取消</button></template>
       <template v-else><button class="btn sm" @click="startEdit(f)">编辑</button> <button class="btn sm" v-if="f.status!=='checked'" @click="setStatus(f,'checked')">校对通过</button>
        <select class="input" style="min-height:28px;padding:2px" @change="setStatus(f,$event.target.value);$event.target.value=''"><option value="">标记…</option><option value="dispute">有异议</option><option value="need">需补证</option></select>
        <button class="btn sm" v-if="['F2','F3','F4','F5','F6','F7','F8','F9','F10','F11'].includes(f.code)||f.custom" @click="toggleNA(f)">{{f.na?'恢复':'不适用'}}</button>
        <button class="btn sm warn" v-if="f.custom" @click="delField(f)">删除</button></template></template>
      <button class="btn sm" @click="open=open===f.code?null:f.code">批注 {{fieldComments(f.code).length||''}}</button></td></tr>
     <tr v-if="open===f.code"><td></td><td colspan="6"><div class="thread">
      <div v-for="c in fieldComments(f.code)" :key="c.id" :style="c.resolved?{opacity:.55}:{}"><span class="who">{{c.user}}</span> <span class="muted">{{fmtTime(c._created)}}</span> <span class="tag st-ok" v-if="c.resolved">已解决</span><br>{{c.body}}
       <a v-if="!c.resolved && (c.user_id===G.me.id||G.project.is_lead)" class="small" @click="resolve(c)"> 标记解决</a></div>
      <div class="formrow"><input class="input" style="flex:1" v-model="body" placeholder="写批注，可用 @姓名 提及专家"><button class="btn sm pri" :disabled="!body" @click="comment(f)">发送</button></div></div></td></tr></template>
   </tbody></table>
   <div class="row" style="padding:10px 14px;border-top:1px solid var(--line)" v-if="canEdit"><input class="input" v-model="newField.name" placeholder="新字段名，如 冠服搭配"><input class="input" style="flex:1" v-model="newField.content" placeholder="内容"><button class="btn sm" :disabled="!newField.name" @click="addField">＋ 新增自定义字段</button></div></section>
   <section class="card" v-if="G.project.is_lead && v.status==='draft'"><h2>签署 V{{v.no}}</h2><div class="formrow">
    <label class="f">复核专家（可选，两人都签才生效）<select v-model="cosigner"><option value="">不设复核</option><option v-for="e in experts" :value="e.id">{{e.name}}</option></select></label>
    <button class="btn ok" :disabled="v.blockers.length>0" @click="sign">签署 V{{v.no}}</button><span class="small muted" v-if="v.blockers.length">还有 {{v.blockers.length}} 项未完成</span></div></section>
   <section class="card"><h2>AI 收到的提示词（只读预览）<span class="sp"></span><span class="small muted">随字段修改实时更新</span></h2><pre class="small muted" style="white-space:pre-wrap;margin:0">{{promptText}}</pre></section>
   <div class="modal-bg" v-if="diffRows" @click.self="diffRows=null"><div class="modal"><h2>版本对比 V{{data.versions[data.versions.length-2].no}} → V{{data.versions[data.versions.length-1].no}}</h2>
    <div v-if="!diffRows.length" class="muted">两个版本内容相同</div>
    <div v-for="d in diffRows" :key="d.code" class="small"><b class="mono">{{d.code}} {{d.name}}</b> <span class="tag st-wait">{{d.kind}}</span> <span class="muted">{{d.by||''}}</span><br>
     <span class="diff-del" v-if="d.before">{{d.before}}</span> <span class="diff-add" v-if="d.after">{{d.after}}</span></div>
    <div class="row"><span class="sp"></span><button class="btn" @click="diffRows=null">关闭</button></div></div></div>
  </main>`,
};

/* ------------------------------------------------------------ P04 */
const GeneratePage = {
  props: ["pid"],
  setup(props) {
    const jobs = ref([]), runs = ref([]), spec = ref(null), filter = ref("draft"), detail = ref(null);
    const opt = reactive({ view: "front", per_model: 2, models: ["nb2", "sd", "gpt", "qwen"], group: "", seed: null, prompt_override: "" });
    const up = reactive({ stage: "draft", model: "qwen", view: "front", variant: "", seconds: "" });
    let timer;
    const load = async () => {
      jobs.value = await api("GET", `/api/projects/${props.pid}/jobs`);
      runs.value = await api("GET", `/api/projects/${props.pid}/runs`);
      spec.value = await api("GET", `/api/projects/${props.pid}/spec`);
    };
    const avail = ref([]);
    onMounted(async () => { avail.value = await api("GET", "/api/models-available"); opt.models = [...avail.value]; });
    onMounted(() => { load(); timer = setInterval(() => { if (jobs.value.some((j) => j.tasks.some((t) => ["queued", "running"].includes(t.status)))) load(); }, 2000); });
    onUnmounted(() => clearInterval(timer));
    const signed = computed(() => spec.value && spec.value.versions.filter((v) => v.status === "signed"));
    const hasV1 = computed(() => signed.value && signed.value.some((v) => v.no === 1));
    const hasV2 = computed(() => signed.value && signed.value.some((v) => v.no >= 2));
    const start = async (stage) => {
      const body = { stage, view: opt.view, per_model: +opt.per_model, models: opt.models };
      if (G.me.role === "tech" && stage === "experiment") Object.assign(body, { group: opt.group || "E0", seed: opt.seed || null, prompt_override: opt.prompt_override || null });
      await call(() => api("POST", `/api/projects/${props.pid}/jobs`, body), "已提交生成任务");
      filter.value = stage; load(); refreshProject();
    };
    const retry = async (t) => { await call(() => api("POST", `/api/gen-tasks/${t.id}/retry`), "已重试"); load(); };
    const upload = async (files) => {
      const fd = new FormData(); for (const f of files) fd.append("files", f);
      for (const k of ["stage", "model", "view", "variant"]) fd.append(k, up[k]);
      if (up.seconds) fd.append("seconds", up.seconds);
      await call(() => api("POST", `/api/projects/${props.pid}/runs/upload`, fd, true), "已上传"); load();
    };
    const shown = computed(() => runs.value.filter((r) => r.stage === filter.value));
    const latest = computed(() => jobs.value[0]);
    const est = computed(() => opt.models.length * opt.per_model);
    return { avail, jobs, runs, spec, filter, detail, opt, up, hasV1, hasV2, start, retry, upload, shown, latest, est, img, STAGE, VIEW, MODELS, fmtTime, G, go };
  },
  template: `<main>
   <div class="head"><div><h2>③ AI 生成</h2><p>点“生成”后系统自动调用各模型，结果回到下方画廊；不需要到外部网站复制提示词。</p></div></div>
   <section class="card" style="display:grid;gap:10px"><div class="formrow">
     <label class="f">视角<select v-model="opt.view"><option value="front">正面</option><option value="side">侧面（以入选正面为参考）</option><option value="back">背面（以入选正面为参考）</option></select></label>
     <label class="f">每模型张数<select v-model="opt.per_model"><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
     <div><div class="small muted">模型</div><div class="chk"><label v-for="(n,k) in MODELS" :key="k" :style="avail.includes(k)?{}:{opacity:.5}"><input type="checkbox" :value="k" v-model="opt.models" :disabled="!avail.includes(k)">{{n}}{{avail.includes(k)?'':'（未配置）'}}</label></div></div></div>
    <div class="alert" v-if="!avail.length">还没有可用的模型：请技术人员在“系统设置 → 模型接入”填写密钥。</div></section>
   <div class="grid3">
    <section class="card" :style="hasV1?{borderColor:'var(--ok)'}:{}"><h2>① 生成初稿</h2><p class="small muted">依据规格书 V1，文字 + 主史料参考图，所选模型并行。</p>
     <button class="btn pri w100" style="margin-top:10px" :disabled="!hasV1||!opt.models.length" @click="start('draft')">{{hasV1?('生成 '+est+' 张'):'规格书 V1 签署后可用'}}</button></section>
    <section class="card"><h2>② 修订重生成</h2><p class="small muted">依据最新签署的规格书（V2 起），以对比选择的入选版本为参考，只改修订项。</p>
     <button class="btn pri w100" style="margin-top:10px" :disabled="!hasV2||!opt.models.length" @click="start('revise')">{{hasV2?('生成 '+est+' 张'):'规格书 V2 签署后可用'}}</button></section>
    <section class="card"><h2>③ 展示应用</h2><p class="small muted">定稿后在“合拍模板”页生成虚拟模特穿着效果。</p><button class="btn w100" style="margin-top:10px" @click="go('#/templates')">前往合拍模板</button></section>
   </div>
   <section class="card" v-if="G.me.role==='tech'"><h2>实验模式 <span class="tag st-need">仅技术</span></h2><div class="formrow">
     <label class="f">实验组<select v-model="opt.group"><option value="E0">E0 通用直出</option><option value="E1">E1 规格书 · 文生图</option><option value="E2">E2 规格书 + 参考图</option></select></label>
     <label class="f">起始种子<input type="number" v-model.number="opt.seed" placeholder="随机"></label>
     <label class="f" style="flex:1">提示词覆盖（可选）<input v-model="opt.prompt_override"></label><button class="btn" :disabled="!hasV1" @click="start('experiment')">运行实验</button></div></section>
   <section class="card" v-if="latest"><h2>任务进度 · {{STAGE[latest.stage]}} · {{VIEW[latest.view]}} <span class="sp"></span><span class="small muted">{{fmtTime(latest._created)}} 发起 · {{latest.created_by_name}} · 规格书 V{{latest.spec_version_no}}</span></h2>
    <table><thead><tr><th>模型</th><th>状态</th><th style="width:40%">进度</th><th></th></tr></thead><tbody>
     <tr v-for="t in latest.tasks" :key="t.id"><td><b>{{MODELS[t.model]}}</b></td>
      <td><span class="tag" :class="{done:'st-ok',failed:'st-doubt',running:'L2',queued:'st-wait'}[t.status]">{{({done:'完成',failed:'失败',running:'生成中',queued:'排队中'})[t.status]}} {{t.done}}/{{t.total}}</span><div class="small" style="color:var(--bad)" v-if="t.error">{{t.error}}</div></td>
      <td><div class="progress"><i :style="{width:(t.done/t.total*100)+'%',background:t.status==='failed'?'var(--bad)':''}"></i></div></td>
      <td><button class="btn sm" v-if="t.status==='failed'" @click="retry(t)">单独重试</button></td></tr></tbody></table></section>
   <section class="card"><h2>结果画廊 <div class="seg" style="margin-left:8px"><button v-for="(n,k) in STAGE" :key="k" v-show="k!=='apply'&&(k!=='experiment'||G.me.role==='tech')" :class="{on:filter===k}" @click="filter=k">{{n}}</button></div><span class="sp"></span><span class="small muted">{{shown.length}} 张 · 点击查看来源</span></h2>
    <div class="grid4" v-if="shown.length"><div class="shot clickable" v-for="r in shown" :key="r.id" @click="detail=r"><div class="im"><img :src="img(r.file_id)"><span class="mock-flag" v-if="r.mock">模拟</span></div>
     <div class="meta"><b>{{r.model_name}} · {{VIEW[r.view]}}</b><span class="muted">规格书 V{{r.spec_version||'—'}} · {{r.seconds?r.seconds+' 秒':'手动上传'}}</span></div></div></div>
    <div v-else class="empty">还没有结果</div>
    <div class="formrow" style="margin-top:12px"><label class="f">手动上传 · 阶段<select v-model="up.stage"><option value="draft">生成初稿</option><option value="revise">修订重生成</option></select></label>
     <label class="f">模型<select v-model="up.model"><option v-for="(n,k) in MODELS" :value="k">{{n}}</option></select></label><label class="f">视角<select v-model="up.view"><option value="front">正面</option><option value="side">侧面</option><option value="back">背面</option></select></label>
     <label class="f">模型版本<input v-model="up.variant" placeholder="如 Nano Banana Pro"></label><label class="f">用时（秒）<input v-model="up.seconds" size="6"></label>
     <label class="btn">选择图片<input type="file" multiple accept="image/png,image/jpeg,image/webp" hidden @change="upload($event.target.files)"></label></div>
    <p class="small muted">用于接口未覆盖的模型；文件名按 E2_qwen_front_1.png 规则时自动识别组别、模型、视角。</p></section>
   <div class="modal-bg" v-if="detail" @click.self="detail=null"><div class="modal"><h2>{{detail.model_name}} · {{VIEW[detail.view]}} <span class="tag st-need" v-if="detail.mock">演示模式模拟图，非真实模型输出</span></h2>
    <img :src="img(detail.file_id)" style="max-height:60vh;object-fit:contain">
    <dl class="kv"><dt>阶段</dt><dd>{{STAGE[detail.stage]}}（{{detail.group}}）</dd><dt>模型版本</dt><dd>{{detail.model_version||'—'}}</dd><dt>种子</dt><dd class="mono">{{detail.seed||'—'}}</dd>
     <dt>规格书</dt><dd>V{{detail.spec_version||'—'}}</dd><dt>参考图</dt><dd>{{detail.ref_file_id?'有':'无'}}</dd><dt>用时</dt><dd>{{detail.seconds||'—'}} 秒</dd><dt v-if="detail.prompt">提示词</dt><dd v-if="detail.prompt" class="small" style="white-space:pre-wrap">{{detail.prompt}}</dd></dl>
    <div class="row"><a class="btn" :href="img(detail.file_id)" download>下载原图（含 AIGC 标识）</a><span class="sp"></span><button class="btn" @click="detail=null">关闭</button></div></div></div>
  </main>`,
};
