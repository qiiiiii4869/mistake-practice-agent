import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {SqliteWorkflowStore,runWorkflow,freezeInput,exportProfile} from '../app/packages/agent/src/workflow/index.ts';
import {canonical} from '../app/packages/agent/src/workflow/input.ts';
import {setupWorkflow} from './workflow_fixture.mjs';
import {sqliteProbeTransport} from '../tools/workflow-store-transport.mjs';

const root=resolve('tmp/workflow-persistence-tests/'+randomUUID());await mkdir(root,{recursive:true});
const database=()=>join(root,randomUUID()+'.sqlite');
async function crashFixture(pending=false,extra={}){
  const db=database(),log=join(root,randomUUID()+'.log'),config=join(root,randomUUID()+'.json'),runId=randomUUID();
  await writeFile(config,JSON.stringify({database:db,log,runId,pending,...extra}));
  const child=spawn(process.execPath,['tests/workflow_persistence_child.mjs',config],{windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);});assert.equal(code,pending?24:23,stderr);
  return {db,log,runId};
}
test('completed tasks survive independent database reopen with no model calls',async()=>{
  const db=database(),a=sqliteProbeTransport(db),s=await setupWorkflow();let run;
  try{run=await runWorkflow({input:s.input,runId:'completed',ports:{...s.ports,store:new SqliteWorkflowStore(a.invoke,s.input.ownerId)}});assert.equal(run.state,'contentReady');}
  finally{await a.close();}
  const b=sqliteProbeTransport(db),model=await setupWorkflow();
  try{const store=new SqliteWorkflowStore(b.invoke,s.input.ownerId),copy=await store.task('completed');assert.deepEqual(copy.run,JSON.parse(JSON.stringify(run)));
    const restored=await runWorkflow({input:copy.input,runId:'completed',ports:{...model.ports,store}});assert.equal(restored.state,'contentReady');assert.equal(model.model.calls.length,0);
    assert.equal((await store.list())[0].callCount,7);
  }finally{await b.close();}
});
test('OCR response survives a process crash and the resumed reread uses only the missing independent call',async()=>{
  const f=await crashFixture(false,{recognition:true,stage:'recognize'}),t=sqliteProbeTransport(f.db,{now:()=>33001}),s=await setupWorkflow();
  try{const store=new SqliteWorkflowStore(t.invoke,s.input.ownerId),task=await store.task(f.runId);
    const {recognizeWorkflowUnits}=await import('../app/packages/agent/src/workflow/recognition.ts');
    s.ports.prepareUnits=(input,signal,invoke,report)=>recognizeWorkflowUnits(input,invoke,[],report);
    const base=s.model.call.bind(s.model);s.model.call=async(request,signal)=>{await appendFile(f.log,request.stage+'\n');
      if(request.stage==='recognize')return {value:{questions:[{number:'1',paragraphs:['说明光合作用中的能量转化。'],confidence:'high'},{number:'2',paragraphs:['说明细胞分化的实质。'],confidence:'high'}],warnings:[]},usage:{totalTokens:20}};
      return base(request,signal);};
    const run=await runWorkflow({input:task.input,ports:{...s.ports,store},runId:f.runId,resume:true});
    assert.equal(run.state,'contentReady');assert.equal((await readFile(f.log,'utf8')).split('\n').filter(s=>s==='recognize').length,2);
  }finally{await t.close();}
});
test('a crash inside fact checking replays the committed check without losing or duplicating facts',async()=>{
 const f=await crashFixture(false,{stage:'verifyFact'}),t=sqliteProbeTransport(f.db,{now:()=>33001}),s=await setupWorkflow();
 try{const store=new SqliteWorkflowStore(t.invoke,s.input.ownerId),task=await store.task(f.runId),base=s.model.call.bind(s.model);
  s.model.call=async(r,signal)=>{await appendFile(f.log,r.stage+'\n');return base(r,signal);};
  const run=await runWorkflow({input:task.input,ports:{...s.ports,store},runId:f.runId,resume:true});
  assert.equal(run.state,'contentReady');assert.equal(run.facts.length,2);
  assert.equal((await readFile(f.log,'utf8')).split('\n').filter(s=>s==='verifyFact').length,2);
 }finally{await t.close();}
});
test('process crash after response commit replays the unfinished step without repeating its model request',async()=>{
  const f=await crashFixture(),t=sqliteProbeTransport(f.db,{now:()=>33001}),s=await setupWorkflow();
  try{const store=new SqliteWorkflowStore(t.invoke,s.input.ownerId),task=await store.task(f.runId);
    assert.ok(task.run.frame);assert.equal(task.run.calls.at(-1).status,'completed');
    const base=s.ports.model.call.bind(s.ports.model);s.ports.model.call=async(r,signal)=>{await appendFile(f.log,r.stage+'\n');return base(r,signal);};
    const resumed=await runWorkflow({input:task.input,ports:{...s.ports,store},runId:f.runId,resume:true});
    assert.equal(resumed.state,'contentReady');assert.equal(resumed.calls.length,7);assert.equal(resumed.frame,undefined);
    const calls=(await readFile(f.log,'utf8')).trim().split('\n');assert.equal(calls.length,7);assert.equal(calls.filter(c=>c==='cloze').length,1);
  }finally{await t.close();}
});
test('unknown in-flight result never automatically repeats; explicit retry keeps the old budget reservation',async()=>{
  const f=await crashFixture(true),t=sqliteProbeTransport(f.db,{now:()=>33001}),s=await setupWorkflow();
  try{const store=new SqliteWorkflowStore(t.invoke,s.input.ownerId),task=await store.task(f.runId);
    await assert.rejects(runWorkflow({input:task.input,ports:{...s.ports,store},runId:f.runId,resume:true}),/workflow_unknown_call_requires_decision/);assert.equal(s.model.calls.length,0);
    const run=await runWorkflow({input:task.input,ports:{...s.ports,store},runId:f.runId,resume:true,retryUnknownCalls:true});
    assert.equal(run.state,'contentReady');assert.equal(run.calls.length,8);
    const unknown=run.calls.find(c=>c.status==='unknown');assert.ok(unknown.reservedTokens>16384);assert.equal(unknown.usage,null);
  }finally{await t.close();}
});
test('account namespaces and owner leases prevent reading or writing another account or live executor',async()=>{
  const db=database(),t=sqliteProbeTransport(db,{now:()=>1000}),s=await setupWorkflow(),owner=s.input.ownerId;
  try{const a=new SqliteWorkflowStore(t.invoke,owner),b=new SqliteWorkflowStore(t.invoke,owner);
    await a.beginRun(s.input,'locked',{},()=>{});
    await assert.rejects(b.beginRun(s.input,'other',{},()=>{}),/workflow_busy/);
    assert.equal((await new SqliteWorkflowStore(t.invoke,'other-owner').task('locked')),null);
    await assert.rejects(a.load('other-owner','locked'),/workflow_owner_mismatch/);
    await a.endRun(owner,'locked');
  }finally{await t.close();}
});
test('expired process cannot overwrite a newer lease or silently reset accounting',async()=>{
  const db=database();let clock=1000;const t=sqliteProbeTransport(db,{now:()=>clock}),s=await setupWorkflow();
  try{const a=new SqliteWorkflowStore(t.invoke,s.input.ownerId),b=new SqliteWorkflowStore(t.invoke,s.input.ownerId);
    await a.beginRun(s.input,'lease',{},()=>{});clock=32000;await b.beginRun(s.input,'lease',{},()=>{});
    const run=await runWorkflow(s);run.runId='lease';
    await assert.rejects(a.save(s.input.ownerId,run),/workflow_lease_lost/);
    await a.endRun(s.input.ownerId,'lease');await b.save(s.input.ownerId,run).then(()=>assert.fail('missing atomic receipts should not be accepted'),e=>assert.ok(e));
    await b.endRun(s.input.ownerId,'lease');
  }finally{await t.close();}
});
test('credentials and malformed input checksums are rejected before storage',async()=>{
  const db=database(),t=sqliteProbeTransport(db),s=await setupWorkflow();
  try{const {contentHash,...body}=s.input,base={ownerId:s.input.ownerId,operation:'begin',payload:{runId:'secret-test',input:s.input,context:{},leaseId:'lease',expectedRevision:0,canonicalInput:canonical(body)}};
    await assert.rejects(t.invoke('workflow_store',{...base,payload:{...base.payload,modelKey:'synthetic-forbidden-value'}}),/workflow_secret_blocked/);
    await assert.rejects(t.invoke('workflow_store',{...base,payload:{...base.payload,canonicalInput:'{}'}}),/workflow_input_checksum/);
    const d=new DatabaseSync(db);assert.equal(d.prepare('SELECT count(*) n FROM workflow_runs').get().n,0);d.close();
  }finally{await t.close();}
});
test('corrupt committed response stops recovery without a new model request',async()=>{
  const f=await crashFixture(),db=new DatabaseSync(f.db);db.prepare("UPDATE model_calls SET response_json='{}' WHERE stage='cloze'").run();db.close();
  const t=sqliteProbeTransport(f.db,{now:()=>33001}),s=await setupWorkflow();
  try{const store=new SqliteWorkflowStore(t.invoke,s.input.ownerId);await assert.rejects(store.task(f.runId),/workflow_storage_corrupt/);assert.equal(s.model.calls.length,0);}
  finally{await t.close();}
});
test('receipt and usage transaction rolls back together on write failure and stops generation',async()=>{
 const db=database(),t=sqliteProbeTransport(db),s=await setupWorkflow();let installed=false;
 const base=s.model.call.bind(s.model);s.model.call=async(r,signal)=>{
  if(!installed){installed=true;const native=new DatabaseSync(db);native.exec(`CREATE TRIGGER reject_completed BEFORE UPDATE ON workflow_runs WHEN NEW.run_json LIKE '%"status":"completed"%' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;`);native.close();}
  return base(r,signal);
 };
 try{const store=new SqliteWorkflowStore(t.invoke,s.input.ownerId),run=await runWorkflow({input:s.input,ports:{...s.ports,store},runId:'atomic-failure'});
  assert.equal(run.state,'recoverable');assert.equal(run.errorCode,'workflow_storage_failed');assert.equal(s.model.calls.length,1);
  const native=new DatabaseSync(db);assert.equal(native.prepare('SELECT count(*) n FROM model_calls WHERE response_json IS NOT NULL').get().n,0);
  assert.equal(native.prepare('SELECT status FROM model_calls').get().status,'unknown');native.close();
 }finally{await t.close();}
});
test('changed frozen data and mode cannot reuse another task; common analysis remains account and model scoped after reopen',async()=>{
 const db=database(),a=sqliteProbeTransport(db),s=await setupWorkflow();s.model.cacheKey='synthetic-model-v1';
 try{await runWorkflow({input:s.input,ports:{...s.ports,store:new SqliteWorkflowStore(a.invoke,s.input.ownerId)},runId:'cache-dictation'});}finally{await a.close();}
 const b=sqliteProbeTransport(db),next=await setupWorkflow();next.model.cacheKey='synthetic-model-v1';
 try{const store=new SqliteWorkflowStore(b.invoke,s.input.ownerId),exercise=await freezeInput({ownerId:s.input.ownerId,workspace:s.input.workspace,mode:'exercise'});
  const run=await runWorkflow({input:exercise,ports:{...next.ports,store},runId:'cache-exercise'});assert.equal(run.state,'contentReady');assert.equal(run.analysisCacheHit,true);
  assert.deepEqual(next.model.calls.map(c=>c.stage),['exercise','solve','guidance']);
  const check=new SqliteWorkflowStore(b.invoke,s.input.ownerId);assert.equal((await check.task('cache-exercise')).run.items[0].mode,'exercise');
  await assert.rejects(runWorkflow({input:exercise,ports:{...next.ports,store:check},runId:'cache-dictation',resume:true}),/workflow_stale_run/);
  const changed=await freezeInput({ownerId:s.input.ownerId,workspace:s.input.workspace,mode:'dictation',knowledgeRevision:'new-library'});
  await assert.rejects(runWorkflow({input:changed,ports:{...next.ports,store:check},runId:'cache-dictation',resume:true}),/workflow_stale_run/);
 }finally{await b.close();}
});
test('restored deadline never resets and an expired unfinished task makes no new model request',async()=>{
 const f=await crashFixture(),t=sqliteProbeTransport(f.db,{now:()=>33001}),s=await setupWorkflow();
 try{const store=new SqliteWorkflowStore(t.invoke,s.input.ownerId),task=await store.task(f.runId);
  const run=await runWorkflow({input:task.input,ports:{...s.ports,store,now:()=>task.run.startedAt+task.run.policy.maxRunMs+1},runId:f.runId,resume:true});
  assert.equal(run.state,'recoverable');assert.equal(run.errorCode,'workflow_deadline');assert.equal(s.model.calls.length,0);
  assert.equal(run.startedAt,task.run.startedAt);assert.equal(run.calls.length,task.run.calls.length);
 }finally{await t.close();}
});
