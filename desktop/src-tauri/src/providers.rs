//! Model providers beyond the LiteLLM gateway: any OpenAI-compatible endpoint, with presets for
//! the common clouds and local servers. Keys live in the OS credential store; provider models
//! are offered as `<provider>::<model>` and routed to that provider.

use crate::db::Db;
use crate::gateway::{Gateway, GatewayStatus, ModelEntry};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Separates the provider id from its model id (model ids may themselves contain `/`).
pub const SEP: &str = "::";

#[derive(Serialize, Clone, Copy)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub needs_key: bool,
}

const fn p(id: &'static str, name: &'static str, base_url: &'static str, needs_key: bool) -> Preset {
    Preset { id, name, base_url, needs_key }
}

/// OpenAI-compatible endpoints of the common providers.
pub const PRESETS: &[Preset] = &[
    p("openai", "OpenAI", "https://api.openai.com/v1", true),
    p("anthropic", "Anthropic", "https://api.anthropic.com/v1", true),
    p("gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", true),
    p("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", true),
    p("groq", "Groq", "https://api.groq.com/openai/v1", true),
    p("mistral", "Mistral", "https://api.mistral.ai/v1", true),
    p("deepseek", "DeepSeek", "https://api.deepseek.com/v1", true),
    p("xai", "xAI", "https://api.x.ai/v1", true),
    p("together", "Together AI", "https://api.together.xyz/v1", true),
    p("fireworks", "Fireworks", "https://api.fireworks.ai/inference/v1", true),
    p("cerebras", "Cerebras", "https://api.cerebras.ai/v1", true),
    p("perplexity", "Perplexity", "https://api.perplexity.ai", true),
    p("nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1", true),
    p("ollama", "Ollama (local)", "http://127.0.0.1:11434/v1", false),
    p("lmstudio", "LM Studio (local)", "http://127.0.0.1:1234/v1", false),
    p("llamacpp", "llama.cpp server (local)", "http://127.0.0.1:8080/v1", false),
    p("vllm", "vLLM (local)", "http://127.0.0.1:8000/v1", false),
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub preset: Option<String>,
    pub enabled: bool,
}

pub fn load(db: &Db) -> Vec<Provider> {
    db.get_setting("providers").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(db: &Db, list: &[Provider]) -> anyhow::Result<()> {
    db.set_setting("providers", &serde_json::to_string(list)?)
}

fn key_entry(id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(crate::state::KEYRING_SERVICE, &format!("provider:{id}"))
}

pub fn has_key(id: &str) -> bool {
    key(id).is_some()
}

fn key(id: &str) -> Option<String> {
    key_entry(id).ok().and_then(|e| e.get_password().ok()).filter(|k| !k.is_empty())
}

/// Stores (or with an empty string, removes) a provider's key in the credential store.
pub fn set_key(id: &str, value: &str) -> anyhow::Result<()> {
    let e = key_entry(id)?;
    if value.is_empty() {
        let _ = e.delete_credential();
    } else {
        e.set_password(value)?;
    }
    Ok(())
}

/// A provider id: lowercase letters, digits and dashes (it prefixes model ids).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn valid_base_url(u: &str) -> bool {
    url::Url::parse(u).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
}

pub fn client(p: &Provider) -> Gateway {
    let k = key(&p.id);
    let anthropic = p.preset.as_deref() == Some("anthropic") || p.base_url.contains("api.anthropic.com");
    let mut headers = vec![];
    if anthropic {
        headers.push(("anthropic-version".to_string(), "2023-06-01".to_string()));
        if let Some(k) = &k {
            headers.push(("x-api-key".to_string(), k.clone()));
        }
    }
    Gateway::openai_compatible(&p.base_url, k, headers)
}

/// `openrouter::anthropic/claude-sonnet` -> ("openrouter", "anthropic/claude-sonnet").
pub fn split(model: &str) -> Option<(&str, &str)> {
    model.split_once(SEP).filter(|(p, m)| valid_id(p) && !m.is_empty())
}

/// The client and the model id to send for a model the user picked.
pub fn route(db: &Db, gateway: &Gateway, model: &str) -> (Gateway, String) {
    if let Some((pid, m)) = split(model) {
        if let Some(p) = load(db).into_iter().find(|p| p.id == pid && p.enabled) {
            return (client(&p), m.to_string());
        }
    }
    (gateway.clone(), model.to_string())
}

#[derive(Serialize, Clone, Debug)]
pub struct ProviderView {
    #[serde(flatten)]
    pub provider: Provider,
    pub has_key: bool,
    pub status: Option<GatewayStatus>,
    pub models: usize,
}

