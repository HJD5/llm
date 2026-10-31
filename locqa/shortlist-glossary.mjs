import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {parseDraft} from './src/glossary-review.mjs';
import {glossaryCsv} from './src/glossary.mjs';
import {loadArb,makeRecords} from './src/arb.mjs';
import {buildShortlist} from './src/glossary-shortlist.mjs';

export async function main(args=process.argv.slice(2)){
  const {values:v}=parseArgs({args,options:Object.fromEntries(['draft','review','out-dir','source','target','reference','target-size'].map(name=>[name,{type:'string'}]))});
  const draftFile=path.resolve(v.draft??'glossary_draft.csv'),reviewFile=path.resolve(v.review??'locqa/private-results/glossary_review.csv'),out=path.resolve(v['out-dir']??'locqa/private-results/hackathon-shortlist');
  if((v.source&&!v.target)||(v.target&&!v.source)||(v.reference&&!v.source))throw Error('Provide source and target ARB together');
  const inputs=[draftFile,reviewFile,...[v.source,v.target,v.reference].filter(Boolean).map(p=>path.resolve(p))];
  const files=['glossary_shortlist.csv','selection-manifest.json','REVIEW.md'].map(name=>path.join(out,name));
  if(files.some(f=>inputs.some(p=>f.toLowerCase()===p.toLowerCase())))throw Error('Output cannot overwrite inputs');
  // New directory only: every earlier shortlist and review stays intact.
  await fs.mkdir(path.dirname(out),{recursive:true});await fs.mkdir(out);
  const hashes={};for(const file of inputs)hashes[file]=createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const draft=parseDraft(await fs.readFile(draftFile,'utf8')),review=parseDraft(await fs.readFile(reviewFile,'utf8'));
  let records=[];
  if(v.source){const [source,target,reference]=await Promise.all([loadArb(v.source),loadArb(v.target),v.reference?loadArb(v.reference):null]);records=makeRecords(source,target,reference);}
  const result=buildShortlist(draft,review,{records,target:Number(v['target-size']??120)});
  const csv=glossaryCsv(result.rows,result.columns);
  for(const file of inputs)if(hashes[file]!==createHash('sha256').update(await fs.readFile(file)).digest('hex'))throw Error('Input changed during shortlist generation');
  await fs.writeFile(files[0],csv,{flag:'wx'});
  await fs.writeFile(files[1],JSON.stringify({summary:result.summary,input_hashes:hashes,selected:result.rows.map(r=>({id:r.review_id,rank:r.shortlist_rank,group:r.shortlist_group,domain:r.shortlist_domain,score:r.shortlist_score,usage:r.shortlist_usage_count})),excluded:result.excluded},null,2),{flag:'wx'});
  const q=value=>String(value??'').replaceAll('|','\\|').replaceAll('\n',' ');
  const lines=['# Hackathon glossary candidate shortlist','',`Selected: **${result.summary.selected}**. Excluded: **${result.summary.excluded}**. Existing translations without detected flags: **${result.summary.existing_translation}**. Need additional human attention: **${result.summary.needs_attention}**. All entries remain proposed; none are approved.`, '', 'Frequency means distinct ARB keys, not player telemetry. Original RU/KK/EN, comments, contexts and model recommendations are retained. Existing translations without detected flags still need explicit human confirmation. Ambiguous meanings must be approved for one existing key. No model was invoked. All excluded source rows, including duplicates, are preserved in selection-manifest.json and remain in the original input files.','', 'Import glossary_shortlist.csv in the existing Glossary interface. Review the existing_translation group first, then needs_attention. Select rows, inspect the text, enter your reviewer name and explicitly confirm before approving. Export glossary.csv only after those decisions.','', '| Rank | RU | Existing KK | Qwen recommendation | ARB keys | Review group | Attention |','|---|---|---|---|---|---|---|'];
  for(const r of result.rows)lines.push('| '+[r.shortlist_rank,r.ru,r.kk,r.recommended_kk,r.shortlist_usage_count,r.shortlist_group,r.shortlist_attention_flags].map(q).join(' | ')+' |');
  await fs.writeFile(files[2],lines.join('\n')+'\n',{flag:'wx'});
  console.log(JSON.stringify({...result.summary,output:files[0],report:files[2],model_calls:0},null,2));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
