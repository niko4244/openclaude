import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ModelEntry } from "../api";
import { ModelPicker } from "./ModelPicker";
import { Markdown } from "./Markdown";
import { Terminal } from "./Terminal";
import { Pip } from "./Pip";
import { DevicePreview } from "./DevicePreview";

type CodeEvent =
  | { type: "agent"; record: AgentRecord }
  | { type: "approval"; request_id: string; tool: string; input: unknown }
  | { type: "stderr"; line: string }
  | { type: "error"; message: string }
  | { type: "exited"; code: number | null };
type RemoteCheck = { ok: boolean; node?: string | null; cli?: string | null; git?: boolean; error?: string | null; install?: string | null };
type Remote = { host: string; dir: string };
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
  request_id?: string;
};
type GitStatus = { is_repo: boolean; branch: string | null; files: [string, string][]; error: string | null };
type Worktree = { path: string; branch: string | null; head: string };
type ApprovalState = "pending" | "allowed" | "denied" | "cancelled";
type Entry = { kind: "user" | "text" | "tool" | "result" | "system" | "log" | "approval"; text: string; title?: string; err?: boolean; requestId?: string; state?: ApprovalState };

const MODES: [string, string][] = [
  ["plan", "Plan only (read-only)"],
  ["default", "Ask before edits and commands"],
  ["acceptEdits", "Auto-accept edits, ask for commands"],
  ["bypassPermissions", "Bypass all permissions (dangerous)"],
];

function blockText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
  return JSON.stringify(c);
}

