use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

struct Session {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct AppState {
    // Each panel gets its own claude subprocess, keyed by a frontend-supplied
    // panel_id. In single-panel mode the frontend uses the literal "main".
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

#[derive(serde::Serialize)]
struct SessionInfo {
    id: String,
    title: String,
    cwd: String,
    mtime_ms: u128,
    message_count: usize,
    context_tokens: u64,
    context_limit: u64,
    total_cost_usd: f64,
    output_tokens: u64,
    model: String,
    permission_mode: String,
}

fn context_limit_for(model: &str, max_observed: u64) -> u64 {
    // If the session ever exceeded the 200k envelope, it must be on 1M.
    if max_observed > 200_000 {
        return 1_000_000;
    }
    if model.contains("1m") || model.contains("[1m]") {
        return 1_000_000;
    }
    200_000
}

fn encode_cwd(cwd: &str) -> String {
    cwd.replace('/', "-")
}

fn projects_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

#[tauri::command]
async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    panel_id: String,
    cwd: String,
    permission_mode: Option<String>,
    model: Option<String>,
    resume_id: Option<String>,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().await;
    if let Some(mut s) = guard.remove(&panel_id) {
        let _ = s.child.start_kill();
    }

    let mode = permission_mode.unwrap_or_else(|| "bypassPermissions".to_string());

    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg("--input-format").arg("stream-json")
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--permission-mode").arg(&mode);

    if let Some(m) = model.filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }

    if let Some(rid) = resume_id.filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(rid);
    }

    cmd.current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Make sure the spawned claude can be found even when the launching
    // environment has a minimal PATH. Cover the common install locations.
    let path = std::env::var("PATH").unwrap_or_default();
    let mut extras: Vec<String> = Vec::new();
    extras.push("/usr/local/bin".into());
    extras.push("/opt/homebrew/bin".into());
    if let Some(home) = std::env::var_os("HOME").and_then(|h| h.into_string().ok()) {
        extras.push(format!("{}/.npm-global/bin", home));
        extras.push(format!("{}/.local/bin", home));
        extras.push(format!("{}/.volta/bin", home));
        extras.push(format!("{}/.bun/bin", home));
        extras.push(format!("{}/.cargo/bin", home));
    }
    let combined = if path.is_empty() {
        extras.join(":")
    } else {
        format!("{}:{}", path, extras.join(":"))
    };
    cmd.env("PATH", combined);

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn claude: {}", e))?;
    let stdin = child.stdin.take().ok_or_else(|| "no stdin handle".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout handle".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr handle".to_string())?;

    let app_out = app.clone();
    let pid_out = panel_id.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "claude-event",
                serde_json::json!({ "panel_id": pid_out, "line": line }),
            );
        }
        let _ = app_out.emit("claude-done", serde_json::json!({ "panel_id": pid_out }));
    });

    let app_err = app.clone();
    let pid_err = panel_id.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "claude-stderr",
                serde_json::json!({ "panel_id": pid_err, "line": line }),
            );
        }
    });

    guard.insert(panel_id, Session { child, stdin });
    Ok(())
}

#[tauri::command]
async fn send_message(
    state: State<'_, AppState>,
    panel_id: String,
    text: String,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().await;
    let session = guard
        .get_mut(&panel_id)
        .ok_or_else(|| format!("no active session for panel {}", panel_id))?;
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    });
    let line = format!("{}\n", msg);
    session
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    session.stdin.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn stop_session(state: State<'_, AppState>, panel_id: String) -> Result<(), String> {
    let mut guard = state.sessions.lock().await;
    if let Some(mut s) = guard.remove(&panel_id) {
        let _ = s.child.start_kill();
    }
    Ok(())
}

