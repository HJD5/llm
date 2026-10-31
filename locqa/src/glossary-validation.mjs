import {norm,validateSuggestion} from './message.mjs';

export const glossaryList=value=>Array.isArray(value)?value:String(value??'').split('|').map(x=>x.trim()).filter(Boolean);
const words=text=>String(text??'').toLocaleLowerCase('kk').match(/\p{L}+/gu)??[];
// Small, explicit regression policy, not a Kazakh language classifier. Shared letters,
// loanwords (e.g. профиль, бонус), and absence of Kazakh-specific letters prove nothing.
const russianFragments=new Set(['ножки','ножка','стрипсы','оригинальные','текущая','текущий','выберите','выбрать','нажмите','купить','получить','продолжить','пожалуйста','чтобы','награда','награды','задания','игровой','игровая','игровую','валюты','отмена','страна','страны','для','или','еще','ещё']);
const standardAbbreviations=new Set(['gps','id','vip','hp','xp','usd','rub','kzt','км','м','кг','см','мм','мин']);
const explicitNameCategories=new Set(['brand','бренд','proper_name','person_name','имя собственное']);
export const canonicalProperName=original=>norm(original.ru)==='казахстан'?'Қазақстан':null;
const englishSense=value=>{
  const key=norm(value).replace(/[.!?]+$/u,'');
  return ['kazakhstan','qazaqstan'].includes(key)?'kazakhstan':key;
};
export function glossaryKeys(original,contexts=[]){return [...new Set([original.key,...glossaryList(original.related_keys),...contexts.map(c=>c.key)].filter(k=>typeof k==='string'&&k.trim()))];}
export function contextPolicy(original,contexts=[]){
  const keys=glossaryKeys(original,contexts);
  if(original.key)return {requires_key_scope:false,reasons:[],keys:[original.key]};
  const english=new Set([...glossaryList(original.en),...contexts.map(c=>c.en)].filter(v=>typeof v==='string'&&v.trim()).map(englishSense));
  const variants=new Set([original.kk,...glossaryList(original.observed_variants),...contexts.map(c=>c.kk)].filter(v=>typeof v==='string'&&v.trim()).map(norm));
  const units=new Set();
  for(const key of keys){if(/(?:^|_)(?:min|minutes?)(?:_|$)/iu.test(key))units.add('minute');if(/(?:^|_)(?:meters?|metres?)(?:_|$)/iu.test(key))units.add('distance');}
  const reasons=[];
  if(english.size>1)reasons.push('different_english_senses');
  if(variants.size>1&&keys.length>1)reasons.push('key_specific_variants');
  if(units.size>1)reasons.push('different_unit_meanings');
  return {requires_key_scope:reasons.length>0,reasons,keys};
}
export function contextGroups(contexts){
  const groups=new Map();
  for(const c of contexts){
    const signature=JSON.stringify([englishSense(c.en??''),norm(c.kk??'')]);
    if(!groups.has(signature))groups.set(signature,{english:c.en??'',kk:c.kk??'',keys:[],sections:[],example:c});
    const group=groups.get(signature);group.keys.push(c.key);if(c.section&&!group.sections.includes(c.section))group.sections.push(c.section);
  }
  return [...groups.values()];
}
export function establishedTranslation(original,contexts=[]){
  if(contextPolicy(original,contexts).requires_key_scope)return null;
  const en=[original.en,...contexts.map(c=>c.en)].join(' ');
  if(norm(original.ru)==='профиль'&&norm(original.kk)==='профиль'&&/\bprofile\b/iu.test(en))return original.kk;
  if(original.kk?.trim()&&norm(original.kk)===norm(original.ru)&&standardAbbreviations.has(norm(original.kk)))return original.kk;
  return null;
}
export function validateKkCandidate(original,text,{contexts=[]}={}){
  const issues=[];
  if(typeof text!=='string'||!text.trim())return {valid:false,issues:['empty_translation']};
  if(text.length>1000)issues.push('oversized_translation');
  const structure=validateSuggestion({source:original.ru},text,'kk');if(structure.reason)issues.push(structure.reason);
  const named=glossaryList(original.category).some(c=>explicitNameCategories.has(norm(c)));
  const exactName=named&&[original.ru,original.kk].some(v=>v&&norm(v)===norm(text));
  if(!exactName&&!standardAbbreviations.has(norm(text))){
    for(const word of words(text))if(russianFragments.has(word))issues.push('untranslated_russian_fragment:'+word);
  }
  const proper=canonicalProperName(original);
  if(proper&&text!==proper)issues.push(norm(text)===norm(proper)?'proper_noun_capitalization':'proper_noun_spelling');
  // Also catch the established country name embedded in an otherwise Kazakh phrase.
  if(!proper&&/(?<!\p{L})қазақстан(?:да|ға|нан|ның|ды|мен)?(?!\p{L})/u.test(text))issues.push('proper_noun_capitalization');
  const en=[original.en,...contexts.map(c=>c.en)].join(' ');
  if(/\b(?:strips|nuggets|drumsticks|coins|points|tasks|rewards|items|players)\b/iu.test(en)){
    const next=new Set(words(text));
    for(const word of words(original.kk)){
      const stem=word.replace(/(?:лар|лер|дар|дер|тар|тер)$/u,'');
      if(stem!==word&&stem.length>=3&&next.has(stem)&&!next.has(word))issues.push('possible_lost_kazakh_plural');
    }
  }
  return {valid:issues.length===0,issues:[...new Set(issues)]};
}
export const styleOnlyReason=reason=>/слишком буквальн|слишком общ|стилистическ|лучше звуч|более естествен|для ясности|stylistic|too general|more natural|unfamiliar|merely literal/iu.test(reason);
