import {read,write} from './db.mjs';
const tasks={},requests=new Map(),intercepting=new Set();let creating,saveChain=Promise.resolve();
const ready=(async()=>{
  Object.assign(tasks,(await chrome.storage.local.get({tasks:{}})).tasks);
  const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
  if(contexts.length)return;
  // A browser exit aborts uncommitted file writes. Reconcile committed writes before fallback.
  for(const task of Object.values(tasks)) {
    const journal=await read('job:'+task.gid);
    if(journal?.committed) {
      await chrome.downloads.cancel(task.chromeId).catch(()=>{});
    }else {
      if(journal?.directory&&await journal.directory.queryPermission({mode:'readwrite'})==='granted') {
        try {const f=await journal.directory.getFileHandle(journal.name);if((await f.getFile()).size===0)await journal.directory.removeEntry(journal.name);}catch{}
      }
      if(task.chromeId)await chrome.downloads.resume(task.chromeId).catch(()=>{});
    }
    await write('job:'+task.gid,undefined);delete tasks[task.gid];
  }
  await persist();
})();
function persist() {
  const snapshot=structuredClone(tasks);
  saveChain=saveChain.catch(()=>{}).then(async()=>{
    await chrome.storage.local.set({tasks:snapshot});
    const values=Object.values(snapshot),connecting=values.some(t=>['preparing','connecting'].includes(t.status));
    await chrome.action.setBadgeText({text:connecting?'…':String(values.length||'')});
    await chrome.action.setBadgeBackgroundColor({color:'#155bd7'});
  });return saveChain;
}
async function directoryStatus() {
  const directory=await read('directory');
  if(!directory)return {ready:false,note:'尚未设置下载文件夹，请先选择文件夹以启用多线程下载。'};
  const granted=await directory.queryPermission({mode:'readwrite'})==='granted';
  return {ready:granted,name:directory.name,note:granted?'':'下载文件夹需要重新授权，请点击“选择文件夹”。'};
}
async function feedback(tabId,text,chooseDirectory=false) {
  if(tabId>=0)await chrome.tabs.sendMessage(tabId,{type:'download-feedback',text,chooseDirectory}).catch(()=>{});
}
async function engine(action,args={}) {
  if(!creating)creating=(async()=>{
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
    if(!contexts.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS'],justification:'在后台 Worker 中流式分段下载并直接写入用户授权的文件夹'});
  })().finally(()=>{creating=null;});
  await creating;
  const response=await chrome.runtime.sendMessage({target:'engine',action,...args});
  if(!response?.ok)throw Error(response?.error||'下载引擎未响应');return response.result;
}
chrome.webRequest.onBeforeSendHeaders.addListener(d=>{
  if(d.initiator===chrome.runtime.getURL('').replace(/\/$/,''))return;
  const privateRequest=(d.requestHeaders||[]).some(h=>['cookie','authorization','proxy-authorization'].includes(h.name.toLowerCase()));
  requests.set(d.url,{method:d.method,privateRequest,tabId:d.tabId,time:Date.now()});
  for(const [url,r] of requests)if(Date.now()-r.time>60000)requests.delete(url);
  while(requests.size>512)requests.delete(requests.keys().next().value);
},{urls:['http://*/*','https://*/*']},['requestHeaders','extraHeaders']);

async function fallback(task,note) {
  try{await engine('cancel',{gid:task.gid});}catch{}
  if(task.chromeId) {
    const [original]=await chrome.downloads.search({id:task.chromeId});
    if(original?.state==='in_progress'&&original.paused||original?.state==='interrupted'&&original.canResume)await chrome.downloads.resume(task.chromeId).catch(()=>{});
  }
  delete tasks[task.gid];await persist();
  await chrome.storage.local.set({notice:note});await feedback(task.tabId,note);
}
async function accept(item,manual=false,tabId=-1) {
  await ready;
  if(intercepting.has(item.id)||Object.values(tasks).some(t=>t.chromeId===item.id&&item.id))return;
  const settings=await chrome.storage.local.get({enabled:true,connections:8});
  const url=item.finalUrl||item.url,request=requests.get(url);
  if(!manual&&(!settings.enabled||item.byExtensionId||item.incognito||item.paused||item.state!=='in_progress'||!['safe','accepted'].includes(item.danger)))return;
  if(!/^https?:\/\//.test(url))return;
  const gid=crypto.randomUUID();tabId=manual?tabId:(request?.tabId??-1);
  const folder=await directoryStatus();
  if(!folder.ready){await feedback(tabId,folder.note,true);return;}
  if(!manual) {
    const reason=!request||Date.now()-request.time>60000?'未能识别下载请求':request.privateRequest?'该请求携带网站登录或认证信息':request.method!=='GET'?'该下载由网页表单发起':item.totalBytes>=0&&item.totalBytes<2*1024*1024?'文件小于 2 MB':'';
    if(reason){const notice=reason+'，本次使用 Chrome 下载。';await chrome.storage.local.set({notice});await feedback(tabId,notice);return;}
  }
  await chrome.storage.local.set({notice:''});
  const task={gid,chromeId:item.id||null,url,name:item.filename?.split(/[\\/]/).pop()||decodeURIComponent(new URL(url).pathname.split('/').pop()||'download.bin'),tabId,created:Date.now(),status:'preparing',completedLength:0,totalLength:item.totalBytes||0,connections:settings.connections};
  tasks[gid]=task;intercepting.add(item.id);await persist();
  await feedback(tabId,'下载已接收，正在连接…');
  try {
    const directory=await read('directory');
    if(!directory||await directory.queryPermission({mode:'readwrite'})!=='granted')throw Error('请在插件设置中选择下载文件夹；原下载仍由 Chrome 处理');
    if(item.id) {
      await chrome.downloads.pause(item.id);
      const [current]=await chrome.downloads.search({id:item.id});
      if(!current||current.state!=='in_progress'||!current.paused)throw Error('原下载已结束');
    }
    await engine('add',{task:{...task,expected:item.totalBytes}});
    if(item.id&&tasks[gid]) {
      const [current]=await chrome.downloads.search({id:item.id});
      if(!current||current.state!=='in_progress'||!current.paused)await fallback(task,'原下载已变更，已停止多线程接管');
    }
  }catch(e){await fallback(task,e.message);}finally{intercepting.delete(item.id);}
}
// Earliest browser-confirmed signal; no guessing based on arbitrary page buttons.
chrome.downloads.onCreated.addListener(item=>{
  const request=requests.get(item.finalUrl||item.url);
  if(request&&!item.incognito&&!item.byExtensionId)void (async()=>{
    const s=await chrome.storage.local.get({enabled:true});if(!s.enabled)return;
    const directory=await directoryStatus();
    await feedback(request.tabId,directory.ready?'下载已接收':directory.note,!directory.ready);
  })();
});
chrome.downloads.onDeterminingFilename.addListener((item,suggest)=>{suggest();void accept(item);});
chrome.downloads.onChanged.addListener(async d=>{
  await ready;if(intercepting.has(d.id))return;
  const task=Object.values(tasks).find(t=>t.chromeId===d.id);if(!task)return;
  if(d.state?.current==='interrupted'||d.paused?.current===false)await fallback(task,d.paused?.current===false?'已切回 Chrome 下载':'下载已取消');
});
chrome.runtime.onInstalled.addListener(()=>{
  chrome.contextMenus.create({id:'parallel',title:'使用多线程下载',contexts:['link']});
});
chrome.contextMenus.onClicked.addListener((info,tab)=>{
  if(info.menuItemId==='parallel')void accept({url:info.linkUrl,totalBytes:-1},true,tab?.id??-1);
});
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||m.target!=='background')return;
  (async()=>{
    if(m.action==='directory-status')return directoryStatus();
    if(m.action==='open-settings'){await chrome.runtime.openOptionsPage();return {};}
    await ready;
    if(m.action==='view')return {tasks:Object.values(tasks).sort((a,b)=>b.created-a.created),directory:await directoryStatus(),settings:await chrome.storage.local.get({enabled:true,connections:8,theme:'system',directoryName:'未选择',notice:''})};
    if(m.action==='state') {
      if(sender.url!==chrome.runtime.getURL('offscreen.html'))throw Error('无效状态来源');
      const task=tasks[m.state.gid];if(!task)return {};
      Object.assign(task,m.state);
      if(task.status==='complete') {
        delete tasks[task.gid];await persist();
        if(task.chromeId)await chrome.downloads.cancel(task.chromeId).catch(()=>{});
        await engine('forget',{gid:task.gid});await feedback(task.tabId,'下载完成：'+task.name);
      }else if(task.status==='error')await fallback(task,'多线程未完成：'+task.note+(task.chromeId?'；已尝试切回 Chrome':''));
      else if(task.status==='cancelled'){delete tasks[task.gid];await persist();}
      else await persist();return {};
    }
    if(m.action==='engine-failed'){for(const task of Object.values(tasks))await fallback(task,'下载引擎中断，已尝试恢复 Chrome 下载');return {};}
    if(m.action==='settings') {
      await chrome.storage.local.set({enabled:!!m.enabled,connections:[4,8,16,32,64].includes(Number(m.connections))?Number(m.connections):8,theme:['system','light','dark'].includes(m.theme)?m.theme:'system'});return {};
    }
    const task=tasks[m.gid];if(!task)throw Error('任务已结束');
    if(m.action==='fallback'){await fallback(task,'已切回 Chrome 下载');return {};}
    if(!['pause','start','cancel'].includes(m.action))throw Error('未知操作');
    await engine(m.action,{gid:task.gid});
    if(m.action==='cancel'){delete tasks[task.gid];await persist();if(task.chromeId)await chrome.downloads.cancel(task.chromeId).catch(()=>{});}
    return {};
  })().then(result=>respond({ok:true,result}),e=>respond({ok:false,error:e.message}));return true;
});
