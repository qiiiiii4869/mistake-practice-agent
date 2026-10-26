// Compile the actual desktop storage modules without the Tauri/WebView shell.
#![cfg(test)]
#[path = "../../../app/apps/desktop/src-tauri/src/storage.rs"]
mod storage;
#[path = "../../../app/apps/desktop/src-tauri/src/knowledge.rs"]
mod knowledge;
#[path = "../../../app/apps/desktop/src-tauri/src/practice.rs"]
mod practice;
