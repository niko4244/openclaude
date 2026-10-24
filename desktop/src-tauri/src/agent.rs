//! Coding workspace adapter: drives the existing OpenClaude CLI agent in
//! headless stream-json mode instead of re-implementing a second agent runtime.
//! Inference goes through the same LiteLLM gateway as chat.

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CodeEvent {
    /// One stream-json record from the CLI, passed through verbatim.
    Agent { record: Value },
    /// The CLI asked permission to run a tool (`can_use_tool` control request).
    /// Answer with `CodeSessions::respond`.
    Approval { request_id: String, tool: String, input: Value },
    Stderr { line: String },
    Exited { code: Option<i32> },
}

pub struct CodeSession {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    /// request_id -> original tool input of approvals still awaiting an answer
    /// (an `allow` must echo the input back as `updatedInput`).
    pending: Mutex<HashMap<String, Value>>,
}

#[derive(Default)]
pub struct CodeSessions {
    pub map: Mutex<HashMap<String, Arc<CodeSession>>>,
    /// One-shot shell commands typed by the user in the Code tab.
    cmds: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CmdEvent {
    Out { line: String },
    Err { line: String },
    Exited { code: Option<i32> },
}

/// The user's own command, run in the granted workspace with no window.
pub fn shell_command(cwd: &Path, command: &str) -> Command {
    #[cfg(windows)]
    let mut c = {
        let mut c = Command::new("powershell.exe");
        c.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]);
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    c.current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    c
}

/// Modes in which the CLI asks (instead of silently denying) and so need the stdio prompt tool.
fn asks_for_approval(mode: &str) -> bool {
    matches!(mode, "default" | "acceptEdits")
}

/// `(request_id, tool_name, input)` of a `can_use_tool` control request record.
pub fn parse_approval(rec: &Value) -> Option<(String, String, Value)> {
    if rec.get("type")?.as_str()? != "control_request" {
        return None;
    }
    let req = rec.get("request")?;
    if req.get("subtype")?.as_str()? != "can_use_tool" {
        return None;
    }
    Some((
        rec.get("request_id")?.as_str()?.to_string(),
        req.get("tool_name")?.as_str()?.to_string(),
        req.get("input").cloned().unwrap_or_else(|| json!({})),
    ))
}

/// The exact stdin line the CLI expects: a `control_response` success wrapping a
/// PermissionPromptToolResult (`{behavior:"allow",updatedInput}` / `{behavior:"deny",message}`).
pub fn control_response_line(request_id: &str, allow: bool, updated_input: Value, message: Option<String>) -> String {
    let result = if allow {
        json!({"behavior": "allow", "updatedInput": updated_input})
    } else {
        json!({"behavior": "deny", "message": message.unwrap_or_else(|| "The user denied this action.".into())})
    };
    format!(
        "{}\n",
        json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": result}})
    )
}

pub const PERMISSION_MODES: &[&str] = &["plan", "default", "acceptEdits", "bypassPermissions"];

/// Find the OpenClaude CLI entry point (setting > env > known install locations).
pub fn locate_cli(setting: Option<String>) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = vec![];
    if let Some(s) = setting.filter(|s| !s.trim().is_empty()) {
        cands.push(s.into());
    }
    if let Ok(s) = std::env::var("OPENCLAUDE_BIN") {
        cands.push(s.into());
    }
    if let Some(home) = dirs::home_dir() {
        cands.push(home.join("Desktop/openclaude/dist/cli.mjs"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        cands.push(Path::new(&appdata).join("npm/node_modules/@gitlawb/openclaude/dist/cli.mjs"));
    }
    cands.into_iter().find(|p| p.is_file())
}

pub struct StartArgs<'a> {
    pub cli: &'a Path,
    pub cwd: &'a Path,
    pub model: &'a str,
    pub permission_mode: &'a str,
    /// OpenAI-compatible base URL including its version path (gateway `/v1` or a provider's base).
    pub openai_base: &'a str,
    pub api_key: Option<&'a str>,
    /// Enabled plugins, loaded by the CLI itself (all hook types run there).
    pub plugin_dirs: &'a [PathBuf],
}

