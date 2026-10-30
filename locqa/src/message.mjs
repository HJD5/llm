import {parse,TYPE} from '@formatjs/icu-messageformat-parser';
export const norm=s=>s.normalize('NFC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
export const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function printfArguments(text){
  const found=[];let next=1;
  const pattern=/%%|%(?:(\d+)\$)?[-+0 #]*(?:\d+)?(?:\.\d+)?([sdifouxXeEgGc])/g;
  for(const m of text.matchAll(pattern)) if(m[0]!=='%%')found.push(`${m[1]??next++}:${m[2]}`);
  return found.sort();
}
export function analyzeMessage(text){
  const info={args:[],roles:[],selectors:[],printf:printfArguments(text),error:null};
  try{
    const ast=parse(text,{ignoreTag:true,requiresOtherClause:true});
    const args=new Set(),roles=new Set();
    function walk(nodes){for(const n of nodes){
      if([TYPE.argument,TYPE.number,TYPE.date,TYPE.time,TYPE.select,TYPE.plural].includes(n.type)){
        args.add(n.value);roles.add(`${n.value}:${n.type}${n.type===TYPE.plural?':'+n.pluralType:''}`);
      }
      if(n.type===TYPE.plural||n.type===TYPE.select){
        info.selectors.push({arg:n.value,kind:n.type===TYPE.select?'select':n.pluralType,offset:n.offset??0,options:Object.keys(n.options).sort()});
        for(const option of Object.values(n.options))walk(option.value);
      }
      if(n.children)walk(n.children);
    }}walk(ast);info.args=[...args].sort();info.roles=[...roles].sort();
  }catch(e){info.error=e.message;}
  return info;
}
export function structureProblems(s,t,locale='kk'){
  if(s.error)return [];
  if(t.error)return [`Некорректный ICU/синтаксис аргументов: ${t.error}`];
  const problems=[];
  for(const src of s.selectors){
    const targets=t.selectors.filter(x=>x.arg===src.arg&&x.kind===src.kind);
    if(!targets.length){problems.push(`Исчезла конструкция ${src.kind} для ${src.arg}`);continue;}
    if(!targets.some(dst=>dst.offset===src.offset&&src.options.filter(x=>src.kind==='select'||x.startsWith('=')).every(x=>dst.options.includes(x))))problems.push(`Изменены offset или явные варианты для ${src.arg}`);
  }
  for(const dst of t.selectors){
    if(!s.selectors.some(x=>x.arg===dst.arg&&x.kind===dst.kind))problems.push(`Добавлена/изменена конструкция ${dst.kind} для ${dst.arg}`);
    if(dst.kind!=='select'){
      let categories;
      try{categories=new Intl.PluralRules(locale.replace('_','-'),{type:dst.kind}).resolvedOptions().pluralCategories;}catch{continue;}
      const invalid=dst.options.filter(x=>!x.startsWith('=')&&!categories.includes(x));
      if(invalid.length)problems.push(`Недопустимые категории для ${locale}: ${invalid.join(', ')}`);
    }
  }
  return problems;
}
export function validateSuggestion(row,text,locale){
  if(text===null)return {suggestion:null,reason:null};
  if(typeof text!=='string'||!text.trim())return {suggestion:null,reason:'empty_suggestion'};
  const s=analyzeMessage(row.source),t=analyzeMessage(text);
  if(s.error||t.error||!same(s.args,t.args)||!same(s.printf,t.printf)||!same(s.roles,t.roles)||structureProblems(s,t,locale).length)return {suggestion:null,reason:'structure_mismatch'};
  // Retain HTML tags, not just ICU arguments.
  const tags=x=>(x.match(/<\/?[A-Za-z][^>]*>/g)??[]).sort();
  if(!same(tags(row.source),tags(text)))return {suggestion:null,reason:'markup_mismatch'};
  return {suggestion:text,reason:null};
}
