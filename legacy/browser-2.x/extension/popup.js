const $=id=>document.getElementById(id);
$('version').textContent='版本 '+chrome.runtime.getManifest().version;
const labels={preparing:'已接收，正在准备…',connecting:'已接收，正在连接服务器…',active:'正在下载',retrying:'正在恢复连接',paused:'已暂停',saving:'正在保存文件…'};
const bytes=n=>{n=Math.max(0,Number(n)||0);let i=0;while(n>=1024&&i<4){n/=1024;i++;}return n.toFixed(i?1:0)+' '+['B','KB','MB','GB','TB'][i];};
async function call(action,args={}){const r=await chrome.runtime.sendMessage({target:'background',action,...args});if(!r?.ok)throw Error(r?.error||'后台未响应');return r.result;}
function element(tag,cls,text){const e=document.createElement(tag);e.className=cls;e.textContent=text;return e;}
let version=0,updating=false;
async function update(){
  if(updating)return;updating=true;const v=version;
  try{
    const {tasks,settings,directory}=await call('view');if(v!==version)return;
    $('enabled').checked=settings.enabled;$('connections').value=String(settings.connections);$('theme').value=settings.theme;document.documentElement.dataset.theme=settings.theme;
    $('directory').textContent=directory.ready?'保存到：'+directory.name:'未设置或未授权下载文件夹';$('notice').textContent=directory.ready?settings.notice:directory.note;
    if(!tasks.length)$('tasks').replaceChildren(element('p','empty','当前没有下载任务'));
    else $('tasks').querySelector('.empty')?.remove();
    for(const card of $('tasks').querySelectorAll('.task'))if(!tasks.some(t=>t.gid===card.dataset.gid))card.remove();
    for(const task of tasks){
      let card=$('tasks').querySelector(`[data-gid="${task.gid}"]`);
      if(!card){card=element('article','task','');card.dataset.gid=task.gid;card.append(element('h2','',''),element('p','status',''),document.createElement('progress'),element('p','meta stats',''),element('p','meta note',''),element('div','actions',''));$('tasks').append(card);}
      card.querySelector('h2').textContent=task.name;card.querySelector('.status').textContent=labels[task.status]||task.status;
      const progress=card.querySelector('progress');progress.max=Math.max(1,task.totalLength);progress.value=task.completedLength;
      card.querySelector('.stats').textContent=bytes(task.completedLength)+' / '+(task.totalLength>0?bytes(task.totalLength):'大小待确认')+' · '+bytes(task.downloadSpeed)+'/s';
      card.querySelector('.note').textContent=task.note||'';
      const actions=card.querySelector('.actions');
      for(const button of actions.children)if(button.dataset.action===(task.status==='paused'?'pause':'start'))button.remove();
      for(const [action,label] of [[task.status==='paused'?'start':'pause',task.status==='paused'?'继续':'暂停'],...(task.chromeId?[['fallback','切回 Chrome']]:[]),['cancel','取消']]) {
        let button=actions.querySelector(`[data-action="${action}"]`);
        if(!button){button=element('button','',label);button.dataset.action=action;if(['pause','start'].includes(action))actions.prepend(button);else actions.append(button);}
        button.disabled=!!button.dataset.busy||['preparing','saving'].includes(task.status);
        button.onclick=async()=>{button.dataset.busy='true';button.disabled=true;button.textContent='已接收…';try{await call(action,{gid:task.gid});}catch(e){$('notice').textContent=e.message;}finally{delete button.dataset.busy;button.textContent=label;button.disabled=false;void update();}};
      }
    }
  }catch(e){$('notice').textContent=e.message;}finally{updating=false;}
}
for(const id of ['enabled','connections','theme'])$(id).onchange=async()=>{
  version++;document.documentElement.dataset.theme=$('theme').value;
  try{await call('settings',{enabled:$('enabled').checked,connections:Number($('connections').value),theme:$('theme').value});}catch(e){$('notice').textContent=e.message;}finally{version++;void update();}
};
$('options').onclick=()=>chrome.runtime.openOptionsPage();
chrome.storage.onChanged.addListener(()=>void update());void update();setInterval(update,500);
