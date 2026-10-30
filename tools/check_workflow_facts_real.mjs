// Real scores read-only. Protocol statements are from the approved plan, not
// actual OCR or knowledge mappings for these students. All model calls are local callbacks.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
import {freezeInput} from '../app/packages/agent/src/workflow/freeze.ts';
import {createFactAdapters} from '../app/packages/agent/src/workflow/factAdapters.ts';
import {createWorkflowHandlers} from '../app/packages/agent/src/workflow/handlers.ts';
if(!process.argv[2])throw new Error('Pass actual account workspace.sqlite path');
const path=resolve(process.argv[2]),before=readFileSync(path),db=new DatabaseSync(path,{readOnly:true});
const workspace=JSON.parse(db.prepare('SELECT payload FROM active_workspace WHERE id=1').get().payload);db.close();
const settings={difficulty:'same',includePartialCredit:true,partialCreditThreshold:100,maxBlanks:16,maxExercises:5,minCoverage:0.8};
const input=await freezeInput(workspace,basename(dirname(path)),'dictation',0,settings);
const number=input.students.find(s=>s.availability==='scored').questions[0].number;
const unit={unitId:'protocol',sourceNumbers:[number],pageIds:[],stem:'协议检查片段：细胞分化',options:[],material:'',recognitionChecks:{alignmentStatus:'aligned',readHashes:[]},availability:'recognized_by_machine'};
const signal=new AbortController().signal;
const statement={knowledgePoint:'细胞分化',completeStatement:'细胞分化的实质是基因的选择性表达',conditions:[]};
let calls=0,searches=0,revision=1,requests=[],mode='valid',checks=0;
const evidenceId='a'.repeat(64)+':1:1';
const adapters=createFactAdapters({maxCallTokens:100,libraryRevision:async()=>revision,
 search:async()=>{searches++;return [{documentId:'a'.repeat(64),name:'协议文档',page:1,ordinal:1,text:statement.completeStatement}];},
 model:async request=>{
  calls++;requests.push(request);
  if(mode==='quota')throw new Error('model_quota_exhausted');
  if(mode==='privacy')return {value:{facts:[{...statement,completeStatement:input.students[0].name}]},usage:1};
  if(request.stage==='extract_facts_v2')return {value:{units:request.data.groups.map(g=>({unitId:g.unitId,facts:mode==='badExtraction'?[{...statement,factCheck:'verified'}]:[statement]}))},usage:1};
  if(request.stage==='repair_facts_v2')return {value:{repairs:[]},usage:1};
  return {value:{decisions:request.data.groups.flatMap(g=>g.candidates.map(e=>({factId:e.candidate.factId,accurate:true,inScope:true,conditionsComplete:true,supportedEvidenceRefs:mode==='forgedRef'?['fake-ref']:e.evidence.length?[evidenceId]:[],reason:'协议核对说明，非实际事实质量验收。'})))},usage:1};
 }});
