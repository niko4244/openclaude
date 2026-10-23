mod agent;
mod chat;
mod db;
mod gateway;
mod mcp;
mod probe;
mod shell;
mod state;

use chat::{ChatEvent, Run, SendArgs};
use db::{Conversation, Db, Message, Project};
use gateway::{Gateway, GatewayStatus, ModelEntry};
use mcp::{McpConfig, ServerConfig, ServerStatus};
use serde::Serialize;
use serde_json::Value;
use state::AppState;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};

type Res<T> = Result<T, String>;
fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

// ---------- gateway / models

#[tauri::command]
async fn gateway_status(state: State<'_, Arc<AppState>>) -> Res<GatewayStatus> {
    let gw = state.gateway.read().await.clone();
    Ok(gw.status().await)
}

#[tauri::command]
async fn list_models(state: State<'_, Arc<AppState>>, refresh: bool) -> Res<Vec<ModelEntry>> {
    if !refresh {
        let cached = state.models.read().await.clone();
        if !cached.is_empty() {
            return Ok(cached);
        }
    }
    let gw = state.gateway.read().await.clone();
    let models = gw.models().await.map_err(e)?;
    *state.models.write().await = models.clone();
    Ok(models)
}

#[derive(Serialize)]
struct GatewaySettings {
    base_url: String,
    has_key: bool,
}

#[tauri::command]
async fn get_gateway_settings(state: State<'_, Arc<AppState>>) -> Res<GatewaySettings> {
    let gw = state.gateway.read().await;
    Ok(GatewaySettings { base_url: gw.base_url.clone(), has_key: gw.api_key.is_some() })
}

/// `api_key: None` keeps the stored key; `Some("")` clears it.
#[tauri::command]
async fn set_gateway_settings(state: State<'_, Arc<AppState>>, base_url: String, api_key: Option<String>) -> Res<()> {
    let parsed = url::Url::parse(&base_url).map_err(|_| "Gateway URL must be an absolute http(s) URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Gateway URL must use http or https".into());
    }
    if let Some(k) = &api_key {
        state::store_api_key(k.trim()).map_err(e)?;
    }
    state.db.lock().unwrap().set_setting("gateway_url", &base_url).map_err(e)?;
    *state.gateway.write().await = Gateway::new(&base_url, state::resolve_api_key());
    state.models.write().await.clear();
    Ok(())
}

/// Run the capability probe against the live gateway and remember the result.
#[tauri::command]
async fn probe_model(state: State<'_, Arc<AppState>>, model: String) -> Res<probe::ProbeReport> {
    let gw = state.gateway.read().await.clone();
    let rep = probe::probe(&gw, &model).await;
    state.db.lock().unwrap().set_setting(&format!("probe:{model}"), &serde_json::to_string(&rep).map_err(e)?).map_err(e)?;
    Ok(rep)
}

#[tauri::command]
fn get_probes(state: State<'_, Arc<AppState>>) -> Res<Vec<probe::ProbeReport>> {
    let rows = state.db.lock().unwrap().settings_with_prefix("probe:").map_err(e)?;
    Ok(rows.into_iter().filter_map(|(_, v)| serde_json::from_str(&v).ok()).collect())
}

// ---------- settings

#[tauri::command]
fn get_setting(state: State<'_, Arc<AppState>>, key: String) -> Option<String> {
    state.db.lock().unwrap().get_setting(&key)
}

#[tauri::command]
fn set_setting(state: State<'_, Arc<AppState>>, key: String, value: String) -> Res<()> {
    check_ui_setting(&key, &value)?;
    state.db.lock().unwrap().set_setting(&key, &value).map_err(e)
}

