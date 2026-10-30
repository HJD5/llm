import {finding,hasTarget} from '../shared.mjs';
import {norm} from '../message.mjs';
export default {id:'glossary_violation',run(ctx){
  if(!hasTarget(ctx))return [];
  const terms=ctx.glossary.filter(t=>norm(t.ru)===norm(ctx.row.source)&&(!t.key||t.key===ctx.row.key));
  if(!terms.length)return [];
  const accepted=terms.flatMap(t=>[t.kk,...(t.variants??[])]).map(norm);
  if(accepted.includes(norm(ctx.row.target)))return [];
  return [finding(ctx,'glossary_violation',`Для точного исходного термина указаны варианты: ${accepted.join(', ')}. Проверить контекст и словоформу; глоссарий не заменяет морфологический анализ.`)];
}};
