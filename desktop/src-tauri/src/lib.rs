mod agent;
mod browser;
mod chat;
mod chrome_bridge;
mod computer;
mod mcp_oauth;
mod pdf;
mod providers;
mod plugins;
mod voice;
mod db;
mod diag;
mod devices;
mod extensions;
mod gateway;
mod knowledge;
mod mcp;
mod probe;
mod registry;
mod shell;
mod sigverify;
mod state;
mod sync;
mod tasks;

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
    let list = providers::load(&state.db.lock().unwrap());
    let (gateway_models, (provider_models, _)) = tokio::join!(gw.models(), providers::catalog(&list));
    // The gateway may be offline while a direct provider still works.
    let mut models = match gateway_models {
        Ok(m) => m,
        Err(err) if !provider_models.is_empty() => {
            eprintln!("gateway catalog: {err}");
            vec![]
        }
        Err(err) => return Err(e(err)),
    };
    models.extend(provider_models);
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
    let (gw, wire) = providers::route(&state.db.lock().unwrap(), &gw, &model);
    let mut rep = probe::probe(&gw, &wire).await;
    rep.model = model.clone();
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
    let db = state.db.lock().unwrap();
    db.set_setting(&key, &value).map_err(e)?;
    sync::note_pref_change(&db, &key);
    Ok(())
}

/// The UI may only write plain preferences. Security-relevant state (folder grants,
/// CLI path, probe results, gateway URL) is written by dedicated backend commands.
fn check_ui_setting(key: &str, value: &str) -> Res<()> {
    const UI_KEYS: &[&str] = &[
        "theme", "system_prompt", "tools_enabled", "quick_entry_shortcut", "close_to_tray", "default_model", "favorite_models",
        "mcp_disabled", "extended_thinking", "user_name", "stt_model", "computer_use_enabled", "browser_tools_enabled", "android_devices_enabled", "auto_update",
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
fn project_files(state: State<'_, Arc<AppState>>, project_id: String) -> Res<Vec<db::ProjectFile>> {
    state.db.lock().unwrap().project_files(&project_id).map_err(e)
}

/// Native picker -> text extraction -> stored with the project. Binary files are rejected.
#[tauri::command]
async fn project_add_files(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, project_id: String) -> Res<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |f| {
        let _ = tx.send(f);
    });
    let Ok(Some(files)) = rx.await else { return Ok(vec![]) };
    let mut errors = vec![];
    for f in files {
        let Ok(path) = f.into_path() else { continue };
        match read_attachment(&path) {
            Ok(a) if a.kind == "text" => {
                state.db.lock().unwrap().add_project_file(&project_id, &a.name, a.text.as_deref().unwrap_or(""), a.size as i64).map_err(e)?
            }
            Ok(a) => errors.push(format!("{}: images can't be project knowledge; add text, Markdown, code or PDF files", a.name)),
            Err(err) => errors.push(err),
        }
    }
    Ok(errors)
}

#[tauri::command]
fn project_remove_file(state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    state.db.lock().unwrap().remove_project_file(&id).map_err(e)
}

#[tauri::command]
fn delete_project(state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    let db = state.db.lock().unwrap();
    db.delete_project(&id).map_err(e)?;
    sync::tombstone(&db, "project", &id);
    Ok(())
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
    let db = state.db.lock().unwrap();
    db.delete_conversation(&id).map_err(e)?;
    sync::tombstone(&db, "conversation", &id);
    Ok(())
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
    tauri::async_runtime::spawn(chat::run(st, run_id.clone(), run, args, chat::Sink::channel(on_event)));
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
    mcp_oauth::forget(&name);
    cfg.save(&state.mcp_config_path).map_err(e)?;
    state.mcp.stop(&name).await;
    state.mcp.set_config(&cfg).await;
    Ok(())
}

/// OAuth sign-in for a remote connector: opens the system browser, waits for the loopback redirect.
#[tauri::command]
async fn mcp_authorize(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, name: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = McpConfig::load(&state.mcp_config_path)
        .servers
        .get(&name)
        .and_then(|s| s.url.clone())
        .ok_or("not a remote connector")?;
    let opener = app.clone();
    mcp_oauth::authorize(&name, &url, move |u| {
        let _ = opener.opener().open_url(u, None::<&str>);
    })
    .await
    .map_err(e)?;
    state.mcp.stop(&name).await;
    state.mcp.start(&name).await;
    Ok(())
}

#[tauri::command]
async fn mcp_sign_out(state: State<'_, Arc<AppState>>, name: String) -> Res<()> {
    mcp_oauth::forget(&name);
    state.mcp.stop(&name).await;
    state.mcp.start(&name).await;
    Ok(())
}

#[tauri::command]
async fn mcp_restart(state: State<'_, Arc<AppState>>, name: String) -> Res<()> {
    state.mcp.stop(&name).await;
    state.mcp.start(&name).await;
    Ok(())
}

// ---------- tasks

#[tauri::command]
fn tasks_list(state: State<'_, Arc<AppState>>) -> Res<Vec<tasks::Task>> {
    let running = state.running_tasks.lock().unwrap().clone();
    let mut ts = state.db.lock().unwrap().tasks().map_err(e)?;
    for t in &mut ts {
        t.running = running.contains(&t.id);
    }
    Ok(ts)
}

