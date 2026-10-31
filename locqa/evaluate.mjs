// Run labeled detector cases against the real endpoint. No mocked inference.
import fs from 'node:fs/promises';
import path from 'node:path';
import {QwenClient} from './src/qwen.mjs';
import {modules} from './src/engine.mjs';
const [casesFile,configFile,outFile]=process.argv.slice(2);
if(!casesFile||!configFile||!outFile)throw Error('Usage: node locqa/evaluate.mjs cases.json config.json results.json');
if([casesFile,configFile].some(p=>path.resolve(p).toLowerCase()===path.resolve(outFile).toLowerCase()))throw Error('Output must not overwrite inputs');
const cases=JSON.parse(await fs.readFile(casesFile,'utf8'));
const config=JSON.parse(await fs.readFile(configFile,'utf8'));
if(!Array.isArray(cases)||!cases.length)throw Error('Expected nonempty labeled cases array');
for(const c of cases)if(!modules.some(m=>m.model&&m.id===c.check)||!['issue','no_issue'].includes(c.expected)||typeof c.source!=='string'||typeof c.target!=='string')throw Error('Each case needs source, target, check, expected issue|no_issue');
const client=new QwenClient({endpoint:config.endpoint??'http://127.0.0.1:8088/v1/chat/completions',modelRevision:config.model_revision??'unspecified',cacheDir:path.join(path.dirname(outFile),'eval-cache'),maxCalls:cases.length*2,maxRetries:config.llm_max_retries??1,maxTokens:config.llm_max_tokens??768,timeoutMs:config.llm_timeout_ms??240000});
const results=[];
for(const [i,c] of cases.entries()){
 console.log(`${i+1}/${cases.length} ${c.check} ${c.key??i}`);
 try{const result=await client.check(modules.find(m=>m.id===c.check),{...c,key:c.key??String(i),context:c.context??{}},'kk');results.push({...c,result,predicted:result.review?.verdict??'deferred'});}
 catch(e){results.push({...c,predicted:'failed',error:e.message,attempts:e.attempts});}
}
const scores={};
for(const check of new Set(cases.map(c=>c.check))){
 const rows=results.filter(c=>c.check===check);
 const tp=rows.filter(c=>c.expected==='issue'&&c.predicted==='error').length;
 const fp=rows.filter(c=>c.expected==='no_issue'&&c.predicted==='error').length;
 const fn=rows.filter(c=>c.expected==='issue'&&c.predicted!=='error').length;
 const tn=rows.filter(c=>c.expected==='no_issue'&&c.predicted==='clear').length;
 const unresolved=rows.filter(c=>!['clear','error'].includes(c.predicted)).length;
 scores[check]={total:rows.length,tp,fp,fn,tn,unresolved,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null,coverage:(rows.length-unresolved)/rows.length};
}
await fs.mkdir(path.dirname(outFile),{recursive:true});
await fs.writeFile(outFile,JSON.stringify({created_at:new Date().toISOString(),note:'Recall counts unresolved positive cases as missed; unresolved negatives are not true negatives. Labels require human review. Small regression fixtures do not estimate overall accuracy.',scores,model_calls:client.calls,results},null,2));
console.log(JSON.stringify(scores,null,2));
if(results.some(r=>r.predicted==='failed'))process.exitCode=2;
