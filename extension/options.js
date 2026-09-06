const status=document.getElementById('status'),button=document.getElementById('choose'),input=document.getElementById('directory'),save=document.getElementById('save');
let busy=false,dirty=false;
async function call(action,args={}){const r=await chrome.runtime.sendMessage({target:'background',action,...args});if(!r?.ok)throw Error(r?.error||'后台未响应');return r.result;}
async function show(){
  try{const {engine,settings}=await call('view');document.documentElement.dataset.theme=settings.theme;
    if(!dirty&&!busy)input.value=engine.directory||'';
    button.disabled=save.disabled=busy||!!engine.choosing;
    status.textContent=engine.error||(engine.connecting?'正在连接引擎…':engine.choosing?'请在弹出的文件夹窗口中选择…':engine.directoryError||'当前：'+engine.directory);
  }catch(e){status.textContent=e.message;}
}
async function change(action){busy=true;button.disabled=save.disabled=true;status.textContent='正在处理…';
  try{await call(action,{directory:input.value});dirty=false;}catch(e){status.textContent=e.message;return;}finally{busy=false;button.disabled=save.disabled=false;}
  await show();
}
input.oninput=()=>dirty=true;button.onclick=()=>change('choose_directory');save.onclick=()=>change('set_directory');
void show();setInterval(()=>{if(!busy)void show();},1500);
