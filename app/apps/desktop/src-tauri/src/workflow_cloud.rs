use serde::Deserialize;
use serde_json::{json,Value};
use std::{collections::HashMap,path::PathBuf,sync::{Mutex,atomic::{AtomicBool,AtomicU64,Ordering}},time::{SystemTime,UNIX_EPOCH}};
use tauri::{Manager,WebviewWindow};
use tokio::sync::watch;
use zeroize::{Zeroize,Zeroizing};

fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
fn id(s:&str)->bool{s.len()==36&&s.bytes().all(|b|b.is_ascii_hexdigit()||b==b'-')}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Page{pub id:String,pub name:String,pub data:String}
struct ActiveRun{
    owner:PathBuf,job_id:String,key:Zeroizing<String>,lease_until:u64,expires_at:u64,deadline:u64,
    max_calls:u64,max_tokens:u64,calls:u64,tokens:u64,reported_tokens:u64,pages:HashMap<String,String>,numbers:Vec<String>,names:Vec<String>,cancel:watch::Sender<bool>,
}
#[derive(Default)]pub(crate) struct WorkflowCloudState{active:Mutex<Option<ActiveRun>>,busy:AtomicBool,epoch:AtomicU64}
pub(crate) fn clear(state:&WorkflowCloudState){state.epoch.fetch_add(1,Ordering::SeqCst);if let Ok(mut active)=state.active.lock(){if let Some(run)=active.take(){let _=run.cancel.send(true);}}}
fn clear_job(state:&WorkflowCloudState,job_id:&str){if let Ok(mut active)=state.active.lock(){if active.as_ref().is_some_and(|r|r.job_id==job_id){if let Some(run)=active.take(){let _=run.cancel.send(true);}}}}
fn public_model(value:&Value)->Result<Value,String>{
    let configured=value["configured"].as_bool().ok_or("account_invalid_response")?;
    let version=value["modelConfigVersion"].as_str().filter(|v|v.len()==16&&v.bytes().all(|b|b.is_ascii_hexdigit()));
    if value["model"]!=super::model::MODEL||(configured&&version.is_none()){return Err("account_invalid_response".into());}
    Ok(json!({"configured":configured,"model":super::model::MODEL,"modelConfigVersion":version,"deliveryEnabled":value["deliveryEnabled"].as_bool().unwrap_or(false)}))
}
struct Guard<'a>(&'a AtomicBool);impl Drop for Guard<'_>{fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}
fn lock(state:&WorkflowCloudState)->Result<Guard<'_>,String>{if state.busy.swap(true,Ordering::SeqCst){Err("workflow_busy".into())}else{Ok(Guard(&state.busy))}}

