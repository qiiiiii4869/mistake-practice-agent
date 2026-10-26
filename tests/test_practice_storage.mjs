import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkspace} from '../app/packages/core/src/index.ts';
import {practiceFixture} from './practice_fixture.mjs';

test('practice and review roundtrip with literal document URLs retained as plain evidence',async()=>{
  const w=await practiceFixture();const result=validateWorkspace(JSON.parse(JSON.stringify(w)));
  assert.equal(result.practice.variants[0].review,'approved');
  assert.equal(result.practice.mode,'mock');
  assert.ok(result.practice.variants[0].evidence[0].text.includes('https://example.test/book'));
});
for(const [name,mutate] of [
  ['stale settings',w=>w.settings.variantsPerQuestion=3],
  ['stale stem',w=>w.paper.questions[0].stem='改变后的题干'],
  ['unconfirmed source',w=>w.paper.questions[0].confirmed=false],
  ['forged passing answer',w=>w.practice.variants[0].answer='与自检不一致'],
  ['forged citation index',w=>w.practice.variants[0].sourceIndexes=[99]],
  ['unknown source question',w=>w.practice.variants[0].sourceNumbers=['999']],
  ['duplicate variants',w=>w.practice.variants.push(structuredClone(w.practice.variants[0]))],
  ['invalid mode',w=>w.practice.mode='pretend-real'],
  ['approved failed question',w=>w.practice.variants[0].passed=false],
])test(`stored practice rejects ${name}`,async()=>{const w=await practiceFixture();mutate(w);assert.throws(()=>validateWorkspace(w),/invalid_practice/);});