#[tauri::command]
fn task_save(state: State<'_, Arc<AppState>>, mut task: tasks::Task) -> Res<tasks::Task> {
    if task.title.trim().is_empty() || task.prompt.trim().is_empty() || task.model.trim().is_empty() {
        return Err("title, prompt and model are required".into());
    }
    if !tasks::valid_schedule(&task.schedule) {
        return Err("schedule must be manual, every 5+ minutes, or daily at HH:MM".into());
    }
    task.workspace = task.workspace.filter(|w| !w.trim().is_empty());
    if let Some(w) = &task.workspace {
        check_workspace(&state, w)?;
    }
    state.db.lock().unwrap().save_task(&mut task).map_err(e)?;
    Ok(task)
}

#[tauri::command]
fn task_delete(state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    state.db.lock().unwrap().delete_task(&id).map_err(e)
}

#[tauri::command]
async fn task_run_now(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    let task = state.db.lock().unwrap().task(&id).map_err(e)?.ok_or("task not found")?;
    if state.running_tasks.lock().unwrap().contains(&id) {
        return Err("task is already running".into());
    }
    let st = state.inner().clone();
    tauri::async_runtime::spawn(tasks::run_task(st, app, task));
    Ok(())
}

// ---------- desktop extensions (.mcpb / .dxt)

#[derive(Serialize)]
struct ExtensionPick {
    token: String,
    preview: extensions::Preview,
}

#[tauri::command]
async fn extension_pick(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Res<Option<ExtensionPick>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("Desktop extension", &["mcpb", "dxt"]).pick_file(move |f| {
        let _ = tx.send(f);
    });
    let Ok(Some(f)) = rx.await else { return Ok(None) };
    let path = f.into_path().map_err(e)?;
    let (_, preview) = extensions::read_manifest(&path).map_err(e)?;
    let token = db::new_id();
    state.pending_ext.lock().unwrap().insert(token.clone(), path);
    Ok(Some(ExtensionPick { token, preview }))
}

#[tauri::command]
async fn extension_install(state: State<'_, Arc<AppState>>, token: String, values: std::collections::BTreeMap<String, String>) -> Res<String> {
    let path = state.pending_ext.lock().unwrap().remove(&token).ok_or("pick the extension again")?;
    let root = state.mcp_config_path.parent().map(|p| p.join("extensions")).ok_or("no data dir")?;
    let (name, server) = extensions::install(&path, &root, &values).map_err(e)?;
    let mut cfg = McpConfig::load(&state.mcp_config_path);
    cfg.servers.insert(name.clone(), server);
    cfg.save(&state.mcp_config_path).map_err(e)?;
    state.mcp.stop(&name).await;
    state.mcp.set_config(&cfg).await;
    state.mcp.start(&name).await;
    Ok(name)
}

