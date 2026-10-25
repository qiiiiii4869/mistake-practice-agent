use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

mod remote;
mod storage;

const PROBE: &str = include_str!(concat!(env!("OUT_DIR"), "/probe.js"));
const LOGIN_URL: &str = "https://www.zhixue.com/wap_login.html";

#[derive(Default)]
struct ProbeState {
    running: AtomicBool,
    last_report: Mutex<Option<ConnectionReport>>,
    captcha_seen: AtomicBool,
    progress: Mutex<Option<Value>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Exam {
    id: String,
    name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Subject {
    code: String,
    name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct TeachingClass {
    id: String,
    name: String,
    subjects: Vec<Subject>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Endpoint {
    host: String,
    path: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    business_code: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Summary {
    status: String,
    authentication: String,
    #[serde(default)]
    error: Option<String>,
    endpoints: Vec<Endpoint>,
    #[serde(default)]
    exams: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ConnectionReport {
    ok: bool,
    summary: Summary,
    #[serde(default)]
    options: Vec<Exam>,
    #[serde(default, rename = "teachingClasses")]
    teaching_classes: Vec<TeachingClass>,
}

// Navigation guard, not a claim of filtering all third-party subresource traffic.
// Changyan is the SSO URL referenced by the official Zhixue login page.
fn allowed_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| {
            host == "zhixue.com" || host.ends_with(".zhixue.com") || host == "open.changyan.com"
        })
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("local_window_required".into())
    }
}

fn create_login(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("zhixue-login") {
        window.show().map_err(|_| "window_show_failed")?;
        window.set_focus().map_err(|_| "window_focus_failed")?;
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        app,
        "zhixue-login",
        WebviewUrl::External(LOGIN_URL.parse().unwrap()),
    )
    .title("智学网 · 请手动登录教师账号")
    .inner_size(1120.0, 820.0)
    .min_inner_size(800.0, 600.0)
    .on_navigation(allowed_navigation)
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    // Match the existing live probe's direct connection. A separate profile is required
    // by WebView2 when browser arguments differ; this does not modify the system proxy.
    #[cfg(target_os = "windows")]
    let builder = builder
        .data_directory(
            app.path()
                .app_local_data_dir()
                .map_err(|_| "webview_path_failed")?
                .join("zhixue-webview"),
        )
        .additional_browser_args("--no-proxy-server");
    builder.build().map_err(|_| "login_window_create_failed")?;
    Ok(())
}

#[tauri::command]
async fn open_login(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    require_main(&window)?;
    create_login(&app)
}

async fn evaluate(window: &WebviewWindow, script: String) -> Result<String, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Mutex::new(Some(sender));
    window
        .eval_with_callback(script, move |value| {
            if let Ok(mut guard) = sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(value);
                }
            }
        })
        .map_err(|_| "webview_eval_failed")?;
    tokio::time::timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "webview_eval_timeout".to_string())?
        .map_err(|_| "webview_eval_failed".to_string())
}

#[derive(Serialize)]
struct LoginStatus {
    open: bool,
    host: Option<String>,
    captcha_60500: bool,
}

#[tauri::command]
async fn login_status(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, ProbeState>,
) -> Result<LoginStatus, String> {
    require_main(&window)?;
    let Some(login) = app.get_webview_window("zhixue-login") else {
        return Ok(LoginStatus {
            open: false,
            host: None,
            captcha_60500: state.captcha_seen.load(Ordering::SeqCst),
        });
    };
    let url = login.url().map_err(|_| "window_url_failed")?;
    // Read rendered text only to recognize the known login error. No text is returned or saved.
    if allowed_navigation(&url) {
        if let Ok(value) = evaluate(
            &login,
            "(() => /(^|[^0-9])60500([^0-9]|$)/.test(document.body?.innerText ?? ''))()".into(),
        )
        .await
        {
            if value == "true" {
                state.captcha_seen.store(true, Ordering::SeqCst);
            }
        }
    }
    Ok(LoginStatus {
        open: true,
        host: url.host_str().map(str::to_owned),
        captcha_60500: state.captcha_seen.load(Ordering::SeqCst),
    })
}

struct RunningGuard<'a>(&'a AtomicBool);
impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
async fn read_exam_list(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, ProbeState>,
) -> Result<ConnectionReport, String> {
    require_main(&window)?;
    *state.last_report.lock().map_err(|_| "state_unavailable")? = None;
    let value = remote::run_remote(&app, &state, json!({"action":"connect"})).await?;
    let report: ConnectionReport =
        serde_json::from_value(value).map_err(|_| "invalid_probe_result")?;
    validate_report(&report)?;
    *state.last_report.lock().map_err(|_| "state_unavailable")? = Some(report.clone());
    Ok(report)
}

