import {hasTarget} from '../shared.mjs';
import {norm} from '../message.mjs';
export default {id:'inconsistent_term',run(ctx){
  if(!hasTarget(ctx)||ctx.row.source.length>40)return [];
  const group=ctx.groups.get(norm(ctx.row.source))??[];
  // One comparison per group; a different translation alone is not a defect.
  if(group[0]?.key!==ctx.row.key)return [];
  const variants=[...new Set(group.map(r=>norm(r.target)))];
  if(variants.length<2)return [];
  return [{kind:'translation_comparison',check:'inconsistent_term',source:ctx.row.source,status:'needs_context',evidence:'Разные переводы могут быть допустимы в разных контекстах. Сравните назначение строк; наличие вариантов само по себе не является ошибкой.',variants,rows:group.map(r=>({key:r.key,source:r.source,target:r.target,context:r.context??{}}))}];
}};
