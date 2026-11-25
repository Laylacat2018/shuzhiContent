/* P05 专家评审 · P06 对比选择 · P07 修订 · P08 定稿存证 · P09 合拍模板 · P11 系统设置 */

/* ------------------------------------------------------------ P05 */
const ReviewPage = {
  props: ["pid"],
  setup(props) {
    const rounds = ref([]), ri = ref(0), runs = ref([]), sheet = ref(null), cur = ref(null), templates = ref([]), forbidList = ref([]);
    const form = reactive({ scores: {}, notes: {}, annotations: [], forbidden: [], opinion: "", suggestions: [], verdict: null });
    const newRound = reactive({ show: false, run_ids: [], expert_ids: [], template_id: "", deadline: "", blind: true });
    const tplEdit = ref(null), severity = ref("error"), ai = ref(null);
    const load = async () => {
      rounds.value = await api("GET", `/api/projects/${props.pid}/rounds`);
      runs.value = await api("GET", `/api/projects/${props.pid}/runs`);
      templates.value = await api("GET", "/api/review-templates");
      const spec = await api("GET", `/api/projects/${props.pid}/spec`);
      const f12 = spec.versions[spec.versions.length - 1].fields.find((f) => f.code === "F12");
      forbidList.value = f12 ? f12.content.split(/[、，,]/).map((x) => x.trim()).filter(Boolean) : [];
      if (round.value && !cur.value) openRun(round.value.run_ids[0]);
    };
    const round = computed(() => rounds.value[ri.value]);
    onMounted(load);
    watch(ri, () => { cur.value = null; if (round.value) openRun(round.value.run_ids[0]); });
    const openRun = async (rid) => {
      cur.value = rid; ai.value = null;
      sheet.value = await api("GET", `/api/rounds/${round.value.id}/sheet/${rid}`);
      const m = sheet.value.mine || {};
      Object.assign(form, { scores: { ...(m.scores || {}) }, notes: { ...(m.notes || {}) }, annotations: [...(m.annotations || [])], forbidden: [...(m.forbidden || [])],
        opinion: m.opinion || "", suggestions: (m.suggestions || []).map((x) => ({ ...x })), verdict: m.verdict || null });
      ai.value = sheet.value.ai;
    };
    const dims = computed(() => (sheet.value ? sheet.value.round.template.dims : []));
    const myTotal = computed(() => {
      let num = 0, den = 0;
      for (const d of dims.value) { den += d.weight * d.scale; num += d.weight * (form.scores[d.code] || 0); }
      return den ? Math.round((num / den) * 1000) / 10 : 0;
    });
    const isReviewer = computed(() => round.value && round.value.expert_ids.includes(G.me.id));
    const submitted = computed(() => sheet.value && sheet.value.mine && sheet.value.mine.submitted);
    const locked = computed(() => !isReviewer.value || submitted.value || (sheet.value && sheet.value.complete));
    const addMark = (e) => {
      if (locked.value) return;
      const box = e.currentTarget.getBoundingClientRect();
      const label = prompt("标注说明（如：上身做成背心式）");
      if (!label) return;
      form.annotations.push({ x: Math.round(((e.clientX - box.left) / box.width) * 1000) / 10, y: Math.round(((e.clientY - box.top) / box.height) * 1000) / 10, label, severity: severity.value });
    };
    const save = async (submit) => {
      await call(() => api("PUT", `/api/rounds/${round.value.id}/reviews/${cur.value}`, { ...form, submit }), submit ? "评审已提交" : "已暂存");
      await load(); openRun(cur.value); refreshProject();
    };
    const withdraw = async () => { await call(() => api("POST", `/api/rounds/${round.value.id}/reviews/${cur.value}/withdraw`), "已撤回，可修改"); openRun(cur.value); };
    const runAI = async () => { ai.value = await call(() => api("POST", `/api/runs/${cur.value}/ai-review?template_id=${round.value.template_id}`), "AI 预评完成"); };
    const createRound = async () => {
      const body = { run_ids: newRound.run_ids, expert_ids: newRound.expert_ids, template_id: newRound.template_id, blind: newRound.blind, deadline: newRound.deadline ? new Date(newRound.deadline).getTime() / 1000 : null };
      await call(() => api("POST", `/api/projects/${props.pid}/rounds`, body), "已发起评审"); newRound.show = false; ri.value = 0; cur.value = null; load();
    };
    const openNewRound = () => {
      const reviewed = new Set(rounds.value.flatMap((r) => r.run_ids));
      Object.assign(newRound, { show: true, run_ids: runs.value.filter((r) => !reviewed.has(r.id)).map((r) => r.id), expert_ids: [G.project.lead_id, ...G.project.experts.map((e) => e.id)],
        template_id: (templates.value[templates.value.length - 1] || {}).id, blind: true, deadline: "" });
    };
    const editTpl = (t) => { tplEdit.value = { name: t.name, category: t.category, dims: t.dims.map((d) => ({ ...d })) }; };
    const addDim = () => { const n = tplEdit.value.dims.length + 1; tplEdit.value.dims.push({ code: "C" + n, name: "", fields: "", weight: 1, scale: 2, required: true }); };
    const saveTpl = async () => { await call(() => api("POST", "/api/review-templates", tplEdit.value), "已保存为新版本"); tplEdit.value = null; load(); };
    const label = (rid) => { const r = runs.value.find((x) => x.id === rid); const i = round.value.run_ids.indexOf(rid); return round.value.blind && !round.value.complete ? "候选 " + String.fromCharCode(65 + i) : r ? `${r.model_name} · ${VIEW[r.view]}` : rid; };
    const runImg = (rid) => img((runs.value.find((x) => x.id === rid) || {}).file_id);
    return { rounds, ri, round, runs, sheet, cur, templates, forbidList, form, newRound, tplEdit, severity, ai, dims, myTotal, isReviewer, submitted, locked, openRun, addMark, save, withdraw, runAI, createRound, openNewRound, editTpl, addDim, saveTpl, label, runImg, img, G, fmtTime, VIEW };
  },
  template: `<main>
   <div class="head"><div><h2>④ 专家评审</h2><p>每位专家独立打分；提交前看不到他人的分数。AI 预评只作参考，不计入专家分。</p></div><span class="sp"></span>
    <select class="input" v-if="rounds.length>1" v-model="ri"><option v-for="(r,i) in rounds" :value="i">第 {{rounds.length-i}} 轮 · {{r.total}} 张</option></select>
    <span class="pill expert" v-if="round&&round.blind">盲评</span><span class="small muted" v-if="round&&round.deadline">截止 {{fmtTime(round.deadline)}}</span>
    <template v-if="G.project.is_lead"><button class="btn" @click="editTpl(templates[templates.length-1])">评审模板</button><button class="btn pri" @click="openNewRound">发起评审</button></template></div>
   <div class="empty" v-if="!round">还没有评审轮次。{{G.project.is_lead?'点击“发起评审”，选择候选图和评审专家。':'请等待主审发起评审。'}}</div>
   <template v-if="round">
    <section class="card"><div class="row" style="gap:12px"><b>评审进度</b>
     <span class="chip" v-for="(n,name) in round.progress" :key="name">{{name}} <span class="tag" :class="n>=round.total?'st-ok':n?'L2':'st-wait'">{{n>=round.total?'已提交':'进行中'}} {{n}}/{{round.total}}</span></span>
     <span class="tag st-ok" v-if="round.complete">全部提交，已揭晓</span></div>
     <div class="row" style="margin-top:10px;gap:8px"><div v-for="rid in round.run_ids" :key="rid" class="clickable" :class="{sel:cur===rid}" style="width:84px;border-radius:8px;overflow:hidden;border:1px solid var(--line)" @click="openRun(rid)">
      <img :src="runImg(rid)" style="width:100%;aspect-ratio:3/4;object-fit:cover;display:block"><div class="small" style="padding:2px 4px;white-space:nowrap;overflow:hidden">{{label(rid)}}</div></div></div></section>
    <div v-if="sheet" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:16px">
     <section class="card"><h2>{{label(cur)}} <span class="small muted" v-if="round.blind&&!round.complete">模型名已隐藏</span></h2>
      <div class="stage-img" @click="addMark"><img :src="runImg(cur)"><div v-for="(a,i) in form.annotations" :key="i" class="mark" :class="{ok:a.severity==='ok',doubt:a.severity==='doubt'}" :style="{left:a.x+'%',top:a.y+'%'}"><span>{{i+1}}</span></div></div>
      <ol class="small" style="margin:8px 0 0;padding-left:20px"><li v-for="(a,i) in form.annotations" :key="i"><b>{{({error:'错误',doubt:'存疑',ok:'亮点'})[a.severity]}}</b> {{a.label}} <a v-if="!locked" @click="form.annotations.splice(i,1)">删除</a></li></ol>
      <div class="row" v-if="!locked" style="margin-top:6px"><span class="small muted">点击图片添加标注，严重程度：</span><div class="seg"><button :class="{on:severity==='error'}" @click="severity='error'">错误</button><button :class="{on:severity==='doubt'}" @click="severity='doubt'">存疑</button><button :class="{on:severity==='ok'}" @click="severity='ok'">亮点</button></div></div></section>
     <section class="card"><h2>我的评分 <span class="score">{{myTotal}} / 100</span><span class="sp"></span><span class="small muted">模板：{{sheet.round.template.name}} v{{sheet.round.template.version}} · {{dims.length}} 项</span>
       <button class="btn sm" @click="runAI">AI 预评</button></h2>
      <table><thead><tr><th>项</th><th>评分项（权重）</th><th>我的打分</th><th>AI 预评</th></tr></thead><tbody>
       <tr v-for="d in dims" :key="d.code"><td class="mono">{{d.code}}</td><td>{{d.name}}（{{d.weight}}）<input v-if="!locked" class="input w100" style="min-height:26px;margin-top:4px" v-model="form.notes[d.code]" placeholder="评语（可选）"><div v-else-if="form.notes[d.code]" class="small muted">{{form.notes[d.code]}}</div></td>
        <td><div class="dots"><button v-for="n in d.scale+1" :key="n" :class="{on:form.scores[d.code]===n-1}" :disabled="locked" @click="form.scores[d.code]=n-1">{{n-1}}</button></div></td>
        <td class="muted">{{ai&&ai.scores?(ai.scores[d.code]??'—'):'—'}}</td></tr></tbody></table>
      <div style="display:grid;gap:8px;margin-top:10px">
       <div class="row"><b>禁用元素</b><div class="chk"><label v-for="x in forbidList" :key="x"><input type="checkbox" :value="x" v-model="form.forbidden" :disabled="locked">{{x}}</label></div></div>
       <label class="f">总体专业意见<textarea class="input" v-model="form.opinion" :disabled="locked"></textarea></label>
       <div><div class="small muted">修订建议（写入规格书的句子）</div>
        <div class="formrow" v-for="(s,i) in form.suggestions" :key="i"><input class="input" style="width:70px" v-model="s.field" placeholder="F4" :disabled="locked"><input class="input" style="flex:1" v-model="s.change" :disabled="locked"><a v-if="!locked" @click="form.suggestions.splice(i,1)">删除</a></div>
        <button class="btn sm" v-if="!locked" @click="form.suggestions.push({field:'',change:'',reason:''})">＋ 修订建议</button></div>
       <div class="row"><b>结论</b><div class="seg"><button v-for="v in ['通过','重新生成','退回改规格书']" :key="v" :class="{on:form.verdict===v}" :disabled="locked" @click="form.verdict=v">{{v}}</button></div><span class="sp"></span>
        <template v-if="isReviewer&&!sheet.complete"><button class="btn" v-if="!submitted" @click="save(false)">暂存</button><button class="btn pri" v-if="!submitted" @click="save(true)">提交评审</button><button class="btn" v-if="submitted" @click="withdraw">撤回修改</button></template>
        <span class="small muted" v-if="!isReviewer">你不在本轮评审名单中</span></div>
       <p class="small muted" v-if="ai&&ai.summary">AI 预评（{{ai.model}}）：{{ai.summary}}</p></div></section></div>
    <section class="card" v-if="sheet&&sheet.complete"><h2>评审汇总 · {{label(cur)}} <span class="tag L2">推荐分 {{sheet.summary.score??'—'}}</span><span class="tag st-doubt" v-if="sheet.summary.forbidden.length">禁用元素：{{sheet.summary.forbidden.join('、')}}</span></h2>
     <table><thead><tr><th>项</th><th>平均</th><th>标准差</th><th v-for="o in sheet.others" :key="o.id">{{o.expert}}</th><th></th></tr></thead><tbody>
      <tr v-for="d in sheet.summary.dims" :key="d.code" :style="d.divergent?{background:'var(--bad-soft)'}:{}"><td class="mono">{{d.code}} {{d.name}}</td><td class="score">{{d.mean}}</td><td>{{d.std}}</td><td v-for="o in sheet.others" :key="o.id">{{o.scores[d.code]}}</td><td><span class="tag st-doubt" v-if="d.divergent">分歧</span></td></tr>
      <tr><td>结论</td><td colspan="2"><span class="tag st-doubt" v-if="sheet.summary.verdict_divergent">结论不一致</span></td><td v-for="o in sheet.others" :key="o.id">{{o.verdict}}</td><td></td></tr></tbody></table>
     <div class="small" v-for="o in sheet.others" :key="'op'+o.id"><b>{{o.expert}}：</b>{{o.opinion||'—'}}</div></section>
   </template>
   <div class="modal-bg" v-if="newRound.show" @click.self="newRound.show=false"><div class="modal"><h2>发起评审</h2>
    <div class="small muted">候选图（{{newRound.run_ids.length}}）</div><div class="row" style="gap:6px"><label v-for="r in runs" :key="r.id" style="width:76px" class="small"><img :src="img(r.file_id)" style="width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:6px"><input type="checkbox" :value="r.id" v-model="newRound.run_ids">{{r.model_name}}</label></div>
    <div class="small muted">评审专家</div><div class="chk"><label><input type="checkbox" :value="G.project.lead_id" v-model="newRound.expert_ids">{{G.project.lead_name}}（主审）</label><label v-for="e in G.project.experts" :key="e.id"><input type="checkbox" :value="e.id" v-model="newRound.expert_ids">{{e.name}}</label></div>
    <div class="formrow"><label class="f">评审模板<select v-model="newRound.template_id"><option v-for="t in templates" :value="t.id">{{t.name}} v{{t.version}}（{{t.dims.length}} 项）</option></select></label>
     <label class="f">截止时间<input type="datetime-local" v-model="newRound.deadline"></label><label class="chip"><input type="checkbox" v-model="newRound.blind"> 盲评（隐藏模型名）</label></div>
    <div class="row"><span class="sp"></span><button class="btn" @click="newRound.show=false">取消</button><button class="btn pri" :disabled="!newRound.run_ids.length||!newRound.expert_ids.length" @click="createRound">发起</button></div></div></div>
   <div class="modal-bg" v-if="tplEdit" @click.self="tplEdit=null"><div class="modal"><h2>评审模板 · {{tplEdit.name}}</h2><p class="small muted">保存后生成新版本；已用于评审的旧版本不受影响。</p>
    <table><thead><tr><th>编号</th><th>评分项</th><th>权重</th><th>分制</th><th>必评</th></tr></thead><tbody>
     <tr v-for="(d,i) in tplEdit.dims" :key="i"><td><input class="input" style="width:60px" v-model="d.code"></td><td><input class="input w100" v-model="d.name"></td><td><input class="input" style="width:60px" type="number" min="0.5" step="0.5" v-model.number="d.weight"></td>
      <td><select class="input" v-model.number="d.scale"><option :value="2">0–2</option><option :value="5">0–5</option></select></td><td><input type="checkbox" v-model="d.required"></td></tr></tbody></table>
    <div class="row"><button class="btn sm" @click="addDim">＋ 新增维度</button><span class="sp"></span><button class="btn" @click="tplEdit=null">取消</button><button class="btn pri" @click="saveTpl">保存为新版本</button></div></div></div>
  </main>`,
};

