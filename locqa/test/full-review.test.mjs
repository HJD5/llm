import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTree,getNodeValue} from 'jsonc-parser';
import {parseArb} from '../src/arb.mjs';
import {applyReviewedMachineEdits} from '../src/arb-edits.mjs';
import {withNeighborContext} from '../src/neighbor-context.mjs';
import {checkRecords} from '../src/engine.mjs';
import {glossaryCsv,readGlossary} from '../src/glossary.mjs';
import {validateReview} from '../src/qwen.mjs';
import {makeLinguisticBatch} from '../src/batch-linguistics.mjs';
test('language evidence must describe target, and dotted currencies remain unresolved',()=>{
 const row={key:'currency',source:'руб.',target:'қ.қ.а.',context:{}};
 const value={source_quote:'руб.',target_quote:'қ.қ.а.',reason:'Russian abbreviation',detected_language:'ru',language_evidence:'руб is Russian',verdict:'error',suggestion:null};
 assert.equal(validateReview(value,row,'kk',{id:'wrong_language'}).verdict,'uncertain');
 assert.equal(validateReview({...value,target_quote:'Поштаға'}, {...row,target:'Поштаға'},'kk',{id:'wrong_language'}).validation_warning,'language_evidence_does_not_describe_target');
});
test('positional batch requires every detector verdict and actual quoted evidence',()=>{
 const rows=[{key:'a',source:'На почту',target:'Pochta bo‘limiga',context:{neighbors:[]}}];
 const {validate}=makeLinguisticBatch(rows);
 assert.throws(()=>validate({verdicts:[],evidence:[]}));
 assert.equal(validate({verdicts:['001'],evidence:[]})[0].checks.wrong_language,'uncertain');
 const result=validate({verdicts:['001'],evidence:[{index:0,check:'wrong_language',source_quote:'На почту',target_quote:'bo‘limiga',reason:'Uzbek word',detected_language:'uz',language_evidence:'bo‘limiga is Uzbek'}]});assert.equal(result[0].issues[0].type,'wrong_language');
 assert.throws(()=>validate({verdicts:['001'],evidence:[{index:0,check:'wrong_language',source_quote:'invented',target_quote:'bo‘limiga',reason:'Uzbek word',detected_language:'uz',language_evidence:'bo‘limiga is Uzbek'}]}));
});
test('correct repeated values without collapsing keys, sections, metadata or unrelated variants',()=>{
 const input='{"@@comment":"A","x":"Bad {n}","untouched":"one","@@comment":"B","x":"Bad {n}","untouched":"two","@x":{"description":"retain","placeholders":{"n":{"type":"int"}}}}';
 const s=parseArb('{"x":"Source {n}"}');
 const result=applyReviewedMachineEdits(input,s,[{key:'x',before:'Bad {n}',after:'Дұрыс {n}',type:'placeholder_mismatch'}]);
 const props=parseTree(result.text).children.map(p=>[p.children[0].value,getNodeValue(p.children[1])]);
 assert.deepEqual(props.filter(([k])=>k==='@@comment').map(([,v])=>v),['A','B']);
 assert.deepEqual(props.filter(([k])=>k==='x').map(([,v])=>v),['Дұрыс {n}','Дұрыс {n}']);
 assert.deepEqual(props.filter(([k])=>k==='untouched').map(([,v])=>v),['one','two']);
 assert.equal(result.parsed.metadata.get('@x').placeholders.n.type,'int');assert.equal(result.parsed.metadata.get('@x').reviewed_by_human,false);assert.equal(result.changes[0].occurrences_changed,2);
 assert.throws(()=>applyReviewedMachineEdits('{"x":"one","x":"two"}',parseArb('{"x":"Source"}'),[{key:'x',before:'two',after:'New',type:'orthography'}]),/duplicate/);
 assert.throws(()=>applyReviewedMachineEdits(input,s,[{key:'x',after:'Lost argument'}]),/structure/);
});
test('neighbors stay in their section and do not mutate inputs',()=>{
 const rows=[{key:'a',source:'A',target:'А',context:{section:'one'}},{key:'b',source:'B',target:'Б',context:{section:'one'}},{key:'c',source:'C',target:'В',context:{section:'two'}}];
 const enriched=withNeighborContext(rows);assert.deepEqual(enriched[1].context.neighbors.map(x=>x.key),['a']);assert.equal(enriched[2].context.neighbors.length,0);assert.equal(rows[0].context.neighbors,undefined);
});
test('missing keys and their metadata are inserted inside the matching source section',()=>{
 const source=parseArb('{"@@comment":"A","first":"First","missing":"Missing","next":"Next","@@comment":"B","last":"Last"}');
 const text='{"@@comment":"A","first":"Бірінші","next":"Келесі","@@comment":"B","last":"Соңғы"}';
 const result=applyReviewedMachineEdits(text,source,[{key:'missing',before:null,after:'Жетіспейтін',type:'untranslated'}]);
 assert.equal(result.parsed.entries.get('missing').section,'A');
 assert.ok(result.text.indexOf('"missing"')<result.text.indexOf('"next"'));assert.ok(result.text.indexOf('"@missing"')<result.text.indexOf('"next"'));
});
test('machine glossary is opt-in, uses explicit inflections and never claims human approval',async()=>{
 const terms=readGlossary(glossaryCsv([{ru:'Ставка',kk:'Бәс',status:'proposed',verification:'ru_en_context_crosscheck',source_variants:['ставки','ставок'],match_mode:'phrase',variants:['Бәстер','Бәстерді','Ставка']}],['ru','kk','status','verification','source_variants','match_mode','variants']));
 const rows=[{key:'good',source:'Прием ставок',target:'Бәстерді қабылдау',context:{},metadata:{}},{key:'bad',source:'Прием ставок',target:'Тігістерді қабылдау',context:{},metadata:{}}];
 const defaultReport=await checkRecords(rows,{terms,checks:['glossary_violation']});assert.equal(defaultReport.modules.glossary_violation.assessed,0);
 const report=await checkRecords(rows,{terms,checks:['glossary_violation'],config:{include_machine_validated_glossary:true}});
 assert.deepEqual(report.issues.map(i=>i.key),['bad']);assert.equal(report.issues[0].reviewed_by_human,false);
 const substring=await checkRecords([{...rows[1],source:'Приставка',target:'Басқа'}],{terms,checks:['glossary_violation'],config:{include_machine_validated_glossary:true}});assert.equal(substring.issues.length,0);
});
