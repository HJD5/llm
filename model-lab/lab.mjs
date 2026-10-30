import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
export const types = ['untranslated','same_as_source','placeholder_mismatch','plural_mismatch','glossary_violation','length_overflow','machine_translation_suspect','inconsistent_term','suffix_harmony','orthography','wrong_language'];
const read = async name => JSON.parse(await fs.readFile(path.join(root,name),'utf8'));
export function validateInput(data) {
  if (!data || !Array.isArray(data.records) || !data.records.length || data.records.length > 12) throw Error('Provide 1–12 records.');
  const ids = new Set();
  for (const r of data.records) {
    if (!r || typeof r.id !== 'string' || !r.id || ids.has(r.id) || typeof r.source !== 'string' || !(typeof r.target === 'string' || r.target === null)) throw Error('Each record needs a unique id, source string and target string or null.');
    ids.add(r.id);
  }
  if (Buffer.byteLength(JSON.stringify(data),'utf8') > 9000) throw Error('Input too large for this 4096-token profile; use smaller batches.');
}
export function schema(records, detailed=false) {
  const item = detailed ? {type:'object',additionalProperties:false,properties:{type:{enum:types},evidence:{type:'string'},suggestion:{anyOf:[{type:'string'},{type:'null'}]}},required:['type','evidence','suggestion']} : {enum:types};
  return {type:'object',additionalProperties:false,properties:{results:{type:'array',minItems:records.length,maxItems:records.length,items:{type:'object',additionalProperties:false,properties:{id:{enum:records.map(x=>x.id)},issues:{type:'array',maxItems:4,items:item}},required:['id','issues']}}},required:['results']};
}
export function validateOutput(output, records, detailed=false) {
  if (!output || !Array.isArray(output.results) || output.results.length !== records.length) throw Error('Invalid result count.');
  output.results.forEach((r,i)=>{
    if (r.id !== records[i].id || !Array.isArray(r.issues)) throw Error('Missing, duplicated or reordered result id.');
    const labels = r.issues.map(x=>detailed ? x.type : x);
    if (labels.some(x=>!types.includes(x)) || new Set(labels).size !== labels.length) throw Error('Invalid or duplicate issue type.');
    if (detailed && r.issues.some(x=>typeof x.evidence !== 'string' || !(x.suggestion === null || typeof x.suggestion === 'string'))) throw Error('Invalid issue fields.');
  });
  return output;
}
export function score(cases, output) {
  let tp=0,fp=0,fn=0,exact=0;
  const details = cases.map((c,i)=>{
    const predicted=output.results[i].issues, expected=c.expected;
    const extra=predicted.filter(x=>!expected.includes(x)), missed=expected.filter(x=>!predicted.includes(x));
    tp+=predicted.filter(x=>expected.includes(x)).length; fp+=extra.length; fn+=missed.length;
    if (!extra.length && !missed.length) exact++;
    return {id:c.id,expected,predicted,extra,missed};
  });
  return {tp,fp,fn,precision:tp+fp ? tp/(tp+fp) : null,recall:tp+fn ? tp/(tp+fn) : null,exact,total:cases.length,details};
}
export async function run(profile, input, detailed=false) {
  validateInput(input);
  if (!['baseline','profile'].includes(profile)) throw Error('Unknown profile');
  const settings=await read('settings.json');
  const system=await fs.readFile(path.join(root,profile+'.txt'),'utf8');
  const {endpoint,timeout_ms,...sampling}=settings;
  // Never forward gold labels or arbitrary fields to the model.
  const payload={target_locale:'kk',glossary:input.glossary??[],records:input.records.map(({id,source,target,context,max_chars})=>({id,source,target,context,max_chars}))};
  const request={...sampling,stream:false,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(payload)}],response_format:{type:'json_object',schema:schema(input.records,detailed)}};
  const started=Date.now();
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(timeout_ms)});
  if (!response.ok) throw Error(`Model HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
  const raw=await response.json();
  if (raw.choices?.[0]?.finish_reason !== 'stop') throw Error(`Incomplete response: ${raw.choices?.[0]?.finish_reason}`);
  const output=validateOutput(JSON.parse(raw.choices[0].message.content),input.records,detailed);
  return {profile,profile_sha256:createHash('sha256').update(system).digest('hex'),settings,elapsed_seconds:(Date.now()-started)/1000,usage:raw.usage,timings:raw.timings,output};
}
async function main() {
  const [command,arg,out]=process.argv.slice(2);
  if (command === 'evaluate' || command === 'holdout') {
    const single = command === 'holdout';
    const dataset=await read(single ? 'holdout.json' : 'cases.json');
    const report={created_at:new Date().toISOString(),description:dataset.description,batch_size:single?1:dataset.cases.length,dataset_sha256:createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),runs:[]};
    await fs.mkdir(path.join(root,'results'),{recursive:true});
    const stamp=report.created_at.replace(/[:.]/g,'-');
    const filename=path.join(root,'results',`${command}-${stamp}.json`);
    for (const profile of ['baseline','profile']) {
      console.log(`Running ${profile}: ${dataset.cases.length} synthetic cases...`);
      let result;
      if (single) {
        const parts=[];
        for (const record of dataset.cases) {
          console.log(`  ${record.id}`);
          parts.push(await run(profile,{records:[record],glossary:dataset.glossary}));
          await fs.writeFile(path.join(root,'results',`${command}-${stamp}-${profile}-partial.json`),JSON.stringify(parts,null,2));
        }
        result={profile,parts,elapsed_seconds:parts.reduce((a,b)=>a+b.elapsed_seconds,0),output:{results:parts.flatMap(x=>x.output.results)}};
      } else result=await run(profile,{records:dataset.cases,glossary:dataset.glossary});
      result.score=score(dataset.cases,result.output);
      report.runs.push(result);
      await fs.writeFile(filename,JSON.stringify(report,null,2));
      console.log(JSON.stringify({profile,seconds:result.elapsed_seconds,...result.score}));
    }
    console.log(`Saved ${filename}`);
  } else if (command === 'review' && arg && out) {
    const input=JSON.parse(await fs.readFile(arg,'utf8'));
    validateInput(input);
    const parts=[];
    for (const record of input.records) {
      console.log(`Reviewing ${record.id}...`);
      parts.push(await run('profile',{records:[record],glossary:input.glossary??[]},true));
    }
    const result={profile:'profile',batch_size:1,parts,output:{results:parts.flatMap(x=>x.output.results)}};
    result.reviewed_by_human=false;
    result.notice='Model proposals only. No translations applied; native-speaker review required.';
    await fs.writeFile(out,JSON.stringify(result,null,2));
    console.log(`Saved ${out}`);
  } else throw Error('Usage: node model-lab/lab.mjs evaluate | holdout | review input.json output.json');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1;});
