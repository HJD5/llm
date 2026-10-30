export function finding(ctx,type,evidence,options={}){
  return {key:ctx.row.key,issue_type:type,severity:'medium',source:ctx.row.source,target:ctx.row.target,evidence,suggestion:null,confidence:null,reviewed_by_human:false,status:'candidate',detector:'code',...options};
}
export function hasTarget(ctx){return typeof ctx.row.target==='string'&&ctx.row.target.trim()!=='';}
