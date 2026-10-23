import { useEffect, useState } from "react";
import type { Conversation, GatewayStatus, Project } from "../api";

function bucket(ts: number) {
  const d = Date.now() - ts;
  const day = 86_400_000;
  if (d < day) return "Today";
  if (d < 2 * day) return "Yesterday";
  if (d < 7 * day) return "Previous 7 days";
  if (d < 30 * day) return "Previous 30 days";
  return "Older";
}

export function Sidebar({
  collapsed,
  conversations,
  projects,
  activeId,
  activeProject,
  view,
  status,
  query,
  onQuery,
  onNew,
  onOpen,
  onRename,
  onDelete,
  onTogglePin,
  onSelectProject,
  onSettings,
  onCode,
  onToggle,
  searchRef,
}: {
  collapsed: boolean;
  conversations: Conversation[];
  projects: Project[];
  activeId: string | null;
  activeProject: string | null;
  view: string;
  status: GatewayStatus | null;
  query: string;
  onQuery: (q: string) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (c: Conversation, title: string) => void;
  onDelete: (c: Conversation) => void;
  onTogglePin: (c: Conversation) => void;
  onSelectProject: (id: string | null) => void;
  onSettings: (tab?: string) => void;
  onCode: () => void;
  onToggle: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ c: Conversation; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const groups = new Map<string, Conversation[]>();
  for (const c of conversations) {
    const g = c.pinned ? "Pinned" : bucket(c.updated_at);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  }
  const statusDot = !status ? "" : status.reachable && status.authenticated ? "ok" : status.reachable ? "warn" : "err";
  const statusText = !status ? "Checking gateway…" : status.reachable && status.authenticated ? `Gateway online · ${status.latency_ms} ms` : status.error || "Gateway offline";

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`} aria-label="Sidebar">
      <div className="sidebar-head">
        <span className="brand">OpenClaude</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onToggle} title="Collapse sidebar (Ctrl+B)" aria-label="Collapse sidebar">⟨</button>
      </div>
      <button className="new-chat" onClick={onNew} title="New chat (Ctrl+N)">
        <span className="plus">+</span> New chat
      </button>
      <input ref={searchRef} className="search" placeholder="Search chats  (Ctrl+K)" value={query} onChange={(e) => onQuery(e.target.value)} aria-label="Search chats" />
      <button className={`nav-item ${view === "chat" && !activeProject ? "active" : ""}`} onClick={() => onSelectProject(null)}>💬 All chats</button>
      <button className={`nav-item ${view === "code" ? "active" : ""}`} onClick={onCode}>⌨ Code</button>
      {projects.length > 0 && <div className="section-label">Projects</div>}
      {projects.map((p) => (
        <button key={p.id} className={`nav-item ${activeProject === p.id ? "active" : ""}`} onClick={() => onSelectProject(p.id)}>📁 {p.name}</button>
      ))}
      <button className="nav-item" onClick={() => onSettings("projects")}>＋ New project</button>
      <div className="conv-list">
        {[...groups.entries()].map(([g, cs]) => (
          <div key={g}>
            <div className="section-label">{g}</div>
            {cs.map((c) => (
              <div
                key={c.id}
                className={`conv-item ${c.id === activeId ? "active" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ c, x: e.clientX, y: e.clientY });
                }}
              >
                {renaming === c.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => { setRenaming(null); if (draft.trim()) onRename(c, draft.trim()); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <button className="conv-title" onClick={() => onOpen(c.id)} onDoubleClick={() => { setRenaming(c.id); setDraft(c.title); }} title={c.title}>
                    {c.title}
                  </button>
                )}
                <button className="icon-btn" aria-label="Chat options" onClick={(e) => { e.stopPropagation(); setMenu({ c, x: e.clientX, y: e.clientY }); }}>⋯</button>
              </div>
            ))}
          </div>
        ))}
        {!conversations.length && <div className="muted" style={{ padding: "12px 20px" }}>{query ? "No chats match." : "No chats yet."}</div>}
      </div>
      <div className="sidebar-foot">
        <span className={`dot ${statusDot}`} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={statusText}>{statusText}</span>
        <button className="icon-btn" onClick={() => onSettings()} title="Settings (Ctrl+,)" aria-label="Settings">⚙</button>
      </div>
      {menu && (
        <div className="card" style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 90, padding: 4, minWidth: 150 }} role="menu">
          <button className="nav-item" role="menuitem" onClick={() => onTogglePin(menu.c)}>{menu.c.pinned ? "Unpin" : "Pin"}</button>
          <button className="nav-item" role="menuitem" onClick={() => { setRenaming(menu.c.id); setDraft(menu.c.title); }}>Rename</button>
          <button className="nav-item" role="menuitem" style={{ color: "var(--err)" }} onClick={() => onDelete(menu.c)}>Delete</button>
        </div>
      )}
    </aside>
  );
}