/* ------------------------------------------------------------ P06 */
const ComparePage = {
  props: ["pid"],
  setup(props) {
    const data = ref(null), runs = ref([]), primary = ref(null), picks = ref([]), zoom = ref(1);
    const myVote = reactive({ first: "", backups: [], reason: "", dissent: "" }), dec = reactive({ run_id: "", reason: "" });
    const load = async () => {
      data.value = await api("GET", `/api/projects/${props.pid}/compare`);
      runs.value = await api("GET", `/api/projects/${props.pid}/runs`);
      primary.value = (await api("GET", `/api/projects/${props.pid}/sources`)).find((s) => s.primary);
      const mine = data.value.votes.find((v) => v.expert_id === G.me.id);
      if (mine) Object.assign(myVote, { first: mine.first, backups: mine.backups, reason: mine.reason, dissent: mine.dissent });
      if (!dec.run_id && data.value.recommendations[0]) dec.run_id = data.value.recommendations[0].run.id;
      if (!picks.value.length) picks.value = data.value.recommendations.map((r) => r.run.id);
    };
    onMounted(load);
    const run = (id) => runs.value.find((r) => r.id === id) || {};
    const scoredRuns = computed(() => (data.value ? runs.value.filter((r) => data.value.scored[r.id] !== undefined) : []));
    const top = computed(() => data.value && data.value.recommendations[0] && data.value.recommendations[0].run.id);
    const vote = async () => { await call(() => api("PUT", `/api/projects/${props.pid}/vote`, myVote), "已提交推荐"); load(); };
    const decide = async () => { await call(() => api("POST", `/api/projects/${props.pid}/decision`, dec), "已确定入选版本"); load(); refreshProject(); };
    const canVote = computed(() => G.project.is_lead || G.project.experts.some((e) => e.id === G.me.id));
    const togglePick = (id) => { const i = picks.value.indexOf(id); if (i >= 0) picks.value.splice(i, 1); else if (picks.value.length < 4) picks.value.push(id); };
    const stages = ["draft", "revise"], models = ["nb2", "sd", "gpt", "qwen"];
    const cell = (s, m) => data.value.matrix.find((c) => c.stage === s && c.model === m);
    return { data, runs, primary, picks, zoom, myVote, dec, run, scoredRuns, top, vote, decide, canVote, togglePick, stages, models, cell, img, G, STAGE, MODELS, VIEW, fmtTime, userName };
  },
  template: `<main v-if="data">
   <div class="head"><div><h2>⑤ 对比选择</h2><p>系统按专家评分推荐，专家也可推荐自己认为最合适的版本；以主审的选择为准。</p></div></div>
   <div class="empty" v-if="!data.recommendations.length">还没有完成的评审轮次，评审全部提交后这里给出推荐。</div>
   <template v-else>
    <section class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>阶段 \\ 模型</th><th v-for="m in models" :key="m">{{MODELS[m]}}</th></tr></thead><tbody>
     <tr v-for="s in stages" :key="s"><td><b>{{STAGE[s]}}</b></td><td v-for="m in models" :key="m"><template v-if="cell(s,m)"><span class="score">{{cell(s,m).mean}}</span> <span class="small" :style="cell(s,m).forbidden?{color:'var(--bad)'}:{}">禁用 {{cell(s,m).forbidden}}</span></template><span v-else class="muted">—</span></td></tr></tbody></table></section>
    <div class="grid3"><section class="card" v-for="(r,i) in data.recommendations" :key="r.run.id" :style="i===0?{border:'2px solid var(--ok)'}:{}">
     <h2>系统推荐 #{{i+1}} <span class="tag" :class="i===0?'st-ok':'L2'">{{r.score}}</span><span class="sp"></span><span class="vote" v-if="r.votes">专家首选 {{r.votes}}</span></h2>
     <div class="shot" style="border:none"><div class="im"><img :src="img(r.run.file_id)"><span class="mock-flag" v-if="r.run.mock">模拟</span></div></div>
     <p class="small" style="margin-top:6px"><b>{{r.run.model_name}} · {{STAGE[r.run.stage]}} · {{VIEW[r.run.view]}}</b></p><p class="small muted">理由：{{r.reason}}</p></section></div>
    <section class="card"><h2>并排对比 <span class="small muted">选 2–4 张，与原画像一起看</span><span class="sp"></span><label class="small">放大 <input type="range" min="1" max="3" step="0.25" v-model.number="zoom"></label></h2>
     <div class="row" style="gap:6px;margin-bottom:8px"><span v-for="r in scoredRuns" :key="r.id" class="chip clickable" :class="{sel:picks.includes(r.id)}" @click="togglePick(r.id)">{{r.model_name}} {{STAGE[r.stage]}} · {{data.scored[r.id]}}</span></div>
     <div class="grid4" style="grid-template-columns:repeat(5,1fr)"><div class="shot" v-if="primary"><div class="im" style="overflow:hidden"><img :src="img(primary.file_id)" :style="{transform:'scale('+zoom+')'}"></div><div class="meta"><b>原画像</b></div></div>
      <div class="shot" v-for="id in picks" :key="id"><div class="im" style="overflow:hidden"><img :src="img(run(id).file_id)" :style="{transform:'scale('+zoom+')'}"></div><div class="meta"><b>{{run(id).model_name}}</b><span class="muted">{{data.scored[id]}} 分</span></div></div></div></section>
    <div class="grid2">
     <section class="card"><h2>专家推荐与意见</h2>
      <div v-for="v in data.votes" :key="v.id" style="padding:6px 0;border-top:1px solid var(--line)" class="small"><b>{{v.expert}}</b> <span class="vote">首选 {{run(v.first).model_name}} {{STAGE[run(v.first).stage]}}</span> <span class="tag st-need" v-if="v.first!==top">不同意系统推荐</span>
       <div class="muted">{{v.reason}}</div><div v-if="v.dissent" class="muted">反对意见：{{v.dissent}}</div></div>
      <div v-if="canVote" style="display:grid;gap:8px;margin-top:10px"><label class="f">我的首选<select v-model="myVote.first"><option value="">请选择</option><option v-for="r in scoredRuns" :key="r.id" :value="r.id">{{r.model_name}} · {{STAGE[r.stage]}} · {{data.scored[r.id]}}</option></select></label>
       <div class="chk"><span class="small muted">备选</span><label v-for="r in scoredRuns" :key="'b'+r.id"><input type="checkbox" :value="r.id" v-model="myVote.backups">{{r.model_name}} {{STAGE[r.stage]}}</label></div>
       <label class="f">推荐理由<textarea class="input" v-model="myVote.reason"></textarea></label><label class="f">对系统推荐的反对意见（可选）<input class="input" v-model="myVote.dissent"></label>
       <button class="btn pri" :disabled="!myVote.first" @click="vote">提交我的推荐</button></div></section>
     <section class="card"><h2>主审决定</h2>
      <div v-if="data.decision" class="alert ok">已确定入选：{{run(data.decision.run_id).model_name}} · {{STAGE[run(data.decision.run_id).stage]}}（{{data.decision.by_name}}，{{fmtTime(data.decision._created)}}）<div v-if="data.decision.reason">理由：{{data.decision.reason}}</div></div>
      <template v-if="G.project.is_lead"><label class="f">入选版本<select v-model="dec.run_id"><option v-for="r in scoredRuns" :key="r.id" :value="r.id">{{r.model_name}} · {{STAGE[r.stage]}} · {{data.scored[r.id]}}</option></select></label>
       <div class="alert" v-if="dec.run_id && dec.run_id!==top">与系统推荐第一名不一致，须填写理由（写入存证）</div>
       <label class="f" style="margin-top:8px">选择理由<textarea class="input" v-model="dec.reason"></textarea></label>
       <div class="row" style="margin-top:8px"><span class="sp"></span><button class="btn ok" @click="decide">确定入选版本</button></div></template>
      <p v-else class="small muted">由主审专家确定入选版本。</p></section></div>
   </template>
  </main>`,
};

