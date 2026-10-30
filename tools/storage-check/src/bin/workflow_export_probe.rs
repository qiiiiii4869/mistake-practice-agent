// Development-only native PDF export harness using an isolated test database.
#![allow(dead_code)]
#[path="../../../../app/apps/desktop/src-tauri/src/storage.rs"]mod storage;
#[path="../../../../app/apps/desktop/src-tauri/src/practice.rs"]mod practice;
#[path="../../../../app/apps/desktop/src-tauri/src/workflow_storage.rs"]mod workflow_storage;
#[path="../../../../app/apps/desktop/src-tauri/src/workflow_export_process.rs"]mod workflow_export_process;
use std::{io::BufRead,path::PathBuf,sync::{Arc,atomic::{AtomicBool,Ordering}},time::{Duration,SystemTime,UNIX_EPOCH}};
use serde_json::{Value,json};
fn main(){
 let mut line=String::new();std::io::stdin().lock().read_line(&mut line).unwrap();let config:Value=serde_json::from_str(&line).unwrap();
 let owner=config["request"]["ownerId"].as_str().unwrap();let run_id=config["request"]["runId"].as_str().unwrap();let database=PathBuf::from(config["database"].as_str().unwrap());
 let cancel=Arc::new(AtomicBool::new(false));if let Some(delay)=config["cancelAfterMs"].as_u64(){let c=cancel.clone();std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(delay));c.store(true,Ordering::SeqCst);});}
 let result=workflow_export_process::run(&PathBuf::from(config["runtime"].as_str().unwrap()),config["request"].clone(),&cancel,|args|{
  workflow_export_process::validate_rpc(args,owner,run_id)?;
  let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()as i64;
  workflow_storage::dispatch(&database,owner,args["operation"].as_str().unwrap(),&args["payload"],now)
 },|_|{});
 println!("{}",match result{Ok(value)=>json!({"value":value}),Err(error)=>json!({"error":error})});
}
