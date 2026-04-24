use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

struct Session {
    child: Child,
    stdin: ChildStdin,
}

// Live PTY-backed terminal. The master writer is wrapped in a std Mutex
// because portable_pty's writer isn't Send+Sync-friendly for tokio's
// async Mutex, and we only ever touch it from blocking threads.
struct Terminal {
    writer: Arc<StdMutex<Box<dyn std::io::Write + Send>>>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct AppState {
    // Each panel gets its own claude subprocess, keyed by a frontend-supplied
    // panel_id. In single-panel mode the frontend uses the literal "main".
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    terminals: Arc<StdMutex<HashMap<String, Terminal>>>,
    // Session ownership: session_id -> panel_id that currently has a live
    // subprocess resuming it. Enforces one writer per session file so two
    // panels can't both append to the same JSONL and diverge.
    session_owners: Arc<Mutex<HashMap<String, String>>>,
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
    use_worktree: Option<bool>,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().await;
    if let Some(mut s) = guard.remove(&panel_id) {
        let _ = s.child.start_kill();
    }

    // Single-writer gate: if we're about to resume a session id, make sure
    // no other live panel is already attached to it. The prior subprocess
    // for this panel (killed above) held any ownership for this panel_id
    // so a restart-same-session on the same panel is still allowed.
    if let Some(rid) = resume_id.as_deref().filter(|s| !s.is_empty()) {
        let owners = state.session_owners.lock().await;
        if let Some(other) = owners.get(rid) {
            if other != &panel_id {
                return Err(format!(
                    "session {} is already open in panel {} — close it there first",
                    rid, other
                ));
            }
        }
    }

    let mode = permission_mode.unwrap_or_else(|| "bypassPermissions".to_string());

    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg("--input-format").arg("stream-json")
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--permission-mode").arg(&mode);

    // The CLI has a second security layer separate from --permission-mode:
    // a directory sandbox that limits which paths tools can touch. By
    // default that's just the cwd, which blocks cross-project access. We
    // extend it based on the caller's intent:
    //   - bypassPermissions: the user opted into "let claude do anything",
    //     so we pass `--add-dir /` to remove the dir sandbox entirely.
    //     Otherwise an "allow & retry" from a denial overlay wouldn't
    //     actually unblock system paths like /etc or /tmp.
    //   - any other mode: cover the whole home dir, which is where work
    //     typically lives.
    if mode == "bypassPermissions" {
        cmd.arg("--add-dir").arg("/");
    } else if let Some(home) =
        std::env::var_os("HOME").and_then(|h| h.into_string().ok())
    {
        cmd.arg("--add-dir").arg(home);
    }

    if let Some(m) = model.filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }

