// 고정 이름 작업 실행기 시험판 0.1 (격리 시험용). 임의 명령 없음. 작업 이름은 표에 있는 것만.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
const ROOT=process.env.RUNNER_ROOT, APPROVED=process.env.RUNNER_APPROVED; // 승인 해시 목록은 연결 폴더 밖
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const inside=p=>{const r=path.resolve(ROOT,p);return r.startsWith(path.resolve(ROOT)+path.sep)?r:null};
const T={
 watcher_status(){const f=inside('state/watcher.beat');if(!f||!fs.existsSync(f))return{ok:false,alive:false,why:'beat 없음'};
  const age=(Date.now()-fs.statSync(f).mtimeMs)/1000;return{ok:true,alive:age<30,ageSec:Math.round(age)}},
 bridge_selftest(){const f=inside('bridge.cjs');if(!f||!fs.existsSync(f))return{ok:false,why:'bridge.cjs 없음'};
  const r=cp.spawnSync(process.execPath,['--check',f],{shell:false,encoding:'utf8'});return{ok:r.status===0,sha:sha(fs.readFileSync(f)),err:(r.stderr||'').slice(0,200)}},
 bridge_update({staged}){const s=inside(staged||'');if(!s||!s.includes(path.sep+'updates'+path.sep)||!fs.existsSync(s))return{ok:false,why:'staged 경로 불허'};
  const b=fs.readFileSync(s),h=sha(b);const ok=JSON.parse(fs.readFileSync(APPROVED,'utf8')).bridge||[];
  if(!ok.includes(h))return{ok:false,why:'해시 미승인',sha:h};
  const cur=inside('bridge.cjs');let prev=null;if(fs.existsSync(cur)){prev=inside('bridge.prev.'+Date.now()+'.cjs');fs.copyFileSync(cur,prev)}
  fs.writeFileSync(cur,b);const st=T.bridge_selftest();if(!st.ok){if(prev)fs.copyFileSync(prev,cur);return{ok:false,why:'갱신 후 점검 실패, 이전본 복구',rolledBack:!!prev,sha:h}}
  return{ok:true,sha:h,prev:prev&&path.basename(prev)}}
};
function call(name,args){if(!Object.prototype.hasOwnProperty.call(T,name))return{ok:false,why:'알 수 없는 작업 이름'};
 try{return T[name](args||{})}catch(e){return{ok:false,why:String(e.message).slice(0,200)}}}
module.exports={call,TASKS:Object.keys(T)};
if(require.main===module){ // 최소 MCP(stdio JSON-RPC)
 let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;
  const m=JSON.parse(l);const send=r=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...r})+'\n');
  if(m.method==='initialize')send({result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'nodelab-runner',version:'0.1'}}});
  else if(m.method==='tools/list')send({result:{tools:T&&Object.keys(T).map(n=>({name:n,description:'고정 작업 '+n,inputSchema:{type:'object',properties:{staged:{type:'string'}}}}))}});
  else if(m.method==='tools/call')send({result:{content:[{type:'text',text:JSON.stringify(call(m.params.name,m.params.arguments))}]}});
  else if(m.id!==undefined)send({error:{code:-32601,message:'no'}})}})}
