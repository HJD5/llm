import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {loadArb,makeRecords} from './src/arb.mjs';
import {glossaryFixPlan,glossaryFixedArb} from '../platform/glossary-fixed.mjs';
const {values:v}=parseArgs({options:{...Object.fromEntries(['source','target','reference','review-store','out'].map(k=>[k,{type:'string'}])),plan:{type:'boolean'}}});
if(!v.source||!v.target||!v['review-store']||!v.out)throw Error('Usage: node locqa/export-fixed.mjs --source ru.arb --target kk.arb --reference en.arb --review-store platform/private-data/glossary-review.json --out intl_kk_fixed.arb [--plan]');
const out=path.resolve(v.out),inputs=[v.source,v.target,v.reference,v['review-store']].filter(Boolean).map(p=>path.resolve(p).toLowerCase());
if(inputs.includes(out.toLowerCase())||inputs.includes((out+'.review.json').toLowerCase()))throw Error('Output would overwrite an input');
const [source,target,reference,store]=await Promise.all([loadArb(v.source),loadArb(v.target),v.reference?loadArb(v.reference):null,fs.readFile(v['review-store'],'utf8').then(JSON.parse)]);
const dataset={sourceHash:source.sha256,targetHash:target.sha256,rows:makeRecords(source,target,reference),target:await fs.readFile(v.target,'utf8')};
const result=v.plan?{plan:glossaryFixPlan(dataset,store.entries)}:glossaryFixedArb(dataset,store.entries);
await fs.mkdir(path.dirname(out),{recursive:true});
if(v.plan)await fs.writeFile(out,JSON.stringify(result.plan,null,2),{flag:'wx'});
else{
 // Exclusive writes prevent overwriting an earlier reviewed deliverable.
 try{await fs.access(out+'.review.json');throw Error('Review manifest already exists; choose a new output path');}catch(e){if(e.code!=='ENOENT')throw e;}
 const arb=await fs.open(out,'wx');
 try{const manifest=await fs.open(out+'.review.json','wx');try{await manifest.writeFile(JSON.stringify({created_at:new Date().toISOString(),source_sha256:source.sha256,target_sha256:target.sha256,...result.plan},null,2));await arb.writeFile(result.text);}finally{await manifest.close();}}finally{await arb.close();}
}
console.log(JSON.stringify({output:out,plan_only:!!v.plan,changes:result.plan.approved_changes,pending_terms:result.plan.pending_terms,blocked:result.plan.blocked.length}));
