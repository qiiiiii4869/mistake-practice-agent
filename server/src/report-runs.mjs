import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { transaction, expireJobs, publicUser } from './database.mjs';

const fail=(code,statusCode=400)=>{throw Object.assign(new Error(code),{statusCode});};
const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const uuid={type:'string',pattern:'^[a-f0-9-]{36}$'};
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const version={type:'string',minLength:1,maxLength:80,pattern:'^[a-zA-Z0-9._-]+$'};
const validKey=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{16,256}$/.test(value);
const MODEL='deepseek-flash', ENDPOINT='https://api.deepseek.com/chat/completions';

export function registerReportRoutes(app,{db,authenticated,administrator,modelKey='',modelKeyFile,deliveryEnabled=false,allowLocalCredentials=false}){
  const configuredFile=modelKeyFile?resolve(modelKeyFile):null;
  function key(){
    let value=modelKey;
    if(configuredFile){try{value=readFileSync(configuredFile,'utf8').trim();}catch(error){if(error.code!=='ENOENT')fail('model_configuration_failed',503);}}
    return validKey(value)?value:null;
  }
  const modelInfo=()=>{const value=key();return {configured:!!value,model:MODEL,endpoint:ENDPOINT,
    modelConfigVersion:value?createHash('sha256').update(value).digest('hex').slice(0,16):null,deliveryEnabled};};
  function transport(request){
    if(request.protocol!=='https'&&!(allowLocalCredentials&&['localhost','127.0.0.1','[::1]'].includes(request.hostname)))fail('https_required',403);
  }
  function owned(request){
    expireJobs(db);
    const run=db.prepare('SELECT r.*,g.user_id,g.state,g.created_at,g.expires_at FROM report_runs r JOIN generations g ON g.id=r.job_id WHERE r.job_id=? AND g.user_id=?').get(request.params.id,request.account.id);
    if(!run)fail('generation_not_found',404);
    return run;
  }
  const active=run=>{if(run.state!=='reserved'||run.expires_at<=Date.now())fail('generation_expired',409);};
  function summary(run){return {jobId:run.job_id,state:run.state,mode:run.mode,contentHash:run.content_hash,
    calls:run.calls,tokens:run.tokens,createdAt:run.created_at,
    limits:JSON.parse(run.policy_json),policyVersion:'report-policy-v1',leaseUntil:run.lease_until,expiresAt:run.expires_at,
    charged:run.state==='completed',outcome:run.outcome,...modelInfo()};}
  app.get('/v2/model-status',{preHandler:authenticated},async()=>modelInfo());
  app.get('/v2/active-report-run',{preHandler:authenticated},async(request)=>{
    expireJobs(db);const run=db.prepare("SELECT r.*,g.state,g.created_at,g.expires_at FROM report_runs r JOIN generations g ON g.id=r.job_id WHERE g.user_id=? AND g.state='reserved'").get(request.account.id);
    return {jobId:run?.job_id??null};
  });
  app.post('/v2/admin/model-config',{preHandler:administrator,schema:{body:object({modelKey:{type:'string',pattern:'^[a-zA-Z0-9_-]{16,256}$'}})}},async(request)=>{
    transport(request);
    if(!configuredFile)fail('model_configuration_failed',503);
    const temporary=`${configuredFile}.${randomUUID()}.tmp`;
    try{mkdirSync(dirname(configuredFile),{recursive:true,mode:0o700});writeFileSync(temporary,request.body.modelKey,{mode:0o600,flag:'wx'});
      renameSync(temporary,configuredFile);chmodSync(configuredFile,0o600);
    }catch{fail('model_configuration_failed',503);}
    return modelInfo();
  });
  app.post('/v2/report-runs',{preHandler:authenticated,schema:{body:object({requestKey:uuid,contentHash:hash,
    mode:{enum:['dictation','exercise']},exportLayout:{enum:['individual','combined']},workflowVersion:version,promptVersion:version,
    counts:object({pages:integer(1,30),units:integer(1,80),students:integer(1,100)}),
    requestedBudget:object({maxCalls:integer(1,200),maxTokens:integer(4096,2000000),maxRunSeconds:integer(1,2700)})})}},async(request)=>transaction(db,()=>{
      if(!key())fail('model_unconfigured',503);
      expireJobs(db);const body=request.body;
      const old=db.prepare('SELECT r.*,g.state,g.created_at,g.expires_at FROM report_runs r JOIN generations g ON g.id=r.job_id WHERE g.user_id=? AND g.request_key=?').get(request.account.id,body.requestKey);
      if(old){if(old.content_hash!==body.contentHash||old.mode!==body.mode||old.export_layout!==body.exportLayout
        ||old.workflow_version!==body.workflowVersion||old.prompt_version!==body.promptVersion)fail('idempotency_conflict',409);return summary(old);}
      if(db.prepare("SELECT id FROM generations WHERE user_id=? AND state='reserved'").get(request.account.id))fail('generation_busy',409);
      if(db.prepare('SELECT id FROM generations WHERE user_id=? AND request_key=?').get(request.account.id,body.requestKey))fail('idempotency_conflict',409);
      const user=db.prepare('SELECT * FROM users WHERE id=?').get(request.account.id);if(user.credits<1)fail('credits_exhausted',409);
      const now=Date.now(),jobId=randomUUID(),expires=now+2*3600000;
      const policy={maxCalls:body.requestedBudget.maxCalls,maxTokens:body.requestedBudget.maxTokens,
        maxRunSeconds:body.requestedBudget.maxRunSeconds,maxOutputTokens:['report-prompts-v7','report-prompts-v8','report-prompts-v9','report-prompts-v10'].includes(body.promptVersion)?16384:4096,maxInputBytes:32000,heartbeatSeconds:20};
      db.prepare("INSERT INTO generations VALUES(?,?,?,'reserved',?,?,NULL)").run(jobId,user.id,body.requestKey,now,expires);
      db.prepare('INSERT INTO report_runs(job_id,content_hash,mode,export_layout,workflow_version,prompt_version,policy_json,lease_until,heartbeat_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(jobId,body.contentHash,body.mode,body.exportLayout,body.workflowVersion,body.promptVersion,JSON.stringify(policy),now+90000,now);
      return summary(owned({...request,params:{id:jobId}}));
    }));
  const params=object({id:uuid});
  app.get('/v2/report-runs/:id',{preHandler:authenticated,schema:{params}},async(request)=>summary(owned(request)));
  app.post('/v2/report-runs/:id/credential',{preHandler:authenticated,schema:{params,body:object({})},config:{rateLimit:{max:12,timeWindow:'1 minute'}}},async(request)=>transaction(db,()=>{
    transport(request);const run=owned(request);active(run);const modelKey=key();if(!modelKey)fail('model_unconfigured',503);
    const leaseUntil=Math.min(Date.now()+90000,run.expires_at);
    db.prepare('UPDATE report_runs SET lease_until=?,heartbeat_at=? WHERE job_id=?').run(leaseUntil,Date.now(),run.job_id);
    return {...summary({...run,lease_until:leaseUntil}),modelKey};
  }));
  app.post('/v2/report-runs/:id/heartbeat',{preHandler:authenticated,schema:{params,body:object({stage:version,calls:integer(0,100000),tokens:integer(0,100000000)})}},async(request)=>transaction(db,()=>{
    const run=owned(request);if(run.state!=='reserved')return {continue:false,reason:'generation_expired',leaseUntil:0};
    const policy=JSON.parse(run.policy_json),now=Date.now();
    if(run.lease_until<=now)return {continue:false,reason:'workflow_lease_expired',leaseUntil:run.lease_until};
    if(request.body.calls<run.calls||request.body.tokens<run.tokens)fail('workflow_counter_regression',409);
    if(request.body.calls>policy.maxCalls||request.body.tokens>policy.maxTokens){
      db.prepare("UPDATE generations SET state='cancelled' WHERE id=?").run(run.job_id);
      db.prepare("UPDATE report_runs SET outcome='failed' WHERE job_id=?").run(run.job_id);
      return {continue:false,reason:'workflow_budget_exceeded',leaseUntil:0};
    }
    const leaseUntil=Math.min(now+90000,run.expires_at);
    db.prepare('UPDATE report_runs SET lease_until=?,heartbeat_at=?,calls=?,tokens=? WHERE job_id=?').run(leaseUntil,now,request.body.calls,request.body.tokens,run.job_id);
    return {continue:true,leaseUntil};
  }));
  app.post('/v2/report-runs/:id/finish',{preHandler:authenticated,schema:{params,body:object({outcome:{enum:['completed','partial','failed','cancelled']},
    manifestDigest:hash,exportStatus:{enum:['verified']},studentFiles:integer(1,100),teacherFiles:{const:1}},['outcome'])}},async(request)=>transaction(db,()=>{
    const run=owned(request),body=request.body;
    if(run.finish_json){const original=JSON.parse(run.finish_json);if(original.outcome!==body.outcome||original.manifestDigest!==body.manifestDigest)fail('idempotency_conflict',409);
      return {charged:run.state==='completed',outcome:run.outcome,user:publicUser(db,request.account)};}
    if(run.state==='completed')fail('idempotency_conflict',409);
    if(body.outcome==='completed'){
      if(!deliveryEnabled)fail('workflow_delivery_not_enabled',409);
      active(run);if(!body.manifestDigest||body.exportStatus!=='verified'||!body.studentFiles||body.teacherFiles!==1)fail('workflow_export_not_verified',409);
      if(db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>=1').run(request.account.id).changes!==1)fail('credits_exhausted',409);
      const user=db.prepare('SELECT * FROM users WHERE id=?').get(request.account.id);
      db.prepare("INSERT INTO credit_ledger VALUES(?,?,?,?,'generation',?,?,?,?)").run(randomUUID(),user.id,-1,user.credits,user.id,run.job_id,'双模式报告交付',Date.now());
      db.prepare("UPDATE generations SET state='completed',completed_at=? WHERE id=?").run(Date.now(),run.job_id);
    }else if(run.state==='reserved')db.prepare("UPDATE generations SET state='cancelled' WHERE id=?").run(run.job_id);
    db.prepare('UPDATE report_runs SET outcome=?,manifest_digest=?,finish_json=?,lease_until=0 WHERE job_id=?').run(body.outcome,body.manifestDigest??null,JSON.stringify(body),run.job_id);
    return {charged:body.outcome==='completed',outcome:body.outcome,user:publicUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(request.account.id))};
  }));
}
