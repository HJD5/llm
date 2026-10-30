import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPlatform,parseGlossary} from './server.mjs';
test('glossary validates rows and quoted CSV',()=>{
 assert.equal(parseGlossary('ru,kk,note\n"Тест, один",Сынақ,"a,b"')[0].ru,'Тест, один');
 assert.throws(()=>parseGlossary('[{"ru":"x"}]'));
});
test('upload, real worker, report, review, export and restart persistence',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'locqa-platform-'));
 const app=await createPlatform({dataDir:dir,seed:false});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+app.server.address().port;
 const get=async p=>(await fetch(base+p)).json();
 const boot=await get('/api/bootstrap');
 const post=(p,obj,token=boot.csrf)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Locqa-Token':token},body:JSON.stringify(obj)});
 let id,jobId;
 try{
   assert.equal((await post('/api/datasets',{},'wrong')).status,403);
   assert.equal((await fetch(base+'/api/bootstrap',{headers:{Origin:'https://external.example'}})).status,403);
   assert.equal((await post('/api/datasets',{source:'{bad',target:'{}'})).status,400);
   const created=await post('/api/datasets',{name:'Test','source':'{"@@locale":"ru","a":"Hello {name}","b":"Купить","c":"<script>alert(1)</script>"}','target':'{"@@locale":"kk","a":"Сәлем {player}","b":"","c":""}'});
   assert.equal(created.status,201);const d=await created.json();id=d.id;
   const rows=await get(`/api/datasets/${id}/rows?q=Hello`);assert.equal(rows.total,1);
   const started=await post('/api/runs',{datasetId:id,checks:['untranslated','placeholder_mismatch'],useModel:false,budget:0,keys:[]});assert.equal(started.status,201);const j=await started.json();jobId=j.id;
   let state;
   for(let i=0;i<100;i++){state=await get('/api/runs/'+jobId);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,30));}
   assert.equal(state.status,'completed');
   const report=await get(`/api/runs/${jobId}/report`);assert.equal(report.issues.length,3);assert.equal(report.model_calls,0);
   const review=await post(`/api/runs/${jobId}/review`,{issueId:report.issues[0].id,status:'accepted',note:'Checked in integration test'});assert.equal(review.status,200);
   assert.equal((await get(`/api/runs/${jobId}/report`)).issues[0].reviewed_by_human,true);
   const html=await (await fetch(base+`/api/runs/${jobId}/download?format=html`)).text();assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('Подтверждено человеком'));assert.ok(html.includes('Checked in integration test'));
   assert.equal((await post(`/api/runs/${jobId}/cancel`,{})).status,409);
   const both=await Promise.all([post('/api/runs',{datasetId:id,checks:['untranslated'],useModel:false,budget:0}),post('/api/runs',{datasetId:id,checks:['untranslated'],useModel:false,budget:0})]);
   assert.deepEqual(both.map(r=>r.status).sort(),[201,400]);
   const running=await both.find(r=>r.status===201).json();
   const stopped=await post(`/api/runs/${running.id}/cancel`,{});assert.equal(stopped.status,200);assert.equal((await stopped.json()).status,'cancelled');
 }finally{await app.close();}
 const again=await createPlatform({dataDir:dir,seed:false});await new Promise(r=>again.server.listen(0,'127.0.0.1',r));
 try{const b='http://127.0.0.1:'+again.server.address().port;const after=await (await fetch(b+'/api/bootstrap')).json();assert.ok(after.datasets.some(d=>d.id===id));assert.ok(after.runs.some(j=>j.id===jobId));const r=await (await fetch(b+`/api/runs/${jobId}/report`)).json();assert.equal(r.issues[0].human_review.status,'accepted');}finally{await again.close();}
});