pub fn build_command(a: &StartArgs) -> Command {
    let mut c = Command::new("node");
    c.arg(a.cli)
        .args(["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json"])
        .args(["--provider", "openai", "--model", a.model])
        .args(["--permission-mode", a.permission_mode]);
    if asks_for_approval(a.permission_mode) {
        c.args(["--permission-prompt-tool", "stdio"]);
    }
    for d in a.plugin_dirs {
        c.arg("--plugin-dir").arg(d);
    }
    c.current_dir(a.cwd)
        .env("CLAUDE_CODE_USE_OPENAI", "1")
        .env("OPENAI_BASE_URL", a.openai_base.trim_end_matches('/'))
        .env("OPENAI_MODEL", a.model)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(k) = a.api_key {
        c.env("OPENAI_API_KEY", k);
    }
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c
}

impl CodeSessions {
    pub async fn start(&self, id: String, a: StartArgs<'_>, ch: Channel<CodeEvent>) -> anyhow::Result<()> {
        if !PERMISSION_MODES.contains(&a.permission_mode) {
            anyhow::bail!("unknown permission mode");
        }
        let mut child = build_command(&a).spawn().map_err(|e| anyhow::anyhow!("failed to start node: {e}"))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let session = Arc::new(CodeSession { stdin: Mutex::new(stdin), child: Mutex::new(child), pending: Mutex::new(HashMap::new()) });
        self.map.lock().await.insert(id.clone(), session.clone());

        let ch2 = ch.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch2.send(CodeEvent::Stderr { line });
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<Value>(&line) {
                    Ok(record) => {
                        if let Some((request_id, tool, input)) = parse_approval(&record) {
                            session.pending.lock().await.insert(request_id.clone(), input.clone());
                            let _ = ch.send(CodeEvent::Approval { request_id, tool, input });
                        } else {
                            let _ = ch.send(CodeEvent::Agent { record });
                        }
                    }
                    Err(_) => {
                        let _ = ch.send(CodeEvent::Stderr { line });
                    }
                }
            }
            let code = session.child.lock().await.wait().await.ok().and_then(|s| s.code());
            let _ = ch.send(CodeEvent::Exited { code });
        });
        Ok(())
    }

    pub async fn send(&self, id: &str, text: &str) -> anyhow::Result<()> {
        let s = self.map.lock().await.get(id).cloned().ok_or_else(|| anyhow::anyhow!("session not running"))?;
        let msg = json!({"type": "user", "message": {"role": "user", "content": text}});
        let mut w = s.stdin.lock().await;
        w.write_all(format!("{msg}\n").as_bytes()).await?;
        w.flush().await?;
        Ok(())
    }

    /// Answer a pending approval. `allow` with no `updated_input` echoes the original tool input.
    pub async fn respond(&self, id: &str, request_id: &str, allow: bool, updated_input: Option<Value>, message: Option<String>) -> anyhow::Result<()> {
        let s = self.map.lock().await.get(id).cloned().ok_or_else(|| anyhow::anyhow!("session not running"))?;
        let original = s.pending.lock().await.remove(request_id).ok_or_else(|| anyhow::anyhow!("no pending approval {request_id}"))?;
        let line = control_response_line(request_id, allow, updated_input.unwrap_or(original), message);
        let mut w = s.stdin.lock().await;
        w.write_all(line.as_bytes()).await?;
        w.flush().await?;
        Ok(())
    }

    pub async fn run_command(&self, id: String, cwd: &Path, command: &str, ch: Channel<CmdEvent>) -> anyhow::Result<()> {
        let mut child = shell_command(cwd, command).spawn()?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        self.cmds.lock().await.insert(id, child.clone());
        let ch2 = ch.clone();
        let err_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch2.send(CmdEvent::Err { line });
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch.send(CmdEvent::Out { line });
            }
            let _ = err_task.await;
            let code = child.lock().await.wait().await.ok().and_then(|s| s.code());
            let _ = ch.send(CmdEvent::Exited { code });
        });
        Ok(())
    }

    pub async fn stop(&self, id: &str) {
        if let Some(s) = self.map.lock().await.remove(id) {
            let _ = s.child.lock().await.kill().await;
        }
        if let Some(c) = self.cmds.lock().await.remove(id) {
            let _ = c.lock().await.kill().await;
        }
    }

    pub async fn stop_all(&self) {
        let cmd_ids: Vec<String> = self.cmds.lock().await.keys().cloned().collect();
        for id in cmd_ids {
            self.stop(&id).await;
        }
        let ids: Vec<String> = self.map.lock().await.keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }
}

