import os, subprocess, sys, time, pathlib, socket
import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = int(os.environ.get('SCW_TEST_PORT', '8799'))
CHROME = os.environ.get('SCW_CHROMIUM', '/opt/pw-browsers/chromium')


@pytest.fixture(scope='session')
def server():
    subprocess.run([sys.executable, str(ROOT / 'web' / 'build.py')], check=True)
    p = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server.app:app', '--port', str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(('127.0.0.1', PORT), timeout=0.2).close(); break
        except OSError:
            time.sleep(0.2)
    yield f'http://127.0.0.1:{PORT}'
    p.terminate()


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
    pg.goto(server + '/')
    pg.wait_for_selector('#login-btn', timeout=30000)
    yield pg
    ctx.close()
