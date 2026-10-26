import test from 'node:test';
import assert from 'node:assert/strict';
import {deepseekProvider,DEEPSEEK_MODEL} from '../app/packages/agent/src/deepseek.ts';
import {runPipeline} from '../app/packages/agent/src/index.ts';
import {practiceFixture} from './practice_fixture.mjs';

test('uses official V4.1 Flash alias and isolates transport mutation',async()=>{
  assert.equal(DEEPSEEK_MODEL,'deepseek-flash');
  const request={stage:'annotate',instruction:'test',data:{original:{stem:'original'}}};
  const provider=deepseekProvider(async r=>{r.data.original.stem='changed';return {ok:true};});
  assert.equal(provider.mode,'real');await provider.call(request);assert.equal(request.data.original.stem,'original');
});
test('quota exhaustion latches adapter without retry or fallback',async()=>{
  let count=0;const provider=deepseekProvider(async()=>{count++;throw 'model_quota_exhausted';});
  await assert.rejects(provider.call({}),/model_quota_exhausted/);
  await assert.rejects(provider.call({}),/model_quota_exhausted/);assert.equal(count,1);
});
test('transport errors expose only approved error codes',async()=>{
  const provider=deepseekProvider(async()=>{throw new Error('secret-key-from-server');});
  await assert.rejects(provider.call({}),e=>e.message==='model_service_failed');
  const truncated=deepseekProvider(async()=>{throw 'model_output_truncated';});
  await assert.rejects(truncated.call({}),/model_output_truncated/);
});
test('real adapter runs the existing anonymous independent-solve pipeline',async()=>{
  const workspace=await practiceFixture();delete workspace.practice;const calls=[];
  const provider=deepseekProvider(async request=>{
    calls.push(request);
    if(request.stage==='annotate')return {knowledgePoints:['光合作用'],keywords:['光合作用'],kind:'text',materialGroup:null};
    if(request.stage==='generate')return {exercises:[{stem:'列举光合作用的物质变化。',options:[],answer:'正确答案',explanation:'完整解析',knowledgePoints:['光合作用'],sourceIndexes:[0]}]};
    return {answer:'正确答案',complete:true,inScope:true,tooSimilar:false,explanation:'独立解析'};
  });
  const batch=await runPipeline({workspace,provider,retrieve:async()=>[{documentId:'a'.repeat(64),name:'教材.pdf',page:1,ordinal:1,text:'光合作用原理'}]});
  assert.equal(batch.mode,'real');assert.equal(batch.variants[0].passed,true);assert.deepEqual(calls.map(c=>c.stage),['annotate','generate','solve']);
  for(const s of workspace.students){assert.ok(!JSON.stringify(calls).includes(s.name));assert.ok(!JSON.stringify(calls).includes(s.id));}
  assert.equal(calls[2].data.question.answer,undefined);
});