/// Result of a non-interactive agent run (background tasks).
#[derive(Debug, Default)]
pub struct HeadlessOutcome {
    pub result: String,
    pub is_error: bool,
    /// Tools the agent used, in order (e.g. "Write hello.txt").
    pub actions: Vec<String>,
    /// Requests that needed interactive approval and were denied.
    pub denied: Vec<String>,
}

fn describe_tool(name: &str, input: &Value) -> String {
    let arg = ["file_path", "path", "command", "pattern", "url"]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .unwrap_or("");
    let arg: String = arg.chars().take(120).collect();
    if arg.is_empty() { name.to_string() } else { format!("{name} {arg}") }
}

/// Background approval policy: only edit tools writing inside `root` are allowed.
/// (The CLI's acceptEdits mode would also auto-run mkdir/rm/redirects, so it is not used.)
pub fn allow_in_folder(root: &Path, tool: &str, input: &Value) -> bool {
    if !matches!(tool, "Write" | "Edit" | "MultiEdit" | "NotebookEdit") {
        return false;
    }
    let Some(p) = ["file_path", "notebook_path"].iter().find_map(|k| input.get(*k).and_then(Value::as_str)) else { return false };
    let p = Path::new(p);
    let abs = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    // Normalize without requiring the file to exist: resolve the parent, reject `..` escapes.
    if abs.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    let (Ok(root), Some(parent)) = (root.canonicalize(), abs.parent()) else { return false };
    parent.canonicalize().map(|pp| pp.starts_with(&root)).unwrap_or(false)
}

/// Run one prompt to completion without a UI. Approval requests are decided by `allow`
/// (nobody is there to answer); denied ones are recorded.
pub async fn run_headless(a: StartArgs<'_>, prompt: &str, limit: std::time::Duration, allow: impl Fn(&str, &Value) -> bool) -> anyhow::Result<HeadlessOutcome> {
    let mut child = build_command(&a).spawn().map_err(|e| anyhow::anyhow!("failed to start node: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let msg = json!({"type": "user", "message": {"role": "user", "content": prompt}});
    stdin.write_all(format!("{msg}\n").as_bytes()).await?;
    stdin.flush().await?;
    let mut out = HeadlessOutcome::default();
    let run = async {
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            let Ok(rec) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some((request_id, tool, input)) = parse_approval(&rec) {
                let ok = allow(&tool, &input);
                if !ok {
                    out.denied.push(describe_tool(&tool, &input));
                }
                let msg = (!ok).then(|| "Not available in a background task: only file edits inside the task folder are allowed.".to_string());
                let reply = control_response_line(&request_id, ok, input, msg);
                stdin.write_all(reply.as_bytes()).await?;
                stdin.flush().await?;
                continue;
            }
            match rec["type"].as_str() {
                Some("assistant") => {
                    for b in rec.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                        if b["type"] == "tool_use" {
                            out.actions.push(describe_tool(b["name"].as_str().unwrap_or("tool"), &b["input"]));
                        }
                    }
                }
                Some("result") => {
                    out.result = rec["result"].as_str().unwrap_or_default().to_string();
                    out.is_error = rec["is_error"].as_bool().unwrap_or(false);
                    break;
                }
                _ => {}
            }
        }
        anyhow::Ok(())
    };
    let timed_out = tokio::time::timeout(limit, run).await.is_err();
    let _ = child.kill().await;
    if timed_out {
        anyhow::bail!("agent did not finish within {} min", limit.as_secs() / 60);
    }
    Ok(out)
}

#[derive(Serialize, Default)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub files: Vec<(String, String)>,
    pub error: Option<String>,
}

