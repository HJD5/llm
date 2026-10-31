import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPlatform} from './server.mjs';
import {GlossaryReviewStore,exportGlossary} from './glossary-review.mjs';
import {prepareReview,parseDraft,reviewCsv} from '../locqa/src/glossary-review.mjs';
import {glossaryCsv,readGlossary} from '../locqa/src/glossary.mjs';
import {checkRecords} from '../locqa/src/engine.mjs';

const review=()=>{
  const d=parseDraft(glossaryCsv([{ru:'Награда',kk:'Марапат',en:'Reward',status:'proposed',observed_variants:'Марапат|Сыйақы'},{ru:'Семья',kk:'Отбасы',en:'Family',status:'proposed',key:'family_name'}]));
  const rows=prepareReview(d);Object.assign(rows[0],{review_state:'reviewed',verdict:'change',recommended_kk:'Сыйақы',explanation:'Термин награды в игре.'});
  return {columns:d.columns,rows};
};

test('batch approval requires explicit human confirmation, rejects stale/partial batches and persists exact approved text',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'glossary-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'review.json');
  const store=await new GlossaryReviewStore(file).load(),s=review();let view=await store.import(reviewCsv(s),null);
  const entries=view.entries.map(r=>({id:r.id,translation:r.recommended_kk??r.original.kk}));
  const command={revision:view.revision,entries,status:'approved',reviewer:'Reviewer test',confirm:true};
  await assert.rejects(store.decide({...command,confirm:false}));await assert.rejects(store.decide({...command,reviewer:''}));await assert.rejects(store.decide({...command,entries:[entries[0],{id:'missing',translation:'Жоқ'}]}));assert.ok(store.view().entries.every(r=>r.status==='proposed'));
  view=await store.decide(command);assert.equal(view.counts.approved,2);assert.ok(view.entries.every(r=>r.reviewed_by_human));
  await assert.rejects(store.decide(command),/изменился/);
  const again=await new GlossaryReviewStore(file).load();assert.equal(again.view().entries[0].decision.translation,'Сыйақы');
  view=await store.import(reviewCsv(s),view.revision);assert.equal(view.counts.approved,2); // identical reimport preserves explicit decisions
  s.rows[0].recommended_kk='Басқа';view=await store.import(reviewCsv(s),view.revision);assert.equal(view.entries[0].status,'proposed');assert.equal(view.entries[1].status,'approved');
});

test('concurrent batches are serialized and conflicting global terminology is rejected atomically',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'glossary-conflict-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=await new GlossaryReviewStore(path.join(dir,'review.json')).load();
  const d=parseDraft(glossaryCsv([{ru:'Термин',kk:'Бір',status:'proposed'},{ru:'Термин',kk:'Екі',status:'proposed'}]));
  const view=await store.import(reviewCsv({columns:d.columns,rows:prepareReview(d)}),null);
  const command={revision:view.revision,entries:view.entries.map(r=>({id:r.id,translation:r.original.kk})),status:'approved',reviewer:'Human',confirm:true};
  await assert.rejects(store.decide(command),/Конфликт/);assert.equal(store.view().counts.approved,0);
  const outcomes=await Promise.allSettled([store.decide({...command,entries:[command.entries[0]]}),store.decide({...command,entries:[command.entries[1]]})]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(store.view().counts.approved,1);
});

