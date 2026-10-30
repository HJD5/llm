import test from 'node:test';
import assert from 'node:assert/strict';
import {score,validateInput,validateOutput} from './lab.mjs';
const records=[{id:'a',source:'Hello {name}',target:'Сәлем {name}'}];
test('input rejects duplicate ids and malformed strings',()=>{
  assert.throws(()=>validateInput({records:[...records,...records]}));
  assert.throws(()=>validateInput({records:[{...records[0],target:42}]}));
  assert.doesNotThrow(()=>validateInput({records}));
});
test('output rejects unknown labels and duplicate findings',()=>{
  assert.throws(()=>validateOutput({results:[{id:'a',issues:['invented']}]},records));
  assert.throws(()=>validateOutput({results:[{id:'a',issues:['orthography','orthography']}]},records));
  assert.throws(()=>validateOutput({results:[{id:'b',issues:[]}]},records));
});
test('metrics count false positives on clean strings and missed labels',()=>{
  const s=score([{id:'a',expected:[]},{id:'b',expected:['untranslated']}],{results:[{id:'a',issues:['orthography']},{id:'b',issues:[]}]});
  assert.equal(s.tp,0);assert.equal(s.fp,1);assert.equal(s.fn,1);assert.equal(s.exact,0);
});
