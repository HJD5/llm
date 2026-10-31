import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {readGlossary} from './src/glossary.mjs';
import {loadArb,makeRecords} from './src/arb.mjs';
import {checkRecords,modules} from './src/engine.mjs';
import {QwenClient} from './src/qwen.mjs';
import {htmlReport} from './src/report.mjs';
const help=`node locqa/cli.mjs check --source file.arb --target file.arb --out report.json
  --reference intl_en.arb --glossary glossary.csv --config config.json
  --checks comma,separated,ids --keys key1,key2
  --llm --max-llm-calls 12 --cache-dir locqa/private-results/cache
Default: 8 code modules, 3 Qwen modules reported deferred. No translations are modified.
Checks: ${modules.map(m=>m.id).join(', ')}`;
async function main(){
  const names=['source','target','out','reference','glossary','config','checks','keys','max-llm-calls','cache-dir'];
  const {values:v,positionals}=parseArgs({options:{...Object.fromEntries(names.map(n=>[n,{type:'string'}])),llm:{type:'boolean'},help:{type:'boolean'}},allowPositionals:true});
  if(v.help){console.log(help);return;}
  if(positionals.length!==1||positionals[0]!=='check'||!v.source||!v.target||!v.out)throw Error(help);
  const output=path.resolve(v.out),html=output.replace(/\.json$/i,'')+'.html';
  const protectedPaths=[v.source,v.target,v.reference,v.glossary,v.config].filter(Boolean).map(p=>path.resolve(p).toLowerCase());
  if([output,html].some(p=>protectedPaths.includes(p.toLowerCase())))throw Error('Output would overwrite an input file');
  const [source,target,reference]=await Promise.all([loadArb(v.source),loadArb(v.target),v.reference?loadArb(v.reference):null]);
  const config=v.config?JSON.parse(await fs.readFile(v.config,'utf8')):{};
  let terms=[];
  if(v.glossary){
    const text=await fs.readFile(v.glossary,'utf8');
    terms=readGlossary(text);
  }
  if(config.allow_unchanged&&(!Array.isArray(config.allow_unchanged)||config.allow_unchanged.some(x=>typeof x!=='string')))throw Error('allow_unchanged must be an array of strings');
  if(config.max_chars&&(typeof config.max_chars!=='object'||Array.isArray(config.max_chars)||Object.values(config.max_chars).some(x=>!Number.isInteger(x)||x<0)))throw Error('max_chars must map keys to nonnegative integer limits');
  const budget=Number(v['max-llm-calls']??12);
  if(!Number.isSafeInteger(budget)||budget<0||budget>100000)throw Error('Invalid max-llm-calls');
  let records=makeRecords(source,target,reference);
  if(v.keys){const requested=new Set(v.keys.split(','));const unknown=[...requested].filter(k=>!records.some(r=>r.key===k));if(unknown.length)throw Error('Unknown keys: '+unknown.join(','));records=records.filter(r=>requested.has(r.key));}
  const cacheDir=path.resolve(v['cache-dir']??'locqa/private-results/cache');
  const client=v.llm?new QwenClient({endpoint:config.endpoint??'http://127.0.0.1:8088/v1/chat/completions',modelRevision:config.model_revision??'Qwen3-8B-Q4_K_M:d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',cacheDir,maxCalls:budget,maxRetries:config.llm_max_retries??1,maxTokens:config.llm_max_tokens??768,timeoutMs:config.llm_timeout_ms??240000}):null;
  const start=Date.now();
  const provenance={created_at:new Date().toISOString(),source:{file:v.source,sha256:source.sha256},target:{file:v.target,sha256:target.sha256},reference:reference?{file:v.reference,sha256:reference.sha256}:null,selection:v.keys??'all source string keys except lang',glossary:v.glossary??null,config,duplicate_policy:'last occurrence used; all message variants retained in diagnostics',full_icu_flutter_validation:false};
  await fs.mkdir(path.dirname(output),{recursive:true});
  const report=await checkRecords(records,{config,terms,checks:v.checks?v.checks.split(','):undefined,client,onProgress:s=>console.log(s),checkpoint:async partial=>fs.writeFile(output+'.partial',JSON.stringify({provenance,...partial},null,2))});
  report.provenance=provenance;report.elapsed_seconds=(Date.now()-start)/1000;report.model_calls=client?.calls??0;report.cache_hits=client?.cacheHits??0;
  report.diagnostics.push(...source.diagnostics.map(d=>({...d,file:'source'})),...target.diagnostics.map(d=>({...d,file:'target'})));
  for(const key of target.entries.keys())if(!source.entries.has(key))report.diagnostics.push({kind:'extra_target_key',key});
  await fs.writeFile(output,JSON.stringify(report,null,2));await fs.writeFile(html,htmlReport(report));
  console.log(JSON.stringify({report:output,html,records:records.length,seconds:report.elapsed_seconds,model_calls:report.model_calls,cache_hits:report.cache_hits,checks:report.modules},null,2));
  if(report.diagnostics.some(d=>d.kind==='model_request_failed'))process.exitCode=2;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