/// Provider models for the picker, plus each provider's status (unreachable ones are skipped).
pub async fn catalog(list: &[Provider]) -> (Vec<ModelEntry>, Vec<ProviderView>) {
    let futs = list.iter().map(|p| async move {
        if !p.enabled {
            return (vec![], ProviderView { provider: p.clone(), has_key: has_key(&p.id), status: None, models: 0 });
        }
        let c = client(p);
        let models = tokio::time::timeout(Duration::from_secs(20), c.models()).await.ok().and_then(Result::ok).unwrap_or_default();
        let status = if models.is_empty() { Some(c.status().await) } else { None };
        let host = url::Url::parse(&p.base_url).ok().and_then(|u| u.host_str().map(str::to_string));
        let local = host.as_deref().is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "::1") || h.ends_with(".localhost"));
        let entries: Vec<ModelEntry> = models
            .into_iter()
            .map(|m| ModelEntry { id: format!("{}{SEP}{}", p.id, m.id), provider: p.name.clone(), backend_model: Some(m.id), backend_host: host.clone(), local, ..Default::default() })
            .collect();
        let view = ProviderView { provider: p.clone(), has_key: has_key(&p.id), models: entries.len(), status };
        (entries, view)
    });
    let results = futures_util::future::join_all(futs).await;
    let mut all = vec![];
    let mut views = vec![];
    for (m, v) in results {
        all.extend(m);
        views.push(v);
    }
    (all, views)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_and_routes() {
        assert_eq!(split("openrouter::anthropic/claude-sonnet-4.5"), Some(("openrouter", "anthropic/claude-sonnet-4.5")));
        assert_eq!(split("qwen-local"), None);
        assert_eq!(split("Bad Id::x"), None);
        assert!(valid_id("my-ollama2") && !valid_id("My") && !valid_id(""));
        assert!(valid_base_url("http://127.0.0.1:11434/v1") && !valid_base_url("file:///c:/x") && !valid_base_url("nope"));
        assert!(PRESETS.iter().all(|p| valid_id(p.id) && valid_base_url(p.base_url)));

        let db = Db::open_in_memory().unwrap();
        let gw = Gateway::new("http://127.0.0.1:4000", None);
        save(&db, &[Provider { id: "local".into(), name: "Local".into(), base_url: "http://127.0.0.1:9/v1".into(), preset: None, enabled: true }]).unwrap();
        let (c, m) = route(&db, &gw, "local::llama3");
        assert_eq!((c.base_url.as_str(), m.as_str(), c.openai_base().as_str()), ("http://127.0.0.1:9/v1", "llama3", "http://127.0.0.1:9/v1"));
        let (c, m) = route(&db, &gw, "qwen-local");
        assert_eq!((c.openai_base().as_str(), m.as_str()), ("http://127.0.0.1:4000/v1", "qwen-local"));
        // a disabled or unknown provider falls back to the gateway (which will report the model as unknown)
        assert_eq!(route(&db, &gw, "other::x").1, "other::x");
    }

    /// A tiny OpenAI-compatible server: /models and a streamed /chat/completions.
    #[tokio::test]
    async fn openai_compatible_provider_lists_and_streams() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else { break };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let (ctype, body) = if req.starts_with("GET /v1/models") {
                        ("application/json", json!({"data": [{"id": "tiny-1"}, {"id": "org/tiny-2"}]}).to_string())
                    } else if req.starts_with("POST /v1/chat/completions") && req.contains("Bearer sk-test") {
                        ("text/event-stream", "data: {\"model\":\"tiny-1\",\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\ndata: [DONE]\n\n".to_string())
                    } else {
                        ("text/plain", "bad request".to_string())
                    };
                    let status = if ctype == "text/plain" { "400 Bad Request" } else { "200 OK" };
                    let _ = s.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
                });
            }
        });
        let base = format!("http://127.0.0.1:{port}/v1");
        let c = Gateway::openai_compatible(&base, Some("sk-test".into()), vec![]);
        let st = c.status().await;
        assert!(st.reachable && st.authenticated, "{st:?}");
        let ids: Vec<String> = c.models().await.unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["tiny-1", "org/tiny-2"]);
        let cancel = tokio::sync::Notify::new();
        let out = c.stream_chat("tiny-1", &[json!({"role": "user", "content": "ping"})], None, None, &cancel, |_| {}).await.unwrap();
        assert_eq!(out.content, "pong");
    }
}
