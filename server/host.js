/* 服务端引擎宿主：在 V8（mini-racer）中运行与前端同一份业务引擎（geometry.js + engine.js），
 * 管理多个工作区（每个工作区一份独立状态），并收集事件供 WebSocket 推送。
 * 由 server/engine_host.py 加载；所有调用都经 Python 侧的互斥锁串行执行。
 */
var console = { log: function () {}, warn: function () {}, error: function () {} };
var HOST = { ws: {}, events: {}, seq: {}, rev: {}, cur: null };

Engine.on(function (ev) {
  var id = HOST.cur; if (!id) return;
  var q = HOST.events[id] || (HOST.events[id] = []);
  HOST.seq[id] = (HOST.seq[id] || 0) + 1;
  q.push({ seq: HOST.seq[id], type: ev.type, payload: ev.payload, t: ev.t });
  if (q.length > 500) q.splice(0, q.length - 500);
});

function hostUse(id, uid, pid) {
  var S = HOST.ws[id]; if (!S) throw new Error('工作区不存在：' + id);
  HOST.cur = id; Engine.S = S;
  if (uid) S.currentUserId = uid;
  if (pid && S.projects.some(function (p) { return p.id === pid; })) S.currentProjectId = pid;
  return S;
}
function bump(id) { HOST.rev[id] = (HOST.rev[id] || 0) + 1; }

function hostCreate(id) {
  HOST.cur = id;
  if (HOST.production) Engine.productionInit(); else Engine.init({ fresh: true });
  HOST.ws[id] = Engine.S; bump(id);
  return id;
}

/* 断电 / 重启恢复：运行中任务回到排队，GPU 视为空载，正在开机的云节点重新开机 */
function hostLoad(id, json) {
  var S = JSON.parse(json); var n = 0;
  if (!!HOST.production !== !!(S.runtime && S.runtime.mode === 'production')) throw new Error('运行模式与数据不一致，请使用独立 SCW_DATA 目录');
  S.tasks.forEach(function (t) { if (t.status === 'running') { t.status = 'queued'; t.elapsed = 0; t.progress = 0; t._oomChecked = false; (t.log = t.log || []).push('[恢复] 服务重启，运行中任务已回到排队'); n++; } });
  S.gpu.loaded = null; S.gpu.swapping = null; S.gpu.viewportOpen = false;
  S.cloudNodes.forEach(function (c) { if (c.state !== 'off') { c.state = 'booting'; c.boot = 60; c.task = null; } });
  S.clock = Math.max(S.clock, Date.now());
  (S.scenes || []).forEach(function (sc) { sc.agentQueue = sc.agentQueue || []; });
  HOST.ws[id] = S; bump(id);
  return n;
}

function hostCall(id, uid, pid, fn, argsJson) {
  try {
    hostUse(id, uid, pid);
    var f = Engine[fn]; if (typeof f !== 'function') throw new Engine.BizError('未知操作：' + fn, 'bad_request');
    var r = f.apply(Engine, JSON.parse(argsJson || '[]'));
    bump(id);
    return JSON.stringify({ ok: true, result: r === undefined ? null : r });
  } catch (e) {
    bump(id);
    return JSON.stringify({ ok: false, error: e.message, code: e.code || 'error' });
  }
}

/* 只读查询：执行任意引擎读函数并返回结果（不修改 rev） */
function hostRead(id, uid, pid, fn, argsJson) {
  try {
    hostUse(id, uid, pid);
    var r = Engine[fn].apply(Engine, JSON.parse(argsJson || '[]'));
    return JSON.stringify({ ok: true, result: r === undefined ? null : r });
  } catch (e) { return JSON.stringify({ ok: false, error: e.message, code: e.code || 'error' }); }
}

/* 在工作区上下文中执行一段表达式（仅供 REST 层组合查询使用，不对外暴露） */
function hostEval(id, uid, pid, src) {
  try { hostUse(id, uid, pid); var r = (new Function('E', 'return (' + src + ')'))(Engine); return JSON.stringify({ ok: true, result: r === undefined ? null : r }); }
  catch (e) { return JSON.stringify({ ok: false, error: e.message, code: e.code || 'error' }); }
}

function hostTick(ms) {
  Object.keys(HOST.ws).forEach(function (id) { HOST.cur = id; Engine.S = HOST.ws[id]; Engine.tick(ms); bump(id); });
  return true;
}
function hostState(id) { return JSON.stringify(HOST.ws[id]); }
function hostRev(id) { return HOST.rev[id] || 0; }
function hostEvents(id, since) { var q = HOST.events[id] || []; return JSON.stringify(q.filter(function (e) { return e.seq > since; })); }
function hostList() { return JSON.stringify(Object.keys(HOST.ws)); }
function hostReset(id) { delete HOST.ws[id]; HOST.events[id] = []; return hostCreate(id); }
