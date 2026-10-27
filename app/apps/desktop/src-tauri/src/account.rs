use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct User {
    pub id: String,
    pub username: String,
    pub role: String,
    pub status: String,
    pub credits: u32,
    pub reserved: u32,
    pub available: u32,
    pub created_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
    token: String,
    expires_at: u64,
    user: User,
}
struct Session {
    token: String,
    expires_at: u64,
    verified_until: u64,
    user: User,
}
#[derive(Default)]
pub(crate) struct AccountState {
    session: Mutex<Option<Session>>,
    busy: AtomicBool,
}
struct Guard<'a>(&'a AtomicBool);
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn local(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("local_window_required".into())
    }
}
fn lock(state: &AccountState) -> Result<Guard<'_>, String> {
    if state.busy.swap(true, Ordering::SeqCst) {
        Err("account_busy".into())
    } else {
        Ok(Guard(&state.busy))
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}
fn endpoint() -> Result<reqwest::Url, String> {
    let value = option_env!("MISTAKE_ACCOUNT_API_URL").ok_or("account_server_unconfigured")?;
    let url = reqwest::Url::parse(value).map_err(|_| "account_server_unconfigured")?;
    let local_http = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if (!local_http && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().ends_with('/')
    {
        return Err("account_server_unconfigured".into());
    }
    Ok(url)
}
async fn request(path: &str, body: Option<Value>, token: Option<&str>) -> Result<Value, String> {
    let url = join_endpoint(endpoint()?, path)?;
    send_request(url, body, token).await
}
fn join_endpoint(base: reqwest::Url, path: &str) -> Result<reqwest::Url, String> {
    base.join(path.trim_start_matches('/'))
        .map_err(|_| "account_server_unconfigured".into())
}
async fn send_request(
    url: reqwest::Url,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "account_network_failed")?;
    let mut req = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    let mut response = req.send().await.map_err(|_| "account_network_failed")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "account_network_failed")?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err("account_invalid_response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "account_invalid_response")?;
    if !(200..300).contains(&status) {
        let code = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("account_service_failed");
        let allowed = [
            "username_taken",
            "invalid_credentials",
            "account_disabled",
            "session_required",
            "session_expired",
            "rate_limited",
            "invalid_input",
            "credits_exhausted",
            "generation_busy",
            "generation_expired",
            "generation_not_found",
            "server_busy",
            "admin_required",
            "credit_limit",
            "idempotency_conflict",
            "user_not_found",
            "account_inactive",
            "protected_account",
            "username_confirmation_mismatch",
            "account_not_disabled",
            "current_password_required",
            "current_password_incorrect",
            "password_change_conflict",
        ];
        return Err(if allowed.contains(&code) {
            code.into()
        } else {
            "account_service_failed".into()
        });
    }
    Ok(value)
}
fn token(state: &AccountState) -> Result<String, String> {
    state
        .session
        .lock()
        .map_err(|_| "state_unavailable")?
        .as_ref()
        .filter(|s| s.expires_at > now())
        .map(|s| s.token.clone())
        .ok_or("session_required".into())
}
fn update(state: &AccountState, value: &Value) -> Result<User, String> {
    let user: User = serde_json::from_value(
        value
            .get("user")
            .cloned()
            .ok_or("account_invalid_response")?,
    )
    .map_err(|_| "account_invalid_response")?;
    if !valid_id(&user.id)
        || user.status != "active"
        || !matches!(user.role.as_str(), "user" | "admin")
        || user.available.checked_add(user.reserved) != Some(user.credits)
    {
        return Err("account_invalid_response".into());
    }
    let mut session = state.session.lock().map_err(|_| "state_unavailable")?;
    let session = session.as_mut().ok_or("session_required")?;
    if session.user.id != user.id {
        return Err("account_invalid_response".into());
    }
    session.user = user.clone();
    session.verified_until = now() + 90_000;
    Ok(user)
}
pub(crate) fn require_session(state: &AccountState) -> Result<(), String> {
    let session = state.session.lock().map_err(|_| "state_unavailable")?;
    if session
        .as_ref()
        .is_some_and(|s| s.expires_at > now() && s.verified_until > now())
    {
        Ok(())
    } else {
        Err("session_required".into())
    }
}
pub(crate) fn user_folder(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let state = app.state::<AccountState>();
    require_session(&state)?;
    let session = state.session.lock().map_err(|_| "state_unavailable")?;
    let id = session.as_ref().ok_or("session_required")?.user.id.clone();
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "storage_failed")?
        .join("accounts")
        .join(id))
}
pub(crate) fn confirm_current_username(app: &tauri::AppHandle, username: &str) -> Result<(), String> {
    let state = app.state::<AccountState>();
    require_session(&state)?;
    let session = state.session.lock().map_err(|_| "state_unavailable")?;
    if session.as_ref().ok_or("session_required")?.user.username != username {
        return Err("legacy_username_mismatch".into());
    }
    Ok(())
}
fn pending_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(user_folder(app)?.join("pending-generation.json"))
}
fn clear_private_state(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(login) = app.get_webview_window("zhixue-login") {
        login.close().map_err(|_| "window_close_failed")?;
    }
    if let Some(admin) = app.get_webview_window("account-admin") {
        admin.close().map_err(|_| "window_close_failed")?;
    }
    let model = app.state::<super::DeepseekState>();
    *model.key.lock().map_err(|_| "state_unavailable")? = None;
    model.quota.store(false, Ordering::SeqCst);
    *model.usage.lock().map_err(|_| "state_unavailable")? = super::model::Usage::default();
    let probe = app.state::<super::ProbeState>();
    *probe.last_report.lock().map_err(|_| "state_unavailable")? = None;
    probe.captcha_seen.store(false, Ordering::SeqCst);
    *probe.progress.lock().map_err(|_| "state_unavailable")? = None;
    Ok(())
}