/* ------------------------------------------------------------ P07 */
const RevisePage = {
  props: ["pid"],
  setup(props) {
    const groups = ref([]), spec = ref(null), diff = ref([]), best = ref([]), manual = reactive({ field: "", change: "" }), text = reactive({});
    const load = async () => {
      groups.value = await api("GET", `/api/projects/${props.pid}/revisions`);
      spec.value = await api("GET", `/api/projects/${props.pid}/spec`);
      const vs = spec.value.versions;
      diff.value = vs.length > 1 ? await api("GET", `/api/projects/${props.pid}/spec/diff?a=${vs[vs.length - 2].id}&b=${vs[vs.length - 1].id}`) : [];
      best.value = await api("GET", `/api/projects/${props.pid}/v-compare`);
    };
    onMounted(load);
    const handle = async (x, action) => {
      const body = { action };
      if (action === "reject") { body.reason = prompt("驳回原因（必填）") || ""; if (!body.reason) return; }
      if (action === "modify") { body.text = text[x.id] || x.change; }
      await call(() => api("POST", `/api/revisions/${x.id}`, body), action === "reject" ? "已驳回" : "已写入新版本草稿"); load();
    };
    const add = async () => { await call(() => api("POST", `/api/projects/${props.pid}/revisions`, manual), "已添加"); manual.field = manual.change = ""; load(); };
    const latest = computed(() => spec.value && spec.value.versions[spec.value.versions.length - 1]);
    const canRegen = computed(() => latest.value && latest.value.status === "signed" && latest.value.no >= 2);
    const regen = async () => { await call(() => api("POST", `/api/projects/${props.pid}/jobs`, { stage: "revise" }), "已发起修订重生成"); go(`#/p/${props.pid}/generate`); };
    const counts = computed(() => { const all = groups.value.flatMap((g) => g.items); return { all: all.length, pending: all.filter((x) => x.status === "pending").length, acc: all.filter((x) => ["accepted", "modified"].includes(x.status)).length, rej: all.filter((x) => x.status === "rejected").length }; });
    return { groups, spec, diff, best, manual, text, handle, add, latest, canRegen, regen, counts, img, G, go, STAGE };
  },
  template: `<main>
   <div class="head"><div><h2>⑥ 修订 V2</h2><p>汇集各专家的修订建议，主审逐条采纳或驳回，写入规格书新版本后修订重生成。</p></div><span class="sp"></span><span class="small muted">{{counts.all}} 条建议 · 已采纳 {{counts.acc}} · 驳回 {{counts.rej}} · 待处理 {{counts.pending}}</span></div>
   <section class="card"><h2>修订清单（按字段归并）</h2>
    <div class="empty" v-if="!groups.length">还没有修订建议。专家在评审时填写“修订建议”后会汇集到这里。</div>
    <table v-else><thead><tr><th>字段</th><th>建议</th><th>提出人</th><th>处理</th></tr></thead><tbody>
     <template v-for="g in groups" :key="g.field"><tr v-for="(x,i) in g.items" :key="x.id"><td class="mono" v-if="i===0" :rowspan="g.items.length">{{g.field}}</td>
      <td>{{x.final_text||x.change}}<div class="small muted" v-if="x.reason">{{x.reason}}</div><input v-if="x.status==='pending'&&G.project.is_lead" class="input w100" style="margin-top:4px" v-model="text[x.id]" placeholder="修改后采纳：在此改写（可选）"></td><td>{{x.proposer}}</td>
      <td><template v-if="x.status==='pending'&&G.project.is_lead"><div class="row"><button class="btn sm ok" @click="handle(x,'accept')">采纳</button><button class="btn sm" @click="handle(x,'modify')">修改后采纳</button><button class="btn sm warn" @click="handle(x,'reject')">驳回</button></div></template>
       <span v-else class="tag" :class="{pending:'st-wait',accepted:'st-ok',modified:'st-ok',rejected:'st-doubt'}[x.status]">{{({pending:'待处理',accepted:'已采纳',modified:'修改后采纳',rejected:'已驳回'})[x.status]}}{{x.version_no?(' → V'+x.version_no):''}}</span><div class="small muted" v-if="x.reject_reason">原因：{{x.reject_reason}}</div></td></tr></template></tbody></table>
    <div class="formrow" style="margin-top:10px" v-if="G.project.is_lead"><input class="input" style="width:80px" v-model="manual.field" placeholder="F5"><input class="input" style="flex:1" v-model="manual.change" placeholder="手动补充一条修订"><button class="btn sm" :disabled="!manual.field||!manual.change" @click="add">添加</button></div></section>
   <div class="grid2">
    <section class="card"><h2>规格书差异 <span v-if="latest">→ V{{latest.no}} <span class="tag" :class="latest.status==='signed'?'st-ok':'st-wait'">{{latest.status==='signed'?'已签署':'草稿'}}</span></span></h2>
     <div v-if="!diff.length" class="muted small">暂无差异</div>
     <div v-for="d in diff" :key="d.code" class="small" style="margin-bottom:6px"><b class="mono">{{d.code}}</b> <span class="diff-del" v-if="d.before">{{d.before}}</span> <span class="diff-add" v-if="d.after">{{d.after}}</span></div>
     <div class="row" style="margin-top:12px"><button class="btn" @click="go('#/p/'+G.project.id+'/spec')">去 ② 校对并签署</button><span class="sp"></span><button class="btn pri" :disabled="!canRegen" @click="regen">{{canRegen?'修订重生成':'新版本签署后可用'}}</button></div></section>
    <section class="card"><h2>各版本最佳结果</h2><div class="empty" v-if="!best.length">评审完成后显示</div>
     <div class="grid2" v-else><figure style="margin:0" v-for="b in best" :key="b.version"><div class="shot"><div class="im"><img :src="img(b.run.file_id)"></div></div><figcaption class="small" style="margin-top:6px"><b>V{{b.version}} 最佳</b> · {{b.run.model_name}} {{b.score}}</figcaption></figure></div></section></div>
  </main>`,
};

