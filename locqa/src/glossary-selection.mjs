import {createHash} from 'node:crypto';
import {norm} from './message.mjs';
import {canonicalProperName,contextPolicy,establishedTranslation,glossaryList,validateKkCandidate} from './glossary-validation.mjs';

export const screeningVersion=1;
const gamingRu=/фракц|клан|семь[яиюе]|семейн|бизнес|варн|мут|бан(?:а|ы|ов)?(?:\s|$)|валют|монет|награ|(?<!\p{L})опыт|уров|ранг|репутац|инвентар|боеприпас|оруж|брон|здоров|респаун|возрож|квест|задани|аренд|гараж|транспорт|дальнобой|дрифт|навык|донат|баланс|налич|кошел|лиценз|боевой пропуск|контрабанд|ограб|розыск|тюр[ье]м|полиц|гонк|тюнинг|персонаж|скин|зарплат/iu;
const gamingEn=/\b(?:faction|clan|family|business|currency|coins?|reward|experience|level|rank|reputation|inventory|ammo|weapon|armor|health|respawn|quest|rent|garage|vehicle|skill|donat(?:e|ion)|balance|cash|license|battle pass|smuggl(?:ing|er)|robbery|wanted|jail|police|race|tuning|character|skin|salary|mute|warn|ban)\b/iu;
const genericUi=new Set(['да','нет','назад','далее','готово','отмена','пропустить','продолжить','внимание','поиск','ок','хорошо','закрыть','открыть','повторить','перезапустить','сохранить','выход','подтвердить','название','описание','дата','время','или','пусто','прочее','создать','купить','продать','подарить']);
const explicitNames=new Set(['brand','бренд','proper_name','person_name','имя собственное','country_name','city_name']);
const coreTerms=new Set(['фракция','клан','семья','бизнес','варн','мут','бан','валюта','игровая валюта','инвентарь','боеприпасы','оружие','броня','здоровье','репутация','респаун','квест','опыт','уровень','ранг','донат','навык','лицензия','тюнинг','персонаж','зарплата','награда']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hasText=value=>typeof value==='string'&&/\p{L}/u.test(value);

export function screenTerm(row){
  const original=row.original,contexts=row.contexts??[],flags=[...(row.flags??[])];
  const policy=row.context_policy??contextPolicy(original,contexts);
  const usefulContext=hasText(original.en)||contexts.some(c=>hasText(c.en)||hasText(c.description));
  const important=gamingRu.test(original.ru)||gamingEn.test(original.en??'');
  const formatting=[];
  for(const field of ['ru','kk']){
    const text=original[field];
    if(text!==text.trim())formatting.push(field+'_outer_whitespace');
    if(/\s{2,}/u.test(text))formatting.push(field+'_repeated_whitespace');
    if(text!==text.normalize('NFC'))formatting.push(field+'_unicode_normalization');
    if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text))formatting.push(field+'_control_character');
  }
  const technical=/[{}<>]|%(?:\d+\$)?[sdif]|https?:\/\/|www\./iu.test(original.ru)||!hasText(original.ru);
  const candidateCheck=original.kk.trim()?validateKkCandidate(original,original.kk,{contexts}):{issues:['empty_kk']};
  const checks=[...new Set([...flags,...formatting,...candidateCheck.issues])];
  const score=(important?100:40)+(coreTerms.has(norm(original.ru))?100:0)+(!original.kk.trim()?30:0)+Math.max(0,4-original.ru.trim().split(/\s+/u).length)*5;
  const result=(classification,priority,reasons,extra={})=>({version:screeningVersion,classification,priority,score:classification==='needs_llm'?score:0,reasons,checks,useful_context:usefulContext,game_terminology:important,translation_linguistically_verified:false,...extra});
  if(technical)return result('low_priority','normal',['technical_or_unsuitable_candidate']);
  if(policy.requires_key_scope)return result('needs_human',important?'high':'medium',['choose_key_before_translation',...policy.reasons]);
  const proper=canonicalProperName(original);
  if(proper)return result('rule_checked','medium',['known_proper_name','check_canonical_capitalization'],{rule_suggestion:original.kk!==proper?proper:null});
  if(glossaryList(original.category).some(c=>explicitNames.has(norm(c))))return result('rule_checked','normal',['explicit_proper_name_preserve_context']);
  if(establishedTranslation(original,contexts))return result('rule_checked','normal',['established_vocabulary_or_standard_abbreviation']);
  if(/\d/u.test(original.ru))return result('low_priority','normal',['numbered_instance_not_canonical_term']);
  if(!original.kk.trim())return usefulContext?result('needs_llm','high',['missing_kk_with_context']):result('needs_human','high',['missing_kk_without_context']);
  const lexicalIssues=candidateCheck.issues.filter(x=>!x.includes('capitalization'));
  if(lexicalIssues.length)return usefulContext?result('needs_llm','high',['suspect_translation_with_context',...lexicalIssues]):result('needs_human','high',['suspect_translation_without_context',...lexicalIssues]);
  if(flags.includes('conflicting_translations'))return usefulContext?result('needs_llm','high',['scoped_translation_conflict']):result('needs_human','high',['conflict_without_context']);
  if(/громк|зву[кч]|блюм|блум|яркост|график|текстур|прорисов/iu.test(original.ru))return result('low_priority','normal',['generic_settings_label']);
  if(important)return usefulContext?result('needs_llm','high',['important_game_terminology']):result('needs_human','high',['game_term_without_context']);
  if(formatting.length)return result('rule_checked','medium',['formatting_checks_complete']);
  const short=original.ru.replace(/[^\p{L}]/gu,'').length<=2;
  if(short)return usefulContext?result('needs_llm','medium',['ambiguous_short_label_with_context']):result('needs_human','medium',['ambiguous_short_label_without_context']);
  if(genericUi.has(norm(original.ru).replace(/[.!?]+$/u,''))||original.ru.trim().split(/\s+/u).length>4||original.ru.length>40)return result('low_priority','normal',['generic_ui_or_phrase']);
  return result('low_priority','normal',['not_a_core_game_term']);
}

