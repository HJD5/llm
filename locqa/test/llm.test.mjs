import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {QwenClient,validateReview} from '../src/qwen.mjs';
import {checkRecords,modules} from '../src/engine.mjs';
const row=(target,key='x')=>({key,source:'Вы действительно хотите приобрести награду',target,context:{},metadata:{}});
const mod=id=>modules.find(m=>m.id===id);
const clear={verdict:'no_issue',source_quote:'',target_quote:'',reason:'No concrete defect',suggestion:null};
const reply=(value,finish_reason='stop')=>({ok:true,json:async()=>({choices:[{finish_reason,message:{content:typeof value==='string'?value:JSON.stringify(value)}}]})});
test('time abbreviations abstain without consuming model budget; ordinary text remains eligible',async()=>{
 let calls=0;const client={check:async()=>{calls++;return {review:{...clear,verdict:'clear'}};}};
 const records=[{...row('КҮН','format_d'),source:'ДН'},{...row('САҒ','format_h'),source:'Ч'},row('Сіз шынымен сыйақыны сатып алғыңыз келе ме','sentence')];
 const report=await checkRecords(records,{checks:['orthography','machine_translation_suspect'],client});
 assert.equal(calls,2);assert.equal(report.issues.length,0);
 for(const id of ['orthography','machine_translation_suspect'])assert.equal(report.modules[id].skip_reasons.ambiguous_short_abbreviation,2);
 const review=validateReview({...clear,verdict:'issue',source_quote:'ДН',target_quote:'КҮН',reason:'Not a valid Kazakh transliteration'},records[0],'kk',mod('orthography'));
 assert.equal(review.verdict,'uncertain');assert.equal(review.validation_warning,'transliteration_is_not_spelling_evidence');
});
async function client(request,options={}){return new QwenClient({endpoint:'http://127.0.0.1:8088/v1/chat/completions',modelRevision:'test',cacheDir:await fs.mkdtemp(path.join(os.tmpdir(),'locqa-llm-')),request,...options});}
test('known Kazakh regression inputs: no_issue protocol and prompt examples (mock transport, not model accuracy)',async()=>{
 for(const [category,target] of [['orthography','сыйақыны'],['wrong_language','Сіз шынымен сыйақыны сатып алғыңыз келе ме'],['wrong_language','Тауардың бағасы қолданылған жеңілдіктермен']]){
  const c=await client(async(url,opts)=>{assert.match(JSON.parse(opts.body).messages[0].content,/сыйақыны/);return reply({...clear,...(category==='wrong_language'?{detected_language:'',language_evidence:''}:{})});});
  const report=await checkRecords([row(target)],{checks:[category],client:c});
  assert.equal(report.issues.length,0);assert.equal(report.modules[category].assessed,1);assert.equal(report.model_reviews[0].review.verdict,'clear');
 }
});
test('hallucinated spelling and foreign-language claims require human review',()=>{
 for(const category of ['orthography','wrong_language']){
  const review=validateReview({...clear,verdict:'issue',target_quote:'сыйақыны',reason:'wrong',detected_language:'ru',language_evidence:'Russian'},row('сыйақыны'),'kk',mod(category));
  assert.equal(review.verdict,'uncertain');
 }
 const r=row('Тауардың бағасы қолданылған жеңілдіктермен');
 assert.equal(validateReview({...clear,verdict:'issue',target_quote:r.target,reason:'Unnatural style'},r,'kk',mod('wrong_language')).verdict,'uncertain');
 assert.equal(validateReview({...clear,verdict:'issue',target_quote:r.target,reason:'Russian',detected_language:'ru',language_evidence:'Unnatural word order'},r,'kk',mod('wrong_language')).verdict,'uncertain');
 assert.throws(()=>validateReview({...clear,target_quote:'invented'},r,'kk',mod('wrong_language')));
 assert.throws(()=>validateReview({...clear,extra:1},r,'kk',mod('orthography')));
});
test('concrete Uzbek evidence remains a candidate, never human-approved (mock transport)',async()=>{
 const target='Siz haqiqatan ham mukofotni sotib olmoqchimisiz?';
 const c=await client(async()=>reply({...clear,verdict:'issue',target_quote:'mukofotni sotib olmoqchimisiz',reason:'Uzbek sentence',detected_language:'uz',language_evidence:'Uzbek mukofot with accusative -ni and interrogative olmoqchimisiz'}));
 const report=await checkRecords([row(target)],{checks:['wrong_language'],client:c});
 assert.equal(report.issues.length,1);assert.equal(report.issues[0].reviewed_by_human,false);
});
test('invalid/truncated JSON retries once, increases length budget, caches only valid answer',async()=>{
 let n=0;const c=await client(async(url,opts)=>{const body=JSON.parse(opts.body);assert.equal(body.max_tokens,n?1536:768);return n++?reply(clear):reply('{"verdict":','length');});
 const result=await c.check(mod('orthography'),row('сыйақыны'),'kk');
 assert.equal(c.calls,2);assert.equal(result.attempts.length,2);
 assert.equal((await c.check(mod('orthography'),row('сыйақыны'),'kk')).cached,true);
});
test('invalid JSON, invalid schema, empty output, timeout and offline fail without a finding',async()=>{
 for(const request of [async()=>reply('{"verdict":"unterminated'),async()=>reply({...clear,extra:true}),async()=>reply(''),async()=>{throw new DOMException('timeout','TimeoutError');},async()=>{throw Error('fetch failed');}]){
  const c=await client(request,{maxCalls:2});
  const report=await checkRecords([row('Мәтін бірінші','a'),row('Мәтін екінші','b')],{checks:['orthography'],client:c});
  assert.equal(c.calls,2);assert.equal(report.issues.length,0);assert.equal(report.modules.orthography.failed,1);assert.equal(report.modules.orthography.deferred,1);assert.equal(report.diagnostics[0].attempts.length,2);
 }
});
test('CLI continues after a failed check, writes both reports, exits 2',async t=>{
 let calls=0;const server=http.createServer((req,res)=>{req.resume();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:++calls<=2?'broken':JSON.stringify(clear)}}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'locqa-cli-'));
 await fs.writeFile(path.join(dir,'ru.arb'),JSON.stringify({a:'Текст первый',b:'Текст второй',c:'Текст третий'}));
 await fs.writeFile(path.join(dir,'kk.arb'),JSON.stringify({a:'Бірінші мәтін',b:'Екінші мәтін',c:'Үшінші мәтін'}));
 await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({endpoint:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,model_revision:'mock'}));
 const args=[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'check','--source',path.join(dir,'ru.arb'),'--target',path.join(dir,'kk.arb'),'--config',path.join(dir,'config.json'),'--out',path.join(dir,'report.json'),'--cache-dir',path.join(dir,'cache'),'--checks','orthography','--llm','--max-llm-calls','3'];
 const child=spawn(process.execPath,args,{stdio:'pipe'});child.stdout.resume();child.stderr.resume();
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 assert.equal(code,2);const report=JSON.parse(await fs.readFile(path.join(dir,'report.json'),'utf8'));
 assert.equal(report.modules.orthography.failed,1);assert.equal(report.modules.orthography.assessed,1);assert.equal(report.modules.orthography.deferred,1);
 const html=await fs.readFile(path.join(dir,'report.html'),'utf8');assert.ok(html.includes('broken'));assert.ok(html.includes('orthography'));
});
