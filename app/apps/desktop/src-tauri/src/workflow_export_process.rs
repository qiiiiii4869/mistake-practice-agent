use serde_json::{Value,json};
use std::{io::{BufRead,BufReader,Write},path::Path,sync::{atomic::{AtomicBool,Ordering},mpsc},time::{Duration,Instant},process::{Command,Stdio}};

// Only fixed packaged code executes; neither renderer nor model chooses a command.
pub(crate) fn run(runtime:&Path,request:Value,cancel:&AtomicBool,mut rpc:impl FnMut(&Value)->Result<Value,String>,mut progress:impl FnMut(Value))->Result<Value,String>{
 let node=runtime.join("node.exe");let bridge=runtime.join("tools/workflow-desktop-export.mjs");
 if !node.is_file()||!bridge.is_file(){return Err("pdf_runtime_missing".into());}
 let mut command=Command::new(node);command.arg(bridge).current_dir(runtime).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
 for key in ["SystemRoot","WINDIR","TEMP","TMP"]{if let Some(value)=std::env::var_os(key){command.env(key,value);}}
 #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
 let mut child=command.spawn().map_err(|_|"pdf_runtime_unavailable")?;
 struct Reap<'a>(&'a mut std::process::Child);impl Drop for Reap<'_>{fn drop(&mut self){let _=self.0.kill();let _=self.0.wait();}}
 let guard=Reap(&mut child);
 let mut stdin=guard.0.stdin.take().ok_or("pdf_runtime_unavailable")?;
 let stdout=guard.0.stdout.take().ok_or("pdf_runtime_unavailable")?;
 writeln!(stdin,"{}",request).map_err(|_|"pdf_bridge_failed")?;stdin.flush().map_err(|_|"pdf_bridge_failed")?;
 let(tx,rx)=mpsc::sync_channel(1);
 std::thread::spawn(move||{let mut reader=BufReader::new(stdout);loop{let mut bytes=Vec::new();
   // Keep malformed or compromised children from flooding the parent with data.
   let result=std::io::Read::take(&mut reader,20*1024*1024+1).read_until(b'\n',&mut bytes);
   match result{Ok(0)|Err(_)=>break,Ok(_)if bytes.len()>20*1024*1024=>{let _=tx.send(Err("pdf_bridge_limit".to_string()));break;},Ok(_)=>{if tx.send(serde_json::from_slice::<Value>(&bytes).map_err(|_|"pdf_bridge_failed".into())).is_err(){break;}}}
 }});
 let started=Instant::now();let mut cancelled=None;
 loop{
  if cancel.load(Ordering::SeqCst)&&cancelled.is_none(){let _=writeln!(stdin,"{}",json!({"type":"cancel"}));let _=stdin.flush();cancelled=Some(Instant::now());}
  if cancelled.is_some_and(|t:Instant|t.elapsed()>Duration::from_secs(5)){return Err("pdf_cancelled".into());}
  if started.elapsed()>Duration::from_secs(3700){return Err("pdf_export_timeout".into());}
  let message=match rx.recv_timeout(Duration::from_millis(100)){Ok(value)=>value?,Err(mpsc::RecvTimeoutError::Timeout)=>continue,Err(_)=>return Err(if cancelled.is_some(){"pdf_cancelled"}else{"pdf_bridge_failed"}.into())};
  match message["event"].as_str(){
   Some("store")=>{
    let result=rpc(&message["args"]);let reply=match result{Ok(value)=>json!({"type":"reply","id":message["id"],"value":value}),Err(error)=>json!({"type":"reply","id":message["id"],"error":error})};
    writeln!(stdin,"{}",reply).map_err(|_|"pdf_bridge_failed")?;stdin.flush().map_err(|_|"pdf_bridge_failed")?;
   },
   Some("progress")=>progress(message["value"].clone()),
   Some("result")=>{if cancelled.is_some(){return Err("pdf_cancelled".into());}return Ok(message["value"].clone());},
   Some("error")=>return Err(message["code"].as_str().filter(|c|c.len()<100&&c.bytes().all(|b|b.is_ascii_lowercase()||b==b'_')).unwrap_or("pdf_export_failed").into()),
   _=>return Err("pdf_bridge_failed".into())
  }
 }
}

pub(crate) fn validate_rpc(args:&Value,owner:&str,run_id:&str)->Result<(),String>{
 if args["ownerId"]!=owner||args["payload"]["runId"]!=run_id||!matches!(args["operation"].as_str(),Some("load"|"load_response"|"list_exports"|"save_export")){return Err("pdf_invalid_command".into());}Ok(())
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn export_rpc_cannot_change_account_task_or_generation_ledger(){
  let mut value=json!({"ownerId":"owner","operation":"load","payload":{"runId":"run"}});assert!(validate_rpc(&value,"owner","run").is_ok());
  for op in ["begin","save","end","save_analysis"]{value["operation"]=json!(op);assert!(validate_rpc(&value,"owner","run").is_err());}
  value["operation"]=json!("save_export");value["ownerId"]=json!("other");assert!(validate_rpc(&value,"owner","run").is_err());
  value["ownerId"]=json!("owner");value["payload"]["runId"]=json!("other");assert!(validate_rpc(&value,"owner","run").is_err());
 }
}