fn validate_report(report: &ConnectionReport) -> Result<(), String> {
    if report.ok
        && (report.summary.authentication != "verified_teacher_session"
            || !["connected", "no_exams_in_latest_term"].contains(&report.summary.status.as_str())
            || report.teaching_classes.is_empty())
    {
        return Err("invalid_probe_result".into());
    }
    if report.ok && report.summary.status == "connected" && report.options.is_empty() {
        return Err("invalid_probe_result".into());
    }
    if report.options.len() > 30 || report.teaching_classes.len() > 1000 {
        return Err("invalid_probe_result".into());
    }
    Ok(())
}

#[tauri::command]
async fn read_subjects(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, ProbeState>,
    exam_id: String,
) -> Result<Value, String> {
    require_main(&window)?;
    if exam_id.is_empty() || exam_id.len() > 300 {
        return Err("selection_required".into());
    }
    remote::run_remote(&app, &state, json!({"action":"subjects", "examId":exam_id})).await
}

#[tauri::command]
async fn read_class_scores(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, ProbeState>,
    exam_id: String,
    subject_id: String,
    class_id: String,
) -> Result<Value, String> {
    require_main(&window)?;
    if [&exam_id, &subject_id, &class_id]
        .iter()
        .any(|s| s.is_empty() || s.len() > 300)
    {
        return Err("selection_required".into());
    }
    remote::run_remote(
        &app,
        &state,
        json!({"action":"export", "fullClass":true,
        "examId":exam_id, "subjectId":subject_id, "classId":class_id}),
    )
    .await
}

#[tauri::command]
async fn probe_progress(
    window: WebviewWindow,
    state: tauri::State<'_, ProbeState>,
) -> Result<Option<Value>, String> {
    require_main(&window)?;
    Ok(state
        .progress
        .lock()
        .map_err(|_| "state_unavailable")?
        .clone())
}

fn database_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "storage_failed")?
        .join("workspace.sqlite"))
}

