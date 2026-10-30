// Read-only scores supply actual question numbers; every statement/response is
// a protocol probe, never an OCR result or accepted teaching mapping.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolve,basename,dirname} from 'node:path';
import {freezeInput} from '../app/packages/agent/src/workflow/freeze.ts';
import {createFactAdapters} from '../app/packages/agent/src/workflow/factAdapters.ts';
import {createWorkflowHandlers} from '../app/packages/agent/src/workflow/handlers.ts';
if(!process.argv[2])throw new Error('Pass actual account workspace.sqlite path');
const path=resolve(process.argv[2]),before=readFileSync(path),db=new DatabaseSync(path,{readOnly:true});
const workspace=JSON.parse(db.prepare('SELECT payload FROM active_workspace WHERE id=1').get().payload);db.close();
const input=await freezeInput(workspace,basename(dirname(path)),'dictation',0,{difficulty:'same',includePartialCredit:true,partialCreditThreshold:100,maxBlanks:16,maxExercises:5,minCoverage:0.8});
const numbers=[...new Set(input.students.filter(s=>s.availability==='scored').flatMap(s=>s.questions.map(q=>q.number)))].slice(0,7);assert.equal(numbers.length,7);
const units=numbers.map((n,i)=>({unitId:`probe-${i}`,sourceNumbers:[n],pageIds:[],stem:'协议原题片段',options:[],material:'',recognitionChecks:{alignmentStatus:'aligned',readHashes:[]},availability:'recognized_by_machine'}));
const statement={knowledgePoint:'细胞分化',completeStatement:'细胞分化的实质是基因的选择性表达',conditions:[]};
let mode='ok',requests=[],checks=0,targetId;
const model=async r=>{
 requests.push(r);
 if(mode==='quota'&&r.stage==='repair_facts_v2')throw new Error('model_quota_exhausted');
 if(r.stage==='extract_facts_v2')return {value:{units:r.data.groups.map(g=>({unitId:g.unitId,facts:mode==='badOne'&&g.unitId===units[0].unitId?[{...statement,factCheck:'verified'}]:[statement]}))},usage:1};
 if(r.stage==='repair_facts_v2'){
  const failed=r.data.groups.flatMap(g=>g.candidates);
  assert(failed.every(e=>e.candidate.factId===targetId));
  return {value:{repairs:mode==='badRepair'?[{factId:'foreign',completeStatement:'越界',conditions:[]}]:failed.map(e=>({factId:e.candidate.factId,completeStatement:statement.completeStatement+'。',conditions:[]}))},usage:1};
 }
 const candidates=r.data.groups.flatMap(g=>g.candidates);
 assert(candidates.every(e=>!('failure'in e)&&!('factCheck'in e.candidate)));
 return {value:{decisions:candidates.map(e=>{const bad=mode!=='ok'&&e.candidate.factId===targetId&&(mode==='alwaysBad'||e.candidate.completeStatement===statement.completeStatement);
  return {factId:e.candidate.factId,accurate:!bad,inScope:true,conditionsComplete:true,supportedEvidenceRefs:[],reason:bad?'协议失败理由':'协议核对理由'};})},usage:1};
};
const adapters=createFactAdapters({maxCallTokens:100,model}),handlers=createWorkflowHandlers(adapters,100);
const base={input,profile:{},signal:new AbortController().signal,outputs:{aligning:{value:{units}}},callModel:async(id,hash,budget,perform)=>(await perform()).value};
const extraction=await handlers.extracting(base);assert.equal(requests.length,2);assert.deepEqual(requests.map(r=>r.data.groups.length),[6,1]);checks++;
assert.equal(extraction.value.facts.length,7);targetId=extraction.value.facts[0].factId;
const ctx={...base,outputs:{...base.outputs,extracting:extraction,retrieving:{value:{matches:[]}}}};
requests=[];const normal=await handlers.verifyingFacts(ctx);assert.equal(requests.length,2);assert(normal.value.facts.every(f=>f.factCheck==='verified'));checks++;
mode='repair';requests=[];const fixed=await handlers.verifyingFacts(ctx);
assert.deepEqual(requests.map(r=>r.stage),['verify_facts_v2','repair_facts_v2','verify_facts_v2','verify_facts_v2']);checks++;
assert.equal(fixed.value.facts[0].completeStatement,statement.completeStatement+'。');assert.equal(fixed.value.facts[0].factCheck,'verified');checks++;
assert.deepEqual(fixed.value.facts.slice(1),normal.value.facts.slice(1));checks++;
assert.deepEqual(fixed.value.facts.map(f=>f.sourceNumbers),extraction.value.facts.map(f=>f.sourceNumbers));checks++;
assert.equal(requests[1].data.groups.flatMap(g=>g.candidates).length,1);assert.equal(requests[2].data.groups.flatMap(g=>g.candidates).length,1);checks++;
mode='alwaysBad';requests=[];const failed=await handlers.verifyingFacts(ctx);assert.equal(failed.value.facts[0].factCheck,'isolated');assert.equal(requests.filter(r=>r.stage==='repair_facts_v2').length,1);checks++;
assert.equal(failed.value.facts[0].completeStatement,statement.completeStatement);checks++;
mode='badRepair';requests=[];const invalid=await handlers.verifyingFacts(ctx);assert.equal(invalid.value.facts[0].factCheck,'isolated');assert.equal(requests.length,3);checks++;
mode='quota';requests=[];await assert.rejects(handlers.verifyingFacts(ctx),/model_quota_exhausted/);assert.equal(requests.length,2);checks++;
mode='ok';requests=[];const bounded=createFactAdapters({maxCallTokens:100,maxInputBytes:4096,model});
await assert.rejects(bounded.extracting({...base,outputs:{aligning:{value:{units:[...units.slice(0,1),{...units[1],stem:'超长'.repeat(4000)}]}}}}),/workflow_input_limit/);assert.equal(requests.length,0);checks++;
const abort=new AbortController();abort.abort();await assert.rejects(handlers.verifyingFacts({...ctx,signal:abort.signal}),/workflow_cancelled/);assert.equal(requests.length,0);checks++;
mode='badOne';requests=[];const partial=await handlers.extracting(base);assert.equal(partial.value.facts.length,6);assert(!partial.value.facts.some(f=>f.sourceNumbers.includes(numbers[0])));checks++;
mode='ok';requests=[];const byteLimited=createFactAdapters({maxCallTokens:100,maxInputBytes:8192,model});
const byteResult=await byteLimited.extracting({...base,outputs:{aligning:{value:{units:units.map(u=>({...u,stem:'文'.repeat(1500)}))}}}});
assert.equal(byteResult.value.facts.length,7);assert(requests.length>2);assert(requests.every(r=>new TextEncoder().encode(JSON.stringify({prompt:r.prompt,data:r.data})).length<=8192));checks++;
// Returned repairs cannot smuggle a new mapping through the generic stage boundary.
const malicious=createWorkflowHandlers({verifyingFacts:async()=>({value:{decisions:normal.value.facts.map(f=>({factId:f.factId,accurate:true,inScope:true,conditionsComplete:true,supportedEvidenceRefs:[]})),repairs:[{factId:targetId,completeStatement:'协议',conditions:[],sourceNumbers:['foreign']}]}})},100);
await assert.rejects(malicious.verifyingFacts(ctx));checks++;
assert.deepEqual(readFileSync(path),before);
console.log(JSON.stringify({checks,realStudents:input.students.length,sourceDatabaseUnchanged:true,realModelCalls:0,cloudCalls:0,actualContentAccepted:false}));
