use super::*;

// Owns and cleans only this run's transient results in the remote window.
struct RemoteRun {
    window: WebviewWindow,
    run_id: String,
}
impl Drop for RemoteRun {
    fn drop(&mut self) {
        let run_id = &self.run_id;
        let _ = self.window.eval(format!(r#"(() => {{ if(window.__mistakeAgentProbe?.id === {run_id:?}) delete window.__mistakeAgentProbe;
          delete window['__zhixue_probe_progress_' + {run_id:?}]; }})()"#));
    }
}

pub(super) async fn run_remote(
    app: &tauri::AppHandle,
    state: &ProbeState,
    mut command: Value,
) -> Result<Value, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("probe_busy".into());
    }
    let _guard = RunningGuard(&state.running);
    *state.progress.lock().map_err(|_| "state_unavailable")? = None;
    let login = app
        .get_webview_window("zhixue-login")
        .ok_or("login_window_not_open")?;
    if login
        .url()
        .map_err(|_| "window_url_failed")?
        .origin()
        .ascii_serialization()
        != "https://www.zhixue.com"
    {
        return Err("open_authenticated_zhixue_tab".into());
    }
    let full_class = command["action"] == "export";
    let run_id = format!(
        "desktop-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "clock_error")?
            .as_nanos()
    );
    command["runId"] = json!(run_id);
    let command_json = serde_json::to_string(&command).map_err(|_| "invalid_probe_command")?;
    let run = RemoteRun {
        window: login.clone(),
        run_id: run_id.clone(),
    };
    let script = format!(
        r#"(() => {{
      {PROBE}
      const id = {run_id:?};
      window.__mistakeAgentProbe = {{ id, done: false }};
      zhixueProbe({command_json}).then(result => {{
        if (window.__mistakeAgentProbe?.id === id) window.__mistakeAgentProbe = {{ id, done: true, result }};
      }}).catch(() => {{
        if (window.__mistakeAgentProbe?.id === id) window.__mistakeAgentProbe = {{ id, done: true, result: {{
          ok: false, summary: {{ status: 'failed', authentication: 'not_verified', error: 'probe_failed', endpoints: [] }}
        }} }};
      }});
    }})()"#
    );
    login.eval(script).map_err(|_| "webview_eval_failed")?;
    let deadline =
        tokio::time::Instant::now() + Duration::from_secs(if full_class { 1800 } else { 120 });
    loop {
        tokio::time::sleep(Duration::from_millis(700)).await;
        if app.get_webview_window("zhixue-login").is_none() {
            return Err("login_window_closed".into());
        }
        let poll = format!(
            r#"(() => {{
          if (location.origin !== 'https://www.zhixue.com') return {{ changed: true }};
          const p = window.__mistakeAgentProbe;
          if (!p || p.id !== {run_id:?}) return {{ changed: true }};
          const progress = window['__zhixue_probe_progress_' + {run_id:?}];
          return p.done ? {{ result: p.result }} : {{ pending: true, progress }};
        }})()"#
        );
        let raw = evaluate(&login, poll).await?;
        if raw.len() > 16 * 1024 * 1024 {
            return Err("file_too_large".into());
        }
        let mut value: Value = serde_json::from_str(&raw).map_err(|_| "invalid_probe_result")?;
        if value["changed"] == true {
            return Err("probe_page_changed".into());
        }
        if let Some(progress) = value.get("progress") {
            let mut safe = json!({});
            for key in ["total", "processed", "succeeded", "unavailable", "failed"] {
                safe[key] = json!(progress[key].as_u64().unwrap_or(0));
            }
            *state.progress.lock().map_err(|_| "state_unavailable")? = Some(safe);
        }
        if let Some(result) = value.get_mut("result") {
            if result["summary"]["error"]
                .as_str()
                .is_some_and(|s| s.contains("60500"))
            {
                state.captcha_seen.store(true, Ordering::SeqCst);
            }
            // Return no credentials or answer-card content; the existing fullClass probe strips answers.
            let result = result.take();
            drop(run);
            return Ok(result);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(if full_class {
                "full_class_timeout"
            } else {
                "probe_timeout"
            }
            .into());
        }
    }
}
