import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseDraft,prepareReview,reviewCsv} from '../src/glossary-review.mjs';
import {glossaryCsv} from '../src/glossary.mjs';
import {buildShortlist} from '../src/glossary-shortlist.mjs';
import {main} from '../shortlist-glossary.mjs';

const term=(ru,kk,en,extra={})=>({ru,kk,en,status:'proposed',...extra});
const record=(key,source,target,english)=>({key,source,target,context:{english,section:'GAME',description:'Usage example'}});
function fixture(terms,records=[]){
  const draft=parseDraft(glossaryCsv(terms)),rows=prepareReview(draft,records);
  for(const row of rows)if(row.original.kk.trim())Object.assign(row,{review_state:'reviewed',verdict:'keep',recommended_kk:row.original.kk,explanation:'Synthetic model fixture; not native-speaker confirmation.'});
  return {draft,review:parseDraft(reviewCsv({columns:draft.columns,rows}))};
}
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'locqa-shortlist-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('shortlist is deterministic, partitions every source row, favors useful frequent terms and does not pad to a target',()=>{
  const {draft,review}=fixture([term('Инвентарь','Мүкәммал','Inventory',{related_keys:'i1|i2|i3'}),term('Фракция','Фракция','Faction',{related_keys:'f1|f2'}),term('Купить','Сатып алу','Buy',{related_keys:'b1|b2|b3'}),term('Наггетсы','Наггетстер','Chicken nuggets'),term('Вы действительно хотите купить предмет','Сатып алу','Are you sure you want to buy an item?'),term('1-5 уровень','1-5 деңгей','Level 1-5')]);
  const before=structuredClone({draft,review}),first=buildShortlist(draft,review,{target:120}),second=buildShortlist(draft,review,{target:120});
  assert.deepEqual(first,second);assert.deepEqual({draft,review},before);assert.equal(first.rows.length,3);assert.equal(first.excluded.length,3);assert.equal(first.summary.selected+first.summary.excluded,draft.rows.length);
  assert.deepEqual(new Set(first.rows.map(r=>r.ru)),new Set(['Инвентарь','Фракция','Купить']));assert.ok(first.rows.every(r=>r.status==='proposed'&&r.reviewed_by_human==='false'));
});

test('deduplicates case/punctuation equivalents without merging different English senses or key scopes',()=>{
  const {draft,review}=fixture([term('БАЛАНС:','БАЛАНС:','Balance:',{related_keys:'a|b|c'}),term('баланс','баланс','balance',{related_keys:'d'}),term('Баланс','Қалдық','Remaining amount',{key:'remaining'}),term('Баланс','Баланс','Balance',{key:'wallet'})]);
  const result=buildShortlist(draft,review,{target:120});assert.equal(result.rows.length,3);
  const duplicate=result.excluded.find(r=>r.reason==='obvious_duplicate');assert.ok(duplicate);assert.ok(duplicate.source.original_json);assert.ok(duplicate.source.related_keys);assert.ok(result.rows.some(r=>r.review_id===duplicate.duplicate_of));
  assert.ok(result.rows.some(r=>r.key==='remaining'));assert.ok(result.rows.some(r=>r.key==='wallet'));
});

test('preserves every selected original/review column, flags missing or uncertain terms, and retains all excluded row data',()=>{
  const {draft,review}=fixture([term('Оружие','Қару','Weapons',{comment:'Use in inventory, not a person name',related_keys:'weapon',reviewer:'Source metadata'}),term('Отмена','','Cancel',{related_keys:'cancel|cancel2',observed_variants:'Бас тарту|Болдырмау'}),term('Фракция','Фракция','Faction',{related_keys:'faction'})]);
  review.rows[2].review_verdict='uncertain';review.rows[2].recommended_kk='';review.rows[2].review_validation_flags='unsupported_style_change';
  const result=buildShortlist(draft,review,{target:120});assert.equal(result.summary.existing_translation,1);assert.equal(result.summary.needs_attention,2);
  for(const row of result.rows){const source=review.rows.find(r=>r.review_id===row.review_id);for(const key of review.columns)if(!['status','reviewer','reviewed_by_human','review_requires_human'].includes(key))assert.equal(row[key],source[key],key);}
  assert.equal(result.rows[0].ru,'Оружие');assert.equal(result.rows[0].shortlist_group,'existing_translation');
  const cancel=result.rows.find(r=>r.ru==='Отмена');assert.match(cancel.shortlist_attention_flags,/empty_kk/);assert.match(cancel.shortlist_attention_flags,/requires_key_scope/);assert.equal(cancel.recommended_kk,'');
  assert.equal(JSON.parse(result.rows[0].original_json).reviewer,'Source metadata');
});

