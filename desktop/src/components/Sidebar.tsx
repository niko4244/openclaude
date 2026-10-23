import { useEffect, useState } from "react";
import {
  Code2, FolderClosed, ListChecks, MessagesSquare, MoreHorizontal, PanelLeft, Pin, PinOff, Pencil, Search, Settings as Cog, SquarePen, Trash2,
} from "lucide-react";
import type { Conversation, GatewayStatus, Project } from "../api";
import { Logo } from "./Logo";

export type Page = "chat" | "chats" | "projects" | "tasks" | "code" | "settings";

export function Sidebar({
  collapsed,
  conversations,
  projects,
  activeId,
  activeProject,
  page,
  status,
  profile,
  onNew,
  onOpen,
  onRename,
  onDelete,
  onTogglePin,
  onSelectProject,
  onNavigate,
  onToggle,
  onSearch,
}: {
  collapsed: boolean;
  conversations: Conversation[];
  projects: Project[];
  activeId: string | null;
  activeProject: string | null;
  page: Page;
  status: GatewayStatus | null;
  profile: { name: string; initials: string };
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (c: Conversation, title: string) => void;
  onDelete: (c: Conversation) => void;
  onTogglePin: (c: Conversation) => void;
  onSelectProject: (id: string | null) => void;
  onNavigate: (p: Page, tab?: string) => void;
  onToggle: () => void;
  onSearch: () => void;
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

  const starred = conversations.filter((c) => c.pinned);
  const recents = conversations.filter((c) => !c.pinned).slice(0, 40);
  const ok = status?.reachable && status.authenticated;
  const statusText = !status ? "Checking gateway…" : ok ? `LiteLLM · ${status.latency_ms} ms` : status.error || "Gateway offline";

  const NavBtn = ({ icon: Icon, label, active, onClick, title }: { icon: typeof Search; label: string; active?: boolean; onClick: () => void; title?: string }) => (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick} title={collapsed ? label : title} aria-label={label}>
      <Icon size={17} strokeWidth={1.75} />
      {!collapsed && <span>{label}</span>}
    </button>
  );

  const Row = (c: Conversation) => (
    <div
      key={c.id}
      className={`conv-item ${c.id === activeId && page === "chat" ? "active" : ""}`}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ c, x: e.clientX, y: e.clientY }); }}
    >
      {renaming === c.id ? (
        <input
          autoFocus
          value={draft}
          aria-label="Rename chat"
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
      <button className="icon-btn" aria-label="Chat options" onClick={(e) => { e.stopPropagation(); setMenu({ c, x: e.clientX, y: e.clientY }); }}>
        <MoreHorizontal size={15} />
      </button>
    </div>
  );

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`} aria-label="Sidebar">
      <div className="sidebar-head">
        {!collapsed && <span className="brand"><Logo size={20} /> OpenClaude</span>}
        <button className="icon-btn" onClick={onToggle} title={collapsed ? "Open sidebar (Ctrl+B)" : "Close sidebar (Ctrl+B)"} aria-label="Toggle sidebar">
          <PanelLeft size={17} strokeWidth={1.75} />
        </button>
      </div>
      <nav className="sidebar-nav">
        <button className="new-chat" onClick={onNew} title="New chat (Ctrl+N)" aria-label="New chat">
          <span className="plus"><SquarePen size={14} strokeWidth={2} /></span>
          {!collapsed && <span>New chat</span>}
        </button>
        <NavBtn icon={Search} label="Search" onClick={onSearch} title="Search chats (Ctrl+K)" />
        <NavBtn icon={MessagesSquare} label="Chats" active={page === "chats"} onClick={() => onNavigate("chats")} />
        <NavBtn icon={FolderClosed} label="Projects" active={page === "projects"} onClick={() => onNavigate("projects")} />
        <NavBtn icon={ListChecks} label="Tasks" active={page === "tasks"} onClick={() => onNavigate("tasks")} />
        <NavBtn icon={Code2} label="Code" active={page === "code"} onClick={() => onNavigate("code")} />
      </nav>
      {!collapsed && (
        <div className="conv-list">
          {projects.length > 0 && activeProject && (
            <div className="project-chip">
              <FolderClosed size={13} /> {projects.find((p) => p.id === activeProject)?.name}
              <button className="icon-btn" style={{ width: 20, height: 20 }} aria-label="Leave project" onClick={() => onSelectProject(null)}>×</button>
            </div>
          )}
          {starred.length > 0 && <div className="section-label">Starred</div>}
          {starred.map(Row)}
          {recents.length > 0 && <div className="section-label">Recents</div>}
          {recents.map(Row)}
          {!conversations.length && <div className="muted" style={{ padding: "12px 20px" }}>No chats yet.</div>}
        </div>
      )}
      {collapsed && <div className="spacer" />}
      <div className="sidebar-foot">
        <button className="account" onClick={() => onNavigate("settings")} title={`${profile.name} · ${statusText}`} aria-label="Settings and account">
          <span className="avatar">{profile.initials}</span>
          {!collapsed && (
            <span className="account-text">
              <span className="account-name">{profile.name}</span>
              <span className="account-sub"><span className={`dot ${!status ? "" : ok ? "ok" : status.reachable ? "warn" : "err"}`} /> {statusText}</span>
            </span>
          )}
          {!collapsed && <Cog size={15} className="muted" />}
        </button>
      </div>
      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button role="menuitem" onClick={() => onTogglePin(menu.c)}>{menu.c.pinned ? <PinOff size={14} /> : <Pin size={14} />} {menu.c.pinned ? "Unstar" : "Star"}</button>
          <button role="menuitem" onClick={() => { setRenaming(menu.c.id); setDraft(menu.c.title); }}><Pencil size={14} /> Rename</button>
          <button role="menuitem" className="danger" onClick={() => onDelete(menu.c)}><Trash2 size={14} /> Delete</button>
        </div>
      )}
    </aside>
  );
}
