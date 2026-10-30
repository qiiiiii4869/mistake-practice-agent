import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowWorkspace,mockWorkflowModel} from './workflow_fixture.mjs';
import {freezeInput,runWorkflow,MemoryWorkflowStore} from '../app/packages/agent/src/workflow/index.ts';
import {estimateBudget,reserveCall} from '../app/packages/agent/src/workflow/budget.ts';
import {SqliteWorkflowStore} from '../app/packages/agent/src/workflow/persistence.ts';
import {sqliteProbeTransport} from '../tools/workflow-store-transport.mjs';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';

export async function batchFixture({mode='dictation',change,store=new MemoryWorkflowStore(),questionCount=13}={}){
 const workspace=workflowWorkspace(),student=workspace.students[0],question=student.questions[0];
 workspace.students=Array.from({length:50},(_,i)=>({...student,id:`synthetic-${i}`,name:`合成学生${i}`,questions:Array.from({length:questionCount},(_,j)=>({...question,number:String(j+1),label:String(j+1),score:0,result:'incorrect'}))}));
 workspace.paper={pages:Array.from({length:4},(_,i)=>({...workspace.paper.pages[0],id:`page-${i+1}`})),questions:[]};
 const units=Array.from({length:questionCount},(_,i)=>({unitId:`unit-${i+1}`,sourceNumbers:[String(i+1)],pageIds:[`page-${i%4+1}`],stem:`合成原题${String.fromCharCode(65+i)}的文字条件。`,material:'',options:[],availability:'usable',alignmentStatus:'recognized_by_machine'}));
 const input=await freezeInput({ownerId:'synthetic-batch-owner',workspace,mode}),fallback=mockWorkflowModel(),calls=[];
 const statement=letter=>`合成知识${letter}的约定术语是标记${letter}。`;
 const model={executionMode:'mock',cacheKey:'synthetic-batch-v1',calls,async call(request,signal){
  calls.push(structuredClone(request));const d=request.data;let value;
  if(d.groups){value={groups:d.groups.map(g=>{
    if(request.stage==='extract'){
      const letter=String.fromCharCode(64+Number(g.original.sourceNumbers[0]));
      return {unitId:g.unitId,facts:g.repair?.facts??[{knowledgePoint:`合成知识${letter}`,completeStatement:statement(letter),conditions:[],candidateAnswers:[`标记${letter}`]}]};
    }
    return {unitId:g.unitId,checks:g.facts.map(()=>({accurate:true,supported:true,inScope:true}))};
   })};
  }else if(request.stage==='cloze'){
   const answer=d.candidateAnswers[0],at=d.statement.indexOf(answer);value={parts:[{type:'text',text:d.statement.slice(0,at)},{type:'blank',blankId:'b1',answer,acceptedAnswers:[answer]},{type:'text',text:d.statement.slice(at+answer.length)}],correction:'合成协议，不作教学验收。'};
  }else if(request.stage==='blindFill'){
   const n=Number(d.contentId.match(/^unit-(\d+)/)[1]),letter=String.fromCharCode(64+n);value={answers:[{blankId:'b1',value:`标记${letter}`}],ambiguous:false,missingConditions:false};
  }else if(request.stage==='exercise')value={type:'single_choice',stem:`${d.fact.knowledgePoint}的合成检验问题是什么？`,material:'按合成规则选符合项。',options:[{id:'A',text:'符合约定'},{id:'B',text:'不符合约定'}],answer:['A'],rubric:['区分合成约定'],explanation:'仅验证流程。',estimatedMinutes:2};
  else if(request.stage==='solve')value={complete:true,inScope:true,tooSimilar:false,answer:['A']};
  else return fallback.call(request,signal);
  const response={value,usage:{totalTokens:100}};return change?await change(request,response):response;
 }};
 const ports={model,store,prepareUnits:async()=>structuredClone(units),retrieve:async()=>[]};return {input,ports,model,units};
}

