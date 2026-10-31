import test from 'node:test';
import assert from 'node:assert/strict';
import {readGlossary,glossaryCsv} from '../src/glossary.mjs';
import {checkRecords} from '../src/engine.mjs';
const row=(key,source,target)=>({key,source,target,context:{},metadata:{}});
test('draft conflicts are not rules; aliases and CSV roundtrip preserve context',async()=>{
 const terms=readGlossary('term_ru,term_kk,term_en,comment,status\nОтмена,,Cancel,"review, context",proposed');
 assert.equal(terms[0].ru,'Отмена');assert.equal(readGlossary(glossaryCsv(terms))[0].comment,'review, context');
 const r=await checkRecords([row('cancel','Отмена','БАСТАУ')],{terms,checks:['glossary_violation']});assert.equal(r.issues.length,0);assert.equal(r.modules.glossary_violation.skipped,1);
 assert.throws(()=>readGlossary('ru,kk,status\nОтмена,,approved'));
});
test('confirmed units apply only to their keys and accepted variants',async()=>{
 const terms=[{ru:'МИН',kk:'МИН',key:'format_min',status:'approved'}];
 const r=await checkRecords([row('format_min','МИН','МИН'),row('other','МИН','МИН'),row('format_sec','СЕК','СЕК')],{terms,checks:['same_as_source']});
 assert.deepEqual(r.issues.map(i=>i.key),['other','format_sec']);
 const wrong=await checkRecords([row('format_min','МИН','OTHER')],{terms,checks:['glossary_violation']});assert.equal(wrong.issues.length,1);
 const proposed=await checkRecords([row('format_min','МИН','МИН')],{terms:[{...terms[0],status:'proposed'}],checks:['same_as_source']});assert.equal(proposed.issues.length,1);
});