/// The UI may only write plain preferences. Security-relevant state (folder grants,
/// CLI path, probe results, gateway URL) is written by dedicated backend commands.
fn check_ui_setting(key: &str, value: &str) -> Res<()> {
    const UI_KEYS: &[&str] = &[
        "theme", "system_prompt", "tools_enabled", "quick_entry_shortcut", "close_to_tray", "default_model", "favorite_models",
        "mcp_disabled", "extended_thinking", "user_name",
    ];
    if key.starts_with("feedback:") {
        return if matches!(value, "up" | "down" | "none") { Ok(()) } else { Err("invalid feedback".into()) };
    }
    if let Some(_tool) = key.strip_prefix("tool_policy:") {
        return if matches!(value, "allow" | "ask" | "block") { Ok(()) } else { Err("invalid tool policy".into()) };
    }
    if UI_KEYS.contains(&key) { Ok(()) } else { Err(format!("setting `{key}` cannot be changed from the UI")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_export_shows_roles_and_tools() {
        let c = Conversation { id: "c".into(), project_id: None, title: "T".into(), model: None, pinned: false, draft: String::new(), created_at: 0, updated_at: 0 };
        let mk = |role: &str, text: &str| Message { role: role.into(), content: Value::String(text.into()), model_requested: Some("qwen-local".into()), name: Some("echo".into()), ..Default::default() };
        let md = chat_markdown(&c, &[mk("user", "hi"), mk("assistant", "hello"), mk("tool", "a\nb")]);
        assert!(md.starts_with("# T"));
        assert!(md.contains("## You\n\nhi"));
        assert!(md.contains("## qwen-local\n\nhello"));
        assert!(md.contains("> Tool `echo` result:\n>\n> a\n> b"));
    }

    #[test]
    fn ui_cannot_write_security_settings() {
        assert!(check_ui_setting("theme", "dark").is_ok());
        assert!(check_ui_setting("tool_policy:mcp__x__y", "allow").is_ok());
        assert!(check_ui_setting("tool_policy:mcp__x__y", "yolo").is_err());
        for k in ["workspaces", "openclaude_cli_path", "gateway_url", "probe:qwen-local", "tray_notice_shown"] {
            assert!(check_ui_setting(k, "x").is_err(), "{k} must be backend-only");
        }
    }
}

// ---------- projects / conversations

#[tauri::command]
fn list_projects(state: State<'_, Arc<AppState>>) -> Res<Vec<Project>> {
    state.db.lock().unwrap().list_projects().map_err(e)
}

#[tauri::command]
fn save_project(state: State<'_, Arc<AppState>>, mut project: Project) -> Res<Project> {
    if project.id.is_empty() {
        project.id = db::new_id();
    }
    let db = state.db.lock().unwrap();
    db.upsert_project(&project).map_err(e)?;
    db.get_project(&project.id).map_err(e)?.ok_or_else(|| "save failed".into())
}

#[tauri::command]
fn delete_project(state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    state.db.lock().unwrap().delete_project(&id).map_err(e)
}

#[tauri::command]
fn list_conversations(state: State<'_, Arc<AppState>>, query: Option<String>, project_id: Option<String>) -> Res<Vec<Conversation>> {
    let q = query.filter(|q| !q.trim().is_empty());
    state.db.lock().unwrap().list_conversations(q.as_deref(), project_id.as_deref()).map_err(e)
}

#[tauri::command]
fn create_conversation(state: State<'_, Arc<AppState>>, project_id: Option<String>, model: Option<String>) -> Res<Conversation> {
    state.db.lock().unwrap().create_conversation(project_id.as_deref(), model.as_deref()).map_err(e)
}

#[tauri::command]
fn update_conversation(state: State<'_, Arc<AppState>>, conversation: Conversation) -> Res<()> {
    state.db.lock().unwrap().update_conversation(&conversation).map_err(e)
}

#[tauri::command]
fn delete_conversation(state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    state.db.lock().unwrap().delete_conversation(&id).map_err(e)
}

#[tauri::command]
fn switch_branch(state: State<'_, Arc<AppState>>, conversation_id: String, message_id: String) -> Res<()> {
    state.db.lock().unwrap().switch_branch(&conversation_id, &message_id).map_err(e)
}

/// Render a chat as Markdown (visible branch only).
fn chat_markdown(c: &Conversation, msgs: &[Message]) -> String {
    let mut out = format!("# {}\n\n", c.title);
    for m in msgs {
        let text = match &m.content {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
            _ => String::new(),
        };
        match m.role.as_str() {
            "user" => out.push_str(&format!("## You\n\n{text}\n\n")),
            "assistant" if !text.is_empty() => {
                out.push_str(&format!("## {}\n\n{text}\n\n", m.model_requested.as_deref().unwrap_or("Assistant")))
            }
            "tool" => out.push_str(&format!("> Tool `{}` result:\n>\n> {}\n\n", m.name.as_deref().unwrap_or("tool"), text.replace('\n', "\n> "))),
            _ => {}
        }
    }
    out
}

#[tauri::command]
async fn export_chat(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, conversation_id: String) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (conv, msgs) = {
        let db = state.db.lock().unwrap();
        (db.get_conversation(&conversation_id).map_err(e)?.ok_or("chat not found")?, db.messages(&conversation_id).map_err(e)?)
    };
    let md = chat_markdown(&conv, &msgs);
    let safe: String = conv.title.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(format!("{}.md", safe.trim())).add_filter("Markdown", &["md"]).save_file(move |p| {
        let _ = tx.send(p);
    });
    let Ok(Some(path)) = rx.await else { return Ok(None) };
    let path = path.into_path().map_err(e)?;
    std::fs::write(&path, md).map_err(e)?;
    Ok(Some(path.to_string_lossy().into()))
}

#[tauri::command]
fn get_messages(state: State<'_, Arc<AppState>>, conversation_id: String) -> Res<Vec<Message>> {
    state.db.lock().unwrap().messages(&conversation_id).map_err(e)
}

// ---------- chat runtime

#[tauri::command]
fn chat_send(
    state: State<'_, Arc<AppState>>,
    conversation_id: String,
    content: Option<Value>,
    model: String,
    replace_from: Option<String>,
    on_event: Channel<ChatEvent>,
) -> Res<String> {
    if model.trim().is_empty() {
        return Err("Pick a model first".into());
    }
    let run_id = db::new_id();
    let run = Arc::new(Run { cancel: tokio::sync::Notify::new() });
    state.runs.lock().unwrap().insert(run_id.clone(), run.clone());
    let st = state.inner().clone();
    let args = SendArgs { conversation_id, content, model, replace_from };
    tauri::async_runtime::spawn(chat::run(st, run_id.clone(), run, args, on_event));
    Ok(run_id)
}

#[tauri::command]
fn chat_cancel(state: State<'_, Arc<AppState>>, run_id: String) {
    if let Some(r) = state.runs.lock().unwrap().get(&run_id) {
        r.cancel.notify_one();
    }
}

#[tauri::command]
fn tool_decision(state: State<'_, Arc<AppState>>, request_id: String, allow: bool, scope: String) {
    let scope = if matches!(scope.as_str(), "once" | "chat" | "always") { scope } else { "once".into() };
    if let Some(tx) = state.approvals.lock().unwrap().remove(&request_id) {
        let _ = tx.send((allow, scope));
    }
}

// ---------- MCP

#[tauri::command]
async fn mcp_status(state: State<'_, Arc<AppState>>) -> Res<Vec<ServerStatus>> {
    Ok(state.mcp.statuses().await)
}

#[tauri::command]
fn mcp_get_config(state: State<'_, Arc<AppState>>) -> McpConfig {
    McpConfig::load(&state.mcp_config_path)
}

#[tauri::command]
async fn mcp_save_server(state: State<'_, Arc<AppState>>, name: String, config: ServerConfig) -> Res<()> {
    let name = name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err("Server name must be 1-64 characters".into());
    }
    let mut cfg = McpConfig::load(&state.mcp_config_path);
    cfg.servers.insert(name.clone(), config);
    cfg.save(&state.mcp_config_path).map_err(e)?;
    state.mcp.stop(&name).await;
    state.mcp.set_config(&cfg).await;
    state.mcp.start(&name).await;
    Ok(())
}

