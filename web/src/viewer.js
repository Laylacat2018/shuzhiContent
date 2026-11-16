/* 空间内容工场 · three.js 视口封装 */
(function (global) {
  'use strict';
  const T = global.THREE, Geo = global.Geo;
  const meshCache = new Map();
  function cachedMesh(spec, tris) {
    const key = [spec.category, spec.seed, tris, JSON.stringify(spec.defects || {})].join('|');
    if (meshCache.has(key)) { const m = meshCache.get(key); meshCache.delete(key); meshCache.set(key, m); return m; }
    const m = Geo.buildMesh(spec, tris); meshCache.set(key, m);
    if (meshCache.size > 40) meshCache.delete(meshCache.keys().next().value);
    return m;
  }
  const texCache = new Map();
  function cachedTexture(cat, seed, size) {
    const key = cat + '|' + seed + '|' + size;
    if (!texCache.has(key)) { const c = Geo.textureCanvas(cat, seed, size); const t = new T.CanvasTexture(c); t.encoding = T.sRGBEncoding; t.flipY = false; t.wrapS = T.RepeatWrapping; texCache.set(key, t); if (texCache.size > 40) { const k = texCache.keys().next().value; texCache.get(k).dispose(); texCache.delete(k); } }
    return texCache.get(key);
  }
  let checker = null;
  function checkerTex() {
    if (checker) return checker;
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) { x.fillStyle = (i + j) % 2 ? '#2c7a6b' : '#eef3f1'; x.fillRect(i * 16, j * 16, 16, 16); }
    x.fillStyle = '#a8732f'; x.font = 'bold 20px sans-serif'; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) x.fillText(String.fromCharCode(65 + i) + (j + 1), i * 64 + 18, j * 64 + 40);
    checker = new T.CanvasTexture(c); checker.flipY = false; return checker;
  }
  function toGeometry(m) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new T.BufferAttribute(m.normals, 3));
    g.setAttribute('uv', new T.BufferAttribute(m.uvs, 2));
    g.setIndex(new T.BufferAttribute(m.indices, 1));
    return g;
  }
  function attrColors(m, mode) {
    const n = m.verts, c = new Float32Array(n * 3);
    if (mode === 'metal' || mode === 'rough') { const k = mode === 'metal' ? 0 : 1; for (let i = 0; i < n; i++) { const v = m.mr[i * 2 + k]; c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = v; } }
    if (mode === 'issues') {
      for (let i = 0; i < n; i++) { c[i * 3] = 0.62; c[i * 3 + 1] = 0.66; c[i * 3 + 2] = 0.64; }
      for (let t = 0; t < m.flags.length; t++) if (m.flags[t]) for (let k = 0; k < 3; k++) { const vi = m.indices[t * 3 + k]; c[vi * 3] = m.flags[t] === 1 ? 0.92 : 0.98; c[vi * 3 + 1] = m.flags[t] === 1 ? 0.2 : 0.62; c[vi * 3 + 2] = m.flags[t] === 1 ? 0.18 : 0.1; }
    }
    return c;
  }
  function materialFor(m, mode, info) {
    const tex = info && info.texture ? cachedTexture(info.category, info.seed, Math.min(1024, info.texture)) : null;
    let avgM = 0, avgR = 0; for (let i = 0; i < m.verts; i += 7) { avgM += m.mr[i * 2]; avgR += m.mr[i * 2 + 1]; } const k = Math.ceil(m.verts / 7); avgM /= k; avgR /= k;
    switch (mode) {
      case 'wire': return new T.MeshBasicMaterial({ color: 0x2c7a6b, wireframe: true });
      case 'normal': return new T.MeshNormalMaterial();
      case 'basecolor': return tex ? new T.MeshBasicMaterial({ map: tex }) : new T.MeshBasicMaterial({ color: 0xbbbbbb });
      case 'metal': case 'rough': case 'issues': return new T.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.85 });
      case 'uv': return new T.MeshBasicMaterial({ map: checkerTex() });
      default: return tex ? new T.MeshStandardMaterial({ map: tex, metalness: avgM, roughness: avgR, envMapIntensity: 1 }) : new T.MeshStandardMaterial({ color: 0xb8bcb8, metalness: 0.1, roughness: 0.7 });
    }
  }
  function envMap(renderer) {
    // 程序化环境：天光 + 地面反光，供 PBR 金属读数
    const pmrem = new T.PMREMGenerator(renderer);
    const sc = new T.Scene();
    const geo = new T.SphereGeometry(10, 32, 16);
    const c = document.createElement('canvas'); c.width = 256; c.height = 128; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, '#dfe9ff'); g.addColorStop(0.48, '#fff6e6'); g.addColorStop(0.52, '#6b6157'); g.addColorStop(1, '#2a2622'); x.fillStyle = g; x.fillRect(0, 0, 256, 128);
    x.fillStyle = '#ffffff'; x.fillRect(40, 20, 60, 14); x.fillRect(160, 26, 40, 10);
    const t = new T.CanvasTexture(c); t.encoding = T.sRGBEncoding;
    sc.add(new T.Mesh(geo, new T.MeshBasicMaterial({ map: t, side: T.BackSide })));
    const rt = pmrem.fromScene(sc, 0.02); pmrem.dispose(); return rt.texture;
  }

  function Base(el, opts) {
    opts = opts || {};
    this.el = el; this.opts = opts;
    const w = el.clientWidth || 400, h = el.clientHeight || 300;
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, global.devicePixelRatio || 1));
    this.renderer.setSize(w, h); this.renderer.outputEncoding = T.sRGBEncoding; this.renderer.toneMapping = T.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    el.appendChild(this.renderer.domElement);
    this.scene = new T.Scene();
    this.scene.environment = envMap(this.renderer);
    this.camera = new T.PerspectiveCamera(opts.fov || 35, w / h, 0.01, 200);
    this.camera.position.set(1.4, 1.0, 1.8);
    this.controls = new T.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.scene.add(new T.HemisphereLight(0xffffff, 0x50463c, 0.55));
    const d = new T.DirectionalLight(0xfff1dd, 1.6); d.position.set(3, 5, 4); this.scene.add(d); this.key = d;
    const r = new T.DirectionalLight(0xbfd8ff, 0.5); r.position.set(-4, 2, -3); this.scene.add(r);
    if (opts.grid !== false) { const grid = new T.GridHelper(opts.gridSize || 4, opts.gridDiv || 20, 0x6c7a75, 0x9aa7a2); grid.material.opacity = 0.35; grid.material.transparent = true; this.scene.add(grid); this.grid = grid; }
    this.alive = true; this.onFrame = null;
    const loop = () => { if (!this.alive) return; this.raf = requestAnimationFrame(loop); if (this.onFrame) this.onFrame(); this.controls.update(); this.renderer.render(this.scene, this.camera); };
    loop();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(el);
  }
  Base.prototype.resize = function () { const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return; this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); };
  Base.prototype.dispose = function () { this.alive = false; cancelAnimationFrame(this.raf); this.ro.disconnect(); this.controls.dispose(); this.renderer.dispose(); if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement); };
  Base.prototype.frame = function (bbox, k) {
    const c = new T.Vector3((bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2);
    const s = Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]);
    this.controls.target.copy(c); this.camera.position.set(c.x + s * 1.3 * (k || 1), c.y + s * 0.7 * (k || 1), c.z + s * 1.7 * (k || 1)); this.camera.near = s / 100; this.camera.far = s * 60; this.camera.updateProjectionMatrix();
    this.home = { p: this.camera.position.clone(), t: c.clone(), size: s };
  };
  Base.prototype.reset = function () { if (!this.home) return; this.camera.position.copy(this.home.p); this.controls.target.copy(this.home.t); };
  Base.prototype.snapshot = function () { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); };

  // ---------- 单件资产视口 ----------
  function AssetViewer(el, opts) { Base.call(this, el, opts); this.mode = 'solid'; this.obj = null; }
  AssetViewer.prototype = Object.create(Base.prototype);
  AssetViewer.prototype.show = function (info, mode) {
    // info: {category, seed, tris, texture, defects}
    this.info = info; this.mode = mode || this.mode;
    if (info.file_url) { this.showFile(info, this.mode); return { tris: info.tris, verts: info.verts || 0 }; }
    const m = cachedMesh({ category: info.category, seed: info.seed, defects: info.defects || {} }, info.tris);
    this.meshData = m;
    if (this.obj) { this.scene.remove(this.obj); this.obj.geometry.dispose(); }
    const g = toGeometry(m);
    const mode2 = this.mode;
    if (['metal', 'rough', 'issues'].includes(mode2)) g.setAttribute('color', new T.BufferAttribute(attrColors(m, mode2), 3));
    this.obj = new T.Mesh(g, materialFor(m, mode2, info));
    this.scene.add(this.obj);
    if (!this.framed || this.framedKey !== info.category) { this.frame(m.bbox); this.framed = true; this.framedKey = info.category; }
    return m;
  };
  AssetViewer.prototype.showFile = function (info, mode) {
    if (this.fileUrl === info.file_url && this.realObject) { this.fileMode(mode); return; }
    this.fileUrl = info.file_url; const key = this.fileUrl;
    if (!T.GLTFLoader) throw new Error('GLTFLoader 未加载');
    const loader = new T.GLTFLoader();
    loader.load(key, gltf => {
      if (!this.alive || this.fileUrl !== key) return;
      if (this.obj) this.scene.remove(this.obj);
      if (this.realObject) { this.scene.remove(this.realObject); this.realObject.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
      this.realObject = gltf.scene; this.realObject.traverse(o => { if (o.isMesh) o.userData.originalMaterial = o.material; });
      this.scene.add(this.realObject); const b = new T.Box3().setFromObject(this.realObject);
      this.frame({ min: b.min.toArray(), max: b.max.toArray() }); this.fileMode(this.mode);
    }, undefined, e => { console.error('真实 GLB 加载失败', e); });
  };
  AssetViewer.prototype.fileMode = function (mode) {
    if (!this.realObject) return;
    this.realObject.traverse(o => {
      if (!o.isMesh) return;
      if (o.userData.modeMaterial) { o.userData.modeMaterial.dispose(); delete o.userData.modeMaterial; }
      const source = o.userData.originalMaterial;
      const m = Array.isArray(source) ? source[0] : source;
      let next;
      if (mode === 'wire') next = new T.MeshBasicMaterial({ color: 0x2c7a6b, wireframe: true });
      else if (mode === 'normal') next = new T.MeshNormalMaterial();
      else if (mode === 'uv') next = new T.MeshBasicMaterial({ map: checkerTex() });
      else if (mode === 'basecolor') next = new T.MeshBasicMaterial({ map: m.map, color: m.color });
      else if (mode === 'metal' || mode === 'rough') {
        const ch = mode === 'metal' ? 'b' : 'g'; const tex = mode === 'metal' ? m.metalnessMap : m.roughnessMap; const value = mode === 'metal' ? m.metalness : m.roughness;
        next = new T.ShaderMaterial({ uniforms: { channelMap: { value: tex }, factor: { value }, hasMap: { value: !!tex } }, vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}', fragmentShader: 'uniform sampler2D channelMap; uniform float factor; uniform bool hasMap; varying vec2 vUv; void main(){float v=factor;if(hasMap)v*=texture2D(channelMap,vUv).' + ch + ';gl_FragColor=vec4(vec3(v),1.0);}' });
      } else { o.material = source; return; }
      o.userData.modeMaterial = next; o.material = next;
    });
  };
  AssetViewer.prototype.setMode = function (mode) { if (this.info) this.show(this.info, mode); };

  // ---------- 场景组装视口 ----------
  function SceneViewer(el, opts) { Base.call(this, el, Object.assign({ gridSize: 12, gridDiv: 24, fov: 40 }, opts)); this.items = new Map(); this.camera.position.set(6, 4, 7); this.controls.target.set(0, 0.6, 0); this.selected = null; this.view = 'persp';
    const floor = new T.Mesh(new T.PlaneGeometry(12, 9), new T.MeshStandardMaterial({ color: 0x8f8a82, roughness: 0.9 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.001; this.scene.add(floor);
    const wall = new T.Mesh(new T.PlaneGeometry(12, 4), new T.MeshStandardMaterial({ color: 0xcfc6b8, roughness: 0.95 })); wall.position.set(0, 2, -4.5); this.scene.add(wall);
    this.ray = new T.Raycaster(); this.camHelper = null;
    this.renderer.domElement.addEventListener('pointerdown', (e) => { this._down = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (!this._down || Math.hypot(e.clientX - this._down[0], e.clientY - this._down[1]) > 4) return;
      const r = this.renderer.domElement.getBoundingClientRect(); const v = new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
      this.ray.setFromCamera(v, this.camera); const hits = this.ray.intersectObjects([...this.items.values()], true);
      const hit = hits[0] && [...this.items.entries()].find(([, o]) => { let p = hits[0].object; while (p) { if (p === o) return true; p = p.parent; } return false; });
      this.select(hit ? hit[0] : null); if (this.onSelect) this.onSelect(hit ? hit[0] : null);
    });
  }
  SceneViewer.prototype = Object.create(Base.prototype);
  SceneViewer.prototype.sync = function (sc, versionOf) {
    const seen = new Set();
    for (const it of sc.items) {
      seen.add(it.id);
      let o = this.items.get(it.id);
      if (!o) {
        const v = versionOf(it.version_id); if (!v) continue; const s = v.opt || v.raw;
        const m = cachedMesh({ category: v.category, seed: v.seed, defects: {} }, Math.min(s.tris, 6000));
        o = new T.Mesh(toGeometry(m), materialFor(m, 'solid', { category: v.category, seed: v.seed, texture: 256 }));
        o.userData.id = it.id; this.scene.add(o); this.items.set(it.id, o);
      }
      o.position.set(it.pos[0], it.pos[1], it.pos[2]); o.rotation.y = it.rotY || 0; o.scale.setScalar(it.scale || 1);
    }
    for (const [k, o] of this.items) if (!seen.has(k)) { this.scene.remove(o); o.geometry.dispose(); this.items.delete(k); }
    const L = (sc.lights || []).find(l => l.type === 'directional');
    if (L) { this.key.color.set(L.color); this.key.intensity = L.intensity; this.key.position.set(...(L.pos || [4, 6, 3])); } else { this.key.color.set(0xffffff); this.key.intensity = 0.9; }
    this.sceneCam = sc.camera;
    if (this.selected && !this.items.has(this.selected)) this.select(null);
  };
  SceneViewer.prototype.select = function (iid) {
    if (this.box) { this.scene.remove(this.box); this.box = null; }
    this.selected = iid; const o = iid && this.items.get(iid);
    if (o) { this.box = new T.BoxHelper(o, 0xd0902f); this.scene.add(this.box); }
  };
  SceneViewer.prototype.refreshBox = function () { if (this.box) this.box.update(); };
  SceneViewer.prototype.setView = function (v) {
    this.view = v;
    if (v === 'top') { this.camera.position.set(0.01, 12, 0.01); this.controls.target.set(0, 0, 0); }
    else if (v === 'main' && this.sceneCam) { this.camera.position.set(...this.sceneCam.pos); this.controls.target.set(...this.sceneCam.target); }
    else { this.camera.position.set(6, 4, 7); this.controls.target.set(0, 0.6, 0); }
  };
  SceneViewer.prototype.orbit = function (sec) {
    const t0 = performance.now(), r = 8, h = 3.2; const prev = this.onFrame;
    return new Promise(res => { this.onFrame = () => { const t = (performance.now() - t0) / 1000; const a = t / sec * Math.PI * 2; this.camera.position.set(Math.sin(a) * r, h, Math.cos(a) * r); this.controls.target.set(0, 0.6, 0); if (t > sec) { this.onFrame = prev; res(); } }; });
  };

  // ---------- 3DGS 点云视口 ----------
  function SplatViewer(el, opts) { Base.call(this, el, Object.assign({ gridSize: 12, fov: 50 }, opts)); this.camera.position.set(5, 3.5, 6); this.controls.target.set(0, 1, 0); this.pts = null; this.cams = null; }
  SplatViewer.prototype = Object.create(Base.prototype);
  SplatViewer.prototype.show = function (d, mode) {
    if (this.pts) { this.scene.remove(this.pts); this.pts.geometry.dispose(); }
    const n = mode === 'points' ? 25000 : 90000;
    const sp = Geo.buildSplats(Geo.hash(d.code || 'x'), n, d.floaters, d.cropped);
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(sp.positions, 3)); g.setAttribute('color', new T.BufferAttribute(sp.colors, 3));
    this.pts = new T.Points(g, new T.PointsMaterial({ size: mode === 'points' ? 0.025 : 0.06, vertexColors: true, sizeAttenuation: true, transparent: mode !== 'points', opacity: mode === 'points' ? 1 : 0.82, depthWrite: mode === 'points' }));
    this.scene.add(this.pts);
    if (this.cams) { this.scene.remove(this.cams); this.cams = null; }
    if (d.registered) {
      const grp = new T.Group(); const R = Geo.rng(d.registered); const k = Math.min(80, d.registered);
      for (let i = 0; i < k; i++) { const a = i / k * Math.PI * 2, r = 2.6 + R() * 0.8; const cam = new T.Mesh(new T.ConeGeometry(0.06, 0.12, 4), new T.MeshBasicMaterial({ color: 0xd0902f, wireframe: true })); cam.position.set(Math.cos(a) * r, 1.2 + R() * 1.2, Math.sin(a) * r * 0.8); cam.lookAt(0, 1, 0); cam.rotateX(Math.PI / 2); grp.add(cam); }
      this.scene.add(grp); this.cams = grp;
    }
    if (d.cropped) { if (!this.crop) { this.crop = new T.Box3Helper(new T.Box3(new T.Vector3(-4.6, -0.05, -3.6), new T.Vector3(4.6, 3.3, 3.6)), 0x2c7a6b); this.scene.add(this.crop); } } else if (this.crop) { this.scene.remove(this.crop); this.crop = null; }
    return sp.count;
  };

  // ---------- 全景查看器 ----------
  function PanoViewer(el) { Base.call(this, el, { grid: false, fov: 75 }); this.camera.position.set(0, 0, 0.01); this.controls.target.set(0, 0, 0); this.controls.enableZoom = false; this.controls.rotateSpeed = -0.35; this.sphere = null; }
  PanoViewer.prototype = Object.create(Base.prototype);
  PanoViewer.prototype.show = function (canvas) {
    if (this.sphere) { this.scene.remove(this.sphere); this.sphere.material.map.dispose(); }
    const t = new T.CanvasTexture(canvas); t.encoding = T.sRGBEncoding;
    this.sphere = new T.Mesh(new T.SphereGeometry(10, 64, 32), new T.MeshBasicMaterial({ map: t, side: T.BackSide }));
    this.sphere.scale.x = -1; this.sphere.rotation.y = Math.PI; // 接缝位于视线正前方，便于检查
    this.scene.add(this.sphere);
  };
  PanoViewer.prototype.lookAtSeam = function () { this.camera.position.set(0, 0, 0.01); this.controls.target.set(0, 0, 0); };

  // ---------- 角色视口 ----------
  function CharacterViewer(el) { Base.call(this, el, { gridSize: 4, fov: 35 }); this.camera.position.set(1.6, 1.4, 3); this.controls.target.set(0, 0.95, 0); this.bones = {}; this.mode = 'mesh'; this.clipT = 0; this.build(); }
  CharacterViewer.prototype = Object.create(Base.prototype);
  CharacterViewer.prototype.build = function () {
    const root = new T.Group(); this.scene.add(root); this.root = root;
    const mat = new T.MeshStandardMaterial({ color: 0x2c6a62, roughness: 0.6, metalness: 0.05 }); const skin = new T.MeshStandardMaterial({ color: 0xe6c3a5, roughness: 0.7 });
    this.meshMats = [mat, skin];
    const lines = [];
    for (const [name, parent, off] of Geo.SKELETON) {
      const b = new T.Group(); b.position.set(off[0], off[1], off[2]); b.name = name; this.bones[name] = b;
      (parent ? this.bones[parent] : root).add(b);
      const len = Math.hypot(...off);
      if (parent && len > 0.05) {
        const seg = new T.Mesh(new T.CylinderGeometry(name.includes('knee') || name.includes('foot') ? 0.055 : 0.05, 0.06, len, 10), name.includes('hand') || name.includes('head') ? skin : mat);
        seg.position.set(-off[0] / 2, -off[1] / 2, -off[2] / 2); seg.lookAt(new T.Vector3(0, 0, 0)); seg.rotateX(Math.PI / 2);
        b.add(seg); seg.userData.mesh = true; seg.userData.bone = name;
      }
      lines.push(b);
    }
    const head = new T.Mesh(new T.SphereGeometry(0.11, 20, 14), skin); head.position.set(0, 0.1, 0); this.bones.head.add(head); head.userData.mesh = true; head.userData.bone = 'head';
    const torso = new T.Mesh(new T.CylinderGeometry(0.16, 0.13, 0.42, 14), mat); torso.position.set(0, 0.2, 0); this.bones.spine.add(torso); torso.userData.mesh = true; torso.userData.bone = 'chest';
    const skirt = new T.Mesh(new T.CylinderGeometry(0.15, 0.22, 0.3, 14), new T.MeshStandardMaterial({ color: 0xa8732f, roughness: 0.7 })); skirt.position.set(0, -0.08, 0); this.bones.hips.add(skirt); skirt.userData.mesh = true; skirt.userData.bone = 'hips';
    // 骨骼显示
    this.skelGroup = new T.Group(); this.scene.add(this.skelGroup);
    this.jointMeshes = {};
    for (const [name] of Geo.SKELETON) { const j = new T.Mesh(new T.SphereGeometry(0.025, 8, 6), new T.MeshBasicMaterial({ color: 0xd0902f, depthTest: false })); j.renderOrder = 10; this.skelGroup.add(j); this.jointMeshes[name] = j; }
    this.boneLines = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({ color: 0xd0902f, depthTest: false })); this.boneLines.renderOrder = 9; this.skelGroup.add(this.boneLines);
    this.onFrame = () => this.update();
  };
  CharacterViewer.prototype.setMode = function (mode, issues) {
    this.mode = mode; const bad = new Set((issues || []).map(i => i.bone));
    this.root.traverse(o => { if (!o.userData.mesh) return; o.visible = mode !== 'bones'; if (mode === 'weights') { o.material = new T.MeshBasicMaterial({ color: bad.has(o.userData.bone) || bad.has(o.parent.name) ? 0xe0412f : new T.Color().setHSL(0.6 - (Geo.hash(o.userData.bone) % 100) / 220, 0.8, 0.5) }); } else if (o._orig) o.material = o._orig; if (!o._orig && mode !== 'weights') o._orig = o.material; });
    this.skelGroup.visible = mode !== 'mesh';
  };
  CharacterViewer.prototype.update = function () {
    const clips = this.clips || []; const pose = {};
    if (this.playing && clips.length) {
      const now = performance.now() / 1000; if (!this.t0) this.t0 = now; let t = (now - this.t0); const total = clips.reduce((s, c) => s + c.duration, 0); t = t % total; this.clipT = t;
      let acc = 0; for (let i = 0; i < clips.length; i++) { const c = clips[i]; if (t < acc + c.duration) { const lt = t - acc; const cur = Geo.MOTIONS[c.motion].f(lt); const nxt = clips[i + 1] && lt > c.duration - c.blend ? Geo.MOTIONS[clips[i + 1].motion].f(0) : null; const w = nxt ? (lt - (c.duration - c.blend)) / c.blend : 0; for (const k of new Set([...Object.keys(cur), ...Object.keys(nxt || {})])) { const a = cur[k] || [0, 0, 0], b = (nxt && nxt[k]) || a; pose[k] = [a[0] * (1 - w) + b[0] * w, (a[1] || 0) * (1 - w) + (b[1] || 0) * w, (a[2] || 0) * (1 - w) + (b[2] || 0) * w]; } break; } acc += c.duration; }
    } else if (!this.rigged) { Object.assign(pose, { l_shoulder: [0, -1.25], r_shoulder: [0, 1.25] }); }
    else Object.assign(pose, Geo.MOTIONS.idle.f(performance.now() / 1000));
    for (const [name, , off] of Geo.SKELETON) { const b = this.bones[name]; const p = pose[name] || [0, 0, 0]; b.rotation.set(p[0] || 0, 0, p[1] || 0); if (name === 'hips') b.position.y = off[1] + (p[2] || 0); }
    // 骨骼线
    const pts = []; const wp = {}; for (const [name] of Geo.SKELETON) { const v = new T.Vector3(); this.bones[name].getWorldPosition(v); wp[name] = v; this.jointMeshes[name].position.copy(v); }
    for (const [name, parent] of Geo.SKELETON) if (parent) pts.push(wp[parent].x, wp[parent].y, wp[parent].z, wp[name].x, wp[name].y, wp[name].z);
    this.boneLines.geometry.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
  };
  CharacterViewer.prototype.play = function (clips) { this.clips = clips; this.playing = true; this.t0 = 0; };
  CharacterViewer.prototype.stop = function () { this.playing = false; };

  // ---------- 缩略图 ----------
  let thumbR = null; const thumbCache = new Map();
  function thumbnail(info) {
    const key = [info.category, info.seed, info.tris, info.texture].join('|');
    if (thumbCache.has(key)) return thumbCache.get(key);
    try {
      if (!thumbR) {
        const r = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); r.setSize(220, 220); r.outputEncoding = T.sRGBEncoding; r.toneMapping = T.ACESFilmicToneMapping;
        const sc = new T.Scene(); sc.environment = envMap(r); sc.add(new T.HemisphereLight(0xffffff, 0x50463c, 0.6)); const d = new T.DirectionalLight(0xfff1dd, 1.5); d.position.set(3, 5, 4); sc.add(d);
        thumbR = { r, sc, cam: new T.PerspectiveCamera(30, 1, 0.01, 100) };
      }
      const m = cachedMesh({ category: info.category, seed: info.seed, defects: {} }, Math.min(info.tris || 4000, 4000));
      const o = new T.Mesh(toGeometry(m), materialFor(m, 'solid', { category: info.category, seed: info.seed, texture: 256 }));
      thumbR.sc.add(o);
      const b = m.bbox, s = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]); const cy = (b.min[1] + b.max[1]) / 2;
      thumbR.cam.position.set(s * 1.25, cy + s * 0.55, s * 1.65); thumbR.cam.lookAt(0, cy, 0);
      thumbR.r.render(thumbR.sc, thumbR.cam); const url = thumbR.r.domElement.toDataURL('image/png');
      thumbR.sc.remove(o); o.geometry.dispose();
      thumbCache.set(key, url); return url;
    } catch (e) { return ''; }
  }
  const conceptCache = new Map();
  function conceptURL(c, size, view) {
    if (c.url) return c.url;
    const key = c.id + '|' + (size || 256) + '|' + (view || 'front');
    if (conceptCache.has(key)) return conceptCache.get(key);
    const cv = document.createElement('canvas'); cv.width = cv.height = size || 256;
    Geo.drawConcept(cv, { category: c.category, seed: c.seed, removeBg: c.remove_bg, view: view || 'front' });
    const url = cv.toDataURL('image/png'); conceptCache.set(key, url); if (conceptCache.size > 300) conceptCache.delete(conceptCache.keys().next().value); return url;
  }
  const panoCache = new Map();
  function panoCanvas(p, w) {
    const key = p.id + '|' + w + '|' + p.seam_defect;
    if (panoCache.has(key)) return panoCache.get(key);
    const c = document.createElement('canvas'); c.width = w; c.height = w / 2; Geo.drawPanorama(c, { seed: p.seed, seamDefect: p.seam_defect, theme: p.theme });
    panoCache.set(key, c); if (panoCache.size > 30) panoCache.delete(panoCache.keys().next().value); return c;
  }

  global.Viewers = { AssetViewer, SceneViewer, SplatViewer, PanoViewer, CharacterViewer, thumbnail, conceptURL, panoCanvas, cachedMesh };
})(window);
