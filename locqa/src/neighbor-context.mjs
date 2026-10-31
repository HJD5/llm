export function withNeighborContext(records){
 const snippet=r=>({key:r.key,source:r.source.slice(0,240),target:r.target?.slice(0,240)??null,english:r.context?.english?.slice(0,240)??null});
 return records.map((r,i)=>({...r,context:{...r.context,neighbors:[records[i-1],records[i+1]].filter(x=>x&&x.context?.section===r.context?.section).map(snippet)}}));
}
