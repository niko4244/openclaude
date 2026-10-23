//! Opt-in capability probe: measures what a model alias actually does through
//! the gateway, because most aliases declare nothing. A plain HTTP 200 is not
//! enough; each check validates the response content.

use crate::gateway::Gateway;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub ms: u64,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ProbeReport {
    pub model: String,
    pub at_ms: i64,
    pub served_model: Option<String>,
    pub checks: Vec<Check>,
}

impl ProbeReport {
    pub fn passed(&self, name: &str) -> Option<bool> {
        self.checks.iter().find(|c| c.name == name).map(|c| c.ok)
    }
}

// 8x8 red PNG.
const RED_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x01, 0x03, 0x00, 0x00, 0x00, 0xfe, 0xc1, 0x2c,
    0xc8, 0x00, 0x00, 0x00, 0x06, 0x50, 0x4c, 0x54, 0x45, 0xff, 0x00, 0x00, 0xff, 0xff, 0xff, 0x41,
    0x1d, 0x34, 0x11, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0xc0,
    0x05, 0x00, 0x00, 0x18, 0x00, 0x01, 0xcd, 0x20, 0x66, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

async fn one(gw: &Gateway, model: &str, msgs: Vec<Value>, tools: Option<Vec<Value>>, extra: Option<Value>) -> (Result<crate::gateway::Completion, String>, u64) {
    let cancel = tokio::sync::Notify::new();
    let t = std::time::Instant::now();
    let fut = gw.stream_chat(model, &msgs, tools.as_deref(), extra.as_ref(), &cancel, |_| {});
    let r = match tokio::time::timeout(std::time::Duration::from_secs(90), fut).await {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(_) => Err("timed out after 90s".into()),
    };
    (r, t.elapsed().as_millis() as u64)
}

pub async fn probe(gw: &Gateway, model: &str) -> ProbeReport {
    let mut rep = ProbeReport { model: model.into(), at_ms: crate::db::now_ms(), ..Default::default() };
    let mut push = |name: &str, ok: bool, ms: u64, detail: String| {
        rep.checks.push(Check { name: name.into(), ok, ms, detail: detail.chars().take(200).collect() })
    };

    // chat + streaming
    let (r, ms) = one(gw, model, vec![json!({"role":"user","content":"Reply with exactly: pong"})], None, None).await;
    match r {
        Ok(c) => {
            rep.served_model = c.served_model.clone();
            push("chat", c.content.to_lowercase().contains("pong"), ms, c.content.clone());
            push("streaming", c.ttft_ms.is_some(), c.ttft_ms.unwrap_or(0), format!("ttft {:?} ms", c.ttft_ms));
        }
        Err(e) => {
            push("chat", false, ms, e);
            return rep; // nothing else will work
        }
    }

    // system prompt adherence
    let (r, ms) = one(gw, model, vec![
        json!({"role":"system","content":"Always answer with the single word BANANA, whatever the user says."}),
        json!({"role":"user","content":"What is 2+2?"}),
    ], None, None).await;
    match r {
        Ok(c) => push("system", c.content.to_uppercase().contains("BANANA"), ms, c.content),
        Err(e) => push("system", false, ms, e),
    }

    // tool calling
    let tool = json!({"type":"function","function":{"name":"get_weather","description":"Get current weather for a city",
        "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}});
    let (r, ms) = one(gw, model, vec![json!({"role":"user","content":"What's the weather in Paris? Use the tool."})], Some(vec![tool]), None).await;
    match r {
        Ok(c) => {
            let ok = c.tool_calls.iter().any(|t| {
                t.name == "get_weather" && serde_json::from_str::<Value>(&t.arguments).ok().and_then(|a| a.get("city").cloned()).is_some()
            });
            push("tools", ok, ms, format!("{:?}", c.tool_calls.iter().map(|t| format!("{}({})", t.name, t.arguments)).collect::<Vec<_>>()));
        }
        Err(e) => push("tools", false, ms, e),
    }

    // structured JSON
    let (r, ms) = one(gw, model, vec![json!({"role":"user","content":"Return a JSON object with keys \"a\" (number 1) and \"b\" (string \"x\"). JSON only."})],
        None, Some(json!({"response_format": {"type": "json_object"}}))).await;
    match r {
        Ok(c) => {
            let body = c.content.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim().to_string();
            let ok = serde_json::from_str::<Value>(&body).ok().is_some_and(|v| v.get("a").is_some() && v.get("b").is_some());
            push("json", ok, ms, c.content);
        }
        Err(e) => push("json", false, ms, e),
    }

    // vision
    let (r, ms) = one(gw, model, vec![json!({"role":"user","content":[
        {"type":"text","text":"What single color fills this image? Answer with one word."},
        {"type":"image_url","image_url":{"url": format!("data:image/png;base64,{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, RED_PNG))}}
    ]})], None, None).await;
    match r {
        Ok(c) => push("vision", c.content.to_lowercase().contains("red"), ms, c.content),
        Err(e) => push("vision", false, ms, e),
    }
    rep
}

#[cfg(test)]
mod tests {
    #[test]
    fn vision_fixture_is_a_png() {
        assert_eq!(&super::RED_PNG[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    /// OPENCLAUDE_LITELLM_KEY=... OC_LIVE_MODELS=a,b cargo test live_probe -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_probe() {
        let gw = crate::gateway::Gateway::new(
            &std::env::var("OPENCLAUDE_GATEWAY_URL").unwrap_or_else(|_| "http://127.0.0.1:4000".into()),
            std::env::var("OPENCLAUDE_LITELLM_KEY").ok(),
        );
        let models = std::env::var("OC_LIVE_MODELS").unwrap_or_else(|_| "qwen-local".into());
        for m in models.split(',') {
            let r = super::probe(&gw, m).await;
            let line: Vec<String> = r.checks.iter().map(|c| format!("{}={}({}ms)", c.name, if c.ok { "ok" } else { "FAIL" }, c.ms)).collect();
            println!("PROBE {m}: {}", line.join(" "));
            if let Some(c) = r.checks.iter().find(|c| !c.ok) {
                println!("      first failure [{}]: {}", c.name, c.detail);
            }
        }
    }
}