async fn git(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    let mut c = Command::new("git");
    c.args(args).current_dir(cwd);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    let out = c.output().await?;
    if !out.status.success() {
        anyhow::bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Read-only: branch + porcelain status.
pub async fn git_status(cwd: &Path) -> GitStatus {
    match git(cwd, &["status", "--porcelain=v1", "-b"]).await {
        Err(e) => GitStatus { error: Some(e.to_string()), ..Default::default() },
        Ok(s) => {
            let mut st = GitStatus { is_repo: true, ..Default::default() };
            for line in s.lines() {
                if let Some(b) = line.strip_prefix("## ") {
                    st.branch = Some(b.split("...").next().unwrap_or(b).to_string());
                } else if line.len() > 3 {
                    st.files.push((line[..2].trim().to_string(), line[3..].to_string()));
                }
            }
            st
        }
    }
}

/// Read-only unified diff for one path (or the whole tree when `path` is None).
pub async fn git_diff(cwd: &Path, path: Option<&str>) -> anyhow::Result<String> {
    let mut args = vec!["diff", "--no-color", "HEAD", "--"];
    if let Some(p) = path {
        if p.starts_with('-') || Path::new(p).is_absolute() || p.contains("..") {
            anyhow::bail!("invalid path");
        }
        args.push(p);
    }
    let d = git(cwd, &args).await?;
    Ok(if d.len() > 400_000 { format!("{}\n…[diff truncated]", &d[..d.floor_char_boundary(400_000)]) } else { d })
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
}

fn norm_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).trim_end_matches('/').to_string();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn same_path(a: &Path, b: &Path) -> bool {
    norm_path(a) == norm_path(b)
        || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if norm_path(&x) == norm_path(&y))
}

fn parse_worktrees(porcelain: &str) -> Vec<Worktree> {
    let mut out = Vec::new();
    for block in porcelain.split("\n\n") {
        let mut w = Worktree { path: String::new(), branch: None, head: String::new() };
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                w.path = p.trim_end_matches('\r').to_string();
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                w.head = h.trim().to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                w.branch = Some(b.trim().strip_prefix("refs/heads/").unwrap_or(b.trim()).to_string());
            }
        }
        if !w.path.is_empty() {
            out.push(w);
        }
    }
    out
}

/// All worktrees of the repo; the first entry is the main worktree.
pub async fn worktrees(repo: &Path) -> anyhow::Result<Vec<Worktree>> {
    Ok(parse_worktrees(&git(repo, &["worktree", "list", "--porcelain"]).await?))
}

/// Create a worktree for `branch` (new branch, or the existing one) at `<main>-wt/<branch with / -> ->`.
pub async fn worktree_add(repo: &Path, branch: &str) -> anyhow::Result<PathBuf> {
    let b = branch.trim();
    if b.is_empty() || b.starts_with('-') || b.starts_with('@') || b.contains("@{") {
        anyhow::bail!("invalid branch name");
    }
    git(repo, &["check-ref-format", "--branch", b]).await.map_err(|_| anyhow::anyhow!("invalid branch name: {b}"))?;
    let main = worktrees(repo).await?.into_iter().next().ok_or_else(|| anyhow::anyhow!("not a git repository"))?;
    let main = PathBuf::from(main.path);
    let name = main.file_name().ok_or_else(|| anyhow::anyhow!("bad repo path"))?.to_string_lossy().to_string();
    let dir = main.parent().ok_or_else(|| anyhow::anyhow!("bad repo path"))?.join(format!("{name}-wt")).join(b.replace('/', "-"));
    if dir.exists() {
        anyhow::bail!("{} already exists", dir.display());
    }
    tokio::fs::create_dir_all(dir.parent().unwrap()).await?;
    let p = dir.to_string_lossy().to_string();
    let exists = git(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{b}")]).await.is_ok();
    if exists {
        git(repo, &["worktree", "add", &p, b]).await?;
    } else {
        git(repo, &["worktree", "add", "-b", b, &p]).await?;
    }
    Ok(dir)
}

/// Remove a linked worktree (never the main one, never an unknown path). No --force: git refuses if dirty.
pub async fn worktree_remove(repo: &Path, path: &Path) -> anyhow::Result<()> {
    let wts = worktrees(repo).await?;
    let target = wts.iter().skip(1).find(|w| same_path(Path::new(&w.path), path)).ok_or_else(|| anyhow::anyhow!("not a linked worktree of this repository"))?;
    git(repo, &["worktree", "remove", &target.path]).await?;
    Ok(())
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
        } else if it.peek() == Some(&'[') {
            it.next();
            for d in it.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&d) {
                    break;
                }
            }
        }
    }
    out
}

/// Only http(s) on localhost / 127.0.0.1 / ::1 with an explicit port, no credentials.
pub fn is_local_preview_url(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    if !matches!(u.scheme(), "http" | "https") || u.port().is_none() || !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    match u.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    }
}

