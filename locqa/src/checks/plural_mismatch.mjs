import {finding,hasTarget} from '../shared.mjs';
import {structureProblems} from '../message.mjs';
export default {id:'plural_mismatch',run(ctx){
  if(!hasTarget(ctx)||ctx.src.error)return [];
  const errors=structureProblems(ctx.src,ctx.tgt,ctx.config.locale);
  return errors.length?[finding(ctx,'plural_mismatch',errors.join('; '),{severity:'high',status:'structural'})]:[];
}};
