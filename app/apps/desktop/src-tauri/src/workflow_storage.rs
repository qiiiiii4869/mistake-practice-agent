// Authoritative account-scoped SQLite checkpoints, also compiled by the offline
// test transport. One transaction writes the call result and its usage ledger.
use rusqlite::{Connection,OptionalExtension,params};
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use std::{path::Path,collections::HashSet,time::Duration};
type Result<T>=std::result::Result<T,String>;
const SCHEMA:&str=include_str!("../../../../packages/agent/src/workflow/schema.sql");
const APP_ID:i64=0x4d535457;
fn bad()->String{"workflow_storage_invalid".into()}
fn db_error(_:rusqlite::Error)->String{"workflow_storage_failed".into()}
pub(crate) fn checksum(data:&str)->String{format!("{:x}",Sha256::digest(data.as_bytes()))}
fn string<'a>(v:&'a Value,k:&str)->Result<&'a str>{v[k].as_str().ok_or_else(bad)}
fn num(v:&Value,k:&str)->Result<i64>{v[k].as_i64().filter(|n|*n>=0).ok_or_else(bad)}
fn hash(s:&str)->bool{s.len()==64&&s.bytes().all(|c|c.is_ascii_hexdigit())}
fn id(s:&str)->bool{!s.is_empty()&&s.len()<=100&&s.bytes().all(|c|c.is_ascii_alphanumeric()||b"_-".contains(&c))}
fn secret(v:&Value)->bool{match v{
 Value::Object(o)=>o.iter().any(|(k,v)|{let k:String=k.chars().filter(|c|c.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect();
  ["modelkey","apikey","authorization","password","passwordplain","passwordhash","cookie","cookies","token","headers","credential","credentials","secret"].contains(&k.as_str())||secret(v)}),
 Value::Array(a)=>a.iter().any(secret),_=>false}}
fn encode(v:&Value)->Result<String>{if secret(v){return Err("workflow_secret_blocked".into());}let s=serde_json::to_string(v).map_err(|_|bad())?;if s.len()>24*1024*1024{return Err(bad());}Ok(s)}
fn decode(s:String,h:String)->Result<Value>{if checksum(&s)!=h{return Err("workflow_storage_corrupt".into());}let v=serde_json::from_str(&s).map_err(|_|"workflow_storage_corrupt")?;if secret(&v){return Err("workflow_secret_blocked".into());}Ok(v)}
pub(crate) fn open(path:&Path)->Result<Connection>{
 if let Some(parent)=path.parent(){std::fs::create_dir_all(parent).map_err(|_|"workflow_storage_failed")?;}
 let conn=Connection::open(path).map_err(db_error)?;conn.busy_timeout(Duration::from_secs(3)).map_err(db_error)?;
 let app:i64=conn.pragma_query_value(None,"application_id",|r|r.get(0)).map_err(db_error)?;
 let version:i64=conn.pragma_query_value(None,"user_version",|r|r.get(0)).map_err(db_error)?;
 let tables:i64=conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",[],|r|r.get(0)).map_err(db_error)?;
 if (app!=0&&app!=APP_ID)||(app==0&&tables>0)||version>1{return Err("workflow_database_unknown".into());}
 conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;").map_err(db_error)?;
 conn.execute_batch(&format!("BEGIN IMMEDIATE; {SCHEMA} PRAGMA application_id={APP_ID}; PRAGMA user_version=1; COMMIT;")).map_err(db_error)?;Ok(conn)
}
fn task(conn:&Connection,owner:&str,run_id:&str)->Result<Value>{
 let row=conn.query_row("SELECT r.content_hash,r.run_json,r.checksum,r.revision,r.context_json,r.created_at,r.updated_at,i.input_json,i.checksum FROM workflow_runs r JOIN frozen_inputs i ON i.owner_id=r.owner_id AND i.content_hash=r.content_hash WHERE r.owner_id=? AND r.run_id=?",params![owner,run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,String>(7)?,r.get::<_,String>(8)?))).optional().map_err(db_error)?;
 let Some((content_hash,run,check,revision,context,created,updated,input,ih))=row else{return Ok(Value::Null);};
 let input=decode(input,ih)?;if input["ownerId"]!=owner||input["contentHash"]!=content_hash{return Err("workflow_storage_corrupt".into());}
 let run=match(run,check){(Some(v),Some(h))=>decode(v,h)?,(None,None)=>Value::Null,_=>return Err("workflow_storage_corrupt".into())};
 if let Some(calls)=run["calls"].as_array(){for (index,c) in calls.iter().enumerate(){
  let row:Option<(String,String,String,i64,Option<String>,Option<String>)>=conn.query_row("SELECT request_hash,stage,status,ordinal,response_json,checksum FROM model_calls WHERE owner_id=? AND run_id=? AND call_id=?",params![owner,run_id,string(c,"callId")?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(db_error)?;
  let Some((request,stage,status,ordinal,value,checksum))=row else{return Err("workflow_storage_corrupt".into());};
  if c["requestHash"]!=request||c["stage"]!=stage||c["status"]!=status||ordinal!=index as i64{return Err("workflow_storage_corrupt".into());}
  if c["status"]=="completed"&&c.get("errorCode").is_none(){match(value,checksum){(Some(v),Some(h))=>{decode(v,h)?;},_=>return Err("workflow_result_missing".into())}}
 }}
 Ok(json!({"input":input,"run":run,"revision":revision,"context":serde_json::from_str::<Value>(&context).map_err(|_|bad())?,"createdAt":created,"updatedAt":updated}))
}
pub(crate) fn load_task(path:&Path,owner:&str,run_id:&str)->Result<Value>{task(&open(path)?,owner,run_id)}
fn lease(conn:&Connection,owner:&str,run_id:&str,lease_id:&str,now:i64)->Result<()>{
 let active:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM workflow_leases WHERE owner_id=? AND run_id=? AND lease_id=? AND expires_at>?)",params![owner,run_id,lease_id,now],|r|r.get(0)).map_err(db_error)?;
 if !active{return Err("workflow_lease_lost".into());}Ok(())
}
fn validate_run(run:&Value,input:&Value,run_id:&str)->Result<()>{
 if run["runId"]!=run_id||run["contentHash"]!=input["contentHash"]||run["mode"]!=input["mode"]||run["workflowVersion"]!=input["workflowVersion"]||run["promptVersion"]!=input["promptVersion"]
  ||!matches!(run["executionMode"].as_str(),Some("real"|"mock"))||!run["state"].as_str().is_some_and(|s|["idle","preflight","authorizing","rendering","recognizing","aligning","extracting","retrieving","verifyingFacts","merging","selectingTargets","clozing","validatingCloze","generatingExercises","solving","validatingExercise","assembling","aggregatingEvidence","writingGuidance","validatingGuidance","contentReady","partial","failed","cancelled","recoverable"].contains(&s)){return Err(bad());}
 let calls=run["calls"].as_array().filter(|a|a.len()<=200).ok_or_else(bad)?;let mut ids=HashSet::new();
 if num(&run["policy"],"maxCalls")?>200||num(&run["policy"],"maxTokens")?>2_000_000||num(&run["policy"],"maxRunMs")?>2_700_000{return Err(bad());}
 for c in calls{let cid=string(c,"callId")?;if !id(cid)||!ids.insert(cid)||!hash(string(c,"requestHash")?)||!matches!(c["status"].as_str(),Some("pending"|"completed"|"unknown"))
   ||!matches!(c["stage"].as_str(),Some("recognize"|"extract"|"verifyFact"|"cloze"|"blindFill"|"exercise"|"solve"|"guidance"))||!matches!(num(c,"attempt")?,1|2)
   ||num(c,"reservedTokens")?>2_000_000||(!c["usage"].is_null()&&c["usage"].as_u64().is_none()){return Err(bad());}}
 for c in calls{if c.get("errorCode").is_some_and(|v|!v.as_str().is_some_and(|s|s.len()<=80&&s.bytes().all(|b|b.is_ascii_lowercase()||b==b'_'))){return Err(bad());}}
 Ok(())
}
pub(crate) fn dispatch(path:&Path,owner:&str,operation:&str,p:&Value,now:i64)->Result<Value>{
 if !id(owner)||secret(p){return Err(if secret(p){"workflow_secret_blocked".into()}else{bad()});}
 let mut conn=open(path)?;
 if operation=="list"{
  let mut query=conn.prepare("SELECT run_id FROM workflow_runs WHERE owner_id=? ORDER BY updated_at DESC,run_id LIMIT 100").map_err(db_error)?;
  let ids=query.query_map([owner],|r|r.get::<_,String>(0)).map_err(db_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(db_error)?;
  let mut rows=Vec::new();for run_id in ids{let t=task(&conn,owner,&run_id)?;let r=&t["run"];rows.push(json!({"runId":run_id,"contentHash":t["input"]["contentHash"],"mode":t["input"]["mode"],"examName":t["input"]["workspace"]["exam"]["name"],"state":r["state"],"updatedAt":t["updatedAt"],"callCount":r["calls"].as_array().map_or(0,Vec::len),"unknownCalls":r["calls"].as_array().map_or(0,|a|a.iter().filter(|c|c["status"]!="completed").count()),"workspaceRevision":t["context"]["workspaceRevision"]}));}return Ok(json!(rows));
 }
 if operation=="load_analysis"{let key=string(p,"cacheKey")?;if !hash(key){return Err(bad());}return conn.query_row("SELECT data_json,checksum FROM analysis_cache WHERE owner_id=? AND cache_key=?",params![owner,key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(db_error)?.map_or(Ok(Value::Null),|(v,h)|decode(v,h));}
 let run_id=string(p,"runId")?;if !id(run_id){return Err(bad());}
 if operation=="load"{return task(&conn,owner,run_id);}
 if operation=="load_response"{let cid=string(p,"callId")?;return conn.query_row("SELECT response_json,checksum FROM model_calls WHERE owner_id=? AND run_id=? AND call_id=? AND response_json IS NOT NULL",params![owner,run_id,cid],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(db_error)?.map_or(Ok(Value::Null),|(v,h)|decode(v,h));}
 if operation=="list_exports"{let mut q=conn.prepare("SELECT data_json,checksum,revision FROM export_profiles WHERE owner_id=? AND run_id=? ORDER BY export_id").map_err(db_error)?;
  let rows=q.query_map(params![owner,run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).map_err(db_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(db_error)?;
  return rows.into_iter().map(|(v,h,revision)|Ok(json!({"data":decode(v,h)?,"revision":revision}))).collect::<Result<Vec<_>>>().map(|a|json!(a));}
 let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(db_error)?;
 let result=match operation{
 "begin"=>{
  let input=&p["input"];if input["ownerId"]!=owner||input["schemaVersion"]!=1||!matches!(input["mode"].as_str(),Some("dictation"|"exercise")){return Err(bad());}
   let snapshot:crate::storage::Snapshot=serde_json::from_value(input["workspace"].clone()).map_err(|_|bad())?;snapshot.validate()?;
  let mut body=input.clone();body.as_object_mut().ok_or_else(bad)?.remove("contentHash");
  let canonical=string(p,"canonicalInput")?;if canonical.len()>24*1024*1024||serde_json::from_str::<Value>(canonical).map_err(|_|bad())?!=body||checksum(canonical)!=string(input,"contentHash")?{return Err("workflow_input_checksum".into());}
  let context=&p["context"];if !context.as_object().is_some_and(|o|o.keys().all(|k|k=="workspaceRevision")&&o.values().all(|v|v.as_u64().is_some())){return Err(bad());}
  let lease_id=string(p,"leaseId")?;if !id(lease_id){return Err(bad());}
  let occupied:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM workflow_leases WHERE owner_id=? AND lease_id!=? AND expires_at>?)",params![owner,lease_id,now],|r|r.get(0)).map_err(db_error)?;if occupied{return Err("workflow_busy".into());}
  let existing=task(&tx,owner,run_id)?;
  if !existing.is_null()&&(existing["input"]!=*input||existing["context"]!=*context){return Err("workflow_stale_run".into());}
  if !existing.is_null()&&num(p,"expectedRevision")?!=num(&existing,"revision")?{return Err("workflow_storage_conflict".into());}
  let serialized=encode(input)?;let ch=string(input,"contentHash")?;
  tx.execute("INSERT OR IGNORE INTO frozen_inputs VALUES(?,?,?,?)",params![owner,ch,serialized,checksum(&serialized)]).map_err(db_error)?;
  let context=encode(context)?;
  tx.execute("INSERT OR IGNORE INTO workflow_runs(owner_id,run_id,content_hash,mode,context_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",params![owner,run_id,ch,string(input,"mode")?,context,now,now]).map_err(db_error)?;
  tx.execute("INSERT INTO workflow_leases VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET run_id=excluded.run_id,lease_id=excluded.lease_id,expires_at=excluded.expires_at",params![owner,run_id,lease_id,now+30000]).map_err(db_error)?;
  json!({"revision":if existing.is_null(){0}else{num(&existing,"revision")?},"expiresAt":now+30000})
 },
 "renew"=>{lease(&tx,owner,run_id,string(p,"leaseId")?,now)?;tx.execute("UPDATE workflow_leases SET expires_at=? WHERE owner_id=? AND lease_id=?",params![now+30000,owner,string(p,"leaseId")?]).map_err(db_error)?;json!({"expiresAt":now+30000})},
 "end"=>{tx.execute("DELETE FROM workflow_leases WHERE owner_id=? AND run_id=? AND lease_id=?",params![owner,run_id,string(p,"leaseId")?]).map_err(db_error)?;Value::Null},
 "save"=>{
  lease(&tx,owner,run_id,string(p,"leaseId")?,now)?;let old=task(&tx,owner,run_id)?;let run=&p["run"];validate_run(run,&old["input"],run_id)?;
  if num(&old,"revision")?!=num(p,"expectedRevision")?{return Err("workflow_storage_conflict".into());}
  if !old["run"].is_null(){
   for key in ["mode","contentHash","executionMode","workflowVersion","promptVersion","modelConfiguration","policy","startedAt"]{if old["run"][key]!=run[key]{return Err("workflow_stale_run".into());}}
   let previous=old["run"]["calls"].as_array().ok_or_else(bad)?;let calls=run["calls"].as_array().ok_or_else(bad)?;if calls.len()<previous.len(){return Err(bad());}
   for (a,b) in previous.iter().zip(calls){let mut a=a.clone();let mut b=b.clone();
    if a["status"]=="pending"{for key in ["status","usage","finishedAt","errorCode"]{a.as_object_mut().unwrap().remove(key);b.as_object_mut().unwrap().remove(key);}}
    if a!=b{return Err("workflow_call_ledger_conflict".into());}}
  }
  let response=p.get("receipt").filter(|v|!v.is_null());
  for c in run["calls"].as_array().unwrap(){if c["status"]=="completed"&&c.get("errorCode").is_none()&&response.is_none_or(|r|r["callId"]!=c["callId"]){
   let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM model_calls WHERE owner_id=? AND run_id=? AND call_id=? AND response_json IS NOT NULL)",params![owner,run_id,string(c,"callId")?],|r|r.get(0)).map_err(db_error)?;
   if !exists{return Err("workflow_result_missing".into());}
  }}
  if let Some(receipt)=response{let cid=string(receipt,"callId")?;let call=run["calls"].as_array().unwrap().iter().find(|c|c["callId"]==cid).ok_or_else(bad)?;
   let r=receipt["response"].as_object().ok_or_else(bad)?;if !r.contains_key("value")||r.keys().any(|k|!["value","usage"].contains(&k.as_str())){return Err(bad());}
   if !receipt["response"]["usage"].is_null()&&!receipt["response"]["usage"].as_object().is_some_and(|u|u.len()==1&&u["totalTokens"].as_u64().is_some()){return Err(bad());}
   if call["status"]!="completed"||(!receipt["response"]["usage"].is_null()&&receipt["response"]["usage"]["totalTokens"]!=call["usage"]){return Err(bad());}
   let content=encode(&receipt["response"])?;if content.len()>160000{return Err(bad());}
   let prior:Option<String>=tx.query_row("SELECT checksum FROM model_calls WHERE owner_id=? AND run_id=? AND call_id=? AND response_json IS NOT NULL",params![owner,run_id,cid],|r|r.get(0)).optional().map_err(db_error)?;
   if prior.as_ref().is_some_and(|h|*h!=checksum(&content)){return Err("workflow_call_ledger_conflict".into());}
  }
  for (ordinal,c) in run["calls"].as_array().unwrap().iter().enumerate(){
   tx.execute("INSERT INTO model_calls(owner_id,run_id,call_id,ordinal,request_hash,stage,status) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,run_id,call_id) DO UPDATE SET status=excluded.status",params![owner,run_id,string(c,"callId")?,ordinal as i64,string(c,"requestHash")?,string(c,"stage")?,string(c,"status")?]).map_err(db_error)?;
  }
  if let Some(r)=response{let content=encode(&r["response"])?;tx.execute("UPDATE model_calls SET response_json=?,checksum=? WHERE owner_id=? AND run_id=? AND call_id=?",params![content,checksum(&content),owner,run_id,string(r,"callId")?]).map_err(db_error)?;}
  let serialized=encode(run)?;let revision=num(p,"expectedRevision")?+1;
  tx.execute("UPDATE workflow_runs SET run_json=?,checksum=?,revision=?,updated_at=? WHERE owner_id=? AND run_id=?",params![serialized,checksum(&serialized),revision,now,owner,run_id]).map_err(db_error)?;json!({"revision":revision})
 },
 "save_analysis"=>{lease(&tx,owner,run_id,string(p,"leaseId")?,now)?;let key=string(p,"cacheKey")?;if !hash(key){return Err(bad());}let content=encode(&p["value"])?;
  tx.execute("INSERT INTO analysis_cache VALUES(?,?,?,?) ON CONFLICT(owner_id,cache_key) DO UPDATE SET data_json=excluded.data_json,checksum=excluded.checksum",params![owner,key,content,checksum(&content)]).map_err(db_error)?;Value::Null},
 "save_export"=>{
  let task=task(&tx,owner,run_id)?;if task.is_null()||task["run"]["state"]!="contentReady"{return Err("workflow_export_content_incomplete".into());}
  let value=&p["value"];let profile=&value["profile"];let export_id=string(profile,"exportId")?;let profile_hash=string(profile,"exportHash")?;
  if !id(export_id)||!hash(profile_hash)||profile["runId"]!=run_id||!matches!(profile["layout"].as_str(),Some("individual"|"combined"))||!profile["includeAnswers"].is_boolean(){return Err(bad());}
  let state=string(value,"state")?;if !["planned","exporting","failed","cancelled","verified"].contains(&state){return Err(bad());}
  if state=="verified"{let m=&value["manifest"];let qa=&value["qa"];
   if m["exportStatus"]!="verified"||m["runId"]!=run_id||m["contentHash"]!=task["input"]["contentHash"]||m["mode"]!=task["input"]["mode"]||m["profileHash"]!=profile_hash||m["layout"]!=profile["layout"]||m["includeAnswers"]!=profile["includeAnswers"]||qa["passed"]!=true||qa["exportHash"]!=m["exportHash"]{return Err("workflow_export_unverified".into());}
   let outputs=m["outputs"].as_array().ok_or_else(bad)?;let students=task["input"]["workspace"]["students"].as_array().ok_or_else(bad)?.len();
   if outputs.len()!=if profile["layout"]=="individual"{students+1}else{2}||outputs.iter().filter(|o|o["role"]=="teacher").count()!=1{return Err("workflow_export_unverified".into());}
   let mut names=HashSet::new();for o in outputs{let name=string(o,"relativePath")?;if !name.ends_with(".pdf")||name.contains(['/', '\\'])||!names.insert(name)||!hash(string(o,"sha256")?)||num(o,"pages")?==0||num(o,"size")?==0{return Err(bad());}}
  }
  let prior:Option<(String,i64)>=tx.query_row("SELECT data_json,revision FROM export_profiles WHERE owner_id=? AND export_id=?",params![owner,export_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
  let rev=prior.as_ref().map_or(0,|p|p.1);if rev!=num(p,"expectedRevision")?{return Err("workflow_storage_conflict".into());}
  if let Some((s,_))=&prior{let old:Value=serde_json::from_str(s).map_err(|_|bad())?;if old["profile"]!=*profile||(old["state"]=="verified"&&old!=*value){return Err("workflow_export_conflict".into());}}
  let data=encode(value)?;tx.execute("INSERT INTO export_profiles VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,export_id) DO UPDATE SET data_json=excluded.data_json,checksum=excluded.checksum,revision=excluded.revision",params![owner,run_id,export_id,profile_hash,data,checksum(&data),rev+1]).map_err(db_error)?;json!({"revision":rev+1})
 },
 _=>return Err(bad())};tx.commit().map_err(db_error)?;Ok(result)
}
