// 用 Khronos glTF-Validator 校验 GLB：node tests/validate_gltf.js a.glb [b.glb ...]
const fs = require('fs');
const validator = require('gltf-validator');
(async () => {
  let bad = 0; const out = [];
  for (const f of process.argv.slice(2)) {
    const r = await validator.validateBytes(new Uint8Array(fs.readFileSync(f)));
    const i = r.issues;
    out.push({ file: f, errors: i.numErrors, warnings: i.numWarnings, triangles: r.info && r.info.totalTriangleCount, messages: i.messages.filter(m => m.severity === 0).slice(0, 5).map(m => m.code + ' ' + m.message) });
    if (i.numErrors) bad++;
  }
  console.log(JSON.stringify(out));
  process.exit(bad ? 1 : 0);
})();