/// First local dev-server URL in a line of output (Vite / Next / CRA style), ANSI stripped.
pub fn detect_dev_url(line: &str) -> Option<String> {
    let clean = strip_ansi(line);
    let mut rest = clean.as_str();
    while let Some(i) = rest.find("http") {
        let cand = &rest[i..];
        if cand.starts_with("http://") || cand.starts_with("https://") {
            let end = cand.find(|c: char| c.is_whitespace() || "\"'<>)\\`".contains(c)).unwrap_or(cand.len());
            let url = cand[..end].trim_end_matches(['.', ',', ';', ':']);
            if is_local_preview_url(url) {
                return Some(url.to_string());
            }
        }
        rest = &rest[i + 4..];
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real CLI in a temp repo: the edit is allowed, the shell command is denied (background rules).
    #[tokio::test]
    #[ignore = "runs the real OpenClaude CLI against the live gateway"]
    async fn live_headless_allows_edits_and_denies_commands() {
        let key = std::env::var("OPENCLAUDE_LITELLM_KEY").expect("OPENCLAUDE_LITELLM_KEY");
        let cli = locate_cli(None).expect("OpenClaude CLI");
        // Outside %LOCALAPPDATA% (the CLI treats AppData paths as protected).
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
        let dir = tempfile::tempdir_in(base).unwrap();
        std::process::Command::new("git").args(["init", "-q"]).current_dir(dir.path()).status().unwrap();
        let out = run_headless(
            StartArgs { cli: &cli, cwd: dir.path(), model: "coder-local", permission_mode: "default", openai_base: "http://127.0.0.1:4000/v1", api_key: Some(&key), plugin_dirs: &[] },
            "Use the Write tool to create notes.txt containing the word ready. Then run the shell command `mkdir made_by_shell`. Then stop.",
            std::time::Duration::from_secs(300),
            |t, i| allow_in_folder(dir.path(), t, i),
        )
        .await
        .unwrap();
        println!("{out:?}");
        assert!(dir.path().join("notes.txt").is_file(), "edit inside the folder allowed: {out:?}");
        assert!(!out.denied.is_empty(), "the mkdir request was denied: {out:?}");
        // The model may fall back to writing a *file* of that name (an allowed in-folder edit),
        // but the shell `mkdir` itself must never have run.
        assert!(!dir.path().join("made_by_shell").is_dir(), "mutating command must not run: {out:?}");
        assert!(out.denied.iter().any(|d| d.starts_with("Bash mkdir")), "mkdir was denied: {out:?}");
    }

    #[test]
    fn folder_policy_allows_only_edit_tools_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let inside = dir.path().join("sub").join("a.txt").to_string_lossy().to_string();
        assert!(allow_in_folder(dir.path(), "Write", &json!({"file_path": inside})));
        assert!(allow_in_folder(dir.path(), "Edit", &json!({"file_path": "sub/a.txt"})));
        assert!(!allow_in_folder(dir.path(), "Bash", &json!({"command": "mkdir x"})));
        assert!(!allow_in_folder(dir.path(), "Write", &json!({"file_path": "../escape.txt"})));
        let outside = std::env::temp_dir().join("oc-outside.txt").to_string_lossy().to_string();
        assert!(!allow_in_folder(&dir.path().join("sub"), "Write", &json!({"file_path": outside})));
        assert!(!allow_in_folder(dir.path(), "Write", &json!({})));
    }

    #[test]
    fn command_routes_through_gateway_and_never_skips_permissions() {
        let a = StartArgs {
            cli: Path::new("cli.mjs"),
            cwd: Path::new("."),
            model: "coder-local",
            permission_mode: "acceptEdits",
            openai_base: "http://127.0.0.1:4000/v1/",
            api_key: Some("k"),
            plugin_dirs: &[PathBuf::from("p1"), PathBuf::from("p2")],
        };
        let c = build_command(&a);
        let std = c.as_std();
        let args: Vec<String> = std.get_args().map(|s| s.to_string_lossy().into()).collect();
        assert!(args.windows(2).any(|w| w == ["--model", "coder-local"]));
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]));
        assert!(!args.iter().any(|a| a.contains("dangerously")));
        assert!(args.windows(2).any(|w| w == ["--permission-prompt-tool", "stdio"]));
        assert_eq!(args.windows(2).filter(|w| w[0] == "--plugin-dir").map(|w| w[1].clone()).collect::<Vec<_>>(), ["p1", "p2"]);
        let env: HashMap<String, String> = std
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into(), v?.to_string_lossy().into())))
            .collect();
        assert_eq!(env["OPENAI_BASE_URL"], "http://127.0.0.1:4000/v1");
    }

    fn args_for(mode: &str) -> Vec<String> {
        let a = StartArgs { cli: Path::new("cli.mjs"), cwd: Path::new("."), model: "m", permission_mode: mode, openai_base: "http://x/v1", api_key: None, plugin_dirs: &[] };
        build_command(&a).as_std().get_args().map(|s| s.to_string_lossy().into()).collect()
    }

    #[test]
    fn prompt_tool_only_in_asking_modes() {
        for (mode, want) in [("default", true), ("acceptEdits", true), ("plan", false), ("bypassPermissions", false)] {
            assert_eq!(args_for(mode).iter().any(|a| a == "--permission-prompt-tool"), want, "{mode}");
        }
    }

    #[test]
    fn parses_can_use_tool_and_ignores_other_records() {
        let rec = json!({"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"hello.txt","content":"hi"},"tool_use_id":"t1"}});
        assert_eq!(parse_approval(&rec), Some(("r1".into(), "Write".into(), json!({"file_path":"hello.txt","content":"hi"}))));
        assert_eq!(parse_approval(&json!({"type":"control_request","request_id":"r","request":{"subtype":"hook_callback"}})), None);
        assert_eq!(parse_approval(&json!({"type":"assistant","message":{}})), None);
        assert_eq!(parse_approval(&json!({"type":"control_cancel_request","request_id":"r1"})), None);
    }

    #[test]
    fn control_response_matches_cli_schema() {
        let allow: Value = serde_json::from_str(control_response_line("r1", true, json!({"command":"ls"}), None).trim_end()).unwrap();
        assert_eq!(allow, json!({"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"behavior":"allow","updatedInput":{"command":"ls"}}}}));
        let line = control_response_line("r2", false, json!({}), Some("nope".into()));
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1);
        let deny: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(deny, json!({"type":"control_response","response":{"subtype":"success","request_id":"r2","response":{"behavior":"deny","message":"nope"}}}));
        let dflt: Value = serde_json::from_str(control_response_line("r3", false, json!({}), None).trim_end()).unwrap();
        assert_eq!(dflt["response"]["response"]["behavior"], "deny");
        assert!(dflt["response"]["response"]["message"].as_str().is_some_and(|m| !m.is_empty()));
    }

    /// Live: real CLI + LiteLLM gateway. Needs OPENCLAUDE_LITELLM_KEY (gateway at 127.0.0.1:4000).
    #[tokio::test]
    #[ignore]
    async fn live_cli_asks_then_writes_file_on_allow() {
        let key = std::env::var("OPENCLAUDE_LITELLM_KEY").expect("OPENCLAUDE_LITELLM_KEY");
        let (_t, repo) = temp_repo().await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let ch = Channel::<CodeEvent>::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                let _ = tx.send(serde_json::from_str(&s).unwrap());
            }
            Ok(())
        });
        let cli = locate_cli(None).expect("openclaude cli.mjs");
        let sessions = CodeSessions::default();
        let a = StartArgs { cli: &cli, cwd: &repo, model: "coder-local", permission_mode: "default", openai_base: "http://127.0.0.1:4000/v1", api_key: Some(&key), plugin_dirs: &[] };
        sessions.start("s1".into(), a, ch).await.unwrap();
        sessions.send("s1", "Create a file named hello.txt containing exactly the word hi. Use the Write tool.").await.unwrap();

        let mut approved = false;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(240);
        loop {
            let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("timed out").expect("channel closed");
            match ev["type"].as_str() {
                Some("approval") => {
                    assert!(!repo.join("hello.txt").exists(), "file written before approval");
                    sessions.respond("s1", ev["request_id"].as_str().unwrap(), true, None, None).await.unwrap();
                    approved = true;
                }
                Some("agent") if ev["record"]["type"] == "result" => break,
                Some("exited") => break,
                _ => {}
            }
        }
        sessions.stop_all().await;
        assert!(approved, "never received a can_use_tool approval");
        assert!(repo.join("hello.txt").exists(), "hello.txt missing after allow");
    }

    #[tokio::test]
    async fn shell_command_runs_in_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "x").unwrap();
        let cmd = if cfg!(windows) { "Get-ChildItem -Name" } else { "ls" };
        let out = shell_command(dir.path(), cmd).output().await.unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("marker.txt"));
    }

    #[tokio::test]
    async fn git_status_reads_this_repo() {
        let st = git_status(Path::new(env!("CARGO_MANIFEST_DIR"))).await;
        assert!(st.is_repo, "{:?}", st.error);
        assert!(st.branch.is_some());
        assert!(git_diff(Path::new("."), Some("../etc")).await.is_err());
    }

    async fn temp_repo() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("proj");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]).await.unwrap();
        git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]).await.unwrap();
        (t, repo)
    }

    #[tokio::test]
    async fn worktree_add_list_remove() {
        let (_t, repo) = temp_repo().await;
        let p = worktree_add(&repo, "feat/x").await.unwrap();
        assert!(p.ends_with("feat-x") && p.exists(), "{p:?}");
        assert!(p.parent().unwrap().ends_with("proj-wt"));
        let l = worktrees(&repo).await.unwrap();
        assert_eq!(l.len(), 2);
        let w = l.iter().find(|w| same_path(Path::new(&w.path), &p)).expect("listed");
        assert_eq!(w.branch.as_deref(), Some("feat/x"));
        assert_eq!(w.head.len(), 40);
        // from inside the linked worktree the layout is still derived from the main one
        assert!(worktree_add(&p, "other").await.unwrap().parent().unwrap().ends_with("proj-wt"));
        worktree_remove(&repo, &p).await.unwrap();
        assert!(!p.exists());
        // branch survives removal: re-adding uses the existing branch
        let p2 = worktree_add(&repo, "feat/x").await.unwrap();
        assert!(p2.exists());
    }

    #[tokio::test]
    async fn worktree_rejects_bad_names_and_paths() {
        let (_t, repo) = temp_repo().await;
        for bad in ["", "-bad", "--force", "a..b", "has space", "x.lock", "@{-1}", "a~b"] {
            assert!(worktree_add(&repo, bad).await.is_err(), "{bad:?}");
        }
        assert!(worktree_remove(&repo, &repo).await.is_err(), "main worktree");
        assert!(worktree_remove(&repo, repo.parent().unwrap()).await.is_err(), "unknown path");
    }

    #[tokio::test]
    async fn worktree_remove_dirty_surfaces_git_error() {
        let (_t, repo) = temp_repo().await;
        let p = worktree_add(&repo, "dirty").await.unwrap();
        std::fs::write(p.join("scratch.txt"), "x").unwrap();
        assert!(worktree_remove(&repo, &p).await.is_err());
        assert!(p.exists());
    }

    #[test]
    fn detects_dev_urls() {
        // Vite (with ANSI, bold port inside the URL)
        assert_eq!(detect_dev_url("  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m").as_deref(), Some("http://localhost:5173/"));
        assert_eq!(detect_dev_url("  ➜  Local:   http://localhost:5173/").as_deref(), Some("http://localhost:5173/"));
        // Next
        assert_eq!(detect_dev_url("   - Local:        http://localhost:3000").as_deref(), Some("http://localhost:3000"));
        // CRA
        assert_eq!(detect_dev_url("  Local:            http://localhost:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(detect_dev_url("Server listening on http://127.0.0.1:8080.").as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(detect_dev_url("ready at http://[::1]:4321/").as_deref(), Some("http://[::1]:4321/"));
        // remote first, local second -> local; remote only -> none
        assert_eq!(detect_dev_url("Network: http://192.168.1.5:5173/ Local: https://localhost:8443/x").as_deref(), Some("https://localhost:8443/x"));
        assert_eq!(detect_dev_url("  ➜  Network: http://192.168.1.5:5173/"), None);
        assert_eq!(detect_dev_url("see https://example.com:3000/ or http://localhost/"), None);
        assert_eq!(detect_dev_url("compiled successfully"), None);
    }

    #[test]
    fn preview_url_is_local_only() {
        for ok in ["http://localhost:5173", "https://127.0.0.1:3000/a?b=1", "http://[::1]:8080/", "http://LOCALHOST:3000"] {
            assert!(is_local_preview_url(ok), "{ok}");
        }
        for bad in [
            "http://example.com:3000", "http://localhost.evil.com:3000", "http://127.0.0.1.evil.com:80", "http://localhost@evil.com:3000",
            "http://user:pw@localhost:3000", "http://localhost", "ftp://localhost:21", "file:///C:/x", "javascript:alert(1)", "http://192.168.1.2:3000", "http://0.0.0.0:3000", "", "localhost:3000",
        ] {
            assert!(!is_local_preview_url(bad), "{bad}");
        }
    }
}