#[tauri::command]
async fn load_workspace(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<storage::Stored, String> {
    require_main(&window)?;
    storage::load(&storage::open(&database_path(&app)?)?)
}

#[tauri::command]
async fn save_workspace(
    window: WebviewWindow,
    app: tauri::AppHandle,
    expected_revision: i64,
    snapshot: Option<storage::Snapshot>,
) -> Result<storage::Stored, String> {
    require_main(&window)?;
    if let Some(snapshot) = &snapshot {
        snapshot.validate()?;
    }
    let audit = snapshot.as_ref().map(storage::Snapshot::anonymous_audit);
    let saved = storage::save(
        &mut storage::open(&database_path(&app)?)?,
        expected_revision,
        snapshot,
    )?;
    // Audit writing is secondary: a filesystem error must not hide a committed save.
    if let Some(audit) = audit {
        if let Ok(folder) = app
            .path()
            .app_local_data_dir()
            .map(|p| p.join("diagnostics"))
        {
            if std::fs::create_dir_all(&folder).is_ok() {
                if let Ok(bytes) = serde_json::to_vec_pretty(&audit) {
                    let _ = std::fs::write(folder.join("desktop-class-verification.json"), bytes);
                }
            }
        }
    }
    Ok(saved)
}

// Rebuild diagnostics from known fields. Names, IDs, raw responses and URLs are excluded.
fn anonymous_diagnostic(report: &ConnectionReport, captcha_seen: bool) -> Value {
    let endpoints: Vec<Value> = report.summary.endpoints.iter().map(|endpoint| {
        let known_host = ["www.zhixue.com", "ali-bg.zhixue.com"].contains(&endpoint.host.as_str());
        let known_path = ["/container/getCurrentUser", "/container/app/token/getToken",
            "/api-classreport/class/getAcademicTermTeachingCycle/", "/api-classreport/class/getUserTeachingInfos/",
            "/api-teacher/newContainer/getClassReportList"].contains(&endpoint.path.as_str());
        json!({ "host": if known_host { &endpoint.host } else { "unrecognized" },
            "path": if known_path { &endpoint.path } else { "unrecognized" },
            "http_status": endpoint.http_status,
            "business_code": endpoint.business_code.as_ref().and_then(|code| code.as_i64().or_else(|| code.as_str()?.parse().ok())),
            "error": endpoint.error.as_deref().map(safe_code) })
    }).collect();
    json!({ "schema_version": 1, "stage": "tauri_login_and_exam_list", "app_version": env!("CARGO_PKG_VERSION"),
        "checked_at_unix_seconds": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        "live_exam_list_verified": report.ok && report.summary.authentication == "verified_teacher_session" && !report.options.is_empty(),
        "captcha_60500_observed": captcha_seen,
        "authentication": if report.summary.authentication == "verified_teacher_session" { "verified_teacher_session" } else { "not_verified" },
        "status": safe_code(&report.summary.status), "error": report.summary.error.as_deref().map(safe_code),
        "exam_count": report.options.len(), "teaching_class_count": report.teaching_classes.len(),
        "scope": "latest_term_first_page", "endpoints": endpoints })
}

fn safe_code(code: &str) -> &str {
    const ALLOWED: &[&str] = &[
        "connected",
        "no_exams_in_latest_term",
        "failed",
        "teacher_session_required",
        "missing_session_token",
        "academic_schema_changed",
        "teaching_scope_schema_changed",
        "no_teaching_scope",
        "exam_list_schema_changed",
        "request_timeout",
        "request_failed",
        "session_expired",
        "invalid_json_shape",
        "probe_failed",
        "open_authenticated_zhixue_tab",
        "endpoint_not_allowed",
    ];
    if ALLOWED.contains(&code)
        || ["http_", "business_error_"].iter().any(|prefix| {
            code.strip_prefix(prefix)
                .is_some_and(|value| value.len() <= 10 && value.parse::<i64>().is_ok())
        })
    {
        code
    } else {
        "unrecognized"
    }
}

#[tauri::command]
async fn save_diagnostic(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, ProbeState>,
) -> Result<String, String> {
    require_main(&window)?;
    let report = state
        .last_report
        .lock()
        .map_err(|_| "state_unavailable")?
        .clone()
        .ok_or("diagnostic_not_ready")?;
    let diagnostic = anonymous_diagnostic(&report, state.captcha_seen.load(Ordering::SeqCst));
    let folder = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "diagnostic_path_failed")?
        .join("diagnostics");
    std::fs::create_dir_all(&folder).map_err(|_| "diagnostic_write_failed")?;
    let path = folder.join("tauri-login-verification.json");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&diagnostic).map_err(|_| "diagnostic_write_failed")?,
    )
    .map_err(|_| "diagnostic_write_failed")?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProbeState::default())
        .invoke_handler(tauri::generate_handler![
            open_login,
            login_status,
            read_exam_list,
            save_diagnostic,
            read_subjects,
            read_class_scores,
            probe_progress,
            load_workspace,
            save_workspace
        ])
        .setup(|app| {
            if std::env::var("ZHIXUE_OPEN_LOGIN").as_deref() == Ok("1") {
                create_login(app.handle()).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("desktop application failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_rejects_untrusted_origins() {
        for url in [
            "https://www.zhixue.com/wap_login.html",
            "https://ali-bg.zhixue.com/",
            "https://open.changyan.com/sso/ac",
        ] {
            assert!(allowed_navigation(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "http://www.zhixue.com/",
            "https://zhixue.com.evil.test/",
            "https://evilzhixue.com/",
            "https://www.zhixue.com:444/",
            "https://u:p@www.zhixue.com/",
            "file:///C:/Windows/win.ini",
            "https://test-open.changyan.com/",
        ] {
            assert!(!allowed_navigation(&url.parse().unwrap()), "{url}");
        }
    }
    #[test]
    fn diagnostics_drop_names_tokens_and_arbitrary_codes() {
        let report: ConnectionReport = serde_json::from_value(json!({"ok":true,
            "summary":{"status":"connected","authentication":"verified_teacher_session","endpoints":[{
                "host":"www.zhixue.com", "path":"/container/getCurrentUser", "status":"received_json", "http_status":200,
                "error":"PRIVATE_TOKEN", "business_code":"PRIVATE_TOKEN"}]},
            "options":[{"id":"PRIVATE_EXAM_ID","name":"PRIVATE_EXAM_NAME"}],
            "teachingClasses":[{"id":"PRIVATE_CLASS_ID","name":"PRIVATE_CLASS_NAME","subjects":[]}]})).unwrap();
        validate_report(&report).unwrap();
        let output = anonymous_diagnostic(&report, false).to_string();
        assert!(!output.contains("PRIVATE"));
        assert!(output.contains("\"live_exam_list_verified\":true"));
    }
    #[test]
    fn empty_or_unverified_results_cannot_pass() {
        let mut report: ConnectionReport = serde_json::from_value(json!({"ok":true,
            "summary":{"status":"connected","authentication":"not_verified","endpoints":[]},
            "options":[],"teachingClasses":[]}))
        .unwrap();
        assert!(validate_report(&report).is_err());
        report.summary.authentication = "verified_teacher_session".into();
        assert!(validate_report(&report).is_err());
        assert!(
            !anonymous_diagnostic(&report, false)["live_exam_list_verified"]
                .as_bool()
                .unwrap()
        );
    }
}
