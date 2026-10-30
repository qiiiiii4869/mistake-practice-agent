// Explicit developer diagnostic. Reads a temporary test session token from stdin,
// obtains model credentials over the normal HTTPS task API, never prints Key/token.
#[path="../../../../app/apps/desktop/src-tauri/src/model.rs"]mod model;
#[path="../../../../app/apps/desktop/src-tauri/src/model_http.rs"]mod model_http;
#[path="../../../../app/apps/desktop/src-tauri/src/workflow_model.rs"]mod workflow_model;
use serde_json::{json,Value};
use std::io::Read;
use zeroize::Zeroizing;

async fn cloud(client:&reqwest::Client,path:&str,token:&str,body:Value)->Result<Value,String>{
 let response=client.post(format!("https://codeqiqi.com/mistake-agent/{path}")).bearer_auth(token).json(&body).send().await.map_err(|_|"probe_cloud_network")?;
 let status=response.status();let value:Value=response.json().await.map_err(|_|"probe_cloud_response")?;
 if !status.is_success(){return Err(value["error"].as_str().unwrap_or("probe_cloud_failed").to_owned());}Ok(value)
}
#[tokio::main(flavor="current_thread")]
async fn main(){if let Err(code)=run().await{eprintln!("{}",if code.bytes().all(|b|b.is_ascii_lowercase()||b==b'_'){code}else{"probe_failed".into()});std::process::exit(1);}}
async fn run()->Result<(),String>{
 let mut input=Zeroizing::new(String::new());std::io::stdin().read_to_string(&mut input).map_err(|_|"probe_input")?;
 let mut data:Value=serde_json::from_str(&input).map_err(|_|"probe_input")?;
 let token=match data.get_mut("token"){Some(Value::String(s))=>Zeroizing::new(std::mem::take(s)),_=>return Err("probe_input".into())};
 let image=std::fs::read_to_string(data["imageFile"].as_str().ok_or("probe_input")?).map_err(|_|"probe_image")?;
 let number=data["number"].as_str().ok_or("probe_input")?.to_owned();
 let client=reqwest::Client::builder().no_proxy().https_only(true).redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never()).timeout(std::time::Duration::from_secs(180)).build().map_err(|_|"probe_http")?;
 let job=cloud(&client,"v2/report-runs",&token,json!({"requestKey":data["requestKey"],"contentHash":data["contentHash"],"mode":"dictation","exportLayout":"individual",
   "workflowVersion":"report-workflow-v1","promptVersion":"report-prompts-v3","counts":{"pages":1,"units":1,"students":1},
   "requestedBudget":{"maxCalls":3,"maxTokens":250000,"maxRunSeconds":180}})).await?;
 let id=job["jobId"].as_str().ok_or("probe_cloud_response")?;
 let operation=async{
   let mut credential=cloud(&client,&format!("v2/report-runs/{id}/credential"),&token,json!({})).await?;
   let key=match credential.get_mut("modelKey"){Some(Value::String(s))=>Zeroizing::new(std::mem::take(s)),_=>return Err("probe_cloud_response".to_owned())};
   if credential["endpoint"]!=model::ENDPOINT||credential["model"]!=model::MODEL{return Err("probe_model_config".into());}
   let mut readings=vec![];
   for attempt in 1..=3{
     let request=model::Request{stage:"recognize".into(),instruction:"".into(),data:if attempt==3{json!({"pageId":"local-probe","focusNumbers":[number]})}else{json!({"pageId":"local-probe"})}};
     let payload=workflow_model::payload(&request,&[],Some(image.trim()),&[number.clone()])?;
     let body=model_http::call(&key,&payload).await?;let(value,usage)=model::response(body,&[])?;
     readings.push(json!({"attempt":attempt,"value":value,"usage":usage.total_tokens}));
   }
   drop(key);Ok::<_,String>(json!({"number":number,"readings":readings}))
 }.await;
 let ended=cloud(&client,&format!("v2/report-runs/{id}/finish"),&token,json!({"outcome":"partial"})).await;
 if ended.is_err(){return Err("probe_release_failed".into());}
 let result=operation?;std::fs::write(data["outputFile"].as_str().ok_or("probe_input")?,serde_json::to_vec_pretty(&result).map_err(|_|"probe_output")?).map_err(|_|"probe_output")?;
 println!("probe_completed_three_reads_key_dropped_task_released");Ok(())
}
