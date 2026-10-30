import test from 'node:test';
import assert from 'node:assert/strict';
import {runWorkflow} from '../app/packages/agent/src/workflow/index.ts';
import {setupWorkflow} from './workflow_fixture.mjs';
import {workflowErrorCode} from '../app/packages/agent/src/workflow/errors.ts';

test('native string rejections preserve approved failure codes without storing raw messages',()=>{
 for(const code of ['workflow_invalid_question_scope','invalid_input','account_network_failed','account_service_failed','session_expired','credits_exhausted','knowledge_invalid_query']){
  assert.equal(workflowErrorCode(code),code);assert.equal(workflowErrorCode(new Error(code)),code);
 }
 for(const message of ['request failed: sk-secret-value','张三请求失败','account_failure with private data','Bearer private-session',null,{}, {message:'invalid_input'}])assert.equal(workflowErrorCode(message),'workflow_failed');
});
for(const code of ['workflow_invalid_question_scope','invalid_input','account_network_failed','credits_exhausted'])test(`native authorization rejects ${code} before model calls and records the specific reason`,async()=>{
 const s=await setupWorkflow();s.model.executionMode='real';let releaseCount=0;
 s.ports.authorize=async()=>{throw code;};s.ports.release=async()=>{releaseCount++;};
 const run=await runWorkflow(s);assert.equal(run.errorCode,code);assert.equal(run.state,'failed');assert.equal(run.calls.length,0);assert.equal(s.model.calls.length,0);assert.equal(releaseCount,1);
});
test('structural failure records its actual workflow stage without discarding saved calls',async()=>{
 const s=await setupWorkflow();s.ports.prepareUnits=async()=>[{unitId:'bad',sourceNumbers:['1'],pageIds:['page-1'],stem:'',material:'',options:[],availability:'usable',alignmentStatus:'recognized_by_machine'}];
 const run=await runWorkflow(s);assert.equal(run.errorCode,'workflow_invalid_output');assert.equal(run.errorStage,'recognizing');assert.equal(run.state,'failed');
});
test('native knowledge query rejection retains its cause and stage without issuing a verification call',async()=>{
 const s=await setupWorkflow();s.ports.retrieve=async()=>{throw 'knowledge_invalid_query';};
 const run=await runWorkflow(s);assert.equal(run.state,'failed');assert.equal(run.errorCode,'knowledge_invalid_query');assert.equal(run.errorStage,'retrieving');
 assert(s.model.calls.length>0);assert(s.model.calls.every(c=>c.stage==='extract'));assert.equal(run.facts.length,0);
});
