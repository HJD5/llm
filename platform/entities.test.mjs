import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checkRecords} from '../locqa/src/engine.mjs';
import {entityHint,entityFingerprint} from '../locqa/src/entities.mjs';
import {classifyEntity} from './entity-review.mjs';
import {createPlatform} from './server.mjs';
test('entity hints never approve; exact exceptions suppress only same_as_source',async()=>{
 const row={key:'city_name',source:'Астана',target:'Астана',context:{section:'Cities'},metadata:{}};
 assert.equal(entityHint(row).type,'city');
 const before=await checkRecords([row]);assert.ok(before.issues.some(x=>x.issue_type==='same_as_source'));
 const exception={status:'approved',check:'same_as_source',fingerprint:entityFingerprint(row)};
 const after=await checkRecords([row],{config:{entity_exceptions:[exception]}});assert.equal(after.issues.length,0);assert.equal(after.suppressed_findings.length,1);assert.equal(after.modules.placeholder_mismatch.assessed,1);assert.equal(after.modules.plural_mismatch.assessed,1);
 for(const change of [{key:'other'},{source:'Алматы',target:'Алматы'},{context:{section:'Other'}},{target:'Москва'}]){
  const result=await checkRecords([{...row,...change}],{config:{entity_exceptions:[exception]}});assert.equal(result.suppressed_findings.length,0);
 }
 assert.equal((await checkRecords([row],{config:{entity_exceptions:[{...exception,status:'revoked'}]}})).suppressed_findings.length,0);
 assert.equal(entityHint({key:'button',source:'Сохранить изменения'}),null);
});
test('Qwen classifier requires complete target evidence and cannot approve',async()=>{
 const row={key:'city',source:'Астана',target:'Астана',context:{}};
 const request=value=>async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]})});
 const signal=new AbortController().signal;
 const result=await classifyEntity({row,signal,request:request({type:'city',quote:'Астана',reason:'Possible city'})});assert.equal(result.status,'suggested');
 await assert.rejects(()=>classifyEntity({row,signal,request:request({type:'city',quote:'invented',reason:'x'})}));
 await assert.rejects(()=>classifyEntity({row,signal,request:request({type:'city',quote:'Астана',reason:'x',approved:true})}));
});
test('human exception persists, affects future runs only, and can be revoked',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'locqa-entities-'));
 let app=await createPlatform({dataDir,seed:false,entityClassifier:async()=>({type:'city',quote:'Астана',reason:'Possible city',status:'suggested'})});
 let base,csrf;
 const connect=async()=>{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;csrf=(await get('/api/bootstrap')).csrf;};
 const get=async p=>(await fetch(base+p)).json();
 const post=(p,b)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Locqa-Token':csrf},body:JSON.stringify(b)});
 await connect();let dataset,id,exceptionId;
 const run=async()=>{const j=await (await post('/api/runs',{datasetId:dataset,checks:['same_as_source','placeholder_mismatch','plural_mismatch'],useModel:false,budget:0})).json();for(let n=0;n<100;n++){if((await get(`/api/runs/${j.id}`)).status!=='running')return {id:j.id,report:await get(`/api/runs/${j.id}/report`)};await new Promise(r=>setTimeout(r,20));}throw Error('Worker timeout');};
 try{
  dataset=(await (await post('/api/datasets',{source:'{"city_name":"Астана"}',target:'{"city_name":"Астана"}'})).json()).id;
  const first=await run();id=first.id;const issueId=first.report.issues[0].id;
  await post(`/api/runs/${id}/entity-classify`,{issueId});assert.equal((await get(`/api/runs/${id}/report`)).issues.length,1);
  const body={issueId,type:'city',reviewer:'Test reviewer',note:'Confirmed writing'};
  assert.equal((await post(`/api/runs/${id}/entity-exception`,body)).status,400);
  const response=await post(`/api/runs/${id}/entity-exception`,{...body,confirm:true});assert.equal(response.status,201);exceptionId=(await response.json()).id;
  const next=await run();assert.equal(next.report.issues.length,0);assert.equal(next.report.suppressed_findings.length,1);
 }finally{await app.close();}
 app=await createPlatform({dataDir,seed:false});await connect();
 try{
  const next=await run();assert.equal(next.report.suppressed_findings.length,1);
  assert.equal((await post('/api/entity-exceptions/revoke',{id:exceptionId})).status,200);
  const restored=await run();assert.equal(restored.report.issues.length,1);assert.equal(restored.report.suppressed_findings.length,0);
 }finally{await app.close();}
});
