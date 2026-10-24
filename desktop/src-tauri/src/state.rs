use crate::chat::Run;
use crate::db::Db;
use crate::gateway::{Gateway, ModelEntry};
use crate::mcp::McpManager;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::{RwLock, oneshot};

pub const KEYRING_SERVICE: &str = "openclaude-desktop";
pub const KEYRING_USER: &str = "litellm-api-key";
pub const DEFAULT_GATEWAY: &str = "http://127.0.0.1:4000";

pub struct AppState {
    pub db: Mutex<Db>,
    pub gateway: RwLock<Gateway>,
    pub models: RwLock<Vec<ModelEntry>>,
    pub mcp: McpManager,
    pub runs: Mutex<HashMap<String, Arc<Run>>>,
    /// request_id -> (allow, scope) where scope is "once" | "chat" | "always"
    pub approvals: Mutex<HashMap<String, oneshot::Sender<(bool, String)>>>,
    /// (conversation_id, tool) pairs allowed for the rest of that chat ("Allow for this chat"); not persisted.
    pub chat_allows: Mutex<std::collections::HashSet<(String, String)>>,
    pub mcp_config_path: PathBuf,
    /// Untrusted HTML served on the isolated `artifact:` origin.
    pub artifacts: Mutex<HashMap<String, String>>,
    pub code: crate::agent::CodeSessions,
    pub zoom: Mutex<f64>,
    /// Bundles picked in the native dialog, keyed by an opaque token (the UI never sends paths).
    pub pending_ext: Mutex<HashMap<String, PathBuf>>,
    pub running_tasks: Mutex<std::collections::HashSet<String>>,
    pub plugins: crate::plugins::Plugins,
    /// Prompt library collections (same installer, own registry under `<data>/prompts`).
    pub prompts: crate::plugins::Plugins,
}

/// OS credential store first, then environment. Never read from or written to logs.
pub fn resolve_api_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|k| !k.is_empty())
        .or_else(|| std::env::var("OPENCLAUDE_LITELLM_KEY").ok())
        .or_else(|| std::env::var("LITELLM_API_KEY").ok())
        .or_else(|| std::env::var("LITELLM_MASTER_KEY").ok())
        .filter(|k| !k.is_empty())
}

pub fn store_api_key(key: &str) -> anyhow::Result<()> {
    let e = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    if key.is_empty() {
        let _ = e.delete_credential();
    } else {
        e.set_password(key)?;
    }
    Ok(())
}
