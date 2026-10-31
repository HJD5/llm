import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {glossaryCsv} from '../src/glossary.mjs';
import {parseDraft,prepareReview,reviewBody,reviewCsv,reuseReviewCsv,reviewWorkload,runReview,validateGlossaryReview} from '../src/glossary-review.mjs';
import {preScreen,selectReviewRows,screeningSummary} from '../src/glossary-selection.mjs';
import {QwenClient} from '../src/qwen.mjs';
import {main} from '../review-glossary.mjs';

const term=(ru,kk,en='',extra={})=>({ru,kk,en,status:'proposed',...extra});
const make=(terms,records=[])=>{const d=parseDraft(glossaryCsv(terms));return {columns:d.columns,rows:prepareReview(d,records)};};
const result=row=>({id:row.id,verdict:'keep',recommended_kk:row.original.kk,reason:'Перевод соответствует контексту.',priority:'normal'});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'locqa-selection-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('pre-screen detects technical data, proper names, abbreviations, formatting, generic phrases, and useful missing translations without approval',()=>{
  const s=make([term('{count} монет','{count} монет','Coins'),term('Казахстан','қазақстан','Kazakhstan'),term('ID','ID','ID'),term(' Указатель ','Көрсеткіш','Indicator'),term('Наггетсы','Наггетстер','Chicken nuggets'),term('Фракция','','Faction'),term('Неясно','',''),term('Профиль','профиль','Profile')]);
  const originals=structuredClone(s.rows.map(r=>r.original));preScreen(s.rows);
  assert.deepEqual(s.rows.map(r=>r.screening.classification),['low_priority','rule_checked','rule_checked','rule_checked','low_priority','needs_llm','needs_human','rule_checked']);
  assert.equal(s.rows[1].screening.rule_suggestion,'Қазақстан');assert.ok(s.rows[3].screening.checks.includes('ru_outer_whitespace'));
  assert.deepEqual(s.rows.map(r=>r.original),originals);assert.ok(s.rows.every(r=>r.status==='proposed'&&!r.reviewed_by_human&&!r.screening.translation_linguistically_verified));
});

test('unresolved cross-key conflicts go to a human; a scoped conflict with useful context goes to Qwen',()=>{
  const global=term('Очки','','Glasses | Points',{related_keys:'glasses|points',observed_variants:'Көзілдірік|Ұпайлар'});
  const s=make([global,{...global,key:'points'}]);preScreen(s.rows);
  assert.equal(s.rows[0].screening.classification,'needs_human');assert.equal(s.rows[1].screening.classification,'needs_llm');
  assert.deepEqual(selectReviewRows(s,{selection:'smart',limit:10}).map(r=>r.id),[s.rows[1].id]);
});

test('only exact-context duplicates are suppressed; different keys and meanings remain separate',()=>{
  const a=term('Мут','Мут','Mute'),s=make([a,{...a},{...a,key:'chat_mute'}]);preScreen(s.rows);
  assert.equal(s.rows[1].screening.duplicate_of,s.rows[0].id);assert.equal(s.rows[1].screening.classification,'rule_checked');assert.equal(s.rows[2].screening.duplicate_of,undefined);
  assert.equal(selectReviewRows(s,{selection:'smart',limit:10}).length,2);assert.equal(s.rows.length,3);
});

test('smart selection ranks core game terms, preserves completed results, excludes numbered/settings labels, and supports all/priority thresholds',()=>{
  const s=make([term('Назад','Артқа','Back'),term('Текущий уровень','Ағымдағы деңгей','Current level'),term('Инвентарь','Мүкәммал','Inventory'),term('Ч','сағ','Hour'),term('1-5 уровень','1-5 деңгей','Level 1-5'),term('Уровень звука','Дыбыс деңгейі','Sound level'),term('Попытки','Талпыныстар','Attempts')]);
  assert.equal(selectReviewRows(s,{selection:'smart',priority:'high',limit:1})[0].original.ru,'Инвентарь');
  const medium=selectReviewRows(s,{selection:'smart',priority:'medium',limit:10});assert.ok(medium.some(r=>r.original.ru==='Ч'));assert.equal(medium.length,3);
  for(const i of [0,4,5,6])assert.equal(s.rows[i].screening.classification,'low_priority');
  const originalResult={review_state:'reviewed',recommended_kk:'Мүкәммал',verdict:'keep',model:{request_hash:'preserve'}};Object.assign(s.rows[2],originalResult);
  const selected=selectReviewRows(s,{selection:'smart',limit:10});assert.ok(!selected.includes(s.rows[2]));assert.deepEqual(s.rows[2].model,originalResult.model);
  assert.deepEqual(selectReviewRows(s,{selection:'all',limit:1}).map(r=>r.original.ru),['Назад']);
  assert.throws(()=>selectReviewRows(s,{selection:'wrong'}));assert.throws(()=>selectReviewRows(s,{priority:'low'}));
});

