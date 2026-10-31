import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {QwenClient} from './src/qwen.mjs';
import {loadArb,makeRecords} from './src/arb.mjs';
import {parseDraft,prepareReview,reviewCsv,runReview,digest,reviewBody,reviewVersion,reuseReviewCsv,reviewWorkload} from './src/glossary-review.mjs';
import {preScreen,screeningSummary} from './src/glossary-selection.mjs';

export const reviewHelp=`node locqa/cli.mjs review-glossary --input glossary_draft.csv --out glossary_review.csv
  --source intl_ru.arb --target intl_kk.arb --reference intl_en.arb
  --limit 20 --batch-size 3 --max-llm-calls 12 --timeout-ms 240000
  --max-tokens 768 --context-tokens 4096 --max-retries 1
  --checkpoint path.json --cache-dir locqa/private-results/glossary-cache
  --selection smart|all --priority high|medium|all --dry-run
  --reuse-review previous_review.csv --resume --retry-failed --rules-only --model-revision name
Default: smart selection, up to 20 NEW candidates, max 12 generation attempts.
smart: prioritize the eligible queue across the draft. all: legacy first N input rows.
priority medium includes high + medium. dry-run makes no HTTP calls and writes no files.
No automatic approvals. Import the review CSV in the platform Glossary tab for human decisions.`;
const exists=async file=>{try{await fs.access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export async function atomicWrite(file,text){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',text);await fs.rename(file+'.tmp',file);}
export async function main(args=process.argv.slice(2)){
  const names=['input','out','source','target','reference','limit','batch-size','max-llm-calls','timeout-ms','max-tokens','context-tokens','max-retries','checkpoint','cache-dir','model-revision','selection','priority','reuse-review'];
  const {values:v}=parseArgs({args,options:{...Object.fromEntries(names.map(n=>[n,{type:'string'}])),resume:{type:'boolean'},'retry-failed':{type:'boolean'},'rules-only':{type:'boolean'},'dry-run':{type:'boolean'},help:{type:'boolean'}}});
  if(v.help){console.log(reviewHelp);return;}
  if((v.source&&!v.target)||(v.target&&!v.source)||(v.reference&&!v.source))throw Error('--source and --target are required together for ARB context');
  const input=path.resolve(v.input??'glossary_draft.csv'),output=path.resolve(v.out??'glossary_review.csv'),checkpoint=path.resolve(v.checkpoint??output+'.checkpoint.json');
  const inputs=[input,v.source,v.target,v.reference,v['reuse-review'],v['reuse-review']?v['reuse-review']+'.checkpoint.json':null].filter(Boolean).map(p=>path.resolve(p).toLowerCase());
  const writes=[output,checkpoint,output+'.tmp',checkpoint+'.tmp'].map(p=>p.toLowerCase());
  if(new Set(writes).size!==writes.length||writes.some(p=>inputs.includes(p)))throw Error('Review outputs must not overwrite inputs or each other');
  const integer=(name,fallback,min,max)=>{const n=Number(v[name]??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid --'+name);return n;};
  const options={limit:integer('limit',20,1,10000),batchSize:integer('batch-size',3,1,8),maxTokens:integer('max-tokens',768,128,2048),contextTokens:integer('context-tokens',4096,1024,4096),selection:v.selection??'smart',priority:v.priority??'all'};
  if(!['smart','all'].includes(options.selection)||!['high','medium','all'].includes(options.priority))throw Error('Expected --selection smart|all and --priority high|medium|all');
  const client=new QwenClient({endpoint:'http://127.0.0.1:8088/v1/chat/completions',modelRevision:v['model-revision']??'Qwen3-8B-Q4_K_M:d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',cacheDir:path.resolve(v['cache-dir']??'locqa/private-results/glossary-cache'),maxCalls:integer('max-llm-calls',12,0,100000),timeoutMs:integer('timeout-ms',240000,1,3600000),maxTokens:options.maxTokens,maxRetries:integer('max-retries',1,0,2)});
  const draft=parseDraft(await fs.readFile(input,'utf8'));
  let records=[];
  if(v.source){const [source,target,reference]=await Promise.all([loadArb(v.source),loadArb(v.target),v.reference?loadArb(v.reference):null]);records=makeRecords(source,target,reference);}
  const initialRows=prepareReview(draft,records);
  const fingerprint=digest({version:reviewVersion,columns:draft.columns,rows:initialRows,endpoint:client.endpoint,revision:client.modelRevision,prompt:reviewBody([],768).messages[0].content});
  const freshState=()=>({version:reviewVersion,fingerprint,input,columns:draft.columns,created_at:new Date().toISOString(),rows:initialRows});
  let state,reuse={checkpoint:0,csv:0,skipped:0};
  if(v.resume){
    if(await exists(checkpoint)){
      state=JSON.parse(await fs.readFile(checkpoint,'utf8'));
      if(state.version!==reviewVersion||state.fingerprint!==fingerprint||digest(state.rows.map(r=>({id:r.id,original:r.original,contexts:r.contexts})))!==digest(initialRows.map(r=>({id:r.id,original:r.original,contexts:r.contexts}))))throw Error('Checkpoint does not match draft, ARB context or model/prompt revision; choose new output paths');
    }else{
      state=freshState();const imported=reuseReviewCsv(state,await fs.readFile(output,'utf8'),{modelRevision:client.modelRevision,sourceFile:output});reuse.csv=imported.reused;reuse.skipped=imported.skipped;
    }
  }else{
    if(await exists(output)||await exists(checkpoint))throw Error('Output/checkpoint already exists; use --resume or choose new paths');
    state=freshState();
  }
  if(v['reuse-review']){
    const file=path.resolve(v['reuse-review']);
    try{
      const previous=JSON.parse(await fs.readFile(file+'.checkpoint.json','utf8'));
      if(previous.version===reviewVersion&&previous.fingerprint===fingerprint){
        const byId=new Map(previous.rows.map(r=>[r.id,r]));
        state.rows=state.rows.map(row=>{const old=byId.get(row.id);if(row.review_state!=='reviewed'&&old?.review_state==='reviewed'&&digest({original:old.original,contexts:old.contexts,groups:old.context_groups})===digest({original:row.original,contexts:row.contexts,groups:row.context_groups})){reuse.checkpoint++;return structuredClone(old);}return row;});
      }
    }catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    const imported=reuseReviewCsv(state,await fs.readFile(file,'utf8'),{modelRevision:client.modelRevision,sourceFile:file});reuse.csv+=imported.reused;reuse.skipped+=imported.skipped;
  }
  preScreen(state.rows);
  // Validate reserved CSV fields before creating any outputs.
  reviewCsv(state);
  const plan=await reviewWorkload(state,{...options,client,retryFailed:v['retry-failed']});
  if(v['dry-run']){console.log(JSON.stringify({dry_run:true,files_written:0,http_calls:0,reused:reuse,...plan},null,2));return {state,plan};}
  state.selection_options={...options,reuse};
  const save=async s=>{await atomicWrite(checkpoint,JSON.stringify(s,null,2));await atomicWrite(output,reviewCsv(s));};
  const controller=new AbortController(),interrupt=()=>controller.abort();
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  try{
    if(v['rules-only'])await save(state);
    else await runReview(state,{...options,client,retryFailed:v['retry-failed'],signal:controller.signal,save,onProgress:p=>console.log(JSON.stringify(p))});
  }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
  const counts={};for(const row of state.rows)counts[row.review_state]=(counts[row.review_state]??0)+1;
  console.log(JSON.stringify({output,checkpoint,...screeningSummary(state),selection:options.selection,priority:options.priority,counts,reused:reuse,run:state.last_selection??null,model_calls:client.calls,cache_hits:client.cacheHits,interrupted:controller.signal.aborted}));
  if(controller.signal.aborted)process.exitCode=130;
  else if(state.rows.some(r=>state.last_selection?.selected_ids.includes(r.id)&&r.review_state==='failed'))process.exitCode=2;
  return state;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
