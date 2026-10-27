//! Read a teacher-provided database and exercise copying into an ephemeral local
//! database. Never creates student fixtures or writes into the source directory.
#![allow(dead_code)]
#[path="../../../../app/apps/desktop/src-tauri/src/storage.rs"]mod storage;
#[path="../../../../app/apps/desktop/src-tauri/src/practice.rs"]mod practice;
#[path="../../../../app/apps/desktop/src-tauri/src/knowledge.rs"]mod knowledge;
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let source=std::path::PathBuf::from(std::env::args().nth(1).ok_or("pass the actual legacy workspace database path")?);
    let before=std::fs::read(&source)?;
    let input=storage::load(&rusqlite::Connection::open_with_flags(&source,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?)?;
    let value=serde_json::to_value(&input)?;
    let revision=value["revision"].as_i64().ok_or("missing revision")?;
    let temporary=tempfile::tempdir()?;
    let target=temporary.path().join("workspace.sqlite");
    let copied=storage::import_legacy(&source,&target,revision,0)?;
    assert_eq!(serde_json::to_value(copied)?["snapshot"],value["snapshot"]);
    assert_eq!(storage::import_legacy(&source,&target,revision,1).unwrap_err(),"legacy_target_not_empty");
    let changed=temporary.path().join("changed.sqlite");
    assert_eq!(storage::import_legacy(&source,&changed,revision+1,0).unwrap_err(),"legacy_source_changed");
    assert!(!changed.exists());
    assert_eq!(std::fs::read(&source)?,before,"source must remain byte-for-byte unchanged");
    let knowledge_path=source.with_file_name("knowledge.sqlite");
    let knowledge=rusqlite::Connection::open_with_flags(knowledge_path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let knowledge_ready=knowledge::require_searchable(&knowledge).is_ok();
    let students=value["snapshot"]["students"].as_array().ok_or("missing students")?;
    let records:usize=students.iter().map(|s|s["questions"].as_array().map_or(0,Vec::len)).sum();
    println!("{}",serde_json::json!({"students":students.len(),"records":records,"copyMatchesSource":true,"sourceUnchanged":true,"overwriteRejected":true,"changedSourceRejected":true,"knowledgeReady":knowledge_ready,"modelCalls":0,"realAccountWorkspaceModified":false}));
    Ok(())
}
