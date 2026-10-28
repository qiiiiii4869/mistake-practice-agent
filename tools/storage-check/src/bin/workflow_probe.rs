// Developer-only, line-based transport for a bounded real-original workflow test.
// Credentials enter through stdin/HTTPS and are never written or printed.
#[path="../../../../app/apps/desktop/src-tauri/src/model.rs"]mod model;
#[path="../../../../app/apps/desktop/src-tauri/src/model_http.rs"]mod model_http;
#[path="../../../../app/apps/desktop/src-tauri/src/workflow_model.rs"]mod workflow_model;
use serde_json::{json,Value};
use std::io::{BufRead,Write};
use zeroize::Zeroizing;
async fn cloud(client:&reqwest::Client,path:&str,token:&str,body:Value)->Result<Value,String>{
 let response=client.post(format!("https://codeqiqi.com/mistake-agent/{path}")).bearer_auth(token).json(&body).send().await.map_err(|_|"probe_cloud_network")?;
 let status=response.status();let value:Value=response.json().await.map_err(|_|"probe_cloud_response")?;
 if !status.is_success(){return Err(value["error"].as_str().unwrap_or("probe_cloud_failed").to_owned());}Ok(value)
}
fn emit(value:Value){println!("{value}");let _=std::io::stdout().flush();}
#[tokio::main(flavor="current_thread")]
async fn main(){if let Err(code)=run().await{emit(json!({"error":if code.bytes().all(|b|b.is_ascii_lowercase()||b==b'_'){code}else{"probe_failed".into()}}));std::process::exit(1);}}
async fn run()->Result<(),String>{
 let stdin=std::io::stdin();let mut lines=stdin.lock().lines();
 let input=Zeroizing::new(lines.next().ok_or("probe_input")?.map_err(|_|"probe_input")?);
 let mut init:Value=serde_json::from_str(&input).map_err(|_|"probe_input")?;
 let token=match init.get_mut("token"){Some(Value::String(s))=>Zeroizing::new(std::mem::take(s)),_=>return Err("probe_input".into())};
 let image=std::fs::read_to_string(init["imageFile"].as_str().ok_or("probe_input")?).map_err(|_|"probe_image")?;
 let number=init["number"].as_str().ok_or("probe_input")?.to_owned();
 let client=reqwest::Client::builder().no_proxy().https_only(true).redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never()).timeout(std::time::Duration::from_secs(90)).build().map_err(|_|"probe_http")?;
 let job=cloud(&client,"v2/report-runs",&token,init["request"].clone()).await?;
 let id=job["jobId"].as_str().ok_or("probe_cloud_response")?;
 let operation=async{
  let mut credential=cloud(&client,&format!("v2/report-runs/{id}/credential"),&token,json!({})).await?;
  let key=match credential.get_mut("modelKey"){Some(Value::String(s))=>Zeroizing::new(std::mem::take(s)),_=>return Err("probe_cloud_response".to_owned())};
  if credential["endpoint"]!=model::ENDPOINT||credential["model"]!=model::MODEL{return Err("probe_model_config".into());}
  emit(json!({"authorized":true}));let started=std::time::Instant::now();let mut calls=0;let mut tokens=0;let mut reported=0;
  for line in &mut lines{
   let message:Value=serde_json::from_str(&line.map_err(|_|"probe_input")?).map_err(|_|"probe_input")?;
   if message["end"]==true{break;}
   if calls>=20||started.elapsed().as_secs()>180||tokens>500000{return Err("workflow_budget_exceeded".into());}
   let request:model::Request=serde_json::from_value(message["request"].clone()).map_err(|_|"invalid_model_request")?;
   let use_image=request.stage=="recognize";
   let images=if use_image{vec![image.trim()]}else{vec![]};
   let payload=workflow_model::payload_images(&request,&[],&images,&[number.clone()])?;
   let reserve=payload["max_tokens"].as_u64().ok_or("probe_input")?+serde_json::to_vec(&request.data).map_err(|_|"probe_input")?.len() as u64+if use_image{32768}else{0};
   if tokens+reserve>500000{return Err("workflow_budget_exceeded".into());}
   calls+=1;tokens+=reserve;
   let pending=model_http::call(&key,&payload);tokio::pin!(pending);
   let mut heartbeat=tokio::time::interval(std::time::Duration::from_secs(20));
   let body=loop{tokio::select!{
    result=&mut pending=>break result,
    _=heartbeat.tick()=>{reported=reported.max(tokens);let status=cloud(&client,&format!("v2/report-runs/{id}/heartbeat"),&token,json!({"stage":request.stage,"calls":calls,"tokens":reported})).await?;if status["continue"]!=true{return Err("workflow_lease_expired".into());}},
   }};
   let result=match body{Ok(body)=>model::response(body,&[]),Err(e)=>Err(e)};
   match result{Ok((value,usage))=>{tokens=tokens.saturating_sub(reserve)+usage.total_tokens;emit(json!({"value":value,"usage":{"totalTokens":usage.total_tokens}}));},Err(error)=>{emit(json!({"error":error}));}}
  }
  drop(key);Ok::<_,String>(())
 }.await;
 let release=cloud(&client,&format!("v2/report-runs/{id}/finish"),&token,json!({"outcome":"partial"})).await;
 if release.is_err(){return Err("probe_release_failed".into());}operation?;emit(json!({"ended":true}));Ok(())
}