#[tauri::command]pub(crate) async fn workflow_model_status(window:WebviewWindow,app:tauri::AppHandle)->Result<Value,String>{
    super::require_main(&window)?;public_model(&super::account::workflow_request(&app,"/v2/model-status",None).await?)
}
#[tauri::command]pub(crate) async fn workflow_pending(window:WebviewWindow,app:tauri::AppHandle)->Result<Value,String>{
    super::require_main(&window)?;let value=super::account::workflow_request(&app,"/v2/active-report-run",None).await?;
    if value["jobId"].is_null(){return Ok(json!({"jobId":null}));}
    let job_id=value["jobId"].as_str().filter(|s|id(s)).ok_or("account_invalid_response")?;Ok(json!({"jobId":job_id}))
}
#[tauri::command]pub(crate) async fn workflow_configure_cloud_model(window:WebviewWindow,app:tauri::AppHandle,mut model_key:String)->Result<Value,String>{
    super::require_main(&window)?;
    let mut body=json!({"modelKey":model_key});model_key.zeroize();
    let result=super::account::workflow_request(&app,"/v2/admin/model-config",Some(body.clone())).await;
    if let Some(Value::String(s))=body.get_mut("modelKey"){s.zeroize();}public_model(&result?)
}
#[tauri::command]pub(crate) async fn workflow_begin(window:WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,WorkflowCloudState>,
    expected_revision:i64,request:Value,pages:Vec<Page>,question_numbers:Vec<String>)->Result<Value,String>{
    super::require_main(&window)?;let _guard=lock(&state)?;
    let epoch=state.epoch.load(Ordering::SeqCst);
    if state.active.lock().map_err(|_|"state_unavailable")?.is_some(){return Err("workflow_busy".into());}
    let owner=super::account::user_folder(&app)?;
    let stored=serde_json::to_value(super::storage::load(&super::storage::open(&super::database_path(&app)?)?)?).map_err(|_|"storage_failed")?;
    if stored["revision"]!=expected_revision{return Err("storage_conflict".into());}
    let names=super::storage::model_names(&super::storage::open(&super::database_path(&app)?)?)?;
    let numbers:Vec<String>=stored["snapshot"]["students"].as_array().ok_or("model_no_workspace")?.iter()
      .filter_map(|s|s["questions"].as_array()).flatten().filter_map(|q|q["number"].as_str().map(str::to_owned)).collect();
    let numbers:Vec<String>={let mut n=numbers;n.sort();n.dedup();n};
    if question_numbers.is_empty()||question_numbers.len()>6||question_numbers.iter().any(|n|!numbers.contains(n)){
      return Err("invalid_input".into());}
    let numbers=question_numbers;
    super::workflow_model::validate_authorization(&request,pages.len(),numbers.len(),stored["snapshot"]["students"].as_array().ok_or("model_no_workspace")?.len())?;
    if pages.is_empty()||pages.len()>30||pages.iter().map(|p|p.data.len()).sum::<usize>()>8*1024*1024{return Err("invalid_model_request".into());}
    let mut images=HashMap::new();for p in pages{if p.id.len()>80||p.name.len()>300||images.contains_key(&p.id){return Err("invalid_model_request".into());}
        super::model::vision_payload(&p.data,&numbers)?;images.insert(p.id,p.data);}
    let job=super::account::workflow_request(&app,"/v2/report-runs",Some(request.clone())).await?;
    let job_id=job["jobId"].as_str().filter(|s|id(s)).ok_or("account_invalid_response")?.to_owned();
    let credential=super::account::workflow_request(&app,&format!("/v2/report-runs/{job_id}/credential"),Some(json!({}))).await;
    let mut credential=match credential{Ok(v)=>v,Err(e)=>{let _=super::account::workflow_request(&app,&format!("/v2/report-runs/{job_id}/finish"),Some(json!({"outcome":"failed"}))).await;return Err(e);}};
    let key=match credential.get_mut("modelKey"){Some(Value::String(value))=>Zeroizing::new(std::mem::take(value)),_=>return Err("account_invalid_response".into())};
    if credential["jobId"]!=job_id||credential["contentHash"]!=request["contentHash"]||credential["model"]!=super::model::MODEL
      ||credential["endpoint"]!=super::model::ENDPOINT||credential["state"]!="reserved"||!(16..=256).contains(&key.len()){
        return Err("account_invalid_response".into());}
    let num=|path:&str|credential.pointer(path).and_then(Value::as_u64).ok_or("account_invalid_response".to_owned());
    let lease_until=num("/leaseUntil")?;let expires_at=num("/expiresAt")?;let max_calls=num("/limits/maxCalls")?;let max_tokens=num("/limits/maxTokens")?;let seconds=num("/limits/maxRunSeconds")?;
    if lease_until<=now()||max_calls>200||max_tokens>2000000||seconds>2700{return Err("account_invalid_response".into());}
    if super::account::user_folder(&app)?!=owner{return Err("session_required".into());}
    if state.epoch.load(Ordering::SeqCst)!=epoch{
      let _=super::account::workflow_request(&app,&format!("/v2/report-runs/{job_id}/finish"),Some(json!({"outcome":"cancelled"}))).await;
      return Err("workflow_cancelled".into());
    }
    let(cancel,_)=watch::channel(false);
    let binding=ActiveRun{owner,job_id:job_id.clone(),key,
      lease_until,expires_at,deadline:now()+seconds*1000,max_calls,max_tokens,calls:0,tokens:0,reported_tokens:0,pages:images,numbers,names,cancel};
    let bound={let mut active=state.active.lock().map_err(|_|"state_unavailable")?;
      if state.epoch.load(Ordering::SeqCst)==epoch{*active=Some(binding);true}else{false}};
    if !bound{let _=super::account::workflow_request(&app,&format!("/v2/report-runs/{job_id}/finish"),Some(json!({"outcome":"cancelled"}))).await;return Err("workflow_cancelled".into());}
    let handle=app.clone();let watched_id=job["jobId"].as_str().unwrap().to_owned();
    tauri::async_runtime::spawn(async move{loop{
      tokio::time::sleep(std::time::Duration::from_secs(2)).await;
      let state=handle.state::<WorkflowCloudState>();
      let status=state.active.lock().ok().and_then(|a|a.as_ref().filter(|r|r.job_id==watched_id).map(|r|r.lease_until>now()&&r.deadline>now()&&r.expires_at>now()));
      match status{None=>break,Some(false)=>{clear_job(&state,&watched_id);break;},Some(true)=>{}}
      if super::account::user_folder(&handle).is_err(){clear_job(&state,&watched_id);break;}
    }});
    // Never return the credential DTO to JavaScript.
    Ok(json!({"jobId":job["jobId"].as_str(),"state":"reserved","mode":request["mode"].as_str(),"leaseUntil":lease_until,"expiresAt":expires_at}))
}

