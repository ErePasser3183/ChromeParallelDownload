// Isolated-world listener: page code cannot submit download commands.
let directoryWarning=false,feedbackTimer,feedbackTick;
function hideFeedback() {
  clearTimeout(feedbackTimer);clearInterval(feedbackTick);
  directoryWarning=false;document.getElementById('cpd-download-feedback')?.remove();
}
function showFeedback(text,chooseDirectory=false) {
  if(directoryWarning&&!chooseDirectory)return;
  hideFeedback();
  directoryWarning=chooseDirectory;
  const host=document.createElement('div');host.id='cpd-download-feedback';
  host.style.cssText='position:fixed;right:24px;bottom:24px;z-index:2147483647;pointer-events:none';
  const root=host.attachShadow({mode:'closed'}), box=document.createElement('div');
  box.setAttribute('role','status');box.textContent='↓ '+text;
  box.style.cssText='padding:12px 14px;border-radius:12px;background:#155bd7;color:white;font:13px/1.5 system-ui;box-shadow:0 5px 24px #0003;max-width:min(320px,calc(100vw - 76px))';
  root.append(box);(document.body||document.documentElement).append(host);
  host.setAttribute('role','status');host.setAttribute('aria-label',text);
  if(chooseDirectory) {
    host.style.pointerEvents='auto';
    const actions=document.createElement('div');actions.style.cssText='display:flex;align-items:center;gap:8px;margin-top:10px';
    const choose=document.createElement('button');choose.textContent=chooseDirectory==='refresh'?'刷新网页':'选择文件夹';
    choose.style.cssText='padding:5px 10px;border:0;border-radius:6px;background:white;color:#155bd7;cursor:pointer;font:inherit;white-space:nowrap';
    choose.onclick=async()=>{
      if(chooseDirectory==='refresh'){window.location.reload();return;}
      try{const r=await chrome.runtime.sendMessage({target:'background',action:'open-settings'});if(!r?.ok)throw Error(r?.error||'后台未响应');}
      catch{showFeedback('无法打开扩展设置，请刷新网页后重试。','refresh');}
    };
    const close=document.createElement('button');close.textContent='关闭';close.style.cssText=choose.style.cssText;
    close.onclick=hideFeedback;
    const ring=document.createElement('span');ring.title='8 秒后自动关闭';ring.setAttribute('aria-hidden','true');
    ring.style.cssText='margin-left:auto;flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center';
    const remaining=document.createElement('span');remaining.style.cssText='width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:#155bd7;color:white;font:11px/1 system-ui;font-variant-numeric:tabular-nums';
    ring.append(remaining);actions.append(choose,close,ring);box.append(actions);
    const deadline=Date.now()+8000;
    const updateCountdown=()=>{const left=Math.max(0,deadline-Date.now());remaining.textContent=String(Math.ceil(left/1000));ring.style.background=`conic-gradient(white ${left/8000*360}deg,rgba(255,255,255,.25) 0deg)`;if(left===0)hideFeedback();};
    updateCountdown();feedbackTick=setInterval(updateCountdown,100);feedbackTimer=setTimeout(hideFeedback,8000);
  }else feedbackTimer=setTimeout(hideFeedback,3500);
}
chrome.runtime.onMessage.addListener(message => {
  if(message.type==='download-feedback')showFeedback(message.text,message.chooseDirectory);
});
let feedbackEnabled=true;
async function checkDirectory() {
  let timer;
  try {
    const response=await Promise.race([
      Promise.resolve().then(()=>chrome.runtime.sendMessage({target:'background',action:'directory-status'})),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('后台响应超时')),2500);})
    ]);
    if(!response?.ok||typeof response.result?.ready!=='boolean')throw Error(response?.error||'后台未返回文件夹状态，请重新加载扩展并刷新网页');
    return response.result;
  }finally{clearTimeout(timer);}
}
window.addEventListener('focus',()=>{
  if(directoryWarning)chrome.runtime.sendMessage({target:'background',action:'directory-status'}).then(r=>{
    if(r?.ok&&r.result.ready)hideFeedback();
  }).catch(()=>{});
});
chrome.storage.local.get({enabled:true}).then(s=>feedbackEnabled=s.enabled);
chrome.storage.onChanged.addListener(c=>{if(c.enabled)feedbackEnabled=c.enabled.newValue;if(c.directoryName||c.enabled?.newValue===false)hideFeedback();});
document.addEventListener('click',event=>{
  if(!feedbackEnabled||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  const link=event.composedPath().find(e=>e instanceof HTMLAnchorElement);
  if(link&&/^https?:$/.test(link.protocol)&&(link.hasAttribute('download')||/\.(zip|7z|rar|exe|msi|iso|gguf|safetensors|pdf|mp4|mp3|jar|tar|gz)$/i.test(link.pathname))) {
    showFeedback('已点击下载，正在等待网站响应…');
    checkDirectory().then(directory=>{
      if(!directory.ready)showFeedback(directory.note,true);
    }).catch(error=>{
      const stale=/invalidated|重新加载/.test(error.message);
      showFeedback(stale?'扩展连接已失效，请重新加载扩展并刷新网页。':'无法检查下载文件夹：'+error.message+'。请打开设置检查。',stale?'refresh':true);
    });
  }
},true);
