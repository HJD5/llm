import {finding,hasTarget} from '../shared.mjs';
import {norm} from '../message.mjs';
export default {id:'inconsistent_term',run(ctx){
  if(!hasTarget(ctx)||ctx.row.source.length>40)return [];
  const group=ctx.groups.get(norm(ctx.row.source))??[];
  const variants=[...new Set(group.map(r=>norm(r.target)))];
  if(variants.length<2)return [];
  return [finding(ctx,'inconsistent_term',`Одинаковый короткий исходный текст имеет ${variants.length} варианта в ${group.length} ключах. Различия могут быть обусловлены контекстом.`,{severity:'low',related_keys:group.map(r=>r.key),variants})];
}};
