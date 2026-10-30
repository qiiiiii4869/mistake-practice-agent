import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/app.mjs';
import {openDatabase} from '../src/database.mjs';
const secret='sk-synthetic-server-only-model-key';
const body=()=>({requestKey:randomUUID(),contentHash:'a'.repeat(64),mode:'dictation',exportLayout:'individual',
  workflowVersion:'report-workflow-v1',promptVersion:'report-prompts-v1',counts:{pages:1,units:1,students:50},
  requestedBudget:{maxCalls:40,maxTokens:250000,maxRunSeconds:2700}});
async function setup(options={}){
  const folder=mkdtempSync(join(tmpdir(),'report-runs-')),databasePath=join(folder,'accounts.sqlite'),modelKeyFile=join(folder,'model-key');
  const app=await createApp({databasePath,modelKeyFile,rateLimits:false,allowLocalCredentials:true,...options}),db=openDatabase(databasePath);
  const req=async(method,url,payload,token,headers={})=>{const r=await app.inject({method,url,...(payload?{payload}:{}),headers:{...headers,...(token?{authorization:`Bearer ${token}`}:{})}});return {status:r.statusCode,data:r.json(),headers:r.headers};};
  const alice=(await req('POST','/v1/auth/register',{username:'alice',password:'Synthetic-password-42'})).data;
  const bob=(await req('POST','/v1/auth/register',{username:'bobby',password:'Synthetic-password-42'})).data;
  db.prepare("UPDATE users SET credits=3,role='admin' WHERE id=?").run(alice.user.id);
  return {folder,app,db,req,alice,bob,modelKeyFile,close:async()=>{db.close();await app.close();rmSync(folder,{recursive:true,force:true});}};
}
test('cloud key configuration, authenticated reservation, private credential, lease and cancellation',async()=>{
  const s=await setup();const {req,alice,bob,db}=s;
  try{
    assert.equal((await req('POST','/v2/report-runs',body(),alice.token)).data.error,'model_unconfigured');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generations').get().n,0);
    assert.equal((await req('POST','/v2/admin/model-config',{modelKey:secret},bob.token)).status,403);
    const configured=await req('POST','/v2/admin/model-config',{modelKey:secret},alice.token);
    assert.equal(configured.status,200);assert.equal(configured.data.configured,true);assert.ok(!JSON.stringify(configured).includes(secret));assert.equal(readFileSync(s.modelKeyFile,'utf8'),secret);
    const input=body(),run=await req('POST','/v2/report-runs',input,alice.token);assert.equal(run.status,200);assert.ok(!JSON.stringify(run).includes(secret));
    const id=run.data.jobId;assert.equal((await req('POST','/v2/report-runs',input,alice.token)).data.jobId,id);
    assert.equal((await req('POST','/v2/report-runs',{...input,mode:'exercise'},alice.token)).data.error,'idempotency_conflict');
    assert.equal((await req('POST','/v2/report-runs',body(),alice.token)).data.error,'generation_busy');
    assert.equal((await req('GET','/v1/me',null,alice.token)).data.user.available,2);
    const url=`/v2/report-runs/${id}`;
    assert.equal((await req('POST',url+'/credential',{},bob.token)).status,404);
    assert.equal((await req('POST',url+'/credential',{})).status,401);
    const credential=await req('POST',url+'/credential',{},alice.token);assert.equal(credential.data.modelKey,secret);assert.equal(credential.headers['cache-control'],'no-store');
    assert.equal((await req('GET',url,null,alice.token)).data.contentHash,input.contentHash);
    assert.equal((await req('POST',url+'/heartbeat',{stage:'extracting',calls:2,tokens:500},alice.token)).data.continue,true);
    assert.equal((await req('POST',url+'/heartbeat',{stage:'extracting',calls:1,tokens:500},alice.token)).data.error,'workflow_counter_regression');
    assert.equal((await req('POST',`/v1/generations/${id}/finish`,{success:true},alice.token)).data.error,'workflow_v2_required');
    assert.equal((await req('POST',url+'/finish',{outcome:'completed'},alice.token)).data.error,'workflow_delivery_not_enabled');
    for(let i=0;i<2;i++){const r=await req('POST',url+'/finish',{outcome:'cancelled'},alice.token);assert.equal(r.data.charged,false);assert.equal(r.data.user.credits,3);}
    assert.equal((await req('POST',url+'/credential',{},alice.token)).data.error,'generation_expired');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM report_runs').all()).includes(secret));
  }finally{await s.close();}
});
test('frozen accounts, expired jobs, lease loss and overspending stop normal clients',async()=>{
  const s=await setup({modelKey:secret});const {req,alice,db}=s;
  try{
    const id=(await req('POST','/v2/report-runs',body(),alice.token)).data.jobId,url=`/v2/report-runs/${id}`;
    db.prepare('UPDATE report_runs SET lease_until=0 WHERE job_id=?').run(id);
    assert.equal((await req('POST',url+'/heartbeat',{stage:'extracting',calls:0,tokens:0},alice.token)).data.continue,false);
    assert.equal((await req('POST',url+'/credential',{},alice.token)).status,200);
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(alice.user.id);
    assert.equal((await req('POST',url+'/credential',{},alice.token)).data.error,'account_disabled');
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(alice.user.id);
    const over=await req('POST',url+'/heartbeat',{stage:'extracting',calls:41,tokens:1},alice.token);
    assert.equal(over.data.continue,false);assert.equal(over.data.reason,'workflow_budget_exceeded');
    assert.equal((await req('POST',url+'/credential',{},alice.token)).data.error,'generation_expired');
    const next=(await req('POST','/v2/report-runs',body(),alice.token)).data.jobId;
    db.prepare('UPDATE generations SET expires_at=0 WHERE id=?').run(next);
    assert.equal((await req('POST',`/v2/report-runs/${next}/credential`,{},alice.token)).data.error,'generation_expired');
  }finally{await s.close();}
});

