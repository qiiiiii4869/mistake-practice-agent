// Offline-only boundary harness: no HTTP, credentials, model or account database.
#![allow(dead_code)]
#[path="../../../../app/apps/desktop/src-tauri/src/model.rs"]mod model;
#[path="../../../../app/apps/desktop/src-tauri/src/workflow_model.rs"]mod workflow_model;
use serde_json::{Value,json};
use std::io::Read;
fn main(){
 let mut input=String::new();std::io::stdin().read_to_string(&mut input).unwrap();
 let result=(||{
  let value:Value=serde_json::from_str(&input).map_err(|_|"invalid_input".to_string())?;
  let parse=|v:&Value|->Result<Vec<String>,String>{v.as_array().ok_or("invalid_input".into()).and_then(|a|a.iter().map(|v|v.as_str().map(str::to_owned).ok_or("invalid_input".into())).collect())};
  let selected=parse(&value["selected"])?;let available=parse(&value["available"])?;
  workflow_model::validate_question_scope(&selected,&available)?;
  workflow_model::validate_authorization(&value["request"],value["pages"].as_u64().ok_or("invalid_input")? as usize,selected.len(),value["students"].as_u64().ok_or("invalid_input")? as usize)?;
  Ok::<_,String>(json!({"accepted":true,"questionCount":selected.len()}))
 })();
 println!("{}",match result{Ok(value)=>json!({"value":value}),Err(error)=>json!({"error":error})});
}
