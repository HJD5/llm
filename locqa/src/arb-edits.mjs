import {parseTree,getNodeValue,modify,applyEdits} from 'jsonc-parser';
import {parseArb} from './arb.mjs';
import {validateSuggestion} from './message.mjs';
export function applyReviewedMachineEdits(text,source,decisions){
 text=text.replace(/^\uFEFF/,'');
 const inputText=text;
 const original=parseArb(text),seen=new Set(),changes=[];
 // All duplicate occurrences survive. Identical meanings may be corrected in
 // every occurrence; a conflicting duplicate must be resolved explicitly first.
 for(const decision of decisions){
  const {key,after}=decision;if(seen.has(key))throw Error('Repeated correction '+key);seen.add(key);
  const src=source.entries.get(key);if(typeof src?.value!=='string')throw Error('Missing source '+key);
  if(source.diagnostics.some(d=>d.kind==='duplicate_key'&&d.key===key&&new Set(d.values.map(v=>v.value)).size>1))throw Error('Conflicting duplicate source '+key);
  const checked=validateSuggestion({source:src.value},after,'kk');if(checked.reason)throw Error(key+': '+checked.reason);
  const tree=parseTree(text),properties=tree.children.filter(n=>n.children[0].value===key);
  const values=properties.map(n=>getNodeValue(n.children[1]));
  if(new Set(values).size>1&&values.some(v=>v!==after&&v!==decision.before))throw Error('Unresolved duplicate values '+key);
  const before=original.entries.get(key)?.value??null;
  if(decision.before!==undefined&&decision.before!==before)throw Error('Stale correction '+key);
  if(before===after&&values.every(v=>v===after))continue;
  let count=0;
  if(properties.length){const edits=properties.filter(n=>getNodeValue(n.children[1])!==after).map(n=>{count++;return {offset:n.children[1].offset,length:n.children[1].length,content:JSON.stringify(after)};});text=applyEdits(text,edits);}
  else{
   const order=[...source.entries.keys()],rank=order.indexOf(key),placements=[];let section='';
   for(const [index,node] of tree.children.entries()){const name=node.children[0].value;if(name==='@@comment')section=String(getNodeValue(node.children[1]));placements.push({key:name,index,section});}
   const next=order.slice(rank+1).map(k=>placements.find(p=>p.key===k&&p.section===src.section)).find(Boolean);
   const previous=order.slice(0,rank).reverse().map(k=>placements.findLast(p=>p.key===k&&p.section===src.section)).find(Boolean);
   const insertion=next?.index??(previous?previous.index+1:tree.children.length);
   text=applyEdits(text,modify(text,[key],after,{getInsertionIndex:()=>insertion,formattingOptions:{insertSpaces:true,tabSize:2}}));count=1;
  }
  const metaKey='@'+key,metadataNodes=parseTree(text).children.filter(n=>n.children[0].value===metaKey);
  if(metadataNodes.length>1)throw Error('Ambiguous metadata '+metaKey);
  const metadata=metadataNodes.length?getNodeValue(metadataNodes[0].children[1]):source.metadata.get(metaKey)??{};
  if(!metadata||Array.isArray(metadata)||typeof metadata!=='object')throw Error('Invalid metadata '+metaKey);
  text=applyEdits(text,modify(text,[metaKey],{...metadata,reviewed_by_human:false,locqa_review:{status:'machine_cross_checked_needs_native_review',prepared_by:'Codex',issue_type:decision.type}},{getInsertionIndex:properties=>properties.lastIndexOf(key)+1,formattingOptions:{insertSpaces:true,tabSize:2}}));
  changes.push({...decision,before,source:src.value,occurrences_changed:count,reviewed_by_human:false});
 }
 const result=parseArb(text);
 for(const [key,entry] of original.entries)if(!seen.has(key)&&result.entries.get(key)?.value!==entry.value)throw Error('Unintended value change '+key);
 const rawProperties=x=>parseTree(x).children.filter(n=>n.children[0].value==='@@comment').map(n=>getNodeValue(n.children[1]));
 if(JSON.stringify(rawProperties(text))!==JSON.stringify(rawProperties(inputText)))throw Error('Section comments changed');
 if(result.diagnostics.filter(d=>d.kind==='duplicate_key').length!==original.diagnostics.filter(d=>d.kind==='duplicate_key').length)throw Error('Duplicate keys lost');
 return {text,changes,parsed:result};
}
