import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseDraft,digest} from '../locqa/src/glossary-review.mjs';
import {glossaryCsv,glossaryColumns} from '../locqa/src/glossary.mjs';
import {norm} from '../locqa/src/message.mjs';
import {contextPolicy,validateKkCandidate} from '../locqa/src/glossary-validation.mjs';

function scopePolicy(entry){
  return contextPolicy(entry.original,[...entry.contexts,...(entry.context_groups??[]).flatMap(g=>g.keys.map(key=>({key,en:g.english,kk:g.kk}))),...(entry.shortlist?.contexts??[])]);
}
function validateDecision(entry,translation,key){
  const policy=scopePolicy(entry);
  if(typeof key!=='string'||(entry.original.key&&key!==entry.original.key)||(key&&!policy.keys.includes(key)))throw Error('Выберите существующий ключ исходного термина');
  if(policy.requires_key_scope&&!key)throw Error('Разные контексты: выберите один key; общий перевод утверждать нельзя');
  const all=[...entry.contexts,...(entry.shortlist?.contexts??[])],contexts=key?all.filter(c=>c.key===key):all;
  const check=validateKkCandidate(entry.original,translation,{contexts});
  if(!entry.original.ru.trim()||!check.valid)throw Error('Перевод не прошёл проверку: '+check.issues.join(', '));
}

