/* 空间内容工场 · 程序化几何 / 贴图 / GLB 写出
 * 演示版用确定性的程序化生成代替真实模型推理：同一 seed + 参数必然得到同一结果，
 * 因此 seed 可复现（P03 验收）、面数与导出文件一致（P04 验收）。
 */
(function (global) {
  'use strict';

  // ---------- 随机数 ----------
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  // 周期噪声（u 方向首尾连续，用于无缝贴图与全景）
  function pnoise(u, v, seed, oct) {
    let s = 0, amp = 1, f = 1, norm = 0;
    for (let o = 0; o < (oct || 4); o++) {
      const ph = (seed % 997) * 0.013 + o * 1.7;
      s += amp * (Math.sin(2 * Math.PI * u * f * 2 + ph + Math.sin(v * 9 * f + ph) * 0.8) *
                  Math.cos(v * 11 * f + ph * 1.3 + Math.cos(2 * Math.PI * u * f * 3 + ph) * 0.6));
      norm += amp; amp *= 0.5; f *= 2;
    }
    return s / norm * 0.5 + 0.5;
  }

  // ---------- 品类 ----------
  const CATS = {
    ding:    { name: '青铜鼎', kw: ['鼎', '青铜器', '青铜'], size: [0.55, 0.62, 0.55] },
    bell:    { name: '编钟', kw: ['编钟', '钟'], size: [0.36, 0.55, 0.28] },
    lantern: { name: '宫灯', kw: ['宫灯', '灯笼', '灯'], size: [0.42, 0.78, 0.42] },
    vase:    { name: '瓷瓶', kw: ['瓷瓶', '花瓶', '梅瓶', '瓶', '青花'], size: [0.3, 0.52, 0.3] },
    jar:     { name: '陶罐', kw: ['陶罐', '罐', '陶器', '彩陶'], size: [0.4, 0.42, 0.4] },
    censer:  { name: '香炉', kw: ['香炉', '炉', '博山'], size: [0.38, 0.4, 0.38] },
    drum:    { name: '战鼓', kw: ['鼓'], size: [0.7, 0.62, 0.7] },
    table:   { name: '案几', kw: ['案几', '桌', '几', '案'], size: [1.2, 0.72, 0.55] },
    screen:  { name: '屏风', kw: ['屏风', '隔断'], size: [1.8, 1.6, 0.12] },
    chest:   { name: '木箱', kw: ['木箱', '箱', '衣柜', '匣'], size: [0.8, 0.5, 0.5] },
  };
  const CAT_ORDER = Object.keys(CATS);
  function detectCategory(text, seed) {
    text = text || '';
    for (const k of CAT_ORDER) for (const w of CATS[k].kw) if (text.indexOf(w) >= 0) return k;
    return CAT_ORDER[(seed >>> 0) % 6];
  }
  // 多品类提示词时按 seed 轮换（例：“青铜器、宫灯”）
  function categoriesIn(text) {
    const found = [];
    for (const k of CAT_ORDER) for (const w of CATS[k].kw) if ((text || '').indexOf(w) >= 0) { if (!found.includes(k)) found.push(k); break; }
    return found;
  }

  // ---------- 配色 / 材质 ----------
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  const PAL = {
    bronze: hexToRgb('#7a5a32'), patina: hexToRgb('#3f8a78'), patina2: hexToRgb('#6fb3a0'), dark: hexToRgb('#2b231b'),
    red: hexToRgb('#b3261e'), gold: hexToRgb('#d8a93b'), silk: hexToRgb('#e8c48a'),
    white: hexToRgb('#eef1f2'), cobalt: hexToRgb('#1f4fa0'), celadon: hexToRgb('#9cc3a8'),
    clay: hexToRgb('#a8653a'), clayDark: hexToRgb('#4a2a19'), ochre: hexToRgb('#c99a55'),
    wood: hexToRgb('#7b4a2a'), woodLight: hexToRgb('#a87445'), lacquer: hexToRgb('#3a1410'), leather: hexToRgb('#d9c29a'),
  };
  // 返回 [r,g,b,metal,rough]
  function surface(cat, u, v, seed, part) {
    const n = pnoise(u, v, seed, 4), n2 = pnoise(u * 3 % 1, v * 2.3, seed + 11, 3);
    let c, m = 0, r = 0.6;
    switch (cat) {
      case 'ding': case 'bell': case 'censer': {
        const band = Math.abs(Math.sin(v * Math.PI * (cat === 'bell' ? 7 : 5)));
        const motif = (Math.sin(u * Math.PI * 2 * 12) * Math.sin(v * Math.PI * 18) > 0.35 && band > 0.55) ? 1 : 0;
        const pat = clamp((n - 0.42) * 2.4 + n2 * 0.3, 0, 1);
        c = mix(PAL.bronze, mix(PAL.patina, PAL.patina2, n2), pat);
        if (motif) c = mix(c, PAL.dark, 0.55);
        m = lerp(0.85, 0.25, pat); r = lerp(0.38, 0.8, pat);
        break;
      }
      case 'lantern': {
        const frame = (v < 0.12 || v > 0.86 || (Math.abs(Math.sin(u * Math.PI * 6)) < 0.07));
        if (part === 'tassel') { c = PAL.red; m = 0; r = 0.9; break; }
        if (frame) { c = mix(PAL.gold, PAL.bronze, n * 0.4); m = 0.9; r = 0.3; }
        else { c = mix(PAL.red, PAL.silk, clamp((Math.sin(v * Math.PI) - 0.6) * 1.5, 0, 0.7) * (0.6 + n * 0.4)); m = 0; r = 0.75; }
        if (!frame && Math.sin(u * Math.PI * 2 * 6) * Math.sin(v * Math.PI * 9) > 0.7) c = mix(c, PAL.gold, 0.6);
        break;
      }
      case 'vase': {
        const blue = (seed % 2 === 0);
        const band = Math.sin(v * Math.PI * 14) > 0.85 || (v > 0.35 && v < 0.7 && Math.sin(u * Math.PI * 2 * 8 + Math.sin(v * 30) * 2) * Math.cos(v * 40) > 0.55);
        c = blue ? (band ? mix(PAL.cobalt, PAL.white, n * 0.25) : mix(PAL.white, PAL.celadon, n * 0.08)) : mix(PAL.celadon, PAL.white, n * 0.35);
        m = 0; r = 0.18 + n * 0.08;
        break;
      }
      case 'jar': {
        const band = Math.sin(v * Math.PI * 9 + Math.sin(u * Math.PI * 2 * 5) * 1.2) > 0.7;
        c = band ? mix(PAL.clayDark, PAL.dark, n * 0.4) : mix(PAL.clay, PAL.ochre, n * 0.6);
        m = 0; r = 0.85;
        break;
      }
      case 'drum': {
        if (part === 'head') { c = mix(PAL.leather, PAL.ochre, n * 0.4); m = 0; r = 0.8; break; }
        const stud = (v < 0.1 || v > 0.9) && Math.sin(u * Math.PI * 2 * 24) > 0.8;
        c = stud ? PAL.gold : mix(PAL.red, PAL.lacquer, n * 0.5); m = stud ? 0.9 : 0.05; r = stud ? 0.3 : 0.45;
        break;
      }
      default: { // 木作
        const grain = Math.sin((u * 40 + n * 6 + v * 3) * Math.PI) * 0.5 + 0.5;
        c = mix(PAL.wood, PAL.woodLight, grain * 0.6 + n2 * 0.2);
        if (cat === 'screen' && part === 'panel') { c = mix(PAL.silk, PAL.white, n * 0.3); if (Math.sin(u * 9 + n * 4) * Math.cos(v * 7) > 0.6) c = mix(c, PAL.patina, 0.6); r = 0.8; }
        if (cat === 'chest' && part === 'metal') { c = PAL.gold; m = 0.85; r = 0.35; }
        if (cat === 'table') c = mix(c, PAL.lacquer, 0.45);
        m = m || 0.02; r = r || 0.6;
      }
    }
    return [c[0], c[1], c[2], m, r];
  }

  // ---------- 网格构建器 ----------
  function Builder() { this.p = []; this.n = []; this.uv = []; this.idx = []; this.part = []; this.parts = []; }
  Builder.prototype.addLathe = function (profile, S, opts) {
    // profile: [[r,y],...] 由下至上；opts.xform(x,y,z)->[x,y,z]；opts.shape(theta)->半径系数
    opts = opts || {};
    const base = this.p.length / 3, N = profile.length;
    const triStart = this.idx.length / 3;
    for (let i = 0; i < N; i++) {
      const [r, y] = profile[i];
      // 剖面切线用于法线
      const a = profile[Math.max(0, i - 1)], b = profile[Math.min(N - 1, i + 1)];
      const dr = b[0] - a[0], dy = b[1] - a[1];
      for (let j = 0; j <= S; j++) {
        const t = j / S * Math.PI * 2;
        const k = opts.shape ? opts.shape(t) : 1;
        let x = Math.cos(t) * r * k * (opts.sx || 1), z = Math.sin(t) * r * k * (opts.sz || 1);
        let nx = Math.cos(t) * dy, ny = -dr, nz = Math.sin(t) * dy;
        const nl = Math.hypot(nx, ny, nz) || 1;
        let P = [x, y, z];
        if (opts.xform) P = opts.xform(x, y, z);
        this.p.push(P[0], P[1], P[2]);
        this.n.push(nx / nl, ny / nl, nz / nl);
        this.uv.push(j / S, i / (N - 1));
      }
    }
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < S; j++) {
      const a = base + i * (S + 1) + j, b = a + 1, c = a + (S + 1), d = c + 1;
      this.idx.push(a, c, b, b, c, d);
    }
    this.parts.push({ name: opts.part || 'main', triStart, triEnd: this.idx.length / 3 });
    return this;
  };
  Builder.prototype.addBox = function (cx, cy, cz, sx, sy, sz, sub, part) {
    // 细分盒子：每面 sub×sub 网格
    const triStart = this.idx.length / 3;
    const faces = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    const hs = [sx / 2, sy / 2, sz / 2];
    for (const [nrm, U, V] of faces) {
      const base = this.p.length / 3;
      for (let i = 0; i <= sub; i++) for (let j = 0; j <= sub; j++) {
        const u = j / sub * 2 - 1, v = i / sub * 2 - 1;
        const x = cx + (nrm[0] + U[0] * u + V[0] * v) * hs[0];
        const y = cy + (nrm[1] + U[1] * u + V[1] * v) * hs[1];
        const z = cz + (nrm[2] + U[2] * u + V[2] * v) * hs[2];
        this.p.push(x, y, z); this.n.push(nrm[0], nrm[1], nrm[2]); this.uv.push(j / sub, i / sub);
      }
      for (let i = 0; i < sub; i++) for (let j = 0; j < sub; j++) {
        const a = base + i * (sub + 1) + j, b = a + 1, c = a + sub + 1, d = c + 1;
        this.idx.push(a, b, c, b, d, c);
      }
    }
    this.parts.push({ name: part || 'main', triStart, triEnd: this.idx.length / 3 });
    return this;
  };
  Builder.prototype.addTorusArc = function (cx, cy, cz, R, r, a0, a1, segU, segV, rotY, part) {
    const triStart = this.idx.length / 3, base = this.p.length / 3;
    const cr = Math.cos(rotY || 0), sr = Math.sin(rotY || 0);
    for (let i = 0; i <= segU; i++) {
      const a = lerp(a0, a1, i / segU);
      for (let j = 0; j <= segV; j++) {
        const b = j / segV * Math.PI * 2;
        const lx = (R + r * Math.cos(b)) * Math.cos(a), ly = (R + r * Math.cos(b)) * Math.sin(a), lz = r * Math.sin(b);
        const nx0 = Math.cos(b) * Math.cos(a), ny0 = Math.cos(b) * Math.sin(a), nz0 = Math.sin(b);
        this.p.push(cx + lx * cr - lz * sr, cy + ly, cz + lx * sr + lz * cr);
        this.n.push(nx0 * cr - nz0 * sr, ny0, nx0 * sr + nz0 * cr);
        this.uv.push(i / segU, j / segV);
      }
    }
    for (let i = 0; i < segU; i++) for (let j = 0; j < segV; j++) {
      const a = base + i * (segV + 1) + j, b = a + 1, c = a + segV + 1, d = c + 1;
      this.idx.push(a, b, c, b, d, c);
    }
    this.parts.push({ name: part || 'handle', triStart, triEnd: this.idx.length / 3 });
  };

  // 由目标三角形数换算网格分辨率
  function lathRes(tris, aspect) { const s = Math.max(6, Math.round(Math.sqrt(tris / 2 * (aspect || 1.6)))); return [s, Math.max(4, Math.round(tris / 2 / s))]; }
  function sampleProfile(fn, n) { const out = []; for (let i = 0; i < n; i++) { const t = i / (n - 1); out.push(fn(t)); } return out; }

  function shapeParams(cat, seed) {
    const R = rng(seed * 7 + 3);
    return { a: R(), b: R(), c: R(), d: R(), e: R() };
  }

  /* buildMesh(spec, targetTris)
   * spec: {category, seed, defects:{flipped, nonManifold, origin:[x,y,z]}}
   */
  function buildMesh(spec, targetTris) {
    const cat = spec.category, seed = spec.seed, P = shapeParams(cat, seed);
    const B = new Builder();
    const T = Math.max(200, targetTris | 0);
    const sz = CATS[cat].size;
    const main = T * 0.78, extra = T - main;
    const H = sz[1];
    if (cat === 'ding') {
      const [S, N] = lathRes(main * 0.9, 1.6);
      const bowlH = H * 0.6, y0 = H * 0.33, rw = sz[0] / 2 * (0.85 + P.a * 0.15);
      B.addLathe(sampleProfile(t => {
        const r = t < 0.06 ? lerp(0.001, rw * 0.6, t / 0.06) : rw * (0.6 + 0.4 * Math.sin(Math.min(1, (t - 0.06) / 0.8) * Math.PI * 0.55)) * (t > 0.9 ? 1.06 : 1);
        return [r, y0 + t * bowlH];
      }, N), S, { part: 'main' });
      const [s2, n2] = lathRes(extra / 5, 0.6);
      for (let k = 0; k < 3; k++) {
        const a = k / 3 * Math.PI * 2 + Math.PI / 6, lx = Math.cos(a) * rw * 0.62, lz = Math.sin(a) * rw * 0.62;
        B.addLathe(sampleProfile(t => [0.035 + 0.018 * Math.sin(t * Math.PI) + (t < 0.12 ? 0.02 : 0), t * (y0 + 0.02)], n2), s2,
          { part: 'leg', xform: (x, y, z) => [x + lx, y, z + lz] });
      }
      const seg = Math.max(4, Math.round(Math.sqrt(extra / 5)));
      for (const side of [-1, 1]) B.addTorusArc(side * rw * 0.78, y0 + bowlH + 0.01, 0, 0.07, 0.016, 0, Math.PI, seg, Math.max(4, seg >> 1), Math.PI / 2, 'handle');
    } else if (cat === 'bell') {
      const [S, N] = lathRes(main, 1.4);
      B.addLathe(sampleProfile(t => [lerp(sz[0] / 2, sz[0] / 2 * 0.62, Math.pow(t, 0.8)) * (t > 0.97 ? 0.4 : 1), 0.06 + t * H * 0.78], N), S, { part: 'main', sx: 1, sz: 0.72 });
      const [s2, n2] = lathRes(extra, 0.5);
      B.addLathe(sampleProfile(t => [0.04 + 0.012 * Math.sin(t * Math.PI * 3), 0.06 + H * 0.78 + t * H * 0.2], n2), s2, { part: 'handle' });
    } else if (cat === 'lantern') {
      const [S, N] = lathRes(main, 1.3);
      const rw = sz[0] / 2 * (0.9 + P.a * 0.1), sides = 6 + (seed % 2) * 2;
      const shape = t => { const k = Math.PI / sides; const m = ((t % (2 * k)) + 2 * k) % (2 * k) - k; return Math.cos(k) / Math.cos(m) * 0.94 + 0.06; };
      B.addLathe(sampleProfile(t => [t < 0.04 ? lerp(0.02, rw * 0.7, t / 0.04) : t > 0.96 ? lerp(rw * 0.7, 0.02, (t - 0.96) / 0.04) : rw * (0.7 + 0.3 * Math.sin((t - 0.04) / 0.92 * Math.PI)), 0.18 + t * H * 0.62], N), S, { part: 'main', shape });
      const [s2, n2] = lathRes(extra * 0.6, 0.6);
      B.addLathe(sampleProfile(t => [0.03 + 0.03 * Math.sin(t * Math.PI), 0.18 + H * 0.62 + t * 0.12], n2), s2, { part: 'top' });
      const [s3, n3] = lathRes(extra * 0.4, 0.4);
      B.addLathe(sampleProfile(t => [0.008 + 0.05 * Math.pow(1 - t, 2), t * 0.18], n3), s3, { part: 'tassel' });
    } else if (cat === 'vase' || cat === 'jar') {
      const [S, N] = lathRes(T, 1.5);
      const neck = 0.25 + P.b * 0.2, rw = sz[0] / 2;
      B.addLathe(sampleProfile(t => {
        let r;
        if (cat === 'vase') r = rw * (0.45 + 0.55 * Math.sin(Math.min(1, t / 0.75) * Math.PI) * (t < 0.75 ? 1 : 0)) + (t > 0.75 ? rw * neck * (1 + 0.6 * Math.pow((t - 0.75) / 0.25, 3)) : 0);
        else r = rw * (0.55 + 0.45 * Math.sin(t * Math.PI * 0.95 + 0.05)) * (t > 0.9 ? 0.82 : 1);
        if (t < 0.02) r = lerp(0.001, r, t / 0.02);
        return [Math.max(0.002, r), t * H];
      }, N), S, { part: 'main' });
    } else if (cat === 'censer') {
      const [S, N] = lathRes(main, 1.5);
      const rw = sz[0] / 2;
      B.addLathe(sampleProfile(t => [t < 0.05 ? lerp(0.001, rw * 0.5, t / 0.05) : rw * (0.5 + 0.5 * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.6)) * (t > 0.55 ? lerp(1, 0.15, (t - 0.55) / 0.45) : 1), 0.08 + t * H * 0.85], N), S, { part: 'main' });
      const [s2, n2] = lathRes(extra / 3, 0.5);
      for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2; B.addLathe(sampleProfile(t => [0.025, t * 0.1], n2), s2, { part: 'leg', xform: (x, y, z) => [x + Math.cos(a) * rw * 0.5, y, z + Math.sin(a) * rw * 0.5] }); }
    } else if (cat === 'drum') {
      const [S, N] = lathRes(main, 1.6);
      const rw = sz[0] / 2;
      B.addLathe(sampleProfile(t => [rw * (0.88 + 0.12 * Math.sin(t * Math.PI)), 0.06 + t * (H - 0.12)], N), S, { part: 'main' });
      const [s2, n2] = lathRes(extra / 2, 2);
      B.addLathe(sampleProfile(t => [rw * 0.88 * (1 - t), H - 0.06], n2), s2, { part: 'head' });
      B.addLathe(sampleProfile(t => [rw * 0.88 * t, 0.06], n2), s2, { part: 'head' });
    } else if (cat === 'table') {
      const sub = Math.max(1, Math.round(Math.sqrt(main / 12)));
      B.addBox(0, H - 0.03, 0, sz[0], 0.06, sz[2], sub, 'main');
      const sl = Math.max(1, Math.round(Math.sqrt(extra / 4 / 12)));
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.addBox(x * (sz[0] / 2 - 0.06), (H - 0.06) / 2, z * (sz[2] / 2 - 0.05), 0.06, H - 0.06, 0.06, sl, 'leg');
    } else if (cat === 'screen') {
      const panels = 4, w = sz[0] / panels;
      const sub = Math.max(1, Math.round(Math.sqrt(main / panels / 12)));
      for (let k = 0; k < panels; k++) {
        const x = -sz[0] / 2 + w * (k + 0.5), z = (k % 2) * 0.12 - 0.06;
        B.addBox(x, H / 2 + 0.05, z, w * 0.94, H * 0.9, 0.03, sub, 'panel');
      }
      const sl = Math.max(1, Math.round(Math.sqrt(extra / 2 / 12)));
      B.addBox(-sz[0] / 2 + 0.1, 0.03, 0, 0.3, 0.06, 0.3, sl, 'main'); B.addBox(sz[0] / 2 - 0.1, 0.03, 0, 0.3, 0.06, 0.3, sl, 'main');
    } else { // chest
      const sub = Math.max(1, Math.round(Math.sqrt(main / 12)));
      B.addBox(0, sz[1] / 2, 0, sz[0], sz[1], sz[2], sub, 'main');
      const sl = Math.max(1, Math.round(Math.sqrt(extra / 2 / 12)));
      B.addBox(0, sz[1] * 0.75, sz[2] / 2 + 0.01, 0.12, 0.1, 0.02, sl, 'metal');
      B.addBox(0, sz[1] + 0.01, 0, sz[0] * 1.02, 0.02, sz[2] * 1.02, sl, 'metal');
    }

    // 缺陷注入（演示：用于质检与“问题高亮”）
    const d = spec.defects || {};
    const triCount = B.idx.length / 3;
    const flags = new Uint8Array(triCount); // 1=法线翻转 2=非流形
    if (d.flipped > 0) {
      const m = B.parts[0], span = Math.min(m.triEnd - m.triStart, Math.max(2, Math.round((m.triEnd - m.triStart) * 0.012)));
      const st = m.triStart + Math.floor((m.triEnd - m.triStart - span) * 0.55);
      for (let t = st; t < st + span; t++) { const a = B.idx[t * 3 + 1]; B.idx[t * 3 + 1] = B.idx[t * 3 + 2]; B.idx[t * 3 + 2] = a; flags[t] = 1; }
    }
    if (d.nonManifold > 0) {
      const m = B.parts[0], span = Math.min(m.triEnd - m.triStart, Math.max(2, Math.round((m.triEnd - m.triStart) * 0.006)));
      const st = m.triStart + Math.floor((m.triEnd - m.triStart - span) * 0.2);
      for (let t = st; t < st + span; t++) flags[t] = flags[t] || 2;
    }
    const off = d.origin || [0, 0, 0];
    const pos = new Float32Array(B.p.length);
    for (let i = 0; i < B.p.length; i += 3) { pos[i] = B.p[i] + off[0]; pos[i + 1] = B.p[i + 1] + off[1]; pos[i + 2] = B.p[i + 2] + off[2]; }
    // 逐顶点 PBR 属性（metal/rough 用于视口显示模式）
    const vcount = pos.length / 3, mr = new Float32Array(vcount * 2), col = new Float32Array(vcount * 3);
    const vpart = new Array(vcount).fill('main');
    for (const pt of B.parts) for (let t = pt.triStart; t < pt.triEnd; t++) for (let k = 0; k < 3; k++) vpart[B.idx[t * 3 + k]] = pt.name;
    for (let i = 0; i < vcount; i++) {
      const s = surface(cat, B.uv[i * 2], B.uv[i * 2 + 1], seed, vpart[i]);
      col[i * 3] = s[0]; col[i * 3 + 1] = s[1]; col[i * 3 + 2] = s[2]; mr[i * 2] = s[3]; mr[i * 2 + 1] = s[4];
    }
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); }
    return {
      positions: pos, normals: new Float32Array(B.n), uvs: new Float32Array(B.uv), indices: new Uint32Array(B.idx),
      colors: col, mr, flags, parts: B.parts,
      tris: triCount, verts: vcount, bbox: { min: mn, max: mx },
    };
  }

  // ---------- 贴图 ----------
  function textureCanvas(cat, seed, size) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d'); const img = ctx.createImageData(size, size);
    // 以 1/4 分辨率采样再放大，保证 2K 贴图生成速度
    const step = size > 512 ? 4 : size > 256 ? 2 : 1;
    for (let y = 0; y < size; y += step) for (let x = 0; x < size; x += step) {
      const s = surface(cat, x / size, 1 - y / size, seed, cat === 'screen' ? 'panel' : 'main');
      for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) {
        const o = ((y + dy) * size + x + dx) * 4;
        img.data[o] = s[0] * 255; img.data[o + 1] = s[1] * 255; img.data[o + 2] = s[2] * 255; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ---------- 概念图（2D 插画，去背景时透明） ----------
  function drawConcept(canvas, opts) {
    const { category, seed, removeBg, view } = opts; // view: front|side|back
    const W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d');
    const R = rng(seed);
    ctx.clearRect(0, 0, W, H);
    if (!removeBg) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      const hue = (seed % 360);
      g.addColorStop(0, `hsl(${hue},18%,86%)`); g.addColorStop(1, `hsl(${(hue + 30) % 360},22%,62%)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,0.08)'; for (let i = 0; i < 18; i++) { ctx.beginPath(); ctx.arc(R() * W, R() * H * 0.7, R() * W * 0.12, 0, 7); ctx.fill(); }
    } else {
      // 透明棋盘格不画到像素里，由页面 CSS 显示
    }
    // 地面投影
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.ellipse(W / 2, H * 0.86, W * 0.28, H * 0.035, 0, 0, 7); ctx.fill();
    // 用低分辨率网格做正交投影 + 简易光照
    const mesh = buildMesh({ category, seed, defects: {} }, 3000);
    const sz = CATS[category].size, scale = Math.min(W * 0.7 / Math.max(sz[0], sz[2], 0.3), H * 0.68 / sz[1]);
    const rot = view === 'side' ? Math.PI / 2 : view === 'back' ? Math.PI : (R() - 0.5) * 0.5;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const tris = [];
    const p = mesh.positions, n = mesh.normals, idx = mesh.indices;
    const tx = (i) => { const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2]; return [x * cr - z * sr, y, x * sr + z * cr]; };
    for (let t = 0; t < idx.length; t += 3) {
      const a = tx(idx[t]), b = tx(idx[t + 1]), c = tx(idx[t + 2]);
      const nz = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      const ni = idx[t];
      const nx = n[ni * 3] * cr - n[ni * 3 + 2] * sr, ny = n[ni * 3 + 1], nzz = n[ni * 3] * sr + n[ni * 3 + 2] * cr;
      tris.push({ a, b, c, z: (a[2] + b[2] + c[2]) / 3, col: [mesh.colors[ni * 3], mesh.colors[ni * 3 + 1], mesh.colors[ni * 3 + 2]], l: clamp(0.35 + 0.65 * Math.max(0, nx * -0.4 + ny * 0.6 + nzz * -0.7), 0, 1), mt: mesh.mr[ni * 2] });
    }
    tris.sort((u, v) => u.z - v.z);
    const ox = W / 2, oy = H * 0.86;
    for (const T of tris) {
      const sp = 0.6 + T.l * 0.6 + (T.mt > 0.5 ? Math.pow(T.l, 8) * 0.8 : 0);
      ctx.fillStyle = `rgb(${clamp(T.col[0] * sp * 255, 0, 255) | 0},${clamp(T.col[1] * sp * 255, 0, 255) | 0},${clamp(T.col[2] * sp * 255, 0, 255) | 0})`;
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(ox + T.a[0] * scale, oy - T.a[1] * scale); ctx.lineTo(ox + T.b[0] * scale, oy - T.b[1] * scale); ctx.lineTo(ox + T.c[0] * scale, oy - T.c[1] * scale); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // 笔触感高光
    ctx.globalCompositeOperation = 'source-atop';
    const hl = ctx.createRadialGradient(W * 0.38, H * 0.35, 0, W * 0.38, H * 0.35, W * 0.5);
    hl.addColorStop(0, 'rgba(255,255,240,0.18)'); hl.addColorStop(1, 'rgba(255,255,240,0)');
    ctx.fillStyle = hl; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    return canvas;
  }

  // ---------- 360 全景（等距柱状，u 方向周期 → 无缝） ----------
  function drawPanorama(canvas, opts) {
    const { seed, seamDefect, theme } = opts;
    const W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H), R = rng(seed);
    const hue = theme === 'night' ? 225 : theme === 'dusk' ? 20 : 200;
    const sky0 = theme === 'night' ? [12, 18, 44] : theme === 'dusk' ? [250, 160, 110] : [150, 196, 235];
    const sky1 = theme === 'night' ? [40, 50, 90] : theme === 'dusk' ? [90, 70, 120] : [60, 120, 190];
    const ground = theme === 'night' ? [24, 28, 30] : [96, 104, 84];
    const sunU = R(), ridges = [0, 1, 2].map(k => ({ h: 0.08 + k * 0.05 + R() * 0.04, f: 2 + k, s: seed + k * 31 }));
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const rh = ridges.map(r => 0.5 - r.h * pnoise(u, r.f * 0.1, r.s, 4));
      for (let y = 0; y < H; y++) {
        const v = y / H; let c;
        if (v < 0.5) {
          const t = v / 0.5; c = mix(sky1.map(a => a / 255), sky0.map(a => a / 255), t);
          const cl = pnoise(u, v * 2.5, seed + 5, 4); if (cl > 0.62) c = mix(c, theme === 'night' ? [0.2, 0.22, 0.32] : [1, 1, 1], (cl - 0.62) * 2.2);
          let du = Math.abs(u - sunU); du = Math.min(du, 1 - du);
          const sd = Math.hypot(du * 2, (v - 0.32)); if (sd < 0.04) c = mix(c, theme === 'night' ? [0.95, 0.95, 0.85] : [1, 0.95, 0.75], 1 - sd / 0.04);
          if (theme === 'night' && pnoise(u * 7 % 1, v * 9, seed + 9, 1) > 0.985) c = [1, 1, 1];
        } else c = mix(ground.map(a => a / 255), [0.05, 0.05, 0.05], (v - 0.5) * 1.2 * (0.6 + pnoise(u, v * 3, seed + 2, 3) * 0.5));
        for (let k = 2; k >= 0; k--) if (v > rh[k] && v < 0.5 + k * 0.004) { const tone = 0.25 + k * 0.18; c = mix(c, theme === 'night' ? [0.06, 0.08, 0.12] : [0.25 + k * 0.08, 0.35 + k * 0.06, 0.4], tone + 0.3); }
        // 建筑剪影（殿宇）
        let bu = Math.abs(u - ((sunU + 0.5) % 1)); bu = Math.min(bu, 1 - bu);
        if (bu < 0.07 && v > 0.5 - 0.06 * (1 - bu / 0.07 * 0.4) && v < 0.5) c = mix(c, [0.2, 0.08, 0.06], 0.85);
        if (bu < 0.09 && Math.abs(v - (0.5 - 0.062)) < 0.006) c = mix(c, [0.15, 0.1, 0.06], 0.9);
        const o = (y * W + x) * 4;
        img.data[o] = c[0] * 255; img.data[o + 1] = c[1] * 255; img.data[o + 2] = c[2] * 255; img.data[o + 3] = 255;
      }
    }
    if (seamDefect) { // 接缝缺陷：右缘 2% 宽度亮度偏移
      for (let y = 0; y < H; y++) for (let x = Math.floor(W * 0.985); x < W; x++) { const o = (y * W + x) * 4; img.data[o] = Math.min(255, img.data[o] * 1.35 + 20); img.data[o + 2] = img.data[o + 2] * 0.7; }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
  // 接缝检查：首列与末列像素平均差
  function seamScore(canvas) {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    const a = ctx.getImageData(0, 0, 1, H).data, b = ctx.getImageData(W - 1, 0, 1, H).data;
    let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return s / (H * 3);
  }

  // ---------- 3DGS 点云（演示：程序化展厅 + 浮点） ----------
  function buildSplats(seed, count, floaters, cropped) {
    const R = rng(seed); const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    let k = 0;
    const push = (x, y, z, c) => { if (k >= count) return; if (cropped && (Math.abs(x) > 4.6 || Math.abs(z) > 3.6 || y > 3.3 || y < -0.05)) return; pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z; col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2]; k++; };
    const nf = floaters ? Math.round(count * 0.02) : 0;
    let guard = 0;
    while (k < count - nf && guard++ < count * 3) {
      const r = R();
      if (r < 0.35) { const x = (R() - 0.5) * 9, z = (R() - 0.5) * 7; const t = pnoise((x + 5) / 10, (z + 4) / 8, seed, 3); push(x, 0, z, mix([0.55, 0.5, 0.44], [0.35, 0.3, 0.26], t)); }
      else if (r < 0.7) { const side = Math.floor(R() * 3); const y = R() * 3.2; if (side === 0) push((R() - 0.5) * 9, y, -3.5, mix([0.82, 0.78, 0.7], [0.6, 0.55, 0.5], R() * 0.3)); else push(side === 1 ? -4.5 : 4.5, y, (R() - 0.5) * 7, mix([0.78, 0.74, 0.68], [0.55, 0.5, 0.45], R() * 0.3)); }
      else if (r < 0.9) { // 展台与文物
        const bx = [-2.5, 0, 2.5][Math.floor(R() * 3)], bz = -1.2; const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * 0.45, y = R();
        if (y < 0.5) push(bx + (R() - 0.5) * 0.9, y * 1.8, bz + (R() - 0.5) * 0.9, [0.18, 0.17, 0.16]);
        else { const h = (y - 0.5) * 1.0; const rad = 0.28 * (0.6 + 0.4 * Math.sin(h / 0.5 * Math.PI)); push(bx + Math.cos(a) * rad, 0.9 + h, bz + Math.sin(a) * rad, mix([0.45, 0.33, 0.18], [0.25, 0.5, 0.42], R())); }
      } else { const x = (R() - 0.5) * 9, z = (R() - 0.5) * 7; push(x, 3.2, z, [0.9, 0.9, 0.86]); }
    }
    for (let i = 0; i < nf; i++) push((R() - 0.5) * 14, R() * 5 - 0.5, (R() - 0.5) * 12, [R(), R(), R()]);
    return { positions: pos.subarray(0, k * 3), colors: col.subarray(0, k * 3), count: k };
  }

  // ---------- GLB 写出 ----------
  function pad4(n) { return (n + 3) & ~3; }
  async function canvasPNG(canvas) {
    return new Promise((res) => canvas.toBlob(b => b.arrayBuffer().then(ab => res(new Uint8Array(ab))), 'image/png'));
  }
  /* meshes: [{mesh, name, translation, textureSize, extras}] ; options: {assetExtras, sceneExtras, texture:true} */
  async function writeGLB(items, options) {
    options = options || {};
    const bufs = []; let offset = 0;
    const bufferViews = [], accessors = [], meshes = [], nodes = [], materials = [], images = [], textures = [];
    function addView(arr, target) {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      const bv = { buffer: 0, byteOffset: offset, byteLength: bytes.length }; if (target) bv.target = target;
      bufferViews.push(bv); bufs.push(bytes); const p = pad4(bytes.length) - bytes.length; if (p) bufs.push(new Uint8Array(p));
      offset += pad4(bytes.length); return bufferViews.length - 1;
    }
    for (const it of items) {
      const m = it.mesh;
      const pv = addView(m.positions, 34962), nv = addView(m.normals, 34962), uv = addView(m.uvs, 34962), iv = addView(m.indices, 34963);
      accessors.push({ bufferView: pv, componentType: 5126, count: m.verts, type: 'VEC3', min: m.bbox.min, max: m.bbox.max });
      const pa = accessors.length - 1;
      accessors.push({ bufferView: nv, componentType: 5126, count: m.verts, type: 'VEC3' }); const na = accessors.length - 1;
      accessors.push({ bufferView: uv, componentType: 5126, count: m.verts, type: 'VEC2' }); const ua = accessors.length - 1;
      accessors.push({ bufferView: iv, componentType: 5125, count: m.indices.length, type: 'SCALAR' }); const ia = accessors.length - 1;
      const mat = { name: (it.name || 'mat') + '_PBR', pbrMetallicRoughness: { metallicFactor: +(it.metallic ?? 0.3).toFixed(3), roughnessFactor: +(it.roughness ?? 0.6).toFixed(3) } };
      if (options.texture !== false && it.textureSize) {
        const png = await canvasPNG(textureCanvas(it.category, it.seed, it.textureSize));
        const bv = addView(png); images.push({ bufferView: bv, mimeType: 'image/png', name: (it.name || 'tex') + '_baseColor' });
        textures.push({ source: images.length - 1 }); mat.pbrMetallicRoughness.baseColorTexture = { index: textures.length - 1 };
      }
      materials.push(mat);
      meshes.push({ name: it.name, primitives: [{ attributes: { POSITION: pa, NORMAL: na, TEXCOORD_0: ua }, indices: ia, material: materials.length - 1 }] });
      const node = { name: it.name, mesh: meshes.length - 1 };
      if (it.translation) node.translation = it.translation;
      if (it.rotationY) node.rotation = [0, Math.sin(it.rotationY / 2), 0, Math.cos(it.rotationY / 2)];
      if (it.scale && it.scale !== 1) node.scale = [it.scale, it.scale, it.scale];
      if (it.extras) node.extras = it.extras;
      nodes.push(node);
    }
    const json = {
      asset: { version: '2.0', generator: '空间内容工场 Spatial Content Works v1.0', extras: options.assetExtras || {} },
      scene: 0, scenes: [{ name: options.sceneName || 'Scene', nodes: nodes.map((_, i) => i), extras: options.sceneExtras || {} }],
      nodes, meshes, materials, accessors, bufferViews, buffers: [{ byteLength: offset }],
    };
    if (images.length) { json.images = images; json.textures = textures; json.samplers = [{ magFilter: 9729, minFilter: 9987 }]; textures.forEach(t => t.sampler = 0); }
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jlen = pad4(jsonBytes.length), blen = pad4(offset);
    const total = 12 + 8 + jlen + 8 + blen;
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jlen, true); dv.setUint32(16, 0x4E4F534A, true);
    out.set(jsonBytes, 20); for (let i = jsonBytes.length; i < jlen; i++) out[20 + i] = 0x20;
    let o = 20 + jlen; dv.setUint32(o, blen, true); dv.setUint32(o + 4, 0x004E4942, true); o += 8;
    for (const b of bufs) { out.set(b, o); o += b.length; }
    return out;
  }
  function readGLBJson(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const len = dv.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
  }

  // Radiance HDR (RGBE, 未压缩) — HDRI 导出
  function canvasToHDR(canvas, exposure) {
    const W = canvas.width, H = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const head = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nSOFTWARE=SpatialContentWorks\n\n-Y ${H} +X ${W}\n`);
    const body = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      let r = Math.pow(d[i * 4] / 255, 2.2) * (exposure || 1), g = Math.pow(d[i * 4 + 1] / 255, 2.2) * (exposure || 1), b = Math.pow(d[i * 4 + 2] / 255, 2.2) * (exposure || 1);
      const lum = r * 0.3 + g * 0.6 + b * 0.1; if (lum > 0.9) { r *= 6; g *= 6; b *= 6; } // 太阳高光提升动态范围
      const v = Math.max(r, g, b);
      if (v < 1e-32) continue;
      const e = Math.ceil(Math.log2(v) + 1e-9), f = 256 / Math.pow(2, e);
      body[i * 4] = Math.min(255, r * f); body[i * 4 + 1] = Math.min(255, g * f); body[i * 4 + 2] = Math.min(255, b * f); body[i * 4 + 3] = e + 128;
    }
    const out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length); return out;
  }
  // 等距柱状 → 鱼眼 domemaster（球幕）
  function equirectToDome(src, size) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const sctx = src.getContext('2d'), sd = sctx.getImageData(0, 0, src.width, src.height).data, SW = src.width, SH = src.height;
    const ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = (x / size) * 2 - 1, ny = (y / size) * 2 - 1, r = Math.hypot(nx, ny); const o = (y * size + x) * 4;
      if (r > 1) { img.data[o + 3] = 255; continue; }
      const theta = Math.atan2(ny, nx), phi = r * Math.PI / 2; // 天顶为圆心
      const u = ((theta / (2 * Math.PI)) + 1) % 1, v = (Math.PI / 2 - phi) / Math.PI; // 0..0.5 上半球
      const sx = Math.min(SW - 1, (u * SW) | 0), sy = Math.min(SH - 1, ((0.5 - v) * SH) | 0), so = (sy * SW + sx) * 4;
      img.data[o] = sd[so]; img.data[o + 1] = sd[so + 1]; img.data[o + 2] = sd[so + 2]; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0); return c;
  }

  // ---------- 人形角色（P08） ----------
  const SKELETON = [
    ['hips', null, [0, 0.95, 0]], ['spine', 'hips', [0, 0.18, 0]], ['chest', 'spine', [0, 0.2, 0]], ['neck', 'chest', [0, 0.2, 0]], ['head', 'neck', [0, 0.12, 0]],
    ['l_shoulder', 'chest', [0.17, 0.15, 0]], ['l_elbow', 'l_shoulder', [0.27, 0, 0]], ['l_hand', 'l_elbow', [0.25, 0, 0]],
    ['r_shoulder', 'chest', [-0.17, 0.15, 0]], ['r_elbow', 'r_shoulder', [-0.27, 0, 0]], ['r_hand', 'r_elbow', [-0.25, 0, 0]],
    ['l_hip', 'hips', [0.1, -0.02, 0]], ['l_knee', 'l_hip', [0, -0.44, 0]], ['l_foot', 'l_knee', [0, -0.44, 0]],
    ['r_hip', 'hips', [-0.1, -0.02, 0]], ['r_knee', 'r_hip', [0, -0.44, 0]], ['r_foot', 'r_knee', [0, -0.44, 0]],
  ];
  // 动作：返回各关节欧拉角 (x,z) 弧度
  const MOTIONS = {
    idle: { name: '待机呼吸', dur: 3, f: (t) => ({ chest: [Math.sin(t * 2) * 0.03, 0], l_shoulder: [0, -1.25], r_shoulder: [0, 1.25], l_elbow: [0, -0.1], r_elbow: [0, 0.1] }) },
    walk: { name: '行走', dur: 2, f: (t) => { const s = Math.sin(t * Math.PI * 2); return { l_hip: [s * 0.5, 0], r_hip: [-s * 0.5, 0], l_knee: [Math.max(0, -s) * 0.7, 0], r_knee: [Math.max(0, s) * 0.7, 0], l_shoulder: [-s * 0.4, -1.25], r_shoulder: [s * 0.4, 1.25], hips: [0, 0, Math.abs(s) * 0.03] }; } },
    wave: { name: '挥手致意', dur: 2.5, f: (t) => ({ l_shoulder: [0, -1.25], r_shoulder: [0, -0.3], r_elbow: [0, -1.4 + Math.sin(t * 8) * 0.35], chest: [0, 0] }) },
    point: { name: '指引讲解', dur: 3, f: (t) => ({ l_shoulder: [0, -1.25], r_shoulder: [-0.6, 0.1], r_elbow: [0, -0.1], head: [0, -0.3 * Math.min(1, t)] }) },
    bow: { name: '鞠躬', dur: 2.5, f: (t) => { const k = Math.sin(Math.min(1, t / 2.5) * Math.PI) * 0.7; return { spine: [k * 0.6, 0], chest: [k * 0.4, 0], l_shoulder: [0, -1.3], r_shoulder: [0, 1.3] }; } },
    intro: { name: '展开双臂介绍', dur: 3, f: (t) => { const k = Math.min(1, t / 1.2); return { l_shoulder: [-0.3 * k, -1.25 + 0.9 * k], r_shoulder: [-0.3 * k, 1.25 - 0.9 * k], l_elbow: [0, -0.4 * k], r_elbow: [0, 0.4 * k] }; } },
  };
  function motionFromText(text, seed) {
    const t = text || '';
    if (/挥手|招手|欢迎/.test(t)) return 'wave';
    if (/走|行进|漫步/.test(t)) return 'walk';
    if (/鞠躬|致谢|行礼/.test(t)) return 'bow';
    if (/指|讲解|介绍文物|指向/.test(t)) return 'point';
    if (/展开|张开|介绍/.test(t)) return 'intro';
    return ['point', 'intro', 'wave'][seed % 3];
  }
  function toBVH(clips, fps) {
    fps = fps || 30;
    const lines = ['HIERARCHY'];
    const children = {}; SKELETON.forEach(([n, p]) => { (children[p] = children[p] || []).push(n); });
    const off = {}; SKELETON.forEach(([n, , o]) => off[n] = o);
    const order = [];
    function emit(n, depth) {
      const ind = '  '.repeat(depth); order.push(n);
      lines.push(`${ind}${depth === 0 ? 'ROOT' : 'JOINT'} ${n}`, `${ind}{`, `${ind}  OFFSET ${off[n].map(v => (v * 100).toFixed(2)).join(' ')}`,
        `${ind}  CHANNELS ${depth === 0 ? '6 Xposition Yposition Zposition ' : '3 '}Zrotation Xrotation Yrotation`);
      if (children[n]) children[n].forEach(c => emit(c, depth + 1));
      else lines.push(`${ind}  End Site`, `${ind}  {`, `${ind}    OFFSET 0.00 5.00 0.00`, `${ind}  }`);
      lines.push(`${ind}}`);
    }
    emit('hips', 0);
    const frames = [];
    for (const c of clips) { const m = MOTIONS[c.motion]; const n = Math.round(c.duration * fps); for (let i = 0; i < n; i++) frames.push(m.f(i / fps)); }
    lines.push('MOTION', `Frames: ${frames.length}`, `Frame Time: ${(1 / fps).toFixed(6)}`);
    const deg = r => (r * 180 / Math.PI).toFixed(3);
    for (const f of frames) {
      const row = [];
      for (const n of order) { const a = f[n] || [0, 0]; if (n === 'hips') row.push('0.00', (95 + (a[2] || 0) * 100).toFixed(2), '0.00'); row.push(deg(a[1] || 0), deg(a[0] || 0), '0.000'); }
      lines.push(row.join(' '));
    }
    return lines.join('\n');
  }

  global.Geo = { rng, hash, CATS, CAT_ORDER, detectCategory, categoriesIn, buildMesh, textureCanvas, drawConcept, drawPanorama, seamScore, buildSplats, writeGLB, readGLBJson, canvasToHDR, equirectToDome, SKELETON, MOTIONS, motionFromText, toBVH, surface, lathRes };
})(typeof window !== 'undefined' ? window : globalThis);
