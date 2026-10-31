import {isDeepStrictEqual} from 'node:util';
import {norm} from './message.mjs';
import {contextPolicy,canonicalProperName,validateKkCandidate,glossaryList} from './glossary-validation.mjs';

const clean=value=>norm(value??'').replace(/[.!?:;…]+$/u,'').trim();
const roots=new Set(['фракция','семья','клан','бизнес','бизнесы','уровень','ранг','опыт','опыта','репутация','инвентарь','оружие','боеприпасы','броня','здоровье','гараж','транспорт','автомобили','скины','аксессуары','одежда','ресурсы','кейсы','бустеры','энергия','магазин','баланс','наличные','валюта','игровая валюта','награда','награды','рейтинг','лидерборд','задания','арена','дуэли','гонки','квартира','дом','склад','лицензия','варн','мут','бан','навык','донат']);
const uiTerms=new Set(['профиль','отмена','продолжить','назад','далее','пропустить','подтвердить','выбрать','выбрано','создать','удалить','обновить','принять','открыть','закрыть','начать','старт','играть','настройки','главная','карта','доступно','недоступно','получено','приобретено','куплено','выполнено','осталось','получить','забрать','купить','продать','подарить','пополнить','разблокировать','активировать','снять','понятно','пусто','да','нет','в сети','в процессе','выход','сохранить']);
for(const term of ['магазин','профиль','отмена','выбрать','подтвердить','продолжить','назад','настройки','купить','продать','получить','забрать','пополнить','редкий','легендарный','обычный'])roots.add(term);
for(const term of ['баланс семьи','баланс фракции','сейф семьи','права фракции','фракционные права'])roots.add(term);
uiTerms.add('магазин');
const caps={ui:32,economy:22,progression:14,rewards:8,social:16,vehicles:22,inventory:22,activities:18};

function domain(ru){
  const key=clean(ru);
  if(key==='бизнес класс')return 'vehicles';
  if(/фракц|семь[яиюе]|семейн|клан|состав семьи|сейф семьи|жалоб|организац|мут|варн|(?:^|\s)бан(?:\s|$)/iu.test(key))return 'social';
  if(/награ|приз/iu.test(key))return 'rewards';
  if(/уров|ранг|(?<!\p{L})опыт|репутац|задани|квест|рейтинг|лидерборд|навык/iu.test(key))return 'progression';
  if(/авто|машин|транспорт|гараж|гос\.? номер|двигател|трансмисс|тормоз|подвес|нитро|турбо|гидравл|дрифт|тюнинг|фар|скорост|привод|топлив|закись азота/iu.test(key))return 'vehicles';
  if(/инвентар|оруж|боеприпас|брон|здоров|ресурс|кейс|бустер|скин|аксессуар|одежд|предмет|ячейк|склад|билет|алмаз|металл|маска|(?:^|\s)ключ|энерги|редк|легендар|обычн|эпич/iu.test(key))return 'inventory';
  if(/бизнес|баланс|валют|налич|банк|цен[ауы]|стоимост|скидк|монет|копилк|продаж|сумма пополн|владелец|обмен|купить|продать|подарить|пополнить|приобретено|куплено/iu.test(key))return 'economy';
  if(/гонк|арен[ад]|дуэл|работ[аыу]|професси|контрабанд|ограб|розыск|тюр[ье]м|полиц|дом|квартир|активност|колесо|лицензи/iu.test(key))return 'activities';
  return uiTerms.has(key)?'ui':null;
}
function parseJson(text,fallback){try{return text?JSON.parse(text):fallback;}catch{throw Error('Malformed review JSON metadata');}}
function allContexts(row){
  return [...parseJson(row.review_context,[]),...parseJson(row.review_context_groups,[]).flatMap(g=>g.keys.map(key=>({key,en:g.english,kk:g.kk})))];
}
function attention(row,original,contexts){
  const flags=[];
  if(!row.kk.trim())flags.push('empty_kk');
  if(contextPolicy(original,contexts).requires_key_scope||row.review_requires_key_scope==='true')flags.push('requires_key_scope');
  if(glossaryList(row.review_flags).includes('conflicting_translations'))flags.push('conflicting_translations');
  if(row.review_state!=='reviewed')flags.push('not_llm_reviewed');
  else if(row.review_verdict!=='keep')flags.push('model_'+row.review_verdict);
  if(row.review_validation_flags)for(const flag of glossaryList(row.review_validation_flags))if(!['established_vocabulary_preserved'].includes(flag))flags.push(flag);
  if(row.kk.trim())flags.push(...validateKkCandidate(original,row.kk,{contexts}).issues.map(flag=>'existing_'+flag));
  if(row.recommended_kk?.trim())flags.push(...validateKkCandidate(original,row.recommended_kk,{contexts}).issues.map(flag=>'recommendation_'+flag));
  if(row.kk!==row.kk.trim()||/\s{2,}/u.test(row.kk))flags.push('existing_formatting');
  if(/[\n\r]/u.test(row.kk))flags.push('existing_line_break');
  if(/^(?:опыта|монет|ячеек|дней)$/iu.test(row.ru.trim()))flags.push('inflected_source_form');
  return [...new Set(flags)];
}
function exclusion(row){
  const ru=row.ru.trim();
  if(!/\p{L}/u.test(ru)||/[{}<>%\n\r\p{Co}]/u.test(ru)||/https?:\/\/|www\./iu.test(ru))return 'technical_or_unsuitable';
  if(canonicalProperName({ru})||/^(?:brand|proper_name|person_name|имя собственное)$/iu.test(row.category??''))return 'proper_name_not_glossary_concept';
  if(/\d/u.test(ru))return 'numbered_instance';
  if(ru.length>45||ru.split(/\s+/u).length>4)return 'long_generic_phrase';
  if(ru.split(/\s+/u).length>=4&&/^(?:выберите|выбери|нажмите|вы должны)\s/iu.test(ru))return 'long_ui_instruction';
  if(/^(?:вы действительно|вы уверены|поздравля|у вас|вам |ты |твой |твоя |ваш[аи]? |ваша |твои |получи |получай |прокачай |как |и |все |все$)/iu.test(ru))return 'boilerplate_or_sentence';
  if(/громк|зву[кч]|блюм|блум|яркост|график|текстур|прорисов/iu.test(ru))return 'generic_settings_phrase';
  if(/^(?:награда за|игровую[- ]валюту|уровней наград)$/iu.test(ru)||/[,—]/u.test(ru))return 'sentence_fragment';
  return null;
}
function duplicateKey(row){
  const en=[...new Set(glossaryList(row.en).map(clean))].sort();
  return JSON.stringify([clean(row.ru),clean(row.kk),en,row.key??'']);
}

