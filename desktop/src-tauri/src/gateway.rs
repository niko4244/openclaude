//! LiteLLM gateway client (and any OpenAI-compatible endpoint): catalog discovery and streaming
//! chat completions.
//!
//! Metadata is reported exactly as the gateway returns it; anything the gateway
//! does not declare stays `None` ("unknown") rather than being guessed.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Gateway {
    pub base_url: String,
    pub api_key: Option<String>,
    http: reqwest::Client,
    /// An OpenAI-compatible base that already includes its version path (`.../v1`); no LiteLLM extras.
    compat: bool,
    headers: Vec<(String, String)>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ModelEntry {
    /// Alias the user selects and the router receives.
    pub id: String,
    /// Provider family derived from the backend route (e.g. `ollama`, `groq`).
    pub provider: String,
    /// Backend model string LiteLLM routes the alias to (no credentials).
    pub backend_model: Option<String>,
    /// Host of the backend api_base, if declared (no path, no credentials).
    pub backend_host: Option<String>,
    pub local: bool,
    pub max_input_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub input_cost_per_mtok: Option<f64>,
    pub output_cost_per_mtok: Option<f64>,
    pub supports_tools: Option<bool>,
    pub supports_vision: Option<bool>,
    pub supports_reasoning: Option<bool>,
    pub supports_json: Option<bool>,
    pub mode: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GatewayStatus {
    pub reachable: bool,
    pub authenticated: bool,
    pub base_url: String,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

/// Events streamed to the UI while a completion runs.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Delta {
    Text { text: String },
    Reasoning { text: String },
    ToolCallDelta { index: usize, id: Option<String>, name: Option<String> },
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Completion {
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    /// Model string reported in the response body (what actually served it).
    pub served_model: Option<String>,
    /// LiteLLM routing headers, if present.
    pub resolved_api_base: Option<String>,
    pub resolved_model_id: Option<String>,
    pub attempted_fallbacks: Option<String>,
    pub response_cost: Option<f64>,
    pub usage: Option<Value>,
    pub cancelled: bool,
    pub ttft_ms: Option<u64>,
    pub total_ms: u64,
}

fn host_of(api_base: &str) -> Option<String> {
    url::Url::parse(api_base).ok().and_then(|u| u.host_str().map(str::to_string))
}

fn is_local_host(host: &str) -> bool {
    matches!(
        host,
        "localhost" | "127.0.0.1" | "::1" | "0.0.0.0" | "host.containers.internal" | "host.docker.internal"
    ) || host.ends_with(".localhost")
}

/// Normalize one `/model/info` record. Pure, so it is unit-testable.
pub fn normalize_model_info(rec: &Value) -> Option<ModelEntry> {
    let id = rec.get("model_name")?.as_str()?.to_string();
    let params = rec.get("litellm_params").cloned().unwrap_or(Value::Null);
    let info = rec.get("model_info").cloned().unwrap_or(Value::Null);
    let backend_model = params.get("model").and_then(Value::as_str).map(str::to_string);
    let backend_host = params.get("api_base").and_then(Value::as_str).and_then(host_of);
    let route_provider = backend_model
        .as_deref()
        .and_then(|m| m.split_once('/').map(|(p, _)| p.to_string()));
    let declared_provider = info.get("litellm_provider").and_then(Value::as_str).map(str::to_string);
    let provider = declared_provider
        .or(route_provider)
        .unwrap_or_else(|| "unknown".to_string());
    let local = backend_host.as_deref().map(is_local_host).unwrap_or(false)
        || matches!(provider.as_str(), "ollama" | "ollama_chat" | "lm_studio" | "llamafile");
    let b = |k: &str| info.get(k).and_then(Value::as_bool);
    let u = |k: &str| info.get(k).and_then(Value::as_u64);
    let per_m = |k: &str| info.get(k).and_then(Value::as_f64).map(|c| c * 1_000_000.0);
    Some(ModelEntry {
        id,
        provider,
        backend_model,
        backend_host,
        local,
        max_input_tokens: u("max_input_tokens").or_else(|| u("max_tokens")),
        max_output_tokens: u("max_output_tokens"),
        input_cost_per_mtok: per_m("input_cost_per_token"),
        output_cost_per_mtok: per_m("output_cost_per_token"),
        supports_tools: b("supports_function_calling"),
        supports_vision: b("supports_vision"),
        supports_reasoning: b("supports_reasoning"),
        supports_json: b("supports_response_schema"),
        mode: info.get("mode").and_then(Value::as_str).map(str::to_string),
    })
}

/// Merge streamed tool-call fragments keyed by `index`.
pub fn merge_tool_call_delta(calls: &mut Vec<ToolCall>, frag: &Value) -> (usize, Option<String>, Option<String>) {
    let index = frag.get("index").and_then(Value::as_u64).unwrap_or(calls.len() as u64) as usize;
    while calls.len() <= index {
        calls.push(ToolCall::default());
    }
    let call = &mut calls[index];
    let id = frag.get("id").and_then(Value::as_str).map(str::to_string);
    if let Some(id) = &id {
        call.id = id.clone();
    }
    let f = frag.get("function");
    let name = f.and_then(|f| f.get("name")).and_then(Value::as_str).map(str::to_string);
    if let Some(n) = &name {
        call.name.push_str(n);
    }
    if let Some(a) = f.and_then(|f| f.get("arguments")).and_then(Value::as_str) {
        call.arguments.push_str(a);
    }
    (index, id, name)
}

impl Gateway {
    pub fn new(base_url: &str, api_key: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("http client");
        Self { base_url: base_url.trim_end_matches('/').to_string(), api_key, http, compat: false, headers: vec![] }
    }

    /// Any OpenAI-compatible API (`base_url` like `https://api.openai.com/v1`).
    pub fn openai_compatible(base_url: &str, api_key: Option<String>, headers: Vec<(String, String)>) -> Self {
        Self { compat: true, headers, ..Self::new(base_url, api_key) }
    }

    /// Base URL for OpenAI clients (the Code tab's CLI).
    pub fn openai_base(&self) -> String {
        if self.compat { self.base_url.clone() } else { format!("{}/v1", self.base_url) }
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let path = if self.compat { path.strip_prefix("/v1").unwrap_or(path) } else { path };
        let mut r = self.http.request(method, format!("{}{}", self.base_url, path));
        for (k, v) in &self.headers {
            r = r.header(k, v);
        }
        match &self.api_key {
            Some(k) if !k.is_empty() => r.bearer_auth(k),
            _ => r,
        }
    }

    pub async fn status(&self) -> GatewayStatus {
        let t = Instant::now();
        let live = self
            .req(reqwest::Method::GET, if self.compat { "/models" } else { "/health/liveliness" })
            .timeout(Duration::from_secs(5))
            .send()
            .await;
        let mut st = GatewayStatus {
            reachable: false,
            authenticated: false,
            base_url: self.base_url.clone(),
            latency_ms: None,
            error: None,
        };
        match live {
            Ok(r) if r.status().is_success() => {
                st.reachable = true;
                st.latency_ms = Some(t.elapsed().as_millis() as u64);
                if self.compat {
                    st.authenticated = true;
                    return st;
                }
            }
            Ok(r) if self.compat && matches!(r.status().as_u16(), 401 | 403) => {
                st.reachable = true;
                st.error = Some(format!("the provider rejected the API key (HTTP {})", r.status()));
                return st;
            }
            Ok(r) => st.error = Some(format!("{} returned HTTP {}", if self.compat { "/models" } else { "liveliness" }, r.status())),
            Err(e) => st.error = Some(format!("gateway unreachable: {e}")),
        }
        if st.reachable {
            match self.req(reqwest::Method::GET, "/v1/models").timeout(Duration::from_secs(10)).send().await {
                Ok(r) if r.status().is_success() => st.authenticated = true,
                Ok(r) if r.status().as_u16() == 401 => {
                    st.error = Some("gateway rejected the API key (401)".into())
                }
                Ok(r) => st.error = Some(format!("/v1/models returned HTTP {}", r.status())),
                Err(e) => st.error = Some(e.to_string()),
            }
        }
        st
    }

    /// Full catalog: `/model/info` when allowed (rich metadata), else `/v1/models` ids only.
    pub async fn models(&self) -> anyhow::Result<Vec<ModelEntry>> {
        let info = if self.compat { None } else { Some(self.req(reqwest::Method::GET, "/model/info").timeout(Duration::from_secs(20)).send().await) };
        if let Some(Ok(r)) = info {
            if r.status().is_success() {
                let v: Value = r.json().await?;
                let mut out: Vec<ModelEntry> = v
                    .get("data")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(normalize_model_info).collect())
                    .unwrap_or_default();
                // /model/info lists each deployment; collapse duplicates of one alias.
                out.sort_by(|a, b| a.id.cmp(&b.id));
                out.dedup_by(|a, b| a.id == b.id);
                return Ok(out);
            }
        }
        let r = self.req(reqwest::Method::GET, "/v1/models").timeout(Duration::from_secs(20)).send().await?;
        let r = r.error_for_status()?;
        let v: Value = r.json().await?;
        Ok(v.get("data")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|m| m.get("id").and_then(Value::as_str))
                    .map(|id| ModelEntry { id: id.into(), provider: "unknown".into(), ..Default::default() })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Stream a chat completion. `on_delta` receives incremental output;
    /// `cancel` aborts promptly (the partial completion is still returned).
    pub async fn stream_chat(
        &self,
        model: &str,
        messages: &[Value],
        tools: Option<&[Value]>,
        extra: Option<&Value>,
        cancel: &tokio::sync::Notify,
        mut on_delta: impl FnMut(Delta),
    ) -> anyhow::Result<Completion> {
        let t0 = Instant::now();
        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        if let Some(tools) = tools.filter(|t| !t.is_empty()) {
            body["tools"] = Value::Array(tools.to_vec());
        }
        if let Some(Value::Object(extra)) = extra {
            for (k, v) in extra {
                body[k] = v.clone();
            }
        }
        let send = self.req(reqwest::Method::POST, "/v1/chat/completions").json(&body).send();
        let resp = tokio::select! {
            r = send => r?,
            _ = cancel.notified() => return Ok(Completion { cancelled: true, total_ms: t0.elapsed().as_millis() as u64, ..Default::default() }),
        };
        let hdr = |k: &str| resp.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
        let mut out = Completion {
            resolved_api_base: hdr("x-litellm-model-api-base").as_deref().and_then(host_of),
            resolved_model_id: hdr("x-litellm-model-id"),
            attempted_fallbacks: hdr("x-litellm-attempted-fallbacks"),
            response_cost: hdr("x-litellm-response-cost").and_then(|c| c.parse().ok()),
            ..Default::default()
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
                .unwrap_or(text);
            anyhow::bail!("HTTP {status}: {}", msg.chars().take(800).collect::<String>());
        }
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        'outer: loop {
            let chunk = tokio::select! {
                c = stream.next() => c,
                _ = cancel.notified() => { out.cancelled = true; break 'outer; }
            };
            let Some(chunk) = chunk else { break };
            buf.push_str(&String::from_utf8_lossy(&chunk?));
            while let Some(pos) = buf.find('\n') {
                let line = buf[..pos].trim().to_string();
                buf.drain(..=pos);
                let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
                if data == "[DONE]" {
                    break 'outer;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                if let Some(err) = v.get("error") {
                    anyhow::bail!("stream error: {}", err.get("message").and_then(Value::as_str).unwrap_or("unknown"));
                }
                if let Some(m) = v.get("model").and_then(Value::as_str) {
                    out.served_model.get_or_insert_with(|| m.to_string());
                }
                if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                    out.usage = Some(u.clone());
                }
                let Some(choice) = v.pointer("/choices/0") else { continue };
                if let Some(fr) = choice.get("finish_reason").and_then(Value::as_str) {
                    out.finish_reason = Some(fr.to_string());
                }
                let Some(delta) = choice.get("delta") else { continue };
                if let Some(t) = delta.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    out.ttft_ms.get_or_insert(t0.elapsed().as_millis() as u64);
                    out.content.push_str(t);
                    on_delta(Delta::Text { text: t.to_string() });
                }
                let reasoning = delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning"))
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty());
                if let Some(t) = reasoning {
                    out.ttft_ms.get_or_insert(t0.elapsed().as_millis() as u64);
                    out.reasoning.push_str(t);
                    on_delta(Delta::Reasoning { text: t.to_string() });
                }
                if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                    for frag in calls {
                        let (index, id, name) = merge_tool_call_delta(&mut out.tool_calls, frag);
                        if id.is_some() || name.is_some() {
                            on_delta(Delta::ToolCallDelta { index, id, name });
                        }
                    }
                }
            }
        }
        out.tool_calls.retain(|c| !c.name.is_empty());
        for (i, c) in out.tool_calls.iter_mut().enumerate() {
            if c.id.is_empty() {
                c.id = format!("call_{i}_{}", uuid::Uuid::new_v4().simple());
            }
        }
        out.total_ms = t0.elapsed().as_millis() as u64;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_local_and_unknowns() {
        let rec = json!({
            "model_name": "qwen-local",
            "litellm_params": {"model": "ollama_chat/qwen3:8b", "api_base": "http://host.containers.internal:11434", "api_key": "sk-secret"},
            "model_info": {"max_input_tokens": 32768, "supports_function_calling": true}
        });
        let m = normalize_model_info(&rec).unwrap();
        assert_eq!(m.provider, "ollama_chat");
        assert!(m.local);
        assert_eq!(m.max_input_tokens, Some(32768));
        assert_eq!(m.supports_tools, Some(true));
        assert_eq!(m.supports_vision, None, "undeclared capability must stay unknown");
        assert!(!serde_json::to_string(&m).unwrap().contains("sk-secret"));
    }

    #[test]
    fn cloud_route_is_not_local() {
        let rec = json!({"model_name": "groq-x", "litellm_params": {"model": "groq/openai/gpt-oss-120b"}, "model_info": {}});
        let m = normalize_model_info(&rec).unwrap();
        assert_eq!(m.provider, "groq");
        assert!(!m.local);
    }

    /// Live acceptance against the real gateway. Run with:
    /// OPENCLAUDE_LITELLM_KEY=... OC_LIVE_MODELS=a,b cargo test live_ -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_gateway_catalog_stream_and_tools() {
        let base = std::env::var("OPENCLAUDE_GATEWAY_URL").unwrap_or_else(|_| "http://127.0.0.1:4000".into());
        let gw = Gateway::new(&base, std::env::var("OPENCLAUDE_LITELLM_KEY").ok());
        let st = gw.status().await;
        assert!(st.reachable && st.authenticated, "{st:?}");
        let models = gw.models().await.unwrap();
        println!("catalog: {} models, {} local", models.len(), models.iter().filter(|m| m.local).count());
        assert!(!models.is_empty());
        let wanted = std::env::var("OC_LIVE_MODELS").unwrap_or_else(|_| "qwen-local".into());
        let tool = json!({"type":"function","function":{"name":"get_weather","description":"Get the weather for a city",
            "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}});
        for model in wanted.split(',') {
            let cancel = tokio::sync::Notify::new();
            let mut deltas = 0;
            let c = gw
                .stream_chat(model, &[json!({"role":"user","content":"Reply with exactly: pong"})], None, None, &cancel, |_| deltas += 1)
                .await;
            match c {
                Ok(c) => println!(
                    "[{model}] chat ok deltas={deltas} ttft={:?}ms total={}ms served={:?} host={:?} text={:?}",
                    c.ttft_ms, c.total_ms, c.served_model, c.resolved_api_base, c.content.chars().take(60).collect::<String>()
                ),
                Err(e) => println!("[{model}] chat FAILED: {e}"),
            }
            let c = gw
                .stream_chat(model, &[json!({"role":"user","content":"What's the weather in Paris? Use the tool."})], Some(&[tool.clone()]), None, &cancel, |_| {})
                .await;
            match c {
                Ok(c) => println!("[{model}] tools: calls={:?} finish={:?}", c.tool_calls, c.finish_reason),
                Err(e) => println!("[{model}] tools FAILED: {e}"),
            }
        }
    }

    #[test]
    fn merges_fragmented_tool_calls() {
        let mut calls = vec![];
        merge_tool_call_delta(&mut calls, &json!({"index":0,"id":"c1","function":{"name":"read_","arguments":"{\"pa"}}));
        merge_tool_call_delta(&mut calls, &json!({"index":0,"function":{"name":"file","arguments":"th\":1}"}}));
        merge_tool_call_delta(&mut calls, &json!({"index":1,"id":"c2","function":{"name":"ls","arguments":"{}"}}));
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments, "{\"path\":1}");
        assert_eq!(calls[1].id, "c2");
    }
}