/* ------------------------------------------------------------ P08 */
const FinalPage = {
  props: ["pid"],
  setup(props) {
    const finals = ref([]), cmp = ref(null), runs = ref([]), vres = ref(null);
    const form = reactive({ front: "", others: [], license: "可对外展示", cosigner_ids: [] });
    const load = async () => {
      finals.value = await api("GET", `/api/projects/${props.pid}/finals`);
      cmp.value = await api("GET", `/api/projects/${props.pid}/compare`);
      runs.value = await api("GET", `/api/projects/${props.pid}/runs`);
      if (!form.front && cmp.value.decision) form.front = cmp.value.decision.run_id;
    };
    onMounted(load);
    const active = computed(() => finals.value.find((f) => f.status !== "revoked"));
    const fronts = computed(() => runs.value.filter((r) => r.view === "front" && cmp.value && cmp.value.scored[r.id] !== undefined));
    const extra = computed(() => runs.value.filter((r) => r.view !== "front"));
    const sign = async () => { await call(() => api("POST", `/api/projects/${props.pid}/finals`, { run_ids: [form.front, ...form.others], license: form.license, cosigner_ids: form.cosigner_ids }), "已签署定稿"); load(); refreshProject(); };
    const verify = async (f) => { vres.value = await call(() => api("POST", `/api/finals/${f.id}/verify`)); };
    const cosign = async (f) => { await call(() => api("POST", `/api/finals/${f.id}/cosign`), "已会签"); load(); refreshProject(); };
    const revoke = async (f) => { const reason = prompt("撤销原因（必填），已上线的合拍模板将同时下线"); if (reason) { await call(() => api("POST", `/api/finals/${f.id}/revoke`, { reason }), "已撤销"); load(); refreshProject(); } };
    return { finals, cmp, runs, vres, form, active, fronts, extra, sign, verify, cosign, revoke, img, G, fmtTime, STAGE, VIEW };
  },
  template: `<main>
   <div class="head"><div><h2>⑦ 定稿存证</h2><p>主审签署定稿，系统对定稿图、规格书版本、评审记录和推荐理由计算 SM3 哈希，国博与咪咕两端各留一份。</p></div><span class="sp"></span><span class="pill expert">专家节点 · 签署定稿 · 授权等级</span></div>
   <section class="card" v-if="active"><div style="display:grid;grid-template-columns:340px minmax(0,1fr);gap:20px;align-items:start">
    <div><div class="shot" v-for="r in active.runs" :key="r.id" style="margin-bottom:8px"><div class="im"><img :src="img(r.file_id)"><span class="mock-flag" v-if="r.mock">模拟</span></div><div class="meta"><span class="tag st-ok">AI 复原 · AI 生成</span> {{VIEW[r.view]}}</div></div></div>
    <div style="display:grid;gap:12px"><h2 style="font-family:var(--f-display);font-size:22px">{{G.project.name}}</h2>
     <dl class="kv" style="font-size:13.5px"><dt>资产 ID</dt><dd class="mono">{{active.asset_no}}</dd><dt>依据文物</dt><dd>{{G.project.artifact||'—'}} · {{G.project.museum}}</dd>
      <dt>定稿版本</dt><dd>规格书 V{{active.meta.spec_version}} · {{active.runs[0].model_name}} · {{STAGE[active.runs[0].stage]}}</dd><dt>评审</dt><dd>{{active.meta.reviews.length}} 份专家评审 · 推荐分 {{active.score??'—'}}</dd>
      <dt>入选理由</dt><dd>{{(active.meta.decision&&active.meta.decision.reason)||'与系统推荐一致'}}</dd>
      <dt>签署</dt><dd>{{active.signer}}（主审）{{fmtTime(active.signed_at)}} <span v-for="(t,n) in active.cosigner_names" :key="n">· {{n}} <span class="tag" :class="t?'st-ok':'st-need'">{{t?'已会签':'待会签'}}</span></span></dd>
      <dt>授权等级</dt><dd>{{active.license}}</dd><dt>状态</dt><dd><span class="tag" :class="active.status==='active'?'st-ok':'st-need'">{{active.status==='active'?'有效':'待会签'}}</span></dd></dl>
     <div><b>存证哈希</b> <span class="small muted">{{active.algo}} · {{active.nodes.join(' / ')}}</span><div class="hash">{{active.hash}}</div></div>
     <div class="row"><button class="btn sm" @click="verify(active)">校验哈希</button><span v-if="vres" class="tag" :class="vres.ok?'st-ok':'st-doubt'">{{vres.ok?'✓ 一致：图像与记录未被改动':'✕ 不一致：图像或记录已被改动'}}</span></div>
     <div class="row"><a class="btn" v-for="r in active.runs" :key="'d'+r.id" :href="img(r.file_id)" download>下载{{VIEW[r.view]}}高清图</a><a class="btn" :href="'/api/finals/'+active.id+'/report'" target="_blank">复原报告（打印为 PDF）</a><span class="sp"></span>
      <button class="btn ok" v-if="active.cosigners[G.me.id]===null" @click="cosign(active)">会签</button><button class="btn warn" v-if="G.project.is_lead" @click="revoke(active)">撤销定稿</button></div></div></div></section>
   <section class="card" v-else style="display:grid;gap:12px"><h2>签署定稿</h2>
    <div class="empty" v-if="!fronts.length">需要至少一张已评审的正面候选图（先在 ⑤ 对比选择确定入选版本）。</div>
    <template v-else><div class="row" style="gap:8px"><label v-for="r in fronts" :key="r.id" class="small" style="width:110px"><img :src="img(r.file_id)" style="width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:6px" :class="{sel:form.front===r.id}"><input type="radio" :value="r.id" v-model="form.front">{{r.model_name}} {{cmp.scored[r.id]}}</label></div>
     <div v-if="extra.length"><div class="small muted">同时定稿侧面 / 背面（可选）</div><div class="chk"><label v-for="r in extra" :key="r.id"><input type="checkbox" :value="r.id" v-model="form.others">{{r.model_name}} {{VIEW[r.view]}}</label></div></div>
     <div class="formrow"><label class="f">授权等级<select v-model="form.license"><option>仅内部研究</option><option>可对外展示</option><option>可商业授权</option></select></label>
      <div><div class="small muted">会签专家（全部会签后生效）</div><div class="chk"><label v-for="e in G.project.experts" :key="e.id"><input type="checkbox" :value="e.id" v-model="form.cosigner_ids">{{e.name}}</label></div></div></div>
     <div class="row"><span class="sp"></span><button class="btn ok" v-if="G.project.is_lead" :disabled="!form.front" @click="sign">签署定稿并存证</button><span class="small muted" v-else>由主审专家签署</span></div></template></section>
   <section class="card" v-if="finals.some(f=>f.status==='revoked')"><h2>已撤销的定稿</h2><div class="small" v-for="f in finals.filter(f=>f.status==='revoked')" :key="f.id">{{f.asset_no}} · {{fmtTime(f.revoked_at)}} · 原因：{{f.revoke_reason}}</div></section>
  </main>`,
};

