const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../extension/feedback.js'),'utf8');
async function scenario(sendMessage) {
  const nodes=new Map(),listeners={};
  const element=()=>({style:{},append(){},setAttribute(k,v){this[k]=v;},attachShadow(){return element();},remove(){if(nodes.get(this.id)===this)nodes.delete(this.id);}});
  class Link{};const link=Object.assign(new Link(),{protocol:'https:',pathname:'/file.zip',hasAttribute:()=>true});
  const context={HTMLAnchorElement:Link,document:{getElementById:id=>nodes.get(id),createElement:element,body:{append:e=>nodes.set(e.id,e)},addEventListener:(name,fn)=>listeners[name]=fn},window:{addEventListener(){}},chrome:{runtime:{onMessage:{addListener(){}},sendMessage},storage:{local:{get:async()=>({enabled:true})},onChanged:{addListener(){}}}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){}};
  vm.runInNewContext(source,context);
  try {listeners.click({button:0,composedPath:()=>[link]});}catch(e){assert.fail('Click handler threw instead of showing failure: '+e.message);}
  await new Promise(setImmediate);
  const host=nodes.get('cpd-download-feedback');
  assert(host?.['aria-label']?.includes('检查')||host?.['aria-label']?.includes('刷新'),'A failed folder check must not leave only the waiting-for-network hint');
  assert.equal(host.style.pointerEvents,'auto','Recovery hint must have an actionable settings/refresh path');
}
(async()=>{
  await scenario(async()=>({ok:false,error:'文件夹权限检查失败'}));
  await scenario(async()=>undefined);
  await scenario(()=>{throw Error('Extension context invalidated.');});
  console.log('Failed / missing backend response and stale content script show actionable feedback: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
