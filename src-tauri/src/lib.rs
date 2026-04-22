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
    session: Arc<Mutex<Option<Session>>>,
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
    cwd: String,
    permission_mode: Option<String>,
    model: Option<String>,
    resume_id: Option<String>,
) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    if let Some(mut s) = guard.take() {
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

    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", format!("{}:/usr/local/bin:/opt/homebrew/bin", path));
    }

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn claude: {}", e))?;
    let stdin = child.stdin.take().ok_or_else(|| "no stdin handle".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout handle".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr handle".to_string())?;

    let app_out = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit("claude-event", line);
        }
        let _ = app_out.emit("claude-done", ());
    });

    let app_err = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("claude-stderr", line);
        }
    });

    *guard = Some(Session { child, stdin });
    Ok(())
}

#[tauri::command]
async fn send_message(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or_else(|| "no active session".to_string())?;
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
async fn stop_session(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    if let Some(mut s) = guard.take() {
        let _ = s.child.start_kill();
    }
    Ok(())
}

#[tauri::command]
async fn interrupt_session(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.session.lock().await;
    if let Some(s) = guard.as_ref() {
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

#[tauri::command]
fn load_session(session_id: String, cwd: String) -> Result<Vec<String>, String> {
    let encoded = encode_cwd(&cwd);
    let path = projects_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));
    if !path.exists() {
        return Err("session file not found".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(content.lines().map(|s| s.to_string()).collect())
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
            switch_branch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
