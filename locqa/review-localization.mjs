import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {parseTree,getNodeValue} from 'jsonc-parser';
import {createHash} from 'node:crypto';
import {loadArb,makeRecords} from './src/arb.mjs';
import {withNeighborContext} from './src/neighbor-context.mjs';
import {applyReviewedMachineEdits} from './src/arb-edits.mjs';
import {auditDecisions} from './src/audit-decisions.mjs';
import {checkedTerms,reviewedExistingPairs} from './src/audit-glossary.mjs';
import {readGlossary,glossaryCsv,glossaryColumns} from './src/glossary.mjs';
import {norm} from './src/message.mjs';
import {checkRecords,modules} from './src/engine.mjs';
import {htmlReport,escapeHtml} from './src/report.mjs';
const {values:v}=parseArgs({options:Object.fromEntries(['source','target','reference','draft-report','shortlist','units','out-dir'].map(k=>[k,{type:'string'}]))});
for(const k of ['source','target','reference','draft-report','shortlist','units','out-dir'])if(!v[k])throw Error('Required --'+k);
const out=path.resolve(v['out-dir']);await fs.mkdir(path.dirname(out),{recursive:true});await fs.mkdir(out);
const [source,target,reference,text,draft,shortlist,units]=await Promise.all([loadArb(v.source),loadArb(v.target),loadArb(v.reference),fs.readFile(v.target,'utf8'),fs.readFile(v['draft-report'],'utf8').then(JSON.parse),fs.readFile(v.shortlist,'utf8').then(readGlossary),fs.readFile(v.units,'utf8').then(readGlossary)]);
const rows=withNeighborContext(makeRecords(source,target,reference)),byKey=new Map(rows.map(r=>[r.key,r]));
const checked=new Map();
for(const [ru,kk,en,variants,comment] of checkedTerms)checked.set(norm(ru),{ru,kk,en,variants,comment,status:'proposed',verification:'ru_en_context_crosscheck',reviewed_by_human:'false',reviewer:'',key:'',source_variants:[],match_mode:'exact'});
// Keep only reviewed main-list terms; quarantine phrases with unresolved grammar
// or conflicting Cash/game-currency meaning rather than treating frequency as proof.
const disputed=new Map([
 ['здоровье автомобиля','Согласовать термин прочности/состояния машины; буквальная «здоровье» не автоматически ошибка.'],
 ['оплатить бизнес','Проверить управление и реальный смысл оплаты бизнеса.'],
 ['пополнение баланса семьи','Проверить падежную конструкцию; не навязывать вариант без редакторской сверки.'],
 ['пополнение баланса фракции','Проверить падежную конструкцию.'],
 ['баланс игровой валюты','EN Cash balance и RU игровая валюта не вполне совпадают; требуется продуктовый контекст.']
]);
const attention=[];
for(const term of shortlist){
 if(checked.has(norm(term.ru)))continue;
 if(reviewedExistingPairs.some(([ru,kk])=>norm(ru)===norm(term.ru)&&norm(kk)===norm(term.kk))&&!disputed.has(norm(term.ru))&&term.kk?.trim())checked.set(norm(term.ru),{...term,en:[...new Set(term.en.split('|').map(x=>x.trim()).filter(Boolean))].join(' | '),status:'proposed',reviewed_by_human:'false',reviewer:'',verification:'ru_en_context_crosscheck',comment:term.comment+' Сверено как допустимый существующий вариант, не носителем; падежи определяются предложением.',variants:term.variants??[],source_variants:[],match_mode:'exact'});
 else attention.push({...term,status:'proposed',reviewed_by_human:'false',reviewer:'',verification:'unresolved',comment:[term.comment,disputed.get(norm(term.ru))].filter(Boolean).join(' ')});
}
// Preserve independently confirmed, key-scoped unit abbreviations.
const glossary=[...checked.values(),...units.map(u=>({...u,verification:'user_confirmed_key_scope',reviewed_by_human:'true'}))];
const bet=glossary.find(t=>norm(t.ru)==='ставка');Object.assign(bet,{match_mode:'phrase',source_variants:['ставки','ставок','ставку','ставке','ставкой','ставками']});
const columns=[...glossaryColumns,'source_variants','match_mode','verification','reviewed_by_human'];
await fs.writeFile(path.join(out,'glossary.csv'),glossaryCsv(glossary,columns));
await fs.writeFile(path.join(out,'glossary_needs_review.csv'),glossaryCsv(attention,[...columns,'recommended_kk','review_explanation','review_context','review_context_groups','shortlist_attention_flags']));
const decisions=new Map();
for(const c of draft.changes){
 const row=byKey.get(c.key);if(row?.source!==c.source||row.target!==c.before)throw Error('Prior draft does not match current source '+c.key);
 decisions.set(c.key,{key:c.key,after:c.after,before:c.before,type:c.type,reason:c.reason,previous_draft:true});
}
for(const [key,after,type,reason] of auditDecisions){
 const row=byKey.get(key);if(!row)throw Error('Missing audit key '+key);
 decisions.set(key,{key,after,before:row.target,type,reason,previous_draft:decisions.has(key)});
}
const edited=applyReviewedMachineEdits(text,source,[...decisions.values()]);
const fixedRows=withNeighborContext(makeRecords(source,edited.parsed,reference));
const changes=edited.changes.map(c=>({...c,ru:c.source,en:byKey.get(c.key).context.english,context:byKey.get(c.key).context,verification:'ru_en_context_crosscheck',native_review:false}));
await fs.writeFile(path.join(out,'intl_kk_fixed.arb'),edited.text);
const config={include_machine_validated_glossary:true,allow_unchanged:['АКТ {competition}']};
await fs.writeFile(path.join(out,'validation-config.json'),JSON.stringify(config,null,2));
const before=await checkRecords(rows,{terms:glossary,config}),after=await checkRecords(fixedRows,{terms:glossary,config});
let singleQuality=[];try{singleQuality=JSON.parse(await fs.readFile('locqa/private-results/full-audit-2026-10-31/single-check-quality.json','utf8'));}catch{}
let singleQualityAfter=[];try{singleQualityAfter=JSON.parse(await fs.readFile('locqa/private-results/full-audit-2026-10-31/single-check-quality-after.json','utf8'));}catch{}
let qualityGate=null;try{qualityGate=JSON.parse(await fs.readFile('locqa/private-results/full-audit-2026-10-31/language-before-complete.json','utf8')).quality_gate??null;}catch{}
let batch={rows:{},status:'not_started'};try{batch=JSON.parse(await fs.readFile('locqa/private-results/full-audit-2026-10-31/language-before.json','utf8'));}catch{}
const falsePositives=[];
for(const row of rows){
 if(norm(row.source)!==norm(row.target??'')||!row.target?.trim())continue;
 const allowed=glossary.find(t=>norm(t.ru)===norm(row.source)&&norm(t.kk)===norm(row.target)&&(!t.key||t.key===row.key));
 if(allowed)falsePositives.push({key:row.key,ru:row.source,en:row.context.english,kk:row.target,type:'same_as_source',resolution:'acceptable_shared_term_or_name',reason:allowed.comment,reviewed_by_human:false});
}
const specificUnresolved=[
 ['inventoryEquipped@description','Возможное служебное описание, а не пользовательская строка. Английский текст и нестандартное имя с @ сохранены; уточнить роль поля в ARB/Flutter.'],
 ...['legendary','birthday_camp_one_combo_legend','birthday_store_legend'].map(k=>[k,'Краткая подпись редкости «аңыз»: номинальный ярлык может быть продуктовым решением. Без согласования не заменён ради стилистики.']),
 ['currencyRub','Нестандартная игровая аббревиатура қ.қ.а.; без определения валюты нельзя заменить на тенге или рубль.'],
 ['drag_next_races_after','Подтверждено добавление минут и потеря смысла 5 гонок, но исправление короткого таймерного фрагмента требует схемы сборки UI. Рекомендуемый смысл: «дополнительные 5 гонок через указанное время».'],
 ...['rosticsAcceptWorkDesc','rosticsAcceptWorkDesc1','rosticsAcceptWorkDesc3'].map(k=>[k,'Согласовать три стилизованных фрагмента как одно предложение. Отдельная замена «Табыс» без порядка сборки может сломать грамматику.']),
 ...['piggyGetBy','bigCatchFishActivityInfoPrefix','containersDatetime','dragRacingLevelUpgradeTitle1','festivalGameConfirmTargetPrefix'].map(k=>[k,'Составная фраза/таймер: отсутствие отдельного фрагмента может быть оправдано порядком слов. Нужны место вставки и связанный интерфейс.']),
 ...['predictionsBuyCoinsMinError','predictionsBuyCoinsMaxError','wheelOfFortuneBuyFor','userMenuReportsFromTo'].map(k=>[k,'Окончание после динамического значения — риск, а не доказанная ошибка для всех значений. Уточнить тип аргумента и диапазон значений или согласовать переформулировку.']),
 ...['slot_machine_diamonds','slot_machine_crowns','slot_machine_bells'].map(k=>[k,'Добавлено число 2, отсутствующее в RU/EN; проверить, не собирается ли количество отдельным фрагментом интерфейса.'])
];
const unresolved=specificUnresolved.map(([key,reason])=>({key,...byKey.get(key),reason,status:'needs_context',reviewed_by_human:false}));
for(const d of target.diagnostics.filter(d=>d.kind==='duplicate_key'&&new Set(d.values.map(v=>v.value)).size>1&&!decisions.has(d.key)))unresolved.push({key:d.key,type:'duplicate_key',reason:'Повторные вхождения содержат разные варианты. Все сохранены; требуется согласовать, как игра обрабатывает дубликаты.',values:d.values,status:'needs_context'});
for(const issue of after.issues)if(!unresolved.some(x=>x.key===issue.key))unresolved.push({...issue,en:byKey.get(issue.key)?.context.english,status:'candidate_not_confirmed',reason:issue.evidence});
const changedKeys=new Set(changes.map(x=>x.key));
const modelCoverage={status:'quality_gate_failed_full_scan_incomplete',model:'Qwen3-8B-Q4_K_M',batch_rows_attempted:Object.keys(batch.rows).length,batch_assessed:Object.values(batch.rows).filter(r=>r.status==='assessed').length,batch_false_negative_examples:['donate_to_mail','repeat','jungleTreasuresRecieveImmediately'].filter(k=>batch.rows[k]?.status==='assessed'&&!batch.rows[k].issues?.length),quality_gate:qualityGate,single_detector_checks:singleQuality.map(x=>({key:x.key,check:x.check,verdict:x.review?.verdict??'failed',request_hash:x.request_hash,error:x.error})),single_detector_after_checks:singleQualityAfter.map(x=>({key:x.key,check:x.check,verdict:x.review?.verdict??'failed',request_hash:x.request_hash,error:x.error})),total_unique_keys:rows.length,note:'Пакетная проверка пропустила известные ошибки и повторно не прошла контроль качества, поэтому её clear не считается подтверждением корректности. Единичные результаты до/после и исходные ответы сохранены. Полная проверка Qwen всех строк не завершена.'};
const typeCounts=Object.fromEntries(modules.map(m=>[m.id,changes.filter(c=>c.type===m.id).length]));
const summary={status:'corrected_machine_crosschecked_native_review_pending',full_language_review_completed:false,unique_keys_corrected:changedKeys.size,occurrences_corrected:changes.reduce((n,c)=>n+c.occurrences_changed,0),corrections_by_primary_type:typeCounts,previous_draft_keys_rechecked:draft.changes.length,glossary_terms:glossary.length,unresolved_glossary_terms:attention.length,false_positive_candidates_dismissed:falsePositives.length,before_findings:before.issues.length,after_findings:after.issues.length,unresolved_records:unresolved.length,placeholder_mismatches:after.modules.placeholder_mismatch.findings,icu_mismatches:after.modules.plural_mismatch.findings,missing_or_empty:after.modules.untranslated.findings,duplicate_message_keys_preserved:edited.parsed.diagnostics.filter(d=>d.kind==='duplicate_key').length,native_review_performed:false,flutter_gen_l10n_verified:false,model_coverage:modelCoverage};
const report={...after,summary,changes,false_positives:falsePositives,unresolved,all_checks_enabled:modules.map(m=>m.id),before_modules:before.modules,provenance:{source:{file:v.source,sha256:source.sha256},original_target:{file:v.target,sha256:target.sha256},target:{file:'intl_kk_fixed.arb',sha256:edited.parsed.sha256},reference:{file:v.reference,sha256:reference.sha256},created_at:new Date().toISOString(),glossary_policy:'4 user-approved units plus explicitly opted-in machine-validated terms; no native approval',full_icu_flutter_validation:false},diagnostics:[...after.diagnostics,...source.diagnostics.map(x=>({...x,file:'source'})),...edited.parsed.diagnostics.map(x=>({...x,file:'target'}))],model_evidence:{before:singleQuality,after:singleQualityAfter}};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
await fs.writeFile(path.join(out,'unresolved.json'),JSON.stringify({cases:unresolved,glossary_terms:attention,model_coverage:modelCoverage,not_fully_reviewed_keys:rows.filter(r=>!singleQuality.some(x=>x.key===r.key&&x.review)).map(r=>r.key)},null,2));
await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
const e=escapeHtml;
const changesHtml=`<h2>Исправленные ключи: ${changes.length}</h2><table><tr><th>Ключ / тип</th><th>RU / EN</th><th>Было</th><th>Стало</th><th>Причина</th></tr>${changes.map(c=>`<tr><td>${e(c.key)}<br>${e(c.type)}</td><td>${e(c.ru)}<hr>${e(c.en)}</td><td>${e(c.before??'(нет ключа)')}</td><td>${e(c.after)}</td><td>${e(c.reason)}</td></tr>`).join('')}</table>`;
const warning='<p style="padding:20px;background:#fff1df;border:2px solid #b76c20"><b>Проверка носителем не выполнена. Полный прогон языковых проверок Qwen не завершён.</b> Пакетные ответы модели содержат ложные отрицания и не используются как доказательство отсутствия ошибок. Все изменения reviewed_by_human=false. См. summary.json и unresolved.json.</p>';
await fs.writeFile(path.join(out,'report.html'),htmlReport(report).replace('<h1>Qazaq Loc QA</h1>','<h1>Qazaq Loc QA</h1>'+warning+changesHtml));
const csvColumns=['key','type','ru','en','before','after','reason','occurrences_changed','reviewed_by_human'];
await fs.writeFile(path.join(out,'changes.csv'),glossaryCsv(changes,csvColumns));
const quote=x=>String(x??'').replaceAll('|','\\|').replaceAll('\n',' ↵ ');
await fs.writeFile(path.join(out,'SUMMARY.md'),`# Результат повторной проверки\n\nИсправлено уникальных ключей: **${changes.length}**. Все изменения проверены автоматически и сопоставлены с RU/EN и соседями; **проверка носителем не выполнена**.\n\nВсе 11 модулей включены. 8 кодовых модулей обработали весь набор по применимости; 3 языковых модуля Qwen не покрыли весь файл. Реальное покрытие и ложные отрицания модели приведены в summary.json. Нельзя считать этот результат полной гарантией отсутствия оставшихся ошибок.\n\n| Тип | Исправлено |\n|---|---|\n${Object.entries(typeCounts).map(([k,n])=>'| '+k+' | '+n+' |').join('\n')}\n\nПлейсхолдеры после исправлений: ${summary.placeholder_mismatches} несовпадений. ICU: ${summary.icu_mismatches}. Пропущенные/пустые строки: ${summary.missing_or_empty}; спорные составные фрагменты не заполнены автоматически. Все ${summary.duplicate_message_keys_preserved} группы дублирующихся ключей и все @@comment сохранены. JSON валиден; Flutter SDK отсутствует, gen-l10n не проверен.\n\nГлоссарий: ${glossary.length} записей; ${attention.length} требуют дополнительной проверки. Машинно сверенные термины имеют status=proposed, verification=ru_en_context_crosscheck, reviewed_by_human=false. Они активируются в проверках только явным config.include_machine_validated_glossary=true. Четыре обозначения времени имеют отдельное прежнее подтверждение пользователя. Формы слов учитываются явными вариантами; неизвестные склонения остаются кандидатами, глобального морфологического анализатора нет.\n\nИсходные файлы не перезаписаны. Предыдущие ${draft.changes.length} исправлений перепроверены. Спорные случаи: unresolved.json. Полный журнал ключей: changes.csv и report.html.\n`);
const inputPairs=parseTree(text.replace(/^\uFEFF/,'')).children.map(n=>[n.children[0].value,getNodeValue(n.children[1])]);
const outputPairs=parseTree(edited.text).children.map(n=>[n.children[0].value,getNodeValue(n.children[1])]);
for(const [key,value] of inputPairs){if(changedKeys.has(key)||key.startsWith('@')&&changedKeys.has(key.slice(1)))continue;const a=inputPairs.filter(x=>x[0]===key),b=outputPairs.filter(x=>x[0]===key);if(JSON.stringify(a)!==JSON.stringify(b))throw Error('Unrelated property or duplicate changed '+key);}
if(summary.placeholder_mismatches||summary.icu_mismatches)throw Error('Structural regression remains');
const hashes={};for(const name of await fs.readdir(out))hashes[name]=createHash('sha256').update(await fs.readFile(path.join(out,name))).digest('hex');
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({source_sha256:source.sha256,original_target_sha256:target.sha256,reference_sha256:reference.sha256,files:hashes},null,2));
console.log(JSON.stringify({directory:out,...summary},null,2));