#[tauri::command]
pub(crate) fn account_config(window: WebviewWindow) -> Result<Value, String> {
    local(&window)?;
    Ok(
        json!({"configured":endpoint().is_ok(),"server":endpoint().ok().map(|u|u.origin().ascii_serialization())}),
    )
}
fn admin_access(state: &AccountState) -> Result<String, String> {
    require_session(state)?;
    let session = state.session.lock().map_err(|_| "state_unavailable")?;
    let session = session.as_ref().ok_or("session_required")?;
    if session.user.role != "admin" {
        return Err("admin_required".into());
    }
    Ok(session.token.clone())
}

#[tauri::command]
pub(crate) async fn account_admin_users(
    window: WebviewWindow,
    state: tauri::State<'_, AccountState>,
    query: String,
    page: u32,
) -> Result<Value, String> {
    local(&window)?;
    let access = admin_access(&state)?;
    if query.chars().count() > 32 || page == 0 || page > 100000 {
        return Err("invalid_input".into());
    }
    let mut url = join_endpoint(endpoint()?, "v1/admin/users")?;
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("page", &page.to_string());
    request(
        &format!("v1/admin/users?{}", url.query().unwrap_or("")),
        None,
        Some(&access),
    )
    .await
}

#[tauri::command]
pub(crate) async fn account_admin_ledger(
    window: WebviewWindow,
    state: tauri::State<'_, AccountState>,
    user_id: String,
) -> Result<Value, String> {
    local(&window)?;
    let access = admin_access(&state)?;
    if !valid_id(&user_id) {
        return Err("invalid_input".into());
    }
    request(
        &format!("/v1/admin/users/{user_id}/ledger"),
        None,
        Some(&access),
    )
    .await
}

#[tauri::command]
pub(crate) async fn account_admin_grant(
    window: WebviewWindow,
    state: tauri::State<'_, AccountState>,
    user_id: String,
    amount: u32,
    reason: String,
    request_key: String,
) -> Result<Value, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    let access = admin_access(&state)?;
    if !valid_id(&user_id)
        || !valid_id(&request_key)
        || !(1..=100000).contains(&amount)
        || reason.trim().is_empty()
        || reason.chars().count() > 200
    {
        return Err("invalid_input".into());
    }
    request(
        &format!("/v1/admin/users/{user_id}/credits"),
        Some(json!({"amount":amount,"reason":reason,"requestKey":request_key})),
        Some(&access),
    )
    .await
}

