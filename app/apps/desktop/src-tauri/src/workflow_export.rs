use serde_json::{Value,json};
use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
use tauri::{Manager,Emitter,WebviewWindow};

#[derive(Default)]pub(crate) struct WorkflowExportState{busy:Arc<AtomicBool>,cancel:Arc<AtomicBool>}
#[tauri::command]pub(crate) fn workflow_pdf_status(window:WebviewWindow,app:tauri::AppHandle)->Result<Value,String>{
 super::require_main(&window)?;super::account::user_folder(&app)?;
 let resources=app.path().resource_dir().map_err(|_|"pdf_runtime_missing")?.join("resources");
 let fonts=std::env::var_os("WINDIR").map(|root|std::path::PathBuf::from(root).join("Fonts"));
 let ready_fonts=fonts.is_some_and(|root|["msyh.ttc","msyhbd.ttc","cambria.ttc"].iter().all(|f|root.join(f).is_file()));
 Ok(json!({"available":ready_fonts&&resources.join("workflow-runtime/node.exe").is_file()&&resources.join("workflow-runtime/tools/workflow-desktop-export.mjs").is_file()&&resources.join("workflow-runtime/app/node_modules/pdfjs-dist/package.json").is_file()&&resources.join("workflow-runtime/app/node_modules/@napi-rs/canvas/package.json").is_file()&&resources.join("typst/typst.exe").is_file()}))
}
#[tauri::command]pub(crate) fn workflow_pdf_cancel(window:WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,WorkflowExportState>)->Result<(),String>{
 super::require_main(&window)?;super::account::user_folder(&app)?;state.cancel.store(true,Ordering::SeqCst);Ok(())
}
#[tauri::command]pub(crate) async fn workflow_pdf_export(window:WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,WorkflowExportState>,run_id:String,layout:Option<String>,include_answers:Option<bool>,export_id:Option<String>)->Result<Option<Value>,String>{
 super::require_main(&window)?;let folder=super::account::user_folder(&app)?;
 let valid=|s:&str|!s.is_empty()&&s.len()<=100&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_');
 if !valid(&run_id)||export_id.as_ref().is_some_and(|id|!valid(id))||export_id.is_none()&&(!matches!(layout.as_deref(),Some("individual"|"combined"))||include_answers.is_none()){return Err("invalid_input".into());}
 if state.busy.swap(true,Ordering::SeqCst){return Err("pdf_export_busy".into());}
 struct Reset(Arc<AtomicBool>);impl Drop for Reset{fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}
 let _reset=Reset(state.busy.clone());state.cancel.store(false,Ordering::SeqCst);let cancel=state.cancel.clone();
 let owner=folder.file_name().and_then(|s|s.to_str()).ok_or("session_required")?.to_owned();let database=folder.join("workflow.sqlite");
 let resources=app.path().resource_dir().map_err(|_|"pdf_runtime_missing")?.join("resources");
 let value=tauri::async_runtime::spawn_blocking(move||{
  use tauri_plugin_dialog::DialogExt;
  let task=super::workflow_storage::load_task(&database,&owner,&run_id)?;
  if task["input"]["testScope"].is_object()||task["run"]["state"]!="contentReady"||task["run"]["executionMode"]!="real"{return Err("pdf_content_incomplete".into());}
  let mut request=json!({"type":"start","ownerId":owner,"runId":run_id,"compiler":resources.join("typst/typst.exe")});
  if let Some(export_id)=export_id{request["exportId"]=json!(export_id);}else{
   let Some(destination)=app.dialog().file().set_title("选择保存位置，将新建学生练习和教师报告文件夹").blocking_pick_folder()else{return Ok(None);};
   request["outputDir"]=json!(destination.into_path().map_err(|_|"pdf_write_failed")?);request["layout"]=json!(layout);request["includeAnswers"]=json!(include_answers);
  }
  if super::account::user_folder(&app)?!=folder{return Err("session_required".into());}
  let result=super::workflow_export_process::run(&resources.join("workflow-runtime"),request,&cancel,|args|{
   if super::account::user_folder(&app)?!=folder{return Err("session_required".into());}
   super::workflow_export_process::validate_rpc(args,&owner,&run_id)?;
   let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"pdf_export_failed")?.as_millis()as i64;
   super::workflow_storage::dispatch(&database,&owner,args["operation"].as_str().ok_or("pdf_invalid_command")?,&args["payload"],now)
  },|event|{let _=app.emit("workflow-export-progress",json!({"runId":run_id,"progress":event}));})?;
  if super::account::user_folder(&app)?!=folder{return Err("session_required".into());}Ok(Some(result))
 }).await.map_err(|_|"pdf_export_failed")?;value
}
