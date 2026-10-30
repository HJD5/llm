import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {run} from './lab.mjs';
const base=new URL('./private-results/',import.meta.url);
const inputText=await fs.readFile(new URL('real-sample.json',base),'utf8');
const input=JSON.parse(inputText);
const report={started_at:new Date().toISOString(),input_sha256:createHash('sha256').update(inputText).digest('hex'),scope:'12 targeted real records from test_sample. Not random, not gold-labeled. No precision/recall computed. Source files unchanged.',classification:[],detailed:[],errors:[]};
const out=new URL(`qwen-real-${report.started_at.replace(/[:.]/g,'-')}.json`,base);
const save=()=>fs.writeFile(out,JSON.stringify(report,null,2));
for (const record of input.records) {
  console.log(`Classify ${record.id}`);
  try { report.classification.push(await run('profile',{records:[record],glossary:[]},false)); }
  catch(e) {report.errors.push({id:record.id,stage:'classification',error:e.message});}
  await save();
}
for (const id of ['drag_next_races_after','rosticsGameWork1HeaderInfo1','rosticsGameBasketName0']) {
  console.log(`Explain ${id}`);
  try {report.detailed.push(await run('profile',{records:[input.records.find(x=>x.id===id)],glossary:[]},true));}
  catch(e) {report.errors.push({id,stage:'detailed',error:e.message});}
  await save();
}
report.finished_at=new Date().toISOString();
await save();
console.log(JSON.stringify({file:out.pathname,classified:report.classification.length,detailed:report.detailed.length,errors:report.errors},null,2));