test('text-only reasoning policy has bounded output headroom while old clients retain their policy',async()=>{
  const s=await setup({modelKey:secret});
  try{
    for(const [promptVersion,maxOutputTokens]of [['report-prompts-v6',4096],['report-prompts-v7',16384],['report-prompts-v8',16384],['report-prompts-v9',16384],['report-prompts-v10',16384]]){
      const input={...body(),promptVersion},run=await s.req('POST','/v2/report-runs',input,s.alice.token);
      assert.equal(run.status,200);assert.equal(run.data.limits.maxOutputTokens,maxOutputTokens);
      assert.equal(run.data.limits.maxCalls,input.requestedBudget.maxCalls);assert.equal(run.data.limits.maxTokens,input.requestedBudget.maxTokens);
      assert.equal((await s.req('POST','/v2/report-runs',input,s.alice.token)).data.limits.maxOutputTokens,maxOutputTokens);
      const credential=await s.req('POST',`/v2/report-runs/${run.data.jobId}/credential`,{},s.alice.token);
      assert.equal(credential.data.limits.maxOutputTokens,maxOutputTokens);
      assert.equal((await s.req('POST',`/v2/report-runs/${run.data.jobId}/finish`,{outcome:'partial'},s.alice.token)).data.charged,false);
    }
  }finally{await s.close();}
});

test('reopening one unfinished job returns prior counters without a second reservation or charge',async()=>{
 const s=await setup({modelKey:secret});try{
  const input=body(),created=await s.req('POST','/v2/report-runs',input,s.alice.token),id=created.data.jobId;
  const beat=await s.req('POST',`/v2/report-runs/${id}/heartbeat`,{stage:'cloze',calls:5,tokens:7000},s.alice.token);assert.equal(beat.data.continue,true);
  const again=await s.req('POST','/v2/report-runs',input,s.alice.token),credential=await s.req('POST',`/v2/report-runs/${id}/credential`,{},s.alice.token);
  for(const run of [again.data,credential.data]){assert.equal(run.jobId,id);assert.equal(run.calls,5);assert.equal(run.tokens,7000);assert.equal(run.createdAt,created.data.createdAt);}
  assert.equal(s.db.prepare("SELECT count(*) n FROM generations WHERE user_id=? AND state='reserved'").get(s.alice.user.id).n,1);
  assert.equal(s.db.prepare('SELECT credits FROM users WHERE id=?').get(s.alice.user.id).credits,3);
  assert.equal((await s.req('POST',`/v2/report-runs/${id}/heartbeat`,{stage:'blindFill',calls:4,tokens:7000},s.alice.token)).data.error,'workflow_counter_regression');
 }finally{await s.close();}
});
test('production HTTPS, completion gate and exactly-once accounting remain explicit',async()=>{
  const s=await setup({modelKey:secret,allowLocalCredentials:false,deliveryEnabled:true});const {req,alice,db}=s;
  try{
    const id=(await req('POST','/v2/report-runs',body(),alice.token)).data.jobId,url=`/v2/report-runs/${id}`;
    assert.equal((await req('POST',url+'/credential',{},alice.token)).data.error,'https_required');
    const finish={outcome:'completed',manifestDigest:'b'.repeat(64),exportStatus:'verified',studentFiles:1,teacherFiles:1};
    assert.equal((await req('POST',url+'/finish',{outcome:'completed'},alice.token)).data.error,'workflow_export_not_verified');
    for(let i=0;i<2;i++){const r=await req('POST',url+'/finish',finish,alice.token);assert.equal(r.data.charged,true);assert.equal(r.data.user.credits,2);}
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE kind='generation'").get().n,1);
    assert.equal((await req('POST',url+'/finish',{outcome:'cancelled'},alice.token)).data.error,'idempotency_conflict');
  }finally{await s.close();}
});