export function preScreen(rows){
  const duplicates=new Map();
  for(const row of rows){
    row.screening=screenTerm(row);
    // Only exact semantic/context matches are duplicates. Never combine different keys/senses.
    const key=hash({original:row.original,contexts:row.contexts,groups:row.context_groups});
    if(duplicates.has(key))row.screening={...row.screening,classification:'rule_checked',priority:'normal',reasons:['exact_duplicate'],duplicate_of:duplicates.get(key)};
    else duplicates.set(key,row.id);
  }
  return rows;
}

export function selectReviewRows(state,{selection='smart',priority='all',limit=20,retryFailed=false}={}){
  if(!['smart','all'].includes(selection)||!['high','medium','all'].includes(priority))throw Error('Invalid selection or priority');
  preScreen(state.rows);
  const rank={high:0,medium:1,normal:2};
  const eligible=row=>['pending','deferred'].includes(row.review_state)||(retryFailed&&row.review_state==='failed');
  const priorityAllowed=row=>priority==='all'||rank[row.screening.priority]<=rank[priority];
  if(selection==='all')return state.rows.slice(0,limit).filter(r=>eligible(r)&&priorityAllowed(r));
  return state.rows.filter(r=>eligible(r)&&r.screening.classification==='needs_llm'&&!r.screening.duplicate_of&&priorityAllowed(r)).sort((a,b)=>rank[a.screening.priority]-rank[b.screening.priority]||b.screening.score-a.screening.score||a.index-b.index).slice(0,limit);
}

export function screeningSummary(state){
  const classes={rule_checked:0,needs_llm:0,needs_human:0,low_priority:0};
  for(const row of state.rows)classes[row.screening.classification]++;
  return {total:state.rows.length,classifications:classes,deterministic_only:classes.rule_checked+classes.low_priority+classes.needs_human,duplicates:state.rows.filter(r=>r.screening.duplicate_of).length,completed_llm:state.rows.filter(r=>r.review_state==='reviewed').length,unresolved_human:state.rows.filter(r=>r.screening.classification==='needs_human'||r.review_state==='failed'||(r.review_state==='reviewed'&&r.verdict==='uncertain')).length,awaiting_human_approval:state.rows.filter(r=>r.status==='proposed').length,approved:state.rows.filter(r=>r.status==='approved').length};
}