#[tauri::command]
async fn mcp_remove_server(state: State<'_, Arc<AppState>>, name: String) -> Res<()> {
    let mut cfg = McpConfig::load(&state.mcp_config_path);
    cfg.servers.remove(&name);
    cfg.save(&state.mcp_config_path).map_err(e)?;
    state.mcp.stop(&name).await;
    state.mcp.set_config(&cfg).await;
    Ok(())
}

#[tauri::command]
async fn mcp_restart(state: State<'_, Arc<AppState>>, name: String) -> Res<()> {
    state.mcp.stop(&name).await;
    state.mcp.start(&name).await;
    Ok(())
}

#[derive(Serialize)]
struct ImportCandidate {
    source: String,
    path: String,
    servers: std::collections::BTreeMap<String, ServerConfig>,
}

/// Read-only scan of other apps' MCP registries. Env values are masked.
#[tauri::command]
fn mcp_import_candidates() -> Vec<ImportCandidate> {
    mcp::import_sources()
        .into_iter()
        .map(|(source, path)| {
            let mut servers = mcp::read_external(&path);
            for s in servers.values_mut() {
                for v in s.env.values_mut().chain(s.headers.values_mut()) {
                    *v = "••••".into();
                }
            }
            ImportCandidate { source, path: path.to_string_lossy().into(), servers }
        })
        .filter(|c| !c.servers.is_empty())
        .collect()
}

