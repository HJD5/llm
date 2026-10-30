import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseTree,getNodeValue} from 'jsonc-parser';
export function parseArb(text, name='input.arb') {
  text=text.replace(/^\uFEFF/,'');
  const obj=JSON.parse(text); // Reject comments/trailing commas, retain duplicates below.
  if (!obj || Array.isArray(obj) || typeof obj!=='object') throw Error(`${name}: ARB root must be an object`);
  const tree=parseTree(text), entries=new Map(), metadata=new Map(), occurrences=new Map();
  let section='';
  for (const property of tree.children) {
    const key=property.children[0].value, value=getNodeValue(property.children[1]);
    const line=text.slice(0,property.offset).split('\n').length;
    if (key==='@@comment') {section=String(value);continue;}
    if (key.startsWith('@')) {metadata.set(key,value);continue;}
    const item={key,value,line,section};
    if (!occurrences.has(key)) occurrences.set(key,[]);
    occurrences.get(key).push(item); entries.set(key,item);
  }
  const diagnostics=[];
  for (const [key,items] of occurrences) if(items.length>1) diagnostics.push({kind:'duplicate_key',key,values:items,policy:'last occurrence used; earlier values require review'});
  for(const [key,item] of entries) if(typeof item.value!=='string') diagnostics.push({kind:'non_string_value',key,line:item.line});
  return {name,locale:metadata.get('@@locale'),entries,metadata,diagnostics,sha256:createHash('sha256').update(text).digest('hex')};
}
export async function loadArb(file){return parseArb(await fs.readFile(file,'utf8'),file);}
export function makeRecords(source,target,reference){
  return [...source.entries].filter(([k,v])=>k!=='lang' && typeof v.value==='string').map(([key,s])=>{
    const t=target.entries.get(key), sm=source.metadata.get('@'+key),tm=target.metadata.get('@'+key);
    return {key,source:s.value,target:typeof t?.value==='string'?t.value:null,source_line:s.line,target_line:t?.line??null,context:{section:s.section,description:typeof sm?.description==='string'?sm.description:'',english:reference?.entries.get(key)?.value??null},metadata:{source:sm??{},target:tm??{}}};
  });
}
