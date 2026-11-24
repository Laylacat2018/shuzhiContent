/* 根组件：登录、头部、流程条、路由 */
const LoginPage = {
  setup() {
    const f = reactive({ username: "", password: "" }), err = ref("");
    const submit = async () => {
      try { G.me = await api("POST", "/api/login", f); G.users = await api("GET", "/api/users"); err.value = ""; }
      catch (e) { err.value = e.message; }
    };
    return { f, err, submit };
  },
  template: `<div class="login"><form class="card" @submit.prevent="submit">
    <h2 style="font-family:var(--f-display);font-size:22px">衣冠 · AI复原工作台</h2><p class="small muted">中国国家博物馆 × 咪咕</p>
    <label class="f">账号<input v-model="f.username" autocomplete="username"></label><label class="f">密码<input type="password" v-model="f.password" autocomplete="current-password"></label>
    <div class="alert" v-if="err">{{err}}</div><button class="btn pri" type="submit">登录</button></form></div>`,
};

function parseRoute() {
  const h = (location.hash || "#/projects").slice(2).split("/");
  if (h[0] === "p" && h[1]) return { name: "project", pid: h[1], tab: h[2] || "sources" };
  if (["templates", "settings", "projects"].includes(h[0])) return { name: h[0], pid: null, tab: null };
  return { name: "projects", pid: null, tab: null };
}

const App = {
  components: { LoginPage, ProjectsPage, SourcesPage, SpecPage, GeneratePage, ReviewPage, ComparePage, RevisePage, FinalPage, TemplatesPage, SettingsPage, RefPanel },
  setup() {
    const ready = ref(false), todoCount = ref(0);
    const sync = async () => {
      G.route = parseRoute();
      if (G.me && G.route.pid) {
        try { G.project = await api("GET", `/api/projects/${G.route.pid}`); }
        catch (e) { toast(e.message, true); go("#/projects"); }
      } else G.project = null;
    };
    const refreshTodos = async () => { if (G.me) todoCount.value = (await api("GET", "/api/todos")).length; };
    onMounted(async () => {
      try { G.me = await api("GET", "/api/me"); G.users = await api("GET", "/api/users"); } catch (e) { G.me = null; }
      await sync(); ready.value = true; refreshTodos();
      window.addEventListener("hashchange", async () => { await sync(); refreshTodos(); window.scrollTo(0, 0); });
    });
    watch(() => G.me, async (v, old) => { if (v && !old) { await sync(); refreshTodos(); } });
    const logout = async () => { await api("POST", "/api/logout"); G.me = null; };
    const pageOf = { sources: "SourcesPage", spec: "SpecPage", generate: "GeneratePage", review: "ReviewPage", compare: "ComparePage", revise: "RevisePage", final: "FinalPage" };
    const stepClass = (i) => {
      const p = G.project; if (!p) return "";
      const n = i + 1, on = STEPS[i][1] === G.route.tab;
      if (on) return "on";
      if (p.todos.some((t) => t.step === n)) return "todo";
      return p.steps.done[n] ? "done" : "";
    };
    return { G, ready, todoCount, logout, pageOf, stepClass, STEPS, go };
  },
  template: `<template v-if="ready">
   <LoginPage v-if="!G.me"/>
   <template v-else>
    <header class="top"><div class="top-in">
     <div class="brand"><h1 class="clickable" @click="go('#/projects')">衣冠 · AI复原工作台</h1>
      <span class="sub" v-if="G.project">{{G.project.name}} · {{G.project.museum}}</span><span class="sub" v-else>中国国家博物馆 × 咪咕</span>
      <span class="right"><span class="bell clickable" @click="go('#/projects')">待我处理<b>{{todoCount}}</b></span><span class="role">{{G.me.role_name}}</span><span class="avatar" :title="G.me.name">{{G.me.name.slice(0,1)}}</span><a style="color:#C9D6E3" @click="logout">退出</a></span></div>
     <nav class="steps" v-if="G.project"><a v-for="(s,i) in STEPS" :key="s[1]" :class="stepClass(i)" @click="go('#/p/'+G.project.id+'/'+s[1])"><span class="n">{{G.project.steps.done[i+1]&&STEPS[i][1]!==G.route.tab?'✓':i+1}}</span>{{s[0]}}<span class="ex" v-if="s[2]">专家</span></a></nav>
     <nav class="tabs" v-else><a :class="{on:G.route.name==='projects'}" @click="go('#/projects')">复原项目</a><a :class="{on:G.route.name==='templates'}" @click="go('#/templates')">合拍模板</a><a :class="{on:G.route.name==='settings'}" @click="go('#/settings')">系统设置</a></nav>
    </div></header>
    <div class="wrap" v-if="G.project && G.route.name==='project'"><RefPanel :pid="G.project.id" :key="G.project.id"/><component :is="pageOf[G.route.tab]" :pid="G.project.id" :key="G.route.tab+G.project.id"/></div>
    <ProjectsPage v-else-if="G.route.name==='projects'"/><TemplatesPage v-else-if="G.route.name==='templates'"/><SettingsPage v-else-if="G.route.name==='settings'"/>
   </template>
   <div class="toast" :class="{err:G.toast.err}" v-if="G.toast">{{G.toast.msg}}</div>
  </template>`,
};

Vue.createApp(App).mount("#app");
