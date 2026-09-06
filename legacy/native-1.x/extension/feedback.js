// Isolated-world listener: page code cannot submit download commands.
function showFeedback(text) {
  document.getElementById('cpd-download-feedback')?.remove();
  const host=document.createElement('div');host.id='cpd-download-feedback';
  host.style.cssText='position:fixed;right:24px;bottom:24px;z-index:2147483647;pointer-events:none';
  const root=host.attachShadow({mode:'closed'}), box=document.createElement('div');
  box.setAttribute('role','status');box.textContent='↓ '+text;
  box.style.cssText='padding:14px 20px;border-radius:14px;background:#155bd7;color:white;font:14px/1.5 system-ui;box-shadow:0 5px 24px #0003;max-width:360px';
  root.append(box);(document.body||document.documentElement).append(host);
  setTimeout(()=>host.remove(),3500);
}
chrome.runtime.onMessage.addListener(message => {
  if(message.type==='download-feedback')showFeedback(message.text);
});
let feedbackEnabled=true;
chrome.storage.local.get({enabled:true}).then(s=>feedbackEnabled=s.enabled);
chrome.storage.onChanged.addListener(c=>{if(c.enabled)feedbackEnabled=c.enabled.newValue;});
document.addEventListener('click',event=>{
  if(!feedbackEnabled||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  const link=event.composedPath().find(e=>e instanceof HTMLAnchorElement);
  if(link&&/^https?:$/.test(link.protocol)&&(link.hasAttribute('download')||/\.(zip|7z|rar|exe|msi|iso|gguf|safetensors|pdf|mp4|mp3|jar|tar|gz)$/i.test(link.pathname))) {
    showFeedback('已点击下载，正在等待网站响应…');
  }
},true);
