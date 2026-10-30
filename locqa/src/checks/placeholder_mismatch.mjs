import {finding,hasTarget} from '../shared.mjs';
import {same} from '../message.mjs';
export default {id:'placeholder_mismatch',run(ctx){
  if(!hasTarget(ctx)||ctx.src.error||ctx.tgt.error)return [];
  if(same(ctx.src.args,ctx.tgt.args)&&same(ctx.src.printf,ctx.tgt.printf))return [];
  return [finding(ctx,'placeholder_mismatch',`Аргументы: ${JSON.stringify({source:ctx.src.args,target:ctx.tgt.args,source_printf:ctx.src.printf,target_printf:ctx.tgt.printf})}`,{severity:'high',status:'structural'})];
}};