#[tauri::command]pub(crate) async fn workflow_heartbeat(window:WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,WorkflowCloudState>,job_id:String,stage:String)->Result<Value,String>{
    super::require_main(&window)?;
    let(calls,tokens)={let mut active=state.active.lock().map_err(|_|"state_unavailable")?;let r=active.as_mut().filter(|r|r.job_id==job_id).ok_or("generation_not_found")?;r.reported_tokens=r.reported_tokens.max(r.tokens);(r.calls,r.reported_tokens)};
    let result=super::account::workflow_request(&app,&format!("/v2/report-runs/{job_id}/heartbeat"),Some(json!({"stage":stage,"calls":calls,"tokens":tokens}))).await;
    match result{Ok(value)=>{
      if value["continue"]!=true{clear_job(&state,&job_id);return Err(value["reason"].as_str().unwrap_or("generation_expired").to_owned());}
      if let Some(r)=state.active.lock().map_err(|_|"state_unavailable")?.as_mut().filter(|r|r.job_id==job_id){r.lease_until=value["leaseUntil"].as_u64().ok_or("account_invalid_response")?;}
      Ok(json!({"continue":true,"leaseUntil":value["leaseUntil"].as_u64()}))
    },Err(e)=>{if e!="account_network_failed"{clear_job(&state,&job_id);}Err(e)}}
}

#[tauri::command]pub(crate) async fn workflow_call_model(window:WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,WorkflowCloudState>,job_id:String,request:super::model::Request)->Result<Value,String>{
    super::require_main(&window)?;
    let model=app.state::<super::DeepseekState>();if model.running.swap(true,Ordering::SeqCst){return Err("model_busy".into());}
    let _guard=Guard(&model.running);let owner=super::account::user_folder(&app)?;
    let(key,payload,names,reserved,mut cancellation)={
      let mut active=state.active.lock().map_err(|_|"state_unavailable")?;
      let r=active.as_mut().filter(|r|r.job_id==job_id&&r.owner==owner).ok_or("generation_not_found")?;
      if r.lease_until<=now()||r.expires_at<=now()||r.deadline<=now(){drop(active);clear_job(&state,&job_id);return Err("workflow_lease_expired".into());}
      let mut images=vec![];
      if request.stage=="recognize"{images.push(r.pages.get(request.data["pageId"].as_str().ok_or("invalid_model_request")?).ok_or("paper_page_not_saved")?.as_str());}
      let payload=super::workflow_model::payload_images(&request,&r.names,&images,&r.numbers)?;
      let reserved=images.len() as u64*32768+serde_json::to_vec(&request.data).map_err(|_|"invalid_model_request")?.len() as u64
        +payload["max_tokens"].as_u64().ok_or("invalid_model_request")?;
      if r.calls>=r.max_calls||r.tokens.saturating_add(reserved)>r.max_tokens{drop(active);clear_job(&state,&job_id);return Err("workflow_budget_exceeded".into());}
      r.calls+=1;r.tokens+=reserved;
      (Zeroizing::new(r.key.to_string()),payload,r.names.clone(),reserved,r.cancel.subscribe())
    };
    let future=super::model_http::call(&key,&payload);tokio::pin!(future);
    let mut interval=tokio::time::interval(std::time::Duration::from_secs(2));
    let body=loop{tokio::select!{
      result=&mut future=>break result,
      _=cancellation.changed()=>break Err("workflow_cancelled".into()),
      _=interval.tick()=>{
        let valid=state.active.lock().map_err(|_|"state_unavailable")?.as_ref().is_some_and(|r|r.job_id==job_id&&r.lease_until>now()&&r.deadline>now()&&r.expires_at>now());
        if !valid{clear_job(&state,&job_id);break Err("workflow_lease_expired".into());}
        if super::account::user_folder(&app).ok().as_ref()!=Some(&owner){clear_job(&state,&job_id);break Err("session_required".into());}
      }
    }};
    let body=match body{Ok(v)=>v,Err(e)=>{if ["model_auth_failed","model_quota_exhausted"].contains(&e.as_str()){clear_job(&state,&job_id);}return Err(e);}};
    let usage=body.pointer("/usage/total_tokens").and_then(Value::as_u64);
    if let Some(r)=state.active.lock().map_err(|_|"state_unavailable")?.as_mut().filter(|r|r.job_id==job_id){if let Some(tokens)=usage{r.tokens=r.tokens.saturating_sub(reserved).saturating_add(tokens);}}
    let(value,usage_details)=super::model::response(body,&names)?;
    let mut total=model.usage.lock().map_err(|_|"state_unavailable")?;
    total.prompt_tokens=total.prompt_tokens.saturating_add(usage_details.prompt_tokens);total.completion_tokens=total.completion_tokens.saturating_add(usage_details.completion_tokens);total.total_tokens=total.total_tokens.saturating_add(usage_details.total_tokens);
    Ok(json!({"value":value,"usage":usage.map(|total|json!({"totalTokens":total}))}))
}

