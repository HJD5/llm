import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {loadArb,makeRecords} from './src/arb.mjs';
import {withNeighborContext} from './src/neighbor-context.mjs';
import {makeLinguisticBatch} from './src/batch-linguistics.mjs';
import {QwenClient} from './src/qwen.mjs';
import {readGlossary} from './src/glossary.mjs';
const {values:v}=parseArgs({options:Object.fromEntries(['source','target','reference','glossary','out','limit'].map(k=>[k,{type:'string'}]))});
for(const k of ['source','target','reference','glossary','out'])if(!v[k])throw Error('Required --'+k);
const [s,t,e,terms]=await Promise.all([loadArb(v.source),loadArb(v.target),loadArb(v.reference),fs.readFile(v.glossary,'utf8').then(readGlossary)]);
const records=withNeighborContext(makeRecords(s,t,e));
const fingerprint=createHash('sha256').update(JSON.stringify({source:s.sha256,target:t.sha256,reference:e.sha256,terms,version:'positional-v1'})).digest('hex');
const out=path.resolve(v.out);if([v.source,v.target,v.reference,v.glossary].some(x=>path.resolve(x).toLowerCase()===out.toLowerCase()))throw Error('Input overwrite');
await fs.mkdir(path.dirname(out),{recursive:true});
let state={fingerprint,total:records.length,status:'running',rows:{},created_at:new Date().toISOString(),calls:0};
try{state=JSON.parse(await fs.readFile(out,'utf8'));if(state.fingerprint!==fingerprint)throw Error('Input changed: use a new checkpoint');}catch(err){if(err.code!=='ENOENT')throw err;}
const save=async()=>{state.attempted=Object.keys(state.rows).length;state.assessed=Object.values(state.rows).filter(r=>r.status==='assessed').length;state.updated_at=new Date().toISOString();await fs.writeFile(out+'.tmp',JSON.stringify(state,null,2));await fs.rename(out+'.tmp',out);};
const client=new QwenClient({endpoint:'http://127.0.0.1:8088/v1/chat/completions',modelRevision:'Qwen3-8B-Q4_K_M:d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',cacheDir:path.join(path.dirname(out),'positional-cache'),maxCalls:100000,maxRetries:1,timeoutMs:600000});
const known={donate_to_mail:'Pochta bo‘limiga',repeat:'Takrorlash'};
const priority=r=>Object.hasOwn(known,r.key)?1000:/predictionsBetsTitle|tp_create_title/.test(r.key)?500:0;
const pending=records.filter(r=>state.rows[r.key]?.status!=='assessed').sort((a,b)=>priority(b)-priority(a));
const limit=Number(v.limit??records.length);let processed=0,cap=16;const oldCalls=state.calls;
state.status='running';await save();
while(pending.length&&processed<limit){
 const batch=[];let size=0;
 while(pending.length&&batch.length<cap&&processed+batch.length<limit){const r=pending[0],cost=r.key.length+r.source.length*2+(r.context.english?.length??0)+100;if(batch.length&&size+cost>5000)break;size+=cost;batch.push(pending.shift());}
 const {body,validate}=makeLinguisticBatch(batch,terms);
 try{
  const inputTokens=await client.countChatTokens(body);if(inputTokens+body.max_tokens+32>4096)throw Error('CONTEXT_TOO_LONG');
  const result=await client.structured(body,validate);
  const missed=batch.filter(r=>known[r.key]===r.target&&!result.review.find(x=>x.key===r.key)?.issues.some(i=>i.type==='wrong_language'));
  if(missed.length){state.status='quality_gate_failed';state.quality_gate={missed:missed.map(r=>r.key),request_hash:result.request_hash};await save();console.log(JSON.stringify(state.quality_gate));process.exitCode=2;break;}
  for(const row of result.review)state.rows[row.key]={...row,request_hash:result.request_hash,cached:result.cached};
 }catch(err){
  if(err.message==='CONTEXT_TOO_LONG'&&batch.length>1){cap=Math.max(1,Math.floor(batch.length/2));pending.unshift(...batch);continue;}
  for(const row of batch)state.rows[row.key]={key:row.key,status:'failed',error:err.message,attempts:err.attempts};
 }
 processed+=batch.length;state.calls=oldCalls+client.calls;cap=16;await save();console.log(JSON.stringify({assessed:state.assessed,total:state.total,calls:state.calls,failed:state.attempted-state.assessed}));
}
if(state.status!=='quality_gate_failed')state.status=state.assessed===state.total?'completed':pending.length?'partial':'completed_with_failures';await save();