function importEntries(text){
  const {rows}=parseDraft(text),seen=new Set();
  return rows.map(row=>{
    if(!row.review_id||seen.has(row.review_id)||!row.original_json)throw Error('Нужен CSV команды review-glossary с уникальными review_id');
    seen.add(row.review_id);
    const original=JSON.parse(row.original_json);
    if(!original||Array.isArray(original)||typeof original.ru!=='string'||typeof original.kk!=='string'||Object.values(original).some(v=>typeof v!=='string')||row.ru!==original.ru||row.kk!==original.kk)throw Error('Неверные исходные данные термина');
    if(!['pending','rules','reviewed','deferred','failed'].includes(row.review_state)||!['keep','change','uncertain','unsuitable'].includes(row.review_verdict)||!['normal','medium','high'].includes(row.review_priority))throw Error('Неверные поля проверки глоссария');
    const contexts=JSON.parse(row.review_context||'[]');if(!Array.isArray(contexts))throw Error('Неверный ARB-контекст');
    if(contexts.some(c=>!c||typeof c.key!=='string'||Object.entries(c).some(([k,v])=>['ru','kk','en','section','description'].includes(k)&&v!==null&&typeof v!=='string')))throw Error('Неверные поля ARB-контекста');
    const groups=JSON.parse(row.review_context_groups||'[]');
    if(!Array.isArray(groups)||groups.some(g=>!g||typeof g.english!=='string'||typeof g.kk!=='string'||!Array.isArray(g.keys)||g.keys.some(k=>typeof k!=='string')))throw Error('Неверные группы контекстов');
    const entry={id:row.review_id,original,recommended_kk:row.recommended_kk||null,review_state:row.review_state,verdict:row.review_verdict,priority:row.review_priority,explanation:row.review_explanation,flags:(row.review_flags??'').split('|').filter(Boolean),contexts,context_groups:groups,validation_flags:(row.review_validation_flags??'').split('|').filter(Boolean),rejected_kk:row.review_rejected_kk||null,recommendation_source:row.review_recommendation_source||'qwen'};
    if(row.shortlist_group){
      const rank=Number(row.shortlist_rank),usage=Number(row.shortlist_usage_count),currentContexts=JSON.parse(row.shortlist_arb_context||'[]');
      if(!['existing_translation','needs_attention'].includes(row.shortlist_group)||!Number.isSafeInteger(rank)||rank<1||rank>10000||!Number.isSafeInteger(usage)||usage<0||!Array.isArray(currentContexts)||currentContexts.some(c=>!c||typeof c.key!=='string'||['ru','kk','en','section','description'].some(k=>c[k]!==null&&c[k]!==undefined&&typeof c[k]!=='string')))throw Error('Неверные данные shortlist');
      entry.shortlist={rank,usage,group:row.shortlist_group,domain:row.shortlist_domain??'',flags:(row.shortlist_attention_flags??'').split('|').filter(Boolean),comment:row.shortlist_usage_comment??'',reason:row.shortlist_selection_reason??'',contexts:currentContexts};
    }
    const policy=scopePolicy(entry);entry.requires_key_scope=policy.requires_key_scope;entry.scope_keys=policy.keys;
    const fingerprint={...entry};delete fingerprint.shortlist;
    const saved=[...contexts,...groups.flatMap(g=>g.keys.map(key=>({key,en:g.english,kk:g.kk})))];
    const additional=(entry.shortlist?.contexts??[]).filter(c=>!saved.some(old=>old.key===c.key&&norm(old.kk??'')===norm(c.kk??'')&&norm(old.en??'')===norm(c.en??'')));
    if(additional.length)fingerprint.additional_arb_context=additional;
    return {...entry,source_fingerprint:digest(fingerprint),status:'proposed',reviewed_by_human:false,decision:null,history:[]};
  });
}
export function exportGlossary(entries){
  const approved=entries.filter(r=>r.status==='approved'&&r.reviewed_by_human===true&&r.decision?.confirm===true&&r.decision.reviewer?.trim());
  for(const entry of approved){
    validateDecision(entry,entry.decision.translation,entry.decision.key??entry.original.key??'');
  }
  // Overlapping global/key scopes cannot silently introduce contradictory checker rules.
  for(let i=0;i<approved.length;i++)for(let j=0;j<i;j++){
    const a=approved[i],b=approved[j];
    const ak=a.decision.key??a.original.key??'',bk=b.decision.key??b.original.key??'';
    if(norm(a.original.ru)===norm(b.original.ru)&&(!ak||!bk||ak===bk)&&norm(a.decision.translation)!==norm(b.decision.translation))throw Error('Конфликт утверждённых переводов: '+a.original.ru+'. Уточните key или оставьте один вариант.');
  }
  const columns=[...glossaryColumns,...['source_variants','match_mode','verification'].filter(k=>approved.some(r=>Object.hasOwn(r.original,k)))];
  return glossaryCsv(approved.map(r=>({...r.original,kk:r.decision.translation,key:r.decision.key??r.original.key??'',status:'approved',reviewer:r.decision.reviewer})),columns);
}
export class GlossaryReviewStore{
  constructor(file){this.file=file;this.state={version:1,revision:null,entries:[]};this.queue=Promise.resolve();}
  async load(){try{this.state=JSON.parse(await fs.readFile(this.file,'utf8'));if(this.state.version!==1||!Array.isArray(this.state.entries))throw Error('Invalid glossary review store');for(const entry of this.state.entries){const policy=scopePolicy(entry);entry.requires_key_scope=policy.requires_key_scope;entry.scope_keys=policy.keys;}}catch(e){if(e.code!=='ENOENT')throw e;}return this;}
  mutate(fn){
    const task=this.queue.catch(()=>{}).then(async()=>{
      const next=structuredClone(this.state);await fn(next);next.revision=randomUUID();
      const tmp=this.file+'.tmp';await fs.writeFile(tmp,JSON.stringify(next,null,2));await fs.rename(tmp,this.file);this.state=next;return this.view();
    });this.queue=task;return task;
  }
  view(){const counts={proposed:0,approved:0,rejected:0};for(const r of this.state.entries)counts[r.status]++;return {...this.state,counts};}
  async import(text,revision){
    const entries=importEntries(text);
    return this.mutate(async next=>{
      if(revision!==next.revision)throw Error('Глоссарий изменился: обновите список');
      // Preserve complete prior lists/decisions when importing a smaller shortlist.
      if(next.entries.length){
        const archiveDir=path.join(path.dirname(this.file),'glossary-review-archive');await fs.mkdir(archiveDir,{recursive:true});
        const archive=path.join(archiveDir,digest(next)+'.json');
        try{await fs.writeFile(archive,JSON.stringify(next,null,2),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
        next.previous_import_archive=archive;
      }
      const previous=new Map(next.entries.map(r=>[r.id,r]));
      next.entries=entries.map(entry=>{
        const old=previous.get(entry.id);
        return old?.source_fingerprint===entry.source_fingerprint?{...old,...(entry.shortlist?{shortlist:entry.shortlist}:{})}:{...entry,history:old?[...(old.history??[]),{...old,history:undefined}]:[]};
      });next.importedAt=new Date().toISOString();
    });
  }
  async decide({revision,entries,status,reviewer,note='',confirm}){
    if(!['approved','rejected','proposed'].includes(status)||confirm!==true||typeof reviewer!=='string'||!reviewer.trim()||reviewer.length>100||typeof note!=='string'||note.length>2000||!Array.isArray(entries)||!entries.length||entries.length>100||new Set(entries.map(e=>e.id)).size!==entries.length)throw Error('Выберите 1–100 терминов, укажите имя и явно подтвердите решение');
    return this.mutate(next=>{
      if(revision!==next.revision)throw Error('Глоссарий изменился: обновите список перед решением');
      for(const choice of entries){
        const entry=next.entries.find(r=>r.id===choice.id);if(!entry)throw Error('Термин не найден');
        const key=choice.key??entry.original.key??'';
        if(status==='approved')validateDecision(entry,choice.translation,key);
        if(entry.decision)entry.history.push(entry.decision);
        entry.status=status;entry.reviewed_by_human=status!=='proposed';
        entry.decision={status,translation:status==='approved'?choice.translation:null,key:status==='approved'?key:null,reviewer:reviewer.trim(),note,confirm:true,at:new Date().toISOString()};
      }
      exportGlossary(next.entries); // Validate the entire batch before any state is persisted.
    });
  }
  async flush(){await this.queue.catch(()=>{});}
}
