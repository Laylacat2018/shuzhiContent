// Exercise published, actual GLB files; this never claims to run model inference.
const assert=require('assert/strict'),fs=require('fs'),crypto=require('crypto');
const {chromium}=require(process.env.SCW_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.SCW_UI_BASE||'http://127.0.0.1:8780';
(async()=>{const browser=await chromium.launch({executablePath:process.env.SCW_CHROMIUM||undefined,headless:true,args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
try{const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});const errors=[];
page.on('pageerror',e=>errors.push(String(e)));await page.route('**/*',r=>/^https?:/.test(r.request().url())&&!r.request().url().startsWith(base+'/')?r.abort():r.continue());
await page.goto(base);await page.getByRole('link',{name:'查看真实成果与版本对比'}).waitFor();assert.equal(await page.getByRole('link',{name:'查看真实成果与版本对比'}).count(),1);
await page.goto(base+'/showcase');await page.waitForFunction(()=>window.__REVIEW?.loaded===1);await page.click('#rotate');
assert.match(await page.locator('header').innerText(),/真实成果 v1.1/);
await page.selectOption('#version','old');await page.waitForFunction(()=>window.__REVIEW.loaded===2);await page.selectOption('#version','hero');await page.waitForFunction(()=>window.__REVIEW.loaded===3);
const catalog=await (await page.request.get(base+'/showcase/catalog')).json();const hero=catalog.files.find(x=>x.name==='hero.glb');
const [dl]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'下载精细 GLB'}).click()]);assert.equal(await dl.failure(),null);const data=fs.readFileSync(await dl.path());assert.equal(crypto.createHash('sha256').update(data).digest('hex'),hero.sha256);
fs.mkdirSync('test-results/v1.1-showcase',{recursive:true});await page.screenshot({path:'test-results/v1.1-showcase/desktop.png'});
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile page has horizontal overflow');await page.screenshot({path:'test-results/v1.1-showcase/mobile.png'});
assert.deepEqual(await page.evaluate(()=>window.__REVIEW.errors),[]);assert.deepEqual(errors,[]);const report={base,version:catalog.version,loadedVariants:3,downloadHashMatched:true,mobileNoHorizontalOverflow:true,errors};fs.writeFileSync('test-results/v1.1-showcase/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
