import assert from 'node:assert/strict';
import http from 'node:http';
import {Transfer,safeName} from '../extension/core.mjs';
let data=Buffer.alloc(6*1024*1024+113);for(let i=0;i<data.length;i++)data[i]=(i*31+7)%251;
const requests=[];let failureInjected=false,parallel=0,maxParallel=0;
const server=http.createServer((req,res)=>{
  requests.push({method:req.method,url:req.url,range:req.headers.range});
  if(req.url==='/slow-headers'){setTimeout(()=>{if(!res.destroyed)res.writeHead(200,{'Content-Length':data.length}).end(data);},200);return;}
  const range=/bytes=(\d+)-(\d+)/.exec(req.headers.range||'');
  let start=0,end=data.length-1;
  const headers={'Content-Type':'application/octet-stream','ETag':'"v1"'};
  if(range&&req.url!=='/no-range'){
    start=+range[1];end=Math.min(+range[2],end);headers['Content-Range']=`bytes ${start}-${end}/${data.length}`;
    if(req.url==='/changed'&&start>0)headers.ETag='"v2"';
  }
  headers['Content-Length']=end-start+1;
  res.writeHead(range&&req.url!=='/no-range'?206:200,headers);
  parallel++;maxParallel=Math.max(maxParallel,parallel);res.on('close',()=>parallel--);
  if(req.url==='/retry'&&start>1024*1024&&!failureInjected){failureInjected=true;res.write(data.subarray(start,start+100));setTimeout(()=>res.destroy(),10);return;}
  let position=start;
  const tick=()=>{if(res.destroyed)return;const next=Math.min(end+1,position+65536);res.write(data.subarray(position,next));position=next;if(position>end)res.end();else setTimeout(tick,req.url==='/pause'?3:0);};tick();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
function disk(existing={}){
  const files=new Map(Object.entries(existing));let output,aborted=false;
  return {files,get aborted(){return aborted;},
    async getFileHandle(name,options={}){
      if(!files.has(name)){if(!options.create){const e=Error();e.name='NotFoundError';throw e;}files.set(name,Buffer.alloc(0));}
      return {getFile:async()=>({size:files.get(name).length}),createWritable:async()=>{
        output=Buffer.alloc(data.length+1000);let length=0;
        return {write:async({position,data:value})=>{output.set(value,position);length=Math.max(length,position+value.length);},truncate:async n=>{length=n;},close:async()=>files.set(name,Buffer.from(output.subarray(0,length))),abort:async()=>{aborted=true;}};
      }};
    },async removeEntry(name){files.delete(name);}
  };
}
const start=(route,dir=disk(),connections=4)=>{const states=[];const job=new Transfer({gid:'test',url:base+route,name:'test.bin',connections},{directory:dir,emit:s=>states.push(s)});return {job,dir,states};};
try {
  for(const route of ['/range','/no-range','/retry']){
    requests.length=0;maxParallel=0;const {job,dir}=start(route);await job.run();
    assert.equal(job.mode,'complete',route);assert.deepEqual(dir.files.get('test.bin'),data);
    assert(requests.every(r=>r.method==='GET'),'No HEAD preflight');assert(maxParallel<=4);
    if(route==='/no-range')assert.equal(requests.length,1,'Ignored range uses initial full response');
    console.log(route+': full bytes correct, bounded parallelism, no HEAD: PASS');
  }
  {const {job,dir,states}=start('/slow-headers');const p=job.run();assert.equal(states[0].status,'connecting');await job.pause();assert.equal(job.mode,'paused');await job.run();await p;assert.equal(job.mode,'complete');assert.deepEqual(dir.files.get('test.bin'),data);console.log('Pause before first response + resume cannot publish empty file: PASS');}
  {const {job,dir}=start('/pause');const p=job.run();await new Promise(r=>setTimeout(r,25));await job.pause();const before=job.completed;assert(before>0);await job.run();await p;assert.equal(job.mode,'complete');assert.deepEqual(dir.files.get('test.bin'),data);console.log('Mid-stream pause/resume preserves bytes and produces exact output: PASS');}
  {const {job,dir}=start('/pause');const p=job.run();await new Promise(r=>setTimeout(r,25));await job.cancel();await p;assert.equal(dir.files.size,0);assert(dir.aborted);console.log('Cancellation aborts temporary writes and removes owned empty placeholder: PASS');}
  {const {job,dir}=start('/changed');await job.run();assert.equal(job.mode,'error');assert.equal(dir.files.size,0);console.log('Changed ETag rejects mixed content and cleans target: PASS');}
  {const dir=disk({'test.bin':Buffer.from('user file')});const {job}=start('/range',dir);await job.run();assert.deepEqual(dir.files.get('test.bin'),Buffer.from('user file'));assert.deepEqual(dir.files.get('test (1).bin'),data);console.log('Existing user file preserved with collision suffix: PASS');}
  assert(!safeName('../../CON.txt').includes('/'));assert.equal(safeName('..'),'download_file');
  {
    data=Buffer.alloc(64*1024*1024+113);for(let i=0;i<data.length;i++)data[i]=(i*31+7)%251;
    maxParallel=0;const {job,dir}=start('/range',disk(),64);await job.run();
    assert.equal(job.mode,'complete');assert.deepEqual(dir.files.get('test.bin'),data);
    assert(maxParallel>32&&maxParallel<=64,`Expected 33–64 concurrent requests, got ${maxParallel}`);
    console.log(`64-way setting transfers exact bytes with ${maxParallel} concurrent requests: PASS`);
  }
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