    let is_resume = resume_id.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    if let Some(rid) = resume_id.filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(rid);
    }

    // When the caller asks for an isolated worktree, delegate the
    // worktree creation to the claude CLI itself (it handles the
    // `git worktree add`, places the session inside the new dir, and
    // records the path in its own session metadata). Skipped on
    // --resume since the worktree was already created on first spawn,
    // and skipped silently if the cwd isn't a git repo (claude would
    // otherwise bail out and kill the session with a broken pipe).
    if use_worktree.unwrap_or(false) && !is_resume {
        let dot_git = std::path::Path::new(&cwd).join(".git");
        if dot_git.exists() {
            cmd.arg("--worktree");
        }
    }

    // Bail early with a clear error if the cwd doesn't exist — otherwise
    // spawn fails with a bare ENOENT that looks identical to the binary
    // not being found. Important not to silently swap in $HOME: for a
    // --resume, claude resolves the session file relative to the cwd's
    // project folder, so the wrong cwd would trigger error_during_execution
    // far from the actual source of the problem.
    if cwd.is_empty() || !std::path::Path::new(&cwd).is_dir() {
        return Err(format!(
            "project directory doesn't exist: {} — pick a new cwd or remove this session",
            if cwd.is_empty() { "(none)" } else { cwd.as_str() }
        ));
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
    let owners_out = state.session_owners.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut claimed: Option<String> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            // Claim ownership of the session id on the first init event
            // that carries one. Cheap substring check before a full JSON
            // parse — session_id only appears on a handful of event types.
            if claimed.is_none() && line.contains("\"session_id\"") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(sid) =
                        v.get("session_id").and_then(|x| x.as_str())
                    {
                        let mut owners = owners_out.lock().await;
                        owners.insert(sid.to_string(), pid_out.clone());
                        claimed = Some(sid.to_string());
                    }
                }
            }
            let _ = app_out.emit(
                "claude-event",
                serde_json::json!({ "panel_id": pid_out, "line": line }),
            );
        }
        // Release ownership once the subprocess's stdout closes (claude
        // has exited). If another panel had already stolen the claim,
        // only drop it if it still points at us.
        if let Some(sid) = claimed {
            let mut owners = owners_out.lock().await;
            if owners.get(&sid).map(|p| p == &pid_out).unwrap_or(false) {
                owners.remove(&sid);
            }
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

/// Writes an arbitrary JSON line to the panel's subprocess stdin. Used
/// for control_response (answering Claude's permission prompts) and for
/// control_request (e.g. mid-session set_permission_mode changes).
#[tauri::command]
async fn send_raw(
    state: State<'_, AppState>,
    panel_id: String,
    line: String,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().await;
    let session = guard
        .get_mut(&panel_id)
        .ok_or_else(|| format!("no active session for panel {}", panel_id))?;
    let body = if line.ends_with('\n') {
        line
    } else {
        format!("{}\n", line)
    };
    session
        .stdin
        .write_all(body.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    session.stdin.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

// Writes arbitrary UTF-8 text to the given path. Used by the
// "export session as markdown" action so we don't have to pull in
// plugin-fs just for one write.
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("write failed: {}", e))
}

// Saves bytes from a web-drop — an in-browser File blob that the OS
// never handed us a native filesystem path for (screenshots from a
// menu bar app, images dragged from a webpage, etc.) — into a temp
// file and returns its full path. The caller then attaches the path
// to the chat message the same way a real filesystem drop does.
#[tauri::command]
fn save_dropped_file(name: String, bytes: Vec<u8>) -> Result<String, String> {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};
    let safe_name: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let fallback = if safe_name.trim().is_empty() {
        "dropped.bin".to_string()
    } else {
        safe_name
    };
    // Short time-based prefix so the same name dropped twice doesn't
    // clobber the first copy.
    let prefix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join("blackcrab-drops");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir temp: {}", e))?;
    let path = dir.join(format!("{:x}-{}", prefix, fallback));
    let mut file = std::fs::File::create(&path).map_err(|e| format!("create: {}", e))?;
    file.write_all(&bytes).map_err(|e| format!("write: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn terminal_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    terminal_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    // If this id already exists, kill the old one first so the
    // frontend can hot-reload without leaking subprocesses.
    {
        let mut terms = state.terminals.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = terms.remove(&terminal_id) {
            let _ = old.child.kill();
        }
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {}", e))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = CommandBuilder::new(&shell);
    // Interactive login-ish shell so the user's PATH/aliases load.
    cmd.arg("-l");
    let effective_cwd = if !cwd.is_empty() && std::path::Path::new(&cwd).is_dir() {
        cwd
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/".into())
    };
    cmd.cwd(&effective_cwd);
    // Encourage color + dumb-terminal-friendly output from most CLIs.
    cmd.env("TERM", "xterm-256color");
    if let Ok(lang) = std::env::var("LANG") {
        cmd.env("LANG", lang);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {}", e))?;

    // Detach the slave end so it can be closed by the child; we only
    // hold the master side for IO.
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {}", e))?;

    // Spawn a blocking reader thread that forwards bytes as `terminal-output`
    // events to the frontend.
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {}", e))?;
    let id_for_thread = terminal_id.clone();
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_for_thread.emit(
                        "terminal-output",
                        serde_json::json!({
                            "terminal_id": id_for_thread,
                            "data": chunk,
                        }),
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit(
            "terminal-exit",
            serde_json::json!({ "terminal_id": id_for_thread }),
        );
    });

    let mut terms = state.terminals.lock().map_err(|e| e.to_string())?;
    terms.insert(
        terminal_id,
        Terminal {
            writer: Arc::new(StdMutex::new(writer)),
            master: pair.master,
            child,
        },
    );
    Ok(())
}

#[tauri::command]
fn terminal_write(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let terms = state.terminals.lock().map_err(|e| e.to_string())?;
    let term = terms
        .get(&terminal_id)
        .ok_or_else(|| format!("no terminal {}", terminal_id))?;
    let mut writer = term.writer.lock().map_err(|e| e.to_string())?;
    use std::io::Write;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {}", e))?;
    writer.flush().ok();
    Ok(())
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    use portable_pty::PtySize;
    let terms = state.terminals.lock().map_err(|e| e.to_string())?;
    let term = terms
        .get(&terminal_id)
        .ok_or_else(|| format!("no terminal {}", terminal_id))?;
    term.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {}", e))?;
    Ok(())
}

#[tauri::command]
fn terminal_kill(state: State<'_, AppState>, terminal_id: String) -> Result<(), String> {
    let mut terms = state.terminals.lock().map_err(|e| e.to_string())?;
    if let Some(mut t) = terms.remove(&terminal_id) {
        let _ = t.child.kill();
    }
    Ok(())
}

// List tracked (and new, non-ignored) files under `cwd` via
// `git ls-files`. Empty vec when the dir isn't a git repo — the UI
// just shows no suggestions in that case.
#[tauri::command]
fn list_tracked_files(cwd: String) -> Result<Vec<String>, String> {
    if cwd.is_empty() || !std::path::Path::new(&cwd).is_dir() {
        return Ok(Vec::new());
    }
    use std::process::Command as StdCommand;
    let output = StdCommand::new("git")
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "--full-name",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("git ls-files failed: {}", e))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut paths: Vec<String> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    // Dedup in case ls-files returns duplicates for some reason, keep
    // stable ordering (git already orders by path lexicographically).
    paths.dedup();
    Ok(paths)
}

#[tauri::command]
async fn stop_session(state: State<'_, AppState>, panel_id: String) -> Result<(), String> {
    let mut guard = state.sessions.lock().await;
    if let Some(mut s) = guard.remove(&panel_id) {
        let _ = s.child.start_kill();
    }
    // The stdout-reader's own cleanup already drops ownership once
    // claude's stdout closes, but killing via start_kill races that
    // close so we release eagerly here too to unblock the next
    // start_session for the same sid.
    let mut owners = state.session_owners.lock().await;
    owners.retain(|_, owner| owner != &panel_id);
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
    // Authoritative contextWindow reported by the CLI in each result
    // event's `modelUsage` map. Indexed by model name so we can pick
    // the main model's window at the end — sub-agents like Haiku have
    // their own (smaller) window that shouldn't dominate the bar.
    let mut context_window_by_model: std::collections::HashMap<String, u64> =
        std::collections::HashMap::new();

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
                if let Some(usage) =
                    v.get("modelUsage").and_then(|x| x.as_object())
                {
                    for (model_name, info) in usage {
                        if let Some(cw) = info
                            .get("contextWindow")
                            .and_then(|x| x.as_u64())
                        {
                            if cw > 0 {
                                let entry = context_window_by_model
                                    .entry(model_name.clone())
                                    .or_insert(0);
                                if cw > *entry {
                                    *entry = cw;
                                }
                            }
                        }
                    }
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

    // Prefer the CLI's own contextWindow report for the main model.
    // Fall back to the max window reported across any model used in
    // the session (covers older sessions that never recorded the
    // main model's usage). Only if neither is available do we drop
    // back to the model-name heuristic.
    let context_limit = context_window_by_model
        .get(&model)
        .copied()
        .or_else(|| context_window_by_model.values().max().copied())
        .filter(|&cw| cw > 0)
        .unwrap_or_else(|| context_limit_for(&model, max_context_seen));

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

#[derive(serde::Serialize)]
struct SessionSearchHit {
    session_id: String,
    match_count: u32,
    preview: String,
}

// Greps every session JSONL for `query` and returns the sessions
// that matched (plus a short preview of the first match). Case-
// insensitive substring match against user and assistant text
// content. Bounded pretty loosely — we return up to 200 hits.
#[tauri::command]
fn search_sessions(query: String) -> Result<Vec<SessionSearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 {
        return Ok(Vec::new());
    }
    let projects = match projects_dir() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    if !projects.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<SessionSearchHit> = Vec::new();
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
            if let Some(hit) = search_in_session(&path, &needle) {
                out.push(hit);
                if out.len() >= 200 {
                    return Ok(out);
                }
            }
        }
    }
    // Sort by match_count desc so the most relevant sessions float up.
    out.sort_by(|a, b| b.match_count.cmp(&a.match_count));
    Ok(out)
}

fn search_in_session(path: &std::path::Path, needle: &str) -> Option<SessionSearchHit> {
    let session_id = path.file_stem()?.to_string_lossy().to_string();
    let file = std::fs::File::open(path).ok()?;
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    let mut match_count: u32 = 0;
    let mut preview = String::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t != "user" && t != "assistant" {
            continue;
        }
        let texts = collect_text(v.pointer("/message/content"));
        for snippet in texts {
            let haystack = snippet.to_lowercase();
            if let Some(pos) = haystack.find(needle) {
                match_count += 1;
                if preview.is_empty() {
                    let start = pos.saturating_sub(40);
                    let end = (pos + needle.len() + 80).min(snippet.len());
                    preview = snippet
                        .get(start..end)
                        .unwrap_or(&snippet[..snippet.len().min(120)])
                        .replace('\n', " ")
                        .trim()
                        .to_string();
                }
            }
        }
    }
    if match_count == 0 {
        return None;
    }
    Some(SessionSearchHit {
        session_id,
        match_count,
        preview,
    })
}

