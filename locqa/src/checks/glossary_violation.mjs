import {finding,hasTarget} from '../shared.mjs';
import {norm} from '../message.mjs';
const containsWord=(text,phrase)=>{
 const s=norm(text),p=norm(phrase);let at=s.indexOf(p);
 while(at>=0){const before=s.slice(0,at).at(-1)??'',after=s.slice(at+p.length)[0]??'';if(!/\p{L}/u.test(before)&&!/\p{L}/u.test(after))return true;at=s.indexOf(p,at+1);}return false;
};
export default {id:'glossary_violation',run(ctx){
  if(!hasTarget(ctx))return [];
  const terms=ctx.glossary.filter(t=>(!t.key||t.key===ctx.row.key)&&(t.match_mode==='phrase'?[t.ru,...(t.source_variants??[])].some(s=>containsWord(ctx.row.source,s)):norm(t.ru)===norm(ctx.row.source)));
  if(!terms.length)return [];
  const phraseViolations=terms.filter(t=>t.match_mode==='phrase'&&![t.kk,...(t.variants??[])].some(s=>containsWord(ctx.row.target,s)));
  if(phraseViolations.length)return [finding(ctx,'glossary_violation',`Не найден допустимый термин/явно заданная словоформа: ${phraseViolations.map(t=>t.kk).join(', ')}. Проверить контекст; неизвестная словоформа остаётся кандидатом.`,{severity:'low'})];
  const exact=terms.filter(t=>t.match_mode!=='phrase');if(!exact.length)return [];
  const accepted=exact.flatMap(t=>[t.kk,...(t.variants??[])]).map(norm);
  if(accepted.includes(norm(ctx.row.target)))return [];
  return [finding(ctx,'glossary_violation',`Для точного исходного термина указаны варианты: ${accepted.join(', ')}. Проверить контекст и словоформу; глоссарий не заменяет морфологический анализ.`)];
}};
