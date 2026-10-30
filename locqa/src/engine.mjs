import untranslated from './checks/untranslated.mjs';
import sameAsSource from './checks/same_as_source.mjs';
import placeholders from './checks/placeholder_mismatch.mjs';
import plurals from './checks/plural_mismatch.mjs';
import glossary from './checks/glossary_violation.mjs';
import length from './checks/length_overflow.mjs';
import suffix from './checks/suffix_harmony.mjs';
import inconsistent from './checks/inconsistent_term.mjs';
import semantic from './checks/machine_translation_suspect.mjs';
import orthography from './checks/orthography.mjs';
import language from './checks/wrong_language.mjs';
import {analyzeMessage,norm} from './message.mjs';
import {modelEligible} from './qwen.mjs';
import {finding} from './shared.mjs';
export const modules=[untranslated,sameAsSource,placeholders,plurals,glossary,length,suffix,inconsistent,semantic,orthography,language];
export async function checkRecords(records,{config={},terms=[],checks=modules.map(m=>m.id),client=null,onProgress=()=>{},onEvent=()=>{},checkpoint=async()=>{}}={}){
  config={locale:'kk',allow_unchanged:[],max_chars:{},...config};
  if(config.locale!=='kk')throw Error('Language modules currently support kk only');
  for(const id of checks)if(!modules.some(m=>m.id===id))throw Error(`Unknown check ${id}`);
  const groups=new Map();
  for(const r of records)if(r.target?.trim()){
    const key=norm(r.source);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
  }
  const counters=Object.fromEntries(modules.map(m=>[m.id,{enabled:checks.includes(m.id),assessed:0,findings:0,deferred:0,skipped:0,uncertain:0,failed:0,skip_reasons:{}}]));
  const report={records:records.length,issues:[],modules:counters,model_reviews:[],diagnostics:[],confidence_note:'No calibrated probabilities available; confidence is null. Model error verdicts and heuristics remain unreviewed candidates.'};
  let completed=0;
  onEvent({kind:'progress',completed,total:records.length,modules:counters,findings:0});
  for(const row of records){
    const allowedUnchanged=typeof row.target==='string'&&norm(row.target)===norm(row.source)&&(config.allow_unchanged.some(x=>norm(x)===norm(row.source))||terms.some(t=>norm(t.ru)===norm(row.source)&&norm(t.kk)===norm(row.source)&&(!t.key||t.key===row.key)));
    const ctx={row,config,glossary:terms,groups,allowedUnchanged,src:analyzeMessage(row.source),tgt:analyzeMessage(row.target??'')};
    if(ctx.src.error)report.diagnostics.push({kind:'source_message_parse_error',key:row.key,error:ctx.src.error});
    for(const module of modules.filter(m=>checks.includes(m.id))){
      const stat=counters[module.id];
      const skip=reason=>{stat.skipped++;stat.skip_reasons[reason]=(stat.skip_reasons[reason]??0)+1;};
      if(module.id==='glossary_violation'&&!terms.length){skip('no_glossary');continue;}
      if(!module.model){
        if(module.id!=='untranslated'&&!row.target?.trim()){skip('missing_or_empty');continue;}
        if(['placeholder_mismatch','plural_mismatch'].includes(module.id)&&ctx.src.error){skip('invalid_source_structure');continue;}
        if(module.id==='placeholder_mismatch'&&ctx.tgt.error){skip('invalid_target_structure');continue;}
        const found=module.run(ctx);stat.assessed++;stat.findings+=found.length;report.issues.push(...found);continue;
      }
      const reason=modelEligible(row,ctx,module);
      if(reason){skip(reason);continue;}
      if(!client){stat.deferred++;continue;}
      try{
        onProgress(`${module.id}: ${row.key}`);
        const response=await client.check(module,row,config.locale);
        if(response.deferred){stat.deferred++;continue;}
        stat.assessed++;
        report.model_reviews.push({key:row.key,check:module.id,...response});
        if(response.review.verdict==='uncertain')stat.uncertain++;
        if(response.review.verdict==='error'){
          stat.findings++;
          report.issues.push(finding(ctx,module.id,response.review.reason,{detector:'qwen',source_quote:response.review.source_quote,target_quote:response.review.target_quote,suggestion:response.review.suggestion,suggestion_rejected:response.review.suggestion_rejected}));
        }
      }catch(e){stat.failed++;report.diagnostics.push({kind:'model_request_failed',check:module.id,key:row.key,error:e.message});}
      await checkpoint(report);
    }
    completed++;
    if(records.length<=100||completed%50===0||completed===records.length)onEvent({kind:'progress',completed,total:records.length,modules:counters,findings:report.issues.length,report});
  }
  return report;
}
