import {finding,hasTarget} from '../shared.mjs';
export default {id:'suffix_harmony',run(ctx){
  if(!hasTarget(ctx)||ctx.config.locale!=='kk')return [];
  const hits=[...ctx.row.target.matchAll(/\{([A-Za-z_][A-Za-z_0-9]*)\}[-–]?(ға|ге|қа|ке|ның|нің|дың|дің|тың|тің|ны|ні|ды|ді|ты|ті|мен|бен|пен|дан|ден|тан|тен|нан|нен)(?!\p{L})/gu)];
  return hits.length?[finding(ctx,'suffix_harmony',`Окончание прикреплено к переменной: ${hits.map(m=>m[0]).join(', ')}. Это риск при разных значениях, не доказательство ошибки конкретного имени. Нужны тип аргумента и контекст.`,{severity:'low'})]:[];
}};
