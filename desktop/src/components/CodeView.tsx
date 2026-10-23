import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ModelEntry } from "../api";
import { ModelPicker } from "./ModelPicker";
import { Markdown } from "./Markdown";
import { Terminal } from "./Terminal";

type CodeEvent =
  | { type: "agent"; record: AgentRecord }
  | { type: "stderr"; line: string }
  | { type: "exited"; code: number | null };
type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string; is_error?: boolean };
type AgentRecord = {
  type: string;
  subtype?: string;
  model?: string;
  tools?: string[];
  message?: { role?: string; content?: Block[] | string };
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
};
type GitStatus = { is_repo: boolean; branch: string | null; files: [string, string][]; error: string | null };
type Worktree = { path: string; branch: string | null; head: string };
type Entry = { kind: "user" | "text" | "tool" | "result" | "system" | "log"; text: string; title?: string; err?: boolean };

const MODES: [string, string][] = [
  ["plan", "Plan only (read-only)"],
  ["default", "Ask (edits/commands denied unless allowed)"],
  ["acceptEdits", "Auto-accept file edits in this folder"],
  ["bypassPermissions", "Bypass all permissions (dangerous)"],
];

function blockText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
  return JSON.stringify(c);
}

export function CodeView({ models, favorites, onToggleFavorite, defaultModel }: { models: ModelEntry[]; favorites: string[]; onToggleFavorite: (id: string) => void; defaultModel: string | null }) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState<{ path: string | null; text: string } | null>(null);
  const [model, setModel] = useState<string | null>(defaultModel);
  const [mode, setMode] = useState("acceptEdits");
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [wts, setWts] = useState<Worktree[]>([]);
  const [wtBranch, setWtBranch] = useState("");
  const [wtErr, setWtErr] = useState<string | null>(null);

  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => { void invoke<string[]>("list_workspaces").then((ws) => setRecent(ws.reverse())); }, [cwd]);
  useEffect(() => { if (!model && defaultModel) setModel(defaultModel); }, [defaultModel, model]);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [entries]);

  const refreshGit = async (dir = cwd) => {
    if (!dir) return;
    setGit(await invoke<GitStatus>("git_status", { cwd: dir }));
  };
  useEffect(() => {
    void refreshGit();
    const t = setInterval(() => void refreshGit(), 5000);
    return () => clearInterval(t);
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshWts = async (dir = cwd) => {
    if (!dir) return setWts([]);
    setWts(await invoke<Worktree[]>("worktree_list", { cwd: dir }).catch(() => []));
  };
  useEffect(() => { void refreshWts(); }, [cwd, git?.is_repo]); // eslint-disable-line react-hooks/exhaustive-deps
  const wtAdd = async () => {
    if (!cwd || !wtBranch.trim()) return;
    setWtErr(null);
    try {
      const p = await invoke<string>("worktree_add", { cwd, branch: wtBranch.trim() });
      setWtBranch("");
      await refreshWts();
      setCwd(p);
      setDiff(null);
    } catch (e) { setWtErr(String(e)); }
  };
  const wtRemove = async (path: string) => {
    if (!cwd || !confirm(`Remove worktree ${path}? (git refuses if it has uncommitted changes)`)) return;
    setWtErr(null);
    try {
      await invoke("worktree_remove", { cwd, path });
      await refreshWts();
    } catch (e) { setWtErr(String(e)); }
  };

  const push = (e: Entry) => setEntries((xs) => [...xs, e]);

  const onEvent = (e: CodeEvent) => {
    if (e.type === "stderr") return push({ kind: "log", text: e.line });
    if (e.type === "exited") {
      setSession(null);
      setBusy(false);
      return push({ kind: "system", text: `Agent exited (code ${e.code ?? "?"})` });
    }
    const r = e.record;
    if (r.type === "system" && r.subtype === "init") push({ kind: "system", text: `Agent ready · model ${r.model} · ${r.tools?.length ?? 0} tools` });
    else if (r.type === "assistant" && Array.isArray(r.message?.content)) {
      for (const b of r.message!.content as Block[]) {
        if (b.type === "text" && b.text) push({ kind: "text", text: b.text });
        if (b.type === "tool_use") push({ kind: "tool", title: b.name, text: JSON.stringify(b.input, null, 2) });
      }
    } else if (r.type === "user" && Array.isArray(r.message?.content)) {
      for (const b of r.message!.content as Block[]) {
        if (b.type === "tool_result") push({ kind: "tool", title: "result", text: blockText(b.content).slice(0, 8000), err: b.is_error });
      }
    } else if (r.type === "result") {
      setBusy(false);
      void refreshGit();
      push({ kind: "result", err: r.is_error, text: `${r.is_error ? "Failed" : "Done"}${r.duration_ms ? ` in ${(r.duration_ms / 1000).toFixed(1)} s` : ""}${r.total_cost_usd ? ` · $${r.total_cost_usd.toFixed(4)}` : ""}` });
    }
  };

  const start = async () => {
    if (!cwd || !model) return;
    setErr(null);
    const ch = new Channel<CodeEvent>();
    ch.onmessage = onEvent;
    try {
      const id = await invoke<string>("code_start", { cwd, model, permissionMode: mode, onEvent: ch });
      setSession(id);
      push({ kind: "system", text: `Starting OpenClaude agent in ${cwd} (${mode})…` });
    } catch (e) { setErr(String(e)); }
  };

  const send = async () => {
    if (!session || !input.trim()) return;
    push({ kind: "user", text: input.trim() });
    setBusy(true);
    try { await invoke("code_send", { sessionId: session, text: input.trim() }); setInput(""); }
    catch (e) { setErr(String(e)); setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="topbar" style={{ borderBottom: "1px solid var(--border)", flexWrap: "wrap", height: "auto", minHeight: 48, padding: "6px 12px" }}>
          <button className="btn" onClick={async () => { const p = await invoke<string | null>("pick_workspace"); if (p) { setCwd(p); setDiff(null); void refreshGit(p); } }}>
            📂 {cwd ? cwd.split(/[\\/]/).slice(-2).join("/") : "Open folder…"}
          </button>
          <ModelPicker models={models} value={model} onChange={setModel} direction="down" favorites={favorites} onToggleFavorite={onToggleFavorite} />
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={!!session} className="btn" aria-label="Permission mode">
            {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span className="spacer" />
          <button className="btn" disabled={!cwd} onClick={() => setTermOpen((t) => !t)} aria-pressed={termOpen}>⌨ Terminal</button>
          {session ? (
            <button className="btn danger" onClick={async () => { await invoke("code_stop", { sessionId: session }); }}>Stop agent</button>
          ) : (
            <button className="btn primary" disabled={!cwd || !model} onClick={start}>Start agent</button>
          )}
        </div>
        {mode === "bypassPermissions" && !session && <div className="error-box" style={{ margin: "8px 16px" }}>Bypass mode lets the agent run any command and edit any file without asking. Use it only in a disposable folder.</div>}
        {err && <div className="error-box" style={{ margin: "8px 16px" }}>{err}</div>}
        <div className="chat-scroll" ref={scroller}>
          <div className="chat-inner">
            {!entries.length && <div className="muted">Open a folder, pick a model, start the agent, then describe a coding task. The OpenClaude CLI agent runs in that folder and talks to your LiteLLM gateway.</div>}
            {!cwd && recent.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="section-label" style={{ padding: "0 0 4px" }}>Recent folders</div>
                {recent.map((w) => (
                  <button key={w} className="nav-item mono" onClick={() => { setCwd(w); setDiff(null); }} title={w}>📂 {w}</button>
                ))}
              </div>
            )}
            {entries.map((e, i) =>
              e.kind === "user" ? <div key={i} className="msg user"><div className="bubble-user">{e.text}</div></div>
              : e.kind === "text" ? <div key={i} className="assistant-body"><Markdown text={e.text} /></div>
              : e.kind === "tool" ? (
                <details key={i} className="tool-card"><summary><span className={`dot ${e.err ? "err" : "ok"}`} /><span className="mono">{e.title}</span></summary><pre>{e.text}</pre></details>
              )
              : e.kind === "log" ? <div key={i} className="muted mono" style={{ fontSize: 11 }}>{e.text}</div>
              : <div key={i} className="meta" style={{ color: e.err ? "var(--err)" : undefined }}>{e.text}</div>,
            )}
            {busy && <span className="cursor" />}
          </div>
        </div>
        {termOpen && cwd && <Terminal cwd={cwd} />}
        <div className="composer-dock">
          <div className="composer-wrap">
            <div className="composer">
              <textarea rows={2} value={input} disabled={!session} placeholder={session ? "Describe a coding task…" : "Start the agent first"} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
              <div className="composer-row"><span className="spacer" /><button className="send-btn" disabled={!session || busy || !input.trim()} onClick={send} aria-label="Send task">↑</button></div>
            </div>
          </div>
        </div>
      </div>
      <aside className="artifact-panel" style={{ width: 360, minWidth: 300 }} aria-label="Repository">
        <div className="topbar" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="title">{git?.is_repo ? `⎇ ${git.branch}` : "No git repository"}</span>
          <span className="spacer" />
          <button className="btn" onClick={async () => cwd && setDiff({ path: null, text: await invoke<string>("git_diff", { cwd, path: null }) })} disabled={!git?.is_repo}>Full diff</button>
        </div>
        <div className="artifact-body">
          {diff ? (
            <>
              <div className="topbar"><span className="title mono">{diff.path || "all changes"}</span><span className="spacer" /><button className="icon-btn" onClick={() => setDiff(null)} aria-label="Close diff">✕</button></div>
              <pre>{diff.text.split("\n").map((l, i) => <div key={i} style={{ color: l.startsWith("+") && !l.startsWith("+++") ? "#7ee2a8" : l.startsWith("-") && !l.startsWith("---") ? "#ff9b9b" : l.startsWith("@@") ? "#9cb4ff" : undefined }}>{l || " "}</div>)}</pre>
            </>
          ) : (
            <div style={{ padding: 8 }}>
              {git?.files.map(([st, path]) => (
                <button key={path} className="nav-item" onClick={async () => cwd && setDiff({ path, text: (await invoke<string>("git_diff", { cwd, path }).catch((e) => String(e))) || "(untracked or no diff vs HEAD)" })}>
                  <span className="badge">{st}</span> <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{path}</span>
                </button>
              ))}
              {git?.is_repo && !git.files.length && <div className="muted" style={{ padding: 8 }}>Working tree clean.</div>}
              {git?.error && cwd && <div className="muted" style={{ padding: 8 }}>{git.error}</div>}
            </div>
          )}
        </div>
        {git?.is_repo && (
          <div style={{ borderTop: "1px solid var(--border)", padding: 8 }} aria-label="Worktrees">
            <div className="section-label" style={{ padding: "0 0 4px" }}>Worktrees</div>
            {wts.map((w, i) => {
              const here = cwd !== null && w.path.split("\\").join("/").toLowerCase() === cwd.split("\\").join("/").toLowerCase();
              return (
                <div key={w.path} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 0" }}>
                  <span className="mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={w.path}>{here ? "● " : ""}{w.branch ?? `(detached ${w.head.slice(0, 7)})`}{i === 0 ? " · main" : ""}</span>
                  <button className="btn" disabled={here} onClick={() => { setCwd(w.path); setDiff(null); }}>Open</button>
                  {i > 0 && <button className="btn danger" onClick={() => void wtRemove(w.path)}>Remove</button>}
                </div>
              );
            })}
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              <input value={wtBranch} aria-label="New worktree branch" placeholder="new-branch-name" onChange={(e) => setWtBranch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void wtAdd(); }} style={{ flex: 1, minWidth: 0 }} />
              <button className="btn" disabled={!wtBranch.trim()} onClick={() => void wtAdd()}>New worktree</button>
            </div>
            {wtErr && <div className="error-box" style={{ marginTop: 4 }}>{wtErr}</div>}
          </div>
        )}
      </aside>
    </div>
  );
}
