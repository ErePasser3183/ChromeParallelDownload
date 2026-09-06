const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'work'),{recursive:true});
const dir=fs.mkdtempSync(path.join(root,'work','native-browser-')),destination=path.join(dir,'files'),profile=path.join(dir,'profile');
fs.mkdirSync(destination);fs.mkdirSync(path.join(profile,'Default'),{recursive:true});
fs.writeFileSync(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:path.join(dir,'chrome-downloads'),prompt_for_download:false}}));
const content=Buffer.alloc(16*1024*1024+113);for(let i=0;i<content.length;i++)content[i]=(i*7+13)%251;
const expected=crypto.createHash('sha256').update(content).digest('hex');let rangeRequests=0;
const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<a href="/native-test.zip" download>下载测试文件</a>');return;}
  if(req.url==='/favicon.ico'){res.writeHead(404).end();return;}
  const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');if(range)rangeRequests++;
  const a=range?+range[1]:0,b=range&&range[2]?Math.min(+range[2],content.length-1):content.length-1;
  const headers={'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="native-test.zip"','ETag':'"fixture-v1"','Content-Length':b-a+1,'Accept-Ranges':'bytes'};
  if(range)headers['Content-Range']='bytes '+a+'-'+b+'/'+content.length;
  res.writeHead(range?206:200,headers);if(req.method==='HEAD'){res.end();return;}
  let at=a;const tick=()=>{if(res.destroyed)return;const next=Math.min(b+1,at+65536);res.write(content.subarray(at,next));at=next;if(at>b)res.end();else setTimeout(tick,100);};tick();
});
(async()=>{
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const secret=crypto.randomBytes(24).toString('hex'),config=path.join(dir,'config.json');
  fs.writeFileSync(config,JSON.stringify({port,secret,download_dir:destination,jobs_file:path.join(dir,'jobs.json')}));
  const engine=spawn(path.join(root,'native/aria2c-local64.exe'),['--no-conf=true','--enable-rpc=true','--rpc-listen-all=false','--rpc-listen-port='+port,'--rpc-secret='+secret,'--quiet=true','--file-allocation=none','--min-split-size=1M','--split=64','--max-connection-per-server=64','--enable-dht=false','--follow-torrent=false','--follow-metalink=false'],{windowsHide:true,stdio:'ignore'});
  let context;
  try{
    for(let n=0;n<50;n++){try{const r=await fetch('http://127.0.0.1:'+port+'/jsonrpc',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:'test',method:'aria2.getVersion',params:['token:'+secret]})});if((await r.json()).result)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const extension=path.join(root,'extension');
    context=await chromium.launchPersistentContext(profile,{executablePath:process.env.CHROME_TEST_PATH||path.join(root,'work/playwright-browsers/chromium-1234/chrome-win64/chrome.exe'),headless:true,env:{...process.env,CHROME_PARALLEL_DOWNLOAD_CONFIG:config},args:['--disable-extensions-except='+extension,'--load-extension='+extension],acceptDownloads:true});
    const cdp=await context.newCDPSession(context.pages()[0]);await cdp.send('Browser.setDownloadBehavior',{behavior:'default'});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).hostname;
    const ui=await context.newPage();await ui.goto('chrome-extension://'+id+'/popup.html');await ui.setViewportSize({width:430,height:650});
    await ui.waitForFunction(()=>document.getElementById('engine').textContent.includes('已连接'),{},{timeout:15000});
    await ui.locator('#connections').selectOption('64');await ui.waitForFunction(async()=>(await chrome.storage.local.get('connections')).connections===64);
    const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/');
    await page.getByRole('link',{name:'下载测试文件'}).click();await page.locator('#cpd-download-feedback').waitFor();
    await ui.bringToFront();await ui.locator('.task').waitFor();
    await ui.getByRole('button',{name:'暂停',exact:true}).click();await ui.getByRole('button',{name:'继续',exact:true}).waitFor();
    await ui.screenshot({path:path.join(dir,'native-panel.png')});
    await ui.getByRole('button',{name:'继续',exact:true}).click();
    const target=path.join(destination,'native-test.zip');
    for(let n=0;n<300&&!fs.existsSync(target);n++)await new Promise(r=>setTimeout(r,100));
    assert(fs.existsSync(target),'Native download did not complete');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),expected);
    await ui.waitForFunction(async()=>Object.keys((await chrome.storage.local.get({tasks:{}})).tasks).length===0,{},{timeout:15000});
    assert(rangeRequests>1);assert(!fs.existsSync(path.join(destination,'.ChromeParallelDownload')),'Native staging must be cleaned');
    console.log('Real Chrome -> registered Native Messaging -> Python -> aria2: PASS');
    console.log('64-way setting, click feedback, pause/resume, SHA-256 and staging cleanup: PASS');
    console.log('Screenshot: '+path.join(dir,'native-panel.png'));
  }finally{if(context)await context.close();engine.kill();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
