import {createHash} from 'node:crypto';
export const entityTypes=['person','brand','city','country','unknown'];
export const entityFingerprint=row=>createHash('sha256').update(JSON.stringify([row.key,row.source,row.target,row.context??{}])).digest('hex');
export function entityHint(row){
 const key=row.key.replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase();
 if(row.source.length>80||/[{}<>\n]/.test(row.source))return null;
 for(const [type,pattern] of [['country',/\bcountr(?:y|ies)\b/],['city',/\b(?:city|cities|town)\b/],['brand',/\b(?:brand|manufacturer)\b/],['person',/\b(?:firstname|surname|nickname|person)\b/]]){
  if(pattern.test(key.replace(/[_-]/g,' ')))return {type,reason:'Название ключа указывает на возможное имя или название. Это подсказка, не подтверждение.'};
 }
 if(/^[\p{Lu}][\p{Ll}]+(?:[ -][\p{Lu}][\p{Ll}]+){1,3}$/u.test(row.source))return {type:'unknown',reason:'Несколько слов с прописной буквы: возможно название. Требуется проверить контекст.'};
 return null;
}
export function approvedEntity(row,exceptions=[]){return exceptions.find(x=>x.status==='approved'&&x.check==='same_as_source'&&x.fingerprint===entityFingerprint(row));}