fn collect_text(content: Option<&serde_json::Value>) -> Vec<String> {
    let Some(v) = content else { return Vec::new() };
    if let Some(s) = v.as_str() {
        return vec![s.to_string()];
    }
    let Some(arr) = v.as_array() else { return Vec::new() };
    let mut out = Vec::new();
    for block in arr {
        let t = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t == "text" {
            if let Some(s) = block.get("text").and_then(|x| x.as_str()) {
                out.push(s.to_string());
            }
        } else if t == "tool_result" {
            if let Some(s) = block.get("content").and_then(|x| x.as_str()) {
                out.push(s.to_string());
            } else if let Some(inner) = block.get("content").and_then(|x| x.as_array()) {
                for ib in inner {
                    if let Some(s) = ib.get("text").and_then(|x| x.as_str()) {
                        out.push(s.to_string());
                    }
                }
            }
        }
    }
    out
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
fn set_session_title(session_id: String, cwd: String, title: String) -> Result<(), String> {
    use std::io::Write;
    let path = session_path(&session_id, &cwd)
        .ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        return Err("session file not found".to_string());
    }
    let trimmed = title.trim();
    // summarize_session takes the most recent custom-title record, so appending
    // is enough — no need to rewrite prior lines.
    let record = serde_json::json!({
        "type": "custom-title",
        "customTitle": trimmed,
        "timestamp": chrono_now_iso(),
    });
    let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line).map_err(|e| e.to_string())?;
    Ok(())
}

