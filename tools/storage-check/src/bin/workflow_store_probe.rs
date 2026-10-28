// Developer-only local SQLite transport. No cloud or model credentials.
#![allow(dead_code)]
#[path="../../../../app/apps/desktop/src-tauri/src/storage.rs"]mod storage;
#[path="../../../../app/apps/desktop/src-tauri/src/practice.rs"]mod practice;
#[path="../../../../app/apps/desktop/src-tauri/src/workflow_storage.rs"]mod workflow_storage;
use std::{io::{BufRead,Write},path::PathBuf,time::{SystemTime,UNIX_EPOCH}};
use serde_json::{Value,json};
fn main(){
 let path=PathBuf::from(std::env::args().nth(1).expect("database path required"));
 for line in std::io::stdin().lock().lines(){let result=(||{
  let v:Value=serde_json::from_str(&line.map_err(|_|"workflow_probe_input")?).map_err(|_|"workflow_probe_input")?;
  let owner=v["ownerId"].as_str().ok_or("workflow_probe_input")?;let operation=v["operation"].as_str().ok_or("workflow_probe_input")?;
  let now=v["now"].as_i64().unwrap_or_else(||SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()as i64);
  workflow_storage::dispatch(&path,owner,operation,&v["payload"],now)
 })();
 match result{Ok(value)=>println!("{}",json!({"value":value})),Err(error)=>println!("{}",json!({"error":error}))};let _=std::io::stdout().flush();
 }
}
