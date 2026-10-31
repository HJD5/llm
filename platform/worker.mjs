import {parentPort,workerData} from 'node:worker_threads';
import {parseArb,makeRecords} from '../locqa/src/arb.mjs';
import {checkRecords} from '../locqa/src/engine.mjs';
import {QwenClient} from '../locqa/src/qwen.mjs';
const send=data=>parentPort.postMessage(data);
try{
  const {dataset,options,cacheDir}=workerData;
  send({kind:'log',message:'Чтение ARB и сохранение контекста разделов'});
  const source=parseArb(dataset.source),target=parseArb(dataset.target),reference=dataset.reference?parseArb(dataset.reference):null;
  let rows=makeRecords(source,target,reference);
  if(options.keys?.length)rows=rows.filter(r=>options.keys.includes(r.key));
  const client=options.useModel?new QwenClient({endpoint:'http://127.0.0.1:8088/v1/chat/completions',modelRevision:'Qwen3-8B-Q4_K_M:d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',cacheDir,maxCalls:options.budget}):null;
  const start=Date.now();
  const result=await checkRecords(rows,{terms:dataset.glossary??[],config:{locale:'kk',allow_unchanged:dataset.allow_unchanged??[],entity_exceptions:dataset.entityExceptions??[]},checks:options.checks,client,onEvent:send,onProgress:message=>send({kind:'log',message}),checkpoint:async report=>send({kind:'partial',report,calls:client?.calls??0,cacheHits:client?.cacheHits??0})});
  result.provenance={created_at:new Date().toISOString(),source:{sha256:source.sha256},target:{sha256:target.sha256},selection:options.keys?.length?options.keys:'all source keys except lang',checks:options.checks,duplicate_policy:'last occurrence; variants preserved',full_icu_flutter_validation:false};
  result.elapsed_seconds=(Date.now()-start)/1000;result.model_calls=client?.calls??0;result.cache_hits=client?.cacheHits??0;
  result.diagnostics.push(...source.diagnostics.map(x=>({...x,file:'source'})),...target.diagnostics.map(x=>({...x,file:'target'})));
  for(const key of target.entries.keys())if(!source.entries.has(key))result.diagnostics.push({kind:'extra_target_key',key});
  send({kind:'done',report:result});
}catch(e){send({kind:'failed',message:e.message});}
