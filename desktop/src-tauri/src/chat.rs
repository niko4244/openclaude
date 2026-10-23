//! Conversation runtime: builds context, streams the model, and runs the
//! approval-gated MCP tool loop. Every turn is persisted, including partial
//! (cancelled) and failed ones.

use crate::db::{Message, now_ms};
use crate::gateway::{Delta, ToolCall};
use crate::state::AppState;
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::{Notify, oneshot};

const MAX_STEPS: usize = 25;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    Started { run_id: String },
    UserMessage { message: Message },
    Text { text: String },
    Reasoning { text: String },
    ToolCallDelta { index: usize, name: Option<String> },
    AssistantMessage { message: Message },
    ToolApproval { request_id: String, tool: String, server: String, arguments: Value },
    ToolResult { message: Message },
    Error { message: String },
    Done { cancelled: bool },
    /// Older turns were summarized to fit the model's context window.
    Compacted { summarized: usize },
}

pub struct Run {
    pub cancel: Notify,
}

pub struct SendArgs {
    pub conversation_id: String,
    pub content: Option<Value>,
    pub model: String,
    pub replace_from: Option<String>,
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Persisted messages -> OpenAI chat format.
pub fn to_wire(system: &str, history: &[Message]) -> Vec<Value> {
    let mut out = vec![];
    if !system.trim().is_empty() {
        out.push(json!({"role": "system", "content": system}));
    }
    for m in history {
        match m.role.as_str() {
            "user" => out.push(json!({"role": "user", "content": m.content})),
            "assistant" => {
                let text = text_of(&m.content);
                let calls = m.tool_calls.as_ref().and_then(Value::as_array).filter(|c| !c.is_empty());
                if text.is_empty() && calls.is_none() {
                    continue; // failed/empty turn: nothing for the model to see
                }
                let mut v = json!({"role": "assistant", "content": text});
                if let Some(calls) = calls {
                    v["tool_calls"] = Value::Array(
                        calls
                            .iter()
                            .map(|c| json!({"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}))
                            .collect(),
                    );
                }
                out.push(v);
            }
            "tool" => out.push(json!({"role": "tool", "tool_call_id": m.tool_call_id, "content": text_of(&m.content)})),
            _ => {}
        }
    }
    // A cancelled turn can leave tool calls without results; the API rejects that.
    let answered: std::collections::HashSet<String> = out
        .iter()
        .filter_map(|m| m.get("tool_call_id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut fixed = vec![];
    for m in out {
        let missing: Vec<String> = m
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|calls| {
                calls.iter().filter_map(|c| c["id"].as_str()).filter(|id| !answered.contains(*id)).map(str::to_string).collect()
            })
            .unwrap_or_default();
        fixed.push(m);
        for id in missing {
            fixed.push(json!({"role": "tool", "tool_call_id": id, "content": "Tool call was not executed (cancelled)."}));
        }
    }
    fixed
}

fn system_prompt(state: &AppState, conversation_id: &str, query: &str) -> String {
    let db = state.db.lock().unwrap();
    let mut parts = vec![format!(
        "You are a helpful assistant running inside OpenClaude Desktop. Current date: {}.\n\n\
         When you produce substantial standalone content the user will likely reuse or iterate on (a complete \
         web page, an SVG image, a document, or a program longer than about 20 lines), put it in one fenced code \
         block whose info string is the language followed by a short title, for example ```html title=\"Pricing page\". \
         Use language `markdown` for documents. When revising such content, reuse the same title. \
         Do not add a title to short snippets.",
        chrono_date()
    )];
    if let Some(g) = db.get_setting("system_prompt").filter(|s| !s.trim().is_empty()) {
        parts.push(g);
    }
    if let Ok(Some(c)) = db.get_conversation(conversation_id) {
        if let Some(pid) = c.project_id {
            if let Ok(Some(p)) = db.get_project(&pid) {
                if !p.instructions.trim().is_empty() {
                    parts.push(format!("Project \"{}\" instructions:\n{}", p.name, p.instructions));
                }
                if let Some(k) = db.project_docs(&p.id).ok().and_then(|d| crate::knowledge::context_for(&d, query)) {
                    parts.push(k);
                }
            }
        }
    }
    parts.join("\n\n")
}

fn chrono_date() -> String {
    // Days since epoch -> civil date (Howard Hinnant's algorithm); avoids a chrono dependency.
    let days = now_ms() / 86_400_000;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Where run events go: the UI's IPC channel, or a background task's collector.
#[derive(Clone)]
pub struct Sink {
    f: Arc<dyn Fn(ChatEvent) + Send + Sync>,
    /// false for background tasks: nobody can answer an approval prompt.
    pub interactive: bool,
}

impl Sink {
    pub fn channel(ch: Channel<ChatEvent>) -> Self {
        Self { f: Arc::new(move |e| { let _ = ch.send(e); }), interactive: true }
    }
    pub fn background(f: impl Fn(ChatEvent) + Send + Sync + 'static) -> Self {
        Self { f: Arc::new(f), interactive: false }
    }
    pub fn send(&self, e: ChatEvent) -> Result<(), ()> {
        (self.f)(e);
        Ok(())
    }
}

pub async fn run(state: Arc<AppState>, run_id: String, run: Arc<Run>, args: SendArgs, ch: Sink) {
    let _ = ch.send(ChatEvent::Started { run_id: run_id.clone() });
    let result = run_inner(&state, &run, &args, &ch).await;
    let cancelled = matches!(result, Ok(true));
    if let Err(e) = result {
        let _ = ch.send(ChatEvent::Error { message: e.to_string() });
    }
    state.runs.lock().unwrap().remove(&run_id);
    let _ = ch.send(ChatEvent::Done { cancelled });
}

/// Returns Ok(true) when cancelled.
async fn run_inner(state: &Arc<AppState>, run: &Run, args: &SendArgs, ch: &Sink) -> anyhow::Result<bool> {
    let cid = &args.conversation_id;
    {
        let db = state.db.lock().unwrap();
        let mut conv = db.get_conversation(cid)?.ok_or_else(|| anyhow::anyhow!("conversation not found"))?;
        if let Some(from) = &args.replace_from {
            db.supersede_from(cid, from)?;
        }
        if let Some(content) = &args.content {
            let mut m = Message { conversation_id: cid.clone(), role: "user".into(), content: content.clone(), ..Default::default() };
            db.insert_message(&mut m)?;
            let _ = ch.send(ChatEvent::UserMessage { message: m });
            if conv.title == "New chat" {
                let t: String = text_of(content).split_whitespace().collect::<Vec<_>>().join(" ");
                conv.title = if t.is_empty() { "Untitled".into() } else { t.chars().take(60).collect() };
            }
        }
        conv.model = Some(args.model.clone());
        conv.draft.clear();
        db.update_conversation(&conv)?;
    }

    let model_meta = state.models.read().await.iter().find(|m| m.id == args.model).cloned();
    let tools_enabled = state.db.lock().unwrap().get_setting("tools_enabled").as_deref() != Some("false");
    let probed_tools = state
        .db
        .lock()
        .unwrap()
        .get_setting(&format!("probe:{}", args.model))
        .and_then(|s| serde_json::from_str::<crate::probe::ProbeReport>(&s).ok())
        .and_then(|p| p.passed("tools"));
    // Declared or measured "no" wins; unknown still gets tools (the model may surprise us).
    let model_allows_tools = model_meta.as_ref().and_then(|m| m.supports_tools) != Some(false) && probed_tools != Some(false);
    let (disabled, thinking): (Vec<String>, bool) = {
        let db = state.db.lock().unwrap();
        (
            db.get_setting("mcp_disabled").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
            db.get_setting("extended_thinking").as_deref() == Some("true"),
        )
    };
    let tools: Vec<Value> = if tools_enabled && model_allows_tools {
        let allowed: Vec<String> = state.mcp.statuses().await.into_iter().map(|s| s.name).filter(|n| !disabled.contains(n)).collect();
        state.mcp.openai_tools(Some(&allowed)).await
    } else {
        vec![]
    };
    let extra = thinking.then(|| json!({"reasoning_effort": "high"}));
    let query = {
        let hist = state.db.lock().unwrap().messages(cid)?;
        hist.iter().rev().find(|m| m.role == "user").map(|m| text_of(&m.content)).unwrap_or_default()
    };
    let system = system_prompt(state, cid, &query);
    let gateway = state.gateway.read().await.clone();

    for _step in 0..MAX_STEPS {
        let history = state.db.lock().unwrap().messages(cid)?;
        let budget = model_meta.as_ref().and_then(|m| m.max_input_tokens).map(|t| t as usize * 3 / 4).unwrap_or(DEFAULT_BUDGET_TOKENS);
        let wire = match compaction_cut(&history, budget) {
            None => to_wire(&system, &history),
            Some(cut) => {
                let summary = summary_for(state, &gateway, &args.model, cid, &history[..cut]).await?;
                let _ = ch.send(ChatEvent::Compacted { summarized: cut });
                let sys = format!("{system}\n\nSummary of the earlier part of this conversation (older turns were compacted to fit the context window):\n{summary}");
                to_wire(&sys, &history[cut..])
            }
        };
        let ch2 = ch.clone();
        let res = gateway
            .stream_chat(&args.model, &wire, Some(&tools), extra.as_ref(), &run.cancel, |d| {
                let _ = ch2.send(match d {
                    Delta::Text { text } => ChatEvent::Text { text },
                    Delta::Reasoning { text } => ChatEvent::Reasoning { text },
                    Delta::ToolCallDelta { index, name, .. } => ChatEvent::ToolCallDelta { index, name },
                });
            })
            .await;

        let mut msg = Message {
            conversation_id: cid.clone(),
            role: "assistant".into(),
            model_requested: Some(args.model.clone()),
            ..Default::default()
        };
        let comp = match res {
            Ok(c) => c,
            Err(e) => {
                msg.content = Value::String(String::new());
                msg.status = "error".into();
                msg.error = Some(e.to_string());
                state.db.lock().unwrap().insert_message(&mut msg)?;
                let _ = ch.send(ChatEvent::AssistantMessage { message: msg });
                return Ok(false);
            }
        };
        msg.content = Value::String(comp.content.clone());
        msg.reasoning = Some(comp.reasoning.clone()).filter(|r| !r.is_empty());
        msg.model_served = comp.served_model.clone();
        msg.routed_host = comp.resolved_api_base.clone();
        msg.fallbacks = comp.attempted_fallbacks.clone().filter(|f| f != "0" && !f.is_empty());
        msg.usage = comp.usage.clone().map(|mut u| {
            u["ttft_ms"] = json!(comp.ttft_ms);
            u["total_ms"] = json!(comp.total_ms);
            u
        });
        msg.cost = comp.response_cost;
        let calls: Vec<ToolCall> = if comp.cancelled { vec![] } else { comp.tool_calls.clone() };
        if !calls.is_empty() {
            msg.tool_calls = Some(serde_json::to_value(&calls)?);
        }
        msg.status = if comp.cancelled { "cancelled".into() } else { "complete".into() };
        state.db.lock().unwrap().insert_message(&mut msg)?;
        let _ = ch.send(ChatEvent::AssistantMessage { message: msg });
        if comp.cancelled {
            return Ok(true);
        }
        if calls.is_empty() {
            return Ok(false);
        }

        for call in calls {
            let (text, is_error) = match execute_tool(state, run, cid, &call, ch).await {
                ToolOutcome::Cancelled => return Ok(true),
                ToolOutcome::Done(t, e) => (t, e),
            };
            let mut tm = Message {
                conversation_id: cid.clone(),
                role: "tool".into(),
                tool_call_id: Some(call.id.clone()),
                name: Some(call.name.clone()),
                content: Value::String(text),
                status: if is_error { "error".into() } else { "complete".into() },
                ..Default::default()
            };
            state.db.lock().unwrap().insert_message(&mut tm)?;
            let _ = ch.send(ChatEvent::ToolResult { message: tm });
        }
    }
    let _ = ch.send(ChatEvent::Error { message: format!("Stopped after {MAX_STEPS} tool steps.") });
    Ok(false)
}

/// Tokens assumed available when the gateway does not declare a context window.
const DEFAULT_BUDGET_TOKENS: usize = 24_000;

fn approx_tokens(m: &Message) -> usize {
    (text_of(&m.content).len() + m.tool_calls.as_ref().map(|t| t.to_string().len()).unwrap_or(0)) / 4 + 8
}

/// Index of the first message to keep verbatim, or None if everything fits.
/// Keeps the newest turns within half the budget and never starts on a tool result.
pub fn compaction_cut(history: &[Message], budget_tokens: usize) -> Option<usize> {
    let total: usize = history.iter().map(approx_tokens).sum();
    if total <= budget_tokens {
        return None;
    }
    let mut kept = 0;
    let mut cut = history.len();
    while cut > 0 && kept + approx_tokens(&history[cut - 1]) <= budget_tokens / 2 {
        cut -= 1;
        kept += approx_tokens(&history[cut]);
    }
    while cut < history.len() && history[cut].role != "user" {
        cut += 1;
    }
    (cut > 0 && cut < history.len()).then_some(cut)
}

/// Summary of `older`, cached per conversation and reused while it still covers the same prefix.
async fn summary_for(state: &Arc<AppState>, gw: &crate::gateway::Gateway, model: &str, cid: &str, older: &[Message]) -> anyhow::Result<String> {
    let upto = older.last().map(|m| m.id.clone()).unwrap_or_default();
    let key = format!("compact:{cid}");
    if let Some(cached) = state.db.lock().unwrap().get_setting(&key) {
        if let Ok(v) = serde_json::from_str::<Value>(&cached) {
            if v["upto"] == upto {
                return Ok(v["summary"].as_str().unwrap_or_default().to_string());
            }
        }
    }
    let transcript: String = older
        .iter()
        .filter(|m| m.role != "tool")
        .map(|m| format!("{}: {}", m.role, text_of(&m.content).chars().take(4000).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n\n");
    let msgs = vec![
        json!({"role": "system", "content": "Summarize this conversation so it can be continued without the original messages. Keep decisions, facts, names, numbers, code identifiers and open questions. Be concise; use bullet points."}),
        json!({"role": "user", "content": transcript}),
    ];
    let cancel = tokio::sync::Notify::new();
    let c = gw.stream_chat(model, &msgs, None, None, &cancel, |_| {}).await?;
    let summary = c.content.trim().to_string();
    if summary.is_empty() {
        anyhow::bail!("could not summarize earlier messages to fit the context window");
    }
    state.db.lock().unwrap().set_setting(&key, &json!({"upto": upto, "summary": summary}).to_string())?;
    Ok(summary)
}

enum ToolOutcome {
    Done(String, bool),
    Cancelled,
}

async fn execute_tool(state: &Arc<AppState>, run: &Run, cid: &str, call: &ToolCall, ch: &Sink) -> ToolOutcome {
    let Some((server, tool)) = state.mcp.resolve(&call.name).await else {
        return ToolOutcome::Done(format!("Unknown tool `{}`.", call.name), true);
    };
    let args: Value = match serde_json::from_str(if call.arguments.trim().is_empty() { "{}" } else { &call.arguments }) {
        Ok(v) => v,
        Err(e) => return ToolOutcome::Done(format!("Invalid JSON arguments: {e}"), true),
    };
    let policy_key = format!("tool_policy:{}", call.name);
    let policy = state.db.lock().unwrap().get_setting(&policy_key);
    if policy.as_deref() == Some("block") {
        return ToolOutcome::Done("This tool is blocked by the user's settings.".into(), true);
    }
    let chat_key = (cid.to_string(), call.name.clone());
    let always = policy.as_deref() == Some("allow") || state.chat_allows.lock().unwrap().contains(&chat_key);
    if !always && !ch.interactive {
        return ToolOutcome::Done(
            "This tool needs approval, which is not possible in a background task. Set it to \"Always allow\" in Settings to use it in tasks.".into(),
            true,
        );
    }
    if !always {
        let request_id = crate::db::new_id();
        let (tx, rx) = oneshot::channel::<(bool, String)>();
        state.approvals.lock().unwrap().insert(request_id.clone(), tx);
        let _ = ch.send(ChatEvent::ToolApproval { request_id: request_id.clone(), tool: tool.clone(), server: server.clone(), arguments: args.clone() });
        let decision = tokio::select! {
            d = rx => d.ok(),
            _ = run.cancel.notified() => { state.approvals.lock().unwrap().remove(&request_id); return ToolOutcome::Cancelled; }
        };
        match decision {
            Some((true, scope)) => match scope.as_str() {
                "always" => {
                    let _ = state.db.lock().unwrap().set_setting(&policy_key, "allow");
                }
                "chat" => {
                    state.chat_allows.lock().unwrap().insert(chat_key);
                }
                _ => {}
            },
            _ => return ToolOutcome::Done("The user denied this tool call.".into(), true),
        }
    }
    let fut = state.mcp.call(&server, &tool, args);
    tokio::select! {
        r = fut => match r {
            Ok((text, _raw, is_error)) => ToolOutcome::Done(cap(text), is_error),
            Err(e) => ToolOutcome::Done(format!("Tool error: {e}"), true),
        },
        _ = run.cancel.notified() => ToolOutcome::Cancelled,
    }
}

/// Keep oversized tool output from blowing the context window.
fn cap(mut s: String) -> String {
    const MAX: usize = 60_000;
    if s.len() > MAX {
        let mut cut = MAX;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n…[truncated]");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(role: &str, content: &str) -> Message {
        Message { role: role.into(), content: Value::String(content.into()), ..Default::default() }
    }

    #[test]
    fn wire_skips_empty_and_repairs_orphan_tool_calls() {
        let mut a = m("assistant", "");
        a.tool_calls = Some(json!([{"id": "c1", "name": "mcp__x__y", "arguments": "{}"}]));
        let hist = vec![m("user", "hi"), m("assistant", ""), a];
        let w = to_wire("sys", &hist);
        assert_eq!(w[0]["role"], "system");
        assert_eq!(w.len(), 4, "{w:?}"); // system, user, assistant(tool_calls), synthetic tool
        assert_eq!(w[3]["role"], "tool");
        assert_eq!(w[3]["tool_call_id"], "c1");
    }

    #[test]
    fn compaction_keeps_recent_turns_and_starts_on_user() {
        let mut h = vec![];
        for i in 0..40 {
            h.push(m(if i % 2 == 0 { "user" } else { "assistant" }, &"x".repeat(400)));
        }
        assert_eq!(compaction_cut(&h, 100_000), None, "fits: no compaction");
        let cut = compaction_cut(&h, 2_000).unwrap();
        assert!(cut > 0 && cut < h.len());
        assert_eq!(h[cut].role, "user");
        let kept: usize = h[cut..].iter().map(approx_tokens).sum();
        assert!(kept <= 1_000 + 120, "recent part stays within half the budget");
    }

    #[test]
    fn date_is_iso() {
        let d = chrono_date();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
    }
}
