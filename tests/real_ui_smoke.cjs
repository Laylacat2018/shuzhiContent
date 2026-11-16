// Browser acceptance against the CPU fixture server; this does not test AI inference.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const { chromium } = require(process.env.SCW_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SCW_UI_BASE || 'http://127.0.0.1:8782';
const output = path.resolve('test-results/real-ui');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.SCW_CHROMIUM || undefined, headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/*', r => /^https?:/.test(r.request().url()) && !r.request().url().startsWith(base + '/') ? r.abort() : r.continue());
    await page.goto(base);
    await page.click('.role-pick button:nth-child(4)');
    await page.fill('#pw', process.env.SCW_UI_PASSWORD || 'demo-2026');
    await page.fill('#ws', 'real-test');
    await page.click('#login-btn');
    await page.waitForSelector('.shell');
    const asset = await page.evaluate(() => {
      const a = Engine.S.assets[0]; return { ...a, current: Engine.cur(a) };
    });
    assert.match(asset.current.aigc_mark.model, /TEST FIXTURE/);
    await page.evaluate(() => {
      window.__realLoads = [];
      const original = THREE.GLTFLoader.prototype.load;
      THREE.GLTFLoader.prototype.load = function (url, done, progress, fail) {
        return original.call(this, url, gltf => { window.__realLoads.push(url); done(gltf); }, progress, fail);
      };
    });
    await page.click('[data-route="gen3d"]');
    await page.waitForFunction(() => window.__realLoads.length > 0);
    for (const mode of ['实体', '线框', '法线', 'Base Color', 'Metallic', 'Roughness']) {
      await page.locator('.vp-tools').getByRole('button', { name: mode, exact: true }).click();
      await page.waitForTimeout(100);
    }
    await page.click('[data-route="optimize"]');
    await page.waitForFunction(() => window.__realLoads.length >= 3);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, 'actual-mesh-views.png') });
    await page.click('[data-route="library"]');
    await page.locator('#lib-grid .thumb').first().click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载 GLB', exact: true }).click()]);
    assert.equal(await download.failure(), null);
    const bytes = fs.readFileSync(await download.path());
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha, asset.current.file_sha256);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.click('[data-route="export"]');
    await page.getByRole('button', { name: '校验', exact: true }).filter({ visible: true }).last().click();
    await page.waitForSelector('.modal');
    assert.match(await page.locator('.modal').innerText(), /decodedTriangles/);
    await page.locator('.modal').getByRole('button',{name:'关闭',exact:true}).click();
    const [zipDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'下载',exact:true}).last().click()]);
    assert.equal(await zipDownload.failure(),null);
    const zip=await require('jszip').loadAsync(fs.readFileSync(await zipDownload.path()));
    const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
    assert.equal(manifest.production,true);
    const compressed=await zip.file(manifest.assets[0].file).async('nodebuffer');
    assert.equal(crypto.createHash('sha256').update(compressed).digest('hex'),manifest.assets[0].sha256);
    assert.equal(await page.locator('.toast.err').count(), 0);
    assert.deepEqual(errors, []);
    const report = { fixture: true, inferenceTested: false, realLoads: await page.evaluate(() => window.__realLoads), downloadedBytes: bytes.length, sha256Matched: true, zipAssetHashMatched:true,materialModes: 6, errors };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