const handlers=createWorkflowHandlers(adapters,100);
const ctx={input,profile:{},signal,outputs:{aligning:{value:{units:[unit]}}},callModel:async(id,hash,budget,perform)=>(await perform()).value};
const extracted=await handlers.extracting(ctx);assert.equal(extracted.value.facts.length,1);assert.equal(extracted.value.facts[0].factCheck,'pending');checks++;
let current={...ctx,outputs:{...ctx.outputs,extracting:extracted}};
const retrieved=await handlers.retrieving(current);assert.deepEqual(retrieved.value.matches,[]);assert.equal(searches,0);checks++;
current={...current,outputs:{...current.outputs,retrieving:retrieved}};
const verified=await handlers.verifyingFacts(current);assert.equal(verified.value.facts[0].factCheck,'verified');assert.equal(verified.value.facts[0].sourceMode,'paper');checks++;
assert(!JSON.stringify(requests[1].data).includes('factCheck'));assert(!JSON.stringify(requests[1].data).includes('sourceMode'));checks++;
for(const name of input.students.map(s=>s.name))assert(!JSON.stringify(requests).includes(name));checks++;
const merged=await handlers.merging({...current,outputs:{...current.outputs,verifyingFacts:verified}});assert.equal(merged.value.facts.length,1);checks++;
const libraryInput={...input,knowledgeRevision:1};let libraryCtx={...current,input:libraryInput};
const library=await handlers.retrieving(libraryCtx);assert.equal(searches,1);assert.equal(library.value.matches[0].refs[0].id,evidenceId);checks++;
libraryCtx={...libraryCtx,outputs:{...libraryCtx.outputs,retrieving:library}};
const libraryVerified=await handlers.verifyingFacts(libraryCtx);assert.equal(libraryVerified.value.facts[0].sourceMode,'library');checks++;
mode='forgedRef';const isolated=await handlers.verifyingFacts(libraryCtx);assert.equal(isolated.value.facts[0].factCheck,'isolated');checks++;
mode='valid';const beforeStale=calls;revision=2;await assert.rejects(handlers.verifyingFacts(libraryCtx),/workflow_stale_knowledge/);assert.equal(calls,beforeStale);checks++;revision=1;
mode='badExtraction';assert.equal((await handlers.extracting(ctx)).value.facts.length,0);checks++;
mode='quota';await assert.rejects(handlers.extracting(ctx),/model_quota_exhausted/);checks++;
mode='privacy';await assert.rejects(handlers.extracting(ctx));checks++;
mode='valid';const beforeEmpty=calls;
assert.equal((await handlers.extracting({...ctx,outputs:{aligning:{value:{units:[{...unit,availability:'incomplete'}]}}}})).value.facts.length,0);assert.equal(calls,beforeEmpty);checks++;
const abort=new AbortController();abort.abort();await assert.rejects(handlers.extracting({...ctx,signal:abort.signal}),/workflow_cancelled/);assert.equal(calls,beforeEmpty);checks++;
await assert.rejects(handlers.extracting({...ctx,outputs:{aligning:{value:{units:[{...unit,recognitionChecks:{alignmentStatus:'isolated'}}]}}}}),/workflow_unaligned_fact/);checks++;
const foreign={...extracted.value.facts[0],sourceNumbers:['NOT_A_SCORE_NUMBER']};
await assert.rejects(adapters.verifyingFacts({...current,outputs:{...current.outputs,extracting:{value:{facts:[foreign]}}}}),/workflow_unaligned_fact/);checks++;
const forgedLibrary={value:{matches:[{factId:extracted.value.facts[0].factId,refs:library.value.matches[0].refs}]}};
await assert.rejects(adapters.verifyingFacts({...current,outputs:{...current.outputs,retrieving:forgedLibrary}}),/workflow_evidence_missing/);checks++;
for(const mode of ['dictation','exercise'])for(const knowledgeRevision of [0,1]){
 const context={...ctx,input:{...input,mode,knowledgeRevision}};
 const e=await handlers.extracting(context);context.outputs={...context.outputs,extracting:e};
 const r=await handlers.retrieving(context);context.outputs={...context.outputs,retrieving:r};
 const v=await handlers.verifyingFacts(context);assert.equal(v.value.facts[0].factCheck,'verified');
 assert.equal(v.value.facts[0].sourceMode,knowledgeRevision?'library':'paper');checks++;
}
const emptyLibraryAdapters=createFactAdapters({maxCallTokens:100,libraryRevision:async()=>1,search:async()=>[]});
const noHits=await emptyLibraryAdapters.retrieving(libraryCtx);assert.deepEqual(noHits.value.matches[0].refs,[]);checks++;
const noHitsVerified=await handlers.verifyingFacts({...libraryCtx,outputs:{...libraryCtx.outputs,retrieving:noHits}});
assert.equal(noHitsVerified.value.facts[0].sourceMode,'paper');checks++;
let revisionReads=0;
const changingLibrary=createFactAdapters({maxCallTokens:100,libraryRevision:async()=>++revisionReads===1?1:2,search:async()=>[]});
await assert.rejects(changingLibrary.retrieving(libraryCtx),/workflow_stale_knowledge/);checks++;
assert.deepEqual(readFileSync(path),before);
console.log(JSON.stringify({checks,students:input.students.length,sourceDatabaseUnchanged:true,realModelCalls:0,cloudCalls:0,actualKnowledgeMappingAccepted:false}));
