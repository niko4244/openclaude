import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Clock, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { api, type ModelEntry, type Task } from "../api";
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
        <div className="page-head"><h2>Tasks</h2><span className="spacer" /><button className="btn primary" onClick={() => open(blank(defaultModel))}><Plus size={15} /> New task</button></div>
        <p className="muted">Saved prompts that run on demand or on a schedule. Each run becomes a chat you can open and continue. Tasks run while OpenClaude is running (it stays in the tray when closed). Background runs can only use tools set to “Always allow”.</p>
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
                  {describe(t.schedule)}{!t.enabled && " · paused"}{t.next_run_at && t.enabled ? ` · next ${new Date(t.next_run_at).toLocaleString()}` : ""}
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
