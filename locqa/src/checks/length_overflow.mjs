import {finding,hasTarget} from '../shared.mjs';
export default {id:'length_overflow',run(ctx){
  if(!hasTarget(ctx))return [];
  const {row,config}=ctx,s=[...row.source].length,t=[...row.target].length;
  const max=config.max_chars?.[row.key];
  if(Number.isInteger(max)&&max>=0)return t>max?[finding(ctx,'length_overflow',`Длина ${t} Unicode-кодовых точек превышает заданный предел ${max}. Это ограничение длины, не измерение пикселей.`,{status:'constraint',severity:'high'})]:[];
  return /button|btn|title|tab|header/i.test(row.key)&&s>=2&&s<=35&&t>Math.max(s*1.8,s+10)?[finding(ctx,'length_overflow',`Возможный короткий UI: ${t} символов вместо ${s}. Размеры неизвестны; визуальное обрезание не подтверждено.`,{severity:'low'})]:[];
}};
