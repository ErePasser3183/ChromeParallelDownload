const MiB=1024*1024;
export function safeName(value) {
  let name=String(value||'download.bin').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,180);
  if(!name||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))name='download_'+(name||'file');
  return name;
}
export function parseRange(value) {
  const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(value||'');
  if(!match)return null;
  const [start,end,total]=match.slice(1).map(Number);
  return [start,end,total].every(Number.isSafeInteger)&&start<=end&&end<total?{start,end,total}:null;
}
function validator(response) {
  const etag=response.headers.get('etag');
  if(etag&&!etag.startsWith('W/'))return {key:'etag',value:etag};
  // Conservative: Last-Modified alone isn't necessarily a strong validator.
  return null;
}
export class Transfer {
  constructor(input,{directory,fetcher=(...args)=>fetch(...args),emit=()=>{},journal=async()=>{}}) {
    if(!/^https?:$/.test(new URL(input.url).protocol))throw Error('仅支持 HTTP/HTTPS 下载');
    this.input=input;this.directory=directory;this.fetcher=fetcher;this.emit=emit;this.journal=journal;
    this.controllers=new Set();this.parts=[];this.mode='new';this.completed=0;this.total=0;this.chain=Promise.resolve();
    this.connections=Math.max(1,Math.min(64,Number(input.connections)||8));this.name=safeName(input.name);
  }
  report(status,note='') {
    const now=Date.now();
    if(status==='active'&&now-(this.lastReport||0)<150)return;
    const elapsed=Math.max(1,now-(this.lastReport||now));
    const speed=status==='active'?Math.max(0,(this.completed-(this.lastBytes||0))*1000/elapsed):0;
    this.lastReport=now;this.lastBytes=this.completed;
    this.emit({gid:this.input.gid,name:this.name,status,note,totalLength:this.total,completedLength:this.completed,downloadSpeed:speed,connections:this.controllers.size});
  }
  async openFile() {
    const base=this.name, dot=base.lastIndexOf('.');
    for(let n=0;n<10000;n++) {
      const name=n?(dot>0?`${base.slice(0,dot)} (${n})${base.slice(dot)}`:`${base} (${n})`):base;
      try {await this.directory.getFileHandle(name);continue;}catch(error){if(error.name!=='NotFoundError')throw error;}
      this.name=name;
      await this.journal({name,committed:false});
      this.file=await this.directory.getFileHandle(name,{create:true});
      this.writer=await this.file.createWritable();return;
    }
    throw Error('同名文件过多');
  }
  stopRequests() {for(const c of this.controllers)c.abort();}
  async request(start,end) {
    const controller=new AbortController();this.controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),15000);
    const headers={};
    if(start!==undefined){headers.Range=`bytes=${start}-${end}`;if(this.validator)headers['If-Range']=this.validator.value;}
    try {
      const response=await this.fetcher(this.url||this.input.url,{headers,signal:controller.signal,credentials:'omit',cache:'no-store'});
      return {response,controller};
    }catch(error){this.controllers.delete(controller);throw error;}finally{clearTimeout(timer);}
  }
  async consume({response,controller},part) {
    const reader=response.body.getReader();
    try {
      while(true) {
        const timer=setTimeout(()=>controller.abort(),20000);
        let chunk;try{chunk=await reader.read();}finally{clearTimeout(timer);}
        if(chunk.done)break;
        if(this.mode!=='running')throw Error('已停止');
        if(part.end!==null&&part.position+chunk.value.byteLength>part.end+1)throw Error('服务器返回超出范围的数据');
        const position=part.position;
        // Backpressure: at most one pending buffer per connection; no whole-file RAM merge.
        this.chain=this.chain.then(()=>this.writer.write({type:'write',position,data:chunk.value}));
        await this.chain;
        part.position+=chunk.value.byteLength;this.completed+=chunk.value.byteLength;this.report('active');
      }
      if(part.end!==null&&part.position!==part.end+1)throw Error('连接提前结束');
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();this.controllers.delete(controller);}
  }
  async piece(part) {
    for(let attempt=0;part.position<=part.end;attempt++) {
      if(this.mode!=='running')return;
      let request;
      try {
        request=await this.request(part.position,part.end);
        const r=request.response, range=parseRange(r.headers.get('content-range'));
        if(r.status!==206||!range||range.start!==part.position||range.end!==part.end||range.total!==this.total||r.headers.get(this.validator.key)!==this.validator.value||r.headers.get('content-encoding')) {
          const e=Error('服务器不再支持一致的分段下载');e.fatal=true;throw e;
        }
        await this.consume(request,part);
      }catch(error) {
        request?.controller.abort();if(request)this.controllers.delete(request.controller);
        if(this.mode!=='running')return;
        if(error.fatal||attempt>=2)throw error;
        this.report('retrying',`连接中断，继续已下载部分（${attempt+1}/2）`);
      }
    }
  }
  async run() {
    if(this.mode==='running'||this.mode==='complete')return;
    this.mode='running';this.report('connecting','下载已接收，正在连接服务器…');
    this.running=this.execute();return this.running;
  }
  async execute() {
    try {
      if(!this.writer) {
        // Start the data request immediately; disk setup runs while headers arrive.
        const first=this.request(0,MiB-1);
        first.catch(()=>{});
        await this.openFile();
        let initial=await first;
        if(this.mode!=='running'){initial.controller.abort();this.controllers.delete(initial.controller);return;}
        let r=initial.response, range=parseRange(r.headers.get('content-range'));
        this.validator=validator(r);
        if(r.status===206&&range&&range.start===0&&range.end===Math.min(MiB-1,range.total-1)&&this.validator&&!r.headers.get('content-encoding')) {
          this.total=range.total;this.url=r.url||this.input.url;
          if(this.input.expected>0&&this.total!==this.input.expected)throw Error('文件大小已改变');
          this.parts=[{position:0,end:range.end}];
          const size=Math.max(MiB,Math.min(8*MiB,Math.ceil(this.total/(this.connections*4))));
          for(let at=range.end+1;at<this.total;at+=size)this.parts.push({position:at,end:Math.min(this.total-1,at+size-1)});
          this.single=false;
          // First payload and other slices transfer concurrently, without a HEAD request.
          const payload=this.consume(initial,this.parts[0]);
          const others=this.connections>1?this.pool(this.parts.slice(1),this.connections-1):payload.then(()=>this.pool(this.parts.slice(1)));
          const settled=await Promise.allSettled([payload.catch(async e=>{if(this.mode==='running')await this.piece(this.parts[0]);else throw e;}),others]);
          const failure=settled.find(x=>x.status==='rejected');if(failure)throw failure.reason;
        }else {
          this.single=true;
          if(r.status===206){initial.controller.abort();this.controllers.delete(initial.controller);initial=await this.request();r=initial.response;}
          if(r.status!==200)throw Error(`服务器返回 HTTP ${r.status}`);
          this.total=Number(r.headers.get('content-length'))||0;
          if(this.input.expected>0&&this.total>0&&this.total!==this.input.expected)throw Error('文件大小已改变');
          const part={position:0,end:this.total&&!r.headers.get('content-encoding')?this.total-1:null};this.parts=[part];
          this.report('active','此服务器使用单连接下载');await this.consume(initial,part);
          this.total=this.completed;
        }
      }else if(this.single) {
        // Without a strong validator, restarting is safer than mixing representations.
        await this.writer.truncate(0);this.completed=0;
        const request=await this.request();if(request.response.status!==200)throw Error('服务器拒绝继续下载');
        const part={position:0,end:null};this.parts=[part];await this.consume(request,part);this.total=this.completed;
      }else await this.pool(this.parts.filter(p=>p.position<=p.end));
      if(this.mode!=='running')return;
      if(this.completed!==this.total)throw Error('下载文件长度不一致');
      this.mode='saving';this.report('saving','正在保存文件…');await this.writer.close();this.writer=null;
      await this.journal({name:this.name,committed:true,total:this.total});
      this.mode='complete';this.report('complete','已保存到选择的文件夹');
    }catch(error) {
      this.stopRequests();
      if(this.mode==='paused'||this.mode==='cancelled')return;
      this.mode='error';await this.cleanup();this.report('error',error.message||'下载失败');
    }
  }
  async pool(parts,limit=this.connections) {
    const queue=[...parts];
    const workers=Array.from({length:Math.min(limit,queue.length)},async()=>{
      while(queue.length&&this.mode==='running')await this.piece(queue.shift());
    });
    const results=await Promise.allSettled(workers.map(p=>p.catch(e=>{this.stopRequests();throw e;})));
    const failure=results.find(x=>x.status==='rejected');if(failure)throw failure.reason;
  }
  async pause() {
    if(this.mode!=='running')return;
    this.mode='paused';this.stopRequests();await this.running;
    if(!this.parts.length){await this.cleanup();this.file=null;this.chain=Promise.resolve();}
    this.report('paused',this.single?'继续时从头下载（服务器不支持可靠续传）':'继续时保留已完成分片');
  }
  async cleanup() {
    await this.chain.catch(()=>{});
    if(this.writer){await this.writer.abort().catch(()=>{});this.writer=null;}
    if(this.file){const file=await this.file.getFile().catch(()=>null);if(file?.size===0)await this.directory.removeEntry(this.name).catch(()=>{});}
    await this.journal(null);
  }
  async cancel() {
    if(this.mode==='saving'){await this.running;return;}
    if(this.mode==='complete')return;
    this.mode='cancelled';this.stopRequests();await this.running;await this.cleanup();this.report('cancelled');
  }
}
