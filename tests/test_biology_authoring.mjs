import test from 'node:test';
import assert from 'node:assert/strict';
import {biologyAuthoring,BIOLOGY_AUTHORING_VERSION,biologyAuthoringInstruction,searchBiologyAuthoring} from '../app/packages/knowledge/src/biologyAuthoring.ts';
import {freezeInput,digest,assertFrozen} from '../app/packages/agent/src/workflow/input.ts';
import {modelRequest} from '../app/packages/agent/src/workflow/prompts.ts';
import {runWorkflow} from '../app/packages/agent/src/workflow/runner.ts';
import {setupWorkflow,workflowWorkspace} from './workflow_fixture.mjs';
import {validateStoredTask} from '../app/packages/agent/src/workflow/persistence.ts';

test('authoring library records conversation provenance and separates scope, blank counts and diagrams from app capability',()=>{
 assert.equal(biologyAuthoring.principles.length,12);assert.equal(biologyAuthoring.topicTemplates.length,3);
 assert.equal(biologyAuthoring.sources[0].title,'编写高中生物基础填空题');
 assert(biologyAuthoring.sources[2].scope.includes('跨地区'));assert(biologyAuthoring.scope.includes('不是教材事实证据'));
 assert(searchBiologyAuthoring('遗传概率分母').some(p=>p.id==='genetics-denominator'));
 assert(searchBiologyAuthoring('过程图').some(p=>p.id==='figure-task'));
 assert.deepEqual(searchBiologyAuthoring(''),[]);assert.deepEqual(searchBiologyAuthoring('电磁振荡'),[]);
 const found=searchBiologyAuthoring('概率');found[0].title='changed';assert.notEqual(searchBiologyAuthoring('概率')[0].title,'changed');
 assert(biologyAuthoring.principles.find(p=>p.id==='quantities').method.includes('不能要求每个错题条目都出12或16空'));
});
for(const mode of ['dictation','exercise'])test(`new ${mode} task actually uses fixed authoring methods while independent solving and existing limits stay intact`,async()=>{
 const s=await setupWorkflow({mode});assert.equal(s.input.authoringVersion,BIOLOGY_AUTHORING_VERSION);
 const run=await runWorkflow(s);assert.equal(run.state,'contentReady',run.errorCode);
 for(const r of s.model.calls){
  const writing=['extract','cloze','exercise'].includes(r.stage);
  assert.equal(r.data.authoringVersion,writing?BIOLOGY_AUTHORING_VERSION:undefined);
  if(writing)assert(r.instruction.includes(biologyAuthoring.stageInstructions[r.stage]));
  else assert(!r.instruction.includes('参考基础填空命题方法'));
 }
 assert.equal(s.input.settings.maxItems,mode==='dictation'?16:5);
 const independent=s.model.calls.find(r=>['blindFill','solve'].includes(r.stage));assert(independent);
 assert(!JSON.stringify(independent.data).includes('authoringVersion'));
 await validateStoredTask({input:s.input,run,revision:1,context:{},createdAt:run.startedAt,updatedAt:run.startedAt},s.input.ownerId,run.runId);
});
test('legacy frozen tasks preserve generation request hashes and non-biology tasks never acquire biology instructions',async()=>{
 const s=await setupWorkflow(),{authoringVersion,contentHash,...body}=s.input;s.input={...body,contentHash:await digest(body)};
 await assertFrozen(s.input);const run=await runWorkflow(s);assert.equal(run.state,'contentReady');
 assert(s.model.calls.every(r=>r.data.authoringVersion===undefined));
 for(const stage of ['blindFill','solve','verifyFact','guidance','recognize'])assert.equal(biologyAuthoringInstruction(stage,BIOLOGY_AUTHORING_VERSION),'');
 const w=workflowWorkspace();w.exam.subjectName='物理';const physics=await freezeInput({ownerId:'physics',workspace:w,mode:'dictation'});
 assert.equal(physics.authoringVersion,undefined);
 assert(!modelRequest('cloze',{subject:'物理',authoringVersion:BIOLOGY_AUTHORING_VERSION}).instruction.includes(biologyAuthoring.stageInstructions.cloze));
 const broken={...s.input,authoringVersion:'unrecognized'}, {contentHash:oldHash,...modified}=broken;broken.contentHash=await digest(modified);
 await assert.rejects(()=>assertFrozen(broken),/workflow_invalid_settings/);
});
