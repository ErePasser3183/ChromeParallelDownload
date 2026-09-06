import {read,write} from './db.mjs';
import {Transfer} from './core.mjs';
const jobs=new Map();let names=Promise.resolve();
onmessage=async({data:m})=>{
  try {
    if(m.action==='list'){postMessage({id:m.id,result:[...jobs.keys()]});return;}
    if(m.action==='add') {
      if(jobs.has(m.task.gid)){postMessage({id:m.id,result:{}});return;}
      const directory=await read('directory');
      if(!directory||await directory.queryPermission({mode:'readwrite'})!=='granted')throw Error('请先在扩展设置中选择并授权下载文件夹');
      const task=new Transfer(m.task,{directory,emit:state=>postMessage({state}),journal:info=>write('job:'+m.task.gid,info?{...info,directory}:undefined)});
      const open=task.openFile.bind(task);task.openFile=()=>{const next=names.then(open);names=next.catch(()=>{});return next;};
      jobs.set(m.task.gid,task);postMessage({id:m.id,result:{}});void task.run();return;
    }
    const job=jobs.get(m.gid);
    if(!job)throw Error('下载已中断，请从原网页重试');
    if(m.action==='pause')await job.pause();
    else if(m.action==='start')void job.run();
    else if(m.action==='cancel'){await job.cancel();jobs.delete(m.gid);}
    else if(m.action==='forget'){jobs.delete(m.gid);await write('job:'+m.gid,undefined);}
    else throw Error('未知操作');
    postMessage({id:m.id,result:{}});
  }catch(e){postMessage({id:m.id,error:e.message});}
};
