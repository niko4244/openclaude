//! Minimal MCP client (JSON-RPC 2.0) over stdio and Streamable HTTP.
//!
//! Config uses the `mcpServers` shape shared by Claude Desktop, Claude Code and
//! OpenClaude, so existing registries import without translation.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, RwLock, oneshot};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
pub struct ServerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
}

impl ServerConfig {
    pub fn transport(&self) -> &'static str {
        match (self.kind.as_deref(), &self.url) {
            (Some("sse"), _) => "sse",
            (Some("http") | Some("streamable-http"), _) | (None, Some(_)) => "http",
            _ => "stdio",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct McpConfig {
    #[serde(rename = "mcpServers", default)]
    pub servers: std::collections::BTreeMap<String, ServerConfig>,
}

impl McpConfig {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    /// Atomic write with a `.bak` of the previous file.
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        if path.exists() {
            std::fs::copy(path, path.with_extension("json.bak"))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

/// Known external registries we can import from (read-only; never modified).
pub fn import_sources() -> Vec<(String, PathBuf)> {
    let mut v = vec![];
    if let Some(home) = dirs::home_dir() {
        v.push(("OpenClaude".into(), home.join(".openclaude.json")));
        v.push(("Claude Code".into(), home.join(".claude.json")));
    }
    if let Some(cfg) = dirs::config_dir() {
        v.push(("Claude Desktop".into(), cfg.join("Claude").join("claude_desktop_config.json")));
    }
    v
}

pub fn read_external(path: &Path) -> std::collections::BTreeMap<String, ServerConfig> {
    let Ok(text) = std::fs::read_to_string(path) else { return Default::default() };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return Default::default() };
    v.get("mcpServers")
        .cloned()
        .and_then(|s| serde_json::from_value(s).ok())
        .unwrap_or_default()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct ServerStatus {
    pub name: String,
    pub transport: String,
    pub state: String,
    pub error: Option<String>,
    pub server_info: Option<Value>,
    pub tools: Vec<ToolDef>,
    pub resources: usize,
    pub prompts: usize,
    pub log_tail: Vec<String>,
    pub disabled: bool,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

enum Transport {
    Stdio { stdin: Mutex<ChildStdin>, child: Mutex<Child>, pending: Pending },
    Http { url: String, headers: HashMap<String, String>, session: Mutex<Option<String>>, http: reqwest::Client },
}

struct Conn {
    transport: Transport,
    next_id: AtomicU64,
}

impl Conn {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> anyhow::Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let resp = match &self.transport {
            Transport::Stdio { stdin, pending, .. } => {
                let (tx, rx) = oneshot::channel();
                pending.lock().await.insert(id, tx);
                {
                    let mut w = stdin.lock().await;
                    w.write_all(format!("{msg}\n").as_bytes()).await?;
                    w.flush().await?;
                }
                match tokio::time::timeout(timeout, rx).await {
                    Ok(Ok(v)) => v,
                    Ok(Err(_)) => anyhow::bail!("server closed before replying to {method}"),
                    Err(_) => {
                        pending.lock().await.remove(&id);
                        anyhow::bail!("{method} timed out after {}s", timeout.as_secs())
                    }
                }
            }
            Transport::Http { .. } => self.http_post(&msg, Some(id), timeout).await?,
        };
        if let Some(err) = resp.get("error") {
            anyhow::bail!("{method} failed: {}", err.get("message").and_then(Value::as_str).unwrap_or("error"));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn notify(&self, method: &str) -> anyhow::Result<()> {
        let msg = json!({"jsonrpc": "2.0", "method": method});
        match &self.transport {
            Transport::Stdio { stdin, .. } => {
                let mut w = stdin.lock().await;
                w.write_all(format!("{msg}\n").as_bytes()).await?;
                w.flush().await?;
            }
            Transport::Http { .. } => {
                self.http_post(&msg, None, Duration::from_secs(15)).await?;
            }
        }
        Ok(())
    }

    async fn http_post(&self, msg: &Value, id: Option<u64>, timeout: Duration) -> anyhow::Result<Value> {
        let Transport::Http { url, headers, session, http } = &self.transport else { unreachable!() };
        let mut req = http
            .post(url)
            .timeout(timeout)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION)
            .json(msg);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        if let Some(s) = session.lock().await.as_ref() {
            req = req.header("Mcp-Session-Id", s);
        }
        let resp = req.send().await?;
        if let Some(s) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *session.lock().await = Some(s.to_string());
        }
        let status = resp.status();
        if !status.is_success() {
            anyhow::bail!("HTTP {status}: {}", resp.text().await.unwrap_or_default().chars().take(300).collect::<String>());
        }
        let Some(id) = id else { return Ok(Value::Null) };
        let is_sse = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.contains("text/event-stream"));
        let text = resp.text().await?;
        if !is_sse {
            return Ok(serde_json::from_str(&text)?);
        }
        for line in text.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                if let Ok(v) = serde_json::from_str::<Value>(data.trim()) {
                    if v.get("id").and_then(Value::as_u64) == Some(id) {
                        return Ok(v);
                    }
                }
            }
        }
        anyhow::bail!("no response for request {id} in event stream")
    }
}

struct Server {
    config: ServerConfig,
    conn: Option<Arc<Conn>>,
    state: String,
    error: Option<String>,
    server_info: Option<Value>,
    tools: Vec<ToolDef>,
    resources: usize,
    prompts: usize,
    log: Arc<std::sync::Mutex<VecDeque<String>>>,
}

#[derive(Default, Clone)]
pub struct McpManager {
    servers: Arc<RwLock<std::collections::BTreeMap<String, Server>>>,
}

/// `mcp__<server>__<tool>`, restricted to the charset OpenAI-style tool names allow.
pub fn qualified_name(server: &str, tool: &str) -> String {
    let clean = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect::<String>();
    let mut n = format!("mcp__{}__{}", clean(server), clean(tool));
    n.truncate(64);
    n
}

#[cfg(windows)]
fn resolve_command(cmd: &str, args: &[String]) -> (String, Vec<String>) {
    // npx/uvx etc. are .cmd shims on Windows and cannot be spawned directly.
    let p = Path::new(cmd);
    if p.extension().is_none() && p.parent().map_or(true, |d| d.as_os_str().is_empty()) {
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                for ext in ["exe", "cmd", "bat"] {
                    let cand = dir.join(format!("{cmd}.{ext}"));
                    if cand.is_file() {
                        if ext == "exe" {
                            return (cand.to_string_lossy().into(), args.to_vec());
                        }
                        let mut a = vec!["/C".to_string(), cand.to_string_lossy().into()];
                        a.extend(args.iter().cloned());
                        return ("cmd.exe".into(), a);
                    }
                }
            }
        }
    }
    (cmd.to_string(), args.to_vec())
}