/* ------------------------------------------------------------ P09 */
const TemplatesPage = {
  setup() {
    const finals = ref([]), list = ref([]), acts = ref([]), filter = ref("all"), trialImg = ref(null), trialInfo = ref(null), samples = ref(null);
    const tt = reactive({ mode: "tryon", final_id: "", scene: "", busy: false });
    const MODES = { tryon: "真换装（保留观众姿势和背景）", swap: "模板合影（换脸进审定模板）", portrait: "本人穿礼服（自拍生成古装照）" };
    const gen = reactive({ final_id: "", gender: "女", pose: "站姿正面", bg: "展厅", count: 4 });
    const act = reactive({ show: false, name: "", hall: "", start: new Date().toISOString().slice(0, 10), end: "", daily_limit: 3000, template_ids: [], mode: "tryon", final_id: "", scene: "" });
    let timer;
    const load = async () => {
      finals.value = await api("GET", "/api/finals-shareable");
      list.value = await api("GET", "/api/templates");
      acts.value = await api("GET", "/api/activities");
      if (!gen.final_id && finals.value[0]) gen.final_id = finals.value[0].id;
      if (!tt.final_id && finals.value[0]) tt.final_id = finals.value[0].id;
      if (!act.final_id && finals.value[0]) act.final_id = finals.value[0].id;
    };
    onMounted(() => { load(); timer = setInterval(() => { if (list.value.some((t) => t.status === "generating")) load(); }, 2000); });
    onUnmounted(() => clearInterval(timer));
    const generate = async () => { await call(() => api("POST", "/api/templates", gen), "模板生成中"); load(); };
    const review = async (t, ok) => { const reason = ok ? "" : prompt("不通过原因（必填）"); if (!ok && !reason) return; await call(() => api("POST", `/api/templates/${t.id}/review`, { ok, reason }), "已审核"); load(); };
    const showTrial = async (r) => {
      if (!r.ok) { toast((await r.json()).message, true); return; }
      const h = r.headers.get("X-Tryon-Info"); trialInfo.value = h ? JSON.parse(decodeURIComponent(h)) : null;
      trialImg.value = URL.createObjectURL(await r.blob());
    };
    const trial = async (t, files) => { const fd = new FormData(); fd.append("photo", files[0]); toast("试跑中，约 30–90 秒…"); await showTrial(await fetch(`/api/templates/${t.id}/trial`, { method: "POST", body: fd, credentials: "same-origin" })); };
    const tryonTrial = async (files) => {
      if (!files[0]) return; tt.busy = true;
      try { const fd = new FormData(); fd.append("photo", files[0]); fd.append("mode", tt.mode); fd.append("final_id", tt.final_id); fd.append("scene", tt.scene);
        await showTrial(await fetch(`/api/tryon/trial`, { method: "POST", body: fd, credentials: "same-origin" })); } finally { tt.busy = false; }
    };
    const actOk = computed(() => act.name && act.end && (act.mode === "swap" ? act.template_ids.length : act.final_id));
    const createAct = async () => { await call(() => api("POST", "/api/activities", act), "活动已上线"); act.show = false; load(); };
    const toggle = async (a) => { await call(() => api("PATCH", `/api/activities/${a.id}`, { status: a.status === "online" ? "offline" : "online" })); load(); };
    const showSamples = async (a) => { samples.value = await call(() => api("GET", `/api/activities/${a.id}/samples`)); };
    const shown = computed(() => list.value.filter((t) => filter.value === "all" || t.status === filter.value));
    const STATUS = { generating: ["生成中", "L2"], pending: ["待审核", "st-wait"], approved: ["专家通过", "st-ok"], rejected: ["专家不通过", "st-doubt"], online: ["已上线", "st-ok"], offline: ["已下线", "st-wait"], failed: ["生成失败", "st-doubt"] };
    const isOps = computed(() => ["ops", "tech"].includes(G.me.role)), isExpert = computed(() => ["expert", "lead"].includes(G.me.role));
    const mlink = (a) => location.origin + "/m/" + a.token;
    return { finals, list, acts, filter, trialImg, trialInfo, samples, gen, act, tt, MODES, actOk, generate, review, trial, tryonTrial, createAct, toggle, showSamples, shown, STATUS, isOps, isExpert, mlink, img, fmtTime, G };
  },
  template: `<div class="full">
   <div class="head"><div><h2>观众换装与合拍</h2><p>三种玩法：真换装（观众自己的照片穿上复原服饰）、模板合影（换脸进专家审定的模板）、本人穿礼服（自拍生成古装照）。提示词由定稿所依据的规格书自动生成，出图后自动质检，不合格自动重试或切换备用模型。</p></div></div>
   <section class="card" v-if="isOps&&finals.length"><h2>换装试跑 <span class="small muted">上线前用测试照片检查效果</span></h2>
    <div class="formrow"><label class="f">定稿服饰<select v-model="tt.final_id"><option v-for="f in finals" :key="f.id" :value="f.id">{{f.asset_no}} {{f.project}}</option></select></label>
     <label class="f">玩法<select v-model="tt.mode"><option value="tryon">{{MODES.tryon}}</option><option value="portrait">{{MODES.portrait}}</option></select></label>
     <label class="f" v-if="tt.mode==='portrait'">场景<input v-model="tt.scene" placeholder="江南园林的月洞门前，身旁有梅花与竹子"></label>
     <label class="btn pri" :class="{disabled:tt.busy}">{{tt.busy?'生成中…':'上传测试照片并试跑'}}<input type="file" accept="image/*" hidden :disabled="tt.busy" @change="tryonTrial($event.target.files)"></label></div>
    <p class="small muted">真换装请用全身或半身照；本人穿礼服请用正脸照。试跑结果带“试跑”水印，并显示所用模型、质检分和每次尝试。</p></section>
   <div style="display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px;align-items:start">
    <section class="card" style="display:grid;gap:10px" v-if="isOps"><h2>生成模板</h2>
     <div class="empty" v-if="!finals.length">没有可用的定稿：只有授权为“可对外展示”及以上、且已生效的定稿可以生成模板。</div>
     <template v-else><label class="f">定稿服饰<select v-model="gen.final_id"><option v-for="f in finals" :key="f.id" :value="f.id">{{f.asset_no}} {{f.project}}（{{f.license}}）</option></select></label>
      <label class="f">虚拟模特<div class="seg"><button v-for="x in ['女','男','儿童']" :key="x" :class="{on:gen.gender===x}" @click="gen.gender=x">{{x}}</button></div></label>
      <label class="f">姿势<div class="seg"><button v-for="x in ['站姿正面','微侧','坐姿']" :key="x" :class="{on:gen.pose===x}" @click="gen.pose=x">{{x}}</button></div></label>
      <label class="f">背景<div class="seg"><button v-for="x in ['展厅','明代室内','纯色']" :key="x" :class="{on:gen.bg===x}" @click="gen.bg=x">{{x}}</button></div></label>
      <p class="small muted">模板要求：脸部正对或微侧、无遮挡；服装完整入画；不含文字。不使用任何真实人物形象。</p><button class="btn pri" @click="generate">生成 {{gen.count}} 张模板</button></template></section>
    <section class="card" v-else><h2>审核说明</h2><p class="small muted">请把模板与定稿图并排比对：服装颜色、霞帔、坠子、内袍是否走样。不通过须写明原因。</p></section>
    <section class="card"><h2>模板（{{list.length}}）<span class="sp"></span><div class="seg"><button v-for="(v,k) in {all:'全部',pending:'待审核',approved:'已通过',online:'已上线',rejected:'不通过'}" :key="k" :class="{on:filter===k}" @click="filter=k">{{v}}</button></div></h2>
     <div class="empty" v-if="!shown.length">暂无模板</div>
     <div class="grid3"><div class="shot" v-for="t in shown" :key="t.id"><div class="im" style="display:grid;grid-template-columns:1fr 1fr">
       <img v-if="t.file_id" :src="img(t.file_id)"><div v-else class="fake-img">{{STATUS[t.status][0]}}</div><img v-if="t.final_file" :src="img(t.final_file)" style="opacity:.85" title="定稿图（比对用）"><span class="mock-flag" v-if="t.mock">模拟</span></div>
      <div class="meta"><b>{{t.bg}} · {{t.pose}} · {{t.gender}}</b><div class="row"><span class="tag" :class="STATUS[t.status][1]">{{STATUS[t.status][0]}}</span><span class="small muted" v-if="t.uses">合拍 {{t.uses}} 次 · 成功率 {{t.success}}%</span></div>
       <div class="small muted" v-if="t.review">{{t.review.by}}：{{t.review.ok?'通过':t.review.reason}}</div><div class="small" style="color:var(--bad)" v-if="t.error">{{t.error}}</div>
       <div class="row" v-if="isExpert&&['pending','approved','rejected'].includes(t.status)"><button class="btn sm ok" @click="review(t,true)">通过</button><button class="btn sm warn" @click="review(t,false)">不通过</button></div>
       <div class="row" v-if="isOps&&t.file_id"><label class="btn sm">换脸试跑<input type="file" accept="image/*" hidden @change="trial(t,$event.target.files)"></label></div></div></div></div></section></div>
   <section class="card"><h2>合拍活动 <span class="sp"></span><button class="btn pri" v-if="G.me.role==='ops'" @click="act.show=true">＋ 新建活动</button></h2>
    <div class="empty" v-if="!acts.length">还没有活动</div>
    <div v-for="a in acts" :key="a.id" style="display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:16px;align-items:center;padding:10px 0;border-top:1px solid var(--line)">
     <div><h3>{{a.name}} <span class="tag L2">{{a.mode_name||'模板合影'}}</span> <span class="tag" :class="a.status==='online'?'st-ok':'st-wait'">{{a.status==='online'?'进行中':'已下线'}}</span></h3>
      <div class="grid4"><div><div class="small muted">起止</div><b>{{a.start}} 至 {{a.end}}</b></div><div><div class="small muted">每日上限</div><b>{{a.daily_limit}} 次</b></div><div><div class="small muted">今日 / 累计</div><b>{{a.today}} / {{a.total}} 次 · 成功率 {{a.success??'—'}}%</b></div><div><div class="small muted">平均用时 / 保存率</div><b>{{a.avg_seconds??'—'}} 秒 · {{a.saved??'—'}}%</b></div></div>
      <div class="small muted" style="margin-top:4px">平均质检分 {{a.avg_qc??'—'}} · 降级出图 {{a.degraded||0}} 张 · 累计成本 ¥{{a.cost||0}}<span v-if="a.models&&Object.keys(a.models).length"> · 出图模型：{{Object.entries(a.models).map(([k,v])=>k+' '+v).join('，')}}</span></div>
      <div class="row" style="margin-top:8px"><a class="small" :href="mlink(a)" target="_blank">{{mlink(a)}}</a><span class="sp"></span><button class="btn sm" @click="showSamples(a)">抽检结果（不含自拍原图）</button><button class="btn sm" :class="a.status==='online'?'warn':''" v-if="G.me.role==='ops'" @click="toggle(a)">{{a.status==='online'?'下线':'重新上线'}}</button></div></div>
     <div style="text-align:center"><img :src="'/api/activities/'+a.id+'/qr.svg'" style="width:150px"><div class="small muted">展板二维码</div></div></div></section>
   <div class="modal-bg" v-if="act.show" @click.self="act.show=false"><div class="modal"><h2>新建合拍活动</h2>
    <div class="grid2"><label class="f">活动名称<input v-model="act.name"></label><label class="f">展厅<input v-model="act.hall"></label><label class="f">开始日期<input type="date" v-model="act.start"></label><label class="f">结束日期<input type="date" v-model="act.end"></label>
     <label class="f">每日上限<input type="number" v-model.number="act.daily_limit"></label><label class="f">玩法<select v-model="act.mode"><option v-for="(n,k) in MODES" :key="k" :value="k">{{n}}</option></select></label></div>
    <template v-if="act.mode==='swap'"><div class="small muted">选择已通过审核的模板</div><div class="row"><label v-for="t in list.filter(t=>['approved','online'].includes(t.status))" :key="t.id" style="width:90px" class="small"><img :src="img(t.file_id)" style="width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:6px"><input type="checkbox" :value="t.id" v-model="act.template_ids">{{t.pose}}</label></div></template>
    <template v-else><label class="f">定稿服饰<select v-model="act.final_id"><option v-for="f in finals" :key="f.id" :value="f.id">{{f.asset_no}} {{f.project}}（{{f.license}}）</option></select></label>
     <label class="f" v-if="act.mode==='portrait'">场景<input v-model="act.scene" placeholder="江南园林的月洞门前，身旁有梅花与竹子（避免宫殿、城楼）"></label></template>
    <div class="row"><span class="sp"></span><button class="btn" @click="act.show=false">取消</button><button class="btn pri" :disabled="!actOk" @click="createAct">上线</button></div></div></div>
   <div class="modal-bg" v-if="trialImg" @click.self="trialImg=null"><div class="modal"><h2>试跑结果</h2><img :src="trialImg" style="max-height:62vh;object-fit:contain">
    <div class="small" v-if="trialInfo"><b>{{trialInfo.model_name}}</b> · 质检 {{trialInfo.qc_score??'未质检'}} 分<span v-if="trialInfo.degraded" style="color:var(--bad)">（未达标，降级出图）</span> · 用时 {{trialInfo.seconds}} 秒 · 提示词 {{trialInfo.prompt_version}}
     <div class="muted" v-if="trialInfo.qc_failed&&trialInfo.qc_failed.length">不符合项：{{trialInfo.qc_failed.join('；')}}</div>
     <div class="muted">尝试：{{trialInfo.attempts.map(a=>a.model+'#'+a.try+' '+(a.error?('失败 '+a.error):((a.seconds||0)+'秒 质检'+(a.qc??'—')))).join(' → ')}}</div></div>
    <div class="row"><span class="sp"></span><button class="btn" @click="trialImg=null;trialInfo=null">关闭</button></div></div></div>
   <div class="modal-bg" v-if="samples" @click.self="samples=null"><div class="modal"><h2>抽检合拍结果（最近 24 张）</h2><div class="grid4"><figure v-for="s in samples" :key="s.id" style="margin:0"><img :src="img(s.result)" style="width:100%;border-radius:6px"><figcaption class="small muted">{{s.model||''}} · 质检 {{s.qc??'—'}}<span v-if="s.degraded" style="color:var(--bad)"> 降级</span></figcaption></figure></div><div class="empty" v-if="!samples.length">暂无</div><div class="row"><span class="sp"></span><button class="btn" @click="samples=null">关闭</button></div></div></div>
  </div>`,
};