test('15 originals / 4 pages fit the explicitly authorized 300-call ceiling; 301st call is blocked',()=>{
 assert.equal(estimateBudget('dictation',4,13).maxCalls,230);
 const policy=estimateBudget('dictation',4,15,true);assert.equal(policy.maxCalls,300);
 assert.throws(()=>estimateBudget('dictation',30,80,true),/workflow_initial_budget_exceeded/);
 const calls=Array.from({length:299},()=>({usage:1,attempt:1,stage:'extract',scopeId:'other'}));
 calls.push(reserveCall(policy,calls,'cloze','hash',10,1,0,1,'last'));
 assert.equal(calls.length,300);
 assert.throws(()=>reserveCall(policy,calls,'cloze','hash',10,1,0,1,'overflow'),/workflow_budget_exceeded/);
});
for(const mode of ['dictation','exercise'])test(`third-week scale: 50 students / 15 originals / 4 pages / ${mode}`,async()=>{
 const s=await batchFixture({mode,questionCount:15}),run=await runWorkflow(s);
 assert.equal(run.state,'contentReady',run.errorCode);assert.equal(run.policy.maxCalls,300);
 assert.equal(run.facts.length,15);assert.equal(run.evidence.totalQuestions,15);assert.equal(run.evidence.mappedQuestions,15);
 assert.equal(run.assignments.length,50);assert(run.assignments.every(a=>a.status==='ready'));assert(run.teacherReport);
 assert.deepEqual(run.analysisBatches.map(g=>g.length),[6,6,3]);
});
for(const mode of ['dictation','exercise'])test(`50 students, 13 originals / ${mode}: shared batches, full mapping and teacher report`,async()=>{
 const s=await batchFixture({mode}),run=await runWorkflow(s);
 assert.equal(run.state,'contentReady',run.errorCode);assert.equal(run.facts.length,13);assert.equal(run.assignments.length,50);assert(run.assignments.every(a=>a.status==='ready'));
 assert(run.teacherReport);assert.deepEqual(run.analysisBatches.map(g=>g.length),[6,6,1]);
 assert.equal(s.model.calls.filter(r=>r.stage==='extract').length,3);assert.equal(s.model.calls.filter(r=>r.stage==='verifyFact').length,3);
 assert.equal(run.calls.filter(r=>r.stage==='guidance').length,1);assert(run.calls.length<=200);
 assert.equal(run.evidence.totalQuestions,13);assert.equal(run.evidence.mappedQuestions,13);
 for(const student of s.input.workspace.students){assert(!JSON.stringify(s.model.calls).includes(student.name));assert(!JSON.stringify(s.model.calls).includes(`"${student.id}"`));}
});
test('wrong / repeated batch unit IDs cannot turn unrelated content into reliable mappings',async()=>{
 const s=await batchFixture({change:(r,response)=>r.stage==='extract'?{...response,value:{groups:[{...response.value.groups[0],unitId:'foreign'}]}}:response});
 const run=await runWorkflow(s);assert.equal(run.state,'partial');assert.equal(run.facts.length,0);assert.equal(run.assignments.length,50);assert(run.assignments.every(a=>a.uncoveredNumbers.length===13));
});
test('only failed facts are repaired once; passing facts and every source number survive',async()=>{
 let checkCount=0,repairCount=0;
 const s=await batchFixture({change:(r,response)=>{
  if(r.stage==='verifyFact'&&r.data.groups.some(g=>g.unitId==='unit-1')&&checkCount++===0)response.value.groups.find(g=>g.unitId==='unit-1').checks[0].accurate=false;
  if(r.stage==='extract'&&r.data.groups.some(g=>g.repair)){repairCount++;assert.deepEqual(r.data.groups.map(g=>g.unitId),['unit-1']);}
  return response;
 }});const run=await runWorkflow(s);assert.equal(run.state,'contentReady',run.errorCode);assert.equal(repairCount,1);assert.equal(run.facts.length,13);assert.equal(run.facts.filter(f=>f.sourceNumbers.includes('1')).length,1);
});
test('one malformed fact does not discard the other original questions in the batch',async()=>{
 const s=await batchFixture({change:(r,response)=>{if(r.stage==='extract'&&response.value.groups.some(g=>g.unitId==='unit-1'))response.value.groups.find(g=>g.unitId==='unit-1').facts[0].candidateAnswers=['不在知识句中'];return response;}});
 const run=await runWorkflow(s);assert.equal(run.state,'partial');assert.equal(run.facts.length,12);assert(run.assignments.every(a=>a.uncoveredNumbers.includes('1')));
});
test('one empty fact group skips retrieval and verification while valid neighbours continue',async()=>{
 const queries=[];
 const s=await batchFixture({change:(r,response)=>{
  if(r.stage==='extract')for(const group of response.value.groups??[])if(group.unitId==='unit-4')group.facts=[];
  return response;
 }});
 s.ports.retrieve=async query=>{assert(query.trim());assert([...query].length<=100);queries.push(query);return [];};
 const run=await runWorkflow(s);assert.equal(run.state,'partial',run.errorCode);assert.equal(run.errorCode,undefined);
 assert.equal(run.draftFacts['unit-4'],undefined);assert.equal(queries.length,12);assert.equal(run.facts.length,12);
 assert(run.assignments.every(a=>a.uncoveredNumbers.includes('4')));
 assert(run.skipped.some(s=>s.reason==='text_evidence_insufficient'&&s.sourceNumbers.includes('4')));
 assert(s.model.calls.filter(c=>c.stage==='verifyFact').every(c=>c.data.groups.every(g=>g.unitId!=='unit-4')));
});
test('all empty fact groups make no retrieval, verification or item requests and stay visibly incomplete',async()=>{
 const s=await batchFixture({change:(r,response)=>{
  if(r.stage==='extract')for(const group of response.value.groups??[])group.facts=[];
  return response;
 }});
 s.ports.retrieve=async()=>{throw Error('empty extraction must not search');};
 const run=await runWorkflow(s);assert.equal(run.state,'partial',run.errorCode);assert.equal(run.facts.length,0);assert.equal(run.items.length,0);
 assert(s.model.calls.every(c=>c.stage==='extract'));assert.equal(Object.keys(run.draftFacts).length,0);
 assert(run.assignments.every(a=>a.uncoveredNumbers.length===13));assert.equal(run.teacherReport.generatedBy,'template');
});
test('a legacy empty retrieval frame is completed locally on resume without repeating extraction',async()=>{
 const s=await batchFixture(),store=s.ports.store,runId='legacy-empty-retrieval';
 s.ports.retrieve=async query=>{if(query.includes('合成知识D'))throw 'knowledge_invalid_query';return [];};
 const first=await runWorkflow({...s,runId});assert.equal(first.state,'failed');assert.equal(first.errorCode,'knowledge_invalid_query');
 assert.equal(first.frame.id,'retrieve:unit-4');assert.equal(first.calls.length,3);
 // Simulate the exact old writer shape, without touching any real task/database.
 const saved=structuredClone(first);saved.draftFacts['unit-4']=[];saved.frame.data.draftFacts['unit-4']=[];
 await store.save(s.input.ownerId,saved);
 const queries=[];s.ports.retrieve=async query=>{assert(query.trim());queries.push(query);return [];};
 const resumed=await runWorkflow({...s,runId,resume:true});assert.equal(resumed.state,'partial',resumed.errorCode);
 assert.equal(resumed.facts.length,12);assert.equal(resumed.frame,undefined);assert(resumed.checkpoints.includes('retrieve:unit-4'));
 assert.deepEqual(resumed.unitEvidence['unit-4'],[]);assert.equal(queries.length,9);
 assert.equal(s.model.calls.filter(c=>c.stage==='extract').length,3);
});
test('cancel after a committed batch response reuses it on resume without re-reading accepted content',async()=>{
 const store=new MemoryWorkflowStore(),controller=new AbortController(),complete=store.completeCall.bind(store);let cancelled=false;
 store.completeCall=async(owner,run,id,response)=>{await complete(owner,run,id,response);if(run.calls.at(-1).stage==='verifyFact'&&!cancelled){cancelled=true;controller.abort();}};
 const s=await batchFixture({store}),first=await runWorkflow({...s,runId:'resume-batch',signal:controller.signal});assert.equal(first.state,'cancelled');
 const second=await runWorkflow({...s,runId:'resume-batch',resume:true});assert.equal(second.state,'contentReady',second.errorCode);assert.equal(second.facts.length,13);
 assert.equal(s.model.calls.filter(c=>c.stage==='verifyFact').length,3);assert.equal(new Set(second.facts.map(f=>f.factId)).size,13);
});
test('batched task plans and final results survive SQLite reopen without resetting calls',async()=>{
 const dir=resolve('tmp/workflow-batch-persistence/'+randomUUID());await mkdir(dir,{recursive:true});const database=join(dir,'workflow.sqlite');
 const first=sqliteProbeTransport(database);let s,count;
 try{s=await batchFixture();s.ports.store=new SqliteWorkflowStore(first.invoke,s.input.ownerId);const run=await runWorkflow({...s,runId:'batch-durable'});assert.equal(run.state,'contentReady',run.errorCode);count=run.calls.length;}finally{await first.close();}
 const second=sqliteProbeTransport(database);try{const store=new SqliteWorkflowStore(second.invoke,s.input.ownerId),task=await store.task('batch-durable');assert.equal(task.run.facts.length,13);assert.equal(task.run.calls.length,count);assert.equal(task.run.analysisBatches.length,3);}finally{await second.close();}
});
test('a 300-call task restores its full ledger; native storage and frontend both reject 301',async()=>{
 const dir=resolve('tmp/workflow-300-persistence/'+randomUUID());await mkdir(dir,{recursive:true});const database=join(dir,'workflow.sqlite');
 const transport=sqliteProbeTransport(database),s=await batchFixture({questionCount:15});
 const store=new SqliteWorkflowStore(transport.invoke,s.input.ownerId);s.ports.store=store;
 try{
  const run=await runWorkflow({...s,runId:'over-200-ledger'});
  assert.equal(run.state,'contentReady',run.errorCode);assert.equal(run.policy.maxCalls,300);
  await store.beginRun(s.input,run.runId,{},()=>{});
  while(run.calls.length<300)run.calls.push({callId:`unknown-${run.calls.length}`,stage:'extract',scopeId:`scope-${run.calls.length}`,requestHash:'a'.repeat(64),attempt:1,status:'unknown',reservedTokens:1,usage:null,startedAt:run.startedAt});
  await store.save(s.input.ownerId,run);await store.endRun(s.input.ownerId,run.runId);
  const restored=new SqliteWorkflowStore(transport.invoke,s.input.ownerId),task=await restored.task(run.runId);
  assert.equal(task.run.calls.length,300);assert.equal(task.run.policy.maxCalls,300);
  await restored.beginRun(s.input,run.runId,{},()=>{});
  const overflow=structuredClone(task);overflow.run.calls.push({...overflow.run.calls.at(-1),callId:'overflow'});
  await assert.rejects(()=>restored.save(s.input.ownerId,overflow.run),/workflow_storage_invalid/);
  const {validateStoredTask}=await import('../app/packages/agent/src/workflow/persistence.ts');
  await assert.rejects(()=>validateStoredTask(overflow,s.input.ownerId,run.runId),/workflow_storage_corrupt/);
  task.run.policy.maxCalls=301;
  await assert.rejects(()=>restored.save(s.input.ownerId,task.run),/workflow_storage_invalid/);
  await assert.rejects(()=>validateStoredTask(task,s.input.ownerId,run.runId),/workflow_storage_corrupt/);
  await restored.endRun(s.input.ownerId,run.runId);
 }finally{await transport.close();}
});
test('a smaller authorized call limit still stops new batch calls and preserves all input targets',async()=>{
 const s=await batchFixture(),run=await runWorkflow({...s,runId:'small-authorized-budget',policy:{maxCalls:20}});
 assert.equal(run.state,'recoverable');assert.equal(run.errorCode,'workflow_budget_estimate_exceeded');assert.equal(s.model.calls.length,0);assert.equal(run.units.length,13);
 const resumed=await runWorkflow({...s,runId:'small-authorized-budget',resume:true});assert.equal(resumed.policy.maxCalls,20);assert.equal(resumed.state,'recoverable');assert.equal(s.model.calls.length,0);
});
test('a single overlong original stops before extraction rather than trimming its text',async()=>{
 const s=await batchFixture();s.units[0].stem='长'.repeat(19000);s.ports.prepareUnits=async()=>structuredClone(s.units);
 const run=await runWorkflow(s);assert.equal(run.state,'recoverable');assert.equal(run.errorCode,'workflow_batch_input_exceeded');assert.equal(s.model.calls.length,0);assert.equal(run.units[0].stem.length,19000);
});
