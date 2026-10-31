import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {loadArb,makeRecords} from './src/arb.mjs';
import {norm} from './src/message.mjs';
import {glossaryCsv} from './src/glossary.mjs';
const {values:v}=parseArgs({options:Object.fromEntries(['source','target','reference','out'].map(x=>[x,{type:'string'}]))});
if(!v.source||!v.target||!v.out)throw Error('Usage: node locqa/build-glossary.mjs --source ru.arb --target kk.arb --reference en.arb --out glossary-draft.csv');
if([v.source,v.target,v.reference].filter(Boolean).some(p=>path.resolve(p).toLowerCase()===path.resolve(v.out).toLowerCase()))throw Error('Output cannot overwrite input');
const [source,target,reference]=await Promise.all([loadArb(v.source),loadArb(v.target),v.reference?loadArb(v.reference):null]);
const groups=new Map();
for(const row of makeRecords(source,target,reference)){
 if(row.source.length>40||row.source.split(/\s+/u).length>4||!row.target?.trim()||/[{}<>%\n]/u.test(row.source)||!/[А-Яа-яЁё]/u.test(row.source))continue;
 const key=norm(row.source);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
}
const rows=[...groups.values()].filter(g=>g.length>1||/фракц|семь|бизнес|варн|мут|фур|монет|награ|валют|опыт|уровень/iu.test(g[0].source)).map(g=>{
 const variants=[...new Map(g.map(r=>[norm(r.target),r.target])).values()];
 return {ru:g[0].source,kk:variants.length===1?variants[0]:'',en:[...new Set(g.map(r=>r.context.english).filter(Boolean))].join(' | '),comment:variants.length>1?'Конфликт вариантов. Выбрать по контексту с носителем; частота не доказывает правильность.':'Извлечено из ARB. Нужна проверка носителем, это не утверждённый перевод.',status:'proposed',category:[...new Set(g.map(r=>r.context.section))].join(' | '),observed_variants:variants,related_keys:g.map(r=>r.key)};
});
await fs.mkdir(path.dirname(path.resolve(v.out)),{recursive:true});
await fs.writeFile(v.out,glossaryCsv(rows),{flag:'wx'});
console.log(JSON.stringify({output:v.out,terms:rows.length,conflicts:rows.filter(x=>!x.kk).length,approved:0}));
