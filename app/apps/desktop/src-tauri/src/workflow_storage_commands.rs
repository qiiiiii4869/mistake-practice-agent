use serde_json::Value;
use tauri::WebviewWindow;
#[tauri::command]
pub(crate) async fn workflow_store(window:WebviewWindow,app:tauri::AppHandle,owner_id:String,operation:String,payload:Value)->Result<Value,String>{
 super::require_main(&window)?;
 let folder=super::account::user_folder(&app)?;
 if folder.file_name().and_then(|s|s.to_str())!=Some(owner_id.as_str()){return Err("workflow_owner_mismatch".into());}
 let database=folder.join("workflow.sqlite");let expected=folder.clone();
 let value=tauri::async_runtime::spawn_blocking(move||{
  let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"workflow_storage_failed")?.as_millis()as i64;
  super::workflow_storage::dispatch(&database,&owner_id,&operation,&payload,now)
 }).await.map_err(|_|"workflow_storage_failed")??;
 if super::account::user_folder(&app)?!=expected{return Err("session_required".into());}Ok(value)
}
