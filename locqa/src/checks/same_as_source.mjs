import {finding,hasTarget} from '../shared.mjs';
import {norm} from '../message.mjs';
export default {id:'same_as_source',run(ctx){
  const {row,config}=ctx;
  if(!hasTarget(ctx)||norm(row.source)!==norm(row.target)||ctx.allowedUnchanged)return [];
  if(!/\p{L}/u.test(row.source)||row.key==='currencySymbol')return [];
  if(!/[А-Яа-яЁё]/u.test(row.source))return []; // This module is RU→KK scoped.
  return [finding(ctx,'same_as_source','Перевод совпадает с русским. Имя, бренд или допустимый общий термин нужно подтвердить по контексту.')];
}};
