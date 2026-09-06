import {read,write} from './db.mjs';
const status=document.getElementById('status'),button=document.getElementById('choose');
chrome.storage.local.get({theme:'system'}).then(s=>document.documentElement.dataset.theme=s.theme);
async function show(){const directory=await read('directory');status.textContent=directory?'当前：'+directory.name+' · '+(await directory.queryPermission({mode:'readwrite'})==='granted'?'已授权':'需要重新授权'):'尚未选择文件夹';}
button.onclick=async()=>{
  button.disabled=true;status.textContent='请选择保存位置…';
  try {
    const directory=await window.showDirectoryPicker({id:'parallel-downloads',mode:'readwrite',startIn:'downloads'});
    await write('directory',directory);await chrome.storage.local.set({directoryName:directory.name,notice:''});
    await show();
  }catch(e){status.textContent=e.name==='AbortError'?'已取消选择，可随时重试':e.message;}finally{button.disabled=false;}
};
void show();
