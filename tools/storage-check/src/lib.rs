// Compile the actual desktop storage modules without the Tauri/WebView shell.
#![cfg(test)]
#[path = "../../../app/apps/desktop/src-tauri/src/storage.rs"]
mod storage;
#[path = "../../../app/apps/desktop/src-tauri/src/knowledge.rs"]
mod knowledge;
#[path = "../../../app/apps/desktop/src-tauri/src/practice.rs"]
mod practice;
#[path = "../../../app/apps/desktop/src-tauri/src/model.rs"]
mod model;
#[path = "../../../app/apps/desktop/src-tauri/src/workflow_model.rs"]
mod workflow_model;
#[path = "../../../app/apps/desktop/src-tauri/src/model_http.rs"]
mod model_http;
#[path = "../../../app/apps/desktop/src-tauri/src/pdf_export.rs"]
mod pdf_export;