/// Move a session's JSONL into a sibling `.trash/` so it disappears
/// from the sidebar but stays recoverable. Refuses if the session is
/// currently owned by a live panel — the user should close that panel
/// first so the subprocess isn't writing to a moved file.
#[tauri::command]
async fn delete_session(
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
) -> Result<(), String> {
    {
        let owners = state.session_owners.lock().await;
        if let Some(owner) = owners.get(&session_id) {
            return Err(format!(
                "session is still open in panel {} — close it first",
                owner
            ));
        }
    }
    let path = session_path(&session_id, &cwd)
        .ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        return Err("session file not found".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "session file has no parent dir".to_string())?;
    let trash = parent.join(".trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let stamp = chrono_now_iso().replace(':', "-").replace('.', "-");
    let base = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("{}.jsonl", session_id));
    let target = trash.join(format!("{}.{}", base, stamp));
    fs::rename(&path, &target).map_err(|e| e.to_string())?;
    Ok(())
}

fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // Simple RFC3339-ish UTC stamp without pulling in chrono.
    let secs = d.as_secs();
    let millis = d.subsec_millis();
    let (y, mo, da, h, mi, se) = epoch_to_ymdhms(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, mo, da, h, mi, se, millis
    )
}

fn epoch_to_ymdhms(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86400) as i64;
    let rem = (secs % 86400) as u32;
    let h = rem / 3600;
    let mi = (rem % 3600) / 60;
    let se = rem % 60;
    // Civil-from-days algorithm (Howard Hinnant).
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d, h, mi, se)
}

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
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_session,
            send_message,
            send_raw,
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
            git_remote_url,
            set_session_title,
            delete_session,
            write_text_file,
            save_dropped_file,
            list_tracked_files,
            search_sessions,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