#[tauri::command]
async fn interrupt_session(state: State<'_, AppState>, panel_id: String) -> Result<(), String> {
    let guard = state.sessions.lock().await;
    if let Some(s) = guard.get(&panel_id) {
        if let Some(pid) = s.child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGINT);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn default_cwd() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

/// Returns the "owner/repo" slug for the git repo at `cwd`, or an empty
/// string if it isn't a GitHub remote. Used to linkify PR references in
/// chat markdown.
#[tauri::command]
fn git_remote_url(cwd: String) -> String {
    use std::process::Command;
    let output = match Command::new("git")
        .args(["config", "--get", "remote.origin.url"])
        .current_dir(&cwd)
        .output()
    {
        Ok(o) => o,
        Err(_) => return String::new(),
    };
    if !output.status.success() {
        return String::new();
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(ssh) = url.strip_prefix("git@github.com:") {
        return ssh.trim_end_matches(".git").to_string();
    }
    if let Some(https) = url.strip_prefix("https://github.com/") {
        return https.trim_end_matches(".git").to_string();
    }
    if let Some(https) = url.strip_prefix("git://github.com/") {
        return https.trim_end_matches(".git").to_string();
    }
    String::new()
}

#[tauri::command]
fn preview_navigate(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    use tauri::Manager;
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e: url::ParseError| format!("invalid url: {}", e))?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview '{}' not found", label))?;
    webview.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns the top inset of the main window's content area in logical pixels
/// (title bar height on macOS, 0 on fullscreen / frameless windows).
#[tauri::command]
fn window_top_inset(window: tauri::Window) -> Result<u32, String> {
    if window.is_fullscreen().unwrap_or(false) {
        return Ok(0);
    }
    let outer_size = window.outer_size().map_err(|e| e.to_string())?;
    let inner_size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let diff_physical = (outer_size.height as i32) - (inner_size.height as i32);
    let logical = if diff_physical > 0 {
        ((diff_physical as f64) / scale).round() as u32
    } else {
        // Tauri sometimes reports the same size for outer and inner on macOS
        // once the webview is attached. Fall back to the standard title bar
        // height so the child webview lands below the URL bar anyway.
        #[cfg(target_os = "macos")]
        {
            28
        }
        #[cfg(not(target_os = "macos"))]
        {
            0
        }
    };
    Ok(logical)
}

#[derive(serde::Serialize)]
struct BranchInfo {
    is_repo: bool,
    current: String,
    branches: Vec<String>,
    dirty: bool,
}

fn run_git(cwd: &str, args: &[&str]) -> Result<(bool, String, String), std::io::Error> {
    use std::process::Command as StdCommand;
    let output = StdCommand::new("git")
        .args(args)
        .current_dir(cwd)
        .output()?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((output.status.success(), stdout, stderr))
}

#[tauri::command]
fn list_branches(cwd: String) -> BranchInfo {
    let (inside_ok, inside_out, _) = match run_git(&cwd, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(v) => v,
        Err(_) => {
            return BranchInfo {
                is_repo: false,
                current: String::new(),
                branches: vec![],
                dirty: false,
            };
        }
    };
    if !inside_ok || inside_out.trim() != "true" {
        return BranchInfo {
            is_repo: false,
            current: String::new(),
            branches: vec![],
            dirty: false,
        };
    }

    let current = run_git(&cwd, &["branch", "--show-current"])
        .ok()
        .and_then(|(ok, out, _)| if ok { Some(out.trim().to_string()) } else { None })
        .unwrap_or_default();

    let branches = run_git(&cwd, &["branch", "--format=%(refname:short)"])
        .ok()
        .and_then(|(ok, out, _)| {
            if ok {
                Some(
                    out.lines()
                        .map(|l| l.trim().to_string())
                        .filter(|l| !l.is_empty())
                        .collect::<Vec<_>>(),
                )
            } else {
                None
            }
        })
        .unwrap_or_default();

    let dirty = run_git(&cwd, &["status", "--porcelain"])
        .ok()
        .map(|(_, out, _)| !out.trim().is_empty())
        .unwrap_or(false);

    BranchInfo {
        is_repo: true,
        current,
        branches,
        dirty,
    }
}

#[tauri::command]
fn switch_branch(cwd: String, branch: String) -> Result<(), String> {
    let (ok, _, stderr) = run_git(&cwd, &["checkout", &branch]).map_err(|e| e.to_string())?;
    if ok {
        Ok(())
    } else {
        let msg = stderr.trim().to_string();
        Err(if msg.is_empty() { "git checkout failed".into() } else { msg })
    }
}

fn summarize_session(path: &std::path::Path) -> Option<SessionInfo> {
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let meta = fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let file = std::fs::File::open(path).ok()?;
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);

    let mut title = String::new();
    let mut first_user = String::new();
    let mut session_cwd = String::new();
    let mut message_count: usize = 0;
    let mut context_tokens: u64 = 0;
    let mut max_context_seen: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut total_cost: f64 = 0.0;
    let mut model = String::new();
    let mut permission_mode = String::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if session_cwd.is_empty() {
            if let Some(s) = v.get("cwd").and_then(|x| x.as_str()) {
                session_cwd = s.to_string();
            }
        }
        if let Some(pm) = v.get("permissionMode").and_then(|x| x.as_str()) {
            // The most-recent permissionMode wins so toggling mid-session
            // is preserved in the UI on resume.
            permission_mode = pm.to_string();
        }
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "custom-title" => {
                if let Some(s) = v.get("customTitle").and_then(|x| x.as_str()) {
                    title = s.to_string();
                }
            }
            "ai-title" => {
                if title.is_empty() {
                    if let Some(s) = v.get("title").and_then(|x| x.as_str()) {
                        title = s.to_string();
                    }
                }
            }
            "user" => {
                message_count += 1;
                if first_user.is_empty() {
                    if let Some(content_val) = v.pointer("/message/content") {
                        if let Some(s) = content_val.as_str() {
                            first_user = s.to_string();
                        } else if let Some(arr) = content_val.as_array() {
                            for block in arr {
                                if block.get("type").and_then(|x| x.as_str())
                                    == Some("text")
                                {
                                    if let Some(s) =
                                        block.get("text").and_then(|x| x.as_str())
                                    {
                                        first_user = s.to_string();
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "assistant" => {
                message_count += 1;
                if let Some(m) = v.pointer("/message/model").and_then(|x| x.as_str()) {
                    model = m.to_string();
                }
                if let Some(usage) = v.pointer("/message/usage") {
                    let input =
                        usage.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                    let cc = usage
                        .get("cache_creation_input_tokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0);
                    let cr = usage
                        .get("cache_read_input_tokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0);
                    let ot = usage
                        .get("output_tokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0);
                    // Latest turn's input is the current context fill.
                    let turn_input = input + cc + cr;
                    context_tokens = turn_input;
                    if turn_input > max_context_seen {
                        max_context_seen = turn_input;
                    }
                    output_tokens = output_tokens.saturating_add(ot);
                }
            }
            "result" => {
                if let Some(cost) = v.get("total_cost_usd").and_then(|x| x.as_f64()) {
                    total_cost = cost;
                }
            }
            _ => {}
        }
    }

    if title.is_empty() {
        title = first_user;
    }
    if title.is_empty() {
        title = id.clone();
    }
    let trimmed = title.trim().to_string();
    let truncated: String = if trimmed.chars().count() > 100 {
        let s: String = trimmed.chars().take(100).collect();
        format!("{}…", s)
    } else {
        trimmed
    };

    let context_limit = context_limit_for(&model, max_context_seen);

    Some(SessionInfo {
        id,
        title: truncated,
        cwd: session_cwd,
        mtime_ms,
        message_count,
        context_tokens,
        context_limit,
        total_cost_usd: total_cost,
        output_tokens,
        model,
        permission_mode,
    })
}

#[tauri::command]
fn list_sessions() -> Result<Vec<SessionInfo>, String> {
    let projects = match projects_dir() {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    if !projects.exists() {
        return Ok(vec![]);
    }
    let mut out: Vec<SessionInfo> = vec![];
    let dirs = fs::read_dir(&projects).map_err(|e| e.to_string())?;
    for dir_entry in dirs.flatten() {
        let dir_path = dir_entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&dir_path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for file_entry in files.flatten() {
            let path = file_entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(info) = summarize_session(&path) {
                out.push(info);
            }
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(out)
}

// Internal event types we never surface in the transcript.
const REPLAY_SKIP_TYPES: [&str; 6] = [
    "queue-operation",
    "last-prompt",
    "ai-title",
    "custom-title",
    "attachment",
    "system",
];

fn session_path(session_id: &str, cwd: &str) -> Option<PathBuf> {
    let encoded = encode_cwd(cwd);
    Some(
        projects_dir()?
            .join(encoded)
            .join(format!("{}.jsonl", session_id)),
    )
}

fn should_skip_line(line: &str) -> bool {
    // Cheap string prefilter: avoids a full JSON parse for internal types.
    // JSONL records always have `"type":"..."` as a top-level field, so this
    // substring check is a reliable first pass.
    for t in REPLAY_SKIP_TYPES {
        let needle = format!("\"type\":\"{}\"", t);
        if line.contains(&needle) {
            return true;
        }
    }
    false
}

#[tauri::command]
fn load_session(session_id: String, cwd: String) -> Result<Vec<serde_json::Value>, String> {
    let path = session_path(&session_id, &cwd)
        .ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        return Err("session file not found".to_string());
    }
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    let mut out: Vec<serde_json::Value> = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        if should_skip_line(&line) {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(t) = v.get("type").and_then(|x| x.as_str()) {
            if REPLAY_SKIP_TYPES.contains(&t) {
                continue;
            }
        }
        out.push(v);
    }
    Ok(out)
}

/// Faster path for the "open a session" click: returns the last `limit`
/// renderable events without parsing everything before them. Backward line
/// iteration + a substring prefilter keep this in the tens of ms even for
/// 10 MB session files.
#[tauri::command]
fn load_session_tail(
    session_id: String,
    cwd: String,
    limit: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let path = session_path(&session_id, &cwd)
        .ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        return Err("session file not found".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let cap = limit.max(1);
    let mut rev: Vec<serde_json::Value> = Vec::with_capacity(cap);
    for line in content.lines().rev() {
        if rev.len() >= cap {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        if should_skip_line(line) {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(t) = v.get("type").and_then(|x| x.as_str()) {
            if REPLAY_SKIP_TYPES.contains(&t) {
                continue;
            }
        }
        rev.push(v);
    }
    rev.reverse();
    Ok(rev)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_session,
            send_message,
            stop_session,
            interrupt_session,
            default_cwd,
            list_sessions,
            load_session,
            list_branches,
            switch_branch,
            preview_navigate,
            window_top_inset,
            load_session_tail,
            git_remote_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
