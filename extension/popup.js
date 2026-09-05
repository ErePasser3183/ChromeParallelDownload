const $ = id => document.getElementById(id);
const labels = {preparing:'正在接管', active:'多线程下载中', waiting:'排队中', paused:'多线程已暂停', complete:'已完成', fallback:'Chrome 下载（未加速）', cancelled:'已取消', superseded:'已重新接管'};
const bytes = n => { n = Math.max(0, Number(n) || 0); const units = ['B','KB','MB','GB']; let i=0; while(n>=1024&&i<3){n/=1024;i++;}return n.toFixed(i?1:0)+' '+units[i]; };
let busy = false;
let directoryDirty = false, directoryBusy = false, themeBusy = false;
let revision = 0;
function applyTheme(theme) { document.documentElement.dataset.theme = theme; }
chrome.storage.local.get({theme:'system'}).then(data => { if (!themeBusy) applyTheme(data.theme); });
async function call(action, args = {}) {
  const response = await chrome.runtime.sendMessage({action, ...args});
  if (!response?.ok) throw new Error(response?.error || '扩展后台未连接');
  return response.result;
}
function el(tag, className, text) { const e=document.createElement(tag);e.className=className;e.textContent=text;return e; }
async function update() {
  if(busy) return;
  busy=true;
  const requestRevision=revision;
  try {
    const data=await call('view');
    if (requestRevision !== revision) return;
    $('enabled').checked=data.settings.enabled;
    $('connections').value=String(data.settings.connections);
    $('engine').textContent=data.engine.error?'引擎未连接':'aria2 '+data.engine.version+' · 已连接';
    if (!themeBusy) { $('theme').value=data.settings.theme; applyTheme(data.settings.theme); }
    if (!directoryDirty && !directoryBusy) $('directory').value=data.engine.directory||'';
    const choosing = directoryBusy || data.engine.choosing;
    $('choose-directory').disabled=Boolean(choosing);
    $('save-directory').disabled=Boolean(choosing);
    $('directory').disabled=Boolean(choosing);
    $('directory-status').textContent=choosing?'请在文件夹窗口中选择，完成后自动保存':data.engine.directoryError||'仅影响新下载任务';
    if (data.engine.error) $('error').textContent=data.engine.error;
    const fragment=document.createDocumentFragment();
    const visibleTasks=data.tasks.filter(t => ['preparing','active','waiting','paused'].includes(t.status));
    if(!visibleTasks.length) fragment.append(el('div','empty','当前没有下载任务。完成或取消的任务不会保留记录。'));
    for(const t of visibleTasks) {
      const card=el('article','task','');card.append(el('div','name',t.name));
      const connecting=t.status==='active'&&!Number(t.completedLength)&&!Number(t.downloadSpeed);
      const meta=el('div','meta','');meta.append(el('span','',connecting?'正在连接服务器…':labels[t.status]||t.status),el('span','', t.status==='active'&&!connecting?bytes(t.downloadSpeed)+'/s · '+(t.connections||0)+' 路':''));card.append(meta);
      const progress=document.createElement('progress');progress.max=Math.max(1,Number(t.totalLength)||1);progress.value=t.status==='complete'?progress.max:Number(t.completedLength)||0;card.append(progress);
      if(t.note||t.path) card.append(el('p','note',t.path||t.note));
      else card.append(el('p','note',bytes(t.completedLength)+' / '+bytes(t.totalLength)));
      if (t.directory && t.directory !== data.engine.directory) card.append(el('p','note','保存到 '+t.directory));
      const actions=el('div','actions','');
      const add=(label,action)=>{const b=el('button','',label);b.onclick=async()=>{b.disabled=true;try{await call(action,{gid:t.gid});$('error').textContent='';await update();}catch(e){$('error').textContent=e.message;}finally{b.disabled=false;}};actions.append(b);};
      if(t.status==='complete') add('打开位置','show');
      if(t.status==='fallback') {
        card.append(el('p','note','重新接管会从头建立多线程任务；Chrome 已下载的部分保留作回退。'));
        add('重新接管','retry');
      }
      if(['active','waiting','paused','preparing'].includes(t.status)) {if(t.status==='paused')add('继续','start');else add('暂停','pause');add('切回 Chrome','fallback');add('取消','cancel');}
      card.append(actions);fragment.append(card);
    }
    $('tasks').replaceChildren(fragment);
  } catch(e) { $('error').textContent=e.message; }
  finally {busy=false;}
}
async function settings(){revision++;try{await call('settings',{enabled:$('enabled').checked,connections:Number($('connections').value)});}catch(e){$('error').textContent=e.message;}finally{revision++;}}
$('enabled').onchange=settings;$('connections').onchange=settings;
$('theme').onchange=async()=>{
  themeBusy=true;
  revision++;
  const theme=$('theme').value; applyTheme(theme);
  try { await call('theme',{theme}); $('error').textContent=''; }
  catch(e) { $('error').textContent=e.message; }
  finally { themeBusy=false; revision++; await update(); }
};
$('directory').oninput=()=>{ directoryDirty=true; };
async function changeDirectory(action) {
  if (directoryBusy) return;
  directoryBusy=true;
  revision++;
  $('choose-directory').disabled=true; $('save-directory').disabled=true; $('directory').disabled=true;
  try {
    const result=await call(action,{directory:$('directory').value});
    if (result.directory) $('directory').value=result.directory;
    directoryDirty=false; $('error').textContent='';
  } catch(e) { $('error').textContent=e.message; }
  finally { directoryBusy=false; revision++; await update(); }
}
$('directory-form').onsubmit=event=>{ event.preventDefault(); void changeDirectory('set_directory'); };
$('choose-directory').onclick=()=>{ void changeDirectory('choose_directory'); };
void update();setInterval(update,1500);
