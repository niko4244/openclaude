import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clock, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { api, type ModelEntry, type Task, type PendingAction, type Proactive } from "../api";
import { ago } from "./Pages";

function describe(schedule: string) {
  if (schedule.startsWith("every:")) return `Every ${schedule.slice(6)} min`;
  if (schedule.startsWith("daily:")) return `Daily at ${schedule.slice(6)}`;
  return "Manual";
}

const blank = (model: string | null): Task => ({
  id: "", title: "", prompt: "", model: model || "", schedule: "manual", enabled: true,
  next_run_at: null, last_run_at: null, last_status: null, last_conversation_id: null, running: false,
});

export function TasksPage({ models, defaultModel, onOpenChat, toast }: { models: ModelEntry[]; defaultModel: string | null; onOpenChat: (id: string) => void; toast: (m: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [edit, setEdit] = useState<Task | null>(null);
  const [kind, setKind] = useState("manual");
  const [every, setEvery] = useState("60");
  const [at, setAt] = useState("09:00");
  const [err, setErr] = useState<string | null>(null);

  const load = async () => setTasks(await api.tasksList());
  const [folders, setFolders] = useState<string[]>([]);
  useEffect(() => { void invoke<string[]>("list_workspaces").then(setFolders); }, []);
  useEffect(() => {
    void load();
    const un = listen("tasks-changed", () => void load());
    const t = setInterval(load, 15000);
    return () => { void un.then((f) => f()); clearInterval(t); };
  }, []);

  const open = (t: Task) => {
    setEdit(t);
    setErr(null);
    setKind(t.schedule.split(":")[0]);
    if (t.schedule.startsWith("every:")) setEvery(t.schedule.slice(6));
    if (t.schedule.startsWith("daily:")) setAt(t.schedule.slice(6));
  };
  const save = async () => {
    if (!edit) return;
    const schedule = kind === "every" ? `every:${every}` : kind === "daily" ? `daily:${at}` : "manual";
    try { await api.taskSave({ ...edit, schedule }); setEdit(null); await load(); toast("Task saved"); }
    catch (e) { setErr(String(e)); }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head"><h1>Tasks</h1><span className="spacer" /><button className="btn primary" onClick={() => open(blank(defaultModel))}><Plus size={15} /> New task</button></div>
        <p className="muted">Saved prompts that run on demand or on a schedule. Each run becomes a chat you can open and continue. Tasks run while OpenClaude is running (it stays in the tray when closed). Tools set to “Always allow” run directly; anything else waits for you in the inbox below.</p>
        <Inbox onOpenChat={onOpenChat} toast={toast} />
        <ProactiveCard models={models} defaultModel={defaultModel} toast={toast} />
        {edit && (
          <div className="card">
            <div className="field"><label>Title</label><input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Morning briefing" /></div>
            <div className="field"><label>Prompt</label><textarea value={edit.prompt} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} placeholder="Summarize what changed in my repos since yesterday…" /></div>
            <div className="field"><label>Model</label>
              <select value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
              </select>
            </div>
            <div className="field"><label>Schedule</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="manual">Manual only</option>
                  <option value="every">Every N minutes</option>
                  <option value="daily">Daily at</option>
                </select>
                {kind === "every" && <input type="number" min={5} value={every} onChange={(e) => setEvery(e.target.value)} style={{ width: 90 }} />}
                {kind === "daily" && <input type="time" value={at} onChange={(e) => setAt(e.target.value)} />}
              </div>
            </div>
            <div className="field"><label>Work in folder (optional)</label>
              <select aria-label="Task folder" value={edit.workspace || ""} onChange={(e) => setEdit({ ...edit, workspace: e.target.value || null })}>
                <option value="">No folder (chat task)</option>
                {folders.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <span className="help">With a folder, the OpenClaude coding agent works there: file edits inside the folder are allowed; shell commands that change things and anything else needing approval are denied (read-only commands still run). Folders come from Code → Open folder.</span>
            </div>
            <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /> Enabled</label>
            {err && <div className="error-box">{err}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn primary" onClick={save}>Save task</button>
              <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        )}
        <div className="list">
          {tasks.map((t) => (
            <div key={t.id} className="task-row">
              <span className="artifact-icon">{t.running ? <Loader2 size={17} className="logo-spin" /> : <Clock size={17} />}</span>
              <button className="grow task-main" onClick={() => open(t)}>
                <span className="list-title">{t.title}</span>
                <span className="muted">
                  {describe(t.schedule)}{t.workspace ? ` · in ${t.workspace.split(/[\\/]/).pop()}` : ""}{!t.enabled && " · paused"}{t.next_run_at && t.enabled ? ` · next ${new Date(t.next_run_at).toLocaleString()}` : ""}
                  {t.last_run_at ? ` · last run ${ago(t.last_run_at)}: ` : ""}
                  {t.last_status && <span style={{ color: t.last_status === "ok" ? "var(--ok)" : "var(--err)" }}>{t.last_status}</span>}
                </span>
              </button>
              {t.last_conversation_id && <button className="btn" onClick={() => onOpenChat(t.last_conversation_id!)}>Open result</button>}
              <button className="btn" disabled={t.running} onClick={async () => { try { await api.taskRunNow(t.id); await load(); } catch (e) { toast(String(e)); } }}><Play size={14} /> Run now</button>
              <button className="icon-btn" aria-label={`Delete ${t.title}`} onClick={async () => { if (confirm(`Delete task “${t.title}”?`)) { await api.taskDelete(t.id); await load(); } }}><Trash2 size={15} /></button>
            </div>
          ))}
          {!tasks.length && !edit && <div className="muted" style={{ padding: 14 }}>No tasks yet.</div>}
        </div>
      </div>
    </div>
  );
}

function Inbox({ onOpenChat, toast }: { onOpenChat: (id: string) => void; toast: (m: string) => void }) {
  const [items, setItems] = useState<PendingAction[]>([]);
  const load = async () => setItems(await api.pendingList());
  useEffect(() => {
    void load();
    const un = listen("inbox-changed", () => void load());
    const un2 = listen("tasks-changed", () => void load());
    const t = setInterval(load, 15000);
    return () => { void un.then((f) => f()); void un2.then((f) => f()); clearInterval(t); };
  }, []);
  const waiting = items.filter((i) => i.status === "pending");
  const decide = async (i: PendingAction, approve: boolean) => {
    try { await api.pendingDecide(i.id, approve); toast(approve ? `Approved ${i.tool}` : `Declined ${i.tool}`); await load(); }
    catch (e) { toast(String(e)); }
  };
  if (!items.length) return null;
  return (
    <div className="card inbox" aria-label="Approvals inbox">
      <div className="card-head"><span className="name">Waiting for your approval</span><span className="badge">{waiting.length}</span></div>
      {waiting.length === 0 && <div className="muted">Nothing is waiting.</div>}
      {waiting.map((i) => (
        <div key={i.id} className="offer-row" data-pending={i.tool}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>{i.server} › {i.tool}</strong> <span className="muted">· from “{i.conversation_title}”</span>
            <pre className="mono context-preview" style={{ margin: "4px 0 0", maxHeight: 120 }}>{JSON.stringify(i.arguments, null, 2)}</pre>
          </span>
          <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button className="btn primary" onClick={() => void decide(i, true)}>Approve</button>
            <button className="btn" onClick={() => void decide(i, false)}>Decline</button>
            <button className="btn" onClick={() => onOpenChat(i.conversation_id)}>Open chat</button>
          </span>
        </div>
      ))}
      {items.some((i) => i.status !== "pending") && (
        <details style={{ marginTop: 6 }}>
          <summary className="muted">Recent decisions</summary>
          {items.filter((i) => i.status !== "pending").map((i) => <div key={i.id} className="muted" style={{ fontSize: 12.5 }}>{i.status} · {i.server} › {i.tool} · {new Date(i.created_at).toLocaleString()}</div>)}
        </details>
      )}
    </div>
  );
}

function ProactiveCard({ models, defaultModel, toast }: { models: ModelEntry[]; defaultModel: string | null; toast: (m: string) => void }) {
  const [p, setP] = useState<Proactive | null>(null);
  useEffect(() => { void api.proactiveGet().then((x) => setP({ ...x, model: x.model || defaultModel || "" })); }, [defaultModel]);
  if (!p) return null;
  const save = async (next: Proactive) => {
    try { await api.proactiveSet(next); setP(next); toast(next.enabled ? "Proactive assistant on" : "Proactive assistant off"); }
    catch (e) { toast(String(e)); }
  };
  return (
    <div className="card" aria-label="Proactive assistant">
      <div className="card-head"><span className="name">Proactive assistant</span>{p.enabled && <span className="badge local">on</span>}</div>
      <div className="muted" style={{ margin: "4px 0 8px" }}>A morning brief and regular check-ins across your connectors (mail, calendar, tasks…). It reads freely; anything that would change something waits for your approval above.</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label className="muted">Brief at <input type="time" value={p.brief_at} onChange={(e) => setP({ ...p, brief_at: e.target.value })} aria-label="Brief time" /></label>
        <label className="muted">Check in every <select value={p.every_hours} onChange={(e) => setP({ ...p, every_hours: Number(e.target.value) })} aria-label="Check-in interval">{[0, 1, 2, 3, 4, 6, 8, 12].map((h) => <option key={h} value={h}>{h === 0 ? "never" : `${h} h`}</option>)}</select></label>
        <select value={p.model} onChange={(e) => setP({ ...p, model: e.target.value })} aria-label="Model">{models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</select>
        <button className="btn primary" onClick={() => void save({ ...p, enabled: true })}>{p.enabled ? "Save" : "Turn on"}</button>
        {p.enabled && <button className="btn" onClick={() => void save({ ...p, enabled: false })}>Turn off</button>}
      </div>
    </div>
  );
}
