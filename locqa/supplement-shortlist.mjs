import fs from 'node:fs/promises';
import {parseDraft,prepareReview,reviewCsv} from './src/glossary-review.mjs';
import {glossaryCsv} from './src/glossary.mjs';
import {loadArb,makeRecords} from './src/arb.mjs';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: node locqa/supplement-shortlist.mjs input.csv output.csv');
const original=parseDraft(await fs.readFile(input,'utf8'));
const [s,t,e]=await Promise.all(['ru','kk','en'].map(lang=>loadArb(`basw/handout/intl_${lang}.arb`)));
const records=makeRecords(s,t,e);
const additions=[
 {ru:'Grand Coins',kk:'Grand Coins',en:'Grand Coins',category:'economy',comment:'Название игровой валюты встречается внутри строк. Уточнить сохранение бренда и связь с GC у заказчика. Это кандидат, не утверждённый термин.'},
 {ru:'варн',kk:'',en:'',category:'moderation',comment:'Термин приведён в задании. Точное употребление в ARB не найдено; запросить контекст и казахский вариант у носителя/заказчика.'},
 {ru:'мут',kk:'',en:'',category:'moderation',comment:'Термин приведён в задании. Точное употребление в ARB не найдено; не выдумывать перевод без контекста.'},
 {ru:'фура',kk:'',en:'',category:'vehicles',comment:'Игровой сленг из задания. Точное употребление в ARB не найдено; требуется согласовать значение и перевод.'}
].filter(a=>!original.rows.some(r=>r.ru.trim().toLowerCase()===a.ru.toLowerCase()));
const draft=parseDraft(glossaryCsv(additions.map(a=>({...a,status:'proposed',related_keys:records.filter(r=>r.source.includes(a.ru)).map(r=>r.key).join('|')}))));
const prepared=prepareReview(draft,records);for(const r of prepared){r.id='supplement-'+r.id;r.priority='high';r.explanation=r.original.comment;r.recommendation_source='case_requirement';}
const extra=parseDraft(reviewCsv({columns:draft.columns,rows:prepared})).rows;
for(const [index,r] of extra.entries())Object.assign(r,{shortlist_rank:String(original.rows.length+index+1),shortlist_score:'0',shortlist_domain:additions[index].category,shortlist_usage_count:String((r.related_keys||'').split('|').filter(Boolean).length),shortlist_group:'needs_attention',shortlist_attention_flags:'requires_human_definition',shortlist_arb_context:r.review_context,shortlist_usage_comment:r.comment});
await fs.writeFile(output,glossaryCsv([...original.rows,...extra],original.columns),{flag:'wx'});
console.log(JSON.stringify({original:original.rows.length,added:extra.length,total:original.rows.length+extra.length,approved:0}));