test('ARB usage counts distinct keys, retains current contexts and flags additional or changed meaning instead of certifying it',()=>{
  const saved=[record('inventory','Инвентарь','Мүкәммал','Inventory')];
  const {draft,review}=fixture([term('Инвентарь','Мүкәммал','Inventory',{related_keys:'inventory'})],saved);
  const current=[...saved,record('inventory_new','ИНВЕНТАРЬ','Қор','Stock')];
  const result=buildShortlist(draft,review,{records:current});const row=result.rows[0];
  assert.equal(row.shortlist_usage_count,'2');assert.equal(row.shortlist_usage_source,'actual_arb_keys');assert.match(row.shortlist_arb_keys,/inventory_new/);assert.equal(JSON.parse(row.shortlist_arb_context).length,2);
  assert.equal(row.shortlist_group,'needs_attention');assert.match(row.shortlist_attention_flags,/additional_arb_context/);assert.match(row.shortlist_attention_flags,/requires_key_scope/);assert.equal(row.review_requires_key_scope,'false');
});

test('relevant model changes remain visible as uncertain proposals without replacing the existing KK',()=>{
  const {draft,review}=fixture([term('Фракция','Фракция','Faction'),term('Цена за единицу','Бірлік бағасы','Unit price',{related_keys:'p1|p2|p3'}),term('Игровой валюты','Ойын валютасы','Cash')]);
  review.rows[2].review_verdict='change';review.rows[2].recommended_kk='Ойын ақшасы';
  const result=buildShortlist(draft,review,{target:2});const changed=result.rows.find(r=>r.ru==='Игровой валюты');
  assert.ok(changed);assert.equal(changed.kk,'Ойын валютасы');assert.equal(changed.recommended_kk,'Ойын ақшасы');assert.equal(changed.status,'proposed');assert.equal(changed.shortlist_group,'needs_attention');assert.match(changed.shortlist_attention_flags,/model_change/);assert.equal(result.summary.model_changes_selected,1);
});

test('rejects mismatched inputs rather than silently dropping provenance or original terms',()=>{
  const {draft,review}=fixture([term('Инвентарь','Мүкәммал','Inventory'),term('Оружие','Қару','Weapons')]);
  const changed=structuredClone(review);changed.rows[0].kk='Changed';assert.throws(()=>buildShortlist(draft,changed),/does not match/);
  assert.throws(()=>buildShortlist(draft,{...review,rows:review.rows.slice(0,1)}),/counts differ/);
  const duplicated=structuredClone(review);duplicated.rows[1].original_json=duplicated.rows[0].original_json;duplicated.rows[1].ru=duplicated.rows[0].ru;duplicated.rows[1].kk=duplicated.rows[0].kk;assert.throws(()=>buildShortlist(draft,duplicated),/does not match/);
});

test('CLI writes only a new output directory, preserves inputs and refuses overwrites without any network or model invocation',async t=>{
  const dir=await temp(t),draftFile=path.join(dir,'draft.csv'),reviewFile=path.join(dir,'review.csv'),out=path.join(dir,'shortlist');
  const {draft,review}=fixture([term('Оружие','Қару','Weapons')]);
  await fs.writeFile(draftFile,glossaryCsv(draft.rows,draft.columns));await fs.writeFile(reviewFile,glossaryCsv(review.rows,review.columns));
  const hashes=await Promise.all([draftFile,reviewFile].map(async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex')));
  const fetch=globalThis.fetch,log=console.log;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('No network allowed');};console.log=()=>{};
  try{await main(['--draft',draftFile,'--review',reviewFile,'--out-dir',out]);await assert.rejects(main(['--draft',draftFile,'--review',reviewFile,'--out-dir',out]),/EEXIST/);}finally{globalThis.fetch=fetch;console.log=log;}
  assert.equal(calls,0);assert.deepEqual(await Promise.all([draftFile,reviewFile].map(async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex'))),hashes);
  const csv=parseDraft(await fs.readFile(path.join(out,'glossary_shortlist.csv'),'utf8'));assert.equal(csv.rows[0].status,'proposed');assert.equal(csv.rows[0].shortlist_group,'existing_translation');assert.ok((await fs.readFile(path.join(out,'selection-manifest.json'),'utf8')).includes('input_hashes'));
});
