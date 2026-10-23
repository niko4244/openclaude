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
    Stderr { line: String },
    Exited { code: Option<i32> },
}

pub struct CodeSession {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,

}

#[derive(Default)]
pub struct CodeSessions {
    pub map: Mutex<HashMap<String, Arc<CodeSession>>>,
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
    pub gateway_base: &'a str,
    pub api_key: Option<&'a str>,
}

pub fn build_command(a: &StartArgs) -> Command {
    let mut c = Command::new("node");
    c.arg(a.cli)
        .args(["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json"])
        .args(["--provider", "openai", "--model", a.model])
        .args(["--permission-mode", a.permission_mode])
        .current_dir(a.cwd)
        .env("CLAUDE_CODE_USE_OPENAI", "1")
        .env("OPENAI_BASE_URL", format!("{}/v1", a.gateway_base.trim_end_matches('/')))
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
        let session = Arc::new(CodeSession { stdin: Mutex::new(stdin), child: Mutex::new(child) });
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
                        let _ = ch.send(CodeEvent::Agent { record });
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

    pub async fn stop(&self, id: &str) {
        if let Some(s) = self.map.lock().await.remove(id) {
            let _ = s.child.lock().await.kill().await;
        }
    }

    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.map.lock().await.keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_routes_through_gateway_and_never_skips_permissions() {
        let a = StartArgs {
            cli: Path::new("cli.mjs"),
            cwd: Path::new("."),
            model: "coder-local",
            permission_mode: "acceptEdits",
            gateway_base: "http://127.0.0.1:4000/",
            api_key: Some("k"),
        };
        let c = build_command(&a);
        let std = c.as_std();
        let args: Vec<String> = std.get_args().map(|s| s.to_string_lossy().into()).collect();
        assert!(args.windows(2).any(|w| w == ["--model", "coder-local"]));
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]));
        assert!(!args.iter().any(|a| a.contains("dangerously")));
        let env: HashMap<String, String> = std
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into(), v?.to_string_lossy().into())))
            .collect();
        assert_eq!(env["OPENAI_BASE_URL"], "http://127.0.0.1:4000/v1");
    }

    #[tokio::test]
    async fn git_status_reads_this_repo() {
        let st = git_status(Path::new(env!("CARGO_MANIFEST_DIR"))).await;
        assert!(st.is_repo, "{:?}", st.error);
        assert!(st.branch.is_some());
        assert!(git_diff(Path::new("."), Some("../etc")).await.is_err());
    }
}