#[tauri::command]
pub(crate) async fn account_admin_deactivate(
    window: WebviewWindow,
    state: tauri::State<'_, AccountState>,
    user_id: String,
    confirm_username: String,
    reason: String,
    request_key: String,
) -> Result<Value, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    let access = admin_access(&state)?;
    if !valid_id(&user_id)
        || !valid_id(&request_key)
        || !(3..=32).contains(&confirm_username.len())
        || reason.trim().is_empty()
        || reason.chars().count() > 200
    {
        return Err("invalid_input".into());
    }
    request(
        &format!("/v1/admin/users/{user_id}/deactivate"),
        Some(json!({"confirmUsername":confirm_username,"reason":reason,"requestKey":request_key})),
        Some(&access),
    )
    .await
}

#[tauri::command]
pub(crate) async fn account_admin_audit(
    window: WebviewWindow,
    state: tauri::State<'_, AccountState>,
    user_id: String,
) -> Result<Value, String> {
    local(&window)?;
    let access = admin_access(&state)?;
    if !valid_id(&user_id) {
        return Err("invalid_input".into());
    }
    request(
        &format!("/v1/admin/users/{user_id}/account-audit"),
        None,
        Some(&access),
    )
    .await
}

#[tauri::command]
pub(crate) async fn account_admin_restore(
    window: WebviewWindow,
    state: tauri::State<'_, AccountState>,
    user_id: String,
    confirm_username: String,
    reason: String,
    request_key: String,
) -> Result<Value, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    let access = admin_access(&state)?;
    if !valid_id(&user_id)
        || !valid_id(&request_key)
        || !(3..=32).contains(&confirm_username.len())
        || reason.trim().is_empty()
        || reason.chars().count() > 200
    {
        return Err("invalid_input".into());
    }
    request(
        &format!("/v1/admin/users/{user_id}/restore"),
        Some(json!({"confirmUsername":confirm_username,"reason":reason,"requestKey":request_key})),
        Some(&access),
    )
    .await
}

#[tauri::command]
pub(crate) async fn account_admin_delete(
    window: WebviewWindow,
    state: tauri::State<'_, AccountState>,
    user_id: String,
    confirm_username: String,
    confirm_delete: bool,
) -> Result<Value, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    let access = admin_access(&state)?;
    if !valid_id(&user_id) || !(3..=32).contains(&confirm_username.len()) || !confirm_delete {
        return Err("invalid_input".into());
    }
    request(
        &format!("/v1/admin/users/{user_id}/delete"),
        Some(json!({"confirmUsername":confirm_username,"confirmDelete":true})),
        Some(&access),
    )
    .await
}