#[cfg(not(windows))]
fn resolve_command(cmd: &str, args: &[String]) -> (String, Vec<String>) {
    (cmd.to_string(), args.to_vec())
}

fn push_log(log: &std::sync::Mutex<VecDeque<String>>, line: String) {
    let mut l = log.lock().unwrap();
    if l.len() >= 200 {
        l.pop_front();
    }
    l.push_back(line);
}

async fn connect(name: &str, cfg: &ServerConfig, log: Arc<std::sync::Mutex<VecDeque<String>>>) -> anyhow::Result<Conn> {
    match cfg.transport() {
        "stdio" => {
            let cmd = cfg.command.as_deref().ok_or_else(|| anyhow::anyhow!("no command configured"))?;
            let (prog, args) = resolve_command(cmd, &cfg.args);
            let mut c = Command::new(&prog);
            c.args(&args)
                .envs(&cfg.env)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            let mut child = c.spawn().map_err(|e| anyhow::anyhow!("spawn `{prog}` failed: {e}"))?;
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let pending: Pending = Default::default();
            let p2 = pending.clone();
            let l2 = log.clone();
            let n2 = name.to_string();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(v) = serde_json::from_str::<Value>(&line) else {
                        push_log(&l2, format!("[stdout] {line}"));
                        continue;
                    };
                    if let Some(id) = v.get("id").and_then(Value::as_u64) {
                        if v.get("method").is_none() {
                            if let Some(tx) = p2.lock().await.remove(&id) {
                                let _ = tx.send(v);
                            }
                        }
                    }
                }
                push_log(&l2, format!("[{n2}] stdout closed"));
            });
            let l3 = log.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    push_log(&l3, line);
                }
            });
            Ok(Conn {
                transport: Transport::Stdio { stdin: Mutex::new(stdin), child: Mutex::new(child), pending },
                next_id: AtomicU64::new(1),
            })
        }
        "http" => Ok(Conn {
            transport: Transport::Http {
                url: cfg.url.clone().unwrap_or_default(),
                headers: cfg.headers.clone(),
                session: Mutex::new(None),
                http: reqwest::Client::new(),
            },
            next_id: AtomicU64::new(1),
        }),
        other => anyhow::bail!("transport `{other}` is not supported yet (use stdio or streamable http)"),
    }
}

