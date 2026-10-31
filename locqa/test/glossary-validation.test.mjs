import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareReview,reviewBody,validateGlossaryReview,reviewCsv,parseDraft} from '../src/glossary-review.mjs';
import {glossaryCsv} from '../src/glossary.mjs';
import {validateKkCandidate,contextPolicy} from '../src/glossary-validation.mjs';

const original=(ru,kk,en,extra={})=>({ru,kk,en,status:'proposed',...extra});
const prepare=(term,records=[])=>prepareReview(parseDraft(glossaryCsv([term])),records)[0];
const review=(row,change={})=>validateGlossaryReview({results:[{id:row.id,verdict:'change',recommended_kk:null,reason:'Сопоставление RU, KK и EN.',priority:'normal',...change}]},[row])[0];
const record=(key,ru,kk,en)=>({key,source:ru,target:kk,context:{english:en,section:'GAME',description:''}});

test('chicken drumsticks: reject Russian/Kazakh mixtures and keep the original for human review',()=>{
  const row=prepare(original('Оригинальные ножки','Оригинал аяқтар','Chicken drumsticks'));
  const result=review(row,{recommended_kk:'Оригинал ножки',reason:'Слово аяқтар слишком общее, лучше использовать ножки.'});
  assert.equal(result.verdict,'uncertain');assert.equal(result.recommended_kk,null);assert.equal(result.rejected_kk,'Оригинал ножки');
  assert.ok(result.validation_flags.includes('untranslated_russian_fragment:ножки'));assert.equal(result.requires_human_review,true);
  assert.equal(row.original.kk,'Оригинал аяқтар');assert.equal(row.status,'proposed');assert.equal(row.reviewed_by_human,false);
  assert.equal(validateKkCandidate(row.original,'Выберите регион').valid,false);
  assert.equal(validateKkCandidate(row.original,'НОЖКИ').valid,false);
});

test('country canonical casing is checked on keep and change; ordinary UI casing is preserved',()=>{
  const row=prepare(original('Казахстан','қазақстан','Qazaqstan | Kazakhstan',{related_keys:'regionKazakhstan|police_kz'}));
  assert.equal(row.context_policy.requires_key_scope,false);
  for(const v of [{verdict:'keep',recommended_kk:'қазақстан'},{verdict:'keep',recommended_kk:'Қазақстан'},{verdict:'change',recommended_kk:'Қазақстан'},{verdict:'uncertain',recommended_kk:null}]){
    const result=review(row,v);assert.equal(result.verdict,'change');assert.equal(result.recommended_kk,'Қазақстан');assert.equal(result.recommendation_source,'rules');assert.equal(row.original.kk,'қазақстан');
  }
  assert.equal(validateKkCandidate(row.original,'қазақстан').valid,false);assert.equal(validateKkCandidate(row.original,'ҚАЗАҚСТАН').valid,false);assert.equal(validateKkCandidate(row.original,'Қазақстан').valid,true);
  const label=prepare(original('Продолжить','ЖАЛҒАСТЫРУ','Continue'));
  assert.equal(review(label,{verdict:'keep',recommended_kk:'Жалғастыру'}).recommended_kk,'ЖАЛҒАСТЫРУ');
});

test('профиль is protected in the validated UI Profile sense, without inventing approval or general language rules',()=>{
  const row=prepare(original('Профиль','профиль','Profile'));
  for(const v of [{verdict:'uncertain',recommended_kk:null},{verdict:'change',recommended_kk:'Профиль'},{verdict:'change',recommended_kk:'Жеке бет'}]){
    const result=review(row,v);assert.equal(result.verdict,'keep');assert.equal(result.recommended_kk,'профиль');assert.equal(result.model_verdict,v.verdict);assert.ok(result.validation_flags.includes('established_vocabulary_preserved'));assert.equal(row.status,'proposed');
  }
  // The same Russian spelling can describe another sense: the protected UI example is scoped.
  const shape=prepare(original('Профиль','профиль','Side outline'));
  assert.equal(review(shape,{verdict:'uncertain'}).verdict,'uncertain');
  for(const kk of ['профиль','Бонус','сыйақыны','жеңілдіктермен','Оригинал стрипстер'])assert.equal(validateKkCandidate(original('Термин',kk,'Term'),kk).valid,true,kk);
});

