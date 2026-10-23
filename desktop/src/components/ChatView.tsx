import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Volume2, VolumeX, FileText, Pencil, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { api } from "../api";
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

type Scope = "once" | "chat" | "always";

function ApprovalCard({ a, onDecide }: { a: Approval; onDecide: (allow: boolean, scope: Scope) => void }) {
  return (
    <div className="approval" role="alertdialog" aria-label="Tool approval">
      <div style={{ marginBottom: 6 }}>
        <b>{a.server}</b> wants to use <b className="mono">{a.tool}</b>
      </div>
      <pre>{JSON.stringify(a.arguments, null, 2)}</pre>
      <div className="row">
        <button className="btn primary" onClick={() => onDecide(true, "once")} autoFocus>Allow once</button>
        <button className="btn" onClick={() => onDecide(true, "chat")}>Allow for this chat</button>
        <button className="btn" onClick={() => onDecide(true, "always")}>Always allow</button>
        <span className="spacer" />
        <button className="btn danger" onClick={() => onDecide(false, "once")}>Deny</button>
      </div>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="icon-btn" title="Copy" aria-label="Copy" onClick={async () => { await copyText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}>
      {done ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

/** Read a reply aloud with the OS speech voices (offline). Code blocks are skipped. */
function ReadAloud({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const toggle = () => {
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    const plain = text.replace(/```[\s\S]*?```/g, " (code block) ").replace(/[*_#>`]/g, "");
    const u = new SpeechSynthesisUtterance(plain);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    setSpeaking(true);
  };
  return (
    <button className={`icon-btn ${speaking ? "on" : ""}`} title={speaking ? "Stop reading" : "Read aloud"} aria-label={speaking ? "Stop reading" : "Read aloud"} onClick={toggle}>
      {speaking ? <VolumeX size={15} /> : <Volume2 size={15} />}
    </button>
  );
}

function Feedback({ id }: { id: string }) {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => { void api.getSetting(`feedback:${id}`).then(setV); }, [id]);
  const set = async (x: "up" | "down") => {
    const next = v === x ? "none" : x;
    setV(next);
    await api.setSetting(`feedback:${id}`, next);
  };
  return (
    <>
      <button className={`icon-btn ${v === "up" ? "on" : ""}`} title="Good response" aria-label="Good response" aria-pressed={v === "up"} onClick={() => set("up")}><ThumbsUp size={15} /></button>
      <button className={`icon-btn ${v === "down" ? "on" : ""}`} title="Bad response" aria-label="Bad response" aria-pressed={v === "down"} onClick={() => set("down")}><ThumbsDown size={15} /></button>
    </>
  );
}

function BranchNav({ m, onSwitch }: { m: Message; onSwitch: (id: string) => void }) {
  if (m.sibling_ids.length < 2) return null;
  const i = m.sibling_ids.indexOf(m.id);
  return (
    <span className="branch-nav" aria-label={`Version ${i + 1} of ${m.sibling_ids.length}`}>
      <button className="icon-btn" disabled={i <= 0} aria-label="Previous version" onClick={() => onSwitch(m.sibling_ids[i - 1])}><ChevronLeft size={14} /></button>
      <span>{i + 1} / {m.sibling_ids.length}</span>
      <button className="icon-btn" disabled={i >= m.sibling_ids.length - 1} aria-label="Next version" onClick={() => onSwitch(m.sibling_ids[i + 1])}><ChevronRight size={14} /></button>
    </span>
  );
}

function RetryMenu({ models, onRetry }: { models: string[]; onRetry: (model?: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="picker" style={{ display: "inline-flex" }}>
      <button className="icon-btn" title="Retry" aria-label="Retry" onClick={() => onRetry()}><RotateCcw size={15} /></button>
      <button className="icon-btn" style={{ width: 20, marginLeft: -4 }} title="Retry with another model" aria-label="Retry with another model" onClick={() => setOpen((o) => !o)}><ChevronDown size={14} strokeWidth={2} /></button>
      {open && (
        <div className="menu" style={{ position: "absolute", top: 30, left: 0 }} role="menu" onMouseLeave={() => setOpen(false)}>
          <div className="picker-group">Retry with</div>
          {models.map((m) => <button key={m} role="menuitem" onClick={() => { setOpen(false); onRetry(m); }}>{m}</button>)}
        </div>
      )}
    </span>
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
  initials,
  retryModels,
  onSwitchBranch,
}: {
  onSwitchBranch: (id: string) => void;
  initials: string;
  retryModels: string[];
  messages: Message[];
  live?: LiveRun;
  onRegenerate: (fromId: string, model?: string) => void;
  onEdit: (m: Message, text: string) => void;
  onDecide: (a: Approval, allow: boolean, scope: Scope) => void;
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
                      <span className="avatar small" aria-hidden>{initials}</span>
                      <div className="bubble-body">
                        {images.map((p, j) => p.type === "image_url" && <img key={j} src={p.image_url.url} alt="attachment" />)}
                        {[...text.matchAll(/<file name="([^"]*)">/g)].map((f, j) => <span key={j} className="file-chip"><FileText size={13} /> {f[1]}</span>)}
                        {text.replace(/<file name="[^"]*">[\s\S]*?<\/file>\n*/g, "")}
                      </div>
                    </div>
                  )}
                  <div className="msg-actions">
                    <BranchNav m={m} onSwitch={onSwitchBranch} />
                    <CopyBtn text={text} />
                    {!busy && <button className="icon-btn" title="Edit" aria-label="Edit" onClick={() => { setEditing(m.id); setEditText(text); }}><Pencil size={15} /></button>}
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
              <div className="msg-actions always">
                {!busy && <BranchNav m={m} onSwitch={onSwitchBranch} />}
                {text && <CopyBtn text={text} />}
                {text && <ReadAloud text={text} />}
                <Feedback id={m.id} />
                {i === lastAssistantIdx && !busy && <RetryMenu models={retryModels} onRetry={(model) => onRegenerate(regenFrom, model)} />}
                <Meta m={m} />
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
            {live.approvals.map((a) => <ApprovalCard key={a.request_id} a={a} onDecide={(allow, scope) => onDecide(a, allow, scope)} />)}
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
