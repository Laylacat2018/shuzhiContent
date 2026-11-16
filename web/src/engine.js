/* 空间内容工场 · 业务引擎（演示版）
 * 实现 PRD 第二部分业务规则与 SPEC 第 3、4、9、10 章：
 *  - 许可证规则（提交时 / 导出时）、文博准确性规则、AIGC 标识规则
 *  - GPU 调度：单卡互斥、同模型合批（20 件 / 30 分钟）、置顶、夜间窗口、超限路由、OOM 降级重试
 *  - 任务状态机、审核返工规则（返工超过 2 次转人工）
 *  - Q01–Q09 质检规则、导出前 6 项检查、交付清单
 * 模型推理由确定性模拟代替（见 geometry.js），所有耗时按“演示加速倍率”压缩。
 */
(function (global) {
  'use strict';
  const Geo = global.Geo;
  const STORE_KEY = 'scw.state.v1';

  // ---------------- 字典 ----------------
  const ROLES = { pm: '产品 / 策划', artist: '3D 美术 / TD', reviewer: '审核人', admin: '管理员' };
  const SCOPES = { internal: '内部原型', commercial_cn: '对外商用 · 中国境内', commercial_overseas: '对外商用 · 出海' };
  const ALLOWED = { all: '全部项目', internal: '仅内部原型', disabled: '禁用' };
  const CONTENT_TYPES = { prop: '道具 / 陪衬资产', scene: '虚构场景', recon: '实景重建', character: '角色与动作', panorama: '全景 / 球幕' };
  const PLATFORMS = { quest3: 'Quest 3', pico4: 'PICO 4', webxr: 'WebXR', xr_space: 'XR 大空间', dome: '球幕' };
  const TASK_STATUS = { queued: '排队', running: '运行中', paused: '已暂停', failed: '失败', manual: '转人工', done: '已完成', canceled: '已取消', swapping: '换载中' };
  const JOB_STATUS = { draft: '草稿', submitted: '已提交', producing: '生产中', done: '已完成', canceled: '已取消' };
  const ASSET_STATUS = { generating: '3D 生成中', generated: '已生成', optimizing: '优化中', qa: '质检中', review: '待审核', rework: '返工', manual: '转人工', library: '已入库', exported: '已导出', discarded: '已废弃' };
  const NODE_NAMES = { concept_image: '概念图', image_to_3d: '3D 生成', mesh_optimize: '资产优化', auto_qa: '自动质检', panorama: '全景生成', world_gen: '世界生成', pose_solve: '位姿求解', gs_train: '3DGS 训练', rig: '自动绑骨', motion_gen: '文生动作', export: '导出', upscale: '全景超分' };
  const REWORK_REASONS = { geometry: '几何缺陷', texture: '贴图问题', scale: '比例或原点错误', style: '风格不符', other: '其他' };
  const REWORK_ROUTE = { geometry: 'image_to_3d', style: 'image_to_3d', texture: 'mesh_optimize', scale: 'mesh_optimize', other: 'mesh_optimize' };
  const COMMERCIAL_LICENSES = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0（工具）', '自有数据', '商用计费 API'];
  const STEPS = ['白盒布局', '静帧确认', '几何审计', '绑骨动画', '短预览', '最终输出'];
  const EXPORT_TARGETS = {
    webxr: { name: 'WebXR', fmt: 'GLB + 查看页', ver: 'V1.0' },
    raw: { name: '原始工程', fmt: '源文件 + Blender 导入脚本 + JSON 清单', ver: 'V1.0' },
    gs: { name: '3DGS 场景', fmt: 'PLY / glTF + KHR_gaussian_splatting', ver: 'V1.1' },
    dome: { name: '球幕', fmt: 'domemaster 4K', ver: 'V1.1' },
    quest: { name: 'Quest / PICO', fmt: 'Unity 工程包', ver: 'V1.2' },
    xr_space: { name: 'XR 大空间', fmt: 'UE 资产包', ver: 'V1.2' },
  };
  const VERSION_ORDER = { 'V1.0': 0, 'V1.1': 1, 'V1.2': 2 };
  const PERM = {
    'job.create': ['pm', 'artist', 'admin'], 'concept': ['pm', 'artist', 'admin'], 'gen3d': ['artist', 'admin'], 'optimize': ['artist', 'admin'],
    'scene.gen': ['artist', 'admin'], 'recon': ['artist', 'admin'], 'character': ['artist', 'admin'], 'assembly': ['pm', 'artist', 'admin'],
    'review': ['reviewer', 'admin'], 'manual.handle': ['artist', 'admin'], 'library': ['pm', 'artist', 'reviewer', 'admin'],
    'export': ['pm', 'artist', 'admin'], 'export.confirm': ['reviewer', 'admin'], 'task.control': ['pm', 'artist', 'admin'], 'admin': ['admin'],
  };
  const PERM_NAMES = { 'job.create': '创建 / 提交需求单', concept: '概念图生成与选图', gen3d: '3D 生成', optimize: '资产优化参数调整', 'scene.gen': '场景生成', recon: '实景重建', character: '角色动画', assembly: 'Agent 场景组装', review: '质检审核', 'manual.handle': '转人工处理', library: '资产库检索', export: '导出发布', 'export.confirm': '导出确认', 'task.control': '任务控制', admin: '系统设置' };

  // ---------------- 工具 ----------------
  const R = Geo.rng;
  function pad(n, w) { return String(n).padStart(w, '0'); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  class BizError extends Error { constructor(msg, code) { super(msg); this.code = code || 'rule'; } }
  const fail = (m, c) => { throw new BizError(m, c); };

  // ---------------- 初始数据 ----------------
  function seedModels() {
    const M = (o) => Object.assign({ disk_gb: 0, load_s: 20, unit_s: 10, location: 'local', region_restricted: false, license_status: '无需登记', status: '已安装', version: '', pbr: null, cost: 0, engine: '' }, o);
    return [
      M({ id: 'qwen-image-fp8', name: 'Qwen-Image fp8', version: '2025.08', purpose: '概念图', node: 'concept_image', license_type: 'Apache-2.0', allowed_scope: 'all', vram_gb: 20, disk_gb: 41, unit_s: 10, load_s: 28, engine: 'ComfyUI :8188' }),
      M({ id: 'flux-dev', name: 'FLUX.1-dev', version: '1.0', purpose: '概念图', node: 'concept_image', license_type: 'FLUX.1-dev 非商用许可', license_status: '待核对', allowed_scope: 'internal', vram_gb: 22, disk_gb: 34, unit_s: 14, load_s: 30, engine: 'ComfyUI :8188' }),
      M({ id: 'lora-bronze', name: '风格 LoRA · 青铜纹饰', version: 'v3', purpose: '风格 LoRA', node: 'lora', license_type: '自有数据', allowed_scope: 'all', vram_gb: 0.6, disk_gb: 0.3, engine: 'ComfyUI' }),
      M({ id: 'lora-palace', name: '风格 LoRA · 宫廷彩绘', version: 'v1', purpose: '风格 LoRA', node: 'lora', license_type: '自有数据', allowed_scope: 'all', vram_gb: 0.6, disk_gb: 0.3, engine: 'ComfyUI' }),
      M({ id: 'trellis2-4b', name: 'TRELLIS.2-4B', version: '2.0', purpose: '图生 3D', node: 'image_to_3d', license_type: 'MIT', allowed_scope: 'all', vram_gb: 16, disk_gb: 18, unit_s: 90, load_s: 35, pbr: true, engine: '独立推理服务 :8200' }),
      M({ id: 'hunyuan3d-21', name: 'Hunyuan3D 2.1（量化分进程）', version: '2.1', purpose: '图生 3D', node: 'image_to_3d', license_type: '腾讯混元社区许可', license_status: '待授权', region_restricted: true, allowed_scope: 'internal', vram_gb: 19, disk_gb: 50, unit_s: 110, load_s: 40, pbr: true, engine: '推理服务' }),
      M({ id: 'direct3d-s2', name: 'Direct3D-S2（1024）', version: '1.0', purpose: '图生 3D', node: 'image_to_3d', license_type: 'MIT', allowed_scope: 'all', vram_gb: 24, disk_gb: 22, unit_s: 120, load_s: 40, pbr: false, engine: '推理服务' }),
      M({ id: 'triposg', name: 'TripoSG', version: '1.0', purpose: '图生 3D', node: 'image_to_3d', license_type: 'MIT', allowed_scope: 'all', vram_gb: 8, disk_gb: 6, unit_s: 45, load_s: 15, pbr: false, engine: '推理服务' }),
      M({ id: 'step1x-3d', name: 'Step1X-3D（AutoDL A800）', version: '1.0', purpose: '图生 3D', node: 'image_to_3d', license_type: 'Apache-2.0', allowed_scope: 'all', vram_gb: 28, disk_gb: 0, unit_s: 150, location: 'cloud', pbr: true, cost_per_hour: 5.59, engine: 'AutoDL A800' }),
      M({ id: 'hunyuan-api', name: '腾讯云混元生 3D 专业版', version: 'API', purpose: '图生 3D', node: 'image_to_3d', license_type: '商用计费 API', allowed_scope: 'all', vram_gb: 0, unit_s: 120, location: 'api', pbr: true, cost: 2, engine: 'cloud.tencent.com' }),
      M({ id: 'birefnet', name: 'BiRefNet 去背景', version: '1.0', purpose: '去背景', node: 'rembg', license_type: 'MIT', allowed_scope: 'all', vram_gb: 2, disk_gb: 1, engine: 'ComfyUI' }),
      M({ id: 'blender', name: 'Blender 4.2 无头', version: '4.2 LTS', purpose: '优化 / 质检 / 导出', node: 'mesh_optimize', license_type: 'GPL-3.0（工具）', allowed_scope: 'all', vram_gb: 0, location: 'local-cpu', engine: 'blender -b' }),
      M({ id: 'instant-meshes', name: 'Instant Meshes', version: '2024', purpose: '重拓扑', node: 'tool', license_type: 'BSD-3-Clause', allowed_scope: 'all', vram_gb: 0, location: 'local-cpu' }),
      M({ id: 'xatlas', name: 'xatlas', version: '2024', purpose: 'UV 展开', node: 'tool', license_type: 'MIT', allowed_scope: 'all', vram_gb: 0, location: 'local-cpu' }),
      M({ id: 'qwen-360', name: 'Qwen-Image int4 + Qwen 360 LoRA', version: '1.0', purpose: '360 全景', node: 'panorama', license_type: 'Apache-2.0', license_status: '已登记授权', allowed_scope: 'all', vram_gb: 22, disk_gb: 24, unit_s: 60, load_s: 30, engine: 'ComfyUI :8188' }),
      M({ id: 'realesrgan', name: 'Real-ESRGAN 全景超分', version: 'x4', purpose: '超分到 8K', node: 'upscale', license_type: 'BSD-3-Clause', allowed_scope: 'all', vram_gb: 6, unit_s: 30, load_s: 8, engine: 'ComfyUI' }),
      M({ id: 'matrix-3d', name: 'Matrix-3D（AutoDL H800）', version: '1.0', purpose: '世界生成', node: 'world_gen', license_type: 'Matrix-3D 许可（待核对）', license_status: '待核对', allowed_scope: 'internal', vram_gb: 60, unit_s: 1800, location: 'cloud', cost_per_hour: 10, engine: 'AutoDL H800' }),
      M({ id: 'marble-api', name: 'World Labs Marble API（Pro）', version: 'API', purpose: '世界生成', node: 'world_gen', license_type: '商用计费 API', allowed_scope: 'all', vram_gb: 0, unit_s: 600, location: 'api', cost: 7.5, engine: 'marble.worldlabs.ai' }),
      M({ id: 'colmap', name: 'COLMAP', version: '3.11', purpose: '位姿求解', node: 'pose_solve', license_type: 'BSD-3-Clause', allowed_scope: 'all', vram_gb: 8, unit_s: 1200, load_s: 5, engine: 'colmap CLI' }),
      M({ id: 'lichtfeld', name: 'LichtFeld Studio CLI', version: '0.4', purpose: '3DGS 训练', node: 'gs_train', license_type: 'GPL-3.0（工具）', allowed_scope: 'all', vram_gb: 20, unit_s: 2400, load_s: 5, engine: '宿主机进程' }),
      M({ id: 'unirig', name: 'UniRig', version: '1.0', purpose: '自动绑骨', node: 'rig', license_type: '代码 MIT · 权重待核对', license_status: '待核对', allowed_scope: 'internal', vram_gb: 8, unit_s: 180, load_s: 15, engine: '推理服务' }),
      M({ id: 'hunyuan-motion-api', name: '腾讯云混元文生动作', version: 'API', purpose: '文生动作', node: 'motion_gen', license_type: '商用计费 API', allowed_scope: 'all', vram_gb: 0, unit_s: 60, location: 'api', cost: 1.5, engine: 'cloud.tencent.com' }),
      M({ id: 'hy-motion-local', name: 'HY-Motion 本地版', version: '1.0', purpose: '文生动作', node: 'motion_gen', license_type: '腾讯混元社区许可', license_status: '待授权', region_restricted: true, allowed_scope: 'internal', vram_gb: 14, unit_s: 40, load_s: 20 }),
      M({ id: 'claude-api', name: 'Claude（编排模型）', version: 'API', purpose: 'Agent 编排', node: 'llm', license_type: '商用计费 API', allowed_scope: 'all', vram_gb: 0, location: 'api' }),
      M({ id: 'qwen-llm-local', name: 'Qwen3-32B（llama.cpp 离线备用）', version: 'Q4_K_M', purpose: 'Agent 编排', node: 'llm', license_type: 'Apache-2.0', allowed_scope: 'all', vram_gb: 20, location: 'local', status: '未启用' }),
    ];
  }
  function seedPresets() {
    return {
      quest3: { name: 'Quest 3 道具', tris: 20000, tex: 1024, materials: 1, size_mb: 5, scene_tris: 1500000, drawcalls: 200, tex_mem_mb: 512, scene_materials: 64, src: '场景级：Meta 文档；单件：平台默认' },
      pico4: { name: 'PICO 4 道具', tris: 20000, tex: 1024, materials: 1, size_mb: 5, scene_tris: 1500000, drawcalls: 200, tex_mem_mb: 512, scene_materials: 64, src: '平台默认（参照 Quest 3）' },
      quest2: { name: 'Quest 2 / 低端一体机', tris: 10000, tex: 1024, materials: 1, size_mb: 4, scene_tris: 750000, drawcalls: 100, tex_mem_mb: 256, scene_materials: 32, src: '场景级：Meta 文档；单件：平台默认' },
      webxr: { name: 'WebXR 道具', tris: 10000, tex: 1024, materials: 1, size_mb: 3, scene_tris: 750000, drawcalls: 100, tex_mem_mb: 256, scene_materials: 32, src: '平台默认（Draco + KTX2）' },
      xr_space: { name: 'XR 大空间（PC 串流）', tris: 100000, tex: 2048, materials: 3, size_mb: 30, scene_tris: 6000000, drawcalls: 1000, tex_mem_mb: 4096, scene_materials: 256, src: '平台默认' },
      dome: { name: '球幕', tris: 100000, tex: 2048, materials: 3, size_mb: 30, scene_tris: 6000000, drawcalls: 1000, tex_mem_mb: 4096, scene_materials: 256, src: '平台默认' },
      custom: { name: '自定义', tris: 30000, tex: 2048, materials: 2, size_mb: 10, scene_tris: 1500000, drawcalls: 200, tex_mem_mb: 512, scene_materials: 64, src: '用户自定义' },
    };
  }
  const PLATFORM_PRESET = { quest3: 'quest3', pico4: 'pico4', webxr: 'webxr', xr_space: 'xr_space', dome: 'dome' };
  function seedTemplates() {
    return [
      { id: 'prop_batch_v1', name: '道具批量生产', content_type: 'prop', version: 1, nodes: [
        { id: 'concept', type: 'concept_image', model: 'qwen-image-fp8', params: { size: 1024, batch: 8, remove_bg: true } },
        { id: 'pick', type: 'human_gate', name: '人工选图', after: ['concept'] },
        { id: 'gen3d', type: 'image_to_3d', model: 'trellis2-4b', params: { resolution: 1024, texture: 2048, preview_render: false }, on_oom: { resolution: 512 }, after: ['pick'] },
        { id: 'optimize', type: 'mesh_optimize', model: 'blender', preset: '${job.platform_preset}', steps: ['decimate', 'remesh', 'uv', 'bake', 'compress'], after: ['gen3d'] },
        { id: 'qa', type: 'auto_qa', model: 'blender', preset: '${job.platform_preset}', after: ['optimize'] },
        { id: 'review', type: 'human_gate', name: '人工审核入库', after: ['qa'] }] },
      { id: 'scene_pano_v1', name: '虚构场景（全景 + 世界生成）', content_type: 'scene', version: 1, nodes: [
        { id: 'pano', type: 'panorama', model: 'qwen-360', params: { width: 4096, height: 2048 } },
        { id: 'pick', type: 'human_gate', name: '人工选图', after: ['pano'] },
        { id: 'world', type: 'world_gen', model: 'marble-api', after: ['pick'] },
        { id: 'qa', type: 'auto_qa', model: 'blender', after: ['world'] },
        { id: 'review', type: 'human_gate', name: '人工审核入库', after: ['qa'] }] },
      { id: 'pano_dome_v1', name: '全景 / 球幕', content_type: 'panorama', version: 1, nodes: [
        { id: 'pano', type: 'panorama', model: 'qwen-360', params: { width: 4096, height: 2048 } },
        { id: 'pick', type: 'human_gate', name: '人工选图', after: ['pano'] },
        { id: 'up', type: 'upscale', model: 'realesrgan', params: { target: '8K' }, after: ['pick'] },
        { id: 'export', type: 'export', model: 'blender', params: { target: 'dome' }, after: ['up'] }] },
      { id: 'recon_3dgs_v1', name: '实景重建（3DGS）', content_type: 'recon', version: 1, heritage_ok: true, nodes: [
        { id: 'pose', type: 'pose_solve', model: 'colmap' },
        { id: 'train', type: 'gs_train', model: 'lichtfeld', params: { iterations: 30000, sh: 3 }, after: ['pose'] },
        { id: 'clean', type: 'human_gate', name: '清理浮点', after: ['train'] },
        { id: 'qa', type: 'auto_qa', model: 'blender', after: ['clean'] },
        { id: 'review', type: 'human_gate', name: '人工审核入库', after: ['qa'] }] },
      { id: 'character_v1', name: '角色与动作', content_type: 'character', version: 1, nodes: [
        { id: 'rig', type: 'rig', model: 'unirig' },
        { id: 'motion', type: 'motion_gen', model: 'hunyuan-motion-api', after: ['rig'] },
        { id: 'review', type: 'human_gate', name: '真机测试', after: ['motion'] }] },
    ];
  }
  const GEN_NODES = ['concept_image', 'image_to_3d', 'panorama', 'world_gen', 'motion_gen', 'upscale'];

  function freshState() {
    const now = Date.now();
    return {
      schema: 1, seq: 100, clock: now, lastSample: 0, speed: 15, release: 'V1.2',
      users: [
        { id: 'u_pm', name: '林策划', role: 'pm' }, { id: 'u_art', name: '周美术', role: 'artist' },
        { id: 'u_rev', name: '陈审核', role: 'reviewer' }, { id: 'u_admin', name: '王管理', role: 'admin' }],
      currentUserId: 'u_pm',
      projects: [
        { id: 'p_lz', name: '良渚玉器数字展厅', usage_scope: 'commercial_cn', default_platforms: ['quest3', 'webxr'], client: '某省级博物馆' },
        { id: 'p_sl', name: '丝路驼队 VR 导览（海外巡展）', usage_scope: 'commercial_overseas', default_platforms: ['pico4', 'webxr'], client: '海外巡展合作方' },
        { id: 'p_lab', name: '内部技术预研', usage_scope: 'internal', default_platforms: ['quest3'], client: '内部' }],
      currentProjectId: 'p_lz',
      models: seedModels(), licenses: [
        { id: 'lic_1', model_id: 'qwen-360', file_name: 'Qwen360-LoRA-授权核对记录.pdf', confirmed_by: '王管理', confirmed_at: now - 4 * 864e5, valid_until: '2027-11-10' },
        { id: 'lic_2', model_id: 'marble-api', file_name: 'WorldLabs-Pro-订阅合同.pdf', confirmed_by: '王管理', confirmed_at: now - 9 * 864e5, valid_until: '2027-05-01' }],
      settings: {
        rules: { submitCheck: true, exportCheck: true, heritageLock: true },
        presets: seedPresets(),
        llm: { orchestrator: 'claude-api', offline: 'qwen-llm-local', mcp: ['MCP for Blender @ 127.0.0.1:9876', 'pipeline-mcp'], pythonConfirm: true, dataLocal: true, maxToolCalls: 40 },
        cloud: { provider: 'AutoDL', image: 'scw-worker:1.0', idleShutdownMin: 10, maxRunHours: 6, keySet: true, tencentKeySet: true, marbleKeySet: true },
        storage: { models: { path: '/data/models', totalGb: 2000, usedGb: 312 }, assets: { path: '/data/assets', totalGb: 2000, usedGb: 486 }, alertPct: 85, backupDays: 14 },
        autoOptimize: true, aigcVisible: true, nightWindow: [22, 7],
      },
      templates: seedTemplates(),
      jobs: [], tasks: [], concepts: [], assets: [], versions: [], qa: [], reviews: [], scenes: [], panoramas: [], recon: [], characters: [], exports: [],
      audit: [], alerts: [], schedule: [],
      gpu: { loaded: null, history: [], util: 0, temp: 41, power: 62, swapping: null, batchModel: null, batchCount: 0, batchStart: 0, viewportOpen: false },
      cloudNodes: [], cloudCostMonth: 186.4,
    };
  }

  // ---------------- 引擎 ----------------
  const E = { S: null, listeners: [], events: [], BizError };
  E.dict = { ROLES, SCOPES, ALLOWED, CONTENT_TYPES, PLATFORMS, TASK_STATUS, JOB_STATUS, ASSET_STATUS, NODE_NAMES, REWORK_REASONS, STEPS, EXPORT_TARGETS, PERM, PERM_NAMES, VERSION_ORDER };
  E.on = (fn) => { E.listeners.push(fn); return () => { E.listeners = E.listeners.filter(f => f !== fn); }; };
  function emit(type, payload) { const ev = { type, payload, t: E.S.clock }; E.events.push(ev); if (E.events.length > 300) E.events.shift(); E.listeners.forEach(f => { try { f(ev); } catch (e) { console.error(e); } }); }
  E.emit = emit;
  const id = (p) => p + '_' + (++E.S.seq).toString(36);
  E.now = () => E.S.clock;
  E.user = () => E.S.users.find(u => u.id === E.S.currentUserId);
  E.project = (pid) => E.S.projects.find(p => p.id === (pid || E.S.currentProjectId));
  E.model = (mid) => E.S.models.find(m => m.id === mid);
  // 需求单可单独指定使用范围；未指定时取项目
  E.scopeOf = function (pid, jid) { const p = E.project(pid); const j = jid && E.S.jobs.find(x => x.id === jid); return Object.assign({}, p, j && j.usage_scope ? { usage_scope: j.usage_scope } : {}); };
  E.can = (perm, role) => (PERM[perm] || []).includes(role || E.user().role);
  function need(perm) { if (!E.can(perm)) fail(`当前角色（${ROLES[E.user().role]}）无权执行：${PERM_NAMES[perm] || perm}`, 'forbidden'); }
  function audit(action, object, detail) { E.S.audit.unshift({ id: id('au'), actor: E.user().name, role: E.user().role, action, object, detail: detail || '', time: E.S.clock }); if (E.S.audit.length > 800) E.S.audit.length = 800; }
  E.audit = audit;
  function alert(level, message, link) {
    const a = { id: id('al'), level, message, link, time: E.S.clock, read: false };
    E.S.alerts.unshift(a); if (E.S.alerts.length > 80) E.S.alerts.length = 80; emit('system.alert', a);
  }
  E.alert = alert;

  // ---------- 许可证规则 ----------
  E.modelAllowed = function (m, project) {
    if (typeof m === 'string') m = E.model(m);
    project = project || E.project();
    if (!m) return { ok: false, reason: '模型未登记' };
    if (m.allowed_scope === 'disabled') return { ok: false, reason: '管理员已禁用' };
    if (m.status === '未启用') return { ok: false, reason: '未启用' };
    if (project.usage_scope === 'internal') return { ok: true };
    if (m.allowed_scope !== 'all') return { ok: false, reason: m.license_status === '待核对' ? '许可待核对，仅内部原型可用' : m.license_status === '待授权' ? `${m.license_type}：未登记书面授权，仅内部原型可用` : '允许范围为仅内部原型' };
    const commercialOk = COMMERCIAL_LICENSES.includes(m.license_type) || m.license_status === '已登记授权';
    if (!commercialOk) return { ok: false, reason: `${m.license_type} 不允许对外商用` };
    if (project.usage_scope === 'commercial_overseas' && m.region_restricted) return { ok: false, reason: '社区许可排除欧盟 / 英国 / 韩国，出海项目不可用' };
    return { ok: true };
  };
  E.modelsFor = function (node, project) {
    return E.S.models.filter(m => m.node === node).map(m => Object.assign({ m }, E.modelAllowed(m, project)));
  };
  // 许可链逐项对照项目使用范围（Q08、导出检查共用）
  E.chainCheck = function (chain, project) {
    const bad = [];
    for (const c of chain || []) { const r = E.modelAllowed(c.model_id, project); if (!r.ok && !c.tool) bad.push({ stage: c.stage, model: c.model_name, reason: r.reason }); }
    return { ok: bad.length === 0, bad };
  };

  // ---------- 预算 / 管线预览 ----------
  E.strictestPreset = function (platforms) {
    const P = E.S.settings.presets; let best = null;
    for (const p of platforms || []) { const k = PLATFORM_PRESET[p]; if (!k) continue; if (!best || P[k].tris < P[best].tris) best = k; }
    return best || 'quest3';
  };
  E.templateFor = (contentType) => E.S.templates.find(t => t.content_type === contentType);
  E.precheck = function (draft) {
    const project = Object.assign({}, E.project(draft.project_id), draft.usage_scope ? { usage_scope: draft.usage_scope } : {});
    const ct = draft.is_heritage ? 'recon' : draft.content_type;
    const tpl = E.templateFor(ct);
    const presetKey = E.strictestPreset(draft.platforms);
    const preset = E.S.settings.presets[presetKey];
    const excluded = [], nodes = [];
    let unitGpu = 0, unitTotal = 0, peakVram = 0, humanGates = 0, blocked = [];
    for (const n of tpl.nodes) {
      if (n.type === 'human_gate') { humanGates++; nodes.push({ id: n.id, type: n.type, name: n.name, human: true }); continue; }
      if (draft.is_heritage && GEN_NODES.includes(n.type)) { blocked.push(`${NODE_NAMES[n.type]}：文物本体不可使用生成类节点`); continue; }
      const cands = E.modelsFor(n.type, project);
      cands.filter(c => !c.ok).forEach(c => excluded.push({ node: NODE_NAMES[n.type], model: c.m.name, reason: c.reason }));
      let pick = cands.find(c => c.m.id === (draft.models && draft.models[n.type]) && c.ok) || cands.find(c => c.m.id === n.model && c.ok) || cands.find(c => c.ok);
      if (!pick && n.type === 'auto_qa') pick = { m: E.model('blender'), ok: true };
      if (!pick && n.type === 'export') pick = { m: E.model('blender'), ok: true };
      if (!pick) { blocked.push(`${NODE_NAMES[n.type]}：没有满足“${SCOPES[project.usage_scope]}”的可用模型`); nodes.push({ id: n.id, type: n.type, name: NODE_NAMES[n.type], model: null }); continue; }
      const m = pick.m;
      const queue = routeQueue(n.type, m);
      const unit = n.type === 'auto_qa' ? 8 : n.type === 'mesh_optimize' ? 150 : n.type === 'concept_image' ? m.unit_s * 2 : m.unit_s; // 概念图：每件约 2 张候选
      if (queue === 'gpu') { unitGpu += unit; peakVram = Math.max(peakVram, m.vram_gb); }
      unitTotal += unit;
      nodes.push({ id: n.id, type: n.type, name: NODE_NAMES[n.type], model: m.id, model_name: m.name, queue, vram: m.vram_gb, unit_s: unit, license: m.license_type, location: m.location, cost: m.cost });
    }
    const qty = Math.max(1, draft.quantity | 0);
    return {
      template: tpl.id, template_name: tpl.name, content_type: ct, preset: presetKey, preset_name: preset.name, budget: preset,
      nodes, excluded, blocked, ok: blocked.length === 0, humanGates,
      est_gpu_s: qty * unitGpu, est_total_s: qty * unitTotal, peak_vram: peakVram,
      locked_recon: !!draft.is_heritage,
    };
  };
  function routeQueue(node, m) {
    if (!m) return 'cpu';
    if (m.location === 'api' || m.location === 'cloud') return 'cloud';
    if (m.location === 'local-cpu' || ['mesh_optimize', 'auto_qa', 'export'].includes(node)) return 'cpu';
    if (m.vram_gb > 23) return E.S.settings.cloud.keySet ? 'cloud' : 'reject'; // 超限路由
    return 'gpu';
  }
  E.routeQueue = routeQueue;

  // ---------- 需求单 ----------
  E.createJob = function (d) {
    need('job.create');
    if (!d.title) fail('请填写需求名称');
    if (d.is_heritage === undefined || d.is_heritage === null) fail('“是否文物本体”为必填项');
    if (!d.platforms || !d.platforms.length) fail('请至少选择一个目标平台');
    if (d.content_type && !CONTENT_TYPES[d.content_type]) fail('内容类型取值：' + Object.keys(CONTENT_TYPES).join('、'));
    if (d.platforms.some(p => !PLATFORMS[p])) fail('目标平台取值：' + Object.keys(PLATFORMS).join('、'));
    if (d.usage_scope && !SCOPES[d.usage_scope]) fail('使用范围取值：' + Object.keys(SCOPES).join('、'));
    if (d.project_id && !E.S.projects.some(p => p.id === d.project_id)) fail('项目不存在');
    const job = Object.assign({ id: id('job'), code: 'REQ-' + pad(E.S.jobs.length + 1, 4), project_id: E.S.currentProjectId, status: 'draft', created_by: E.user().name, created_at: E.S.clock, quantity: 1, style_lora: '', ref_images: [], content_type: 'prop' }, clone(d));
    job.quantity = Math.max(1, Math.min(500, job.quantity | 0));
    if (job.is_heritage) job.content_type = 'recon';
    E.S.jobs.unshift(job); audit('创建需求单', job.code, job.title); emit('job.state', job);
    return job;
  };
  E.updateJob = function (jid, d) { const j = E.job(jid); if (j.status !== 'draft') fail('仅草稿可编辑'); Object.assign(j, clone(d)); if (j.is_heritage) j.content_type = 'recon'; return j; };
  E.job = (jid) => E.S.jobs.find(j => j.id === jid) || fail('需求单不存在');
  E.submitJob = function (jid) {
    need('job.create');
    const job = E.job(jid);
    if (job.status !== 'draft') fail('需求单已提交');
    const pre = E.precheck(job);
    if (E.S.settings.rules.submitCheck && !pre.ok) { audit('需求单提交被拒', job.code, pre.blocked.join('；')); fail('提交被拒：' + pre.blocked.join('；'), 'license'); }
    job.status = 'submitted'; job.template_id = pre.template; job.preset = pre.preset; job.precheck = pre; job.submitted_at = E.S.clock;
    job.nodeModels = {}; pre.nodes.forEach(n => { if (n.model) job.nodeModels[n.type] = n.model; });
    audit('提交需求单', job.code, `${pre.template_name} · ${job.quantity} 件 · 预算 ${pre.preset_name}`);
    // 拆分任务
    if (pre.content_type === 'prop') {
      const prompt = job.description || job.title;
      const batches = Math.max(1, Math.ceil(job.quantity * 1.5 / 8));
      const batchLimit = E.S.runtime?.mode === 'production' ? batches : Math.min(batches, 6);
      for (let b = 0; b < batchLimit; b++) enqueue({ job_id: job.id, node: 'concept_image', model_id: job.nodeModels.concept_image, params: { prompt, negative: '模糊，低清，多余物体，文字水印', size: 1024, batch: 8, remove_bg: true, three_view: false, lora: job.style_lora || '', lora_weight: 0.8, seed: (Geo.hash(job.id) + b * 101) % 99999 } });
    }
    job.status = 'producing';
    emit('job.state', job);
    return job;
  };
  E.cancelJob = function (jid) { const j = E.job(jid); j.status = 'canceled'; E.S.tasks.filter(t => t.job_id === jid && ['queued', 'paused', 'running'].includes(t.status)).forEach(t => cancelTask(t)); audit('取消需求单', j.code); };
  E.deleteJob = function (jid) { const j = E.job(jid); if (j.status !== 'draft') fail('仅草稿可删除'); E.S.jobs = E.S.jobs.filter(x => x !== j); audit('删除需求单', j.code); };
  function heritageGuard(job, node) {
    if (job && job.is_heritage && E.S.settings.rules.heritageLock && GEN_NODES.includes(node)) { audit('文博规则拒绝', job.code, NODE_NAMES[node]); fail('文物本体需求单只能使用实景重建模板，生成类节点不可用', 'heritage'); }
  }

  // ---------- 任务 ----------
  function estimate(node, m, params) {
    if (node === 'concept_image') return (m.unit_s) * (params.batch || 8) * (params.three_view ? 1.6 : 1);
    if (node === 'image_to_3d') return m.unit_s * ((params.resolution || 1024) >= 1024 ? 1 : 0.55) * ((params.steps || 25) / 25);
    if (node === 'mesh_optimize') return 90 + (params.manual ? 30 : 0) + (params.batchIdx || 0) % 3 * 20;
    if (node === 'auto_qa') return 6;
    if (node === 'panorama') return m.unit_s * (params.count || 4) * (params.width >= 8192 ? 2 : 1);
    if (node === 'upscale') return m.unit_s;
    if (node === 'pose_solve') return Math.round(m.unit_s * (params.photos || 400) / 400);
    if (node === 'gs_train') return Math.round(m.unit_s * (params.photos || 400) / 400 * (params.iterations || 30000) / 30000);
    if (node === 'rig') return m.unit_s;
    if (node === 'motion_gen') return m.unit_s;
    if (node === 'world_gen') return m.unit_s;
    if (node === 'export') return 40 + (params.items || 1) * 4;
    return 30;
  }
  function enqueue(t) {
    const m = E.model(t.model_id) || E.model('blender');
    const queue = t.queue || routeQueue(t.node, m);
    if (queue === 'reject') fail(`${m.name} 登记显存 ${m.vram_gb}GB 超过本机上限且未配置云端，已拒绝`);
    const est = estimate(t.node, m, t.params || {});
    const task = Object.assign({
      id: id('t'), code: 'T' + pad(E.S.seq, 5), status: 'queued', priority: est > 3600 ? 'night' : 'normal', retry_count: 0, oom_retry: 0,
      vram_peak: 0, duration: est, elapsed: 0, progress: 0, executor: queue === 'cloud' ? 'cloud' : queue === 'cpu' ? 'local-cpu' : 'local', cost: 0,
      log: [], created_at: E.S.clock, created_by: E.user().name, queue, started_at: null, finished_at: null, metrics: {},
    }, t);
    task.log.push(logLine(`创建任务：${NODE_NAMES[task.node]} · ${m.name} · 预计 ${fmtDur(est)}${task.priority === 'night' ? ' · 预计超过 60 分钟，已排入夜间窗口 22:00–07:00' : ''}`));
    E.S.tasks.unshift(task);
    emit('task.state', { task_id: task.id, status: task.status });
    return task;
  }
  E.enqueue = enqueue;
  function logLine(s) { return `[${new Date(E.S.clock).toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`; }
  function fmtDur(s) { s = Math.round(s); if (s < 60) return s + ' 秒'; if (s < 3600) return Math.round(s / 60) + ' 分钟'; return (s / 3600).toFixed(1) + ' 小时'; }
  E.fmtDur = fmtDur;
  E.task = (tid) => E.S.tasks.find(t => t.id === tid) || fail('任务不存在');
  function cancelTask(t) {
    const wasRunning = t.status === 'running';
    t.status = 'canceled'; t.finished_at = E.S.clock; t.log.push(logLine('任务已取消' + (wasRunning ? '，已释放显存' : '')));
    if (wasRunning && t.queue === 'gpu') { E.S.gpu.running = null; E.S.gpu.util = 0; }
    onTaskEnded(t);
  }
  E.taskAction = function (tid, action) {
    need('task.control');
    const t = E.task(tid);
    if (E.user().role === 'pm' && t.created_by !== E.user().name) fail('产品 / 策划仅可操作本人创建的任务', 'forbidden');
    const ok = { pause: ['queued'], resume: ['paused'], cancel: ['queued', 'paused', 'running'], retry: ['failed', 'manual', 'canceled'], pin: ['queued', 'paused'], now: ['queued'] };
    if (!ok[action] || !ok[action].includes(t.status)) fail(`当前状态“${TASK_STATUS[t.status]}”不可执行该操作`);
    if (action === 'pause') { t.status = 'paused'; t.log.push(logLine('人工暂停')); }
    if (action === 'resume') { t.status = 'queued'; t.log.push(logLine('恢复排队')); }
    if (action === 'cancel') cancelTask(t);
    if (action === 'pin') { t.priority = 'pin'; t.pinned_at = E.S.clock; t.log.push(logLine('置顶：当前批次结束后优先执行')); }
    if (action === 'now') { t.priority = 'normal'; t.log.push(logLine('改为立即执行')); }
    if (action === 'retry') { t.status = 'queued'; t.elapsed = 0; t.progress = 0; t.retry_count++; t.error = null; t.log.push(logLine('人工重试（沿用原参数）')); if (t.asset_id) { const a = E.asset(t.asset_id); if (a.status === 'manual') a.status = t.node === 'image_to_3d' ? 'generating' : 'optimizing'; } }
    audit('任务' + { pause: '暂停', resume: '恢复', cancel: '取消', retry: '重试', pin: '置顶', now: '立即执行' }[action], t.code, NODE_NAMES[t.node]);
    emit('task.state', { task_id: t.id, status: t.status });
    return t;
  };

  // ---------- 调度器 ----------
  function inNight(ts) { const h = new Date(ts).getHours(); const [a, b] = E.S.settings.nightWindow; return h >= a || h < b; }
  function pickGpuTask() {
    const S = E.S;
    const q = S.tasks.filter(t => t.queue === 'gpu' && t.status === 'queued' && (t.priority !== 'night' || inNight(S.clock)));
    if (!q.length) return null;
    const oldest = (arr) => arr.reduce((a, b) => (a.created_at <= b.created_at ? a : b));
    const pinned = q.filter(t => t.priority === 'pin');
    if (pinned.length) return pinned.reduce((a, b) => (a.pinned_at <= b.pinned_at ? a : b));
    const g = S.gpu;
    const batchOpen = g.loaded && g.batchCount < 20 && (S.clock - g.batchStart) < 30 * 60 * 1000 / 1; // 30 分钟（模拟时间）
    const same = q.filter(t => t.model_id === g.loaded);
    if (same.length && (batchOpen || q.every(t => t.model_id === g.loaded))) return oldest(same);
    // 批次到达上限：让出给其他模型，避免饿死
    const others = q.filter(t => t.model_id !== g.loaded);
    return oldest(others.length ? others : q);
  }
  function segment(lane, kind, label, model, start, end, taskId) {
    const segs = E.S.schedule;
    const last = segs[segs.length - 1];
    if (last && last.lane === lane && last.kind === kind && last.taskId === taskId && last.end >= start - 1500) { last.end = end; return; }
    segs.push({ lane, kind, label, model, start, end, taskId }); if (segs.length > 600) segs.splice(0, segs.length - 600);
  }
  // 推进模拟：simDt 为模拟秒，realMs 为对应的时钟毫秒
  function advance(simDt, realMs) {
    const S = E.S; const g = S.gpu;
    S.clock += realMs;
    // --- GPU 单卡 ---
    if (g.swapping) {
      g.swapping.left -= simDt;
      segment('gpu', 'swap', '换载 → ' + (E.model(g.swapping.to) || {}).name, null, S.clock - realMs, S.clock);
      if (g.swapping.left <= 0) {
        g.loaded = g.swapping.to; g.batchModel = g.loaded; g.batchCount = 0; g.batchStart = S.clock;
        const t = S.tasks.find(x => x.id === g.swapping.task);
        if (t) t.log.push(logLine(`换载完成：空闲显存校验通过（≥ ${(E.model(g.loaded).vram_gb + 1).toFixed(0)}GB），已加载 ${E.model(g.loaded).name}`));
        g.swapping = null;
      }
    } else {
      let run = S.tasks.find(t => t.queue === 'gpu' && t.status === 'running');
      if (!run) {
        const next = pickGpuTask();
        if (next) {
          if (next.model_id !== g.loaded) {
            g.swapping = { from: g.loaded, to: next.model_id, left: (E.model(next.model_id).load_s || 20) + (g.loaded ? 6 : 0), task: next.id };
            next.log.push(logLine(g.loaded ? `调度：卸载 ${E.model(g.loaded).name}，加载 ${E.model(next.model_id).name}` : `调度：加载 ${E.model(next.model_id).name}`));
            if (E.model(next.model_id).vram_gb > 20 && g.viewportOpen) alert('info', 'GPU 任务需求超过 20GB，已通知场景组装视口切换到实体模式并暂停渲染', 'assembly');
          } else startTask(next);
        }
      }
      run = S.tasks.find(t => t.queue === 'gpu' && t.status === 'running');
      if (run) stepTask(run, simDt, realMs);
    }
    // --- CPU 池（并发 3） ---
    let cpuRun = S.tasks.filter(t => t.queue === 'cpu' && t.status === 'running');
    if (cpuRun.length < 3) {
      const q = S.tasks.filter(t => t.queue === 'cpu' && t.status === 'queued').sort((a, b) => (b.priority === 'pin') - (a.priority === 'pin') || a.created_at - b.created_at);
      q.slice(0, 3 - cpuRun.length).forEach(startTask);
    }
    S.tasks.filter(t => t.queue === 'cpu' && t.status === 'running').forEach(t => stepTask(t, simDt, realMs));
    // --- 云端 ---
    S.tasks.filter(t => t.queue === 'cloud' && t.status === 'queued' && (t.priority !== 'night' || inNight(S.clock))).forEach(t => {
      const m = E.model(t.model_id);
      if (m.location === 'cloud') {
        let node = S.cloudNodes.find(n => n.state !== 'off' && !n.task && n.type === m.engine);
        if (!node) { node = { id: id('cn'), name: m.engine + ' #' + (S.cloudNodes.length + 1), type: m.engine, rate: m.cost_per_hour, state: 'booting', boot: 60, started: S.clock, runSec: 0, cost: 0, idleSec: 0, task: null }; S.cloudNodes.unshift(node); t.log.push(logLine(`云节点开机：${node.name}（¥${m.cost_per_hour}/小时）`)); }
        if (node.state === 'booting' && node.task && node.task !== t.id) return;
        node.task = t.id; t.cloud_node = node.id;
        if (node.state === 'on') startTask(t);
      } else startTask(t);
    });
    S.cloudNodes.forEach(n => {
      if (n.state === 'off') return;
      n.runSec += simDt; n.cost = +(n.runSec / 3600 * n.rate).toFixed(2);
      if (n.state === 'booting') { n.boot -= simDt; if (n.boot <= 0) { n.state = 'on'; const t = S.tasks.find(x => x.id === n.task); if (t && t.status === 'queued') startTask(t); } return; }
      const t = S.tasks.find(x => x.id === n.task);
      if (t && t.status !== 'running' && t.status !== 'queued') { n.task = null; }
      if (!n.task) { n.idleSec += simDt; if (n.idleSec > S.settings.cloud.idleShutdownMin * 60) { n.state = 'off'; n.stopped = S.clock; S.cloudCostMonth = +(S.cloudCostMonth + n.cost).toFixed(2); alert('info', `云节点 ${n.name} 空闲超过 ${S.settings.cloud.idleShutdownMin} 分钟，已自动关机（本次 ¥${n.cost}）`, 'queue'); } }
      else n.idleSec = 0;
    });
    S.tasks.filter(t => t.queue === 'cloud' && t.status === 'running').forEach(t => stepTask(t, simDt, realMs));
    // --- Agent 流式输出 ---
    S.scenes.forEach(sc => { if (sc.agentQueue && sc.agentQueue.length) { sc.agentWait = (sc.agentWait || 0) - realMs; while (sc.agentQueue.length && sc.agentWait <= 0) { const ev = sc.agentQueue.shift(); applyAgentEvent(sc, ev); sc.agentWait += ev.delay || 350; } } });
    // --- GPU 指标（每 2 秒） ---
    if (S.clock - S.lastSample >= 2000) {
      S.lastSample = S.clock;
      const runT = S.tasks.find(t => t.queue === 'gpu' && t.status === 'running');
      const lm = g.loaded ? E.model(g.loaded) : null;
      let vram = 0.8 + (g.viewportOpen ? 3 : 0);
      if (g.swapping) vram += (lm ? lm.vram_gb * 0.5 : 0) + 4 * Math.random();
      else if (lm) vram += lm.vram_gb * 0.92 + (runT ? (runT.vram_peak_target || lm.vram_gb) - lm.vram_gb * 0.92 : 0) * (runT ? 0.6 + 0.4 * Math.sin(runT.progress * 9) : 0);
      vram = Math.min(24, Math.max(0.6, vram));
      g.util = runT ? 92 + Math.random() * 7 : g.swapping ? 35 : 2; g.temp = Math.round(g.temp + ((runT ? 74 : 44) - g.temp) * 0.15); g.power = Math.round(runT ? 380 + Math.random() * 60 : g.swapping ? 150 : 60);
      g.history.push({ t: S.clock, vram: +vram.toFixed(2), util: Math.round(g.util), temp: g.temp, power: g.power, model: g.loaded });
      if (g.history.length > 900) g.history.splice(0, g.history.length - 900);
      emit('gpu.metrics', g.history[g.history.length - 1]);
      if (g.temp > 85) alert('warn', `GPU 温度 ${g.temp}℃ 超过 85℃`, 'queue');
    }
  }
  function startTask(t) {
    const m = E.model(t.model_id) || {};
    t.status = 'running'; t.started_at = t.started_at || E.S.clock;
    t.vram_peak_target = t.queue === 'gpu' ? (t.node === 'image_to_3d' && t.params.preview_render ? 30 : m.vram_gb) : 0;
    if (t.queue === 'gpu') { E.S.gpu.batchCount++; }
    t.log.push(logLine(`开始执行 @ ${t.queue === 'gpu' ? '本地 GPU（RTX 4090 24GB）' : t.queue === 'cpu' ? '本地 CPU 池' : '云端 ' + (m.engine || '')}`));
    if (t.asset_id) { const a = E.S.assets.find(x => x.id === t.asset_id); if (a && t.node === 'mesh_optimize') a.status = 'optimizing'; if (a && t.node === 'auto_qa') a.status = 'qa'; }
    emit('task.state', { task_id: t.id, status: 'running' });
  }
  function stepTask(t, simDt, realMs) {
    const m = E.model(t.model_id) || {};
    t.elapsed += simDt; t.progress = Math.min(1, t.elapsed / t.duration);
    const lane = t.queue === 'gpu' ? 'gpu' : t.queue === 'cpu' ? 'cpu' : 'cloud';
    segment(lane, 'task', NODE_NAMES[t.node], t.model_id, E.S.clock - realMs, E.S.clock, t.id);
    if (t.queue === 'gpu') t.vram_peak = Math.max(t.vram_peak, Math.min(24, t.vram_peak_target));
    if (m.location === 'api') t.cost = m.cost;
    if (t.cloud_node) { const n = E.S.cloudNodes.find(x => x.id === t.cloud_node); if (n) t.cost = +(t.elapsed / 3600 * n.rate).toFixed(2); }
    // OOM：预览渲染峰值约 30GB > 24GB，或高分辨率偶发溢出
    if (t.node === 'image_to_3d' && t.queue === 'gpu' && t.progress > 0.55 && !t._oomChecked) {
      t._oomChecked = true;
      const forced = t.params.preview_render || (t.params.resolution >= 1024 && t.params.force_oom);
      if (forced) {
        t.log.push(logLine(`CUDA out of memory：显存峰值 ${t.params.preview_render ? '29.6' : '24.1'}GB 超过 24GB`));
        if (t.oom_retry < 1 && t.params.resolution > 512) {
          t.oom_retry++; t.params = Object.assign({}, t.params, { resolution: 512, preview_render: false, force_oom: false });
          t.elapsed = 0; t.progress = 0; t._oomChecked = false; t.status = 'queued'; t.vram_peak_target = m.vram_gb;
          E.S.gpu.loaded = null; // 释放模型
          t.log.push(logLine('OOM 处理：已释放模型，体素分辨率 1024³ → 512³ 自动降级重试 1 次'));
          emit('task.state', { task_id: t.id, status: 'queued', reason: 'OOM 降级重试' });
        } else {
          t.status = 'manual'; t.finished_at = E.S.clock; t.error = '显存溢出，降级重试仍失败'; t.log.push(logLine('降级重试仍失败，状态置为转人工'));
          E.S.gpu.loaded = null;
          const a = E.S.assets.find(x => x.id === t.asset_id); if (a) a.status = 'manual';
          alert('error', `${t.code} 3D 生成显存溢出，已转人工`, 'queue');
          emit('task.state', { task_id: t.id, status: 'manual', reason: t.error });
          onTaskEnded(t);
        }
        return;
      }
    }
    if (t.node === 'gs_train') { const it = Math.round(t.progress * (t.params.iterations || 30000)); t.metrics = { iteration: it, psnr: +(18 + 12.5 * (1 - Math.exp(-t.progress * 4)) + Math.sin(it / 700) * 0.15).toFixed(2), splats: Math.round(Math.min(t.params.splat_limit || 3e6, 2.6e6 * Math.min(1, t.progress * 1.6))) }; }
    if (t.node === 'mesh_optimize') { t.metrics = { step: Math.min(4, Math.floor(t.progress * 5)) }; }
    emit('task.progress', { task_id: t.id, percent: Math.round(t.progress * 100), eta: (t.duration - t.elapsed), metrics: t.metrics });
    if (t.progress >= 1) {
      try { complete(t); t.status = t.status === 'running' ? 'done' : t.status; }
      catch (e) { console.error(e); t.status = t.retry_count < 1 ? 'queued' : 'failed'; t.retry_count++; t.error = e.message; t.log.push(logLine('执行出错：' + e.message + (t.status === 'queued' ? '，自动重试 1 次' : ''))); if (t.status === 'failed') alert('error', `${t.code} ${NODE_NAMES[t.node]} 失败：${e.message}`, 'queue'); }
      t.finished_at = E.S.clock; t.log.push(logLine(`完成，用时 ${fmtDur(t.elapsed)}${t.vram_peak ? '，显存峰值 ' + t.vram_peak.toFixed(1) + 'GB' : ''}`));
      emit('task.state', { task_id: t.id, status: t.status });
      onTaskEnded(t);
    }
  }
  function onTaskEnded(t) {
    if (t.queue === 'gpu') { E.S.gpu.util = 0; }
    if (t.cloud_node) { const n = E.S.cloudNodes.find(x => x.id === t.cloud_node); if (n && n.task === t.id) n.task = null; }
    // 失败统计：连续失败 3 次告警
    const recent = E.S.tasks.filter(x => x.finished_at).sort((a, b) => b.finished_at - a.finished_at).slice(0, 3);
    if (recent.length === 3 && recent.every(x => x.status === 'failed')) alert('error', '任务连续失败 3 次，请检查 Worker 状态', 'queue');
    const job = t.job_id && E.S.jobs.find(j => j.id === t.job_id);
    if (job) updateJobStatus(job);
  }
  function updateJobStatus(job) {
    if (job.status === 'canceled' || job.status === 'draft') return;
    const assets = E.S.assets.filter(a => a.job_id === job.id);
    const passed = assets.filter(a => ['library', 'exported'].includes(a.status)).length;
    if (passed >= job.quantity && job.status !== 'done') { job.status = 'done'; job.done_at = E.S.clock; alert('ok', `需求单 ${job.code}「${job.title}」已完成 ${passed} 件入库`, 'library'); }
  }

  // ---------- 任务完成处理 ----------
  function complete(t) {
    const H = {
      concept_image: () => {
        const p = t.params; const cats = Geo.categoriesIn(p.prompt);
        for (let i = 0; i < (p.batch || 8); i++) {
          const seed = (p.seed + i * 7919) % 999983;
          const category = cats.length ? cats[i % cats.length] : Geo.detectCategory(p.prompt, seed);
          E.S.concepts.unshift({ id: id('img'), code: 'IMG-' + pad(E.S.concepts.length + 1, 5), job_id: t.job_id, batch_task: t.id, batch_code: t.code, prompt: p.prompt, negative: p.negative, seed, model_id: t.model_id, lora: p.lora, lora_weight: p.lora_weight, size: p.size, category, remove_bg: p.remove_bg, three_view: p.three_view, selected: false, status: 'candidate', created_at: E.S.clock, tags: [Geo.CATS[category].name] });
        }
      },
      image_to_3d: () => produceRaw(t),
      mesh_optimize: () => produceOptimized(t),
      auto_qa: () => runQA(t.version_id, t),
      panorama: () => {
        const p = t.params;
        for (let i = 0; i < (p.count || 4); i++) {
          const seed = (p.seed + i * 4241) % 999983;
          E.S.panoramas.unshift({ id: id('pano'), code: 'PANO-' + pad(E.S.panoramas.length + 1, 4), project_id: t.project_id, job_id: t.job_id, prompt: p.prompt, seed, theme: p.theme || themeFrom(p.prompt), width: p.width, height: p.height, model_id: t.model_id, seam_ok: null, seam_defect: (Geo.rng(seed)() < 0.3), seam_fixed: false, upscaled: false, uses: ['天空盒'], created_at: E.S.clock, status: 'candidate' });
        }
      },
      upscale: () => { const pn = E.S.panoramas.find(x => x.id === t.pano_id); if (pn) { pn.upscaled = true; pn.width = 8192; pn.height = 4096; } },
      world_gen: () => {
        const pn = E.S.panoramas.find(x => x.id === t.pano_id);
        const a = newAsset({ project_id: t.project_id, job_id: t.job_id, type: 'world', source: '生成', category: null, name: '世界 · ' + (pn ? pn.prompt.slice(0, 12) : '场景'), tags: ['世界生成', '3DGS'] });
        const v = newVersion(a, { stage: 'world', seed: pn ? pn.seed : 1, pano_id: t.pano_id, splats: t.params.splats || 500000, formats: t.params.formats, license_chain: [{ stage: '全景', model_id: pn ? pn.model_id : 'qwen-360', model_name: E.model(pn ? pn.model_id : 'qwen-360').name, license: E.model(pn ? pn.model_id : 'qwen-360').license_type }, { stage: '世界生成', model_id: t.model_id, model_name: E.model(t.model_id).name, license: E.model(t.model_id).license_type }], aigc_mark: aigc(t.model_id), parent_task_id: t.id });
        alert('ok', `云端世界生成完成，结果已回传：${a.code}`, 'scenes');
        queueQA(a, v);
      },
      pose_solve: () => {
        const d = E.S.recon.find(x => x.id === t.recon_id); if (!d) return;
        const ratio = d.forceLowRatio ? 0.82 + Geo.rng(d.photo_count)() * 0.05 : Math.min(0.995, 0.93 + Geo.rng(d.photo_count + d.appended)() * 0.06);
        d.registered_ratio = +ratio.toFixed(3); d.registered = Math.round(d.photo_count * ratio); d.sparse_points = Math.round(d.photo_count * 412);
        d.step = ratio < 0.9 ? 1 : 2; d.status = ratio < 0.9 ? 'reshoot' : 'posed';
        if (ratio < 0.9) { alert('warn', `重建数据集 ${d.name} 相机注册率 ${(ratio * 100).toFixed(1)}% 低于 90%，请补拍后重新求解`, 'recon'); t.log.push(logLine('注册率不足，终止，不进入训练')); }
      },
      gs_train: () => {
        const d = E.S.recon.find(x => x.id === t.recon_id); if (!d) return;
        d.step = 3; d.status = 'trained'; d.psnr = t.metrics.psnr; d.splats = Math.min(d.splat_limit, 2600000); d.floaters = true; d.cropped = false;
        d.accuracy_report = { rmse_mm: +(1.6 + Geo.rng(d.photo_count)() * 1.2).toFixed(2), scale_error_pct: +(0.12 + Geo.rng(d.photo_count + 3)() * 0.2).toFixed(2), control_points: d.capture_record.control || '—', color_delta_e: +(1.8 + Geo.rng(d.photo_count + 7)() * 1.1).toFixed(2), psnr: d.psnr, generated_at: E.S.clock };
        alert('ok', `${d.name} 3DGS 训练完成，PSNR ${d.psnr} dB，已生成精度报告`, 'recon');
      },
      rig: () => { const c = E.S.characters.find(x => x.id === t.char_id); if (!c) return; c.status = 'weights'; c.bones = Geo.SKELETON.length; c.rig_by = E.model(t.model_id).name; c.issues = [{ bone: 'l_shoulder', note: '左腋下权重穿插（3 处顶点）' }, { bone: 'r_knee', note: '右膝弯曲时网格自交' }].slice(0, 1 + (c.seed % 2)); c.issues_confirmed = false; },
      motion_gen: () => { const c = E.S.characters.find(x => x.id === t.char_id); if (!c) return; const mo = Geo.motionFromText(t.params.text, Geo.hash(t.params.text)); c.clips.push({ id: id('clip'), motion: mo, name: '文生：' + t.params.text.slice(0, 10), duration: t.params.duration || Geo.MOTIONS[mo].dur, blend: 0.3, source: E.model(t.model_id).name, marks: [] }); },
      export: () => finishExport(t),
    };
    (H[t.node] || (() => { }))();
  }
  function themeFrom(p) { return /夜|星|月/.test(p) ? 'night' : /黄昏|夕阳|晚霞|日落/.test(p) ? 'dusk' : 'day'; }
  function aigc(modelId) { return { generated: true, label: 'AI 生成', model: E.model(modelId).name, time: new Date(E.S.clock).toISOString() }; }

  // ---------- 资产 ----------
  function newAsset(o) {
    const a = Object.assign({ id: id('a'), code: 'SC-' + pad(E.S.assets.length + 1001, 6), current_version: null, versions: [], tags: [], status: 'generating', rework_count: 0, history: [], created_at: E.S.clock, scenes: [], heritage: false }, o);
    if (a.job_id) { const j = E.S.jobs.find(x => x.id === a.job_id); if (j) { a.heritage = !!j.is_heritage; a.preset = j.preset; if (!j.is_heritage && a.type === 'prop' && j.ai_restore !== false) a.ai_restore = true; } }
    E.S.assets.unshift(a); return a;
  }
  function newVersion(a, o) {
    const v = Object.assign({ id: id('v'), asset_id: a.id, version: a.versions.length + 1, created_at: E.S.clock }, o);
    E.S.versions.unshift(v); a.versions.push(v.id); a.current_version = v.id; return v;
  }
  E.asset = (aid) => E.S.assets.find(a => a.id === aid) || fail('资产不存在');
  E.version = (vid) => E.S.versions.find(v => v.id === vid);
  E.cur = (a) => E.version(a.current_version);
  function defectsFor(seed) {
    const r = Geo.rng(seed * 13 + 5);
    return { nonManifold: r() < 0.22 ? 2 + Math.floor(r() * 9) : 0, flipped: r() < 0.16 ? 1 : 0, origin: r() < 0.14 ? [0.04, 0.06, 0.02] : [0, 0, 0], uvOverlap: +(r() * 1.6).toFixed(2), scaleOff: r() < 0.06 };
  }
  function produceRaw(t) {
    const c = E.S.concepts.find(x => x.id === t.concept_id);
    const m = E.model(t.model_id);
    let a = t.asset_id && E.S.assets.find(x => x.id === t.asset_id);
    const seed = t.params.seed;
    const category = c ? c.category : (a && a.category) || 'vase';
    if (!a) { a = newAsset({ project_id: t.project_id, job_id: t.job_id, type: 'prop', source: '生成', category, name: Geo.CATS[category].name + ' ' + pad((E.S.assets.filter(x => x.category === category).length + 1), 2), concept_id: c && c.id, tags: [Geo.CATS[category].name].concat(c && c.lora ? [E.model(c.lora) ? E.model(c.lora).name.replace('风格 LoRA · ', '') : ''] : []).filter(Boolean), prompt: c ? c.prompt : '' }); t.asset_id = a.id; }
    const res = t.params.resolution || 1024;
    const target = Math.round((res >= 1024 ? 150000 : 70000) * (0.85 + Geo.rng(seed)() * 0.4));
    const mesh = Geo.buildMesh({ category, seed, defects: {} }, target);
    const tex = m.pbr === false ? 0 : (t.params.texture || 2048);
    const chain = [];
    if (c) chain.push({ stage: '概念图', model_id: c.model_id, model_name: E.model(c.model_id).name, license: E.model(c.model_id).license_type });
    if (c && c.lora) chain.push({ stage: '风格 LoRA', model_id: c.lora, model_name: E.model(c.lora).name, license: E.model(c.lora).license_type });
    if (c && c.remove_bg) chain.push({ stage: '去背景', model_id: 'birefnet', model_name: 'BiRefNet 去背景', license: 'MIT' });
    chain.push({ stage: '3D 生成', model_id: m.id, model_name: m.name, license: m.license_type });
    const v = newVersion(a, {
      stage: 'raw', seed, category, model_id: m.id, params: clone(t.params), parent_task_id: t.id,
      raw: { target, tris: mesh.tris, verts: mesh.verts, materials: mesh.parts.length > 1 ? Math.min(3, mesh.parts.length) : 1, texture: tex, file_mb: +((mesh.verts * 32 + mesh.tris * 12) / 1048576 + (tex ? tex * tex * 3 * 0.45 / 1048576 : 0)).toFixed(1), pbr: !!m.pbr, gen_s: Math.round(t.elapsed), vram_peak: +t.vram_peak.toFixed(1) },
      opt: null, defects: defectsFor(seed), license_chain: chain, aigc_mark: aigc(m.id), qa_id: null,
    });
    a.status = 'generated';
    a.model_id = m.id;
    if (E.S.settings.autoOptimize || t.params.autoOptimize) queueOptimize(a, v, { preset: a.preset || 'quest3' });
  }
  function queueOptimize(a, v, opts) {
    const j = a.job_id && E.S.jobs.find(x => x.id === a.job_id);
    const t = enqueue({ job_id: a.job_id, project_id: a.project_id, node: 'mesh_optimize', model_id: 'blender', asset_id: a.id, version_id: v.id, params: Object.assign({ preset: (opts && opts.preset) || (j && j.preset) || 'quest3', steps: ['decimate', 'remesh', 'uv', 'bake', 'compress'], manual: false, batchIdx: E.S.tasks.length }, opts || {}), created_by: (opts && opts.by) || E.user().name });
    a.status = 'optimizing';
    return t;
  }
  E.queueOptimize = queueOptimize;
  function produceOptimized(t) {
    const a = E.asset(t.asset_id); const v = E.version(t.version_id);
    const preset = E.S.settings.presets[t.params.preset] || E.S.settings.presets.quest3;
    const target = Math.round(preset.tris * (t.params.ratio || 0.86));
    const mesh = Geo.buildMesh({ category: v.category, seed: v.seed, defects: {} }, target);
    const tex = Math.min(preset.tex, v.raw.texture || preset.tex) || preset.tex;
    v.opt = { target, tris: mesh.tris, verts: mesh.verts, materials: 1, texture: tex, file_mb: +((mesh.verts * 18 + mesh.tris * 6) / 1048576 + tex * tex * 0.25 / 1048576).toFixed(2), preset: t.params.preset, steps: t.params.steps, normal_detail: '需目检', manual_retopo: !!t.params.manual, tools: ['Blender 4.2 无头', 'Instant Meshes', 'xatlas'] };
    v.stage = 'optimized'; v.preset = t.params.preset;
    if (!v.license_chain.find(c => c.stage === '优化')) v.license_chain.push({ stage: '优化', model_id: 'blender', model_name: 'Blender 无头 + Instant Meshes + xatlas', license: 'GPL-3.0 / BSD / MIT（工具）', tool: true });
    if (t.params.reworkFix) { // 返工到优化：按原因修复
      if (t.params.reworkFix === 'scale') { v.defects.origin = [0, 0, 0]; v.defects.scaleOff = false; }
      if (t.params.reworkFix === 'texture') { v.defects.uvOverlap = 0.3; v.opt.texture_rebaked = true; }
    }
    if (t.params.manual) { a.status = 'manual'; a.manual_note = '主视觉资产：已输出高模、自动低模和 .blend，待人工重拓扑'; v.opt.outputs = ['high.glb', 'auto_low.glb', a.code + '.blend']; return; }
    queueQA(a, v);
  }
  function queueQA(a, v) {
    a.status = 'qa';
    return enqueue({ job_id: a.job_id, project_id: a.project_id, node: 'auto_qa', model_id: 'blender', asset_id: a.id, version_id: v.id, params: {}, created_by: '系统' });
  }

  // ---------- 质检 Q01–Q09 ----------
  const QA_RULES = [
    { id: 'Q01', name: '三角形数', level: '阻断' }, { id: 'Q02', name: '贴图分辨率', level: '阻断' }, { id: 'Q03', name: '材质数', level: '阻断' },
    { id: 'Q04', name: '非流形边', level: '可修复' }, { id: 'Q05', name: 'UV 重叠率', level: '警告' }, { id: 'Q06', name: '法线翻转', level: '可修复' },
    { id: 'Q07', name: '尺寸与原点', level: '可修复' }, { id: 'Q08', name: '许可证合规', level: '阻断' }, { id: 'Q09', name: 'AIGC 标识', level: '阻断' }];
  E.QA_RULES = QA_RULES;
  function runQA(vid) {
    const v = E.version(vid); const a = E.asset(v.asset_id); const project = E.scopeOf(a.project_id, a.job_id);
    const presetKey = v.preset || a.preset || 'quest3'; const P = E.S.settings.presets[presetKey];
    const items = [];
    const add = (rid, measured, limit, pass, extra) => { const r = QA_RULES.find(x => x.id === rid); items.push(Object.assign({ rule: rid, name: r.name, level: r.level, measured, limit, result: pass ? 'pass' : (r.level === '警告' ? 'warn' : 'fail') }, extra || {})); };
    const chain = E.chainCheck(v.license_chain, project);
    const needMark = a.source === '生成';
    if (a.type === 'prop') {
      const s = v.opt || v.raw; const d = v.defects || {};
      add('Q01', s.tris, `≤ ${P.tris.toLocaleString()}`, s.tris <= P.tris);
      add('Q02', s.texture ? s.texture + ' px' : '无贴图', `≤ ${P.tex} px`, (s.texture || 0) <= P.tex);
      add('Q03', s.materials, `≤ ${P.materials}`, s.materials <= P.materials);
      add('Q04', d.nonManifold, '0', !d.nonManifold);
      add('Q05', d.uvOverlap + '%', '≤ 1%', d.uvOverlap <= 1);
      add('Q06', d.flipped ? Math.max(12, Math.round(s.tris * 0.012)) + ' 面' : '0 面', '0 面', !d.flipped);
      const sz = Geo.CATS[v.category].size, off = d.origin || [0, 0, 0]; const originOk = Math.hypot(off[0], off[1], off[2]) < 0.005;
      add('Q07', `${(sz[0] * (d.scaleOff ? 10 : 1)).toFixed(2)}×${(sz[1] * (d.scaleOff ? 10 : 1)).toFixed(2)}×${(sz[2] * (d.scaleOff ? 10 : 1)).toFixed(2)} m · 原点${originOk ? '底部中心' : '偏移 ' + (Math.hypot(...off) * 100).toFixed(1) + ' cm'}`, '0.1–3 m · 底部中心', originOk && !d.scaleOff);
    } else if (a.type === 'world' || a.type === 'recon') {
      const lim = a.type === 'recon' ? (v.splat_limit || 500000) : 500000;
      add('Q01', (v.splats || 0).toLocaleString() + ' splat', `≤ ${lim.toLocaleString()} splat`, (v.splats || 0) <= lim);
      add('Q07', '尺度与控制点', a.type === 'recon' ? '标尺校准' : '—', true);
    }
    add('Q08', chain.ok ? '许可链 ' + v.license_chain.length + ' 项全部合规' : chain.bad.map(b => b.stage + '：' + b.reason).join('；'), SCOPES[project.usage_scope], chain.ok);
    const hasMark = !!(v.aigc_mark && v.aigc_mark.generated);
    add('Q09', needMark ? (hasMark ? 'GLB extras 与库记录已写入' : '缺失') : '非生成类，不写入', needMark ? '生成类必须有' : '—', needMark ? hasMark : !hasMark);
    const passed = items.every(i => i.result !== 'fail');
    const qa = { id: id('qa'), asset_version_id: v.id, asset_id: a.id, preset_id: presetKey, items, passed, created_at: E.S.clock, duration_s: +(1.2 + items.length * 0.6).toFixed(1) };
    E.S.qa.unshift(qa); v.qa_id = qa.id;
    if (!['library', 'exported', 'discarded'].includes(a.status)) { a.status = 'review'; a.review_since = E.S.clock; }
    emit('qa.result', { version_id: v.id, passed, items });
    return qa;
  }
  E.runQA = (vid) => runQA(vid);
  E.qaOf = (v) => v && E.S.qa.find(q => q.id === v.qa_id);
  E.autoFix = function (aid) {
    need('review');
    const a = E.asset(aid), v = E.cur(a);
    const d = v.defects || {}; const fixed = [];
    if (d.nonManifold) { fixed.push(`非流形边 ${d.nonManifold} 条`); d.nonManifold = 0; }
    if (d.flipped) { fixed.push('法线翻转'); d.flipped = 0; }
    if (d.origin && Math.hypot(...d.origin) > 0.005) { fixed.push('原点归位到底部中心'); d.origin = [0, 0, 0]; }
    v.autofixed = (v.autofixed || []).concat(fixed);
    audit('自动修复并重检', a.code, fixed.join('、') || '无可修复项');
    a.history.push({ time: E.S.clock, action: '自动修复', detail: fixed.join('、') || '无可修复项', by: E.user().name, version: v.version });
    return { fixed, qa: runQA(v.id) };
  };

  // ---------- 审核 ----------
  E.review = function (aid, decision, reasonCode, comment) {
    need('review');
    const a = E.asset(aid); const v = E.cur(a); const qa = E.qaOf(v);
    if (a.status !== 'review') fail('该资产当前不在待审核状态');
    const failed = qa ? qa.items.filter(i => i.result === 'fail') : [];
    if (decision === 'pass') {
      const hard = failed.filter(i => i.rule === 'Q08' || i.rule === 'Q09');
      if (hard.length) fail(`${hard.map(h => h.rule + ' ' + h.name).join('、')}未通过，不可放行`, 'license');
      if (failed.length && !(comment || '').trim()) fail('存在自动检查未通过项，通过时需填写放行理由');
      a.status = 'library'; v.approved = true; v.approved_at = E.S.clock; a.library_version = v.version;
      a.history.push({ time: E.S.clock, action: '通过入库', detail: (failed.length ? '放行理由：' + comment : comment || '自动检查全部通过'), by: E.user().name, version: v.version });
    } else if (decision === 'rework') {
      if (!REWORK_REASONS[reasonCode]) fail('返工必须选择原因');
      a.rework_count++;
      a.history.push({ time: E.S.clock, action: '返工', detail: REWORK_REASONS[reasonCode] + (comment ? '：' + comment : ''), by: E.user().name, version: v.version });
      if (a.rework_count > 2) {
        a.status = 'manual'; a.manual_note = `返工超过 2 次（第 ${a.rework_count} 次：${REWORK_REASONS[reasonCode]}），已转人工处理，不再占用 GPU 队列`;
        alert('warn', `${a.code} 返工超过 2 次，已自动转人工`, 'review');
      } else {
        a.status = 'rework';
        const route = REWORK_ROUTE[reasonCode];
        if (route === 'image_to_3d') {
          const oldT = E.S.tasks.find(t => t.id === v.parent_task_id);
          enqueue({ job_id: a.job_id, project_id: a.project_id, node: 'image_to_3d', model_id: v.model_id, asset_id: a.id, concept_id: a.concept_id, params: Object.assign({}, v.params || (oldT && oldT.params) || {}, { seed: (v.seed * 31 + a.rework_count * 977) % 999983, force_oom: false, preview_render: false }), created_by: E.user().name, rework: REWORK_REASONS[reasonCode] });
          a.status = 'generating';
        } else {
          // 返工到资产优化：基于同一生成结果生成新版本
          const base = clone(v); delete base.id; delete base.version; delete base.created_at;
          Object.assign(base, { opt: null, stage: 'raw', qa_id: null, approved: false, approved_at: null, rework_of: v.id });
          const nv = newVersion(a, base);
          queueOptimize(a, nv, { preset: v.preset || a.preset, reworkFix: reasonCode, by: E.user().name });
        }
      }
    } else if (decision === 'discard') {
      a.status = 'discarded'; a.discarded_at = E.S.clock; a.purge_at = E.S.clock + 30 * 864e5;
      a.history.push({ time: E.S.clock, action: '废弃', detail: (comment || '') + '（保留 30 天）', by: E.user().name, version: v.version });
    } else fail('未知审核结论');
    const r = { id: id('rv'), asset_version_id: v.id, asset_id: a.id, decision, reason_code: reasonCode || null, comment: comment || '', reviewer: E.user().name, created_at: E.S.clock, model_id: v.model_id, job_id: a.job_id, first: !E.S.reviews.some(x => x.asset_id === a.id) };
    E.S.reviews.unshift(r);
    audit('审核结论', a.code, { pass: '通过入库', rework: '返工 · ' + (REWORK_REASONS[reasonCode] || ''), discard: '废弃' }[decision]);
    const job = a.job_id && E.S.jobs.find(j => j.id === a.job_id); if (job) updateJobStatus(job);
    return r;
  };
  E.manualResolve = function (aid, note) {
    need('manual.handle');
    const a = E.asset(aid); if (a.status !== 'manual') fail('该资产不在转人工状态');
    const v = E.cur(a);
    a.history.push({ time: E.S.clock, action: '人工处理完成', detail: note || '人工修复后重新提交', by: E.user().name, version: v.version });
    if (v.defects) { v.defects.nonManifold = 0; v.defects.flipped = 0; v.defects.origin = [0, 0, 0]; v.defects.scaleOff = false; }
    if (!v.opt) { const P = E.S.settings.presets[a.preset || 'quest3']; v.opt = { tris: Math.round(P.tris * 0.8), verts: Math.round(P.tris * 0.45), materials: 1, texture: P.tex, file_mb: 1.6, preset: a.preset || 'quest3', manual_retopo: true, tools: ['人工重拓扑（Blender）'] }; v.stage = 'optimized'; }
    a.manual_note = null;
    audit('转人工处理完成并重新提交', a.code, note || '');
    queueQA(a, v);
  };
  E.rollback = function (aid, vid) {
    need('manual.handle');
    const a = E.asset(aid); const v = E.version(vid);
    if (!v || !v.approved) fail('只能回退到曾经通过审核的版本');
    a.current_version = v.id; a.history.push({ time: E.S.clock, action: '回退版本', detail: '回退到 v' + v.version, by: E.user().name, version: v.version });
    audit('资产版本回退', a.code, 'v' + v.version);
  };

  // ---------- 概念图 / 3D ----------
  E.generateConcepts = function (o) {
    need('concept');
    const job = o.job_id && E.job(o.job_id); heritageGuard(job, 'concept_image');
    const project = job ? E.scopeOf(job.project_id, job.id) : E.project();
    const r = E.modelAllowed(o.model_id, project); if (!r.ok) fail(`模型不可用：${r.reason}`, 'license');
    if (!o.prompt) fail('请填写提示词');
    const t = enqueue({ job_id: o.job_id, project_id: project.id, node: 'concept_image', model_id: o.model_id, params: { prompt: o.prompt, negative: o.negative || '', size: o.size || 1024, batch: o.batch || 8, remove_bg: o.remove_bg !== false, three_view: !!o.three_view, lora: o.lora || '', lora_weight: o.lora_weight ?? 0.8, seed: o.seed != null && o.seed !== '' ? +o.seed : Math.floor(Math.random() * 99999) } });
    audit('提交概念图生成', t.code, `${o.batch || 8} 张 · ${E.model(o.model_id).name}`);
    return t;
  };
  E.gpuBusyWith = function (modelId) { const g = E.S.gpu; const run = E.S.tasks.find(t => t.queue === 'gpu' && t.status === 'running'); return (run && run.model_id !== modelId) || (g.swapping && g.swapping.to !== modelId) ? (run || {}) : null; };
  E.etaFor = function (queue) { // 预计开始时间（模拟秒）
    const q = E.S.tasks.filter(t => t.queue === queue && ['queued', 'running'].includes(t.status) && t.priority !== 'night');
    const s = q.reduce((acc, t) => acc + Math.max(0, t.duration - t.elapsed), 0) + (E.S.gpu.swapping ? E.S.gpu.swapping.left : 0);
    return queue === 'cpu' ? s / 3 : s;
  };
  E.selectConcepts = function (ids, o) {
    need('concept');
    o = o || {};
    const sel = ids.map(i => E.S.concepts.find(c => c.id === i)).filter(Boolean);
    if (!sel.length) fail('请先选择概念图');
    const job = sel[0].job_id && E.S.jobs.find(j => j.id === sel[0].job_id); heritageGuard(job, 'image_to_3d');
    const project = job ? E.scopeOf(job.project_id, job.id) : E.project();
    const modelId = o.model_id || (job && job.nodeModels && job.nodeModels.image_to_3d) || 'trellis2-4b';
    const r = E.modelAllowed(modelId, project); if (!r.ok) fail(`3D 生成模型不可用：${r.reason}`, 'license');
    const tasks = [];
    sel.forEach((c, i) => {
      c.selected = true; c.status = 'sent'; c.sent_at = E.S.clock;
      tasks.push(enqueue({ job_id: c.job_id, project_id: project.id, node: 'image_to_3d', model_id: modelId, concept_id: c.id, params: Object.assign({ resolution: 1024, texture: 2048, steps: 25, preview_render: false, seed: c.seed }, o.params || {}, { force_oom: o.force_oom_index === i }) }));
    });
    // 未选图片保留 7 天后清理
    const batches = new Set(sel.map(c => c.batch_task));
    E.S.concepts.filter(c => batches.has(c.batch_task) && !c.selected && c.status === 'candidate').forEach(c => { c.purge_at = E.S.clock + 7 * 864e5; });
    audit('送入 3D 生成', sel.length + ' 张概念图', E.model(modelId).name);
    return tasks;
  };
  E.discardConcepts = function (ids) { need('concept'); ids.forEach(i => { const c = E.S.concepts.find(x => x.id === i); if (c && c.status === 'candidate') { c.status = 'discarded'; } }); };
  E.regenerate3d = function (aid, o) {
    need('gen3d');
    const a = E.asset(aid), v = E.cur(a);
    const job = a.job_id && E.S.jobs.find(j => j.id === a.job_id); heritageGuard(job, 'image_to_3d');
    const modelId = (o && o.model_id) || v.model_id; const r = E.modelAllowed(modelId, E.scopeOf(a.project_id, a.job_id)); if (!r.ok) fail(`模型不可用：${r.reason}`, 'license');
    a.status = 'generating';
    return enqueue({ job_id: a.job_id, project_id: a.project_id, node: 'image_to_3d', model_id: modelId, asset_id: a.id, concept_id: a.concept_id, params: Object.assign({}, v.params, (o && o.params) || {}, { seed: (o && o.params && o.params.seed) || (v.seed + 17) % 999983 }) });
  };
  E.discardAsset = function (aid) { need('gen3d'); const a = E.asset(aid); a.status = 'discarded'; a.discarded_at = E.S.clock; a.history.push({ time: E.S.clock, action: '丢弃', detail: '3D 生成阶段丢弃', by: E.user().name }); audit('丢弃资产', a.code); };
  E.optimize = function (aids, o) {
    need('optimize');
    if (o.preset === 'custom' && o.custom) { const c = E.S.settings.presets.custom; c.tris = Math.max(500, +o.custom.tris || c.tris); c.tex = +o.custom.tex || c.tex; }
    const out = [];
    aids.forEach(aid => { const a = E.asset(aid), v = E.cur(a); if (!v.raw) return; out.push(queueOptimize(a, v, { preset: o.preset, manual: !!o.manual, ratio: o.ratio, by: E.user().name })); });
    audit('提交资产优化', out.length + ' 件', E.S.settings.presets[o.preset].name + (o.manual ? ' · 转人工重拓扑' : ''));
    return out;
  };

  // ---------- 资产库 ----------
  E.libraryQuery = function (f) {
    f = f || {};
    const project = E.project();
    const q = (f.q || '').trim();
    let list = E.S.assets.filter(a => a.project_id === project.id || f.allProjects);
    if (f.status) list = list.filter(a => a.status === f.status); else list = list.filter(a => ['library', 'exported'].includes(a.status));
    if (f.type) list = list.filter(a => a.type === f.type);
    if (f.source) list = list.filter(a => a.source === f.source);
    if (f.license === 'commercial' || f.commercialOnly) list = list.filter(a => { const v = E.cur(a); return v && COMMERCIAL_SCOPE_OK(v); });
    if (f.heritageOnly) list = list.filter(a => a.heritage);
    if (f.platform) list = list.filter(a => { const v = E.cur(a); return v && v.preset && E.S.settings.presets[v.preset] && E.S.settings.presets[v.preset].tris <= E.S.settings.presets[PLATFORM_PRESET[f.platform]].tris; });
    if (q) list = list.filter(a => (a.name + ' ' + a.code + ' ' + a.tags.join(' ') + ' ' + (a.prompt || '')).toLowerCase().includes(q.toLowerCase()));
    const sort = f.sort || 'new';
    list = list.slice().sort((a, b) => sort === 'tris' ? ((E.cur(a).opt || E.cur(a).raw || {}).tris || 0) - ((E.cur(b).opt || E.cur(b).raw || {}).tris || 0) : sort === 'name' ? a.name.localeCompare(b.name, 'zh') : b.created_at - a.created_at);
    return list;
  };
  function COMMERCIAL_SCOPE_OK(v) { return E.chainCheck(v.license_chain, { usage_scope: 'commercial_cn' }).ok; }
  E.commercialOk = COMMERCIAL_SCOPE_OK;
  E.tagAssets = function (aids, tag) { need('library'); if (!tag) fail('请输入标签'); aids.forEach(i => { const a = E.asset(i); if (!a.tags.includes(tag)) a.tags.push(tag); }); audit('批量加标签', aids.length + ' 件', tag); };
  E.deleteAsset = function (aid) { need('manual.handle'); const a = E.asset(aid); if (a.scenes && a.scenes.length) fail(`该资产被 ${a.scenes.length} 个场景引用，不能删除`); a.status = 'discarded'; a.purge_at = E.S.clock + 30 * 864e5; audit('删除资产', a.code); };

  // ---------- 场景生成（全景 / 世界） ----------
  E.generatePanoramas = function (o) {
    need('scene.gen');
    const job = o.job_id && E.job(o.job_id); heritageGuard(job, 'panorama');
    const r = E.modelAllowed('qwen-360'); if (!r.ok) fail('全景模型不可用：' + r.reason, 'license');
    if (!o.prompt) fail('请填写提示词');
    const t = enqueue({ job_id: o.job_id, project_id: E.S.currentProjectId, node: 'panorama', model_id: 'qwen-360', params: { prompt: o.prompt, width: o.width || 4096, height: (o.width || 4096) / 2, count: o.count || 4, seam_fix: o.seam_fix !== false, upscale: !!o.upscale, theme: themeFrom(o.prompt), seed: o.seed || Math.floor(Math.random() * 99999) } });
    audit('提交全景生成', t.code, o.prompt.slice(0, 20));
    return t;
  };
  E.fixSeam = function (pid) { const p = E.S.panoramas.find(x => x.id === pid); p.seam_defect = false; p.seam_fixed = true; p.seam_ok = true; audit('全景接缝修复', p.code); };
  E.upscalePano = function (pid) { need('scene.gen'); const p = E.S.panoramas.find(x => x.id === pid); return enqueue({ project_id: p.project_id, node: 'upscale', model_id: 'realesrgan', pano_id: p.id, params: {} }); };
  E.submitWorld = function (pid, modelId, o) {
    need('scene.gen');
    const p = E.S.panoramas.find(x => x.id === pid); if (!p) fail('请先选择全景');
    if (p.seam_ok === false || p.seam_defect) fail('接缝检查未通过，请先执行接缝修复');
    const r = E.modelAllowed(modelId); if (!r.ok) fail('世界生成引擎不可用：' + r.reason, 'license');
    const m = E.model(modelId);
    const t = enqueue({ project_id: p.project_id, job_id: p.job_id, node: 'world_gen', model_id: modelId, pano_id: p.id, params: { formats: (o && o.formats) || ['3DGS', '网格'], splats: (o && o.splats) || 500000 } });
    audit('提交世界生成', t.code, m.name + (m.cost ? ` · 预计 ¥${m.cost}` : m.cost_per_hour ? ` · 约 ¥${(m.cost_per_hour * m.unit_s / 3600).toFixed(1)}` : ''));
    return t;
  };

  // ---------- 实景重建 ----------
  E.createDataset = function (o) {
    need('recon');
    const d = Object.assign({ id: id('rc'), code: 'RC-' + pad(E.S.recon.length + 1, 3), project_id: E.S.currentProjectId, job_id: o.job_id || null, step: 0, status: 'uploaded', appended: 0, registered_ratio: null, capture_record: { collector: '', date: '', control: '', colorChart: '' }, splat_limit: 500000, platform: 'quest3', iterations: 30000, sh: 3, engine: 'lichtfeld', solver: 'colmap', created_at: E.S.clock }, o);
    d.blurred = Math.round(d.photo_count * 0.031); d.photo_count -= d.blurred;
    E.S.recon.unshift(d); audit('上传重建素材', d.code, `${d.photo_count + d.blurred} 张，模糊剔除 ${d.blurred} 张`); return d;
  };
  E.dataset = (rid) => E.S.recon.find(x => x.id === rid) || fail('数据集不存在');
  E.appendPhotos = function (rid, n) { const d = E.dataset(rid); d.photo_count += n; d.appended += n; d.forceLowRatio = false; d.status = 'uploaded'; d.step = 0; audit('追加重建素材', d.code, n + ' 张'); };
  E.solvePoses = function (rid) { need('recon'); const d = E.dataset(rid); d.status = 'solving'; return enqueue({ project_id: d.project_id, job_id: d.job_id, node: 'pose_solve', model_id: 'colmap', recon_id: d.id, queue: 'gpu', params: { photos: d.photo_count } }); };
  E.trainGS = function (rid, o) {
    need('recon'); const d = E.dataset(rid);
    if (!d.registered_ratio || d.registered_ratio < 0.9) fail('相机注册率低于 90%，请补拍，不进入训练');
    Object.assign(d, o || {});
    const m = E.model('lichtfeld');
    const est = estimate('gs_train', m, { photos: d.photo_count, iterations: d.iterations });
    const mode = (o && o.mode) || (est > 3600 ? 'night' : 'now');
    d.status = 'training';
    const t = enqueue({ project_id: d.project_id, job_id: d.job_id, node: 'gs_train', model_id: 'lichtfeld', recon_id: d.id, queue: mode === 'cloud' ? 'cloud' : 'gpu', priority: mode === 'night' ? 'night' : 'normal', params: { photos: d.photo_count, iterations: d.iterations, sh: d.sh, splat_limit: d.splat_limit } });
    if (mode === 'cloud') { t.executor = 'cloud'; t.cost = 0; t.log.push(logLine('改为云端训练（AutoDL A800，¥5.59/小时）')); }
    audit('启动 3DGS 训练', d.code, `${d.iterations} 次迭代 · ${mode === 'night' ? '夜间窗口' : mode === 'cloud' ? '云端' : '立即执行'}`);
    return t;
  };
  E.cleanRecon = function (rid, what) { const d = E.dataset(rid); if (what === 'floaters') { d.floaters = false; d.removed = Math.round(d.splats * 0.02); d.splats -= d.removed; } if (what === 'crop') d.cropped = true; d.step = Math.max(d.step, 3); audit('重建清理', d.code, what === 'floaters' ? '框选删除浮点' : '裁剪盒'); };
  E.captureComplete = (d) => { const c = d.capture_record || {}; return !!(c.collector && c.date && c.control && c.colorChart); };
  E.finishRecon = function (rid) {
    need('recon'); const d = E.dataset(rid);
    if (d.status !== 'trained') fail('训练尚未完成');
    if (!E.captureComplete(d)) fail('采集记录未填写完整（采集人、采集日期、标尺或控制点、色卡），不能导出');
    let a = d.asset_id && E.S.assets.find(x => x.id === d.asset_id);
    if (!a) { a = newAsset({ project_id: d.project_id, job_id: d.job_id, type: 'recon', source: '重建', name: d.name, tags: ['实景重建', '3DGS'] }); d.asset_id = a.id; }
    if (d.job_id) { const j = E.S.jobs.find(x => x.id === d.job_id); if (j && j.is_heritage) a.heritage = true; }
    const v = newVersion(a, { stage: 'recon', splats: d.splats, splat_limit: d.splat_limit, recon_id: d.id, license_chain: [{ stage: '位姿求解', model_id: 'colmap', model_name: 'COLMAP', license: 'BSD-3-Clause', tool: true }, { stage: '3DGS 训练', model_id: 'lichtfeld', model_name: 'LichtFeld Studio', license: 'GPL-3.0（工具）', tool: true }], aigc_mark: null, accuracy_report: d.accuracy_report, capture_record: clone(d.capture_record) });
    d.step = 4; d.status = 'exported_qa';
    queueQA(a, v);
    audit('重建结果送入质检', d.code, a.code);
    return a;
  };

  // ---------- 角色与动画 ----------
  E.createCharacter = function (o) { need('character'); const c = Object.assign({ id: id('ch'), code: 'CH-' + pad(E.S.characters.length + 1, 3), project_id: E.S.currentProjectId, status: 'unrigged', bones: 0, tris: 18420, seed: E.S.seq, clips: [], issues: [], source: '生成', created_at: E.S.clock }, o); E.S.characters.unshift(c); return c; };
  E.rigCharacter = function (cid, how) {
    need('character'); const c = E.S.characters.find(x => x.id === cid);
    if (how === 'import') { c.status = 'rigged'; c.bones = Geo.SKELETON.length; c.rig_by = '外部导入绑定（Mixamo 规范）'; c.issues = []; audit('导入外部绑定', c.code); return null; }
    const r = E.modelAllowed('unirig'); if (!r.ok) fail('UniRig 不可用：' + r.reason + '。可改用“导入外部绑定”', 'license');
    c.status = 'rigging'; return enqueue({ project_id: c.project_id, node: 'rig', model_id: 'unirig', char_id: c.id, params: {} });
  };
  E.confirmWeights = function (cid) { const c = E.S.characters.find(x => x.id === cid); c.issues_confirmed = true; c.status = 'rigged'; audit('确认权重穿插已处理', c.code, c.issues.map(i => i.note).join('；')); };
  E.genMotion = function (cid, text, engine, duration) {
    need('character'); const c = E.S.characters.find(x => x.id === cid);
    if (c.status !== 'rigged') fail('请先完成绑骨并确认权重');
    if (engine === 'library') return null;
    const r = E.modelAllowed(engine); if (!r.ok) fail('动作引擎不可用：' + r.reason, 'license');
    if (!text) fail('请输入动作描述');
    return enqueue({ project_id: c.project_id, node: 'motion_gen', model_id: engine, char_id: c.id, params: { text, duration } });
  };
  E.addClip = function (cid, motion) { const c = E.S.characters.find(x => x.id === cid); if (c.status !== 'rigged') fail('请先完成绑骨并确认权重'); c.clips.push({ id: id('clip'), motion, name: Geo.MOTIONS[motion].name, duration: Geo.MOTIONS[motion].dur, blend: 0.3, source: '动作库', marks: [] }); };

  // ---------- 场景组装（Agent） ----------
  E.createScene = function (o) {
    need('assembly');
    const sc = Object.assign({ id: id('sc'), code: 'SCN-' + pad(E.S.scenes.length + 1, 3), project_id: E.S.currentProjectId, name: '新场景', step: 0, items: [], lights: [{ type: 'ambient', intensity: 0.5, color: '#ffffff' }], camera: { pos: [6, 4, 7], target: [0, 0.6, 0] }, messages: [], agentQueue: [], pending: null, platform: 'quest3', created_at: E.S.clock, stills: [], blend_path: '' }, o);
    sc.blend_path = `/data/assets/scenes/${sc.code}.blend`;
    sc.messages.push({ role: 'agent', text: `已创建 Blender 会话（MCP for Blender @ 127.0.0.1:9876），场景文件 ${sc.blend_path}。告诉我要怎样布景，我只会使用资产库中已入库且许可合规的资产。` });
    E.S.scenes.unshift(sc); audit('创建场景', sc.code, sc.name); return sc;
  };
  E.scene = (sid) => E.S.scenes.find(s => s.id === sid) || fail('场景不存在');
  E.sceneBudget = function (sc) {
    const P = E.S.settings.presets[PLATFORM_PRESET[sc.platform] || 'quest3'];
    let tris = 0, dc = 0, tex = 0; const mats = new Set();
    sc.items.forEach(it => { const v = E.version(it.version_id); if (!v) return; const s = v.opt || v.raw || {}; tris += s.tris || (v.splats ? 0 : 0); dc += (s.materials || 1); tex += s.texture ? s.texture * s.texture * 4 * 1.33 / 1048576 : 0; mats.add(it.asset_id); });
    dc += sc.lights.filter(l => l.type !== 'ambient').length;
    const rows = [
      { key: 'tris', name: '三角形', used: tris, limit: P.scene_tris },
      { key: 'dc', name: 'Draw call', used: dc, limit: P.drawcalls },
      { key: 'tex', name: '贴图内存', used: Math.round(tex), limit: P.tex_mem_mb, unit: 'MB' },
      { key: 'mat', name: '材质数', used: mats.size, limit: P.scene_materials }];
    rows.forEach(r => r.pct = r.limit ? r.used / r.limit : 0);
    return { rows, over: rows.some(r => r.pct > 1), preset: P.name };
  };
  E.sceneAssets = function (project) { project = project || E.project(); return E.S.assets.filter(a => a.project_id === project.id && ['library', 'exported'].includes(a.status) && a.type === 'prop' && E.chainCheck(E.cur(a).license_chain, project).ok); };
  const NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 一对: 2, 几: 3 };
  function parseNum(s) { s = s.replace(/两侧|两边|两旁/g, ''); const m = s.match(/(\d+)\s*(个|件|盏|只|座|组|尊|张|面|口|台)?/); if (m) return +m[1]; for (const k of ['一对', '十', '九', '八', '七', '六', '五', '四', '三', '两', '二', '几', '一']) if (s.includes(k)) return NUM[k]; return 1; }
  function planAgent(sc, text) {
    const ev = []; const project = E.project(sc.project_id);
    const tool = (name, args, result, delay) => ev.push({ kind: 'tool', name, args, result, delay: delay || 450 });
    const say = (t, delay) => ev.push({ kind: 'text', text: t, delay: delay || 300 });
    const avail = E.sceneAssets(project);
    if (/python|脚本|代码/i.test(text)) {
      const code = `import bpy\n# 将所有展品对齐到地面并统一朝向主相机\nfor obj in bpy.data.collections['Props'].objects:\n    obj.location.z = 0.0\n    obj.rotation_euler.z = 0.0\nbpy.ops.wm.save_mainfile()`;
      say('这一步需要执行自定义 Python，执行前需要你确认：');
      ev.push({ kind: 'confirm', tool: 'blender.execute_python', code, delay: 200 });
      return ev;
    }
    if (/删除|移除|去掉|清空/.test(text)) {
      const all = /清空|全部|所有/.test(text);
      const targets = all ? sc.items.map(i => i.id) : sc.items.filter(i => text.includes(i.name.replace(/\s*\d+$/, '')) || text.includes(Geo.CATS[i.category] ? Geo.CATS[i.category].name : '@@')).map(i => i.id);
      if (!targets.length) { say('没有找到要删除的对象，请说明对象名称。'); return ev; }
      say(`将删除 ${targets.length} 个对象，删除操作需要你确认：`);
      ev.push({ kind: 'confirm', tool: 'blender.delete_objects', ids: targets, code: `delete_objects(${JSON.stringify(targets.map(t => sc.items.find(i => i.id === t).name))})`, delay: 200 });
      return ev;
    }
    const parts = text.split(/[，。；;,\n]|并且|然后|再/).map(s => s.trim()).filter(Boolean);
    let placed = 0, calls = 0;
    const occupied = sc.items.map(i => i.pos);
    for (const seg of parts) {
      if (/灯光|主光|补光|暖光|冷光|打光|光照/.test(seg)) {
        const warm = !/冷/.test(seg); sc._light = { type: 'directional', intensity: /柔和|弱/.test(seg) ? 1.2 : 2.2, color: warm ? '#ffd9a8' : '#cfe3ff', pos: [4, 6, 3] };
        tool('blender.set_light', { type: 'SUN', color: sc._light.color, energy: sc._light.intensity }, '已设置' + (warm ? '暖色' : '冷色') + '主光', 400); ev.push({ kind: 'apply', op: 'light', light: sc._light, delay: 1 }); calls++; continue;
      }
      if (/相机|镜头|机位|视角/.test(seg)) {
        const top = /俯视|顶/.test(seg); const cam = { pos: top ? [0.01, 9, 0.01] : /近/.test(seg) ? [3, 2, 4] : [6, 3.6, 7], target: [0, 0.6, 0] };
        tool('blender.set_camera', { location: cam.pos, look_at: cam.target, lens: 35 }, '主相机已就位', 400); ev.push({ kind: 'apply', op: 'camera', camera: cam, delay: 1 }); calls++; continue;
      }
      // 资产匹配
      let cat = null; for (const k of Geo.CAT_ORDER) if (Geo.CATS[k].kw.some(w => seg.includes(w))) { cat = k; break; }
      if (!cat) continue;
      const n = Math.min(60, parseNum(seg) * (/两侧|左右/.test(seg) && /各/.test(seg) ? 2 : 1));
      tool('library.search', { query: Geo.CATS[cat].name, type: 'prop', platform: sc.platform }, null, 350); calls++;
      const found = avail.filter(a => a.category === cat);
      ev[ev.length - 1].result = found.length ? `找到 ${found.length} 件已入库且许可合规的${Geo.CATS[cat].name}：${found.slice(0, 4).map(a => a.code).join('、')}${found.length > 4 ? '…' : ''}` : `资产库中没有可用的${Geo.CATS[cat].name}`;
      if (!found.length) { say(`资产库中没有已入库且许可合规的「${Geo.CATS[cat].name}」，可先在需求单中生产。`); continue; }
      const positions = layout(seg, n, cat, occupied);
      positions.forEach((p, i) => {
        const a = found[i % found.length]; const v = E.cur(a);
        const item = { id: id('it'), asset_id: a.id, version_id: v.id, name: a.name, category: cat, pos: p.pos, rotY: p.rotY || 0, scale: 1 };
        tool('library.import_to_scene', { asset_version_id: a.code + '@v' + v.version, transform: { location: p.pos.map(x => +x.toFixed(2)), rotation_z: +(p.rotY || 0).toFixed(2) } }, `已导入 ${a.name}`, 260);
        ev.push({ kind: 'apply', op: 'add', item, delay: 1 });
        occupied.push(p.pos); placed++; calls++;
      });
      if (calls > E.S.settings.llm.maxToolCalls) { say(`单条指令工具调用已达 ${E.S.settings.llm.maxToolCalls} 次上限，已暂停，请确认后继续。`); break; }
    }
    if (!calls) { say('我没有识别出要放置的资产。可以这样说：“中央放一个青铜鼎，两侧各放两盏宫灯，后方放屏风，打暖色主光，设置主相机”。'); return ev; }
    tool('budget.check', { preset: sc.platform }, null, 400); ev[ev.length - 1].budget = true;
    say(placed ? `白盒布局完成：本次放置 ${placed} 件资产${sc._light ? '，已布置主光' : ''}。请在右侧确认当前步骤，或继续给出修改指令。` : '已完成调整。', 300);
    return ev;
  }
  function layout(seg, n, cat, occupied) {
    const out = []; const sz = Geo.CATS[cat].size; const gap = Math.max(sz[0], sz[2]) + 0.5;
    if (/中央|中间|正中|中心/.test(seg)) { for (let i = 0; i < n; i++) out.push({ pos: [(i - (n - 1) / 2) * gap, 0, 0] }); }
    else if (/两侧|左右|两边/.test(seg)) { const per = Math.ceil(n / 2); for (let i = 0; i < n; i++) { const side = i % 2 ? 1 : -1, k = Math.floor(i / 2); out.push({ pos: [side * (1.8 + k * gap), 0, (k - (per - 1) / 2) * 0.2], rotY: side * -Math.PI / 2 }); } }
    else if (/左/.test(seg)) { for (let i = 0; i < n; i++) out.push({ pos: [-2.2, 0, (i - (n - 1) / 2) * gap], rotY: Math.PI / 2 }); }
    else if (/右/.test(seg)) { for (let i = 0; i < n; i++) out.push({ pos: [2.2, 0, (i - (n - 1) / 2) * gap], rotY: -Math.PI / 2 }); }
    else if (/后|背景|靠墙/.test(seg)) { for (let i = 0; i < n; i++) out.push({ pos: [(i - (n - 1) / 2) * gap, 0, -2.6] }); }
    else if (/前/.test(seg)) { for (let i = 0; i < n; i++) out.push({ pos: [(i - (n - 1) / 2) * gap, 0, 2.2], rotY: Math.PI }); }
    else if (/环绕|一圈|围绕|环形|圆形/.test(seg)) { const r = Math.max(2.2, n * gap / (2 * Math.PI)); for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; out.push({ pos: [Math.cos(a) * r, 0, Math.sin(a) * r], rotY: -a - Math.PI / 2 }); } }
    else { const cols = Math.ceil(Math.sqrt(n)); for (let i = 0; i < n; i++) out.push({ pos: [((i % cols) - (cols - 1) / 2) * gap, 0, 1 + Math.floor(i / cols) * gap] }); }
    // 简单避让
    out.forEach(o => { for (let k = 0; k < 6 && occupied.some(p => Math.hypot(p[0] - o.pos[0], p[2] - o.pos[2]) < 0.3); k++) o.pos[2] += gap; });
    return out;
  }
  function applyAgentEvent(sc, ev) {
    const last = sc.messages[sc.messages.length - 1];
    let msg = last && last.role === 'agent' && last.streaming ? last : null;
    if (!msg) { msg = { role: 'agent', text: '', tools: [], streaming: true }; sc.messages.push(msg); }
    if (ev.kind === 'text') msg.text += (msg.text ? '\n' : '') + ev.text;
    if (ev.kind === 'tool') {
      let result = ev.result;
      if (ev.budget) { const b = E.sceneBudget(sc); result = b.rows.map(r => `${r.name} ${Math.round(r.pct * 100)}%`).join(' · ') + (b.over ? '（有超出项）' : ''); }
      const call = { name: ev.name, args: ev.args, result, ms: 80 + Math.round(Math.random() * 400) };
      msg.tools.push(call); E.S.audit.unshift({ id: id('au'), actor: 'Agent', role: 'agent', action: 'Agent 工具调用', object: sc.code, detail: `${ev.name} ${JSON.stringify(ev.args)} → ${result || ''}`, time: E.S.clock });
      emit('agent.delta', { scene_id: sc.id, tool_call: call });
    }
    if (ev.kind === 'apply') {
      if (ev.op === 'add') { sc.items.push(ev.item); const a = E.S.assets.find(x => x.id === ev.item.asset_id); if (a && !a.scenes.includes(sc.id)) a.scenes.push(sc.id); }
      if (ev.op === 'light') { sc.lights = sc.lights.filter(l => l.type === 'ambient'); sc.lights.push(ev.light); }
      if (ev.op === 'camera') sc.camera = ev.camera;
      sc.rev = (sc.rev || 0) + 1;
    }
    if (ev.kind === 'confirm') { sc.pending = { tool: ev.tool, code: ev.code, ids: ev.ids }; msg.text += (msg.text ? '\n' : '') + '⏸ 等待确认：' + ev.tool; }
    if (!sc.agentQueue.length) msg.streaming = false;
    emit('agent.delta', { scene_id: sc.id, text: ev.text });
  }
  E.agentSend = function (sid, text) {
    need('assembly');
    const sc = E.scene(sid); if (!text || !text.trim()) fail('请输入指令');
    if (sc.step >= 5 && sc.final) fail('场景已完成最终输出');
    sc.messages.push({ role: 'user', text, by: E.user().name });
    const plan = planAgent(sc, text);
    sc.agentQueue = (sc.agentQueue || []).concat(plan); sc.agentWait = 300;
    audit('Agent 指令', sc.code, text.slice(0, 60));
  };
  E.agentConfirm = function (sid, ok) {
    const sc = E.scene(sid); const p = sc.pending; if (!p) return;
    sc.pending = null;
    if (!ok) { sc.messages.push({ role: 'agent', text: `已取消 ${p.tool}。`, tools: [] }); audit('拒绝 Agent 操作', sc.code, p.tool); return; }
    if (p.tool === 'blender.delete_objects') { sc.items = sc.items.filter(i => !p.ids.includes(i.id)); E.S.assets.forEach(a => { a.scenes = a.scenes.filter(s => s !== sc.id || sc.items.some(i => i.asset_id === a.id)); }); sc.rev = (sc.rev || 0) + 1; }
    if (p.tool === 'blender.execute_python') { sc.items.forEach(i => { i.pos[1] = 0; }); sc.rev = (sc.rev || 0) + 1; }
    sc.messages.push({ role: 'agent', text: `已执行 ${p.tool}。`, tools: [{ name: p.tool, args: { code: p.code }, result: 'ok', ms: 220 }] });
    audit('确认 Agent 操作', sc.code, p.tool + '：' + p.code);
  };
  E.sceneConfirm = function (sid, back) {
    need('assembly'); const sc = E.scene(sid);
    if (back) { sc.messages.push({ role: 'agent', text: `收到退回意见，我会保留当前上下文继续修改「${STEPS[sc.step]}」。请告诉我需要调整的地方。`, tools: [] }); audit('场景步骤退回', sc.code, STEPS[sc.step]); return; }
    if (sc.step === 0 && !sc.items.length) fail('白盒布局为空，请先给出布景指令');
    if (sc.step === 1 && !sc.stills.length) fail('请先渲染静帧');
    if (sc.step === 5) {
      const b = E.sceneBudget(sc); if (b.over) fail('性能预算有超过 100% 的项，不能进入最终输出');
      sc.final = true; audit('场景最终输出', sc.code); sc.messages.push({ role: 'agent', text: '六步流程已全部确认。可在「导出发布」中选择本场景打包。', tools: [{ name: 'export.create', args: { target: 'webxr', scene: sc.code }, result: '已在导出发布中预选本场景', ms: 120 }] }); return;
    }
    if (sc.step === 4) { const b = E.sceneBudget(sc); if (b.over) fail('性能预算有超过 100% 的项，不能进入最终输出'); }
    audit('场景步骤确认', sc.code, STEPS[sc.step]);
    sc.step++;
    const tips = { 1: '请渲染静帧供确认（render.still）。', 2: '几何审计：我会检查预算与对象穿插。', 3: '本场景无角色，可直接确认跳过绑骨动画；如需讲解员可在「角色与动画」中准备后加入。', 4: '短预览：点击播放查看相机环绕预览。', 5: '最终输出前请确认预算全部在 100% 以内。' };
    if (sc.step === 2) { const b = E.sceneBudget(sc); const close = []; for (let i = 0; i < sc.items.length; i++) for (let j = i + 1; j < sc.items.length; j++) if (Math.hypot(sc.items[i].pos[0] - sc.items[j].pos[0], sc.items[i].pos[2] - sc.items[j].pos[2]) < 0.25) close.push(sc.items[i].name + ' / ' + sc.items[j].name); sc.audit = { budget: b, overlaps: close }; sc.messages.push({ role: 'agent', text: '几何审计完成：' + (close.length ? `发现 ${close.length} 处对象穿插：${close.slice(0, 3).join('，')}` : '无对象穿插') + '；' + b.rows.map(r => `${r.name} ${Math.round(r.pct * 100)}%`).join('，'), tools: [{ name: 'budget.check', args: { preset: sc.platform }, result: b.over ? '有超出项' : '全部在预算内', ms: 140 }] }); }
    else sc.messages.push({ role: 'agent', text: `进入第 ${sc.step + 1} 步「${STEPS[sc.step]}」。${tips[sc.step] || ''}`, tools: sc.step === 1 ? [{ name: 'scene.set_step', args: { step: STEPS[sc.step] }, result: '已人工确认', ms: 40 }] : [] });
  };
  E.addStill = function (sid, dataUrl) { const sc = E.scene(sid); sc.stills.unshift({ url: dataUrl, time: E.S.clock }); sc.stills.length = Math.min(sc.stills.length, 3); audit('渲染静帧', sc.code, 'render.still'); sc.messages.push({ role: 'agent', text: '静帧已渲染，请确认构图与光照。', tools: [{ name: 'render.still', args: { camera: '主相机', size: '1280×720' }, result: '已生成静帧', ms: 900 }] }); };
  E.moveItem = function (sid, itemId, pos, rotY) { const sc = E.scene(sid); const it = sc.items.find(i => i.id === itemId); if (!it) return; if (pos) it.pos = pos; if (rotY != null) it.rotY = rotY; sc.rev = (sc.rev || 0) + 1; };

  // ---------- 导出 ----------
  E.exportChecks = function (o) {
    const project = E.project();
    const assets = exportAssets(o);
    const targets = o.targets || [];
    const P = E.S.settings.presets[targets.includes('quest') ? 'quest3' : targets.includes('webxr') ? 'webxr' : targets.includes('xr_space') ? 'xr_space' : 'quest3'];
    const mesh = assets.filter(a => a.type === 'prop');
    const tris = mesh.reduce((s, a) => s + ((E.cur(a).opt || E.cur(a).raw || {}).tris || 0), 0);
    const count = o.object_type === 'scene' ? E.scene(o.object_id).items.length : mesh.length;
    const dc = o.object_type === 'scene' ? E.sceneBudget(E.scene(o.object_id)).rows[1].used : mesh.length;
    const splatMax = Math.max(0, ...assets.filter(a => a.type !== 'prop').map(a => E.cur(a).splats || 0));
    const sceneTris = o.object_type === 'scene' ? E.sceneBudget(E.scene(o.object_id)).rows[0].used : tris;
    const checks = [];
    const budgetOk = sceneTris <= P.scene_tris && dc <= P.drawcalls && (!targets.includes('gs') || splatMax <= 500000);
    checks.push({ id: 'C1', name: '性能预算', ok: budgetOk, detail: `三角形 ${sceneTris.toLocaleString()} / ${P.scene_tris.toLocaleString()} · draw call ${dc} / ${P.drawcalls}${splatMax ? ` · splat ${splatMax.toLocaleString()}` : ''}` });
    const notPassed = assets.filter(a => !['library', 'exported'].includes(a.status));
    checks.push({ id: 'C2', name: '全部资产已通过质检', ok: assets.length > 0 && notPassed.length === 0, detail: assets.length ? (notPassed.length ? `${notPassed.length} 件未入库：${notPassed.slice(0, 3).map(a => a.code).join('、')}` : `${assets.length} 件均已入库`) : '未选择资产' });
    const lic = assets.map(a => ({ a, r: E.chainCheck(E.cur(a).license_chain, project) })).filter(x => !x.r.ok);
    checks.push({ id: 'C3', name: '许可证', ok: !E.S.settings.rules.exportCheck || lic.length === 0, detail: lic.length ? lic.slice(0, 2).map(x => `${x.a.code} ${x.r.bad[0].stage}：${x.r.bad[0].reason}`).join('；') + (E.S.settings.rules.exportCheck ? '' : '（导出检查已关闭）') : `许可链对照「${SCOPES[project.usage_scope]}」全部合规` });
    const noMark = assets.filter(a => a.source === '生成' && !(E.cur(a).aigc_mark && E.cur(a).aigc_mark.generated));
    checks.push({ id: 'C4', name: 'AIGC 标识', ok: noMark.length === 0, detail: noMark.length ? `${noMark.length} 件生成类资产缺少标识` : `隐式标识齐全；显式标识${o.settings && o.settings.aigcVisible === false ? '已关闭' : '已开启'}` });
    const her = assets.filter(a => a.heritage && a.source !== '重建');
    checks.push({ id: 'C5', name: '文物本体仅来自重建', ok: her.length === 0, detail: her.length ? `${her.length} 件文物本体资产非重建来源` : '符合文博准确性规则' });
    checks.push({ id: 'C6', name: '真机测试记录', ok: !!o.deviceTested, soft: true, detail: o.deviceTested ? '已记录真机测试' : '未完成，交付包将标记“未经真机验证”' });
    const verOk = targets.every(t => VERSION_ORDER[EXPORT_TARGETS[t].ver] <= VERSION_ORDER[E.S.release]);
    return { checks, blocked: checks.filter(c => !c.soft && !c.ok).length > 0 || !verOk || !targets.length, verOk, assets, summary: { count, tris: sceneTris, drawcalls: dc } };
  };
  function exportAssets(o) {
    if (o.object_type === 'scene') { const sc = E.scene(o.object_id); const ids = [...new Set(sc.items.map(i => i.asset_id))]; return ids.map(i => E.asset(i)); }
    return (o.asset_ids || []).map(i => E.asset(i));
  }
  E.manifestFor = function (o, assets) {
    const project = E.project();
    return {
      platform: '空间内容工场 Spatial Content Works v1.0', generated_at: new Date(E.S.clock).toISOString(), project: { name: project.name, usage_scope: SCOPES[project.usage_scope] },
      object: o.object_type === 'scene' ? { type: 'scene', code: E.scene(o.object_id).code, name: E.scene(o.object_id).name, items: E.scene(o.object_id).items.length } : { type: 'assets', count: assets.length },
      targets: o.targets.map(t => EXPORT_TARGETS[t].name), device_tested: !!o.deviceTested, device_note: o.deviceTested ? '已完成真机测试' : '未经真机验证',
      aigc_visible_mark: o.settings.aigcVisible !== false,
      assets: assets.map(a => { const v = E.cur(a); const qa = E.qaOf(v); return { code: a.code, name: a.name, version: 'v' + v.version, source: a.source, model: (v.license_chain.find(c => c.stage === '3D 生成' || c.stage === '世界生成') || {}).model_name || (a.source === '重建' ? 'COLMAP + LichtFeld Studio' : '—'), seed: v.seed ?? null, license_chain: v.license_chain.map(c => `${c.stage}:${c.model_name}(${c.license})`), license_types: [...new Set(v.license_chain.map(c => c.license))], aigc: a.source === '生成' ? { implicit: true, label: (a.ai_restore ? 'AI 复原 · ' : '') + 'AI 生成', model: v.aigc_mark.model, time: v.aigc_mark.time } : { implicit: false, label: a.source + '类，不写入生成标识' }, heritage: a.heritage, qa: qa ? { passed: qa.passed, items: qa.items.map(i => `${i.rule}:${i.result}`) } : null, device_test: o.deviceTested ? '已测试' : '未经真机验证', tris: (v.opt || v.raw || {}).tris || null, splats: v.splats || null }; }),
    };
  };
  E.createExport = function (o) {
    need('export');
    const res = E.exportChecks(o);
    if (!res.verOk) fail(`所选目标在当前发布版本 ${E.S.release} 未开放`);
    if (res.blocked) { audit('导出被阻断', o.object_type === 'scene' ? E.scene(o.object_id).code : res.assets.length + ' 件资产', res.checks.filter(c => !c.ok && !c.soft).map(c => c.name).join('、')); fail('导出被阻断：' + res.checks.filter(c => !c.ok && !c.soft).map(c => c.name).join('、'), 'blocked'); }
    const ex = { id: id('ex'), code: 'EXP-' + pad(E.S.exports.length + 1, 4), project_id: E.S.currentProjectId, object_type: o.object_type, object_id: o.object_id, asset_ids: res.assets.map(a => a.id), targets: o.targets, settings: clone(o.settings || {}), checks: res.checks, deviceTested: !!o.deviceTested, status: 'running', created_by: E.user().name, created_at: E.S.clock, size_mb: null, files: [], manifest: null, path: '' };
    ex.path = `/data/export/${ex.code}/`;
    ex.manifest = E.manifestFor(o, res.assets);
    E.S.exports.unshift(ex);
    const t = enqueue({ project_id: ex.project_id, node: 'export', model_id: 'blender', export_id: ex.id, params: { items: res.assets.length, targets: o.targets } });
    audit('创建导出', ex.code, o.targets.map(x => EXPORT_TARGETS[x].name).join(' / '));
    return ex;
  };
  function finishExport(t) {
    const ex = E.S.exports.find(x => x.id === t.export_id); if (!ex) return;
    ex.status = 'done'; ex.done_at = E.S.clock;
    const files = [];
    ex.asset_ids.forEach(aid => { const a = E.asset(aid); const v = E.cur(a); if (a.type === 'prop') files.push({ name: `assets/${a.code}_v${v.version}.glb`, mb: (v.opt || v.raw).file_mb }); else files.push({ name: `splats/${a.code}.ply`, mb: +((v.splats || 5e5) * 27 / 1048576).toFixed(1) }); if (a.status === 'library') a.status = 'exported'; });
    if (ex.object_type === 'scene') files.unshift({ name: 'scene.glb', mb: +files.reduce((s, f) => s + f.mb, 0).toFixed(2) });
    if (ex.targets.includes('webxr')) files.push({ name: 'index.html（WebXR 查看页）', mb: 0.01 });
    if (ex.targets.includes('raw')) files.push({ name: 'blender_import.py', mb: 0.01 }, { name: 'project.json', mb: 0.01 });
    if (ex.targets.includes('dome')) files.push({ name: 'domemaster_4k.png', mb: 9.6 });
    if (ex.targets.includes('quest')) files.push({ name: 'unity/Assets/SCW/ImportSettings.cs', mb: 0.01 });
    if (ex.targets.includes('xr_space')) files.push({ name: 'ue/Content/SCW/README.txt', mb: 0.01 });
    files.push({ name: 'manifest.json', mb: 0.01 }, { name: '交付说明.txt', mb: 0.01 });
    ex.files = files; ex.size_mb = +files.reduce((s, f) => s + f.mb, 0).toFixed(2);
    alert('ok', `导出 ${ex.code} 已完成（${ex.size_mb} MB）${ex.deviceTested ? '' : '，标记为未经真机验证'}`, 'export');
  }

  // ---------- 系统设置 ----------
  E.updateModel = function (mid, patch) {
    need('admin'); const m = E.model(mid);
    if (patch.allowed_scope === 'all' && !(COMMERCIAL_LICENSES.includes(m.license_type) || m.license_status === '已登记授权')) fail('需先上传授权文件并经管理员确认，才能把允许范围改为“全部项目”', 'license');
    const before = clone(m); Object.assign(m, patch);
    audit('模型登记变更', m.name, Object.keys(patch).map(k => `${k}: ${before[k]} → ${patch[k]}`).join('；'));
    if (patch.allowed_scope === 'disabled') alert('warn', `模型 ${m.name} 已被禁用，相关管线节点将自动排除`, 'settings');
  };
  E.registerModel = function (o) { need('admin'); if (!o.name || !o.node) fail('请填写模型名称与用途'); const m = Object.assign({ id: 'm_' + (++E.S.seq).toString(36), license_status: '待核对', allowed_scope: 'internal', status: '已安装', disk_gb: 0, load_s: 20, unit_s: 60, location: 'local', region_restricted: false, cost: 0, version: '1.0' }, o); if (m.license_status === '待核对') m.allowed_scope = 'internal'; E.S.models.push(m); audit('登记新模型', m.name, `${m.license_type} · ${ALLOWED[m.allowed_scope]}`); return m; };
  E.uploadLicense = function (mid, fileName) { need('admin'); const m = E.model(mid); const rec = { id: id('lic'), model_id: mid, file_name: fileName, confirmed_by: null, confirmed_at: null, valid_until: '' }; E.S.licenses.unshift(rec); m.license_status = '授权待确认'; audit('上传授权文件', m.name, fileName); return rec; };
  E.confirmLicense = function (lid, validUntil) { need('admin'); const rec = E.S.licenses.find(l => l.id === lid); rec.confirmed_by = E.user().name; rec.confirmed_at = E.S.clock; rec.valid_until = validUntil || '2027-12-31'; const m = E.model(rec.model_id); m.license_status = '已登记授权'; audit('确认授权文件', m.name, rec.file_name); };
  E.updateSettings = function (path, value) {
    need('admin'); const parts = path.split('.'); let o = E.S.settings; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    const before = o[parts[parts.length - 1]]; o[parts[parts.length - 1]] = value;
    audit('规则 / 设置变更', path, `${JSON.stringify(before)} → ${JSON.stringify(value)}（对变更后新提交的需求单生效）`);
  };
  E.setRelease = function (r) { need('admin'); E.S.release = r; audit('发布范围变更', '版本', r); };

  // ---------- 字段级修改（白名单）与小动作：页面不直接写状态，便于服务端统一执行 ----------
  const PATCHABLE = {
    recon: { list: () => E.S.recon, fields: ['capture_record.collector', 'capture_record.date', 'capture_record.control', 'capture_record.colorChart', 'forceLowRatio', 'solver', 'engine', 'iterations', 'sh', 'platform', 'splat_limit'], perm: 'recon' },
    scene: { list: () => E.S.scenes, fields: ['platform', 'name'], perm: 'assembly' },
    character: { list: () => E.S.characters, fields: ['name'], perm: 'character' },
  };
  E.patch = function (kind, oid, path, value) {
    const P = PATCHABLE[kind]; if (!P || !P.fields.includes(path)) fail('不允许修改该字段');
    need(P.perm);
    const o = P.list().find(x => x.id === oid) || fail('对象不存在');
    const parts = path.split('.'); let t = o; for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]] = t[parts[i]] || {};
    t[parts[parts.length - 1]] = value;
    if (kind === 'recon' && path === 'platform' && o.status !== 'trained') o.splat_limit = (value === 'quest3' || value === 'pico4') ? 500000 : 2000000;
    return o;
  };
  E.updateClip = function (cid, idx, o) { need('character'); const c = E.S.characters.find(x => x.id === cid) || fail('角色不存在'); const cl = c.clips[idx] || fail('片段不存在'); if (o.duration != null) cl.duration = Math.max(0.5, Math.min(20, +o.duration)); if (o.blend != null) cl.blend = Math.max(0, Math.min(1.5, +o.blend)); return cl; };
  E.removeClip = function (cid, idx) { need('character'); const c = E.S.characters.find(x => x.id === cid) || fail('角色不存在'); c.clips.splice(idx, 1); };
  E.addSceneItem = function (sid, aid, pos) {
    need('assembly'); const sc = E.scene(sid); const a = E.asset(aid);
    if (a.type !== 'prop') fail('只有道具资产可以加入场景');
    if (!['library', 'exported'].includes(a.status)) fail('只能使用已入库的资产');
    if (!E.chainCheck(E.cur(a).license_chain, E.project(sc.project_id)).ok) fail('该资产许可链不满足项目使用范围', 'license');
    const v = E.cur(a);
    const it = { id: id('it'), asset_id: a.id, version_id: v.id, name: a.name, category: a.category, pos: pos || [(Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 3], rotY: 0, scale: 1 };
    sc.items.push(it); if (!a.scenes.includes(sc.id)) a.scenes.push(sc.id); sc.rev = (sc.rev || 0) + 1;
    audit('加入场景', sc.code, a.code); return it;
  };
  E.scaleItem = function (sid, itemId, scale) { const sc = E.scene(sid); const it = sc.items.find(i => i.id === itemId); if (!it) return; it.scale = Math.max(0.2, Math.min(5, +scale)); sc.rev = (sc.rev || 0) + 1; };
  E.togglePanoUse = function (pid, u) { const p = E.S.panoramas.find(x => x.id === pid) || fail('全景不存在'); const i = p.uses.indexOf(u); i >= 0 ? p.uses.splice(i, 1) : p.uses.push(u); return p.uses; };
  E.readAlerts = function (aid) { E.S.alerts.forEach(a => { if (!aid || a.id === aid) a.read = true; }); };
  E.stopCloudNode = function (nid) { need('task.control'); const n = E.S.cloudNodes.find(x => x.id === nid) || fail('节点不存在'); if (n.state === 'off') return; n.state = 'off'; n.stopped = E.S.clock; E.S.cloudCostMonth = +(E.S.cloudCostMonth + n.cost).toFixed(2); audit('手动关机云节点', n.name, '¥' + n.cost); };
  E.setSpeed = function (v) { need('admin'); E.S.speed = Math.max(1, Math.min(60, +v || 15)); };
  E.sendToQA = function (aid) { need('optimize'); const a = E.asset(aid); const v = E.cur(a); if (!v.opt) fail('请先完成优化'); if (['qa', 'review', 'library', 'exported'].includes(a.status)) fail('该资产已在质检或已入库'); return queueQA(a, v); };
  E.createProject = function (o) {
    need('admin'); if (!o || !o.name) fail('请填写项目名称'); if (!SCOPES[o.usage_scope]) fail('使用范围取值：internal、commercial_cn、commercial_overseas');
    const p = { id: id('p'), name: o.name, usage_scope: o.usage_scope, default_platforms: (o.default_platforms || ['quest3']).filter(x => PLATFORMS[x]), client: o.client || '' };
    E.S.projects.push(p); audit('创建项目', p.name, SCOPES[p.usage_scope]); return p;
  };
  E.setViewport = function (open) { E.S.gpu.viewportOpen = !!open; };

  // ---------- 统计（工作台） ----------
  E.stats = function () {
    const S = E.S, pid = S.currentProjectId, day0 = new Date(S.clock); day0.setHours(0, 0, 0, 0);
    const pa = S.assets.filter(a => a.project_id === pid);
    const today = S.qa.filter(q => q.created_at >= +day0 && pa.some(a => a.id === q.asset_id));
    const revToday = S.reviews.filter(r => r.created_at >= +day0 && pa.some(a => a.id === r.asset_id));
    const cnt = (d) => revToday.filter(r => r.decision === d).length;
    const pass = cnt('pass'), rework = cnt('rework'), discard = cnt('discard');
    const ptasks = S.tasks.filter(t => (t.project_id || (t.job_id && (S.jobs.find(j => j.id === t.job_id) || {}).project_id)) === pid || !t.project_id && !t.job_id);
    const queued = S.tasks.filter(t => ['queued', 'running', 'paused'].includes(t.status));
    const jobs = S.jobs.filter(j => j.project_id === pid);
    const runningCloud = S.cloudNodes.reduce((s, n) => s + (n.state !== 'off' ? n.cost : 0), 0);
    return {
      candidatesToday: new Set(today.map(q => q.asset_id)).size, pendingReview: pa.filter(a => a.status === 'review').length,
      queue: queued.length, queueGpu: queued.filter(t => t.queue === 'gpu').length, queueCpu: queued.filter(t => t.queue === 'cpu').length, queueCloud: queued.filter(t => t.queue === 'cloud').length,
      passRate: pass + rework + discard ? pass / (pass + rework + discard) : null, pass, rework, discard,
      cloudMonth: +(S.cloudCostMonth + runningCloud).toFixed(2),
      board: {
        jobs: jobs.filter(j => ['submitted', 'producing'].includes(j.status)).length,
        concepts: S.concepts.filter(c => c.status === 'candidate' && jobs.some(j => j.id === c.job_id)).length,
        gen3d: pa.filter(a => a.status === 'generating').length + S.tasks.filter(t => t.node === 'image_to_3d' && ['queued', 'running'].includes(t.status) && !t.asset_id && jobs.some(j => j.id === t.job_id)).length,
        optimize: pa.filter(a => ['generated', 'optimizing'].includes(a.status)).length,
        review: pa.filter(a => ['qa', 'review', 'rework'].includes(a.status)).length,
        library: pa.filter(a => a.status === 'library').length,
        exported: pa.filter(a => a.status === 'exported').length,
      },
      ptasks,
    };
  };
  E.reworkStats = function () {
    const by = (key) => { const m = {}; E.S.reviews.forEach(r => { const k = key(r) || '—'; m[k] = m[k] || { pass: 0, rework: 0, discard: 0, reasons: {} }; m[k][r.decision]++; if (r.reason_code) m[k].reasons[r.reason_code] = (m[k].reasons[r.reason_code] || 0) + 1; }); return m; };
    return { byModel: by(r => r.model_id && E.model(r.model_id) ? E.model(r.model_id).name : null), byJob: by(r => r.job_id && E.S.jobs.find(j => j.id === r.job_id) ? E.S.jobs.find(j => j.id === r.job_id).code : null) };
  };

  // ---------- 持久化 / 时钟 ----------
  E.save = function () { try { localStorage.setItem(STORE_KEY, JSON.stringify(E.S)); } catch (e) { /* 存储不可用时仅保留内存状态 */ } };
  E.load = function () { try { const s = localStorage.getItem(STORE_KEY); if (s) { const o = JSON.parse(s); if (o && o.schema === 1) { E.S = o; return true; } } } catch (e) { } return false; };
  E.reset = function () { try { localStorage.removeItem(STORE_KEY); } catch (e) { } E.S = freshState(); seedDemo(); E.save(); emit('reset', {}); };
  E.tick = function (realMs) {
    const S = E.S; realMs = Math.min(realMs, 2000);
    const simDt = realMs / 1000 * S.speed;
    advance(simDt, realMs);
    // 云端 / 本地时钟与真实时间对齐（演示加速只压缩任务耗时）
    S.clock = Math.max(S.clock, Date.now() - 1000) ;
  };
  // 快进（模拟秒），用于初始化演示数据与自测
  E.fastForward = function (simSec, step) {
    step = step || 5; const S = E.S;
    for (let s = 0; s < simSec; s += step) advance(step, step / S.speed * 1000);
  };
  E.init = function (opts) {
    opts = opts || {};
    if (opts.fresh || !E.load()) { E.S = freshState(); if (!opts.empty) seedDemo(); E.save(); }
    E.S.clock = Math.max(E.S.clock, Date.now());
    return E;
  };

  // ---------- 演示数据：用真实流程快进生成，保证各页面数据与规则一致 ----------
  function seedDemo() {
    const S = E.S; const asUser = (uid, fn) => { const k = S.currentUserId; S.currentUserId = uid; try { return fn(); } finally { S.currentUserId = k; } };
    const start = Date.now() - 3.2 * 3600 * 1000; S.clock = start; S.speed = 15; S.lastSample = start;
    // 1. 需求单：展厅陪衬道具
    const j1 = asUser('u_pm', () => E.createJob({ title: '展厅陪衬道具 · 青铜器与宫灯', project_id: 'p_lz', content_type: 'prop', platforms: ['quest3', 'webxr'], quantity: 10, description: '商周风格青铜鼎、编钟与宫灯，陪衬展柜两侧，写实 PBR 材质，带铜锈', is_heritage: false, style_lora: 'lora-bronze' }));
    asUser('u_pm', () => E.submitJob(j1.id));
    E.fastForward(900);
    const cands = S.concepts.filter(c => c.job_id === j1.id);
    asUser('u_art', () => E.selectConcepts(cands.slice(0, 9).map(c => c.id), {}));
    E.fastForward(2400);
    // 审核一部分
    const rv = S.assets.filter(a => a.job_id === j1.id && a.status === 'review');
    asUser('u_rev', () => {
      rv.forEach((a, i) => {
        const qa = E.qaOf(E.cur(a)); const fails = qa.items.filter(x => x.result === 'fail');
        if (i < 5) { if (fails.some(f => ['Q04', 'Q06', 'Q07'].includes(f.rule))) E.autoFix(a.id); const q2 = E.qaOf(E.cur(a)); const f2 = q2.items.filter(x => x.result === 'fail'); E.review(a.id, 'pass', null, f2.length ? '陪衬道具远景使用，可接受' : ''); }
        else if (i === 5) E.review(a.id, 'rework', 'texture', '铜锈贴图拉伸');
      });
    });
    E.fastForward(600);
    // 2. 内部预研项目：使用非商用模型
    const j3 = asUser('u_art', () => E.createJob({ title: '预研 · 瓷瓶与陶罐材质测试', project_id: 'p_lab', content_type: 'prop', platforms: ['quest3'], quantity: 4, description: '青花瓷瓶与彩陶罐，测试 FLUX 与 Hunyuan3D 效果', is_heritage: false }));
    asUser('u_art', () => { j3.models = { concept_image: 'flux-dev' }; E.submitJob(j3.id); });
    // 3. 文物本体：实景重建
    const j2 = asUser('u_pm', () => E.createJob({ title: '玉琮展柜实景重建', project_id: 'p_lz', content_type: 'recon', platforms: ['quest3', 'webxr'], quantity: 1, description: '良渚玉琮展柜及周边展厅，文物本体仅允许实景重建', is_heritage: true }));
    asUser('u_pm', () => E.submitJob(j2.id));
    const d = asUser('u_art', () => E.createDataset({ name: '良渚展厅 · 玉琮展区', job_id: j2.id, photo_count: 412, resolution: '6000×4000', device: 'Sony A7R V + 24mm', overlap: '约 78%', project_id: 'p_lz', capture_record: { collector: '周美术', date: '2026-11-12', control: '8 个控制点 + 1 m 标尺', colorChart: 'X-Rite ColorChecker Classic' } }));
    asUser('u_art', () => E.solvePoses(d.id));
    E.fastForward(1400, 10);
    asUser('u_art', () => E.trainGS(d.id, { mode: 'now' }));
    E.fastForward(2600, 10);
    asUser('u_art', () => { E.cleanRecon(d.id, 'floaters'); E.cleanRecon(d.id, 'crop'); E.finishRecon(d.id); });
    E.fastForward(30);
    asUser('u_rev', () => { const a = E.asset(d.asset_id); if (a.status === 'review') E.review(a.id, 'pass', null, '精度报告 RMSE 合格'); });
    // 4. 全景
    asUser('u_art', () => E.generatePanoramas({ prompt: '黄昏下的良渚古城水岸，远山与殿宇，暖色天空', count: 4, width: 4096 }));
    E.fastForward(400);
    // 5. 角色
    asUser('u_art', () => { const c = E.createCharacter({ name: '讲解员 · 小良', project_id: 'p_lz' }); E.rigCharacter(c.id, 'import'); E.addClip(c.id, 'wave'); E.addClip(c.id, 'point'); E.createCharacter({ name: '驼队商人', project_id: 'p_sl', tris: 22610 }); });
    // 6. 场景
    asUser('u_pm', () => { const sc = E.createScene({ name: '售前样板 · 青铜器展区', project_id: 'p_lz', platform: 'quest3' }); E.agentSend(sc.id, '中央放一个青铜鼎，两侧各放一盏宫灯，后方放两件编钟，打暖色主光，设置主相机'); });
    for (let i = 0; i < 80; i++) advance(1, 400);
    // 7. 导出记录
    asUser('u_pm', () => { const lib = S.assets.filter(a => a.project_id === 'p_lz' && a.status === 'library' && a.type === 'prop').slice(0, 3); if (lib.length) { const ex = E.createExport({ object_type: 'assets', asset_ids: lib.map(a => a.id), targets: ['webxr'], settings: { texCompress: 'KTX2', meshCompress: 'Draco', aigcVisible: true, manifest: true }, deviceTested: false }); } });
    E.fastForward(300);
    // 8. 正在进行的批次（让队列和工作台“活”起来）
    const j4 = asUser('u_pm', () => E.createJob({ title: '宫灯与案几 · 第二批', project_id: 'p_lz', content_type: 'prop', platforms: ['quest3'], quantity: 6, description: '明清宫灯、红木案几与屏风，暖色调', is_heritage: false, style_lora: 'lora-palace' }));
    asUser('u_pm', () => E.submitJob(j4.id));
    E.fastForward(200);
    const c4 = S.concepts.filter(c => c.job_id === j4.id);
    if (c4.length) asUser('u_art', () => E.selectConcepts(c4.slice(0, 4).map(c => c.id), {}));
    E.fastForward(60);
    S.alerts.unshift({ id: id('al'), level: 'warn', message: '模型 FLUX.1-dev 许可待核对：仅内部原型可用，已从对外项目管线中排除', link: 'settings', time: S.clock - 3600e3, read: false });
    S.alerts.unshift({ id: id('al'), level: 'info', message: '资产盘 /data/assets 已用 24%（阈值 85%）', link: 'queue', time: S.clock - 1800e3, read: false });
    S.clock = Date.now(); S.lastSample = S.clock - 2000;
    // GPU 曲线时间轴对齐到当前
    const hist = S.gpu.history; if (hist.length) { const shift = S.clock - hist[hist.length - 1].t; hist.forEach(h => h.t += shift); const segs = S.schedule; segs.forEach(s => { s.start += shift; s.end += shift; }); }
    S.currentUserId = 'u_pm';
  }

  global.Engine = E;
})(typeof window !== 'undefined' ? window : globalThis);
