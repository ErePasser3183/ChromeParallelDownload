const vm=require('vm'), fs=require('fs'), assert=require('assert/strict'), {webcrypto}=require('crypto');
const path=require('path');
const source=fs.readFileSync(path.join(__dirname,'..','extension','background.js'),'utf8');
function harness(seed={}) {
  const store={tasks:{},...seed}, downloads=new Map(), nativeJobs=new Map(), calls=[];
  const listeners={}; let failPing=false, failStart=false;
  const event=name=>({addListener:fn=>listeners[name]=fn});
  const chrome={
    storage:{local:{get:async defaults=>structuredClone({...defaults,...store}),set:async x=>Object.assign(store,structuredClone(x))}},
    runtime:{id:'test',onMessage:event('message'),connectNative:()=>({
      onMessage:event('nativeMessage'),onDisconnect:event('disconnect'),
      postMessage:m=>{calls.push(m.action);queueMicrotask(()=>{
        let result={};let ok=true;
        if(m.action==='ping'){if(failPing)ok=false;else result={version:'1.37.0',directory:'D:\\Downloads'};}
        if(m.action==='prepare'){nativeJobs.set(m.gid,{gid:m.gid,status:'paused'});result={gid:m.gid};}
        if(m.action==='start'){if(failStart)ok=false;else nativeJobs.get(m.gid).status='active';}
        if(m.action==='cancel'){if(nativeJobs.has(m.gid))nativeJobs.get(m.gid).status='removed';}
        if(m.action==='status')result=m.gids.map(gid=>nativeJobs.get(gid)||{gid,status:'missing'});
        listeners.nativeMessage({id:m.id,ok,result,error:'test failure'});
      });}
    })},
    webRequest:{onBeforeSendHeaders:event('request')},
    downloads:{onDeterminingFilename:event('filename'),onChanged:event('changed'),
      pause:async id=>{calls.push('chrome.pause');downloads.get(id).paused=true;},
      resume:async id=>{calls.push('chrome.resume');downloads.get(id).paused=false;},
      cancel:async id=>{calls.push('chrome.cancel');downloads.get(id).state='interrupted';},
      search:async({id})=>downloads.has(id)?[structuredClone(downloads.get(id))]:[]},
    alarms:{create:()=>{},onAlarm:event('alarm')},action:{setBadgeText:async()=>{},openPopup:async()=>calls.push('popup.open')}
  };
  const context=vm.createContext({chrome,crypto:webcrypto,console,setTimeout,clearTimeout,setInterval:()=>{},Uint8Array,Date});
  vm.runInContext(source,context);
  return {store,downloads,nativeJobs,calls,listeners,context,setFailPing:()=>failPing=true,setFailStart:()=>failStart=true};
}
const run=(h,code)=>vm.runInContext(code,h.context);
function item(h,overrides={},request={}) {
  const d={id:1,url:'https://example.org/file.zip',finalUrl:'https://example.org/file.zip',filename:'D:\\Downloads\\file.zip',totalBytes:16000000,paused:false,state:'in_progress',danger:'safe',...overrides};
  h.downloads.set(d.id,d);
  h.listeners.request({url:d.finalUrl,method:'GET',requestId:'1',requestHeaders:[],...request});
  h.context.testItem=d;
  return d;
}
(async()=>{
  let h=harness();item(h);await run(h,'intercept(testItem)');
  assert.equal(h.downloads.get(1).paused,true);assert.equal(Object.values(h.store.tasks)[0].status,'active');
  assert(h.calls.indexOf('prepare')<h.calls.indexOf('start'));assert(!h.calls.includes('chrome.cancel'));
  let t=Object.values(h.store.tasks)[0];h.nativeJobs.set(t.gid,{gid:t.gid,status:'complete',path:'D:\\Downloads\\file.zip'});
  await run(h,'poll()');assert.equal(h.store.tasks[t.gid],undefined);assert(h.calls.includes('chrome.cancel'));
  console.log('Successful handoff keeps Chrome backup until native completion: PASS');
  h=harness();item(h);await run(h,'intercept(testItem)');t=Object.values(h.store.tasks)[0];
  h.nativeJobs.set(t.gid,{gid:t.gid,status:'error'});await run(h,'poll()');
  assert.equal(h.downloads.get(1).paused,false);assert.equal(h.store.tasks[t.gid],undefined);
  console.log('Native failure cancels native job and resumes original Chrome download: PASS');
  h=harness();h.setFailPing();item(h);await run(h,'intercept(testItem)');assert(!h.calls.includes('chrome.pause'));
  console.log('Missing native host never pauses original: PASS');
  h=harness();h.setFailStart();item(h);await run(h,'intercept(testItem)');assert.equal(h.downloads.get(1).paused,false);
  console.log('Start failure restores paused Chrome download: PASS');
  for(const [overrides,request] of [[{url:'blob:x',finalUrl:'blob:x'},{}],[{incognito:true},{}],[{danger:'url'},{}],[{totalBytes:100},{}],[{byExtensionId:'other'},{}],[{}, {method:'POST'}],[{}, {requestHeaders:[{name:'Cookie',value:'secret'}]}],[{}, {requestHeaders:[{name:'Authorization',value:'secret'}]}]]) {
    h=harness();item(h,overrides,request);await run(h,'intercept(testItem)');assert(!h.calls.includes('chrome.pause'));
  }
  console.log('Blob, incognito, danger, small, other extension, POST, cookie/auth bypass: PASS');
  h=harness({enabled:false});item(h);await run(h,'intercept(testItem)');assert(!h.calls.includes('chrome.pause'));
  console.log('Disabled automatic capture leaves downloads untouched: PASS');
  h=harness();item(h);await run(h,'intercept(testItem)');t=Object.values(h.store.tasks)[0];
  h.downloads.get(1).state='interrupted';await h.listeners.changed({id:1,state:{current:'interrupted'}});
  assert.equal(h.store.tasks[t.gid],undefined);assert.equal(h.nativeJobs.get(t.gid).status,'removed');
  console.log('Cancelling original Chrome task stops external task: PASS');
  h=harness({tasks:{a:{gid:'a',chromeId:1,name:'recovery.zip',status:'active'}}});
  h.downloads.set(1,{id:1,state:'in_progress',paused:true});await run(h,'ready');await new Promise(setImmediate);await run(h,'poll()');
  assert.equal(h.downloads.get(1).paused,false);assert.equal(h.store.tasks.a,undefined);
  console.log('Worker recovery with missing engine job resumes Chrome: PASS');
  h=harness();item(h);await run(h,'intercept(testItem)');t=Object.values(h.store.tasks)[0];
  h.downloads.get(1).paused=false;await run(h,'poll()');
  assert.equal(h.store.tasks[t.gid],undefined);
  assert(!h.calls.includes('popup.open'));
  console.log('Switching back to Chrome removes plugin history without a popup: PASS');
  h=harness({tasks:{done:{gid:'done',status:'complete'},cancelled:{gid:'cancelled',status:'cancelled'},keep:{gid:'keep',chromeId:1,status:'paused'}}});
  h.downloads.set(1,{id:1,state:'in_progress',paused:true});h.nativeJobs.set('keep',{gid:'keep',status:'paused'});
  await run(h,'ready');assert.deepEqual(Object.keys(h.store.tasks),['keep']);
  console.log('Upgrade clears old history while preserving paused tasks: PASS');
  for (const connections of [32, 64]) {
    h=harness();await run(h,'ready');
    const result=await new Promise(resolve=>h.listeners.message({action:'settings',enabled:true,connections},{id:'test'},resolve));
    assert.equal(result.ok,true);assert.equal(h.store.connections,connections);
    item(h);await run(h,'intercept(testItem)');
    assert.equal(Object.values(h.store.tasks)[0].status,'active');
    assert(!h.calls.includes('popup.open'));
  }
  assert(!/openPopup|showPanel/.test(source));
  h=harness({enabled:false,connections:64});await run(h,'ready');
  const message=msg=>new Promise(resolve=>h.listeners.message(msg,{id:'test'},resolve));
  for(const theme of ['dark','light','system']) {
    assert.equal((await message({action:'theme',theme})).ok,true);
    assert.equal(h.store.theme,theme);
    assert.equal(h.store.enabled,false);assert.equal(h.store.connections,64);
  }
  assert.equal((await message({action:'theme',theme:'unknown'})).ok,false);
  for(const action of ['set_directory','choose_directory']) {
    assert.equal((await message({action,directory:'D:\\Downloads'})).ok,true);
    assert(h.calls.includes(action));
  }
  console.log('Theme validation/persistence and native directory routing: PASS');
  console.log('32/64 settings accepted; no automatic popup code path remains: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
