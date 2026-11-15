import os, subprocess, sys, time, pathlib, socket, tempfile
import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = int(os.environ.get('SCW_TEST_PORT', '8799'))
CHROME = os.environ.get('SCW_CHROMIUM', '/opt/pw-browsers/chromium')


@pytest.fixture(scope='session')
def server():
    subprocess.run([sys.executable, str(ROOT / 'web' / 'build.py')], check=True)
    env = dict(os.environ, SCW_ALLOW_FASTFORWARD='1', SCW_DATA=tempfile.mkdtemp(prefix='scw-test-'))
    p = start_server(PORT, env)
    yield f'http://127.0.0.1:{PORT}'
    p.terminate()
    p.wait(10)


def start_server(port, env):
    p = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server.app:app', '--port', str(port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            socket.create_connection(('127.0.0.1', port), timeout=0.2).close(); break
        except OSError:
            time.sleep(0.2)
    return p


@pytest.fixture(scope='session')
def browser():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        kw = {'args': ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']}
        if os.path.exists(CHROME):
            kw['executable_path'] = CHROME
        b = pw.chromium.launch(**kw)
        yield b
        b.close()


@pytest.fixture()
def page(browser, server):
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
    pg = ctx.new_page()
    pg.errors = []
    pg.on('pageerror', lambda e: pg.errors.append(str(e)))
    pg.on('console', lambda m: pg.errors.append(m.text) if m.type == 'error' else None)
    pg.goto(server + '/standalone')   # 浏览器内引擎（规则级用例可直接调用 Engine 快进）
    pg.wait_for_selector('#login-btn', timeout=30000)
    yield pg
    ctx.close()