/// Search the official MCP Registry (fixed host; results are data, nothing is installed here).
#[tauri::command]
async fn registry_search(query: Option<String>, cursor: Option<String>) -> Res<registry::Page> {
    registry::search(query.as_deref(), cursor.as_deref()).await.map_err(e)
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
    if pdf::is_pdf(&bytes) {
        let text = pdf::extract_text(&bytes).map_err(|err| format!("{name}: {err}"))?;
        return Ok(Attachment { name, mime: "application/pdf".into(), kind: "text".into(), text: Some(text), data_url: None, size: meta.len() });
    }
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

/// Save an artifact through a native save dialog (the UI never picks the path itself).
#[tauri::command]
async fn artifact_save(app: tauri::AppHandle, title: String, language: String, code: String) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let ext = match language.as_str() {
        "html" => "html", "svg" => "svg", "markdown" | "md" => "md", "javascript" | "js" => "js",
        "typescript" | "ts" => "ts", "tsx" => "tsx", "jsx" => "jsx", "python" | "py" => "py", "rust" | "rs" => "rs",
        "json" => "json", "css" => "css", "sql" => "sql", "bash" | "sh" => "sh", "powershell" | "ps1" => "ps1",
        "yaml" | "yml" => "yaml", "csv" => "csv", "go" => "go", "java" => "java", "c" => "c", "cpp" => "cpp",
        _ => "txt",
    };
    let stem: String = title.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(format!("{}.{ext}", stem.trim())).save_file(move |p| {
        let _ = tx.send(p);
    });
    let Ok(Some(path)) = rx.await else { return Ok(None) };
    let path = path.into_path().map_err(e)?;
    std::fs::write(&path, code).map_err(e)?;
    Ok(Some(path.to_string_lossy().into()))
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
async fn worktree_list(state: State<'_, Arc<AppState>>, cwd: String) -> Res<Vec<agent::Worktree>> {
    let dir = check_workspace(&state, &cwd)?;
    agent::worktrees(&dir).await.map_err(e)
}

/// New worktrees are granted like a picked folder, so the Code tab can open them.
#[tauri::command]
async fn worktree_add(state: State<'_, Arc<AppState>>, cwd: String, branch: String) -> Res<String> {
    let dir = check_workspace(&state, &cwd)?;
    let p = agent::worktree_add(&dir, &branch).await.map_err(e)?.to_string_lossy().to_string();
    let mut ws = granted_workspaces(&state);
    if !ws.contains(&p) {
        ws.push(p.clone());
        state.db.lock().unwrap().set_setting("workspaces", &serde_json::to_string(&ws).map_err(e)?).map_err(e)?;
    }
    Ok(p)
}

#[tauri::command]
async fn worktree_remove(state: State<'_, Arc<AppState>>, cwd: String, path: String) -> Res<()> {
    let dir = check_workspace(&state, &cwd)?;
    agent::worktree_remove(&dir, std::path::Path::new(&path)).await.map_err(e)?;
    let ws: Vec<String> = granted_workspaces(&state).into_iter().filter(|w| w != &path).collect();
    state.db.lock().unwrap().set_setting("workspaces", &serde_json::to_string(&ws).map_err(e)?).map_err(e)
}

/// Local dev-server preview in its own window. That window has no capability, so its
/// (untrusted) page cannot reach the IPC. Async: window creation from a sync command deadlocks on Windows.
#[tauri::command]
async fn preview_open(app: tauri::AppHandle, url: String) -> Res<()> {
    if !agent::is_local_preview_url(&url) {
        return Err("only local http(s) URLs with a port can be previewed".into());
    }
    let parsed: tauri::Url = url.parse().map_err(e)?;
    if let Some(w) = app.get_webview_window("preview") {
        w.navigate(parsed).map_err(e)?;
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "preview", tauri::WebviewUrl::External(parsed))
        .title("Preview")
        .inner_size(1100.0, 760.0)
        .build()
        .map_err(e)?;
    Ok(())
}

#[derive(Serialize, serde::Deserialize, Clone, PartialEq)]
struct RemoteWorkspace {
    host: String,
    dir: String,
}

fn granted_remotes(state: &AppState) -> Vec<RemoteWorkspace> {
    state.db.lock().unwrap().get_setting("remote_workspaces").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Remote folders are usable only after the user confirmed them in the native dialog of `remote_add`.
fn check_remote(state: &AppState, host: &str, dir: &str) -> Res<()> {
    if !granted_remotes(state).iter().any(|r| r.host == host && r.dir == dir) {
        return Err("remote folder was not added through Remote (SSH)".into());
    }
    Ok(())
}

#[tauri::command]
fn ssh_hosts() -> Vec<String> {
    agent::ssh_hosts()
}

#[tauri::command]
fn remote_list(state: State<'_, Arc<AppState>>) -> Vec<RemoteWorkspace> {
    granted_remotes(&state)
}

/// Grant a remote folder. Like the native folder picker for local folders, a native dialog
/// (which page script cannot answer) asks first. Returns false when the user cancels.
#[tauri::command]
async fn remote_add(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, host: String, dir: String) -> Res<bool> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (host, dir) = (host.trim().to_string(), dir.trim().to_string());
    if !agent::valid_ssh_host(&host) {
        return Err("Enter an alias from ~/.ssh/config, a hostname, or user@host.".into());
    }
    if !agent::valid_remote_dir(&dir) {
        return Err("The remote folder must be absolute (/…) or start with ~/.".into());
    }
    let mut list = granted_remotes(&state);
    if list.iter().any(|r| r.host == host && r.dir == dir) {
        return Ok(true);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Run the OpenClaude coding agent on {host} in {dir}?\n\nOpenClaude connects with your own SSH keys (like `ssh {host}`) and reaches your model gateway through an encrypted SSH tunnel. The agent can read and change files in that folder; the permission mode decides what it asks first."
        ))
        .title("Remote coding over SSH")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into()))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    if !rx.await.unwrap_or(false) {
        return Ok(false);
    }
    list.push(RemoteWorkspace { host, dir });
    state.db.lock().unwrap().set_setting("remote_workspaces", &serde_json::to_string(&list).map_err(e)?).map_err(e)?;
    Ok(true)
}

#[tauri::command]
async fn remote_check(state: State<'_, Arc<AppState>>, host: String, dir: String) -> Res<agent::RemoteCheck> {
    check_remote(&state, &host, &dir)?;
    Ok(agent::remote_check(&host, &dir).await)
}

/// `host` set: the agent runs on that SSH host in the remote folder `cwd`.
#[tauri::command]
async fn code_start(
    state: State<'_, Arc<AppState>>,
    cwd: String,
    host: Option<String>,
    model: String,
    permission_mode: String,
    on_event: Channel<agent::CodeEvent>,
) -> Res<String> {
    if let Some(host) = host {
        check_remote(&state, &host, &cwd)?;
        let gw = state.gateway.read().await.clone();
        let (gw, model) = providers::route(&state.db.lock().unwrap(), &gw, &model);
        let remote_port = 20000 + (rand::random::<u16>() % 40000);
        let cmd = agent::build_ssh_command(&agent::RemoteArgs { host: &host, dir: &cwd, model: &model, permission_mode: &permission_mode, openai_base: &gw.openai_base(), remote_port }).map_err(e)?;
        // The key is the first stdin line, read on the remote by a shell builtin (never on a command line).
        let key_line = format!("{}\n", gw.api_key.as_deref().unwrap_or("").trim());
        let id = db::new_id();
        state.code.start_with(id.clone(), cmd, Some(key_line), Some(host), on_event).await.map_err(e)?;
        return Ok(id);
    }
    let dir = check_workspace(&state, &cwd)?;
    let setting = state.db.lock().unwrap().get_setting("openclaude_cli_path");
    let cli = agent::locate_cli(setting).ok_or("OpenClaude CLI not found. Set OPENCLAUDE_BIN or install @gitlawb/openclaude.")?;
    let gw = state.gateway.read().await.clone();
    let (gw, model) = providers::route(&state.db.lock().unwrap(), &gw, &model);
    let plugin_dirs = state.plugins.cli_plugin_dirs();
    let id = db::new_id();
    state
        .code
        .start(
            id.clone(),
            agent::StartArgs { cli: &cli, cwd: &dir, model: &model, permission_mode: &permission_mode, openai_base: &gw.openai_base(), api_key: gw.api_key.as_deref(), plugin_dirs: &plugin_dirs },
            on_event,
        )
        .await
        .map_err(e)?;
    Ok(id)
}

