import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseDraft,prepareReview,reviewBody,reviewCsv,runReview,validateGlossaryReview} from '../src/glossary-review.mjs';
import {QwenClient} from '../src/qwen.mjs';
import {glossaryCsv,readGlossary} from '../src/glossary.mjs';

const draft=rows=>parseDraft(glossaryCsv(rows.map(r=>({ru:'Награда',kk:'Сыйақы',status:'proposed',...r}))));
const state=rows=>{const d=draft(rows);return {columns:d.columns,rows:prepareReview(d)};};
const result=(r,overrides={})=>({id:r.id,verdict:'keep',recommended_kk:r.original.kk,reason:'Корректный перевод по контексту.',priority:'normal',...overrides});
const reply=(value,finish_reason='stop')=>({ok:true,json:async()=>({choices:[{finish_reason,message:{content:typeof value==='string'?value:JSON.stringify(value)}}]})});
async function makeClient(t,request,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'glossary-review-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return new QwenClient({endpoint:'http://127.0.0.1:8088/v1/chat/completions',modelRevision:'mock',cacheDir:dir,request,maxRetries:0,...options});
}

test('rules preserve every duplicate and original CSV field, flag conflicts/empty/unsuitable without linguistic guesses',()=>{
  const d=parseDraft('ru,kk,en,status,reviewer,category,observed_variants,related_keys,custom\r\n"Пропустить",Өткізу,Skip,approved,Old reviewer,UI,Өткізу,a,"comma, quote "" newline\nvalue"\r\nПропустить,Айналып өту,Skip,proposed,,UI,Айналып өту,b,x\r\n123,,Number,proposed,,,,c,z\r\nСыйақыны,Сыйақыны,Reward,proposed,,,,d,y\r\n');
  const rows=prepareReview(d,[{key:'a',source:'Пропустить',target:'Өткізу',context:{english:'Skip',description:'Skip tutorial',section:'UI'}}]);
  assert.equal(rows.length,4);assert.ok(rows[0].flags.includes('duplicate_ru'));assert.ok(rows[0].flags.includes('conflicting_translations'));
  assert.deepEqual(rows[2].flags,['empty_kk','unsuitable_term']);assert.equal(rows[2].review_state,'rules');assert.equal(rows[3].review_state,'pending');assert.deepEqual(rows[3].flags,[]);
  const csv=parseDraft(reviewCsv({columns:d.columns,rows}));
  for(let i=0;i<rows.length;i++){assert.deepEqual(JSON.parse(csv.rows[i].original_json),d.rows[i]);assert.equal(csv.rows[i].status,'proposed');assert.equal(csv.rows[i].reviewed_by_human,'false');}
  assert.equal(csv.rows[0].original_status,'approved');assert.equal(csv.rows[0].original_reviewer,'Old reviewer');assert.equal(rows[0].contexts[0].description,'Skip tutorial');
  assert.ok(prepareReview(draft([{},{}]))[0].flags.includes('exact_duplicate'));
});

test('structured protocol rejects missing/duplicate/foreign ids, fabricated approvals and unsupported suggestions',()=>{
  const s=state([{},{}]),a=s.rows[0],b=s.rows[1];
  assert.equal(validateGlossaryReview({results:[result(b),result(a)]},s.rows).length,2);
  for(const value of [{results:[result(a)]},{results:[result(a),result(a)]},{results:[result(a),result(b,{id:'invented'})]},{results:[result(a),result(b,{approved:true})]},{results:[result(a),result(b,{verdict:'uncertain'})]}])assert.throws(()=>validateGlossaryReview(value,s.rows));
  assert.equal(validateGlossaryReview({results:[result(a),result(b,{recommended_kk:'Иной'})]},s.rows)[1].verdict,'uncertain');
  const placeholders=prepareReview(draft([{ru:'Игрок {name}',kk:'Ойыншы {name}'}]));
  assert.equal(validateGlossaryReview({results:[result(placeholders[0],{verdict:'change',recommended_kk:'Ойыншы'})]},placeholders)[0].verdict,'uncertain');
  const inconsistent=validateGlossaryReview({results:s.rows.map(r=>result(r,{verdict:'change'}))},s.rows);assert.ok(inconsistent.every(r=>r.verdict==='uncertain'&&r.recommended_kk===null));
  const upper=state([{kk:'ЖАЛҒАСТЫРУ'}]).rows;assert.equal(validateGlossaryReview({results:[result(upper[0],{recommended_kk:'Жалғастыру'})]},upper)[0].recommended_kk,'ЖАЛҒАСТЫРУ');
});