/// Copy selected servers (with real env values) into our own config.
#[tauri::command]
async fn mcp_import(state: State<'_, Arc<AppState>>, path: String, names: Vec<String>) -> Res<usize> {
    let allowed: Vec<_> = mcp::import_sources().into_iter().map(|(_, p)| p).collect();
    let path = std::path::PathBuf::from(path);
    if !allowed.contains(&path) {
        return Err("not a known MCP registry".into());
    }
    let ext = mcp::read_external(&path);
    let mut cfg = McpConfig::load(&state.mcp_config_path);
    let mut n = 0;
    for name in names {
        if let Some(s) = ext.get(&name) {
            cfg.servers.insert(name, s.clone());
            n += 1;
        }
    }
    cfg.save(&state.mcp_config_path).map_err(e)?;
    state.mcp.set_config(&cfg).await;
    let mcp = state.mcp.clone();
    tauri::async_runtime::spawn(async move { mcp.start_all().await });
    Ok(n)
}

// ---------- attachments

#[derive(Serialize, Clone)]
struct Attachment {
    name: String,
    mime: String,
    /// "image" -> data_url set; "text" -> text set.
    kind: String,
    text: Option<String>,
    data_url: Option<String>,
    size: u64,
}

const MAX_ATTACHMENT: u64 = 20 * 1024 * 1024;

fn read_attachment(path: &std::path::Path) -> Result<Attachment, String> {
    use base64::Engine;
    let meta = std::fs::metadata(path).map_err(e)?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_ATTACHMENT {
        return Err(format!("{} is larger than 20 MB", path.display()));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
    let image_mime = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    let bytes = std::fs::read(path).map_err(e)?;
    if let Some(mime) = image_mime {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(Attachment { name, mime: mime.into(), kind: "image".into(), text: None, data_url: Some(format!("data:{mime};base64,{b64}")), size: meta.len() });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Attachment { name, mime: "text/plain".into(), kind: "text".into(), text: Some(text), data_url: None, size: meta.len() }),
        Err(_) => Err(format!("{name}: binary files other than images are not supported yet")),
    }
}

/// The file dialog runs in the backend so the UI never supplies arbitrary paths.
#[tauri::command]
async fn pick_attachments(app: tauri::AppHandle) -> Vec<Result<Attachment, String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |files| {
        let _ = tx.send(files);
    });
    let Ok(Some(files)) = rx.await else { return vec![] };
    files
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| read_attachment(&p))
        .collect()
}

/// Store artifact HTML and return the isolated URL it is served from.
#[tauri::command]
fn artifact_put(state: State<'_, Arc<AppState>>, html: String) -> String {
    let id = db::new_id();
    let mut a = state.artifacts.lock().unwrap();
    if a.len() > 200 {
        a.clear();
    }
    a.insert(id.clone(), html);
    if cfg!(windows) { format!("http://artifact.localhost/{id}") } else { format!("artifact://localhost/{id}") }
}

/// Artifacts get their own origin and a CSP that cannot reach the IPC endpoint,
/// and the iframe is additionally sandboxed without `allow-same-origin`.
fn serve_artifact(app: &tauri::AppHandle, req: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let id = req.uri().path().trim_start_matches('/').to_string();
    let html = app.try_state::<Arc<AppState>>().and_then(|s| s.artifacts.lock().unwrap().get(&id).cloned());
    let builder = tauri::http::Response::builder()
        .header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:")
        .header("X-Content-Type-Options", "nosniff");
    match html {
        Some(h) => builder.header("Content-Type", "text/html; charset=utf-8").body(h.into_bytes()).unwrap(),
        None => builder.status(404).body(b"artifact not found".to_vec()).unwrap(),
    }
}

// ---------- coding workspace