async fn handshake(conn: &Conn) -> anyhow::Result<(Value, Vec<ToolDef>, usize, usize)> {
    let init = conn
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "openclaude-desktop", "version": env!("CARGO_PKG_VERSION")}
            }),
            Duration::from_secs(60),
        )
        .await?;
    conn.notify("notifications/initialized").await?;
    let caps = init.get("capabilities").cloned().unwrap_or(Value::Null);
    let mut tools = vec![];
    if caps.get("tools").is_some() {
        let mut cursor: Option<String> = None;
        loop {
            let params = cursor.as_ref().map(|c| json!({"cursor": c})).unwrap_or(json!({}));
            let r = conn.request("tools/list", params, Duration::from_secs(30)).await?;
            if let Some(arr) = r.get("tools").and_then(Value::as_array) {
                tools.extend(arr.iter().filter_map(|t| serde_json::from_value::<ToolDef>(t.clone()).ok()));
            }
            cursor = r.get("nextCursor").and_then(Value::as_str).map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
    }
    let count = |r: anyhow::Result<Value>, key: &str| {
        r.ok().and_then(|v| v.get(key).and_then(Value::as_array).map(Vec::len)).unwrap_or(0)
    };
    let resources = if caps.get("resources").is_some() {
        count(conn.request("resources/list", json!({}), Duration::from_secs(15)).await, "resources")
    } else {
        0
    };
    let prompts = if caps.get("prompts").is_some() {
        count(conn.request("prompts/list", json!({}), Duration::from_secs(15)).await, "prompts")
    } else {
        0
    };
    Ok((init.get("serverInfo").cloned().unwrap_or(Value::Null), tools, resources, prompts))
}

impl McpManager {
    pub async fn set_config(&self, cfg: &McpConfig) {
        let mut servers = self.servers.write().await;
        servers.retain(|name, s| cfg.servers.get(name) == Some(&s.config));
        for (name, c) in &cfg.servers {
            servers.entry(name.clone()).or_insert_with(|| Server {
                config: c.clone(),
                conn: None,
                state: if c.disabled { "disabled".into() } else { "stopped".into() },
                error: None,
                server_info: None,
                tools: vec![],
                resources: 0,
                prompts: 0,
                log: Default::default(),
            });
        }
    }

    pub async fn start(&self, name: &str) {
        let (cfg, log) = {
            let mut s = self.servers.write().await;
            let Some(srv) = s.get_mut(name) else { return };
            if srv.config.disabled {
                return;
            }
            srv.state = "connecting".into();
            srv.error = None;
            srv.conn = None;
            (srv.config.clone(), srv.log.clone())
        };
        let result = async {
            let conn = connect(name, &cfg, log.clone()).await?;
            let hs = handshake(&conn).await?;
            anyhow::Ok((conn, hs))
        }
        .await;
        let mut s = self.servers.write().await;
        let Some(srv) = s.get_mut(name) else { return };
        match result {
            Ok((conn, (info, tools, resources, prompts))) => {
                srv.conn = Some(Arc::new(conn));
                srv.state = "connected".into();
                srv.server_info = Some(info);
                srv.tools = tools;
                srv.resources = resources;
                srv.prompts = prompts;
            }
            Err(e) => {
                srv.state = "error".into();
                srv.error = Some(e.to_string());
            }
        }
    }

    pub async fn start_all(&self) {
        let names: Vec<String> = self.servers.read().await.keys().cloned().collect();
        futures_util::future::join_all(names.iter().map(|n| self.start(n))).await;
    }

    pub async fn stop(&self, name: &str) {
        let mut s = self.servers.write().await;
        if let Some(srv) = s.get_mut(name) {
            if let Some(conn) = srv.conn.take() {
                if let Transport::Stdio { child, .. } = &conn.transport {
                    let _ = child.lock().await.kill().await;
                }
            }
            srv.state = if srv.config.disabled { "disabled".into() } else { "stopped".into() };
            srv.tools.clear();
        }
    }

    pub async fn stop_all(&self) {
        let names: Vec<String> = self.servers.read().await.keys().cloned().collect();
        for n in names {
            self.stop(&n).await;
        }
    }

    pub async fn statuses(&self) -> Vec<ServerStatus> {
        self.servers
            .read()
            .await
            .iter()
            .map(|(name, s)| ServerStatus {
                name: name.clone(),
                transport: s.config.transport().into(),
                state: s.state.clone(),
                error: s.error.clone(),
                server_info: s.server_info.clone(),
                tools: s.tools.clone(),
                resources: s.resources,
                prompts: s.prompts,
                log_tail: s.log.lock().unwrap().iter().rev().take(40).rev().cloned().collect(),
                disabled: s.config.disabled,
            })
            .collect()
    }

