/* 自部署适配层：在 claude.ai 之外，用本站 /api 提供页面需要的 db 与 assets 能力。
   页面原代码不变：window.claude.use("db" | "assets") 返回同样的接口；"sample"（AI 专家）不可用。 */
(function () {
  if (window.claude && window.claude.use) return;
  var POLL_MS = 4000;
  var listeners = [];

  function api(method, path, body, type) {
    var opt = { method: method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      if (type) { opt.headers["Content-Type"] = type; opt.body = body; }
      else { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    }
    return fetch("api" + path, opt).then(function (r) {
      if (r.status === 404 && method === "GET") return null;
      if (!r.ok) throw { code: "http_" + r.status, message: "服务器返回 " + r.status };
      return r.status === 204 ? null : r.json();
    });
  }
  function split(path) {
    var p = String(path).split("/");
    if (p.length !== 2) throw { code: "bad_path", message: "只支持 集合/文档 两段路径" };
    return { col: p[0], id: p[1] };
  }
  function refresh() { listeners.forEach(function (l) { l(); }); }
  setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });

  function watch(fetcher, cb, err) {
    var last = null;
    var run = function () {
      fetcher().then(function (snap) {
        var key = JSON.stringify(snap.raw);
        if (key !== last) { last = key; cb(snap); }
      }).catch(function (e) { if (err) err(e); });
    };
    listeners.push(run); run();
    return function () { var i = listeners.indexOf(run); if (i >= 0) listeners.splice(i, 1); };
  }

  function docRef(path) {
    var p = split(path);
    var url = "/db/" + encodeURIComponent(p.col) + "/" + encodeURIComponent(p.id);
    var load = function () {
      return api("GET", url).then(function (d) {
        return { raw: d, exists: !!d, id: p.id, data: function () { return d ? JSON.parse(JSON.stringify(d)) : undefined; } };
      });
    };
    return {
      id: p.id,
      get: load,
      set: function (data) { return api("PUT", url, data).then(refresh); },
      delete: function () { return api("DELETE", url).then(refresh); },
      onSnapshot: function (cb, err) { return watch(load, cb, err); }
    };
  }

  function collectionRef(col, orderField) {
    var load = function () {
      return api("GET", "/db/" + encodeURIComponent(col)).then(function (list) {
        list = list || [];
        if (orderField) list.sort(function (a, b) {
          var x = a.data[orderField], y = b.data[orderField];
          return x === y ? 0 : (x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1);
        });
        return {
          raw: list,
          docs: list.map(function (d) { return { id: d.id, data: function () { return JSON.parse(JSON.stringify(d.data)); } }; })
        };
      });
    };
    return {
      orderBy: function (field) { return collectionRef(col, field); },
      doc: function (id) { return docRef(col + "/" + id); },
      onSnapshot: function (cb, err) { return watch(load, cb, err); }
    };
  }

  var db = { doc: docRef, collection: function (c) { return collectionRef(c, null); } };
  var assets = {
    upload: function (file) {
      return api("POST", "/assets", file, file.type || "application/octet-stream");
    }
  };

  window.claude = {
    use: function (name) {
      if (name === "db") return Promise.resolve(db);
      if (name === "assets") return Promise.resolve(assets);
      return Promise.reject({ code: "not_available", message: "自部署版本不提供 " + name });
    }
  };
})();
