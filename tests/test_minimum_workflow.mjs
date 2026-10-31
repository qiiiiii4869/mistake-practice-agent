import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeInput,runWorkflow,exportProfile} from '../app/packages/agent/src/workflow/index.ts';
import {setupWorkflow,workflowWorkspace} from './workflow_fixture.mjs';
import {minimumFacts,minimumCloze} from '../app/packages/agent/src/workflow/minimumChecks.ts';
import {recognizeWorkflowUnits} from '../app/packages/agent/src/workflow/recognition.ts';
import {validateStoredTask} from '../app/packages/agent/src/workflow/persistence.ts';
import {buildDocumentPlan} from '../app/packages/pdf/src/workflow/plan.ts';
import {SqliteWorkflowStore} from '../app/packages/agent/src/workflow/persistence.ts';
import {sqliteProbeTransport} from '../tools/workflow-store-transport.mjs';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

async function minimumFixture(mode='dictation'){
 const s=await setupWorkflow({mode});s.input=await freezeInput({ownerId:s.input.ownerId,workspace:s.input.workspace,mode,validationLevel:'minimum'});return s;
}
for(const mode of ['dictation','exercise'])test(`original ${mode} workflow minimum checks skips independent stages, preserves unchecked status, and exports marked PDFs`,async()=>{
 const s=await minimumFixture(mode),run=await runWorkflow(s);assert.equal(run.state,'contentReady',run.errorCode);
 assert(run.facts.length);assert(run.facts.every(f=>f.reviewStatus==='unchecked'&&Object.values(f.factCheck).every(v=>v===false)));
 assert(run.items.length);assert(run.items.every(i=>i.status==='draft'&&!i.checks.independent&&!i.checks.scope));
 assert(!s.model.calls.some(c=>['verifyFact','blindFill','solve'].includes(c.stage)));
 const profile=await exportProfile(s.input,run.runId,'individual');const plan=await buildDocumentPlan(s.input,run,profile,{syntheticPreview:true});
 assert(plan.documents.length);assert(plan.documents.flatMap(d=>d.blocks).filter(b=>b.kind==='title').every(b=>b.text.includes('宽松草稿')));
 await validateStoredTask({input:s.input,run,revision:1,context:{},createdAt:run.startedAt,updatedAt:run.startedAt},s.input.ownerId,run.runId);
});
test('single OCR read accepts low confidence without requiring independent agreement',async()=>{
 const input=await freezeInput({ownerId:'minimum',workspace:workflowWorkspace(),mode:'dictation',validationLevel:'minimum'});let calls=0;
 const units=await recognizeWorkflowUnits(input,async(stage,data)=>{assert.deepEqual(Object.keys(data),['pageId','segmentation']);calls++;return {questions:[{number:1,paragraphs:['可读但未核验的题干'],confidence:'low',warnings:['不一致']},{number:'2',stem:'另一题正文'}]};});
 assert.equal(calls,1);assert.equal(units.length,2);assert(units.every(u=>u.availability==='usable'));
});
test('minimum content accepts optional fields and changed wording without marking it checked',()=>{
 const facts=minimumFacts({facts:[{completeStatement:'原完整知识句',candidateAnswers:['句外词']},{broken:true},{completeStatement:'邻题有效文字'}]});
 assert.equal(facts.length,2);
 const f={...facts[0],factId:'f',sourceNumbers:['1'],unitIds:['u'],evidenceRefs:[],sourceMode:'paper',reviewStatus:'unchecked',factCheck:{accurate:false,supported:false,inScope:false}};
 const item=minimumCloze({parts:[{type:'text',text:'改写句'},{type:'blank',blankId:'same',answer:'形成'},{type:'blank',blankId:'same',answer:'句外词'}]},f,'i',1);
 assert.equal(item.status,'draft');assert.equal(item.parts.filter(p=>p.type==='blank').length,2);assert.equal(new Set(item.parts.filter(p=>p.type==='blank').map(p=>p.blankId)).size,2);
});
test('minimum mode retains missing coverage but does not block the original full PDF path',async()=>{
 const s=await minimumFixture();s.ports.prepareUnits=async()=>[];
 const run=await runWorkflow(s);assert.equal(run.state,'contentReady',run.errorCode);assert.equal(run.items.length,0);assert(run.assignments.some(a=>a.uncoveredNumbers.length));
 const profile=await exportProfile(s.input,run.runId,'combined');const plan=await buildDocumentPlan(s.input,run,profile,{syntheticPreview:true});assert(plan.documents.length);
 assert(plan.documents.flatMap(d=>d.blocks).some(b=>b.text.includes('不能据此认定')));
});
test('minimum tasks restore through the same SQLite store without requiring absent independent receipts',async()=>{
 const dir=resolve('tmp/minimum-workflow/'+randomUUID());await mkdir(dir,{recursive:true});const transport=sqliteProbeTransport(resolve(dir,'workflow.sqlite'));
 try{const s=await minimumFixture();s.ports.store=new SqliteWorkflowStore(transport.invoke,s.input.ownerId);
  const run=await runWorkflow({...s,runId:'minimum-durable'});assert.equal(run.state,'contentReady',run.errorCode);
  const store=new SqliteWorkflowStore(transport.invoke,s.input.ownerId),saved=await store.task(run.runId);
  assert.equal(saved.input.validationLevel,'minimum');assert.deepEqual(saved.run,JSON.parse(JSON.stringify(run)));assert(saved.run.items.every(i=>i.status==='draft'));
 }finally{await transport.close();}
});
test('minimum report takes readable output without strict narrative rules and cannot forge checked flags',async()=>{
 const s=await minimumFixture(),base=s.model.call.bind(s.model);
 s.model.call=async(request,signal)=>request.stage==='guidance'?{value:{overview:'原模型报告含数字123，作为未核验草稿保留。',followUp:'待教师查看。'},usage:{totalTokens:10}}:base(request,signal);
 const run=await runWorkflow(s);assert.equal(run.state,'contentReady',run.errorCode);assert(run.teacherReport.overview.includes('123'));
 assert(run.advice.every(a=>a.validationStatus==='draft'));
 const task={input:s.input,run,revision:1,context:{},createdAt:run.startedAt,updatedAt:run.startedAt};
 for(const alter of [r=>r.items[0].checks.independent=true,r=>r.items[0].status='passed',r=>r.facts[0].factCheck.accurate=true]){
  const copy=structuredClone(task);alter(copy.run);await assert.rejects(()=>validateStoredTask(copy,s.input.ownerId,run.runId),/workflow_storage_corrupt/);
 }
});