#[tauri::command]pub(crate) async fn workflow_end(window:WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,WorkflowCloudState>,job_id:String,outcome:String)->Result<Value,String>{
    if window.label()!="main"{return Err("local_window_required".into());}
    if !id(&job_id)||!["partial","failed","cancelled"].contains(&outcome.as_str()){return Err("invalid_input".into());}
    // Drop and zeroize the session key BEFORE awaiting the server or a failing network.
    clear_job(&state,&job_id);
    super::require_main(&window)?;
    let result=super::account::workflow_request(&app,&format!("/v2/report-runs/{job_id}/finish"),Some(json!({"outcome":outcome}))).await?;
    Ok(json!({"charged":result["charged"].as_bool().unwrap_or(false)}))
}
#[tauri::command]pub(crate) fn workflow_abort(window:WebviewWindow,state:tauri::State<'_,WorkflowCloudState>,job_id:String)->Result<(),String>{
    if window.label()!="main"{return Err("local_window_required".into());}
    let matches=state.active.lock().map_err(|_|"state_unavailable")?.as_ref().is_some_and(|r|r.job_id==job_id);
    if matches{clear_job(&state,&job_id);}Ok(())
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn clearing_removes_key_container_and_signals_inflight_requests(){
        let state=WorkflowCloudState::default();let(cancel,mut receiver)=watch::channel(false);
        *state.active.lock().unwrap()=Some(ActiveRun{owner:PathBuf::from("synthetic-account"),job_id:"synthetic-run".into(),
          key:Zeroizing::new("sk-synthetic-test-key".into()),lease_until:1,expires_at:1,deadline:1,max_calls:1,max_tokens:4096,
          calls:0,tokens:0,reported_tokens:0,pages:HashMap::new(),numbers:vec![],names:vec![],cancel});
        clear_job(&state,"another-run");assert!(state.active.lock().unwrap().is_some());
        clear(&state);assert!(state.active.lock().unwrap().is_none());assert!(*receiver.borrow_and_update());
        clear(&state);assert!(state.active.lock().unwrap().is_none());
    }
    #[test]fn public_model_dto_cannot_return_a_secret(){let value=json!({"configured":true,"model":"deepseek-flash","modelConfigVersion":"0123456789abcdef","modelKey":"sk-test-server-secret","deliveryEnabled":false});
      let public=public_model(&value).unwrap();assert!(public.get("modelKey").is_none());assert!(!public.to_string().contains("sk-test-server-secret"));}
}
