import { useEffect, useRef, useState } from "react";
import { textOf, type Message } from "../api";
import type { Approval, LiveRun } from "../useChat";
import { copyText, Markdown, type Artifact } from "./Markdown";

function fmtMs(ms: number | null | undefined) {
  if (ms == null) return null;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Meta({ m }: { m: Message }) {
  const u = m.usage || {};
  const servedDiffers = m.model_served && m.model_requested && m.model_served !== m.model_requested;
  return (
    <div className="meta">
      <span title="Model you selected">{m.model_requested}</span>
      {servedDiffers && <span title="Model reported by the serving backend">→ served by {m.model_served}</span>}
      {m.routed_host && <span title="Backend host LiteLLM routed to">via {m.routed_host}</span>}
      {m.fallbacks && <span className="warn" title="LiteLLM attempted fallbacks">⚠ fallbacks attempted: {m.fallbacks}</span>}
      {u.prompt_tokens != null && <span>{u.prompt_tokens} in / {u.completion_tokens ?? "?"} out tok</span>}
      {u.ttft_ms != null && <span>first token {fmtMs(u.ttft_ms)}</span>}
      {u.total_ms != null && <span>{fmtMs(u.total_ms)}</span>}
      {m.cost != null && m.cost > 0 && <span>${m.cost.toFixed(4)}</span>}
      {m.status === "cancelled" && <span className="warn">stopped</span>}
    </div>
  );
}

function ToolCard({ name, args, result }: { name: string; args: string; result?: Message }) {
  let pretty = args;
  try {
    pretty = JSON.stringify(JSON.parse(args || "{}"), null, 2);
  } catch { /* keep raw */ }
  const short = name.replace(/^mcp__/, "").replace("__", " › ");
  const state = !result ? "running…" : result.status === "error" ? "failed" : "done";
  return (
    <details className="tool-card">
      <summary>
        <span className={`dot ${!result ? "warn" : result.status === "error" ? "err" : "ok"}`} />
        <span className="mono">{short}</span>
        <span className="muted">{state}</span>
      </summary>
      <pre>{pretty}</pre>
      {result && <pre>{textOf(result.content) || "(empty result)"}</pre>}
    </details>
  );
}

function ApprovalCard({ a, onDecide }: { a: Approval; onDecide: (allow: boolean, remember: boolean) => void }) {
  return (
    <div className="approval" role="alertdialog" aria-label="Tool approval">
      <div style={{ marginBottom: 6 }}>
        Allow <b>{a.server}</b> to run <b className="mono">{a.tool}</b>?
      </div>
      <pre>{JSON.stringify(a.arguments, null, 2)}</pre>
      <div className="row">
        <button className="btn primary" onClick={() => onDecide(true, false)} autoFocus>Allow once</button>
        <button className="btn" onClick={() => onDecide(true, true)}>Always allow this tool</button>
        <button className="btn danger" onClick={() => onDecide(false, false)}>Deny</button>
      </div>
    </div>
  );
}

export function ChatView({
  messages,
  live,
  onRegenerate,
  onEdit,
  onDecide,
  onOpenArtifact,
  onDismissError,
}: {
  messages: Message[];
  live?: LiveRun;
  onRegenerate: (fromId: string) => void;
  onEdit: (m: Message, text: string) => void;
  onDecide: (a: Approval, allow: boolean, remember: boolean) => void;
  onOpenArtifact: (a: Artifact) => void;
  onDismissError: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, live?.text, live?.reasoning, live?.approvals.length]);

  const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m]));
  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");
  const busy = !!live?.runId;

  return (
    <div
      className="chat-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="chat-inner" aria-live="polite">
        {messages.map((m, i) => {
          if (m.role === "tool") return null;
          if (m.role === "user") {
            const text = textOf(m.content);
            const images = typeof m.content === "string" ? [] : m.content.filter((p) => p.type === "image_url");
            return (
              <div className="msg user" key={m.id}>
                <div className="msg-wrap">
                  {editing === m.id ? (
                    <div className="composer" style={{ width: "min(640px, 70vw)" }}>
                      <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={4} autoFocus />
                      <div className="composer-row">
                        <span className="spacer" />
                        <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="btn primary" disabled={!editText.trim() || busy} onClick={() => { setEditing(null); onEdit(m, editText.trim()); }}>Save & resend</button>
                      </div>
                    </div>
                  ) : (
                    <div className="bubble-user">
                      {images.map((p, j) => p.type === "image_url" && <img key={j} src={p.image_url.url} alt="attachment" />)}
                      {text.replace(/<file name="[^"]*">[\s\S]*?<\/file>\n*/g, (f) => `📄 ${/name="([^"]*)"/.exec(f)?.[1]}\n`)}
                    </div>
                  )}
                  <div className="msg-actions">
                    <button className="icon-btn" title="Copy" onClick={() => copyText(text)}>⧉</button>
                    {!busy && <button className="icon-btn" title="Edit" onClick={() => { setEditing(m.id); setEditText(text); }}>✎</button>}
                  </div>
                </div>
              </div>
            );
          }
          const text = textOf(m.content);
          // A regenerate replaces everything after the user turn that produced this answer.
          let regenFrom = m.id;
          for (let j = i; j >= 0 && messages[j].role !== "user"; j--) regenFrom = messages[j].id;
          return (
            <div className="msg assistant" key={m.id}>
              {m.reasoning && (
                <details className="reasoning">
                  <summary>Thought process</summary>
                  <div>{m.reasoning}</div>
                </details>
              )}
              {text && <div className="assistant-body"><Markdown text={text} onOpenArtifact={onOpenArtifact} /></div>}
              {m.tool_calls?.map((c) => <ToolCard key={c.id} name={c.name} args={c.arguments} result={results.get(c.id)} />)}
              {m.status === "error" && <div className="error-box">{m.error}</div>}
              <Meta m={m} />
              <div className="msg-actions">
                {text && <button className="icon-btn" title="Copy" onClick={() => copyText(text)}>⧉</button>}
                {i === lastAssistantIdx && !busy && <button className="icon-btn" title="Regenerate" onClick={() => onRegenerate(regenFrom)}>↻</button>}
              </div>
            </div>
          );
        })}
        {live && (live.runId || live.error) && (
          <div className="msg assistant">
            {live.reasoning && (
              <details className="reasoning" open>
                <summary>Thinking…</summary>
                <div>{live.reasoning}</div>
              </details>
            )}
            {live.text ? (
              <div className="assistant-body">
                <Markdown text={live.text} />
                <span className="cursor" />
              </div>
            ) : (
              live.runId && !live.reasoning && !live.approvals.length && <span className="cursor" />
            )}
            {live.toolNames.map((n, i) => <div key={i} className="muted">Calling {n.replace(/^mcp__/, "").replace("__", " › ")}…</div>)}
            {live.approvals.map((a) => <ApprovalCard key={a.request_id} a={a} onDecide={(allow, remember) => onDecide(a, allow, remember)} />)}
            {live.error && (
              <div className="error-box">
                {live.error}{" "}
                <button className="btn" onClick={onDismissError}>Dismiss</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