fn granted_workspaces(state: &AppState) -> Vec<String> {
    state.db.lock().unwrap().get_setting("workspaces").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Folders become usable only after the user picks them in a native dialog.
fn check_workspace(state: &AppState, cwd: &str) -> Res<std::path::PathBuf> {
    if !granted_workspaces(state).iter().any(|w| w == cwd) {
        return Err("folder was not opened through the folder picker".into());
    }
    Ok(std::path::PathBuf::from(cwd))
}

#[tauri::command]
async fn pick_workspace(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    let Ok(Some(dir)) = rx.await else { return Ok(None) };
    let path = dir.into_path().map_err(e)?.to_string_lossy().to_string();
    let mut ws = granted_workspaces(&state);
    if !ws.contains(&path) {
        ws.push(path.clone());
        state.db.lock().unwrap().set_setting("workspaces", &serde_json::to_string(&ws).map_err(e)?).map_err(e)?;
    }
    Ok(Some(path))
}

/// Previously granted folders that still exist (most recent last).
#[tauri::command]
fn list_workspaces(state: State<'_, Arc<AppState>>) -> Vec<String> {
    granted_workspaces(&state).into_iter().filter(|w| std::path::Path::new(w).is_dir()).collect()
}

#[tauri::command]
async fn code_start(
    state: State<'_, Arc<AppState>>,
    cwd: String,
    model: String,
    permission_mode: String,
    on_event: Channel<agent::CodeEvent>,
) -> Res<String> {
    let dir = check_workspace(&state, &cwd)?;
    let setting = state.db.lock().unwrap().get_setting("openclaude_cli_path");
    let cli = agent::locate_cli(setting).ok_or("OpenClaude CLI not found. Set OPENCLAUDE_BIN or install @gitlawb/openclaude.")?;
    let gw = state.gateway.read().await.clone();
    let id = db::new_id();
    state
        .code
        .start(
            id.clone(),
            agent::StartArgs { cli: &cli, cwd: &dir, model: &model, permission_mode: &permission_mode, gateway_base: &gw.base_url, api_key: gw.api_key.as_deref() },
            on_event,
        )
        .await
        .map_err(e)?;
    Ok(id)
}

#[tauri::command]
async fn code_send(state: State<'_, Arc<AppState>>, session_id: String, text: String) -> Res<()> {
    state.code.send(&session_id, &text).await.map_err(e)
}

#[tauri::command]
async fn code_stop(state: State<'_, Arc<AppState>>, session_id: String) -> Res<()> {
    state.code.stop(&session_id).await;
    Ok(())
}

#[tauri::command]
async fn git_status(state: State<'_, Arc<AppState>>, cwd: String) -> Res<agent::GitStatus> {
    let dir = check_workspace(&state, &cwd)?;
    Ok(agent::git_status(&dir).await)
}

#[tauri::command]
async fn git_diff(state: State<'_, Arc<AppState>>, cwd: String, path: Option<String>) -> Res<String> {
    let dir = check_workspace(&state, &cwd)?;
    agent::git_diff(&dir, path.as_deref()).await.map_err(e)
}

// ---------- quick entry / shell

// Window-creating commands must be async: a sync command runs on the main thread,
// and building a webview there deadlocks on Windows (window stuck at about:blank).
#[tauri::command]
async fn quick_entry_toggle(app: tauri::AppHandle) -> Res<()> {
    shell::toggle_quick(&app).map_err(e)
}

/// Quick Entry hands its prompt to the main window, which starts a new chat.
#[tauri::command]
fn quick_entry_submit(app: tauri::AppHandle, text: String, model: Option<String>) -> Res<()> {
    if let Some(q) = app.get_webview_window(shell::QUICK) {
        let _ = q.hide();
    }
    shell::show_main(&app);
    app.emit_to("main", "quick-submit", serde_json::json!({ "text": text, "model": model })).map_err(e)
}

/// Menu actions reachable from keyboard shortcuts too (zoom lives in the backend).
#[tauri::command]
async fn menu_action(app: tauri::AppHandle, id: String) {
    if matches!(id.as_str(), "zoom_in" | "zoom_out" | "zoom_reset" | "quick_entry") {
        shell::on_menu(&app, &tauri::menu::MenuEvent { id: tauri::menu::MenuId::new(id) });
    }
}

#[tauri::command]
fn quick_entry_hide(app: tauri::AppHandle) {
    if let Some(q) = app.get_webview_window(shell::QUICK) {
        let _ = q.hide();
    }
}

// ---------- command runner (Code tab)

#[tauri::command]
async fn cmd_run(state: State<'_, Arc<AppState>>, cwd: String, command: String, on_event: Channel<agent::CmdEvent>) -> Res<String> {
    let dir = check_workspace(&state, &cwd)?;
    if command.trim().is_empty() {
        return Err("empty command".into());
    }
    let id = db::new_id();
    state.code.run_command(id.clone(), &dir, &command, on_event).await.map_err(e)?;
    Ok(id)
}

#[tauri::command]
async fn cmd_kill(state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    state.code.stop(&id).await;
    Ok(())
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    /// OS account name, used only as the default display name.
    username: String,
    data_dir: String,
    mcp_config: String,
}

#[tauri::command]
fn app_info(state: State<'_, Arc<AppState>>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        username: std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default(),
        data_dir: state.mcp_config_path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        mcp_config: state.mcp_config_path.to_string_lossy().into(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_main(app)))
        .register_uri_scheme_protocol("artifact", |ctx, req| serve_artifact(ctx.app_handle(), &req))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // OPENCLAUDE_DATA_DIR isolates test runs from the user's real profile.
            let data_dir = match std::env::var_os("OPENCLAUDE_DATA_DIR") {
                Some(d) => std::path::PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            let db = Db::open(&data_dir.join("openclaude.db"))?;
            let base_url = std::env::var("OPENCLAUDE_GATEWAY_URL")
                .ok()
                .or_else(|| db.get_setting("gateway_url"))
                .unwrap_or_else(|| state::DEFAULT_GATEWAY.to_string());
            let mcp_config_path = data_dir.join("mcp.json");
            let state = Arc::new(AppState {
                db: std::sync::Mutex::new(db),
                gateway: tokio::sync::RwLock::new(Gateway::new(&base_url, state::resolve_api_key())),
                models: Default::default(),
                mcp: Default::default(),
                runs: Default::default(),
                approvals: Default::default(),
                chat_allows: Default::default(),
                mcp_config_path: mcp_config_path.clone(),
                artifacts: Default::default(),
                code: Default::default(),
                zoom: std::sync::Mutex::new(1.0),
            });
            app.manage(state.clone());
            app.set_menu(shell::build_menu(app.handle())?)?;
            app.on_menu_event(|app, e| shell::on_menu(app, &e));
            shell::build_tray(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                state.mcp.set_config(&McpConfig::load(&mcp_config_path)).await;
                state.mcp.start_all().await;
                let _ = handle.emit("mcp-changed", ());
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    // Only paths the user physically dropped are ever read.
                    let atts: Vec<_> = paths.iter().map(|p| read_attachment(p)).collect();
                    let _ = window.emit("attachments-dropped", atts);
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if shell::intercept_close(window) {
                        api.prevent_close();
                    }
                }
                tauri::WindowEvent::Focused(false) if window.label() == shell::QUICK => {
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            gateway_status,
            list_models,
            get_gateway_settings,
            set_gateway_settings,
            get_setting,
            set_setting,
            list_projects,
            save_project,
            delete_project,
            list_conversations,
            create_conversation,
            update_conversation,
            delete_conversation,
            get_messages,
            switch_branch,
            export_chat,
            chat_send,
            chat_cancel,
            tool_decision,
            mcp_status,
            mcp_get_config,
            mcp_save_server,
            mcp_remove_server,
            mcp_restart,
            mcp_import_candidates,
            mcp_import,
            pick_attachments,
            artifact_put,
            pick_workspace,
            list_workspaces,
            code_start,
            code_send,
            code_stop,
            git_status,
            git_diff,
            app_info,
            probe_model,
            get_probes,
            quick_entry_toggle,
            quick_entry_submit,
            quick_entry_hide,
            menu_action,
            cmd_run,
            cmd_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OpenClaude Desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Child processes (MCP servers, agents, commands) must not outlive the app.
                if let Some(st) = app.try_state::<Arc<AppState>>() {
                    let st = st.inner().clone();
                    tauri::async_runtime::block_on(async move {
                        st.mcp.stop_all().await;
                        st.code.stop_all().await;
                    });
                }
            }
        });
}
