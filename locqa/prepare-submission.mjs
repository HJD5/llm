// Prepare reviewable deliverables. This command never fabricates native review.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {parseTree,getNodeValue,modify,applyEdits} from 'jsonc-parser';
import {loadArb,parseArb,makeRecords} from './src/arb.mjs';
import {parseDraft} from './src/glossary-review.mjs';
import {readGlossary,glossaryCsv} from './src/glossary.mjs';
import {validateSuggestion} from './src/message.mjs';
import {checkRecords} from './src/engine.mjs';
import {htmlReport} from './src/report.mjs';
const {values:v}=parseArgs({options:Object.fromEntries(['source','target','reference','shortlist','units','out-dir'].map(k=>[k,{type:'string'}]))});
for(const k of ['source','target','reference','shortlist','units','out-dir'])if(!v[k])throw Error('Required --'+k);
const out=path.resolve(v['out-dir']);
// A fresh directory protects every earlier reviewed delivery and its evidence.
await fs.mkdir(path.dirname(out),{recursive:true});await fs.mkdir(out);
const [source,target,reference,targetText,shortlist,units]=await Promise.all([loadArb(v.source),loadArb(v.target),loadArb(v.reference),fs.readFile(v.target,'utf8'),fs.readFile(v.shortlist,'utf8').then(parseDraft),fs.readFile(v.units,'utf8').then(readGlossary)]);
const records=makeRecords(source,target,reference),byKey=new Map(records.map(r=>[r.key,r]));
const needsContext=new Map([
 ['Здоровье автомобиля','Буквальное «здоровье автомобиля»: уточнить принятый термин состояния/прочности машины.'],
 ['Оплатить бизнес','Проверить казахскую конструкцию оплаты и управление существительным.'],
 ['Пополнение баланса семьи','Проверить падеж и конструкцию пополнения баланса.'],
 ['Пополнение баланса фракции','Проверить падеж и конструкцию пополнения баланса.'],
 ['баланс игровой валюты','EN указывает Cash balance; согласовать наличные и игровую валюту.'],
 ['Выбери автомобиль:','EN quests/vehicle/UI контекст: проверить название транспорта и форму обращения.']
]);
const main=[],attention=[];
for(const original of shortlist.rows){
 const extra=needsContext.get(original.ru);
 const row={...original,comment:[original.comment,extra].filter(Boolean).join(' '),status:'proposed',reviewer:'',reviewed_by_human:'false',review_status:'needs_native_review'};
 if(original.shortlist_group==='existing_translation'&&!extra)main.push(row);else attention.push(row);
}
for(const u of units)main.push({...u,variants:u.variants??[],reviewed_by_human:'true',review_status:'confirmed_by_user',reviewer:u.reviewer||'user',comment:u.comment+' Подтверждено пользователем для указанного ключа; квалификация носителя не проверялась.'});
const simple=['ru','kk','en','comment','status','key','category','variants','related_keys','reviewed_by_human','review_status','reviewer'];
await fs.writeFile(path.join(out,'glossary.csv'),glossaryCsv(main,simple));
const reviewColumns=[...simple,...shortlist.columns.filter(k=>!simple.includes(k))];
await fs.writeFile(path.join(out,'glossary_needs_review.csv'),glossaryCsv(attention,reviewColumns));