export function buildShortlist(draft,review,{records=[],target=120}={}){
  if(!Number.isSafeInteger(target)||target<1||target>10000)throw Error('Invalid shortlist target');
  if(draft.rows.length!==review.rows.length)throw Error('Draft and review row counts differ');
  const originals=new Map();for(const row of draft.rows){const key=JSON.stringify(row);const item=originals.get(key)??{row,count:0};item.count++;originals.set(key,item);}
  const bySource=new Map();
  for(const r of records){const key=norm(r.source);if(!bySource.has(key))bySource.set(key,[]);bySource.get(key).push(r);}
  const candidates=[],excluded=[],seenIds=new Set();
  for(const row of review.rows){
    if(!row.review_id||seenIds.has(row.review_id))throw Error('Missing or duplicate review_id');seenIds.add(row.review_id);
    const original=parseJson(row.original_json,null);
    const match=originals.get(JSON.stringify(original));
    if(!match||match.count<1||!isDeepStrictEqual(match.row,original)||row.ru!==original.ru||row.kk!==original.kk)throw Error('Review does not match the original draft: '+row.review_id);
    match.count--;
    const savedContexts=allContexts(row),metadataKeys=[...new Set([row.key,...glossaryList(row.related_keys)].filter(Boolean))];
    const occurrences=(bySource.get(norm(row.ru))??[]).filter(r=>!row.key||r.key===row.key);
    const keys=occurrences.length?[...new Set(occurrences.map(r=>r.key))]:metadataKeys;
    const frequency=keys.length;
    let reason=exclusion(row),category=domain(row.ru);
    if(!reason&&!category)reason='low_priority_generic_or_catalog_item';
    if(!reason&&category==='ui'&&frequency<2&&clean(row.ru)!=='профиль')reason='infrequent_generic_ui';
    if(reason){excluded.push({id:row.review_id,reason,source:row});continue;}
    const currentContexts=occurrences.map(r=>({key:r.key,ru:r.source,kk:r.target,en:r.context?.english??'',section:r.context?.section??'',description:r.context?.description??''}));
    const contexts=[...savedContexts,...currentContexts];
    const flags=attention(row,original,contexts);
    if(occurrences.length&&keys.some(key=>!metadataKeys.includes(key)))flags.push('additional_arb_context');
    if(occurrences.length&&metadataKeys.some(key=>!keys.includes(key)))flags.push('arb_key_no_longer_matches');
    const ready=flags.length===0;
    const wordCount=row.ru.trim().split(/\s+/u).length;
    const score=(roots.has(clean(row.ru))?100:40)+Math.round(Math.log2(frequency+1)*18)+(row.kk.trim()?12:0)+(ready?35:0)+(row.review_state==='reviewed'&&row.review_verdict==='keep'?12:0)+(wordCount<=2?12:wordCount===3?4:-5)-(flags.includes('requires_key_scope')?12:0)-(row.kk.trim()?0:10);
    candidates.push({row,category,score,flags,ready,keys,frequency,currentContexts,usageSource:occurrences.length?'actual_arb_keys':'draft_related_keys',essential:roots.has(clean(row.ru))&&wordCount<=2});
  }
  candidates.sort((a,b)=>b.score-a.score||b.frequency-a.frequency||a.row.review_id.localeCompare(b.row.review_id));
  const canonical=new Map(),unique=[];
  for(const candidate of candidates){
    const signature=duplicateKey(candidate.row),existing=canonical.get(signature);
    if(existing){excluded.push({id:candidate.row.review_id,reason:'obvious_duplicate',duplicate_of:existing.row.review_id,source:candidate.row});continue;}
    canonical.set(signature,candidate);unique.push(candidate);
  }
  const selected=[],counts={};
  for(const candidate of unique){
    if(!candidate.essential)continue;
    selected.push(candidate);counts[candidate.category]=(counts[candidate.category]??0)+1;
  }
  // Keep a small number of relevant unresolved model changes visible to the reviewer.
  // They remain proposals, regardless of whether the suggested wording is sensible.
  let changes=0;
  for(const candidate of unique){
    if(changes>=6||selected.length>=target)break;
    if(selected.includes(candidate)||candidate.row.review_state!=='reviewed'||candidate.row.review_verdict!=='change'||(counts[candidate.category]??0)>=caps[candidate.category])continue;
    selected.push(candidate);counts[candidate.category]=(counts[candidate.category]??0)+1;changes++;
  }
  for(const candidate of unique){
    if(selected.includes(candidate))continue;
    if(selected.length>=target){excluded.push({id:candidate.row.review_id,reason:'below_shortlist_cutoff',source:candidate.row});continue;}
    if((counts[candidate.category]??0)>=caps[candidate.category]){excluded.push({id:candidate.row.review_id,reason:'category_limit',source:candidate.row});continue;}
    selected.push(candidate);counts[candidate.category]=(counts[candidate.category]??0)+1;
  }
  selected.sort((a,b)=>Number(b.ready)-Number(a.ready)||b.score-a.score||b.frequency-a.frequency||a.row.review_id.localeCompare(b.row.review_id));
  const rows=selected.map((c,index)=>({...c.row,status:'proposed',reviewer:'',reviewed_by_human:'false',review_requires_human:'true',shortlist_rank:String(index+1),shortlist_score:String(c.score),shortlist_domain:c.category,shortlist_usage_count:String(c.frequency),shortlist_usage_source:c.usageSource,shortlist_arb_keys:c.keys.join('|'),shortlist_arb_context:JSON.stringify(c.currentContexts),shortlist_group:c.ready?'existing_translation':'needs_attention',shortlist_attention_flags:c.flags.join('|'),shortlist_selection_reason:[c.essential?'core_term':'domain_or_ui_term',c.frequency>=3?'frequent_arb_usage':'context_specific',c.ready?'existing_translation_without_detected_flags':'human_resolution_required'].join('|'),shortlist_usage_comment:`${c.frequency} ARB-ключей; разделы: ${c.row.category||'не указан'}. Это частота в ресурсах, не телеметрия. ${c.ready?'Существующий KK без выявленных флагов; требуется решение человека.':'Нужна проверка: '+c.flags.join(', ')+'.'}`}));
  const extra=['shortlist_rank','shortlist_score','shortlist_domain','shortlist_usage_count','shortlist_usage_source','shortlist_arb_keys','shortlist_arb_context','shortlist_group','shortlist_attention_flags','shortlist_selection_reason','shortlist_usage_comment'];
  if(review.columns.some(column=>extra.includes(column)))throw Error('Input review already contains shortlist columns');
  const exclusionCounts={};for(const item of excluded)exclusionCounts[item.reason]=(exclusionCounts[item.reason]??0)+1;
  const summary={total:draft.rows.length,selected:rows.length,excluded:excluded.length,target,existing_translation:rows.filter(r=>r.shortlist_group==='existing_translation').length,needs_attention:rows.filter(r=>r.shortlist_group==='needs_attention').length,needs_key_scope:rows.filter(r=>r.shortlist_attention_flags.split('|').includes('requires_key_scope')).length,model_changes_selected:rows.filter(r=>r.review_state==='reviewed'&&r.review_verdict==='change').length,unreviewed_selected:rows.filter(r=>r.review_state!=='reviewed').length,llm_reviewed_selected:rows.filter(r=>r.review_state==='reviewed').length,approved:0,categories:counts,exclusion_reasons:exclusionCounts};
  if(summary.selected+summary.excluded!==summary.total)throw Error('Shortlist partition lost a source row');
  return {columns:[...review.columns,...extra],rows,excluded,summary};
}
