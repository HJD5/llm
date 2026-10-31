import {exportGlossary} from './glossary-review.mjs';
import {norm} from '../locqa/src/message.mjs';
import {exportApproved} from './recommendations.mjs';
// An approved glossary decision applies only within its reviewed ARB contexts.
// New/unseen keys are never silently rewritten by a global term rule.
export function glossaryFixPlan(dataset,entries){
 exportGlossary(entries); // Reuse scope, language, structure and conflict validation.
 const proposals={},unchanged=[],blocked=[];
 for(const entry of entries.filter(e=>e.status==='approved'&&e.reviewed_by_human===true&&e.decision?.confirm===true&&e.decision.reviewer?.trim())){
  const decision=entry.decision,scope=decision.key??entry.original.key??'';
  const contexts=[...(entry.contexts??[]),...(entry.shortlist?.contexts??[])];
  const related=[...new Set([...(entry.original.related_keys??'').split('|'),...contexts.map(x=>x.key),...(entry.context_groups??[]).flatMap(x=>x.keys)].filter(Boolean))];
  const rows=dataset.rows.filter(r=>norm(r.source)===norm(entry.original.ru)&&(!scope||scope===r.key));
  if(!rows.length){blocked.push({term:entry.original.ru,reason:'no_matching_source_key'});continue;}
  for(const row of rows){
   if(row.target===decision.translation){unchanged.push(row.key);continue;}
   const evidence=contexts.some(c=>c.key===row.key&&c.kk===row.target&&(!c.ru||c.ru===row.source)&&(!c.en||norm(c.en)===norm(row.context?.english??'')))||(entry.context_groups??[]).some(g=>g.keys.includes(row.key)&&g.kk===row.target&&(!g.english||norm(g.english)===norm(row.context?.english??'')));
   if(!related.includes(row.key)||!evidence){blocked.push({key:row.key,reason:'unreviewed_or_changed_arb_context'});continue;}
   const id=entry.id+':'+row.key;
   const previous=Object.values(proposals).find(p=>p.key===row.key);
   if(previous){if(previous.translation!==decision.translation)throw Error('Conflicting corrections for '+row.key);continue;}
   proposals[id]={key:row.key,original:row.target,translation:decision.translation,status:'approved',reviewer:decision.reviewer,reviewedAt:decision.at,note:decision.note??'',sourceHash:dataset.sourceHash,targetHash:dataset.targetHash,glossaryEntry:entry.id};
  }
 }
 return {proposals,unchanged:[...new Set(unchanged)],blocked,approved_changes:Object.keys(proposals).length,pending_terms:entries.filter(e=>e.status==='proposed').length};
}
export function glossaryFixedArb(dataset,entries){
 const plan=glossaryFixPlan(dataset,entries);
 if(plan.blocked.length)throw Error('Есть изменённые или непроверенные контексты. Обновите проверку глоссария: '+JSON.stringify(plan.blocked.slice(0,5)));
 if(!plan.approved_changes)throw Error('Нет одобренных изменений ARB. Сначала подтвердите исправленные переводы и ключи в глоссарии.');
 return {text:exportApproved(dataset,plan.proposals),plan};
}
