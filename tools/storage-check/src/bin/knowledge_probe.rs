// Developer-only cached knowledge integration harness; no model or source PDF.
#![allow(dead_code)]
#[path="../../../../app/apps/desktop/src-tauri/src/storage.rs"]mod storage;
#[path="../../../../app/apps/desktop/src-tauri/src/practice.rs"]mod practice;
#[path="../../../../app/apps/desktop/src-tauri/src/knowledge.rs"]mod knowledge;
use serde_json::{Value,json};
use std::io::BufRead;
fn main(){
 let path=std::env::args().nth(1).expect("isolated test database required");
 let mut line=String::new();std::io::stdin().lock().read_line(&mut line).unwrap();
 let result=(||->Result<Value,String>{let v:Value=serde_json::from_str(&line).map_err(|_|"invalid_input")?;let mut conn=storage::open(std::path::Path::new(&path))?;knowledge::init(&conn)?;
  let out=match v["operation"].as_str().ok_or("invalid_input")?{
   "import"=>serde_json::to_value(knowledge::import(&mut conn,v["revision"].as_i64().ok_or("invalid_input")?,serde_json::from_value(v["document"].clone()).map_err(|_|"invalid_input")?)?),
   "list"=>serde_json::to_value(knowledge::list(&conn)?),
   "read"=>serde_json::to_value(knowledge::read_document(&conn,v["id"].as_str().ok_or("invalid_input")?)?),
   "processed"=>serde_json::to_value(knowledge::load_processed(&conn,v["id"].as_str().ok_or("invalid_input")?)?),
   "process"=>serde_json::to_value(knowledge::process_existing(&mut conn,v["revision"].as_i64().ok_or("invalid_input")?,v["id"].as_str().ok_or("invalid_input")?,serde_json::from_value(v["processed"].clone()).map_err(|_|"invalid_input")?)?),
   "search"=>serde_json::to_value(knowledge::search(&conn,v["query"].as_str().ok_or("invalid_input")?)?),
   "related"=>serde_json::to_value(knowledge::search_related(&conn,v["query"].as_str().ok_or("invalid_input")?)?),
   "remove"=>serde_json::to_value(knowledge::remove(&mut conn,v["revision"].as_i64().ok_or("invalid_input")?,v["id"].as_str().ok_or("invalid_input")?)?),
   _=>return Err("invalid_input".into())};out.map_err(|_|"invalid_input".into())
 })();println!("{}",match result{Ok(v)=>json!({"value":v}),Err(e)=>json!({"error":e})});
}