export function CodeView({ models, favorites, onToggleFavorite, defaultModel, seed }: { models: ModelEntry[]; favorites: string[]; onToggleFavorite: (id: string) => void; defaultModel: string | null; seed?: { key: string; cwd: string; prompt: string } | null }) {
  const [cwd, setCwdRaw] = useState<string | null>(null);
  /** Set when `cwd` is a folder on an SSH host. */
  const [host, setHost] = useState<string | null>(null);
  const setCwd = (dir: string | null, onHost: string | null = null) => { setHost(onHost); setCwdRaw(dir); };
  const [git, setGit] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState<{ path: string | null; text: string } | null>(null);
  const [model, setModel] = useState<string | null>(defaultModel);
  const [mode, setMode] = useState("acceptEdits");
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  useEffect(() => {
    if (!seed) return;
    setCwd(seed.cwd);
    setDiff(null);
    setInput(seed.prompt);
  }, [seed?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState<string | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [wts, setWts] = useState<Worktree[]>([]);
  const [wtBranch, setWtBranch] = useState("");
  const [wtErr, setWtErr] = useState<string | null>(null);

  const [recent, setRecent] = useState<string[]>([]);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  useEffect(() => {
    void invoke<string[]>("list_workspaces").then((ws) => setRecent(ws.reverse()));
    void invoke<Remote[]>("remote_list").then((rs) => setRemotes(rs.reverse()));
  }, [cwd]);
  useEffect(() => { if (!model && defaultModel) setModel(defaultModel); }, [defaultModel, model]);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [entries]);

  // Folder picker: a local folder (native dialog) or a folder on an SSH host.
  const [pickOpen, setPickOpen] = useState(false);
  const [remoteForm, setRemoteForm] = useState(false);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const [rHost, setRHost] = useState("");
  const [rDir, setRDir] = useState("");
  const [rCheck, setRCheck] = useState<RemoteCheck | null>(null);
  const [rBusy, setRBusy] = useState(false);
  useEffect(() => { if (remoteForm) void invoke<string[]>("ssh_hosts").then(setSshHosts); }, [remoteForm]);
  const pickLocal = async () => {
    setPickOpen(false);
    const p = await invoke<string | null>("pick_workspace");
    if (p) { setCwd(p); setDiff(null); setRemoteForm(false); void refreshGit(p, null); }
  };
  const openRemote = async (h: string, d: string) => {
    setRCheck(null);
    setRBusy(true);
    try {
      if (!(await invoke<boolean>("remote_add", { host: h, dir: d }))) return; // cancelled in the native dialog
      const c = await invoke<RemoteCheck>("remote_check", { host: h, dir: d });
      setRCheck(c);
      if (c.ok) { setCwd(d, h); setDiff(null); setRemoteForm(false); }
    } catch (e) {
      setRCheck({ ok: false, error: String(e) });
    } finally {
      setRBusy(false);
    }
  };

  // Device preview (web emulation) of a local dev server.
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [deviceUrl, setDeviceUrl] = useState<string | null>(null);

  const refreshGit = async (dir = cwd, onHost = host) => {
    if (!dir) return;
    setGit(await invoke<GitStatus>("git_status", { cwd: dir, host: onHost }));
  };
  useEffect(() => {
    void refreshGit();
    // Each remote status is a new SSH connection, so poll remote folders less often.
    const t = setInterval(() => void refreshGit(), host ? 15000 : 5000);
    return () => clearInterval(t);
  }, [cwd, host]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshWts = async (dir = cwd) => {
    if (!dir || host) return setWts([]);
    setWts(await invoke<Worktree[]>("worktree_list", { cwd: dir }).catch(() => []));
  };
  useEffect(() => { void refreshWts(); }, [cwd, host, git?.is_repo]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const setApproval = (requestId: string, state: ApprovalState) =>
    setEntries((xs) => xs.map((x) => (x.kind === "approval" && x.requestId === requestId ? { ...x, state } : x)));
  const decide = async (requestId: string, allow: boolean) => {
    if (!session) return;
    setApproval(requestId, allow ? "allowed" : "denied");
    try {
      await invoke("code_approve", { sessionId: session, requestId, allow });
    } catch (e) {
      setApproval(requestId, "pending");
      setErr(String(e));
    }
  };

  const onEvent = (e: CodeEvent) => {
    if (e.type === "approval") return push({ kind: "approval", title: e.tool, text: JSON.stringify(e.input, null, 2), requestId: e.request_id, state: "pending" });
    if (e.type === "stderr") return push({ kind: "log", text: e.line });
    if (e.type === "error") { setErr(e.message); return push({ kind: "system", text: e.message, err: true }); }
    if (e.type === "exited") {
      setSession(null);
      setBusy(false);
      return push({ kind: "system", text: `Agent exited (code ${e.code ?? "?"})` });
    }
    const r = e.record;
    if (r.type === "control_cancel_request" && r.request_id) setApproval(r.request_id, "cancelled");
    else if (r.type === "system" && r.subtype === "init") push({ kind: "system", text: `Agent ready · model ${r.model} · ${r.tools?.length ?? 0} tools` });
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
      const id = await invoke<string>("code_start", { cwd, host, model, permissionMode: mode, onEvent: ch });
      setSession(id);
      push({ kind: "system", text: `Starting OpenClaude agent in ${host ? `${host}:${cwd} over SSH` : cwd} (${mode})…` });
    } catch (e) { setErr(String(e)); }
  };

  const folderLabel = cwd ? (host ? `${host}:${cwd}` : cwd.split(/[\\/]/).slice(-2).join("/")) : "Open folder…";

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
        <div className="topbar" data-tauri-drag-region="deep" style={{ borderBottom: "1px solid var(--border)", flexWrap: "wrap", height: "auto", minHeight: 48, padding: "6px 12px" }}>
          <div style={{ position: "relative" }} onKeyDown={(e) => { if (e.key === "Escape") setPickOpen(false); }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPickOpen(false); }}>
            <button className="btn" aria-haspopup="menu" aria-expanded={pickOpen} disabled={!!session} title={cwd ?? undefined} onClick={() => setPickOpen((o) => !o)}>
              {host ? "🌐" : "📂"} {folderLabel}
            </button>
            {pickOpen && (
              <div className="menu" role="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0 }} onMouseLeave={() => setPickOpen(false)}>
                <button role="menuitem" onClick={() => void pickLocal()}>📂 Local folder…</button>
                <button role="menuitem" onClick={() => { setPickOpen(false); setRCheck(null); setRemoteForm(true); }}>🌐 Remote (SSH)…</button>
              </div>
            )}
          </div>
          <ModelPicker models={models} value={model} onChange={setModel} direction="down" favorites={favorites} onToggleFavorite={onToggleFavorite} />
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={!!session} className="btn" aria-label="Permission mode">
            {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span className="spacer" />
          <button className="btn" onClick={() => setDeviceOpen((o) => !o)} aria-pressed={deviceOpen} title="Preview a local dev server on emulated phones and tablets">📱 Device</button>
          <button className="btn" disabled={!cwd || !!host} title={host ? "The terminal runs on this PC; it isn't available for SSH folders" : undefined} onClick={() => setTermOpen((t) => !t)} aria-pressed={termOpen}>⌨ Terminal</button>
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
            {remoteForm && !session && (
              <form className="remote-form" aria-label="Remote folder over SSH" onSubmit={(e) => { e.preventDefault(); void openRemote(rHost.trim(), rDir.trim()); }}>
                <div className="section-label" style={{ padding: 0 }}>Remote (SSH)</div>
                <div className="field">
                  <label htmlFor="oc-ssh-host">Host</label>
                  <input id="oc-ssh-host" list="oc-ssh-hosts" value={rHost} onChange={(e) => setRHost(e.target.value)} placeholder="devbox or user@host" autoComplete="off" spellCheck={false} />
                  <datalist id="oc-ssh-hosts">{sshHosts.map((h) => <option key={h} value={h} />)}</datalist>
                  <span className="help">{sshHosts.length ? `${sshHosts.length} host${sshHosts.length > 1 ? "s" : ""} from ~/.ssh/config, or type user@host.` : "An alias from ~/.ssh/config, a hostname, or user@host. Ports and keys come from ~/.ssh/config."}</span>
                </div>
                <div className="field">
                  <label htmlFor="oc-ssh-dir">Remote folder</label>
                  <input id="oc-ssh-dir" className="mono" value={rDir} onChange={(e) => setRDir(e.target.value)} placeholder="~/projects/my-app" autoComplete="off" spellCheck={false} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn primary" type="submit" disabled={rBusy || !rHost.trim() || !rDir.trim()}>{rBusy ? "Connecting…" : "Connect"}</button>
                  <button className="btn" type="button" onClick={() => setRemoteForm(false)}>Cancel</button>
                </div>
                {rCheck && !rCheck.ok && (
                  <div className="error-box" role="alert" style={{ marginTop: 10 }}>
                    {rCheck.error}
                    {rCheck.install && (
                      <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
                        <span>Install it on the remote:</span> <code className="mono">{rCheck.install}</code>
                        <button className="btn" type="button" onClick={() => void navigator.clipboard.writeText(rCheck.install!)}>Copy</button>
                      </div>
                    )}
                  </div>
                )}
                <p className="muted">
                  The agent runs on that machine through your system OpenSSH client, with your own keys or ssh-agent (it never asks for passwords). Your model gateway is reached through an SSH reverse tunnel, so nothing but the encrypted SSH session leaves this PC, and the API key never appears on a command line. The remote needs a POSIX shell, Node.js 20+ and the OpenClaude CLI.
                </p>
              </form>
            )}
            {!entries.length && !remoteForm && (
              <div className="code-empty">
                <Pip size={72} label="Pip, the OpenClaude mascot" />
                <div className="code-empty-title">Ready when you are</div>
                <div className="muted">Open a folder on this PC or over SSH, pick a model and start the agent. Its work shows up here, and Pip keeps you company while it runs.</div>
              </div>
            )}
            {!cwd && !remoteForm && (recent.length > 0 || remotes.length > 0) && (
              <div style={{ marginTop: 16 }}>
                <div className="section-label" style={{ padding: "0 0 4px" }}>Recent folders</div>
                {recent.map((w) => (
                  <button key={w} className="nav-item mono" onClick={() => { setCwd(w); setDiff(null); }} title={w}>📂 {w}</button>
                ))}
                {remotes.map((r) => (
                  <button key={`${r.host}:${r.dir}`} className="nav-item mono" disabled={rBusy} onClick={() => void openRemote(r.host, r.dir)} title={`${r.host}:${r.dir} over SSH`}>🌐 {r.host}:{r.dir}</button>
                ))}
                {rCheck && !rCheck.ok && !remoteForm && <div className="error-box" role="alert">{rCheck.error}{rCheck.install && <> Install it on the remote: <code className="mono">{rCheck.install}</code></>}</div>}
              </div>
            )}
            {entries.map((e, i) =>
              e.kind === "user" ? <div key={i} className="msg user"><div className="bubble-user">{e.text}</div></div>
              : e.kind === "text" ? <div key={i} className="assistant-body"><Markdown text={e.text} /></div>
              : e.kind === "tool" ? (
                <details key={i} className="tool-card"><summary><span className={`dot ${e.err ? "err" : "ok"}`} /><span className="mono">{e.title}</span></summary><pre>{e.text}</pre></details>
              )
              : e.kind === "approval" ? (
                <div key={i} className="tool-card" role="group" aria-label={`Permission request for ${e.title}`} style={{ padding: "8px 12px", border: "1px solid var(--border, #8884)", borderRadius: 8 }}>
                  <div><strong>Allow {e.title}?</strong> <span className="muted">{e.state === "pending" ? "The agent is waiting for your answer." : e.state}</span></div>
                  <pre style={{ maxHeight: 220, overflow: "auto" }}>{e.text}</pre>
                  {e.state === "pending" && (
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn" onClick={() => void decide(e.requestId!, true)}>Allow</button>
                      <button className="btn" onClick={() => void decide(e.requestId!, false)}>Deny</button>
                    </div>
                  )}
                </div>
              )
              : e.kind === "log" ? <div key={i} className="muted mono" style={{ fontSize: 11 }}>{e.text}</div>
              : <div key={i} className="meta" style={{ color: e.err ? "var(--err)" : undefined }}>{e.text}</div>,
            )}
            {busy && <div className="pip-working" role="status"><Pip size={30} working /><span className="muted">Working…</span></div>}
          </div>
        </div>
        {termOpen && cwd && !host && <Terminal cwd={cwd} onDevicePreview={(u) => { setDeviceUrl(u); setDeviceOpen(true); }} />}
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
      {deviceOpen ? <DevicePreview initialUrl={deviceUrl} onClose={() => setDeviceOpen(false)} /> : (
      <aside className="artifact-panel" style={{ width: 360, minWidth: 300 }} aria-label="Repository">
        <div className="topbar" data-tauri-drag-region="deep" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="title">{git?.is_repo ? `⎇ ${git.branch}` : "No git repository"}</span>
          <span className="spacer" />
          <button className="btn" onClick={async () => cwd && setDiff({ path: null, text: await invoke<string>("git_diff", { cwd, host, path: null }).catch((e) => String(e)) })} disabled={!git?.is_repo}>Full diff</button>
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
                <button key={path} className="nav-item" onClick={async () => cwd && setDiff({ path, text: (await invoke<string>("git_diff", { cwd, host, path }).catch((e) => String(e))) || "(untracked or no diff vs HEAD)" })}>
                  <span className="badge">{st}</span> <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{path}</span>
                </button>
              ))}
              {git?.is_repo && !git.files.length && <div className="muted" style={{ padding: 8 }}>Working tree clean.</div>}
              {git?.error && cwd && <div className="muted" style={{ padding: 8 }}>{git.error}</div>}
            </div>
          )}
        </div>
        {git?.is_repo && !host && (
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
      )}
    </div>
  );
}
