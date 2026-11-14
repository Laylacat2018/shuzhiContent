// 构建期预编译 Vue 模板：把 `template: \`...\`` 替换为 render 函数，
// 运行时只需 vue.runtime（不使用 eval / new Function，满足严格 CSP）。
const fs = require('fs');
const { compile } = require('@vue/compiler-dom');
const src = fs.readFileSync(0, 'utf8');
let n = 0;
const out = src.replace(/template: `([\s\S]*?)`/g, (_, tpl) => {
  const r = compile(tpl, { mode: 'function', prefixIdentifiers: true, hoistStatic: true, cacheHandlers: true, whitespace: 'condense', onError: (e) => { throw new Error('模板编译失败：' + e.message + '\n' + tpl.slice(0, 200)); } });
  n++;
  return 'render: (function () { ' + r.code + ' })()';
});
process.stderr.write(`compiled ${n} templates\n`);
process.stdout.write(out);
