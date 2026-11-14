#!/usr/bin/env python3
"""构建：把 web/src 下的源文件内联为单页。
输出：
  dist/index.html     —— 部署版（完整 HTML 文档，第三方库走本地 /vendor，可离线局域网使用）
  dist/artifact.html  —— 在线验收版（片段，第三方库走 jsDelivr CDN）
"""
import pathlib, shutil, subprocess

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / 'src'
DIST = ROOT.parent / 'dist'
JS_ORDER = ['geometry.js', 'engine.js', 'viewer.js', 'app-core.js', 'pages-a.js', 'pages-b.js', 'pages-c.js', 'main.js']
LIBS = [
    ('vue/dist/vue.runtime.global.prod.js', 'https://cdn.jsdelivr.net/npm/vue@3.4.38/dist/vue.runtime.global.prod.js'),
    ('three/build/three.min.js', 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js'),
    ('three/examples/js/controls/OrbitControls.js', 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js'),
    ('jszip/dist/jszip.min.js', 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'),
]


def build():
    DIST.mkdir(exist_ok=True)
    tpl = (SRC / 'index.template.html').read_text(encoding='utf-8')
    css = (SRC / 'app.css').read_text(encoding='utf-8')
    js = '\n;\n'.join((SRC / f).read_text(encoding='utf-8') for f in JS_ORDER)
    # 预编译模板（vue.runtime 无编译器，不需要 eval）
    js = subprocess.run(['node', str(ROOT / 'compile-templates.js')], input=js, capture_output=True, text=True, check=True, encoding='utf-8').stdout
    js = js.replace('</script', '<\\/script')
    def page(mode, libs):
        return (tpl.replace('/*__CSS__*/', css).replace('/*__JS__*/', js)
                .replace('__MODE__', mode).replace('<!--__LIBS__-->', libs))
    cdn = '\n'.join(f'<script src="{u}"></script>' for _, u in LIBS)
    local = '\n'.join(f'<script src="vendor/{p.split("/")[0]}/{pathlib.Path(p).name}"></script>' for p, _ in LIBS)
    (DIST / 'artifact.html').write_text(page('artifact', cdn), encoding='utf-8')
    full = '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    body = page('server', local)
    head, _, rest = body.partition('<div id="app"></div>')
    full += head + '</head>\n<body>\n<div id="app"></div>' + rest + '\n</body>\n</html>\n'
    (DIST / 'index.html').write_text(full, encoding='utf-8')
    # 第三方库落到 dist/vendor（来自 node_modules）
    nm = ROOT.parent / 'node_modules'
    for p, _ in LIBS:
        src = nm / p
        dst = DIST / 'vendor' / p.split('/')[0] / pathlib.Path(p).name
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.exists():
            shutil.copyfile(src, dst)
    print('built', (DIST / 'index.html').stat().st_size, 'bytes')


if __name__ == '__main__':
    build()
