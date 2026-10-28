// Actual scores, no generated knowledge mapping. Empty-content and deliberately
// incorrect adapter signals exercise contracts only, not a real PDF/cloud success.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolve,basename,dirname} from 'node:path';
import {freezeInput,createExportProfile} from '../app/packages/agent/src/workflow/freeze.ts';
import {createWorkflowHandlers} from '../app/packages/agent/src/workflow/handlers.ts';
import {WorkflowRunner} from '../app/packages/agent/src/workflow/runner.ts';
import {MemoryCheckpointStore} from '../app/packages/agent/src/workflow/checkpoint.ts';
if(!process.argv[2])throw new Error('Pass actual account workspace.sqlite path');
const path=resolve(process.argv[2]),before=readFileSync(path),db=new DatabaseSync(path,{readOnly:true});
const workspace=JSON.parse(db.prepare('SELECT payload FROM active_workspace WHERE id=1').get().payload);db.close();
const settings={difficulty:'same',includePartialCredit:true,partialCreditThreshold:100,maxBlanks:16,maxExercises:5,minCoverage:0.8};
const reports={};let modelCalls=0;
for(const mode of ['dictation','exercise']){
 const input=await freezeInput(workspace,basename(dirname(path)),mode,0,settings);
 const profile=await createExportProfile(input,{runId:crypto.randomUUID(),layout:'individual',includeAnswers:true,printSettings:{paper:'a4',font:'Microsoft YaHei',fontSize:11},templateVersion:'2.0.0-draft'});
 const store=new MemoryCheckpointStore(),handlers=createWorkflowHandlers({},100);
 const runner=new WorkflowRunner(store,handlers,async()=>false);runner.create(input,profile,{maxCalls:20,maxTokens:1000,deadline:Date.now()+60000,calls:0,tokens:0,pending:{}});
 const stopped=await runner.execute(input,profile);assert.equal(stopped.state,'recoverable');assert.equal(stopped.errorCode,'workflow_service_missing');assert.equal(stopped.budget.calls,0);
 const ctx={input,profile,outputs:{},signal:new AbortController().signal,callModel:async()=>{modelCalls++;throw new Error('Do not call models during this check');}};
 const requirePaper=createWorkflowHandlers({preflight:async()=>({value:{ready:true}})},100);
 if(!input.paperFiles.length)await assert.rejects(requirePaper.preflight(ctx),/workflow_paper_required/);
 assert.deepEqual((await handlers.retrieving(ctx)).value,{matches:[]});
 // No facts have been extracted/verified. Keep this explicit rather than making up content.
 ctx.outputs.verifyingFacts={value:{facts:[]}};ctx.outputs.aligning={value:{units:[]}};
 ctx.outputs.merging=await handlers.merging(ctx);ctx.outputs.selectingTargets=await handlers.selectingTargets(ctx);
 if(mode==='dictation'){
  ctx.outputs.clozing=await handlers.clozing(ctx);ctx.outputs.validatingCloze=await handlers.validatingCloze(ctx);
  await assert.rejects(handlers.generatingExercises(ctx),/workflow_mode_mismatch/);
 }else{
  ctx.outputs.generatingExercises=await handlers.generatingExercises(ctx);ctx.outputs.solving=await handlers.solving(ctx);ctx.outputs.validatingExercise=await handlers.validatingExercise(ctx);
  await assert.rejects(handlers.clozing(ctx),/workflow_mode_mismatch/);
 }
 ctx.outputs.assembling=await handlers.assembling(ctx);const assignments=ctx.outputs.assembling.value.assignments;
 assert.equal(assignments.length,50);assert.equal(assignments.filter(a=>a.status==='partial').length,46);assert.equal(assignments.filter(a=>a.status==='unavailable').length,4);
 ctx.outputs.aggregatingEvidence=await handlers.aggregatingEvidence(ctx);ctx.outputs.writingGuidance=await handlers.writingGuidance(ctx);ctx.outputs.validatingGuidance=await handlers.validatingGuidance(ctx);
 assert.equal(ctx.outputs.validatingGuidance.value.evidence.length,0);assert.equal(ctx.outputs.validatingGuidance.value.advice.length,0);
 reports[mode]={students:assignments.length,partial:46,unavailable:4,mappedKnowledgePoints:0};
 // Incorrect QA signal must not erase the actual incomplete assignments.
 const invalidQa=createWorkflowHandlers({validatingPdf:async()=>({value:null,pdf:{contentHash:input.contentHash,exportHash:profile.exportHash,allOutputsVerified:true,coveragePassed:true}})},100);
 assert.equal((await invalidQa.validatingPdf(ctx)).pdf.coveragePassed,false);
 ctx.outputs.writingGuidance.value.scoredStudents=999;
 await assert.rejects(handlers.validatingGuidance(ctx),/workflow_guidance_evidence_mismatch/);
}
assert.equal(modelCalls,0);assert.deepEqual(readFileSync(path),before);
console.log(JSON.stringify({actualScores:reports,missingAdaptersStop:true,noLibraryPathChecked:true,partialResultsCannotOverrideCoverage:true,changedGuidanceRejected:true,sourceUnchanged:true,actualModelCalls:0,pdfFilesGenerated:0,contentPathsFullyAccepted:false}));
