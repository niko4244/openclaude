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

fn system_prompt(state: &AppState, conversation_id: &str) -> String {
    let db = state.db.lock().unwrap();
    let mut parts = vec![format!(
        "You are a helpful assistant running inside OpenClaude Desktop. Current date: {}.",
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

pub async fn run(state: Arc<AppState>, run_id: String, run: Arc<Run>, args: SendArgs, ch: Channel<ChatEvent>) {
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
async fn run_inner(state: &Arc<AppState>, run: &Run, args: &SendArgs, ch: &Channel<ChatEvent>) -> anyhow::Result<bool> {
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
    let tools = if tools_enabled && model_allows_tools { state.mcp.openai_tools(None).await } else { vec![] };
    let system = system_prompt(state, cid);
    let gateway = state.gateway.read().await.clone();

    for _step in 0..MAX_STEPS {
        let history = state.db.lock().unwrap().messages(cid)?;
        let wire = to_wire(&system, &history);
        let ch2 = ch.clone();
        let res = gateway
            .stream_chat(&args.model, &wire, Some(&tools), None, &run.cancel, |d| {
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
            let (text, is_error) = match execute_tool(state, run, &call, ch).await {
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

enum ToolOutcome {
    Done(String, bool),
    Cancelled,
}

async fn execute_tool(state: &Arc<AppState>, run: &Run, call: &ToolCall, ch: &Channel<ChatEvent>) -> ToolOutcome {
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
    let always = policy.as_deref() == Some("allow");
    if !always {
        let request_id = crate::db::new_id();
        let (tx, rx) = oneshot::channel::<(bool, bool)>();
        state.approvals.lock().unwrap().insert(request_id.clone(), tx);
        let _ = ch.send(ChatEvent::ToolApproval { request_id: request_id.clone(), tool: tool.clone(), server: server.clone(), arguments: args.clone() });
        let decision = tokio::select! {
            d = rx => d.ok(),
            _ = run.cancel.notified() => { state.approvals.lock().unwrap().remove(&request_id); return ToolOutcome::Cancelled; }
        };
        match decision {
            Some((true, remember)) => {
                if remember {
                    let _ = state.db.lock().unwrap().set_setting(&policy_key, "allow");
                }
            }
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
    fn date_is_iso() {
        let d = chrono_date();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
    }
}