test('preserve explicitly identified proper names, standard abbreviations and Kazakh plurals; reject unsupported style changes',()=>{
  const brand=original('Ножки','Ножки','Brand',{category:'brand'});
  assert.equal(validateKkCandidate(brand,'Ножки').valid,true);
  const gps=prepare(original('GPS','GPS','GPS'));assert.equal(review(gps,{verdict:'uncertain'}).recommended_kk,'GPS');
  const strips=prepare(original('Оригинальные стрипсы','Оригинал стрипстер','Chicken strips'));
  const plural=review(strips,{recommended_kk:'Оригинал стрипс'});assert.equal(plural.verdict,'uncertain');assert.ok(plural.validation_flags.includes('possible_lost_kazakh_plural'));
  const literal=prepare(original('Текущая награда','Ағымдағы сыйақы','Current reward'));
  const preference=review(literal,{recommended_kk:'Қазіргі сыйақы',reason:'Так звучит более естественно, это стилистическое улучшение.'});assert.equal(preference.verdict,'uncertain');assert.equal(preference.recommended_kk,null);
  const body=reviewBody([strips],768);assert.match(body.messages[0].content,/Chicken drumsticks/);assert.match(body.messages[0].content,/профиль/);assert.match(body.messages[0].content,/Қазақстан/);
});

test('conflicting senses, currencies and units require an explicit key; all ARB contexts are inspected, including beyond the sample',()=>{
  const term=original('Выберите регион','','Pick a region | Select a country',{related_keys:'region|country',observed_variants:'Аймақты таңдаңыз|Елді таңдаңыз'});
  const row=prepare(term,[record('region',term.ru,'Аймақты таңдаңыз','Pick a region'),record('country',term.ru,'Елді таңдаңыз','Select a country')]);
  assert.equal(row.context_policy.requires_key_scope,true);
  const result=review(row,{recommended_kk:'Аймақты таңдаңыз'});assert.equal(result.verdict,'uncertain');assert.equal(result.recommended_kk,null);assert.ok(result.validation_flags.includes('requires_key_scope'));
  assert.equal(contextPolicy(original('м','м','m',{related_keys:'format_min_s|meters'})).requires_key_scope,true);
  assert.equal(contextPolicy(original('руб.','','RUB | USD',{related_keys:'rub|usd'})).requires_key_scope,true);
  const contexts=Array.from({length:6},(_,i)=>record('k'+i,'Термин','Бір',i===5?'Another meaning':'First meaning'));
  const sampled=prepare(original('Термин','Бір','First meaning',{related_keys:contexts.map(r=>r.key).join('|')}),contexts);
  assert.equal(sampled.context_count,6);assert.equal(sampled.context_policy.requires_key_scope,true);assert.ok(sampled.contexts.some(c=>c.key==='k5'));assert.equal(sampled.context_groups.flatMap(g=>g.keys).length,6);
  const scoped=prepare({...term,key:'region'},[record('region',term.ru,'Аймақты таңдаңыз','Pick a region'),record('country',term.ru,'Елді таңдаңыз','Select a country')]);
  assert.equal(scoped.context_policy.requires_key_scope,false);assert.deepEqual(scoped.contexts.map(c=>c.key),['region']);assert.equal(scoped.original.related_keys,'region|country');
});

test('uncertain recommendations retain originals and review CSV marks every row proposed with full validation metadata',()=>{
  const term=original('Неоднозначно','Бастапқы','Ambiguous',{comment:'Original note',reviewer:'Original metadata'}),row=prepare(term);
  const v=review(row,{verdict:'uncertain',recommended_kk:null});Object.assign(row,{verdict:v.verdict,recommended_kk:v.recommended_kk,validation_flags:v.validation_flags,review_state:'reviewed'});
  const parsed=parseDraft(reviewCsv({columns:parseDraft(glossaryCsv([term])).columns,rows:[row]})).rows[0];
  assert.equal(parsed.kk,'Бастапқы');assert.equal(parsed.status,'proposed');assert.equal(parsed.reviewer,'');assert.equal(parsed.review_requires_human,'true');assert.equal(parsed.reviewed_by_human,'false');assert.equal(parsed.recommended_kk,'');assert.deepEqual(JSON.parse(parsed.original_json),row.original);
});
