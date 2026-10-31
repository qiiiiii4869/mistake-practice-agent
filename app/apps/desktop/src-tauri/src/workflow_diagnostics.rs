use std::io::Write;
use tauri::WebviewWindow;
use super::workflow_diagnostic_schema::{Audit,validate};

#[tauri::command]pub(crate) fn workflow_save_diagnostic(window:WebviewWindow,app:tauri::AppHandle,report:Audit)->Result<(),String>{
    super::require_main(&window)?;validate(&report)?;
    let path=super::account::user_folder(&app)?.join("diagnostics").join("workflow-runs");
    std::fs::create_dir_all(&path).map_err(|_|"workflow_diagnostic_write_failed")?;
    let bytes=serde_json::to_vec_pretty(&report).map_err(|_|"workflow_diagnostic_invalid")?;
    if bytes.len()>256*1024{return Err("workflow_diagnostic_invalid".into());}
    let mut file=tempfile::NamedTempFile::new_in(&path).map_err(|_|"workflow_diagnostic_write_failed")?;
    file.write_all(&bytes).map_err(|_|"workflow_diagnostic_write_failed")?;
    file.as_file().sync_all().map_err(|_|"workflow_diagnostic_write_failed")?;
    file.persist(path.join(format!("{}.json",report.run_id))).map_err(|_|"workflow_diagnostic_write_failed")?;
    Ok(())
}