test('CSV-only completed results are revalidated and reused; changed context/revision is rejected and human approvals cannot be imported',()=>{
  const terms=[term('Мут','Мут','Mute',{related_keys:'mute'})];
  const records=en=>[{key:'mute',source:'Мут',target:'Мут',context:{english:en,section:'CHAT',description:''}}];
  const previous=make(terms,records('Mute'));Object.assign(previous.rows[0],{review_state:'reviewed',verdict:'keep',recommended_kk:'Мут',explanation:'Корректный термин.',model:{model_revision:'test-model'}});
  const parsed=parseDraft(reviewCsv(previous));parsed.rows[0].status='approved';parsed.rows[0].reviewer='Untrusted CSV';parsed.rows[0].reviewed_by_human='true';
  const csv=glossaryCsv(parsed.rows,parsed.columns),next=make(terms,records('Mute'));
  assert.equal(reuseReviewCsv(next,csv,{modelRevision:'test-model'}).reused,1);assert.equal(next.rows[0].review_state,'reviewed');assert.equal(next.rows[0].status,'proposed');assert.equal(next.rows[0].reviewed_by_human,false);
  assert.equal(reuseReviewCsv(make(terms,records('Different context')),csv,{modelRevision:'test-model'}).skipped,1);
  assert.equal(reuseReviewCsv(make(terms,records('Mute')),csv,{modelRevision:'different-model'}).skipped,1);
});

test('dry-run performs no HTTP calls or writes, including when restoring completed work from a CSV without a checkpoint',async t=>{
  const dir=await temp(t),input=path.join(dir,'draft.csv'),output=path.join(dir,'review.csv'),newOutput=path.join(dir,'new','review.csv');
  const s=make([term('Мут','Мут','Mute'),term('Инвентарь','Мүкәммал','Inventory')]);Object.assign(s.rows[0],{review_state:'reviewed',verdict:'keep',recommended_kk:'Мут',explanation:'Проверено Qwen.'});
  await fs.writeFile(input,glossaryCsv(s.rows.map(r=>r.original)));await fs.writeFile(output,reviewCsv(s));
  const originalFetch=globalThis.fetch,originalLog=console.log;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Dry-run must not use HTTP');};console.log=()=>{};
  try{
    const first=await main(['--input',input,'--out',newOutput,'--reuse-review',output,'--dry-run','--max-llm-calls','2']);assert.equal(first.plan.completed_llm,1);assert.equal(first.plan.selected_terms,1);assert.equal(first.plan.new_calls_hard_cap,2);
    const recovered=await main(['--input',input,'--out',output,'--resume','--dry-run']);assert.equal(recovered.plan.completed_llm,1);
  }finally{globalThis.fetch=originalFetch;console.log=originalLog;}
  assert.equal(calls,0);await assert.rejects(fs.access(path.dirname(newOutput)));await assert.rejects(fs.access(output+'.checkpoint.json'));
});

test('cache is reused before tokenization, even at zero budget and after an uncached term',async t=>{
  const dir=await temp(t),s=make([term('Мут','Мут','Mute'),term('Инвентарь','Мүкәммал','Inventory')]);let transportCalls=0;
  const prime=new QwenClient({endpoint:'http://127.0.0.1:8088/v1/chat/completions',modelRevision:'test',cacheDir:dir,request:async()=>{transportCalls++;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({results:[result(s.rows[1])]})}}]})};}});
  await prime.structured(reviewBody([s.rows[1]],768),v=>validateGlossaryReview(v,[s.rows[1]]));assert.equal(transportCalls,1);
  const client=new QwenClient({endpoint:prime.endpoint,modelRevision:'test',cacheDir:dir,maxCalls:0,request:async()=>{throw Error('No HTTP allowed');}});
  client.countChatTokens=async()=>{throw Error('Cache hit must skip tokenization');};
  const plan=await reviewWorkload(s,{client,selection:'all',limit:2,batchSize:1});assert.equal(plan.cached_terms,1);assert.equal(plan.estimated_new_calls_without_retries,0);assert.equal(client.cacheHits,0);
  await runReview(s,{client,selection:'all',limit:2,batchSize:1});assert.equal(client.calls,0);assert.equal(client.cacheHits,1);assert.equal(s.rows[0].review_state,'deferred');assert.equal(s.rows[1].review_state,'reviewed');
});

test('generation attempts including retries stay within the hard cap, and completed results are never reselected',async t=>{
  const dir=await temp(t),s=make([term('Мут','Мут','Mute'),term('Инвентарь','Мүкәммал','Inventory'),term('Оружие','Қару','Weapon')]);
  const client=new QwenClient({endpoint:'http://127.0.0.1:8088/v1/chat/completions',modelRevision:'test',cacheDir:dir,maxCalls:2,maxRetries:1,request:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'broken JSON'}}]})})});
  let tokenizations=0;client.countChatTokens=async()=>{tokenizations++;return 100;};
  await runReview(s,{client,selection:'smart',limit:3,batchSize:1});assert.equal(client.calls,2);assert.equal(tokenizations,1);assert.equal(s.last_selection.sent_to_qwen,1);assert.equal(s.rows.filter(r=>r.review_state==='deferred').length,2);assert.equal(screeningSummary(s).approved,0);
});
