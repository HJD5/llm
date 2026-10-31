import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPlatform} from './server.mjs';
import {parseArb,makeRecords} from '../locqa/src/arb.mjs';
import {exportApproved,validateCorrection} from './recommendations.mjs';

test('export excludes unapproved proposals, preserves unrelated duplicates and metadata, rejects stale or invalid changes',()=>{
 const source='{"a":"Hello {name}"}',target='{"@@comment":"A","@@comment":"B","a":"Wrong {name}","@a":{"description":"Keep","placeholders":{"name":{}}}}';
 const s=parseArb(source),t=parseArb(target),d={source,target,sourceHash:s.sha256,targetHash:t.sha256,rows:makeRecords(s,t)};
 const p={key:'a',translation:'Сәлем {name}',status:'pending',sourceHash:d.sourceHash,targetHash:d.targetHash};
 assert.throws(()=>exportApproved(d,{p}),/Нет подтверждённых/);
 p.status='approved';const result=exportApproved(d,{p});assert.equal(JSON.parse(result).a,p.translation);assert.equal((result.match(/@@comment/g)??[]).length,2);assert.equal(JSON.parse(result)['@a'].description,'Keep');assert.equal(JSON.parse(result)['@a'].reviewed_by_human,true);assert.ok(JSON.parse(result)['@a'].placeholders.name);
 assert.equal(d.target,target);
 assert.throws(()=>exportApproved(d,{p:{...p,targetHash:'stale'}}));
 assert.throws(()=>exportApproved(d,{p:{...p,translation:'Сәлем {player}'}}));
 assert.throws(()=>validateCorrection(d.rows[0],d.rows[0].target));
 const dup={...d,target:'{"a":"first","a":"Wrong {name}"}'};assert.throws(()=>exportApproved(dup,{p}),/дубликаты/);
 assert.throws(()=>exportApproved(d,{p,q:p}),/Несколько/);
 assert.throws(()=>validateCorrection({source:'{n, plural, =0 {None} other {# items}}',target:''},'{n, plural, other {# зат}}'));
 assert.throws(()=>validateCorrection({source:'<b>Hello {name}</b>',target:''},'Сәлем {name}'));
 assert.equal(validateCorrection({source:'{n, plural, one {# item} other {# items}}',target:''},'{n, plural, other {# зат}}'),'{n, plural, other {# зат}}');
});

test('recommendation requires separate explicit human approval; rejection, export and persistence',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'locqa-corrections-'));
 const app=await createPlatform({dataDir,seed:false,recommendationFn:async()=>({translation:'Сәлем {name}',reason:'Сохранить имя игрока'})});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${app.server.address().port}`,get=async p=>(await fetch(base+p)).json();
 const boot=await get('/api/bootstrap');const post=(p,b)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Locqa-Token':boot.csrf},body:JSON.stringify(b)});
 let job,issueId,proposalId;
 try{
  const d=await (await post('/api/datasets',{source:'{"a":"Hello {name}"}',target:'{"a":"Сәлем {player}"}'})).json();
  job=await (await post('/api/runs',{datasetId:d.id,checks:['placeholder_mismatch'],budget:0,useModel:false})).json();
  for(let n=0;n<100;n++){if((await get(`/api/runs/${job.id}`)).status!=='running')break;await new Promise(r=>setTimeout(r,20));}
  issueId=(await get(`/api/runs/${job.id}/report`)).issues[0].id;
  await post(`/api/runs/${job.id}/review`,{issueId,status:'accepted'});
  assert.equal((await fetch(base+`/api/runs/${job.id}/fixed`)).status,400);
  const r=await post(`/api/runs/${job.id}/recommend`,{issueId});assert.equal(r.status,200);const p=await r.json();proposalId=p.id;assert.equal(p.status,'pending');
  assert.equal((await fetch(base+`/api/runs/${job.id}/fixed`)).status,400);
  assert.equal((await post(`/api/runs/${job.id}/correction-review`,{issueId,proposalId,status:'approved'})).status,400);
  assert.equal((await post(`/api/runs/${job.id}/correction-review`,{issueId,proposalId:'old',status:'approved',confirm:true})).status,400);
  const identity={reviewer:'Reviewer Test',note:'Checked',translation:'Сәлем {name}'};
  assert.equal((await post(`/api/runs/${job.id}/correction-review`,{issueId,proposalId,status:'approved',confirm:true,...identity})).status,200);
  const fixed=await get(`/api/runs/${job.id}/fixed`);assert.equal(fixed.a,'Сәлем {name}');
  assert.equal((await post(`/api/runs/${job.id}/correction-edit`,{issueId,proposalId,...identity,translation:'Сәлем {wrong}'})).status,400);
  const edited=await post(`/api/runs/${job.id}/correction-edit`,{issueId,proposalId,...identity,translation:'Қош келдіңіз {name}'});assert.equal(edited.status,200);
  const edit=await edited.json();assert.equal(edit.status,'pending');assert.notEqual(edit.id,proposalId);
  assert.equal((await fetch(base+`/api/runs/${job.id}/fixed`)).status,400);
  assert.equal((await post(`/api/runs/${job.id}/correction-review`,{issueId,proposalId,status:'approved',confirm:true,...identity})).status,400);
  proposalId=edit.id;
  assert.equal((await post(`/api/runs/${job.id}/correction-review`,{issueId,proposalId,status:'approved',confirm:true,...identity})).status,400);
  assert.equal((await post(`/api/runs/${job.id}/correction-review`,{issueId,proposalId,status:'approved',confirm:true,...identity,translation:edit.translation})).status,200);
  assert.equal((await get(`/api/runs/${job.id}/fixed`)).a,edit.translation);
  const rows=await get(`/api/datasets/${d.id}/rows`);assert.equal(rows.rows[0].target,'Сәлем {player}');
 }finally{await app.close();}
 const again=await createPlatform({dataDir,seed:false});await new Promise(r=>again.server.listen(0,'127.0.0.1',r));
 try{
  const b=`http://127.0.0.1:${again.server.address().port}`,boot=await (await fetch(b+'/api/bootstrap')).json();
  const saved=await (await fetch(b+`/api/runs/${job.id}/corrections`)).json();assert.equal(saved[issueId].status,'approved');
  assert.equal(saved[issueId].reviewer,'Reviewer Test');assert.equal(saved[issueId].note,'Checked');assert.ok(saved[issueId].history.length>=3);
  const rejected=await fetch(b+`/api/runs/${job.id}/correction-review`,{method:'POST',headers:{'Content-Type':'application/json','X-Locqa-Token':boot.csrf},body:JSON.stringify({issueId,proposalId,status:'rejected',reviewer:'Reviewer Test',note:'Withdrawn'})});assert.equal(rejected.status,200);
  assert.equal((await fetch(b+`/api/runs/${job.id}/fixed`)).status,400);
 }finally{await again.close();}
});