    /// OpenAI-format tool definitions for every connected server.
    pub async fn openai_tools(&self, allowed_servers: Option<&[String]>) -> Vec<Value> {
        let s = self.servers.read().await;
        s.iter()
            .filter(|(n, srv)| srv.conn.is_some() && allowed_servers.is_none_or(|a| a.contains(n)))
            .flat_map(|(name, srv)| {
                srv.tools.iter().map(move |t| {
                    let mut schema = t.input_schema.clone();
                    if !schema.is_object() {
                        schema = json!({"type": "object", "properties": {}});
                    }
                    json!({"type": "function", "function": {
                        "name": qualified_name(name, &t.name),
                        "description": t.description.clone().unwrap_or_default().chars().take(1024).collect::<String>(),
                        "parameters": schema,
                    }})
                })
            })
            .collect()
    }

    /// Resolve a qualified tool name back to (server, tool).
    pub async fn resolve(&self, qualified: &str) -> Option<(String, String)> {
        let s = self.servers.read().await;
        for (name, srv) in s.iter() {
            for t in &srv.tools {
                if qualified_name(name, &t.name) == qualified {
                    return Some((name.clone(), t.name.clone()));
                }
            }
        }
        None
    }

    /// Returns (model-facing text, raw result, is_error).
    pub async fn call(&self, server: &str, tool: &str, args: Value) -> anyhow::Result<(String, Value, bool)> {
        let conn = {
            let s = self.servers.read().await;
            s.get(server).and_then(|srv| srv.conn.clone()).ok_or_else(|| anyhow::anyhow!("server `{server}` is not connected"))?
        };
        let r = conn
            .request("tools/call", json!({"name": tool, "arguments": args}), Duration::from_secs(180))
            .await?;
        let is_error = r.get("isError").and_then(Value::as_bool).unwrap_or(false);
        let text = r
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .map(|p| match p.get("type").and_then(Value::as_str) {
                        Some("text") => p.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                        Some(t) => format!("[{t} content]"),
                        None => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .or_else(|| r.get("structuredContent").map(|s| s.to_string()))
            .unwrap_or_default();
        Ok((text, r, is_error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_desktop_shape() {
        let v = r#"{"mcpServers":{"fs":{"command":"npx","args":["-y","x"]},"remote":{"type":"http","url":"https://e/mcp"}}}"#;
        let c: McpConfig = serde_json::from_str(v).unwrap();
        assert_eq!(c.servers["fs"].transport(), "stdio");
        assert_eq!(c.servers["remote"].transport(), "http");
    }

    #[test]
    fn qualified_names_are_api_safe() {
        assert_eq!(qualified_name("second-brain", "recall"), "mcp__second-brain__recall");
        assert_eq!(qualified_name("a.b", "c d"), "mcp__a_b__c_d");
        assert!(qualified_name(&"x".repeat(80), "t").len() <= 64);
    }

    /// End-to-end against a tiny stdio MCP server written in Python, when available.
    #[tokio::test]
    async fn stdio_roundtrip() {
        let script = r#"
import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if 'id' not in m: continue
    if m['method'] == 'initialize':
        r = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'echo'}}
    elif m['method'] == 'tools/list':
        r = {'tools': [{'name': 'echo', 'description': 'echo', 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}}}]}
    elif m['method'] == 'tools/call':
        r = {'content': [{'type': 'text', 'text': 'echo:' + m['params']['arguments']['text']}]}
    else:
        r = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': r}), flush=True)
"#;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("echo.py");
        std::fs::write(&path, script).unwrap();
        if std::process::Command::new("python").arg("--version").output().is_err() {
            eprintln!("python not available; skipping");
            return;
        }
        let mut cfg = McpConfig::default();
        cfg.servers.insert(
            "echo".into(),
            ServerConfig { command: Some("python".into()), args: vec![path.to_string_lossy().into()], ..Default::default() },
        );
        let m = McpManager::default();
        m.set_config(&cfg).await;
        m.start_all().await;
        let st = m.statuses().await;
        assert_eq!(st[0].state, "connected", "{:?}", st[0].error);
        assert_eq!(m.openai_tools(None).await.len(), 1);
        let (srv, tool) = m.resolve("mcp__echo__echo").await.unwrap();
        let (text, _, err) = m.call(&srv, &tool, json!({"text": "hi"})).await.unwrap();
        assert_eq!(text, "echo:hi");
        assert!(!err);
        m.stop_all().await;
    }
}
