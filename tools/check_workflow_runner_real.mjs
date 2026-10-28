// Real scores read-only; controlled handler failures exercise scheduler mechanics,
// not actual cloud authorization, model generation or PDF quality.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolve,basename,dirname} from 'node:path';
import {freezeInput,createExportProfile} from '../app/packages/agent/src/workflow/freeze.ts';
import {MemoryCheckpointStore} from '../app/packages/agent/src/workflow/checkpoint.ts';
import {WorkflowRunner} from '../app/packages/agent/src/workflow/runner.ts';
import {buildTeachingReport} from '../app/packages/agent/src/workflow/teachingAdvice.ts';
if(!process.argv[2])throw new Error('Pass actual account workspace.sqlite path');
const path=resolve(process.argv[2]),before=readFileSync(path),db=new DatabaseSync(path,{readOnly:true});
const workspace=JSON.parse(db.prepare('SELECT payload FROM active_workspace WHERE id=1').get().payload);db.close();
const input=await freezeInput(workspace,basename(dirname(path)),'dictation',0,{difficulty:'same',includePartialCredit:true,partialCreditThreshold:100,maxBlanks:16,maxExercises:5,minCoverage:0.8});
const profile=()=>createExportProfile(input,{runId:crypto.randomUUID(),layout:'individual',includeAnswers:true,printSettings:{paper:'a4',font:'Microsoft YaHei',fontSize:11},templateVersion:'2.0.0-draft'});
const budget=()=>({maxCalls:10,maxTokens:1000,deadline:Date.now()+60000,calls:0,tokens:0,pending:{}});
const store=new MemoryCheckpointStore();
const localPreflight=async ctx=>({value:{students:ctx.input.students.length}});
const p=await profile();const runner=new WorkflowRunner(store,{preflight:localPreflight},async()=>false);
runner.create(input,p,budget());const cp=await runner.execute(input,p);
assert.equal(cp.state,'recoverable');assert.equal(cp.errorCode,'workflow_handler_missing');assert.deepEqual(cp.completed,['preflight']);
assert.equal(cp.budget.calls,0);assert.equal(cp.outputs.preflight.value.students,50);
const detached=store.read(input.ownerId,p.runId);detached.completed.push('settling');assert.deepEqual(store.read(input.ownerId,p.runId).completed,['preflight']);
assert.throws(()=>store.write({...cp,outputs:{preflight:{value:{apiKey:'not-allowed'}}}},cp.revision),/workflow_checkpoint_secret/);
assert.throws(()=>store.write(cp,cp.revision-1),/workflow_checkpoint_conflict/);
await assert.rejects(runner.execute(input,p,{ownerId:'wrong-owner',contentHash:input.contentHash,exportHash:p.exportHash,cloudConfirmed:true}),/workflow_recovery_unconfirmed/);
// Single-account execution lock and cancellation, without a model or account API.
let unblock;const gate=new Promise(resolve=>unblock=resolve);let entered;const ready=new Promise(resolve=>entered=resolve);
const p2=await profile(),p3=await profile();
const slow=new WorkflowRunner(store,{preflight:async()=>{entered();await gate;return {value:null};}},async()=>false);
slow.create(input,p2,budget());const running=slow.execute(input,p2);await ready;
const other=new WorkflowRunner(store,{},async()=>false);other.create(input,p3,budget());
await assert.rejects(other.execute(input,p3),/workflow_busy/);slow.cancel();unblock();assert.equal((await running).state,'cancelled');
// Explicit protocol-only fault injection. No HTTP request or model output exists.
let attempts=0;const p4=await profile();
const failed=new WorkflowRunner(store,{preflight:localPreflight,authorizing:async()=>({value:null}),rendering:async()=>({value:null}),recognizing:async ctx=>{
 await ctx.callModel('interrupted-call',input.contentHash,100,async()=>{attempts++;throw new Error('model_network_failed');});return {value:null};
}},async()=>true);
failed.create(input,p4,budget());const interrupted=await failed.execute(input,p4);
assert.equal(interrupted.calls['interrupted-call'].status,'unknown');assert.equal(interrupted.budget.tokens,100);assert.equal(attempts,1);
await assert.rejects(failed.execute(input,p4,{ownerId:input.ownerId,contentHash:input.contentHash,exportHash:p4.exportHash,cloudConfirmed:true}),/workflow_(stage|call)_outcome_unknown/);
assert.equal(attempts,1);
const report=buildTeachingReport(input,[]);
assert.equal(report.scoredStudents,46);assert.equal(report.unavailableStudents,4);assert.equal(report.evidence.length,0);assert.equal(report.advice.length,0);
assert.ok(report.notices.some(t=>t.includes('知识点证据不足')));assert.equal(report.questionEvidence.length,13);
assert.deepEqual(readFileSync(path),before);
console.log(JSON.stringify({students:input.students.length,records:input.students.reduce((n,s)=>n+s.questions.length,0),memoryCheckpointChecks:true,cancelAndConcurrentLockChecked:true,unknownOutcomeNotReplayed:true,missingMappingReported:true,sourceUnchanged:true,actualModelCalls:0,cloudCalls:0,pdfFilesGenerated:0}));
