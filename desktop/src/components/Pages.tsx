import { useEffect, useRef, useState } from "react";
import { FolderClosed, MessageSquare, Plus, Search } from "lucide-react";
import { api, type Conversation, type Project } from "../api";

export function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Ctrl+K: search every chat (titles and message text). */
export function SearchPalette({ onOpen, onClose }: { onOpen: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Conversation[]>([]);
  const [hl, setHl] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const t = setTimeout(() => void api.listConversations(q, null).then((r) => { setRows(r.slice(0, 50)); setHl(0); }), 120);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Search chats" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input"><Search size={16} className="muted" />
          <input ref={input} value={q} placeholder="Search chats…" aria-label="Search chats" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, rows.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
              else if (e.key === "Enter" && rows[hl]) onOpen(rows[hl].id);
              else if (e.key === "Escape") onClose();
            }} />
        </div>
        <div className="results">
          {rows.map((c, i) => (
            <button key={c.id} className={`palette-row ${i === hl ? "hl" : ""}`} onMouseEnter={() => setHl(i)} onClick={() => onOpen(c.id)}>
              <MessageSquare size={15} className="muted" /><span className="grow">{c.title}</span><span className="muted">{ago(c.updated_at)}</span>
            </button>
          ))}
          {!rows.length && <div className="muted" style={{ padding: 14 }}>{q ? "No chats match." : "No chats yet."}</div>}
        </div>
      </div>
    </div>
  );
}

export function ChatsPage({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Conversation[]>([]);
  useEffect(() => {
    const t = setTimeout(() => void api.listConversations(q, null).then(setRows), 120);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head"><h2>Your chat history</h2><span className="spacer" /><button className="btn primary" onClick={onNew}><Plus size={15} /> New chat</button></div>
        <div className="page-search"><Search size={16} className="muted" /><input value={q} placeholder="Search your chats…" aria-label="Search your chats" onChange={(e) => setQ(e.target.value)} /></div>
        <div className="muted" style={{ margin: "10px 2px" }}>{rows.length} chat{rows.length === 1 ? "" : "s"}{q ? ` matching “${q}”` : ""}</div>
        <div className="list">
          {rows.map((c) => (
            <button key={c.id} className="list-row" onClick={() => onOpen(c.id)}>
              <span className="list-title">{c.title}</span>
              <span className="muted">{c.model ? `${c.model} · ` : ""}Last message {ago(c.updated_at)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProjectsPage({ projects, onOpen, onCreate }: { projects: Project[]; onOpen: (id: string) => void; onCreate: () => void }) {
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head"><h2>Projects</h2><span className="spacer" /><button className="btn primary" onClick={onCreate}><Plus size={15} /> New project</button></div>
        <p className="muted">Projects keep related chats together, with shared instructions and a default model.</p>
        <div className="grid">
          {projects.map((p) => (
            <button key={p.id} className="card project-card" onClick={() => onOpen(p.id)}>
              <div className="card-head"><FolderClosed size={16} /><span className="name">{p.name}</span></div>
              <div className="muted clamp">{p.instructions || "No instructions yet."}</div>
              <div className="muted" style={{ marginTop: "auto" }}>{p.default_model || "global default model"} · updated {ago(p.updated_at)}</div>
            </button>
          ))}
          {!projects.length && <div className="muted">No projects yet. Create one to group chats with shared instructions.</div>}
        </div>
      </div>
    </div>
  );
}