test('platform imports proposals, protects decisions, exports checker-compatible approved terms and supports reject/reset/restart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'glossary-http-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let app=await createPlatform({dataDir:dir,seed:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  const get=async p=>(await fetch(base+p)).json(),boot=await get('/api/bootstrap');
  const post=(p,body,token=boot.csrf)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Locqa-Token':token},body:JSON.stringify(body)});
  try{
    assert.equal((await fetch(base+'/glossary.js')).status,200);
    const csv=reviewCsv(review());assert.equal((await post('/api/glossary/import',{csv},'wrong')).status,403);
    let res=await post('/api/glossary/import',{csv});assert.equal(res.status,200);let view=await res.json();assert.equal(view.counts.proposed,2);
    assert.equal(readGlossary(await (await fetch(base+'/api/glossary/export')).text()).length,0);
    const decision={revision:view.revision,entries:[{id:view.entries[0].id,translation:'Сыйақы'}],status:'approved',reviewer:'Human reviewer',note:'Checked game usage',confirm:true};
    assert.equal((await post('/api/glossary/decisions',{...decision,confirm:false})).status,400);
    res=await post('/api/glossary/decisions',decision);assert.equal(res.status,200);view=await res.json();
    const terms=readGlossary(await (await fetch(base+'/api/glossary/export')).text());assert.equal(terms.length,1);assert.equal(terms[0].kk,'Сыйақы');assert.equal(terms[0].reviewer,'Human reviewer');assert.deepEqual(terms[0].variants,[]);assert.equal(terms[0].observed_variants,'Марапат|Сыйақы');
    const report=await checkRecords([{key:'reward',source:'Награда',target:'Марапат',context:{},metadata:{}}],{checks:['glossary_violation'],terms});assert.equal(report.issues.length,1);
    res=await post('/api/glossary/decisions',{...decision,revision:view.revision,status:'rejected'});view=await res.json();assert.equal(view.counts.rejected,1);assert.equal(readGlossary(await (await fetch(base+'/api/glossary/export')).text()).length,0);
    res=await post('/api/glossary/decisions',{...decision,revision:view.revision,status:'proposed'});view=await res.json();assert.equal(view.counts.proposed,2);assert.equal(view.entries[0].reviewed_by_human,false);
  }finally{await app.close();}
  app=await createPlatform({dataDir:dir,seed:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  try{const view=await(await fetch('http://127.0.0.1:'+app.server.address().port+'/api/glossary')).json();assert.equal(view.entries[0].history.length,2);assert.equal(view.counts.proposed,2);}finally{await app.close();}
});

test('ambiguous groups cannot be globally approved, scope flags cannot be forged, and exported rules only affect the chosen key',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'glossary-scope-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=await new GlossaryReviewStore(path.join(dir,'review.json')).load();
  const d=parseDraft(glossaryCsv([{ru:'Выберите регион',kk:'',en:'Pick a region | Select a country',status:'proposed',observed_variants:'Аймақты таңдаңыз|Елді таңдаңыз',related_keys:'region|country'}]));
  let view=await store.import(reviewCsv({columns:d.columns,rows:prepareReview(d)}).replaceAll('"true"','"false"'),null);
  const entry=view.entries[0];assert.equal(entry.requires_key_scope,true);
  const command={revision:view.revision,entries:[{id:entry.id,translation:'Аймақты таңдаңыз'}],status:'approved',reviewer:'Human',confirm:true};
  await assert.rejects(store.decide(command),/контексты/);assert.equal(store.view().counts.approved,0);
  await assert.rejects(store.decide({...command,entries:[{...command.entries[0],key:'invented'}]}),/ключ/);
  view=await store.decide({...command,entries:[{...command.entries[0],key:'region'}]});assert.equal(view.counts.approved,1);
  const terms=readGlossary(exportGlossary(view.entries));assert.equal(terms[0].key,'region');
  const report=await checkRecords(['region','country'].map(key=>({key,source:'Выберите регион',target:'Басқа',context:{},metadata:{}})),{checks:['glossary_violation'],terms});assert.deepEqual(report.issues.map(i=>i.key),['region']);
  const legacy=structuredClone(view.entries);delete legacy[0].decision.key;assert.throws(()=>exportGlossary(legacy),/контексты/);
});

test('human approval and export revalidate obvious Russian mixtures and country capitalization, including old stored decisions',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'glossary-kk-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=await new GlossaryReviewStore(path.join(dir,'review.json')).load();
  const d=parseDraft(glossaryCsv([{ru:'Оригинальные ножки',kk:'Оригинал аяқтар',en:'Chicken drumsticks',status:'proposed'},{ru:'Казахстан',kk:'қазақстан',en:'Kazakhstan',status:'proposed'}]));
  const view=await store.import(reviewCsv({columns:d.columns,rows:prepareReview(d)}),null);
  const command={revision:view.revision,status:'approved',reviewer:'Human',confirm:true};
  await assert.rejects(store.decide({...command,entries:[{id:view.entries[0].id,translation:'Оригинал ножки'}]}),/untranslated_russian_fragment/);
  await assert.rejects(store.decide({...command,entries:[{id:view.entries[1].id,translation:'қазақстан'}]}),/proper_noun_capitalization/);
  const legacy=view.entries.map(r=>({...r,status:'approved',reviewed_by_human:true,decision:{confirm:true,reviewer:'Human',translation:r.original.ru}}));assert.throws(()=>exportGlossary(legacy),/проверку/);
  const valid=await store.decide({...command,entries:[{id:view.entries[1].id,translation:'Қазақстан'}]});assert.equal(readGlossary(exportGlossary(valid.entries))[0].kk,'Қазақстан');assert.equal(valid.entries[0].status,'proposed');
});