#[tauri::command]
pub(crate) async fn account_admin_password(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountState>,
    user_id: String,
    confirm_username: String,
    new_password: String,
    current_password: Option<String>,
    request_key: String,
) -> Result<Value, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    let access = admin_access(&state)?;
    if !valid_id(&user_id)
        || !valid_id(&request_key)
        || !(3..=32).contains(&confirm_username.len())
        || !(10..=128).contains(&new_password.chars().count())
    {
        return Err("invalid_input".into());
    }
    let self_change = state
        .session
        .lock()
        .map_err(|_| "state_unavailable")?
        .as_ref()
        .ok_or("session_required")?
        .user
        .id
        == user_id;
    if self_change
        && (app
            .state::<super::ProbeState>()
            .running
            .load(Ordering::SeqCst)
            || app
                .state::<super::DeepseekState>()
                .running
                .load(Ordering::SeqCst)
            || app.state::<super::ExportState>().0.load(Ordering::SeqCst))
    {
        return Err("account_work_in_progress".into());
    }
    let mut body = json!({"confirmUsername":confirm_username,"newPassword":new_password,"requestKey":request_key});
    if let Some(password) = current_password {
        body["currentPassword"] = json!(password);
    }
    let value = request(
        &format!("/v1/admin/users/{user_id}/password"),
        Some(body),
        Some(&access),
    )
    .await?;
    if self_change {
        *state.session.lock().map_err(|_| "state_unavailable")? = None;
        clear_private_state(&app)?;
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn account_admin_view_password(
    window: WebviewWindow,
    state: tauri::State<'_, AccountState>,
    user_id: String,
    current_password: String,
    request_key: String,
) -> Result<Value, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    let access = admin_access(&state)?;
    if !valid_id(&user_id)
        || !valid_id(&request_key)
        || !(10..=128).contains(&current_password.chars().count())
    {
        return Err("invalid_input".into());
    }
    request(
        &format!("/v1/admin/users/{user_id}/password/view"),
        Some(json!({"currentPassword":current_password,"requestKey":request_key})),
        Some(&access),
    )
    .await
}
#[tauri::command]
pub(crate) async fn account_sign_in(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountState>,
    username: String,
    password: String,
    register: bool,
) -> Result<User, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    if state
        .session
        .lock()
        .map_err(|_| "state_unavailable")?
        .is_some()
    {
        return Err("account_already_signed_in".into());
    }
    if app
        .state::<super::ProbeState>()
        .running
        .load(Ordering::SeqCst)
        || app
            .state::<super::DeepseekState>()
            .running
            .load(Ordering::SeqCst)
        || app.state::<super::ExportState>().0.load(Ordering::SeqCst)
    {
        return Err("account_work_in_progress".into());
    }
    clear_private_state(&app)?;
    if !(3..=32).contains(&username.len())
        || !username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        || !(10..=128).contains(&password.chars().count())
    {
        return Err("invalid_input".into());
    }
    let value = request(
        if register {
            "/v1/auth/register"
        } else {
            "/v1/auth/login"
        },
        Some(json!({"username":username,"password":password})),
        None,
    )
    .await?;
    let response: AuthResponse =
        serde_json::from_value(value.clone()).map_err(|_| "account_invalid_response")?;
    if response.token.len() != 64
        || !response.token.bytes().all(|b| b.is_ascii_hexdigit())
        || response.expires_at <= now()
        || !valid_id(&response.user.id)
    {
        return Err("account_invalid_response".into());
    }
    *state.session.lock().map_err(|_| "state_unavailable")? = Some(Session {
        token: response.token,
        expires_at: response.expires_at,
        verified_until: 0,
        user: response.user,
    });
    update(&state, &value)
}
#[tauri::command]
pub(crate) async fn account_me(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountState>,
) -> Result<Option<User>, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    if state
        .session
        .lock()
        .map_err(|_| "state_unavailable")?
        .is_none()
    {
        return Ok(None);
    }
    let access = match token(&state) {
        Ok(t) => t,
        Err(e) => {
            *state.session.lock().map_err(|_| "state_unavailable")? = None;
            clear_private_state(&app)?;
            return Err(e);
        }
    };
    match request("/v1/me", None, Some(&access)).await {
        Ok(value) => Ok(Some(update(&state, &value)?)),
        Err(error) => {
            if ["session_expired", "session_required", "account_disabled"].contains(&error.as_str())
            {
                *state.session.lock().map_err(|_| "state_unavailable")? = None;
                clear_private_state(&app)?;
            }
            Err(error)
        }
    }
}
#[tauri::command]
pub(crate) async fn account_sign_out(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountState>,
) -> Result<(), String> {
    local(&window)?;
    let _guard = lock(&state)?;
    if app
        .state::<super::ProbeState>()
        .running
        .load(Ordering::SeqCst)
        || app
            .state::<super::DeepseekState>()
            .running
            .load(Ordering::SeqCst)
        || app.state::<super::ExportState>().0.load(Ordering::SeqCst)
    {
        return Err("account_work_in_progress".into());
    }
    if let Ok(access) = token(&state) {
        let _ = request("/v1/auth/logout", Some(json!({})), Some(&access)).await;
    }
    *state.session.lock().map_err(|_| "state_unavailable")? = None;
    clear_private_state(&app)
}
#[tauri::command]
pub(crate) async fn account_generation_begin(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountState>,
    request_key: String,
) -> Result<Value, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    require_session(&state)?;
    if !valid_id(&request_key) {
        return Err("invalid_input".into());
    }
    let value = request(
        "/v1/generations",
        Some(json!({"requestKey":request_key})),
        Some(&token(&state)?),
    )
    .await?;
    if value["state"] != "reserved" || !value["jobId"].as_str().is_some_and(valid_id) {
        return Err("generation_expired".into());
    }
    let path = pending_path(&app)?;
    if path.exists() {
        let old: Value =
            serde_json::from_slice(&std::fs::read(&path).map_err(|_| "storage_failed")?)
                .map_err(|_| "storage_failed")?;
        if old["jobId"] != value["jobId"] {
            return Err("generation_busy".into());
        }
        return Ok(value);
    }
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "storage_failed")?;
    std::fs::write(
        path,
        serde_json::to_vec(&json!({"jobId":value["jobId"],"batch":null})).unwrap(),
    )
    .map_err(|_| "storage_failed")?;
    Ok(value)
}
#[tauri::command]
pub(crate) fn account_pending_generation(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountState>,
) -> Result<Value, String> {
    local(&window)?;
    require_session(&state)?;
    let path = pending_path(&app)?;
    if !path.exists() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|_| "storage_failed")?)
        .map_err(|_| "storage_failed".into())
}
#[tauri::command]
pub(crate) async fn account_generation_finish(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountState>,
    job_id: String,
    batch: Option<Value>,
) -> Result<Value, String> {
    local(&window)?;
    let _guard = lock(&state)?;
    require_session(&state)?;
    if !valid_id(&job_id) {
        return Err("invalid_input".into());
    }
    let path = pending_path(&app)?;
    let pending: Value =
        serde_json::from_slice(&std::fs::read(&path).map_err(|_| "storage_failed")?)
            .map_err(|_| "storage_failed")?;
    if pending["jobId"] != job_id {
        return Err("generation_not_found".into());
    }
    if let Some(batch) = &batch {
        if batch["mode"] != "real"
            || !batch["variants"]
                .as_array()
                .is_some_and(|v| v.iter().any(|q| q["passed"] == true))
        {
            return Err("generation_empty".into());
        }
        let stored = super::storage::load(&super::storage::open(&super::database_path(&app)?)?)?;
        let mut value =
            serde_json::to_value(stored).map_err(|_| "storage_failed")?["snapshot"].clone();
        value
            .as_object_mut()
            .ok_or("model_no_workspace")?
            .insert("practice".into(), batch.clone());
        let snapshot: super::storage::Snapshot =
            serde_json::from_value(value).map_err(|_| "invalid_practice")?;
        snapshot.validate()?;
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"jobId":job_id,"batch":batch}))
                .map_err(|_| "storage_failed")?,
        )
        .map_err(|_| "storage_failed")?;
    }
    let value = match request(
        &format!("/v1/generations/{job_id}/finish"),
        Some(json!({"success":batch.is_some()})),
        Some(&token(&state)?),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            if batch.is_none()
                && ["generation_expired", "generation_not_found"].contains(&e.as_str())
            {
                let _ = std::fs::remove_file(path);
                return Ok(json!({"charged":false}));
            }
            return Err(e);
        }
    };
    update(&state, &value)?;
    if batch.is_none() {
        std::fs::remove_file(path).map_err(|_| "storage_failed")?;
    } else {
        std::fs::write(
            path,
            serde_json::to_vec(&json!({"jobId":job_id,"batch":batch,"paid":true}))
                .map_err(|_| "storage_failed")?,
        )
        .map_err(|_| "storage_failed")?;
    }
    Ok(value)
}
pub(crate) fn clear_saved_pending(
    app: &tauri::AppHandle,
    snapshot: &Option<super::storage::Snapshot>,
) {
    let Ok(path) = pending_path(app) else {
        return;
    };
    if let (Ok(bytes), Ok(value)) = (std::fs::read(&path), serde_json::to_value(snapshot)) {
        if let Ok(pending) = serde_json::from_slice::<Value>(&bytes) {
            if pending["paid"] == true
                && !pending["batch"].is_null()
                && pending["batch"] == value["practice"]
            {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_website_api_keeps_its_configured_prefix() {
        let base: reqwest::Url = "https://example.test/mistake-agent/".parse().unwrap();
        assert_eq!(
            join_endpoint(base.clone(), "/v1/auth/login")
                .unwrap()
                .as_str(),
            "https://example.test/mistake-agent/v1/auth/login"
        );
        assert_eq!(
            join_endpoint(base, "v1/admin/users?q=teacher&page=1")
                .unwrap()
                .as_str(),
            "https://example.test/mistake-agent/v1/admin/users?q=teacher&page=1"
        );
        assert_eq!(
            join_endpoint("http://127.0.0.1:8787/".parse().unwrap(), "/v1/me")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8787/v1/me"
        );
    }
    fn user() -> User {
        User {
            id: "00000000-0000-4000-8000-000000000001".into(),
            username: "test".into(),
            role: "user".into(),
            status: "active".into(),
            credits: 2,
            reserved: 0,
            available: 2,
            created_at: 1,
        }
    }
    #[test]
    fn session_requires_fresh_server_verification() {
        let state = AccountState::default();
        assert!(require_session(&state).is_err());
        *state.session.lock().unwrap() = Some(Session {
            token: "a".repeat(64),
            expires_at: now() + 3600_000,
            verified_until: now() + 10000,
            user: user(),
        });
        assert!(require_session(&state).is_ok());
        state
            .session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .verified_until = 0;
        assert!(require_session(&state).is_err());
        state
            .session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .verified_until = now() + 10000;
        state.session.lock().unwrap().as_mut().unwrap().expires_at = 0;
        assert!(require_session(&state).is_err());
    }
    #[test]
    fn admin_requests_require_a_fresh_admin_session() {
        let state = AccountState::default();
        assert!(admin_access(&state).is_err());
        *state.session.lock().unwrap() = Some(Session {
            token: "a".repeat(64),
            expires_at: now() + 10000,
            verified_until: now() + 10000,
            user: user(),
        });
        assert_eq!(admin_access(&state), Err("admin_required".into()));
        state.session.lock().unwrap().as_mut().unwrap().user.role = "admin".into();
        assert_eq!(admin_access(&state), Ok("a".repeat(64)));
        state
            .session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .verified_until = 0;
        assert_eq!(admin_access(&state), Err("session_required".into()));
    }
    #[test]
    fn account_ids_cannot_escape_their_local_directory() {
        assert!(valid_id(&user().id));
        for value in [
            "../other",
            "00000000-0000-4000-8000-00000000000/",
            "C:\\data",
            "../00000000-0000-4000-8000-000000000001",
        ] {
            assert!(!valid_id(value));
        }
    }
    #[test]
    fn response_cannot_switch_account_or_invent_balance() {
        let state = AccountState::default();
        *state.session.lock().unwrap() = Some(Session {
            token: "a".repeat(64),
            expires_at: now() + 10000,
            verified_until: 0,
            user: user(),
        });
        let mut next = serde_json::to_value(user()).unwrap();
        next["id"] = json!("00000000-0000-4000-8000-000000000002");
        assert!(update(&state, &json!({"user":next})).is_err());
        let mut next = serde_json::to_value(user()).unwrap();
        next["available"] = json!(3);
        assert!(update(&state, &json!({"user":next})).is_err());
        assert!(update(&state, &json!({"user":user()})).is_ok());
        assert!(require_session(&state).is_ok());
    }
}