test('small batches shrink to exact context budget, carry English/variants/context, preserve all nonselected rows and resume',async()=>{
  const s=state(Array.from({length:7},(_,i)=>({ru:'Термин '+i,en:'Term '+i,observed_variants:'Сыйақы|Марапат',category:'FAMILY'})));
  const sizes=[];let saves=0;
  const client={calls:0,cacheHits:0,countChatTokens:async body=>{const n=JSON.parse(body.messages[1].content).terms.length;return n===3?4000:900;},structured:async(body,validate)=>{
    assert.match(body.messages[0].content,/correct literal translation/);assert.match(body.messages[0].content,/resemblance alone/);assert.match(body.messages[0].content,/never approvals/);
    const terms=JSON.parse(body.messages[1].content).terms;sizes.push(terms.length);assert.equal(terms[0].en.startsWith('Term'),true);assert.equal(terms[0].observed_variants.length,2);
    client.calls++;return {review:validate({results:terms.map(r=>result(s.rows.find(x=>x.id===r.id)))}),request_hash:'test'};
  }};
  await runReview(s,{client,limit:5,batchSize:3,save:async()=>{saves++;}});
  assert.deepEqual(sizes,[2,2,1]);assert.ok(saves>=4);assert.equal(s.rows.filter(r=>r.review_state==='reviewed').length,5);assert.equal(s.rows[6].review_state,'pending');assert.ok(s.rows.every(r=>r.status==='proposed'&&!r.reviewed_by_human));
  await runReview(s,{client,limit:7,batchSize:3});assert.deepEqual(sizes,[2,2,1,2]);
});

test('overlong terms and unavailable tokenizer never cause an unbounded inference request',async()=>{
  for(const counter of [async()=>5000,async()=>{throw Error('Tokenizer unavailable');}]){
    const s=state([{}]);let calls=0;
    await runReview(s,{client:{calls:0,cacheHits:0,countChatTokens:counter,structured:async()=>{calls++;}}});
    assert.equal(calls,0);assert.equal(s.rows[0].recommended_kk,null);assert.ok(['failed','deferred'].includes(s.rows[0].review_state));
  }
});

test('local structured transport retries invalid JSON, validates cache, respects budget and timeout without approvals',async t=>{
  const s=state([{}]),body=reviewBody(s.rows,768);let calls=0;
  const c=await makeClient(t,async(url,options)=>{assert.equal(JSON.parse(options.body).max_tokens,768);return ++calls===1?reply('{'):reply({results:[result(s.rows[0])]});},{maxRetries:1});
  const validate=v=>validateGlossaryReview(v,s.rows);
  assert.equal((await c.structured(body,validate)).review[0].verdict,'keep');assert.equal(c.calls,2);
  assert.equal((await c.structured(body,validate)).cached,true);assert.equal(c.calls,2);assert.equal(c.cacheHits,1);
  const noBudget=await makeClient(t,async()=>{throw Error('Must not call');},{maxCalls:0});assert.equal((await noBudget.structured(body,validate)).deferred,true);
  for(const request of [async()=>reply('{}','length'),async()=>{throw new DOMException('timeout','TimeoutError');}]){
    const broken=await makeClient(t,request);await runReview(s,{client:{...broken,calls:0,cacheHits:0,countChatTokens:async()=>100,structured:broken.structured.bind(broken)},retryFailed:true});
    assert.equal(s.rows[0].review_state,'failed');assert.equal(s.rows[0].status,'proposed');
  }
  assert.throws(()=>new QwenClient({endpoint:'https://external.example/v1/chat/completions'}),/loopback/);
});

test('chat template and tokenizer use the same local model and disabled thinking',async t=>{
  const routes=[];const c=await makeClient(t,async(url,options)=>{
    routes.push(new URL(url).pathname);const body=JSON.parse(options.body);
    if(url.endsWith('/apply-template')){assert.equal(body.chat_template_kwargs.enable_thinking,false);assert.equal(body.add_generation_prompt,true);return {ok:true,json:async()=>({prompt:'rendered chat'})};}
    assert.equal(body.content,'rendered chat');assert.equal(body.add_special,false);return {ok:true,json:async()=>({tokens:[1,2,3]})};
  });assert.equal(await c.countChatTokens(reviewBody([],768)),3);assert.deepEqual(routes,['/apply-template','/tokenize']);assert.equal(c.calls,0);
});

const cli=async args=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'review-glossary',...args],{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});return {code,output};
};
test('CLI writes restartable rules checkpoint, rejects changed input and output paths that overwrite ARB',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'glossary-cli-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const input=path.join(dir,'draft.csv'),out=path.join(dir,'review.csv');await fs.writeFile(input,glossaryCsv([{ru:'Тест',kk:'Сынақ',status:'proposed'}]));
  const args=['--input',input,'--out',out,'--rules-only'];assert.equal((await cli(args)).code,0);assert.equal(readGlossary(await fs.readFile(out,'utf8'))[0].status,'proposed');
  assert.equal((await cli(args)).code,1);assert.equal((await cli([...args,'--resume'])).code,0);
  await fs.appendFile(input,'"Иной","Басқа",,,,,,,,,\r\n');const changed=await cli([...args,'--resume']);assert.equal(changed.code,1);assert.match(changed.output,/Checkpoint does not match/);
  const guard=await cli(['--input',input,'--out',input,'--rules-only']);assert.equal(guard.code,1);assert.match(guard.output,/overwrite/);
});