const changes=[];
function propose(key,translation,type,reason){
 const row=byKey.get(key);if(!row)throw Error('Unknown key '+key);
 if(row.target===translation)return;
 if(target.diagnostics.some(d=>d.kind==='duplicate_key'&&d.key===key))throw Error('Ambiguous duplicate change '+key);
 const checked=validateSuggestion(row,translation,'kk');if(checked.reason)throw Error(key+': '+checked.reason);
 changes.push({key,source:row.source,english:row.context.english,before:row.target,after:translation,type,reason,reviewed_by_human:false,review_status:'needs_native_review',prepared_by:'Codex'});
}
// Restore only the broken argument tokens; retain the existing wording.
for(const [key,from,to] of [
 ['birthday_main_updates_in','time','{time}'],
 ['arena_platform_colorname','{platformColo}','{platformColor}'],
 ['dragRacingV2BuyDesc1','blueprintTitle','{blueprintTitle}'],
 ['predictionsBuyCoinsMinError','min','{min}'],
 ['rustoreOfferBuyFor','price','{price}'],
 ['chaosUpgradeText','upgradeTitle','{upgradeTitle}'],
 ['schAssignmentTrainerIntro','books','{books}'],
 ['schGiftPassConfirmQuestion','name','{name}'],
 ['schPassRewardLevelRequired','{leve}','{level}'],
 ['schStoreCasePossiblePrizes','title','{title}'],
 ['schTutorialT2S1','playerTeamText','{playerTeamText}']
]){
 const text=byKey.get(key)?.target;if(typeof text!=='string'||text.split(from).length!==2)throw Error('Expected one broken argument in '+key);
 propose(key,text.replace(from,to),'placeholder_mismatch','Восстановлено имя аргумента/фигурные скобки из RU; остальная формулировка сохранена.');
}
propose('schDuelsPointsAmount','{points} ҰПАЙ','placeholder_mismatch','Возвращён потерянный счётчик points.');
for(const key of ['battlepass_cancel','jungleTreasuresCancel','expedition_cancel','expeditionMapCancel','summerRushRaceCancel']){
 if(byKey.get(key)?.target!=='БАСТАУ')throw Error('Unexpected cancel translation '+key);
 propose(key,'БОЛДЫРМАУ','machine_translation_suspect','RU/EN означают отмену; БАСТАУ означает начало. Предложено согласовать с существующей кнопкой cancel. Требуется проверить регистр и термин у носителя.');
}
for(const [key,text] of Object.entries({
 laAccountEmptyHelpTopText1:'Мұнда кейіпкерлеріңіздің\nстатистикасы көрсетіледі',
 laYouNeedToLinkThisSocialNetworkToAccount:'Бұл әлеуметтік желіні аккаунтыңызға байланыстыруыңыз қажет',
 inventory:'Инвентарь',
 invDisassemble:'БӨЛШЕКТЕУ',
 tablet_auc_all_your_bets:'Барлық бәстеріңіз',
 bankConfirmApartment:'Сіз шынымен жылжымайтын мүлікке төлем жасағыңыз келе ме: Пәтер\nсомасы',
 newYearInfoDesc2:'Тапсырмаларды орындап, Маусымдық рұқсатнама тәжірибесін және мұзкәмпиттерді алуға болады.\n\nКүнделікті тапсырмалар күн сайын жаңарады. Оларды арнайы бустер арқылы да жаңартуға болады.\n\nМаусымдық рұқсатнаманы сатып алғанда арнайы тапсырмаларға да қол жеткізесіз.',
 bigCatchTournamentsVictories:'Турнирлердегі жеңістер',
 bigCatchStoryLineSkipTimer:'Таймерді өткізіп жіберу',
 inventoryMailSubsectionLeftHand:'Сол қол',
 predictionsBetsPossibleReward:'Ықтимал ұтыс'
})){
 if(byKey.get(key)?.target!==null)throw Error('Expected missing target '+key);
 propose(key,text,'untranslated','Черновой перевод отсутствующего значения по RU/EN. Носителю нужно проверить естественность и игровую терминологию.');
}
const unresolved=['piggyGetBy','bigCatchFishActivityInfoPrefix','containersDatetime','dragRacingLevelUpgradeTitle1','festivalGameConfirmTargetPrefix'].map(key=>({...byKey.get(key),reason:'Составной UI-фрагмент: порядок слов/пустое значение могут зависеть от соседних частей и сборки интерфейса. Нужна проверка носителем вместе с соседними ключами.'}));

