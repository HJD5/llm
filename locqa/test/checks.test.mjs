import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseArb,makeRecords} from '../src/arb.mjs';
import {checkRecords,modules} from '../src/engine.mjs';
import {analyzeMessage,printfArguments,validateSuggestion} from '../src/message.mjs';
import {QwenClient,validateReview} from '../src/qwen.mjs';
import {htmlReport} from '../src/report.mjs';
const row=(source,target,key='test')=>({key,source,target,context:{},metadata:{source:{},target:{}}});
const run=async(r,options={})=>checkRecords(r,{...options});
test('exactly 11 separate modules',()=>assert.equal(new Set(modules.map(x=>x.id)).size,11));
test('ARB duplicate values and section metadata remain visible',()=>{
 const a=parseArb('{"@@locale":"kk","@@comment":"A","x":"first","@@comment":"B","x":"last","@x":{"description":"Tip"}}');
 assert.equal(a.entries.get('x').value,'last');assert.equal(a.entries.get('x').section,'B');
 assert.deepEqual(a.diagnostics[0].values.map(x=>x.value),['first','last']);
 assert.equal(a.metadata.get('@x').description,'Tip');
 assert.throws(()=>parseArb('{"x":"a",}'));assert.throws(()=>parseArb('[]'));
});
test('missing/empty translations and metadata keys',async()=>{
 const s=parseArb('{"lang":"ru","a":"Текст","b":"Текст","@a":{}}'),t=parseArb('{"b":""}');
 const r=await run(makeRecords(s,t));assert.equal(r.records,2);assert.equal(r.modules.untranslated.findings,2);assert.equal(r.model_reviews.length,0);
});
test('allowed names, numbers, private currency and unapproved Russian text',async()=>{
 const r=await run([row('Александр','Александр','name'),row('2026','2026','year'),row('\uea34','\uea34','currencySymbol'),row('Удалить персонажа','Удалить персонажа','delete')],{config:{allow_unchanged:['Александр']}});
 assert.deepEqual(r.issues.filter(x=>x.issue_type==='same_as_source').map(x=>x.key),['delete']);
});
test('argument renaming and printf order; escaped percent is literal',async()=>{
 assert.deepEqual(printfArguments('%% %s %d'),printfArguments('%2$d %1$s %%'));
 const r=await run([row('Привет {name}','Сәлем {player}','named'),row('%s %s','%s','printf')]);
 assert.equal(r.modules.placeholder_mismatch.findings,2);
});
test('nested ICU allows kk other-only and preserves all argument names',async()=>{
 const src='{n, plural, one {{name}: # машина} few {{name}: # машины} many {{name}: # машин} other {{name}: # машины}}';
 const dst='{n, plural, other {{name}: # көлік}}';
 const r=await run([row(src,dst)]);assert.equal(r.modules.plural_mismatch.findings,0);assert.equal(r.modules.placeholder_mismatch.findings,0);
 assert.deepEqual(analyzeMessage(dst).args,['n','name']);
});
test('ICU missing other, dropped plural, removed exact branches, and invalid locale category',async()=>{
 const src='{n, plural, =0 {Нет} other {# машин}}';
 const r=await run([row(src,'{n, plural, one {Бір}}','missing_other'),row(src,'{n}','lost_plural'),row(src,'{n, plural, other {# көлік}}','lost_exact'),row('{n, plural, other {# машин}}','{n, plural, few {# көлік} other {# көлік}}','few')]);
 assert.equal(r.modules.plural_mismatch.findings,4);
});
test('invalid source is diagnostic rather than blaming target',async()=>{
 const r=await run([row('{n, plural, one {x}}','Текст')]);assert.equal(r.modules.plural_mismatch.findings,0);assert.equal(r.diagnostics[0].kind,'source_message_parse_error');
});
test('suffix gate excludes ordinary words and fixed brand names',async()=>{
 const r=await run([row('Через 5 гонок','5 жарыстан кейін','a'),row('Кухня Grand Chicken','Grand Chicken ас үйі','b'),row('Игроку {name}','{name}-ға','c')]);
 assert.deepEqual(r.issues.filter(x=>x.issue_type==='suffix_harmony').map(x=>x.key),['c']);
});
test('glossary supports explicit inflected variants without substring matching',async()=>{
 const r=await run([row('Фракция','Топ','bad'),row('Фракция','Фракциясы','good'),row('Моя фракция','Тобым','sentence')],{terms:[{ru:'Фракция',kk:'Фракция',variants:['Фракциясы']}]});
 assert.deepEqual(r.issues.filter(x=>x.issue_type==='glossary_violation').map(x=>x.key),['bad']);
});
test('actual length constraint is separate from visual overflow hypothesis',async()=>{
 const r=await run([row('OK','Жалғастыру','button')],{config:{max_chars:{button:5}}});
 assert.equal(r.issues.find(x=>x.issue_type==='length_overflow').status,'constraint');
});
test('term variations are separate comparison groups, not findings',async()=>{
 const r=await run([row('Награда','Марапат','a'),row('Награда','Сыйлық','b')]);const found=r.issues.filter(x=>x.issue_type==='inconsistent_term');
 assert.equal(found.length,0);assert.equal(r.comparison_groups.length,1);assert.deepEqual(r.comparison_groups[0].rows.map(x=>x.key),['a','b']);assert.equal(r.modules.inconsistent_term.findings,0);
});
test('valid contextual translations of Хорошо are not flagged as errors',async()=>{
 const a={...row('Хорошо','Жарайды','confirm'),context:{section:'DIALOG',description:'Confirmation button',english:'OK'}};
 const b={...row('Хорошо','Жақсы','rating'),context:{section:'RATING',description:'Result rating',english:'Good'}};
 const r=await run([a,b,row('Хорошо','Жарайды','confirmAgain')],{checks:['inconsistent_term']});
 assert.equal(r.issues.length,0);assert.equal(r.comparison_groups.length,1);assert.equal(r.comparison_groups[0].rows.length,3);assert.equal(r.comparison_groups[0].rows[1].context.english,'Good');
 const disabled=await run([a,b],{checks:['placeholder_mismatch']});assert.equal(disabled.comparison_groups.length,0);
 const identical=await run([a,{...b,target:'Жарайды'}],{checks:['inconsistent_term']});assert.equal(identical.comparison_groups.length,0);
 const glossary=await run([a,b],{checks:['inconsistent_term','glossary_violation'],terms:[{ru:'Хорошо',kk:'Жарайды',key:'confirm'},{ru:'Хорошо',kk:'Жақсы',key:'rating'}]});assert.equal(glossary.issues.length,0);
 const mismatch=await run([{...a,target:'Бастау'},b],{checks:['inconsistent_term','glossary_violation'],terms:[{ru:'Хорошо',kk:'Жарайды',key:'confirm'}]});assert.equal(mismatch.issues.length,1);assert.equal(mismatch.issues[0].issue_type,'glossary_violation');
 assert.ok(htmlReport(r).includes('Confirmation button'));assert.ok(htmlReport(r).includes('Сравнить варианты'));
});
test('model evidence must quote inputs; malformed suggestions are discarded',()=>{
 const r=row('Привет {name}','Сәлем {name}');
 assert.throws(()=>validateReview({source_quote:'invented',target_quote:'Сәлем',reason:'x',verdict:'error',suggestion:null},r,'kk'));
 const valid=validateReview({source_quote:'Привет',target_quote:'Сәлем',reason:'x',verdict:'error',suggestion:'Сәлем {player}'},r,'kk');
 assert.equal(valid.suggestion,null);assert.equal(valid.suggestion_rejected,'structure_mismatch');
 assert.equal(validateSuggestion(row('<b>{name}</b>','x'),'Жақсы {name}','kk').reason,'markup_mismatch');
});
test('allowlisted source brand cannot hide an altered target',async()=>{
 const r=await run([row('GrandCoins','Save changes')],{config:{allow_unchanged:['GrandCoins']}});
 assert.equal(r.modules.wrong_language.deferred,1);
});
test('clear with evidence is conservatively uncertain, not a passed review',()=>{
 const r=validateReview({source_quote:'Текст',target_quote:'Мәтін',reason:'explanation',verdict:'clear',suggestion:null},row('Текст','Мәтін'),'kk');
 assert.equal(r.verdict,'uncertain');assert.equal(r.original_verdict,'clear');
});
test('router blocks model on missing/placeholder errors and reports deferred coverage',async()=>{
 const r=await run([row('Привет {name}','Сәлем {player}','broken'),row('Hello','Сәлем','normal')]);
 assert.equal(r.modules.machine_translation_suspect.skipped,1);assert.equal(r.modules.machine_translation_suspect.deferred,1);assert.equal(r.modules.wrong_language.skip_reasons.short_ambiguous_language,1);
});
test('model cannot assign a different issue category; failure is not a clean result',async()=>{
 const client={check:async()=>({review:{verdict:'error',reason:'test',source_quote:'A',target_quote:'B',suggestion:null}})};
 const r=await run([row('Текст один','Мәтін екі')],{checks:['orthography'],client});
 assert.equal(r.issues[0].issue_type,'orthography');
 const failure=await run([row('Текст','Мәтін')],{checks:['orthography'],client:{check:async()=>{throw Error('offline');}}});assert.equal(failure.modules.orthography.failed,1);assert.equal(failure.modules.orthography.assessed,0);
});
test('cache avoids repeated inference and budget is enforced',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'locqa-test-'));
 const request=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({source_quote:'',target_quote:'',reason:'No defect',verdict:'clear',suggestion:null})}}]})});
 const c=new QwenClient({endpoint:'http://127.0.0.1:8088/v1/chat/completions',modelRevision:'test',cacheDir:dir,maxCalls:1,request});
 const m=modules.find(x=>x.id==='orthography');
 const r=row('Текст','Мәтін');
 assert.equal((await c.check(m,r,'kk')).cached,false);assert.equal((await c.check(m,r,'kk')).cached,true);assert.equal(c.calls,1);
 assert.equal((await c.check(m,row('Другой','Басқа'),'kk')).deferred,true);
 // Temporary files are intentionally left in OS temp; no project inputs are removed.
});
test('HTML report escapes hostile localization content',async()=>{
 const r=await run([row('<script>alert(1)</script>','')]);const h=htmlReport(r);
 assert.ok(h.includes('&lt;script&gt;'));assert.ok(!h.includes('<script>'));
});
