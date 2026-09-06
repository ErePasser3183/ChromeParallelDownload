const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'work'),{recursive:true});
const dir=fs.mkdtempSync(path.join(root,'work','browser-'));
const extension=process.env.EXTENSION_TEST_PATH||path.join(root,'extension');
const content=Buffer.alloc(5*1024*1024+111);for(let i=0;i<content.length;i++)content[i]=(i*7+13)%251;
const expected=crypto.createHash('sha256').update(content).digest('hex'), requests=[];
const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<a href="/test.zip" download>下载测试文件</a>');return;}
  if(req.url==='/favicon.ico'){res.writeHead(404).end();return;}
  const range=/bytes=(\d+)-(\d+)/.exec(req.headers.range||'');
  let a=range?+range[1]:0,b=range?Math.min(+range[2],content.length-1):content.length-1;
  requests.push({method:req.method,range:req.headers.range||null,path:req.url});
  const headers={'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="test.zip"','ETag':'"fixture-v1"','Content-Length':b-a+1,'Accept-Ranges':'bytes'};
  if(range)headers['Content-Range']=`bytes ${a}-${b}/${content.length}`;
  const send=()=>{if(res.destroyed)return;res.writeHead(range?206:200,headers);let at=a;const tick=()=>{if(res.destroyed)return;const next=Math.min(b+1,at+32768);res.write(content.subarray(at,next));at=next;if(at>b)res.end();else setTimeout(tick,8);};tick();};
  setTimeout(send,range?5:500);
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{
    executablePath:process.env.CHROME_TEST_PATH||path.join(root,'work/playwright-browsers/chromium-1234/chrome-win64/chrome.exe'),headless:true,
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],acceptDownloads:true,downloadsPath:path.join(dir,'downloads')
  });
  const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  try {
    const cdp=await context.newCDPSession(context.pages()[0]);
    await cdp.send('Browser.setDownloadBehavior',{behavior:'default'});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const id=new URL(worker.url()).hostname;assert(id);console.log('Chrome unpacked extension loaded without native host:',id);
    const ui=await context.newPage();await ui.goto(`chrome-extension://${id}/options.html`);
    console.log('Options snapshot:',await ui.locator('body').innerText());
    await ui.goto(`chrome-extension://${id}/popup.html`);
    await ui.waitForFunction(()=>document.getElementById('notice').textContent.includes('尚未设置下载文件夹'));
    const promptPage=await context.newPage();
    await context.addCookies([{name:'test-auth',value:'fixture',url:`http://127.0.0.1:${server.address().port}`}]);
    await promptPage.goto(`http://127.0.0.1:${server.address().port}/`);
    await promptPage.getByRole('link',{name:'下载测试文件'}).click();
    const warning=promptPage.locator('#cpd-download-feedback');
    await promptPage.waitForFunction(()=>document.getElementById('cpd-download-feedback')?.getAttribute('aria-label')?.includes('尚未设置下载文件夹'));
    await new Promise(r=>setTimeout(r,4000));
    assert((await warning.getAttribute('aria-label')).includes('尚未设置下载文件夹'),'Folder warning must survive the old 3.5s timeout');
    await warning.screenshot({path:path.join(dir,'folder-warning.png')});
    await warning.waitFor({state:'hidden',timeout:6000});
    const initial=await ui.evaluate(async()=>({downloads:await chrome.downloads.search({}),contexts:await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})}));
    assert(initial.downloads.length>0);assert(initial.downloads.every(d=>!d.paused));assert.equal(initial.contexts.length,0);
    await ui.evaluate(async()=>{for(const d of await chrome.downloads.search({}))if(d.state==='in_progress')await chrome.downloads.cancel(d.id);});
    await context.clearCookies();await promptPage.close();requests.length=0;
    console.log('Missing folder: popup notice + page warning with countdown and automatic dismissal; Chrome untouched: PASS');
    // Use actual browser file handles in isolated OPFS; never automate the user's permission picker.
    await ui.evaluate(async()=>{const {write}=await import('./db.mjs');const dir=await navigator.storage.getDirectory();await write('directory',dir);await chrome.storage.local.set({directoryName:'隔离测试目录',enabled:true,connections:4});});
    await ui.goto(`chrome-extension://${id}/popup.html`);await ui.setViewportSize({width:430,height:650});
    await ui.locator('#connections').selectOption('64');
    await ui.waitForFunction(async()=>(await chrome.storage.local.get('connections')).connections===64);
    await ui.reload();await ui.waitForFunction(()=>document.getElementById('connections').value==='64');
    console.log('64-way option accepted and persisted after popup reload: PASS');
    const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
    console.log('Download page snapshot:',await page.locator('body').innerText());
    const clickAt=Date.now();await page.getByRole('link',{name:'下载测试文件'}).click();
    await page.locator('#cpd-download-feedback').waitFor({timeout:1000});
    console.log('Click feedback visible after',Date.now()-clickAt,'ms (website headers delayed 500 ms)');
    await ui.locator('.task').waitFor({timeout:10000});
    await ui.bringToFront();
    await ui.waitForFunction(async()=>Object.values((await chrome.storage.local.get({tasks:{}})).tasks).some(t=>t.status==='active'));
    await ui.getByRole('button',{name:'暂停',exact:true}).click();
    await ui.getByRole('button',{name:'继续',exact:true}).waitFor();
    await ui.screenshot({path:path.join(dir,'downloading.png')});
    await ui.getByRole('button',{name:'继续',exact:true}).click();
    const hash=await ui.evaluate(async()=>{
      const dir=await navigator.storage.getDirectory();
      for(let n=0;n<200;n++) {
        try {const file=await (await dir.getFileHandle('test.zip')).getFile();if(file.size>0){const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');}}catch{}
        await new Promise(r=>setTimeout(r,100));
      }throw Error('Browser download did not finish');
    });
    assert.equal(hash,expected);assert(requests.filter(r=>r.range).length>1);assert(requests.every(r=>r.method==='GET'));
    await ui.waitForFunction(async()=>Object.keys((await chrome.storage.local.get({tasks:{}})).tasks).length===0);
    console.log('Real Chrome -> offscreen -> module Worker -> file handle: SHA-256 matched; tasks cleaned; range requests:',requests.filter(r=>r.range).length);
    await page.getByRole('link',{name:'下载测试文件'}).click();
    await ui.bringToFront();
    await ui.waitForFunction(async()=>Object.values((await chrome.storage.local.get({tasks:{}})).tasks).some(t=>t.status==='active'));
    await ui.getByRole('button',{name:'取消',exact:true}).click();
    await ui.waitForFunction(async()=>Object.keys((await chrome.storage.local.get({tasks:{}})).tasks).length===0);
    const files=await ui.evaluate(async()=>{const names=[];for await(const name of (await navigator.storage.getDirectory()).keys())names.push(name);return names;});
    assert.deepEqual(files,['test.zip']);console.log('Browser pause/resume and cancellation cleanup: PASS');
    const pickerExists=await ui.evaluate(()=>typeof showDirectoryPicker==='function');assert(pickerExists);
    assert.deepEqual(errors,[]);console.log('No browser page errors. Native-free download integration: PASS');
    console.log('Screenshots and isolated browser profile:',dir);
  }finally{await context.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.closeAllConnections();server.close();});
