import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GlossaryReviewStore,exportGlossary} from './glossary-review.mjs';
import {glossaryCsv,readGlossary} from '../locqa/src/glossary.mjs';
import {parseDraft,prepareReview,reviewCsv} from '../locqa/src/glossary-review.mjs';
import {buildShortlist} from '../locqa/src/glossary-shortlist.mjs';

async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'locqa-shortlist-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,store:await new GlossaryReviewStore(path.join(dir,'review.json')).load()};}
function fixture(){
  const draft=parseDraft(glossaryCsv([{ru:'Оружие',kk:'Қару',en:'Weapons',status:'proposed',related_keys:'weapon'},{ru:'Отмена',kk:'',en:'Cancel | Abort',status:'proposed',observed_variants:'Бас тарту|Болдырмау',related_keys:'cancel|abort'},{ru:'Наггетсы',kk:'Наггетстер',en:'Chicken nuggets',status:'proposed'}]));
  const rows=prepareReview(draft);Object.assign(rows[0],{review_state:'reviewed',verdict:'keep',recommended_kk:'Қару',explanation:'Synthetic fixture'});
  return {draft,review:parseDraft(reviewCsv({columns:draft.columns,rows}))};
}
test('shortlist import exposes queues and usage, archives omitted entries and preserves existing explicit human decisions',async t=>{
  const {store}=await setup(t),{draft,review}=fixture();let view=await store.import(glossaryCsv(review.rows,review.columns),null);
  view=await store.decide({revision:view.revision,entries:[{id:view.entries[0].id,translation:'Қару'}],reviewer:'Test human',status:'approved',confirm:true});
  const before=structuredClone(view),shortlist=buildShortlist(draft,review);
  view=await store.import(glossaryCsv(shortlist.rows,shortlist.columns),view.revision);
  assert.equal(view.entries.length,2);assert.equal(view.counts.approved,1);assert.equal(view.entries[0].decision.reviewer,'Test human');assert.equal(view.entries[0].shortlist.group,'existing_translation');assert.equal(view.entries[0].shortlist.usage,1);
  assert.ok(view.previous_import_archive);const archive=JSON.parse(await fs.readFile(view.previous_import_archive,'utf8'));assert.equal(archive.entries.length,3);assert.deepEqual(archive.entries,before.entries);assert.equal(archive.entries[0].decision.confirm,true);
  const attention=view.entries.find(r=>r.shortlist.group==='needs_attention');assert.ok(attention.requires_key_scope);
  await assert.rejects(store.decide({revision:view.revision,entries:[{id:attention.id,translation:'Болдырмау'}],reviewer:'Test human',status:'approved',confirm:true}),/контексты/);
  assert.equal(readGlossary(exportGlossary(view.entries)).length,1);
});
test('current ARB context in shortlist is enforced by approval and invalidates stale global confirmation without losing its history',async t=>{
  const {store}=await setup(t);
  const draft=parseDraft(glossaryCsv([{ru:'Уровень',kk:'Деңгей',en:'Level',status:'proposed',related_keys:'level'}]));
  const records=[{key:'level',source:'Уровень',target:'Деңгей',context:{english:'Level',section:'PLAYER',description:''}}];
  const rows=prepareReview(draft,records);Object.assign(rows[0],{review_state:'reviewed',verdict:'keep',recommended_kk:'Деңгей',explanation:'Synthetic fixture'});
  const review=parseDraft(reviewCsv({columns:draft.columns,rows}));let view=await store.import(glossaryCsv(review.rows,review.columns),null);
  view=await store.decide({revision:view.revision,entries:[{id:view.entries[0].id,translation:'Деңгей'}],status:'approved',reviewer:'Test human',confirm:true});
  const shortlist=buildShortlist(draft,review,{records:[...records,{key:'rank',source:'Уровень',target:'Ранг',context:{english:'Rank',section:'FACTION',description:''}}]});
  view=await store.import(glossaryCsv(shortlist.rows,shortlist.columns),view.revision);assert.equal(view.counts.approved,0);assert.equal(view.entries[0].status,'proposed');assert.ok(view.entries[0].history.some(r=>r.decision?.confirm));assert.ok(view.entries[0].scope_keys.includes('rank'));
  await assert.rejects(store.decide({revision:view.revision,entries:[{id:view.entries[0].id,translation:'Деңгей'}],status:'approved',reviewer:'Test human',confirm:true}),/контексты/);
});