let fixed=targetText.replace(/^\uFEFF/,'');
for(const c of changes){
 const key='@'+c.key;
 const tree=parseTree(fixed);if(tree.children.filter(n=>n.children[0].value===key).length>1)throw Error('Duplicate metadata '+key);
 const existing=tree.children.find(n=>n.children[0].value===key),metadata=existing?getNodeValue(existing.children[1]):(c.before===null?source.metadata.get(key)??{}:{});
 if(!metadata||Array.isArray(metadata)||typeof metadata!=='object')throw Error('Invalid metadata '+key);
 for(const [k,value] of [[c.key,c.after],[key,{...metadata,reviewed_by_human:false,locqa_review:{status:'needs_native_review',prepared_by:'Codex',issue_type:c.type}}]])fixed=applyEdits(fixed,modify(fixed,[k],value,{formattingOptions:{insertSpaces:true,tabSize:2}}));
}
const parsedFixed=parseArb(fixed),fixedRecords=makeRecords(source,parsedFixed,reference);
// Verify all intended changes, preserve every unrelated value and duplicate.
for(const [key,entry] of target.entries){const c=changes.find(x=>x.key===key);if(parsedFixed.entries.get(key)?.value!==(c?c.after:entry.value))throw Error('Unexpected value change '+key);}
if(parsedFixed.diagnostics.filter(d=>d.kind==='duplicate_key').length!==target.diagnostics.filter(d=>d.kind==='duplicate_key').length)throw Error('Duplicates were lost');
for(const c of changes){if(parsedFixed.metadata.get('@'+c.key).reviewed_by_human!==false)throw Error('Invented human approval');}
const before=await checkRecords(records,{terms:units}),report=await checkRecords(fixedRecords,{terms:units});
if(report.modules.placeholder_mismatch.findings!==0)throw Error('Placeholder corrections are incomplete');
if(report.modules.plural_mismatch.findings>before.modules.plural_mismatch.findings)throw Error('New ICU mismatch');
report.provenance={source:{file:v.source,sha256:source.sha256},target:{file:'intl_kk_fixed.arb',sha256:parsedFixed.sha256},input_target_sha256:target.sha256,glossary:'glossary.csv; only 4 user-confirmed unit rules active',created_at:new Date().toISOString(),full_icu_flutter_validation:false};
report.delivery_status='draft_needs_native_review';report.changes=changes;report.unresolved_fragments=unresolved;report.model_calls=0;report.cache_hits=0;
await fs.writeFile(path.join(out,'intl_kk_fixed.arb'),fixed);
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
const banner=`<div style="background:#fff1df;border:2px solid #b76c20;padding:20px;margin:20px 0"><strong>DRAFT / NEEDS NATIVE REVIEW</strong><p>${changes.length} proposed changes; reviewed_by_human=false. Native-speaker review and Flutter gen-l10n have not been completed. See REVIEW.md.</p></div>`;
await fs.writeFile(path.join(out,'report.html'),htmlReport(report).replace('<h1>Qazaq Loc QA</h1>','<h1>Qazaq Loc QA</h1>'+banner));
const quote=s=>String(s??'').replaceAll('|','\\|').replaceAll('\n',' ↵ ');
const review=['# Проверка подготовленных исправлений','', '**Статус: черновик, требуется проверка носителем.** У всех изменённых строк в ARB reviewed_by_human=false. Нельзя сдавать как подтверждённый носителем файл.', '', '| Ключ | RU | Было KK | Предлагается KK | Причина |','|---|---|---|---|---|',...changes.map(c=>'| '+[c.key,c.source,c.before??'(нет ключа)',c.after,c.reason].map(quote).join(' | ')+' |'),'','## Неразрешённые составные фрагменты','',...unresolved.map(r=>'- '+r.key+': '+quote(r.source)+' → '+quote(r.target??'(нет ключа)')),'','Для проверки открыть соседние ключи и реальное место в интерфейсе; не заполнять пустые фрагменты автоматически.',''];
await fs.writeFile(path.join(out,'REVIEW.md'),review.join('\n'));
const hashes={};for(const name of ['glossary.csv','glossary_needs_review.csv','intl_kk_fixed.arb','report.json','report.html','REVIEW.md'])hashes[name]=createHash('sha256').update(await fs.readFile(path.join(out,name))).digest('hex');
const summary={status:'draft_needs_native_review',main_glossary:main.length,main_user_confirmed:units.length,needs_review:attention.length,arb_changes:changes.length,change_types:Object.fromEntries([...new Set(changes.map(c=>c.type))].map(k=>[k,changes.filter(c=>c.type===k).length])),remaining_findings:report.issues.length,remaining_missing:report.modules.untranslated.findings,placeholder_mismatches:report.modules.placeholder_mismatch.findings,icu_mismatches:report.modules.plural_mismatch.findings,native_review_performed:false,flutter_gen_l10n_verified:false,source_sha256:source.sha256,input_target_sha256:target.sha256,files:hashes};
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(summary,null,2));
await fs.writeFile(path.join(out,'README.md'),`# Комплект для проверки\n\nСтатус: ЧЕРНОВИК, требуется проверка носителем казахского.\n\n- glossary.csv: ${main.length} записей основного списка, из них только ${units.length} обозначения времени подтверждены пользователем. Остальные proposed.\n- glossary_needs_review.csv: ${attention.length} спорных/неполных терминов с вариантами, контекстом и объяснениями.\n- intl_kk_fixed.arb: ${changes.length} подготовленных исправлений. У каждой изменённой строки reviewed_by_human=false и locqa_review.status=needs_native_review.\n- REVIEW.md: точные изменения для проверки.\n- report.json/report.html: повторный анализ исправленного черновика; языковой прогон Qwen не выполнялся.\n- manifest.json: объём изменений, статус и хеши файлов.\n\nНи одна строка не объявлена проверенной носителем. Структурные исправления проверены автоматически; полная языковая корректность не подтверждена. Составные пустые фрагменты оставлены для контекстной проверки. Найденные дубликаты сохранены, поэтому файл ещё требует отдельного разбора дубликатов. Flutter gen-l10n не запускался: SDK не найден. После проверки человек должен одобрить/исправить точные тексты; финальный экспорт следует формировать штатным процессом Human Review, сохранив имя и дату решения.\n`);
console.log(JSON.stringify({directory:out,...summary},null,2));
