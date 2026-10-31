import {parse} from 'csv-parse/sync';
export function normalizeGlossary(terms){
 if(!Array.isArray(terms)||terms.length>10000)throw Error('Glossary must contain at most 10000 rows');
 return terms.map(t=>{
  const ru=t.ru??t.term_ru,kk=t.kk??t.term_kk,en=t.en??t.term_en??'',comment=t.comment??t.note??'';
  const status=t.status||'approved'; // Legacy imported glossaries were explicitly supplied as rules.
  if(!['proposed','approved','rejected'].includes(status)||typeof ru!=='string'||!ru.trim()||typeof kk!=='string'||(status==='approved'&&!kk.trim()))throw Error('Glossary requires ru, kk and valid status; approved kk cannot be empty');
  const variants=Array.isArray(t.variants)?t.variants:typeof t.variants==='string'?t.variants.split('|').filter(Boolean):[];
  if(variants.some(x=>typeof x!=='string'))throw Error('Invalid glossary variants');
  return {...t,ru,kk,en,comment,status,variants};
 });
}
export function readGlossary(text){if(!text.trim())return [];return normalizeGlossary(text.trim().startsWith('[')?JSON.parse(text):parse(text,{columns:true,bom:true,skip_empty_lines:true}));}
export const approvedTerms=terms=>terms.filter(t=>!t.status||t.status==='approved');
export function glossaryCsv(rows){
 const columns=['ru','kk','en','comment','status','key','category','variants','observed_variants','related_keys','reviewer'];
 const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
 return '\uFEFF'+[columns.join(','),...rows.map(r=>columns.map(k=>quote(Array.isArray(r[k])?r[k].join('|'):r[k])).join(','))].join('\r\n')+'\r\n';
}