#[tauri::command]
async fn code_approve(state: State<'_, Arc<AppState>>, session_id: String, request_id: String, allow: bool) -> Res<()> {
    let msg = (!allow).then(|| "The user denied this action in OpenClaude Desktop.".to_string());
    state.code.respond(&session_id, &request_id, allow, None, msg).await.map_err(e)
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
async fn git_status(state: State<'_, Arc<AppState>>, cwd: String, host: Option<String>) -> Res<agent::GitStatus> {
    if let Some(host) = host {
        check_remote(&state, &host, &cwd)?;
        return Ok(agent::remote_git_status(&host, &cwd).await);
    }
    let dir = check_workspace(&state, &cwd)?;
    Ok(agent::git_status(&dir).await)
}

#[tauri::command]
async fn git_diff(state: State<'_, Arc<AppState>>, cwd: String, host: Option<String>, path: Option<String>) -> Res<String> {
    if let Some(host) = host {
        check_remote(&state, &host, &cwd)?;
        return agent::remote_git_diff(&host, &cwd, path.as_deref()).await.map_err(e);
    }
    let dir = check_workspace(&state, &cwd)?;
    agent::git_diff(&dir, path.as_deref()).await.map_err(e)
}

// ---------- self-maintenance (diagnostics, self-tests, self-repair)

const UPDATE_FEED: &str = "https://github.com/niko4244/openclaude/releases/latest/download/latest.json";
const ISSUE_REPO: &str = "niko4244/openclaude";

#[tauri::command]
fn report_error(message: String, detail: String) {
    diag::record("frontend", &message, &detail);
}

#[derive(Serialize)]
struct Diagnostics {
    groups: Vec<diag::Group>,
    source_repo: Option<String>,
    version: String,
}

#[tauri::command]
fn diagnostics(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Diagnostics {
    let repo = state.db.lock().unwrap().get_setting("self_repo").map(std::path::PathBuf::from).filter(|p| p.join(".git").exists()).or_else(diag::source_repo);
    Diagnostics { groups: diag::groups(), source_repo: repo.map(|p| p.to_string_lossy().to_string()), version: app.package_info().version.to_string() }
}

#[tauri::command]
fn clear_errors() {
    diag::clear();
}

/// Health checks across the app's moving parts.
#[tauri::command]
async fn self_test(state: State<'_, Arc<AppState>>) -> Res<Vec<diag::Check>> {
    let mut out = vec![];
    let gw = state.gateway.read().await.clone();
    let st = gw.status().await;
    out.push(diag::check("Gateway", st.reachable && st.authenticated, st.error.unwrap_or_else(|| format!("{} ({} ms)", st.base_url, st.latency_ms.unwrap_or(0)))));
    let list = providers::load(&state.db.lock().unwrap());
    for v in providers::catalog(&list).await.1.into_iter().filter(|v| v.provider.enabled) {
        out.push(diag::check(&format!("Provider {}", v.provider.name), v.models > 0, if v.models > 0 { format!("{} models", v.models) } else { v.status.and_then(|s| s.error).unwrap_or_else(|| "no models".into()) }));
    }
    let servers = state.mcp.statuses().await;
    let broken: Vec<String> = servers.iter().filter(|s| s.state == "error").map(|s| format!("{}: {}", s.name, s.error.clone().unwrap_or_default())).collect();
    out.push(diag::check("Connectors", broken.is_empty(), if broken.is_empty() { format!("{} configured, none failing", servers.len()) } else { broken.join("; ") }));
    let plugin_errors: Vec<String> = state.plugins.registry().plugins.into_iter().filter_map(|p| p.error.map(|e| format!("{}: {e}", p.name))).collect();
    out.push(diag::check("Plugins", plugin_errors.is_empty(), if plugin_errors.is_empty() { format!("{} installed, no errors", state.plugins.registry().plugins.len()) } else { plugin_errors.join("; ") }));
    let feed = reqwest::Client::new().get(UPDATE_FEED).timeout(std::time::Duration::from_secs(15)).send().await;
    out.push(match feed {
        Ok(r) if r.status().is_success() => {
            let v: Value = r.json().await.unwrap_or(Value::Null);
            diag::check("Update feed", v["version"].is_string(), format!("latest {}", v["version"].as_str().unwrap_or("?")))
        }
        Ok(r) => diag::check("Update feed", false, format!("HTTP {}", r.status())),
        Err(err) => diag::check("Update feed", false, err.to_string()),
    });
    let groups = diag::groups();
    let day = db::now_ms() - 86_400_000;
    let recent: usize = groups.iter().filter(|g| g.last_at > day).map(|g| g.count).sum();
    out.push(diag::check("Errors (24 h)", recent == 0, if recent == 0 { "none".to_string() } else { format!("{recent} in {} group(s)", groups.iter().filter(|g| g.last_at > day).count()) }));
    Ok(out)
}

/// The coding-agent prompt for a group, and the repo to run it in (granted as a workspace on this click).
#[tauri::command]
fn diag_fix(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, fingerprint: String) -> Res<(String, String)> {
    let g = diag::groups().into_iter().find(|g| g.fingerprint == fingerprint).ok_or("That error is no longer in the log")?;
    let repo = diagnostics(app.clone(), state.clone()).source_repo.ok_or("Choose OpenClaude's source folder first (Diagnostics → Source folder)")?;
    let mut ws = granted_workspaces(&state);
    if !ws.contains(&repo) {
        ws.push(repo.clone());
        state.db.lock().unwrap().set_setting("workspaces", &serde_json::to_string(&ws).map_err(e)?).map_err(e)?;
    }
    Ok((repo, diag::fix_prompt(&g, &app.package_info().version.to_string())))
}

#[tauri::command]
fn diag_report(app: tauri::AppHandle, fingerprint: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let g = diag::groups().into_iter().find(|g| g.fingerprint == fingerprint).ok_or("That error is no longer in the log")?;
    app.opener().open_url(diag::issue_url(ISSUE_REPO, &g, &app.package_info().version.to_string()), None::<&str>).map_err(e)
}

/// Picks OpenClaude's source checkout (for self-repair) with the native folder picker.
#[tauri::command]
async fn diag_pick_repo(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    let Ok(Some(dir)) = rx.await else { return Ok(None) };
    let path = dir.into_path().map_err(e)?;
    if !path.join(".git").exists() || !path.join("desktop").join("src-tauri").is_dir() {
        return Err("That folder is not an OpenClaude checkout (expected .git and desktop/src-tauri)".into());
    }
    let p = path.to_string_lossy().to_string();
    state.db.lock().unwrap().set_setting("self_repo", &p).map_err(e)?;
    Ok(Some(p))
}

// ---------- model providers (any OpenAI-compatible endpoint)

#[tauri::command]
fn provider_presets() -> Vec<providers::Preset> {
    providers::PRESETS.to_vec()
}

#[tauri::command]
async fn providers_list(state: State<'_, Arc<AppState>>) -> Res<Vec<providers::ProviderView>> {
    let list = providers::load(&state.db.lock().unwrap());
    Ok(providers::catalog(&list).await.1)
}

/// Adds or updates a provider. `api_key`: None keeps the stored key, "" removes it.
#[tauri::command]
async fn provider_save(state: State<'_, Arc<AppState>>, provider: providers::Provider, api_key: Option<String>) -> Res<()> {
    if !providers::valid_id(&provider.id) {
        return Err("Provider id: lowercase letters, digits and dashes (max 32)".into());
    }
    if !providers::valid_base_url(&provider.base_url) {
        return Err("Base URL must be an http(s) URL, like https://api.openai.com/v1".into());
    }
    if let Some(k) = api_key {
        providers::set_key(&provider.id, k.trim()).map_err(e)?;
    }
    {
        let db = state.db.lock().unwrap();
        let mut list = providers::load(&db);
        list.retain(|p| p.id != provider.id);
        list.push(provider);
        providers::save(&db, &list).map_err(e)?;
    }
    state.models.write().await.clear();
    Ok(())
}

#[tauri::command]
async fn provider_remove(state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    {
        let db = state.db.lock().unwrap();
        let mut list = providers::load(&db);
        list.retain(|p| p.id != id);
        providers::save(&db, &list).map_err(e)?;
    }
    let _ = providers::set_key(&id, "");
    state.models.write().await.clear();
    Ok(())
}

// ---------- Android devices and emulators

#[tauri::command]
async fn devices_info() -> devices::Inventory {
    devices::inventory().await
}

#[tauri::command]
async fn device_boot(avd: String) -> Res<()> {
    let sdk = devices::locate().ok_or("adb was not found")?;
    devices::boot(&sdk, &avd).map_err(e)
}

#[tauri::command]
async fn device_create(name: String, image: String, device: String) -> Res<()> {
    let sdk = devices::locate().ok_or("adb was not found")?;
    devices::create(&sdk, &name, &image, &device).await.map_err(e)
}

// ---------- device preview: web emulation of phones and tablets in the Code tab

#[tauri::command]
fn device_presets() -> Vec<browser::DevicePreset> {
    browser::DEVICES.to_vec()
}

#[tauri::command]
async fn device_preview_open(state: State<'_, Arc<AppState>>, url: String, device: String, landscape: bool, on_event: Channel<browser::PreviewEvent>) -> Res<()> {
    let profile = state.mcp_config_path.parent().map(|p| p.join("device-preview")).unwrap_or_default();
    browser::preview_open(&url, &device, landscape, &profile, Arc::new(move |ev| { let _ = on_event.send(ev); })).await.map_err(e)
}

#[tauri::command]
async fn device_preview_set(device: String, landscape: bool) -> Res<()> {
    browser::preview_set(&device, landscape).await.map_err(e)
}

#[tauri::command]
async fn device_preview_input(input: browser::PreviewInput) -> Res<()> {
    browser::preview_input(&input).await.map_err(e)
}

#[tauri::command]
async fn device_preview_nav(action: String, url: Option<String>) -> Res<()> {
    browser::preview_nav(&action, url.as_deref()).await.map_err(e)
}

#[tauri::command]
async fn device_preview_info() -> Res<serde_json::Value> {
    browser::preview_info().await.map_err(e)
}

#[tauri::command]
async fn device_preview_close() {
    browser::preview_close().await;
}

// ---------- sync (local-first, through a folder the user's cloud drive syncs)

static SYNC: std::sync::LazyLock<std::sync::Mutex<sync::Memory>> = std::sync::LazyLock::new(Default::default);

/// One pass; returns the status and whether this database changed.
fn sync_pass(state: &AppState) -> (sync::Status, bool) {
    let mut mem = SYNC.lock().unwrap();
    let db = state.db.lock().unwrap();
    let changed = sync::run_once(&db, &mut mem).unwrap_or_else(|err| {
        mem.status.error = Some(err.to_string());
        false
    });
    (mem.status.clone(), changed)
}

#[tauri::command]
fn sync_status() -> sync::Status {
    SYNC.lock().unwrap().status.clone()
}

#[tauri::command]
async fn sync_now(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Res<sync::Status> {
    let (st, changed) = sync_pass(&state);
    if changed {
        let _ = app.emit("sync-changed", ());
    }
    Ok(st)
}

/// The folder comes from the native picker only; the UI never sends a path.
#[tauri::command]
async fn sync_choose_folder(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Res<sync::Status> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    if let Ok(Some(dir)) = rx.await {
        let path = dir.into_path().map_err(e)?.to_string_lossy().to_string();
        state.db.lock().unwrap().set_setting("sync_folder", &path).map_err(e)?;
    }
    sync_now(app, state).await
}

#[tauri::command]
fn sync_off(state: State<'_, Arc<AppState>>) -> Res<sync::Status> {
    state.db.lock().unwrap().set_setting("sync_folder", "").map_err(e)?;
    let mut mem = SYNC.lock().unwrap();
    mem.status.folder = None;
    Ok(mem.status.clone())
}

fn start_sync(state: Arc<AppState>, app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let has = sync::folder(&state.db.lock().unwrap()).is_some();
            if has && sync_pass(&state).1 {
                let _ = app.emit("sync-changed", ());
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

// ---------- plugins (Claude format)

#[derive(Serialize)]
struct PluginView {
    #[serde(flatten)]
    plugin: plugins::Plugin,
    skills: usize,
    commands: usize,
    agents: usize,
    hook_commands: usize,
}

fn plugin_view(p: plugins::Plugin) -> PluginView {
    let comps = plugins::components(&p);
    let count = |k: &str| comps.iter().filter(|c| c.kind == k).count();
    let hook_commands = if p.user_scope { 0 } else { ["SessionStart", "UserPromptSubmit"].iter().map(|ev| plugins::hooks_for(&p, ev, "").len()).sum() };
    PluginView { skills: count("skill"), commands: count("command"), agents: count("agent"), hook_commands, plugin: p }
}

/// Adds a plugin's MCP servers as connectors (keeping the user's on/off choice), drops ones it
/// no longer has, and never touches a connector of the user's that happens to share a name.
async fn sync_plugin_mcp(state: &AppState, id: &str) -> Res<()> {
    let Some(p) = state.plugins.registry().plugins.into_iter().find(|p| p.id == id) else { return Ok(()) };
    let wanted = if p.enabled { plugins::mcp_servers(&p) } else { Default::default() };
    let mut cfg = McpConfig::load(&state.mcp_config_path);
    let mut owned = vec![];
    let mut started = vec![];
    let mut changed = false;
    for old in &p.mcp_servers {
        if !wanted.contains_key(old) && cfg.servers.remove(old).is_some() {
            changed = true;
        }
    }
    for (name, mut sc) in wanted {
        if let Some(existing) = cfg.servers.get(&name) {
            if !p.mcp_servers.contains(&name) {
                continue;
            }
            sc.disabled = existing.disabled;
            if *existing == sc {
                owned.push(name);
                continue;
            }
        }
        if !sc.disabled {
            started.push(name.clone());
        }
        cfg.servers.insert(name.clone(), sc);
        owned.push(name);
        changed = true;
    }
    if changed {
        cfg.save(&state.mcp_config_path).map_err(e)?;
        state.mcp.set_config(&cfg).await;
        for n in &started {
            state.mcp.start(n).await;
        }
    }
    state.plugins.update_entry(id, |e| e.mcp_servers = owned).map_err(e)?;
    Ok(())
}

async fn sync_all_plugin_mcp(state: &AppState) {
    for p in state.plugins.registry().plugins {
        if let Err(err) = sync_plugin_mcp(state, &p.id).await {
            eprintln!("plugin connectors for {}: {err}", p.name);
        }
    }
}

#[tauri::command]
fn plugins_list(state: State<'_, Arc<AppState>>) -> Vec<PluginView> {
    let mut v: Vec<PluginView> = state.plugins.registry().plugins.into_iter().map(plugin_view).collect();
    v.sort_by(|a, b| a.plugin.name.to_lowercase().cmp(&b.plugin.name.to_lowercase()));
    v
}

#[tauri::command]
async fn plugin_inspect(spec: String) -> Res<plugins::Offer> {
    plugins::inspect(&spec).await.map_err(e)
}

#[tauri::command]
async fn plugin_install(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, spec: String, names: Vec<String>) -> Res<Vec<String>> {
    let offer = plugins::inspect(&spec).await.map_err(e)?;
    let mut done = vec![];
    for it in offer.items.into_iter().filter(|i| names.contains(&i.name)) {
        let src = it.source.ok_or_else(|| format!("{}: {}", it.name, it.note.unwrap_or_default()))?;
        let p = state.plugins.install(&it.name, src).await.map_err(e)?;
        sync_plugin_mcp(&state, &p.id).await?;
        done.push(p.name);
    }
    let _ = app.emit("plugins-changed", ());
    Ok(done)
}

#[tauri::command]
async fn plugin_remove(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    state.plugins.update_entry(&id, |p| p.enabled = false).map_err(e)?;
    sync_plugin_mcp(&state, &id).await?;
    state.plugins.remove(&id).map_err(e)?;
    let _ = app.emit("plugins-changed", ());
    Ok(())
}

#[tauri::command]
async fn plugin_set(state: State<'_, Arc<AppState>>, id: String, enabled: Option<bool>, auto_update: Option<bool>, hooks: Option<bool>) -> Res<()> {
    state
        .plugins
        .update_entry(&id, |p| {
            p.enabled = enabled.unwrap_or(p.enabled);
            p.auto_update = auto_update.unwrap_or(p.auto_update) && p.repo_dir.is_some();
            p.hooks = hooks.unwrap_or(p.hooks) && !p.user_scope;
        })
        .map_err(e)?;
    sync_plugin_mcp(&state, &id).await
}

#[tauri::command]
async fn plugin_update(state: State<'_, Arc<AppState>>, id: String) -> Res<Option<bool>> {
    let r = state.plugins.update(&id, true).await.map_err(e)?;
    sync_plugin_mcp(&state, &id).await?;
    Ok(r)
}

#[tauri::command]
async fn plugin_rollback(state: State<'_, Arc<AppState>>, id: String) -> Res<()> {
    state.plugins.rollback(&id).await.map_err(e)?;
    sync_plugin_mcp(&state, &id).await
}

#[tauri::command]
async fn plugins_update_all(state: State<'_, Arc<AppState>>) -> Res<Vec<String>> {
    let changed = state.plugins.update_all().await;
    sync_all_plugin_mcp(&state).await;
    Ok(changed)
}

#[tauri::command]
async fn plugins_import_candidates(state: State<'_, Arc<AppState>>) -> Res<Vec<plugins::Candidate>> {
    Ok(plugins::import_candidates(&state.plugins.registry()).await)
}

#[tauri::command]
async fn plugins_import(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, keys: Vec<String>) -> Res<Vec<String>> {
    let mut done = vec![];
    for c in plugins::import_candidates(&state.plugins.registry()).await.into_iter().filter(|c| keys.contains(&c.key)) {
        let p = plugins::import(&state.plugins, &c).await.map_err(e)?;
        sync_plugin_mcp(&state, &p.id).await?;
        done.push(p.name);
    }
    let _ = app.emit("plugins-changed", ());
    Ok(done)
}

#[tauri::command]
fn slash_commands(state: State<'_, Arc<AppState>>) -> Vec<plugins::Component> {
    state.plugins.index().to_vec()
}

#[tauri::command]
fn slash_expand(state: State<'_, Arc<AppState>>, name: String, args: String) -> Res<String> {
    let c = state.plugins.find(&name).ok_or_else(|| format!("No command /{name}"))?;
    plugins::render(&c, &args).map_err(e)
}

/// What enabled plugins' SessionStart hooks add to a new chat (shown in Settings).
#[tauri::command]
async fn plugin_context_preview(state: State<'_, Arc<AppState>>) -> Res<String> {
    Ok(state.plugins.session_context(&format!("preview-{}", db::new_id()), true).await)
}

/// First run: install Ponytail and import the user's Claude plugins. Test profiles
/// (OPENCLAUDE_DATA_DIR) skip this unless OPENCLAUDE_PLUGIN_SEED=1.
async fn seed_plugins(state: &Arc<AppState>, app: &tauri::AppHandle) {
    if state.plugins.registry_path().exists() {
        return;
    }
    if std::env::var_os("OPENCLAUDE_DATA_DIR").is_some() && std::env::var("OPENCLAUDE_PLUGIN_SEED").as_deref() != Ok("1") {
        return;
    }
    let mut names = vec![];
    if let Ok(offer) = plugins::inspect(plugins::PONYTAIL).await {
        for it in offer.items {
            if let Some(src) = it.source {
                match state.plugins.install(&it.name, src).await {
                    Ok(p) => names.push(p.name),
                    Err(err) => eprintln!("seed {}: {err}", it.name),
                }
            }
        }
    }
    for c in plugins::import_candidates(&state.plugins.registry()).await.into_iter().filter(|c| !c.imported) {
        match plugins::import(&state.plugins, &c).await {
            Ok(p) => names.push(p.name),
            Err(err) => eprintln!("import {}: {err}", c.name),
        }
    }
    if !state.plugins.registry_path().exists() {
        let _ = state.plugins.save(&plugins::Registry::default());
    }
    sync_all_plugin_mcp(state).await;
    if !names.is_empty() {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title("Plugins ready").body(format!("Added {} plugins, including Ponytail and your Claude plugins. Manage them in Settings → Plugins.", names.len())).show();
        let _ = app.emit("plugins-changed", ());
    }
}

/// Keeps GitHub plugins current: checks shortly after start, then every 15 minutes.
fn start_plugin_updater(state: Arc<AppState>, app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        seed_plugins(&state, &app).await;
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            let changed = state.plugins.update_all().await;
            if !changed.is_empty() {
                sync_all_plugin_mcp(&state).await;
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification().builder().title("Plugins updated").body(changed.join(", ")).show();
                let _ = app.emit("plugins-changed", ());
            }
            tokio::time::sleep(plugins::CHECK_EVERY).await;
        }
    });
}

// ---------- Chrome extension bridge

static CHROME_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Token and listener are backend-owned; the UI can only read them to show the pairing details.
fn start_chrome_bridge(state: &AppState) {
    if CHROME_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let token = {
        let db = state.db.lock().unwrap();
        db.get_setting("chrome_bridge_token").unwrap_or_else(|| {
            let t = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            let _ = db.set_setting("chrome_bridge_token", &t);
            t
        })
    };
    tauri::async_runtime::spawn(async move {
        if let Err(err) = chrome_bridge::serve(chrome_bridge::DEFAULT_PORT, token).await {
            eprintln!("chrome bridge stopped: {err}");
            CHROME_STARTED.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    });
}

#[derive(Serialize)]
struct ChromeBridgeInfo {
    enabled: bool,
    port: u16,
    token: Option<String>,
    connected: Option<String>,
}

#[tauri::command]
async fn chrome_bridge_info(state: State<'_, Arc<AppState>>) -> Res<ChromeBridgeInfo> {
    let (enabled, token) = {
        let db = state.db.lock().unwrap();
        (db.get_setting("chrome_extension_enabled").as_deref() == Some("true"), db.get_setting("chrome_bridge_token"))
    };
    Ok(ChromeBridgeInfo { enabled, port: chrome_bridge::DEFAULT_PORT, token: enabled.then_some(token).flatten(), connected: chrome_bridge::connected().await })
}

#[tauri::command]
async fn chrome_bridge_enable(state: State<'_, Arc<AppState>>, on: bool) -> Res<()> {
    state.db.lock().unwrap().set_setting("chrome_extension_enabled", if on { "true" } else { "false" }).map_err(e)?;
    if on {
        start_chrome_bridge(&state);
    }
    Ok(())
}

// ---------- voice

/// Dictation: gateway STT when `stt_model` is set, otherwise local faster-whisper.
#[tauri::command]
async fn voice_transcribe(state: State<'_, Arc<AppState>>, audio_b64: String, mime: String) -> Res<String> {
    use base64::Engine;
    let audio = base64::engine::general_purpose::STANDARD.decode(audio_b64).map_err(e)?;
    let stt = state.db.lock().unwrap().get_setting("stt_model").filter(|s| !s.trim().is_empty());
    let gw = state.gateway.read().await.clone();
    let work_dir = state.mcp_config_path.parent().map(|p| p.join("voice")).ok_or("no data dir")?;
    voice::transcribe(&gw, stt.as_deref(), audio, &mime, &work_dir).await.map_err(|err| format!("{err:#}"))
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
    if matches!(id.as_str(), "zoom_in" | "zoom_out" | "zoom_reset" | "quick_entry" | "quit") {
        shell::on_menu(&app, &tauri::menu::MenuEvent { id: tauri::menu::MenuId::new(id) });
    }
}

/// Quick Entry recents: jump to an existing chat in the main window.
#[tauri::command]
fn quick_entry_open(app: tauri::AppHandle, conversation_id: String) -> Res<()> {
    if let Some(q) = app.get_webview_window(shell::QUICK) {
        let _ = q.hide();
    }
    shell::show_main(&app);
    app.emit_to("main", "open-chat", conversation_id).map_err(e)
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
        // single-instance must be first; with its deep-link feature, links opened while the
        // app runs are forwarded to this instance's on_open_url handler.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::new().with_denylist(&[shell::QUICK]).build())
        .register_uri_scheme_protocol("artifact", |ctx, req| serve_artifact(ctx.app_handle(), &req))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Run-on-login is off until the user enables it in Settings; starts minimized to the tray.
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .setup(|app| {
            // OPENCLAUDE_DATA_DIR isolates test runs from the user's real profile.
            let data_dir = match std::env::var_os("OPENCLAUDE_DATA_DIR") {
                Some(d) => std::path::PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            diag::init(&data_dir);
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
                pending_ext: Default::default(),
                running_tasks: Default::default(),
                plugins: plugins::Plugins::new(data_dir.join("plugins")),
            });
            app.manage(state.clone());
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let h = app.handle().clone();
                app.deep_link().on_open_url(move |ev| {
                    for url in ev.urls() {
                        shell::handle_deep_link(&h, url.as_str());
                    }
                });
                // Launch via a link (app not yet running): the URL arrives as a start argument.
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        shell::handle_deep_link(app.handle(), url.as_str());
                    }
                }
            }
            shell::build_tray(app.handle())?;
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            tasks::start_scheduler(state.clone(), app.handle().clone());
            start_plugin_updater(state.clone(), app.handle().clone());
            start_sync(state.clone(), app.handle().clone());
            if state.db.lock().unwrap().get_setting("chrome_extension_enabled").as_deref() == Some("true") {
                start_chrome_bridge(&state);
            }
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
            project_files,
            project_add_files,
            project_remove_file,
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
            mcp_authorize,
            mcp_sign_out,
            mcp_import_candidates,
            mcp_import,
            registry_search,
            extension_pick,
            tasks_list,
            task_save,
            task_delete,
            task_run_now,
            extension_install,
            pick_attachments,
            artifact_put,
            artifact_save,
            quick_entry_open,
            pick_workspace,
            list_workspaces,
            worktree_list,
            worktree_add,
            worktree_remove,
            preview_open,
            code_start,
            code_send,
            code_approve,
            code_stop,
            git_status,
            git_diff,
            ssh_hosts,
            remote_list,
            remote_add,
            remote_check,
            app_info,
            probe_model,
            get_probes,
            quick_entry_toggle,
            voice_transcribe,
            chrome_bridge_info,
            chrome_bridge_enable,
            plugins_list,
            plugin_inspect,
            plugin_install,
            plugin_remove,
            plugin_set,
            plugin_update,
            plugin_rollback,
            plugins_update_all,
            plugins_import_candidates,
            plugins_import,
            slash_commands,
            slash_expand,
            plugin_context_preview,
            sync_status,
            devices_info,
            provider_presets,
            report_error,
            diagnostics,
            clear_errors,
            self_test,
            diag_fix,
            diag_report,
            diag_pick_repo,
            providers_list,
            provider_save,
            provider_remove,
            device_boot,
            device_create,
            device_presets,
            device_preview_open,
            device_preview_set,
            device_preview_input,
            device_preview_nav,
            device_preview_info,
            device_preview_close,
            sync_now,
            sync_choose_folder,
            sync_off,
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
                        browser::shutdown().await;
                    });
                }
            }
        });
}