/* ------------------------------------------------------------ P11 */
const SettingsPage = {
  setup() {
    const tab = ref(G.me.role === "tech" ? "models" : "audit"), users = ref([]), models = ref([]), wl = ref([]), tpls = ref([]), logs = ref([]), test = reactive({});
    const pol = ref(null);
    const nu = reactive({ username: "", name: "", role: "expert", password: "", org: "" }), keys = reactive({}), nw = reactive({ name: "", level: "省级及重点馆", domain: "", method: "网页", license: "仅研究" });
    const load = async () => {
      users.value = await api("GET", "/api/users");
      if (["tech", "ops"].includes(G.me.role)) { models.value = await api("GET", "/api/settings/models"); pol.value = await api("GET", "/api/settings/tryon-policy"); }
      wl.value = await api("GET", "/api/settings/whitelist");
      tpls.value = await api("GET", "/api/review-templates");
      if (["tech", "lead", "ops"].includes(G.me.role)) logs.value = await api("GET", "/api/settings/audit");
    };
    onMounted(load);
    const isTech = computed(() => G.me.role === "tech");
    const addUser = async () => { await call(() => api("POST", "/api/users", nu), "已添加成员"); Object.assign(nu, { username: "", name: "", password: "" }); load(); G.users = await api("GET", "/api/users"); };
    const patchUser = async (u, ch) => { await call(() => api("PATCH", `/api/users/${u.id}`, ch), "已更新"); load(); };
    const resetPw = async (u) => { const pw = prompt("新密码（至少 8 位）"); if (pw) patchUser(u, { password: pw }); };
    const savePol = async () => { const p = pol.value.policy; await call(() => api("PUT", "/api/settings/tryon-policy", { tryon_chain: p.tryon_chain.filter(Boolean), swap_chain: p.swap_chain.filter(Boolean), portrait_chain: p.portrait_chain.filter(Boolean), template_model: p.template_model, qc: p.qc, qc_pass: +p.qc_pass, qc_floor: +p.qc_floor, tries_per_model: +p.tries_per_model, deadline: +p.deadline }), "换装策略已保存"); load(); };
    const saveModel = async (m) => { const body = { enabled: m.enabled, endpoint: m.endpoint, model: m.model, concurrency: +m.concurrency, timeout: +m.timeout, cross_border: m.cross_border, price: m.price === "" || m.price == null ? null : +m.price }; if (keys[m.id]) body.key = keys[m.id]; await call(() => api("PATCH", `/api/settings/models/${m.id}`, body), "已保存"); keys[m.id] = ""; load(); };
    const testModel = async (m) => { test[m.id] = { message: "测试中…" }; test[m.id] = await api("POST", `/api/settings/models/${m.id}/test`); };
    const addWl = async () => { await call(() => api("POST", "/api/settings/whitelist", nw), "已添加"); Object.assign(nw, { name: "", domain: "" }); load(); };
    const toggleWl = async (w) => { await call(() => api("PATCH", `/api/settings/whitelist/${w.id}`, { name: w.name, level: w.level, domain: w.domain, method: w.method, license: w.license, enabled: !w.enabled })); load(); };
    const ROLES = { expert: "评审专家", lead: "主审专家", ops: "咪咕运营", tech: "咪咕技术" };
    const PURPOSE = { generate: "复原生成", vision: "读图 / 预评", fusion: "换装策略入口", tryon: "观众换装", qc: "换装质检" };
    return { tab, users, models, wl, tpls, logs, test, nu, keys, nw, pol, isTech, addUser, patchUser, resetPw, saveModel, savePol, testModel, addWl, toggleWl, ROLES, PURPOSE, fmtTime, G };
  },
  template: `<div class="full">
   <div class="head"><div><h2>系统设置</h2><p>技术人员维护成员、模型与白名单；主审维护评审模板（在专家评审页）。所有修改进入审计日志。</p></div></div>
   <div class="seg"><button v-for="(n,k) in {members:'成员与角色',models:'模型接入',policy:'换装策略',whitelist:'检索白名单',templates:'评审模板',audit:'审计日志'}" :key="k" v-show="!['models','policy'].includes(k)||['tech','ops'].includes(G.me.role)" :class="{on:tab===k}" @click="tab=k">{{n}}</button></div>
   <section class="card" v-if="tab==='members'"><table><thead><tr><th>姓名</th><th>账号</th><th>单位</th><th>角色</th><th>状态</th><th v-if="isTech"></th></tr></thead><tbody>
    <tr v-for="u in users" :key="u.id"><td><b>{{u.name}}</b></td><td class="mono">{{u.username}}</td><td>{{u.org}}</td>
     <td><select v-if="isTech" class="input" :value="u.role" @change="patchUser(u,{role:$event.target.value})"><option v-for="(n,k) in ROLES" :value="k">{{n}}</option></select><span v-else>{{u.role_name}}</span></td>
     <td><span class="tag" :class="u.active?'st-ok':'st-wait'">{{u.active?'正常':'已停用'}}</span></td>
     <td v-if="isTech"><button class="btn sm" @click="patchUser(u,{active:!u.active})">{{u.active?'停用':'启用'}}</button> <button class="btn sm" @click="resetPw(u)">重置密码</button></td></tr></tbody></table>
    <div class="formrow" style="margin-top:12px" v-if="isTech"><input class="input" v-model="nu.name" placeholder="姓名"><input class="input" v-model="nu.username" placeholder="登录账号"><input class="input" v-model="nu.org" placeholder="单位">
     <select class="input" v-model="nu.role"><option v-for="(n,k) in ROLES" :value="k">{{n}}</option></select><input class="input" type="password" v-model="nu.password" placeholder="初始密码（≥8 位）"><button class="btn pri" :disabled="!nu.name||!nu.username||nu.password.length<8" @click="addUser">邀请成员</button></div></section>
   <section class="card" style="padding:0;overflow:auto" v-if="tab==='models'"><table><thead><tr><th>模型</th><th>接口</th><th>模型名</th><th>密钥</th><th>并发 / 超时</th><th>单价（元/张）</th><th>用量</th><th>出境</th><th>启用</th><th></th></tr></thead><tbody>
    <tr v-for="m in models" :key="m.id"><td><b>{{m.name}}</b><div class="small muted">{{PURPOSE[m.purpose]||m.purpose}} · <span class="mono">{{m.code}}</span></div></td>
     <td><input class="input" v-model="m.endpoint" :disabled="!isTech" style="width:220px"></td><td><input class="input" v-model="m.model" :disabled="!isTech" style="width:200px"></td>
     <td><span class="mono">{{m.key_tail||'未配置'}}</span><input v-if="isTech&&m.kind!=='comfyui'&&m.kind!=='edit_model'" class="input" type="password" v-model="keys[m.id]" placeholder="填写新密钥" style="width:140px"></td>
     <td><input class="input" style="width:50px" v-model="m.concurrency" :disabled="!isTech"> / <input class="input" style="width:60px" v-model="m.timeout" :disabled="!isTech"> 秒</td><td><input class="input" style="width:64px" v-model="m.price" :disabled="!isTech" placeholder="—"></td><td>{{m.used||0}}</td>
     <td><input type="checkbox" v-model="m.cross_border" :disabled="!isTech"></td><td><input type="checkbox" v-model="m.enabled" :disabled="!isTech"></td>
     <td v-if="isTech"><button class="btn sm pri" @click="saveModel(m)">保存</button> <button class="btn sm" @click="testModel(m)">连通测试</button><div class="small" v-if="test[m.id]" :style="{color:test[m.id].ok===false?'var(--bad)':'var(--ok)'}">{{test[m.id].message}}</div></td></tr></tbody></table>
    <p class="small muted" style="padding:10px 14px">密钥加密保存，页面与接口只显示后 4 位。火山方舟、阿里云百炼填 API Key；即梦（火山视觉智能）填 “AccessKeyID:SecretAccessKey”。单价按账单填写，用于活动成本统计。</p></section>
   <section class="card" v-if="tab==='policy'&&pol"><h2>换装策略 <span class="small muted">提示词版本 {{pol.prompt_version}}</span></h2>
    <p class="small muted">每种玩法按顺序尝试模型：接口出错立即换下一个；质检不合格先换种子重试，仍不合格换下一个；全部不合格时，最好一张达到“兜底分”才返回，否则提示观众稍后再试。</p>
    <table><thead><tr><th>玩法</th><th>首选</th><th>备用 1</th><th>备用 2</th></tr></thead><tbody>
     <tr v-for="k in ['tryon','swap','portrait']" :key="k"><td><b>{{pol.modes[k]}}</b></td>
      <td v-for="i in 3" :key="i"><select class="input" v-model="pol.policy[k+'_chain'][i-1]" :disabled="!isTech"><option :value="undefined">—</option><option v-for="m in pol.models" :key="m.code" :value="m.code">{{m.name}}{{m.has_key?'':'（未配置密钥）'}}{{m.enabled?'':'（已停用）'}}</option></select></td></tr></tbody></table>
    <div class="formrow" style="margin-top:10px"><label class="f">模板生成模型<select v-model="pol.policy.template_model" :disabled="!isTech"><option v-for="m in pol.models" :key="m.code" :value="m.code">{{m.name}}</option></select></label>
     <label class="chip"><input type="checkbox" v-model="pol.policy.qc" :disabled="!isTech"> 出图自动质检</label>
     <label class="f">合格分<input class="input" type="number" style="width:70px" v-model="pol.policy.qc_pass" :disabled="!isTech"></label>
     <label class="f">兜底分<input class="input" type="number" style="width:70px" v-model="pol.policy.qc_floor" :disabled="!isTech"></label>
     <label class="f">每模型尝试次数<input class="input" type="number" style="width:60px" v-model="pol.policy.tries_per_model" :disabled="!isTech"></label>
     <label class="f">单次总时长上限（秒）<input class="input" type="number" style="width:70px" v-model="pol.policy.deadline" :disabled="!isTech"></label>
     <button class="btn pri" v-if="isTech" @click="savePol">保存策略</button></div></section>
   <section class="card" v-if="tab==='whitelist'"><table><thead><tr><th>博物馆</th><th>级别</th><th>域名</th><th>检索方式</th><th>默认许可</th><th>启用</th></tr></thead><tbody>
    <tr v-for="w in wl" :key="w.id"><td>{{w.name}}</td><td><span class="tag" :class="w.level==='国家级'?'L1':w.level==='海外'?'L3':'L2'">{{w.level}}</span></td><td class="mono">{{w.domain}}</td><td>{{w.method}}</td><td>{{w.license}}</td>
     <td><button class="btn sm" :disabled="!isTech" @click="toggleWl(w)">{{w.enabled?'✓ 启用':'已停用'}}</button></td></tr></tbody></table>
    <div class="formrow" style="margin-top:12px" v-if="isTech"><input class="input" v-model="nw.name" placeholder="博物馆名称"><select class="input" v-model="nw.level"><option>国家级</option><option>省级及重点馆</option><option>海外</option></select>
     <input class="input" v-model="nw.domain" placeholder="域名，如 sxhm.com"><select class="input" v-model="nw.license"><option>仅研究</option><option>按藏品</option></select><button class="btn pri" :disabled="!nw.name||!nw.domain" @click="addWl">添加</button></div></section>
   <section class="card" v-if="tab==='templates'"><div v-for="t in tpls" :key="t.id" style="padding:6px 0;border-top:1px solid var(--line)"><b>{{t.name}} v{{t.version}}</b> <span class="tag st-wait" v-if="t.locked">已用于评审，锁定</span><div class="small muted">{{t.dims.map(d=>d.code+' '+d.name+'（权重'+d.weight+'，0–'+d.scale+'）').join('；')}}</div></div></section>
   <section class="card" v-if="tab==='audit'"><table><thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>修改前 → 修改后</th></tr></thead><tbody>
    <tr v-for="l in logs" :key="l.id"><td class="small">{{fmtTime(l.at)}}</td><td>{{l.user}}</td><td>{{l.action}}</td><td>{{l.object}}</td><td class="small muted" style="max-width:420px">{{l.before?JSON.stringify(l.before):''}} {{l.after?('→ '+JSON.stringify(l.after)):''}}</td></tr></tbody></table></section>
  </div>`,
};
