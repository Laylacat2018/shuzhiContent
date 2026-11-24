/* 公共：接口调用、全局状态、格式化 */
const { reactive, ref, computed, watch, onMounted, onUnmounted } = Vue;

const G = reactive({ me: null, users: [], project: null, toast: null, route: { name: "projects", pid: null, tab: null } });

function toast(msg, err) {
  G.toast = { msg, err };
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (G.toast = null), err ? 5000 : 2600);
}

async function api(method, url, body, form) {
  const opt = { method, credentials: "same-origin", headers: {} };
  if (form) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json();
  if (!r.ok) {
    if (r.status === 401 && G.me) { G.me = null; }
    const msg = (data && (data.message || data.detail)) || `请求失败（${r.status}）`;
    const e = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    e.status = r.status; e.data = data;
    throw e;
  }
  return data;
}

async function call(fn, okMsg) {
  try { const v = await fn(); if (okMsg) toast(okMsg); return v; }
  catch (e) { toast(e.message, true); throw e; }
}

const img = (fid) => (fid ? `/api/files/${fid}` : "");
const fmtTime = (t) => (t ? new Date(t * 1000).toLocaleString("zh-CN", { hour12: false }) : "—");
const LEVELS = { L1: "L1 实测", L2: "L2 史料有载", L3: "L3 同类推定", L4: "L4 推测", miss: "缺失", rule: "规则" };
const FSTATUS = { pending: ["待审", "st-wait"], checked: ["已校对", "st-ok"], dispute: ["有异议", "st-doubt"], need: ["需补证", "st-need"] };
const STEPS = [["史料汇集", "sources", 1], ["形制规格书", "spec", 1], ["AI 生成", "generate", 0], ["专家评审", "review", 1], ["对比选择", "compare", 0], ["修订 V2", "revise", 0], ["定稿存证", "final", 1]];
const STAGE = { draft: "生成初稿", revise: "修订重生成", apply: "展示应用", experiment: "实验" };
const VIEW = { front: "正面", side: "侧面", back: "背面" };
const MODELS = { nb2: "Nano Banana", sd: "Seedream", gpt: "GPT Image", qwen: "Qwen 本地" };
const userName = (id) => (G.users.find((u) => u.id === id) || {}).name || "—";
function go(hash) { location.hash = hash; }
