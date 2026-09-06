const worker=new Worker('worker.mjs',{type:'module'}), pending=new Map();let sequence=0;
worker.onmessage=({data})=>{
  if(data.state){void chrome.runtime.sendMessage({target:'background',action:'state',state:data.state});return;}
  const resolve=pending.get(data.id);if(resolve){pending.delete(data.id);resolve(data.error?{ok:false,error:data.error}:{ok:true,result:data.result});}
};
worker.onerror=()=>{
  for(const respond of pending.values())respond({ok:false,error:'下载引擎已停止'});pending.clear();
  void chrome.runtime.sendMessage({target:'background',action:'engine-failed'});
};
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||message.target!=='engine')return;
  const id=++sequence;pending.set(id,respond);worker.postMessage({...message,id});return true;
});
