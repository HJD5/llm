import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {parseArb,makeRecords} from '../locqa/src/arb.mjs';
import {modules} from '../locqa/src/engine.mjs';
import {htmlReport} from '../locqa/src/report.mjs';
const require=createRequire(new URL('../locqa/package.json',import.meta.url));
const {parse:csv}=require('csv-parse/sync');
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(here);
export const moduleNames={untranslated:'Отсутствующий перевод',same_as_source:'Совпадение с русским',placeholder_mismatch:'Подстановки',plural_mismatch:'Формы ICU',glossary_violation:'Глоссарий',length_overflow:'Длина текста',suffix_harmony:'Окончания переменных',inconsistent_term:'Единообразие терминов',machine_translation_suspect:'Смысл перевода',orthography:'Орфография',wrong_language:'Язык текста'};
export function parseGlossary(text){
  if(!text?.trim())return [];
  const terms=text.trim().startsWith('[')?JSON.parse(text):csv(text,{columns:true,bom:true,skip_empty_lines:true});
  if(!Array.isArray(terms)||terms.length>5000)throw Error('Некорректный глоссарий');
  return terms.map(t=>{
    if(typeof t.ru!=='string'||!t.ru.trim()||typeof t.kk!=='string'||!t.kk.trim())throw Error('Глоссарий: нужны непустые колонки ru и kk');
    const variants=Array.isArray(t.variants)?t.variants:typeof t.variants==='string'?t.variants.split('|').filter(Boolean):[];
    if(variants.some(x=>typeof x!=='string'))throw Error('Некорректные варианты термина');
    return {...t,variants};
  });
}
const issueId=i=>createHash('sha256').update(i.key+'\0'+i.issue_type).digest('hex').slice(0,24);
export async function createPlatform({dataDir=path.join(here,'private-data'),seed=true}={}){
  await fs.mkdir(path.join(dataDir,'datasets'),{recursive:true});await fs.mkdir(path.join(dataDir,'runs'),{recursive:true});
  const csrf=randomBytes(24).toString('hex'),datasets=new Map(),jobs=new Map(),streams=new Set(),writes=new Map();let active=null,starting=false;
  const persist=(file,data)=>{const snapshot=JSON.stringify(data);const write=(writes.get(file)??Promise.resolve()).catch(()=>{}).then(async()=>{const tmp=file+'.tmp';await fs.writeFile(tmp,snapshot);await fs.rename(tmp,file);});writes.set(file,write);return write;};
  function addDataset(id,data){
    if(typeof data.source!=='string'||typeof data.target!=='string')throw Error('Нужны русский и казахский ARB-файлы');
    const source=parseArb(data.source),target=parseArb(data.target),reference=data.reference?parseArb(data.reference):null;
    if(target.locale&&target.locale!=='kk')throw Error('Сейчас поддерживается целевая локаль kk');
    const rows=makeRecords(source,target,reference);
    if(!rows.length||rows.length>25000)throw Error('Допустимо от 1 до 25000 исходных строк');
    const item={id,name:String(data.name??'Новый набор').slice(0,100),createdAt:data.createdAt??new Date().toISOString(),...data,rows,sourceHash:source.sha256,targetHash:target.sha256,sourceCount:source.entries.size,targetCount:target.entries.size,duplicates:target.diagnostics.filter(x=>x.kind==='duplicate_key').length};
    datasets.set(id,item);return item;
  }
  for(const f of await fs.readdir(path.join(dataDir,'datasets'))){if(!f.endsWith('.json'))continue;try{const d=JSON.parse(await fs.readFile(path.join(dataDir,'datasets',f),'utf8'));addDataset(f.slice(0,-5),d);}catch{}}
  if(seed){try{
    const base=path.join(root,'basw/handout');const [source,target,reference]=await Promise.all(['intl_ru.arb','intl_kk.arb','intl_en.arb'].map(f=>fs.readFile(path.join(base,f),'utf8')));
    addDataset('grand-mobile',{name:'Grand Mobile · RU → KK',source,target,reference,glossary:[],createdAt:new Date().toISOString()});
  }catch{}}
  for(const f of await fs.readdir(path.join(dataDir,'runs'))){if(!f.endsWith('.json'))continue;try{const j=JSON.parse(await fs.readFile(path.join(dataDir,'runs',f),'utf8'));if(j.status==='running'){j.status='interrupted';j.finishedAt=new Date().toISOString();}jobs.set(j.id,j);}catch{}}
  if(seed&&datasets.has('grand-mobile'))for(const [id,file,name] of [['cli-code','full-code.json','Проверки кодом · сохранённый отчёт'],['cli-semantic','semantic-smoke.json','Qwen · сохранённый тест смысла']]){
    if(jobs.has(id))continue;try{const report=JSON.parse(await fs.readFile(path.join(root,'locqa/private-results',file),'utf8'));const d=datasets.get('grand-mobile');if(report.provenance?.source?.sha256!==d.sourceHash||report.provenance?.target?.sha256!==d.targetHash)continue;
    const j={id,name,datasetId:d.id,status:'completed',startedAt:report.provenance.created_at,finishedAt:report.provenance.created_at,completed:report.records,total:report.records,report,reviews:{},logs:[{time:new Date().toISOString(),message:'Загружен ранее сохранённый результат CLI. Это не новый запуск.'}],imported:true,options:{checks:Object.entries(report.modules).filter(([,s])=>s.enabled).map(([id])=>id),useModel:report.model_reviews?.length>0}};jobs.set(id,j);await persist(path.join(dataDir,'runs',id+'.json'),j);}catch{}}
  const dsMeta=d=>({id:d.id,name:d.name,createdAt:d.createdAt,records:d.rows.length,sourceCount:d.sourceCount,targetCount:d.targetCount,duplicates:d.duplicates,glossary:d.glossary?.length??0,hasReference:!!d.reference});
  const jobMeta=j=>({id:j.id,name:j.name,datasetId:j.datasetId,status:j.status,startedAt:j.startedAt,finishedAt:j.finishedAt,total:j.total,completed:j.completed??0,modules:j.report?.modules??j.counters??{},findings:j.report?.issues.length??j.findings??0,modelCalls:j.report?.model_calls??j.calls??0,cacheHits:j.report?.cache_hits??j.cacheHits??0,logs:j.logs,imported:j.imported??false,options:j.options,reviewed:Object.values(j.reviews??{}).filter(r=>r.status!=='pending').length,error:j.error??null});
  function publish(j){const msg='data: '+JSON.stringify(jobMeta(j))+'\n\n';for(const s of streams)s.write(msg);}
  function log(j,message){j.logs.push({time:new Date().toISOString(),message});j.logs=j.logs.slice(-100);publish(j);}
  const saveJob=j=>persist(path.join(dataDir,'runs',j.id+'.json'),j);
  const exportReport=j=>({...j.report,run_status:j.status,issues:j.report.issues.map(i=>{const id=issueId(i),review=j.reviews?.[id];return {...i,id,human_review:review??null,reviewed_by_human:!!review&&review.status!=='pending'};})});
  async function startJob(d,options){
    if(active||starting)throw Error('Дождитесь завершения текущего запуска или остановите его');
    const keys=options.keys??[];
    if(!Array.isArray(options.checks)||!options.checks.length||options.checks.some(x=>!modules.some(m=>m.id===x)))throw Error('Выберите корректные проверки');
    if(!Array.isArray(keys)||keys.some(k=>typeof k!=='string'||!d.rows.some(r=>r.key===k)))throw Error('Неизвестный ключ строки');
    if(!Number.isInteger(options.budget)||options.budget<0||options.budget>100)throw Error('Лимит Qwen: от 0 до 100 запросов');
    const id=randomUUID(),j={id,datasetId:d.id,name:options.useModel?'Проверка с Qwen':'Проверки кодом',options:{checks:[...new Set(options.checks)],keys,useModel:!!options.useModel,budget:options.budget},status:'running',startedAt:new Date().toISOString(),completed:0,total:keys.length||d.rows.length,logs:[],reviews:{}};
    starting=true;
    jobs.set(id,j);try{await saveJob(j);}catch(e){starting=false;jobs.delete(id);throw e;}log(j,'Запуск проверки · '+j.total+' строк');
    const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{dataset:{source:d.source,target:d.target,reference:d.reference,glossary:d.glossary},options:j.options,cacheDir:path.join(root,'locqa/private-results/cache')}});
    active={id,worker};starting=false;
    worker.on('message',event=>{
      if(j.status!=='running')return;
      if(event.kind==='log')log(j,event.message);
      else if(event.kind==='progress'){j.completed=event.completed;j.total=event.total;j.counters=event.modules;j.findings=event.findings;if(event.report)j.report=event.report;publish(j);}
      else if(event.kind==='partial'){j.report=event.report;j.calls=event.calls;j.cacheHits=event.cacheHits;publish(j);saveJob(j).catch(console.error);}
      else if(event.kind==='done'){j.report=event.report;j.completed=j.total;j.status=event.report.diagnostics.some(x=>x.kind==='model_request_failed')?'completed_with_errors':'completed';j.finishedAt=new Date().toISOString();active=null;log(j,'Проверка завершена. Исходные переводы не изменены.');saveJob(j).catch(console.error);}
      else if(event.kind==='failed'){j.status='failed';j.error=event.message;j.finishedAt=new Date().toISOString();active=null;log(j,event.message);saveJob(j).catch(console.error);}
    });
    worker.on('error',e=>{j.status='failed';j.error=e.message;j.finishedAt=new Date().toISOString();if(active?.id===id)active=null;log(j,e.message);saveJob(j).catch(console.error);});
    worker.on('exit',code=>{if(j.status==='running'){j.status='interrupted';j.finishedAt=new Date().toISOString();j.error='Рабочий процесс завершился: '+code;if(active?.id===id)active=null;publish(j);saveJob(j).catch(console.error);}});
    return j;
  }
  let startPromise=null;
  async function modelStatus(){try{const r=await fetch('http://127.0.0.1:8088/health',{signal:AbortSignal.timeout(1500)});if(r.ok)return {status:'ready',name:'Qwen3-8B · Q4_K_M',device:'CPU'};return {status:r.status===503?'loading':'offline',name:'Qwen3-8B · Q4_K_M'};}catch{return {status:'offline',name:'Qwen3-8B · Q4_K_M'};}}
  const server=http.createServer(async(req,res)=>{
    const addr=server.address(),port=addr?.port;const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
    const json=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
    if(!hosts.includes(req.headers.host)){json(403,{error:'Недопустимый Host'});return;}
    if(req.headers.origin&&!hosts.some(h=>req.headers.origin==='http://'+h)){json(403,{error:'Запрос с другого сайта запрещён'});return;}
    const url=new URL(req.url,'http://'+req.headers.host),parts=url.pathname.split('/').filter(Boolean);
    try{
      if(req.method==='GET'&&url.pathname==='/api/bootstrap'){json(200,{csrf,datasets:[...datasets.values()].map(dsMeta),runs:[...jobs.values()].map(jobMeta).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)),modules:modules.map(m=>({id:m.id,name:moduleNames[m.id],model:!!m.model})),active:active?.id??null});return;}
      if(req.method==='GET'&&url.pathname==='/api/model'){json(200,await modelStatus());return;}
      if(req.method==='GET'&&url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(': connected\n\n');streams.add(res);const timer=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clearInterval(timer);streams.delete(res);});return;}
      if(req.method==='GET'&&parts[0]==='api'&&parts[1]==='datasets'&&parts[3]==='rows'){
        const d=datasets.get(parts[2]);if(!d){json(404,{error:'Набор не найден'});return;}
        const q=(url.searchParams.get('q')??'').toLocaleLowerCase(),page=Math.max(0,Number(url.searchParams.get('page'))||0),limit=50;
        const rows=d.rows.filter(r=>!q||[r.key,r.source,r.target].some(v=>v?.toLocaleLowerCase().includes(q)));
        json(200,{total:rows.length,page,rows:rows.slice(page*limit,(page+1)*limit)});return;
      }
      if(req.method==='GET'&&parts[0]==='api'&&parts[1]==='runs'&&parts[2]){
        const j=jobs.get(parts[2]);if(!j){json(404,{error:'Запуск не найден'});return;}
        if(parts[3]==='report'||parts[3]==='download'){
          if(!j.report){json(409,{error:'Результатов пока нет'});return;}
          const report=exportReport(j);
          if(parts[3]==='download'){
            const isHtml=url.searchParams.get('format')==='html';res.writeHead(200,{'Content-Type':isHtml?'text/html; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="locqa-${j.id}.${isHtml?'html':'json'}"`});res.end(isHtml?htmlReport(report):JSON.stringify(report,null,2));return;
          }
          json(200,report);return;
        }
        json(200,jobMeta(j));return;
      }
      if(req.method==='POST'){
        if(req.headers['x-locqa-token']!==csrf){json(403,{error:'Обновите страницу: неверный токен сессии'});return;}
        if(!(req.headers['content-type']??'').startsWith('application/json')){json(415,{error:'Ожидается JSON'});return;}
        let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>12*1024*1024){json(413,{error:'Максимальный размер загрузки 12 МБ'});return;}chunks.push(chunk);}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
        if(url.pathname==='/api/datasets'){
          const id=randomUUID(),data={name:String(body.name??'Новый набор'),source:body.source,target:body.target,reference:body.reference??'',glossary:parseGlossary(body.glossary??''),createdAt:new Date().toISOString()};
          const d=addDataset(id,data);await persist(path.join(dataDir,'datasets',id+'.json'),data);json(201,dsMeta(d));return;
        }
        if(url.pathname==='/api/runs'){
          const d=datasets.get(body.datasetId);if(!d){json(404,{error:'Набор не найден'});return;}
          const j=await startJob(d,body);json(201,jobMeta(j));return;
        }
        if(url.pathname==='/api/model/start'){
          if((await modelStatus()).status==='ready'){json(200,{status:'ready'});return;}
          if(!startPromise){startPromise=new Promise(resolve=>{const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'start-qwen.ps1')],{cwd:root,windowsHide:true,stdio:'ignore'});p.on('error',()=>{startPromise=null;resolve();});p.on('exit',()=>{startPromise=null;resolve();});});}
          json(202,{status:'loading'});return;
        }
        if(parts[0]==='api'&&parts[1]==='runs'&&parts[3]==='cancel'){
          const j=jobs.get(parts[2]);if(!j||active?.id!==j.id){json(409,{error:'Этот запуск уже не выполняется'});return;}
          const worker=active.worker;j.status='cancelled';j.finishedAt=new Date().toISOString();active=null;await worker.terminate();log(j,'Остановлено пользователем. Частичные результаты сохранены.');await saveJob(j);json(200,jobMeta(j));return;
        }
        if(parts[0]==='api'&&parts[1]==='runs'&&parts[3]==='review'){
          const j=jobs.get(parts[2]);if(!j?.report){json(404,{error:'Отчёт не найден'});return;}
          if(j.status==='running'){json(409,{error:'Дождитесь завершения запуска'});return;}
          if(!j.report.issues.some(i=>issueId(i)===body.issueId)||!['accepted','rejected','pending'].includes(body.status))throw Error('Некорректная отметка проверки');
          j.reviews[body.issueId]={status:body.status,note:String(body.note??'').slice(0,2000),at:new Date().toISOString(),reviewer:'local_user'};await saveJob(j);json(200,j.reviews[body.issueId]);return;
        }
        json(404,{error:'Маршрут не найден'});return;
      }
      if(req.method==='GET'&&['/','/index.html','/app.js','/style.css'].includes(url.pathname)){
        const name=url.pathname==='/'?'index.html':url.pathname.slice(1),data=await fs.readFile(path.join(here,'public',name));
        res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(data);return;
      }
      json(404,{error:'Не найдено'});
    }catch(e){if(!res.headersSent)json(400,{error:e.message});else res.end();}
  });
  async function close(){if(active){const j=jobs.get(active.id);j.status='interrupted';j.finishedAt=new Date().toISOString();await active.worker.terminate();await saveJob(j);active=null;}for(const s of streams)s.end();await Promise.allSettled([...writes.values()]);await new Promise(r=>server.close(r));}
  return {server,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createPlatform();app.server.listen(8090,'127.0.0.1',()=>console.log('Qazaq Loc QA: http://127.0.0.1:8090'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
