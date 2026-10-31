import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runWorkflow} from '../app/packages/agent/src/workflow/runner.ts';
import {digest,exportProfile} from '../app/packages/agent/src/workflow/input.ts';
import {setupWorkflow,workflowWorkspace} from './workflow_fixture.mjs';
import {SqliteWorkflowStore,validateStoredTask} from '../app/packages/agent/src/workflow/persistence.ts';
import {unresolvedCalls} from '../app/packages/agent/src/workflow/itemRetries.ts';
import {buildDocumentPlan} from '../app/packages/pdf/src/workflow/plan.ts';
import {sqliteProbeTransport} from '../tools/workflow-store-transport.mjs';
async function fixture(mode='exercise',failure='invalid_model_output',badCount=Infinity){
 const w=workflowWorkspace();for(const s of w.students.filter(s=>s.availability==='scored'))for(const q of s.questions){q.score=0;q.result='incorrect';}
 const s=await setupWorkflow({mode,workspace:w,validationLevel:'minimum'}),base=s.model.call.bind(s.model),stage=mode==='dictation'?'cloze':'exercise';let attempts=0;
 s.model.call=async(r,signal)=>{if(r.stage===stage&&r.data.contentId==='unit-1-fact-1'&&++attempts<=badCount){
   if(failure==='shape')return {value:{broken:true},usage:{totalTokens:13}};
   if(failure==='native-string')throw 'invalid_model_output';
   throw new Error(failure);
  }return base(r,signal);};
 return {...s,stage,attempts:()=>attempts};
}
for(const mode of ['exercise','dictation'])test(`${mode}: three malformed replies skip only that fact, retain reservations and finish other items and the report`,async()=>{
 const s=await fixture(mode),run=await runWorkflow(s);assert.equal(run.state,'contentReady',run.errorCode);assert.equal(s.attempts(),3);
 const bad=run.calls.filter(c=>c.scopeId==='unit-1-fact-1');assert.equal(bad.length,3);assert(bad.every(c=>c.status==='unknown'&&c.usage===null&&c.errorCode==='invalid_model_output'&&c.reservedTokens>0));
 assert.equal(run.items.length,1);assert.equal(run.items[0].factId,'unit-2-fact-1');assert(run.teacherReport);assert(run.skipped.some(s=>s.reason==='item_generation_exhausted'&&s.sourceNumbers.includes('1')));
 assert(run.assignments[0].uncoveredNumbers.includes('1'));assert(!unresolvedCalls(s.input,run));
 await validateStoredTask({input:s.input,run,revision:1,context:{},createdAt:run.startedAt,updatedAt:run.startedAt},s.input.ownerId,run.runId);
 const plan=await buildDocumentPlan(s.input,run,await exportProfile(s.input,run.runId,'individual'),{syntheticPreview:true});assert(plan.documents.length);
 const before=run.calls.length;await runWorkflow({...s,runId:run.runId});assert.equal((await s.store.load(s.input.ownerId,run.runId)).calls.length,before);assert.equal(s.attempts(),3);
});
test('two malformed replies followed by success produce the item on its third and final allowed request',async()=>{
 const s=await fixture('exercise','invalid_model_output',2),r=await runWorkflow(s);assert.equal(r.state,'contentReady');assert.equal(s.attempts(),3);
 assert.equal(r.items.length,2);assert.equal(r.items.find(i=>i.factId==='unit-1-fact-1').attempts,3);assert(!r.skipped.some(s=>s.reason==='item_generation_exhausted'));
});
test('parseable JSON with unusable item fields also consumes the same three-request allowance',async()=>{
 const s=await fixture('dictation','shape'),r=await runWorkflow(s);assert.equal(r.state,'contentReady');assert.equal(s.attempts(),3);
 assert(r.calls.filter(c=>c.scopeId==='unit-1-fact-1').every(c=>c.status==='completed'&&c.usage===13));assert(r.skipped.some(s=>s.reason==='item_generation_exhausted'));
});
test('native string errors are normalized and retried without losing their actual classification',async()=>{
 const s=await fixture('exercise','native-string',1),r=await runWorkflow(s);assert.equal(r.state,'contentReady');assert.equal(s.attempts(),2);assert.equal(r.calls.find(c=>c.scopeId==='unit-1-fact-1').errorCode,'invalid_model_output');
});
for(const code of ['model_quota_exhausted','model_auth_failed','workflow_storage_failed','workflow_request_timeout'])test(`${code} still stops or pauses rather than blindly repeating the request`,async()=>{
 const s=await fixture('exercise',code),r=await runWorkflow(s);assert(['failed','recoverable'].includes(r.state));assert.equal(s.attempts(),1);assert(!r.skipped.some(s=>s.reason==='item_generation_exhausted'));
});
test('legacy tasks retain their original failure behavior and do not acquire automatic retries',async()=>{
 const s=await fixture(),{itemFailurePolicy,contentHash,...body}=s.input;s.input={...body,contentHash:await digest(body)};
 const r=await runWorkflow(s);assert.equal(r.state,'failed');assert.equal(s.attempts(),1);
});
test('three attempts never override the run call budget or pretend an unmade third request occurred',async()=>{
 const s=await fixture(),r=await runWorkflow({...s,policy:{maxCalls:4}});assert.equal(r.state,'recoverable');assert.equal(r.calls.length,4);assert.equal(s.attempts(),2);assert(!r.skipped.some(s=>s.reason==='item_generation_exhausted'));
});
test('an exhausted fact stays skipped after pausing between items, with no renewed allowance',async()=>{
 const s=await fixture(),controller=new AbortController(),original=s.store.save.bind(s.store);let stopped=false;
 s.store.save=async(owner,r)=>{await original(owner,r);if(!stopped&&r.checkpoints.includes('item:unit-1-fact-1')){stopped=true;controller.abort();}};
 const first=await runWorkflow({...s,runId:'after-skipped',signal:controller.signal});assert.equal(first.state,'cancelled');assert.equal(s.attempts(),3);
 const resumed=await runWorkflow({...s,runId:'after-skipped',resume:true});assert.equal(resumed.state,'contentReady',resumed.errorCode);assert.equal(s.attempts(),3);assert(resumed.items.some(i=>i.factId==='unit-2-fact-1'));
});
test('strict generation retries malformed replies within the same three-generation limit and still independently checks success',async()=>{
 const s=await fixture('exercise','invalid_model_output',2),{validationLevel,contentHash,...body}=s.input;s.input={...body,contentHash:await digest(body)};
 const r=await runWorkflow(s);assert.equal(r.state,'contentReady',r.errorCode);assert.equal(s.attempts(),3);assert(r.items.every(i=>i.status==='passed'));assert(r.calls.some(c=>c.stage==='solve'));
});
test('network and output retries share the three-call allowance and do not leave an already recovered item blocked on resume',async()=>{
 const s=await fixture('exercise','invalid_model_output',0),base=s.model.call.bind(s.model),controller=new AbortController();let count=0;
 s.model.call=async(r,signal)=>{if(r.stage==='exercise'&&r.data.contentId==='unit-1-fact-1'){count++;if(count===1)throw new Error('workflow_network_error');if(count===2)throw new Error('invalid_model_output');}return base(r,signal);};
 const original=s.store.save.bind(s.store);let stopped=false;s.store.save=async(owner,r)=>{await original(owner,r);if(!stopped&&r.checkpoints.includes('item:unit-1-fact-1')){stopped=true;controller.abort();}};
 const r=await runWorkflow({...s,runId:'mixed',signal:controller.signal});assert.equal(count,3);assert.equal(r.state,'cancelled');assert(!unresolvedCalls(s.input,r));
 const resumed=await runWorkflow({...s,runId:'mixed',resume:true});assert.equal(resumed.state,'contentReady',resumed.errorCode);assert.equal(count,3);
});
test('SQLite reopen after an interrupted failed response uses the remaining allowance, never resets attempts or retries passed items',async()=>{
 await mkdir(resolve('tmp/item-retry-tests'),{recursive:true});const dir=await mkdtemp(resolve('tmp/item-retry-tests/run-')),database=join(dir,'workflow.sqlite');
 const a=sqliteProbeTransport(database),s=await fixture('exercise','invalid_model_output',2),controller=new AbortController();let run;
 try{const store=new SqliteWorkflowStore(a.invoke,s.input.ownerId),original=store.save.bind(store);let stopped=false;
  store.save=async(owner,value)=>{await original(owner,value);if(!stopped&&value.calls.some(c=>c.status==='unknown')){stopped=true;controller.abort();}};
  run=await runWorkflow({...s,runId:'interrupted',ports:{...s.ports,store},signal:controller.signal});assert.equal(run.state,'cancelled');assert.equal(s.attempts(),1);
 }finally{await a.close();}
 const b=sqliteProbeTransport(database);
 try{const store=new SqliteWorkflowStore(b.invoke,s.input.ownerId),saved=await store.task('interrupted');assert(!unresolvedCalls(saved.input,saved.run));
  const r=await runWorkflow({...s,input:saved.input,runId:'interrupted',ports:{...s.ports,store},resume:true});assert.equal(r.state,'contentReady',r.errorCode);assert.equal(s.attempts(),3);
  const calls=r.calls.filter(c=>c.scopeId==='unit-1-fact-1');assert.equal(calls.length,3);assert(calls.slice(0,2).every(c=>c.usage===null&&c.status==='unknown'));
  assert.equal((await store.task(r.runId)).run.calls.length,r.calls.length);
 }finally{await b.close();}
});
