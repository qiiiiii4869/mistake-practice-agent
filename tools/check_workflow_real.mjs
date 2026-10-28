// Read-only engineering check using an explicitly supplied real account database.
// No student fixtures, model requests, cloud calls, generated questions or PDFs.
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {basename,dirname,resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {freezeInput,createExportProfile} from '../app/packages/agent/src/workflow/freeze.ts';
import {createWorkflowActor,commonStages,endingStages} from '../app/packages/agent/src/workflow/machine.ts';
import {estimateCalls,reserveCall,recordUsage} from '../app/packages/agent/src/workflow/budget.ts';

if(!process.argv[2])throw new Error('Pass the actual account workspace.sqlite path');
const path=resolve(process.argv[2]),before=readFileSync(path);
const db=new DatabaseSync(path,{readOnly:true});
const row=db.prepare('SELECT payload FROM active_workspace WHERE id=1').get();db.close();
const workspace=JSON.parse(row.payload),ownerId=basename(dirname(path));
const settings={difficulty:'same',includePartialCredit:true,partialCreditThreshold:100,maxBlanks:16,maxExercises:5,minCoverage:0.8};
const frozen=await freezeInput(workspace,ownerId,'dictation',0,settings);
const exercise=await freezeInput(workspace,ownerId,'exercise',0,settings);
assert.notEqual(frozen.contentHash,exercise.contentHash);assert.ok(Object.isFrozen(frozen.students[0]));
assert.deepEqual(frozen.students,workspace.students);
const profile={runId:crypto.randomUUID(),layout:'individual',includeAnswers:true,printSettings:{paper:'a4',font:'Microsoft YaHei',fontSize:11},templateVersion:'2.0.0-draft'};
const individual=await createExportProfile(frozen,profile);
const combined=await createExportProfile(frozen,{...profile,layout:'combined'});
assert.equal(individual.contentHash,combined.contentHash);assert.notEqual(individual.exportHash,combined.exportHash);
await assert.rejects(freezeInput(workspace,ownerId,'dictation',0,{...settings,apiKey:'must-not-be-persisted'}),/workflow_invalid_settings/);
for(const input of [frozen,exercise]){
 const exportProfile=await createExportProfile(input,profile);
 const actor=createWorkflowActor({ownerId,contentHash:input.contentHash,exportHash:exportProfile.exportHash,mode:input.mode}).start();
 actor.send({type:'START'});actor.send({type:'STEP_DONE',stage:'recognizing'});assert.equal(actor.getSnapshot().value,'preflight');
 for(const stage of commonStages)actor.send({type:'STEP_DONE',stage});
 const branch=input.mode==='dictation'?['clozing','validatingCloze']:['generatingExercises','solving','validatingExercise'];
 for(const stage of [...branch,...endingStages.filter(s=>!['validatingPdf','settling'].includes(s))])actor.send({type:'STEP_DONE',stage});
 assert.equal(actor.getSnapshot().value,'validatingPdf');
 actor.send({type:'SETTLED',contentHash:input.contentHash,exportHash:exportProfile.exportHash});assert.equal(actor.getSnapshot().value,'validatingPdf');
 actor.send({type:'PDF_VERIFIED',contentHash:input.contentHash,exportHash:exportProfile.exportHash,allOutputsVerified:false,coveragePassed:true});assert.equal(actor.getSnapshot().value,'validatingPdf');
 actor.send({type:'PDF_VERIFIED',contentHash:input.contentHash,exportHash:exportProfile.exportHash,allOutputsVerified:true,coveragePassed:true});assert.equal(actor.getSnapshot().value,'settling');
 actor.send({type:'SETTLEMENT_FAILED'});assert.equal(actor.getSnapshot().value,'pendingSettlement');
 actor.send({type:'RECOVER',ownerId:'wrong-owner',contentHash:input.contentHash,cloudConfirmed:true});assert.equal(actor.getSnapshot().value,'pendingSettlement');
 actor.send({type:'RECOVER',ownerId,contentHash:input.contentHash,cloudConfirmed:true});assert.equal(actor.getSnapshot().value,'settling');
 actor.send({type:'SETTLED',contentHash:input.contentHash,exportHash:exportProfile.exportHash});assert.equal(actor.getSnapshot().value,'completed');actor.stop();
 const cancel=createWorkflowActor({ownerId,contentHash:input.contentHash,exportHash:exportProfile.exportHash,mode:input.mode}).start();
 cancel.send({type:'START'});cancel.send({type:'CANCEL'});assert.equal(cancel.getSnapshot().value,'cancelled');cancel.stop();
 const recovery=createWorkflowActor({ownerId,contentHash:input.contentHash,exportHash:exportProfile.exportHash,mode:input.mode}).start();
 recovery.send({type:'START'});recovery.send({type:'FAIL',recoverable:true});
 recovery.send({type:'RECOVER',ownerId,contentHash:input.contentHash,cloudConfirmed:false});assert.equal(recovery.getSnapshot().value,'recoverable');
 recovery.send({type:'RECOVER',ownerId,contentHash:input.contentHash,cloudConfirmed:true});assert.equal(recovery.getSnapshot().value,'preflight');recovery.stop();
}
assert.throws(()=>estimateCalls(30,30,30),/workflow_call_budget_exceeded/);
let budget={maxCalls:2,maxTokens:100,deadline:1000,calls:0,tokens:0,pending:{}};
budget=recordUsage(reserveCall(budget,'unknown',70,1),'unknown',null);assert.equal(budget.tokens,70);
assert.throws(()=>reserveCall(budget,'next',31,2),/workflow_budget_exceeded/);
assert.deepEqual(readFileSync(path),before);
console.log(JSON.stringify({students:frozen.students.length,records:frozen.students.reduce((n,s)=>n+s.questions.length,0),modesChecked:2,contentAndExportHashesSeparated:true,stageOrderChecked:true,cancellationAndRecoveryChecked:true,unverifiedPdfBlocksSettlement:true,unknownUsageRetained:true,sourceUnchanged:true,modelCalls:0}));
