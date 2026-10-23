import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { BookOpen, ChevronDown, Code2, Coffee, Download, Lightbulb, PenLine, Pin, PinOff, Pencil, Trash2 } from "lucide-react";
import { api, textOf, type Attachment, type Conversation, type GatewayStatus, type Message, type ModelEntry, type Project } from "./api";
import { Sidebar, type Page } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { Composer, buildContent } from "./components/Composer";
import { ModelPicker } from "./components/ModelPicker";
import { Settings } from "./components/Settings";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { CodeView } from "./components/CodeView";
import { FindBar, ShortcutsSheet } from "./components/FindBar";
import { ChatsPage, ProjectKnowledge, ProjectsPage, SearchPalette, ago } from "./components/Pages";
import { ToolsMenu } from "./components/ToolsMenu";
import { TasksPage } from "./components/TasksPage";
import { TitleBar } from "./components/TitleBar";
import { Logo } from "./components/Logo";
import { extractArtifacts, type Artifact } from "./components/Markdown";

import { useChat } from "./useChat";
import { speak, voiceMode } from "./voiceMode";

const STARTERS: { icon: typeof PenLine; label: string; prompt: string }[] = [
  { icon: PenLine, label: "Write", prompt: "Help me write " },
  { icon: BookOpen, label: "Learn", prompt: "Explain to me how " },
  { icon: Code2, label: "Code", prompt: "Write code that " },
  { icon: Coffee, label: "Life stuff", prompt: "Help me plan " },
  { icon: Lightbulb, label: "Brainstorm", prompt: "Brainstorm ideas for " },
];

function greeting(name: string) {
  const h = new Date().getHours();
  const first = name.split(/\s+/)[0];
  if (h < 5) return `Up late, ${first}?`;
  return `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}, ${first}`;
}

function initialsOf(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
}

export default function App() {
  const [page, setPage] = useState<Page>("chat");
  const [settingsTab, setSettingsTab] = useState<string | undefined>();
  const [collapsed, setCollapsed] = useState(false);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [theme, setTheme] = useState("system");
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [titleMenu, setTitleMenu] = useState(false);
  const [userName, setUserName] = useState("there");
  const [seed, setSeed] = useState<{ key: string; text: string }>({ key: "home", text: "" });
  const [measured, setMeasured] = useState<Record<string, Record<string, boolean>>>({});
  const draftTimer = useRef<number | undefined>(undefined);

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const refreshConvs = useCallback(async () => setConvs(await api.listConversations(undefined, activeProject)), [activeProject]);
  const chat = useChat(activeId, refreshConvs, toast);
  const active = convs.find((c) => c.id === activeId) || null;

  const loadModels = useCallback(async (refresh = false) => {
    try {
      const ms = await api.listModels(refresh);
      setModels(ms);
      return ms;
    } catch (e) {
      toast(`Could not load models: ${e}`);
      return [];
    }
  }, [toast]);

  const loadProbes = useCallback(async () => {
    const probes = await api.getProbes();
    setMeasured(Object.fromEntries(probes.map((p) => [p.model, Object.fromEntries(p.checks.map((c) => [c.name, c.ok]))])));
  }, []);

  const checkGateway = useCallback(async () => setStatus(await api.gatewayStatus()), []);
  const loadProfile = useCallback(async () => {
    const os = (await api.appInfo()).username;
    const n = (await api.getSetting("user_name")) || (os ? os[0].toUpperCase() + os.slice(1) : "there");
    setUserName(n);
  }, []);

  // ---- boot
  useEffect(() => {
    void (async () => {
      const t = (await api.getSetting("theme")) || "system";
      setTheme(t);
      void loadProfile();
      setFavorites(JSON.parse((await api.getSetting("favorite_models")) || "[]"));
      setProjects(await api.listProjects());
      await checkGateway();
      const ms = await loadModels();
      await loadProbes();
      const saved = await api.getSetting("default_model");
      const pick = (saved && ms.find((m) => m.id === saved)?.id) || ms.find((m) => m.local && m.supports_tools)?.id || ms.find((m) => m.local)?.id || ms[0]?.id || null;
      setModel(pick);
    })();
    const t = setInterval(checkGateway, 30_000);
    return () => clearInterval(t);
  }, [checkGateway, loadModels, loadProbes, loadProfile]);

  useEffect(() => { void refreshConvs(); }, [refreshConvs]);

  // When a reply finishes, open the newest artifact it produced (the reference app's behaviour).
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !chat.busy) {
      const last = [...chat.messages].reverse().find((m) => m.role === "assistant");
      const arts = last ? extractArtifacts(textOf(last.content)) : [];
      if (arts.length) setArtifact(arts[arts.length - 1]);
      if (last && voiceMode.get()) speak(textOf(last.content));
    }
    wasBusy.current = chat.busy;
  }, [chat.busy, chat.messages]);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  // conversation's own model wins when opening it
  useEffect(() => {
    if (active?.model && models.some((m) => m.id === active.model)) setModel(active.model);
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((p: Page, tab?: string) => {
    setPage(p);
    setSettingsTab(tab);
    setFindOpen(false);
    if (p !== "chat") setArtifact(null);
  }, []);

  const openChat = useCallback((id: string) => {
    setActiveId(id);
    setSearchOpen(false);
    go("chat");
  }, [go]);

  const newChat = useCallback(() => {
    setActiveId(null);
    go("chat");
    if (activeProject) {
      const p = projects.find((x) => x.id === activeProject);
      if (p?.default_model) setModel(p.default_model);
    }
  }, [activeProject, projects, go]);

  // ---- global quick-entry shortcut
  useEffect(() => {
    const apply = async () => {
      try {
        await unregisterAll();
        const s = (await api.getSetting("quick_entry_shortcut")) ?? "CommandOrControl+Alt+Space";
        if (!s) return;
        await register(s, (e) => {
          if (e.state === "Pressed") void invoke("quick_entry_toggle");
        });
      } catch (err) {
        console.warn("shortcut registration failed", err);
      }
    };
    void apply();
    window.addEventListener("oc-shortcut-changed", apply);
    return () => window.removeEventListener("oc-shortcut-changed", apply);
  }, []);

  // ---- native menu + quick entry hand-off (refs so the listeners see fresh state)
  const menuRef = useRef<(id: string) => void>(() => {});
  const quickRef = useRef<(p: { text: string; model: string | null }) => void>(() => {});
  useEffect(() => {
    const u1 = listen<string>("menu", (e) => menuRef.current(e.payload));
    const u2 = listen<{ text: string; model: string | null }>("quick-submit", (e) => quickRef.current(e.payload));
    // openclaude://new?prompt=… prefills a new chat; the user still presses Send.
    const u3 = listen<string>("deep-link-new", (e) => menuRef.current(`deep:${e.payload}`));
    const u4 = listen<string>("open-chat", (e) => menuRef.current(`open:${e.payload}`));
    return () => {
      void u1.then((f) => f());
      void u2.then((f) => f());
      void u3.then((f) => f());
      void u4.then((f) => f());
    };
  }, []);

  // ---- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "n") { e.preventDefault(); newChat(); }
      else if (mod && k === "k") { e.preventDefault(); setSearchOpen((s) => !s); }
      else if (mod && k === "b") { e.preventDefault(); setCollapsed((c) => !c); }
      else if (mod && e.key === ",") { e.preventDefault(); go("settings"); }
      else if (mod && k === "f") { e.preventDefault(); if (page === "chat" && activeId) setFindOpen(true); }
      else if (mod && e.key === "/") { e.preventDefault(); setSheetOpen((s) => !s); }
      else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); void invoke("menu_action", { id: "zoom_in" }); }
      else if (mod && e.key === "-") { e.preventDefault(); void invoke("menu_action", { id: "zoom_out" }); }
      else if (mod && e.key === "0") { e.preventDefault(); void invoke("menu_action", { id: "zoom_reset" }); }
      else if (e.key === "Escape" && (findOpen || sheetOpen || titleMenu)) { setFindOpen(false); setSheetOpen(false); setTitleMenu(false); }
      else if (e.key === "Escape" && activeId && chat.busy) { e.preventDefault(); void chat.stop(activeId); }
      else if (e.key === "Escape" && page === "settings") go("chat");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, activeId, chat, page, findOpen, sheetOpen, titleMenu, go]);

  const chooseModel = async (id: string) => {
    setModel(id);
    await api.setSetting("default_model", id);
    if (active && active.model !== id) {
      await api.updateConversation({ ...active, model: id });
      void refreshConvs();
    }
  };

  const toggleFavorite = async (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id];
    setFavorites(next);
    await api.setSetting("favorite_models", JSON.stringify(next));
  };

  const send = async (text: string, atts: Attachment[], opts: { fresh?: boolean; model?: string | null } = {}) => {
    const useModel = (opts.model && models.some((m) => m.id === opts.model) ? opts.model : null) || model;
    if (!useModel) return toast("Pick a model first");
    const vision = models.find((m) => m.id === useModel)?.supports_vision ?? measured[useModel]?.vision;
    if (atts.some((a) => a.kind === "image") && vision === false) toast(`${useModel} cannot read images (declared or measured); the request may fail.`);
    let cid = opts.fresh ? null : activeId;
    if (!cid) {
      go("chat");
      const c = await api.createConversation(opts.fresh ? null : activeProject, useModel);
      cid = c.id;
      setActiveId(cid);
      setConvs((cs) => [c, ...cs]);
    }
    void chat.send(cid, buildContent(text, atts), useModel);
    setTimeout(refreshConvs, 400);
  };

  const deleteChat = async (c: Conversation) => {
    if (!confirm(`Delete “${c.title}”? This cannot be undone.`)) return;
    await api.deleteConversation(c.id);
    if (c.id === activeId) setActiveId(null);
    void refreshConvs();
  };

  menuRef.current = (id: string) => {
    if (id.startsWith("open:")) {
      void refreshConvs();
      return openChat(id.slice(5));
    }
    if (id.startsWith("deep:")) {
      newChat();
      setSeed({ key: `deep-${Date.now()}`, text: id.slice(5) });
      return;
    }
    switch (id) {
      case "new_chat": return newChat();
      case "settings": return go("settings");
      case "toggle_sidebar": return setCollapsed((c) => !c);
      case "search": return setSearchOpen(true);
      case "code": return go("code");
      case "find": if (activeId) { go("chat"); setFindOpen(true); } return;
      case "shortcuts": return setSheetOpen(true);
      case "about": return go("settings", "about");
    }
  };
  quickRef.current = ({ text, model: m }) => {
    if (m && models.some((x) => x.id === m)) setModel(m);
    void send(text, [], { fresh: true, model: m });
  };

  const saveDraft = (t: string) => {
    if (!active) return;
    clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => void api.updateConversation({ ...active, draft: t }), 500);
  };

  // Artifacts across this chat; same title = versions of one artifact.
  const chatArtifacts = chat.messages.filter((m) => m.role === "assistant").flatMap((m) => extractArtifacts(textOf(m.content)));
  const versionsOf = (title: string) => chatArtifacts.filter((a) => a.title === title);

  const modelsView = models.map((m) => (measured[m.id] ? { ...m, measured: measured[m.id] } : m));
  const picker = <ModelPicker models={modelsView} value={model} onChange={chooseModel} favorites={favorites} onToggleFavorite={toggleFavorite} />;
  const tools = <ToolsMenu onManage={() => go("settings", "connectors")} />;
  const project = projects.find((p) => p.id === activeProject);
  const initials = initialsOf(userName);
  const retryModels = [...new Set([...favorites, ...(model ? [model] : []), ...models.filter((m) => m.local).map((m) => m.id)])].slice(0, 12);
  const gatewayDown = status && !(status.reachable && status.authenticated);

  return (
    <div className="shell">
    <TitleBar onMenu={(id) => menuRef.current(id)} />
    {/* While a dialog is open the page behind it is inert (not focusable, hidden from assistive tech). */}
    <div className="app" inert={searchOpen || sheetOpen || undefined} aria-hidden={searchOpen || sheetOpen || undefined}>
      <Sidebar
        collapsed={collapsed}
        conversations={convs}
        projects={projects}
        activeId={activeId}
        activeProject={activeProject}
        page={page}
        status={status}
        profile={{ name: userName, initials }}
        onNew={newChat}
        onOpen={openChat}
        onRename={async (c, title) => { await api.updateConversation({ ...c, title }); void refreshConvs(); }}
        onDelete={deleteChat}
        onTogglePin={async (c) => { await api.updateConversation({ ...c, pinned: !c.pinned }); void refreshConvs(); }}
        onSelectProject={(id) => { setActiveProject(id); setActiveId(null); go("chat"); }}
        onNavigate={go}
        onToggle={() => setCollapsed((c) => !c)}
        onSearch={() => setSearchOpen(true)}
      />
      <main className="main">
        {page === "chat" && activeId && <h1 className="sr-only">{active?.title || "Chat"}</h1>}
        {page === "code" && <h1 className="sr-only">Code workspace</h1>}
        {page === "chat" && activeId && (
          <div className="topbar chat-top">
            <span className="spacer" />
            <div className="picker">
              <button className="title-btn" onClick={() => setTitleMenu((o) => !o)} aria-haspopup="menu" aria-expanded={titleMenu}>
                {project && <span className="muted">{project.name} /</span>}
                <span className="title">{active?.title || "New chat"}</span>
                <ChevronDown size={14} />
              </button>
              {titleMenu && active && (
                <div className="menu" style={{ position: "absolute", top: 34, left: "50%", transform: "translateX(-50%)" }} role="menu" onMouseLeave={() => setTitleMenu(false)}>
                  <button role="menuitem" onClick={async () => { setTitleMenu(false); await api.updateConversation({ ...active, pinned: !active.pinned }); void refreshConvs(); }}>
                    {active.pinned ? <PinOff size={14} /> : <Pin size={14} />} {active.pinned ? "Unstar" : "Star"}
                  </button>
                  <button role="menuitem" onClick={async () => {
                    setTitleMenu(false);
                    const t = prompt("Rename chat", active.title);
                    if (t?.trim()) { await api.updateConversation({ ...active, title: t.trim() }); void refreshConvs(); }
                  }}><Pencil size={14} /> Rename</button>
                  <button role="menuitem" onClick={async () => { setTitleMenu(false); const p = await api.exportChat(active.id); if (p) toast(`Exported to ${p}`); }}><Download size={14} /> Export as Markdown</button>
                  <button role="menuitem" className="danger" onClick={() => { setTitleMenu(false); void deleteChat(active); }}><Trash2 size={14} /> Delete</button>
                </div>
              )}
            </div>
            <span className="spacer" />
            {gatewayDown && <button className="btn danger" onClick={() => go("settings", "gateway")}>Gateway {status!.reachable ? "auth failed" : "offline"}</button>}
          </div>
        )}
        {page === "settings" ? (
          <Settings
            initialTab={settingsTab}
            models={models}
            onModelsChanged={async () => { await loadModels(true); await loadProbes(); }}
            onGatewayChanged={async () => { await checkGateway(); const ms = await loadModels(true); if (!model && ms[0]) setModel(ms[0].id); }}
            theme={theme}
            onTheme={async (t) => { setTheme(t); await api.setSetting("theme", t); }}
            projects={projects}
            onProjectsChanged={async () => setProjects(await api.listProjects())}
            onProfileChanged={loadProfile}
            onClose={() => go("chat")}
            toast={toast}
          />
        ) : page === "code" ? (
          <CodeView models={modelsView} favorites={favorites} onToggleFavorite={toggleFavorite} defaultModel={model} />
        ) : page === "tasks" ? (
          <TasksPage models={models} defaultModel={model} onOpenChat={(id) => { void refreshConvs(); openChat(id); }} toast={toast} />
        ) : page === "chats" ? (
          <ChatsPage onOpen={openChat} onNew={newChat} />
        ) : page === "projects" ? (
          <ProjectsPage projects={projects} onOpen={(id) => { setActiveProject(id); setActiveId(null); go("chat"); }} onCreate={() => go("settings", "projects")} />
        ) : !activeId ? (
          <div className="home">
            {gatewayDown && (
              <div className="banner" role="alert">
                Gateway {status!.reachable ? "rejected the API key" : "is offline"}. <button className="btn" onClick={() => go("settings", "gateway")}>Fix in Settings</button>
              </div>
            )}
            <h1 className="greeting"><Logo size={34} /> {project ? project.name : greeting(userName)}</h1>
            <div className="composer-wrap">
              <Composer
                onSend={send}
                busy={false}
                modelSlot={picker}
                toolsSlot={tools}
                autoFocus
                focusKey={`${seed.key}-${activeProject}`}
                initialDraft={seed.text}
                placeholder="How can I help you today?"
                onError={toast}
              />
              {!project && (
                <div className="suggestions">
                  {STARTERS.map(({ icon: Icon, label, prompt }) => (
                    <button key={label} className="chip-btn" onClick={() => setSeed({ key: `${label}-${Date.now()}`, text: prompt })}><Icon size={15} /> {label}</button>
                  ))}
                </div>
              )}
              {project && (
                <div className="project-home">
                  {project.instructions && <div className="card"><div className="muted">Instructions</div><div style={{ whiteSpace: "pre-wrap" }}>{project.instructions}</div></div>}
                  <ProjectKnowledge projectId={project.id} toast={toast} />
                  <div className="section-label" style={{ padding: "12px 2px 4px" }}>Chats in this project</div>
                  {convs.map((c) => (
                    <button key={c.id} className="list-row" onClick={() => openChat(c.id)}>
                      <span className="list-title">{c.title}</span><span className="muted">{ago(c.updated_at)}</span>
                    </button>
                  ))}
                  {!convs.length && <div className="muted">No chats yet. Start one above.</div>}
                </div>
              )}
              {!models.length && status && (
                <p className="hint">No models loaded. <a href="#" onClick={(e) => { e.preventDefault(); go("settings", "gateway"); }}>Configure your gateway</a>.</p>
              )}
            </div>
          </div>
        ) : (
          <>
            {findOpen && <FindBar root={() => document.querySelector(".chat-inner")} onClose={() => setFindOpen(false)} />}
            <ChatView
              messages={chat.messages}
              live={chat.live}
              initials={initials}
              retryModels={retryModels}
              onRegenerate={(from, m) => { const use = m || model; if (use) { if (m) setModel(m); void chat.send(activeId, null, use, from); } }}
              onEdit={(m: Message, text) => model && void chat.send(activeId, text, model, m.id)}
              onDecide={(a, allow, remember) => void chat.decide(activeId, a, allow, remember)}
              onOpenArtifact={setArtifact}
              onDismissError={() => chat.clearError(activeId)}
              onSwitchBranch={async (id) => { await api.switchBranch(activeId, id); await chat.reload(activeId); }}
            />
            <div className="composer-dock">
              <div className="composer-wrap">
                <Composer
                  onSend={send}
                  onStop={() => void chat.stop(activeId)}
                  busy={chat.busy}
                  modelSlot={picker}
                  toolsSlot={tools}
                  initialDraft={active?.draft || ""}
                  onDraftChange={saveDraft}
                  placeholder="Reply…"
                  autoFocus
                  focusKey={activeId}
                  onError={toast}
                />
                <div className="hint">OpenClaude can make mistakes. Replies come from {model || "your selected model"} through your gateway.</div>
              </div>
            </div>
          </>
        )}
      </main>

      {artifact && page === "chat" && (
        <ArtifactPanel
          artifact={versionsOf(artifact.title).find((v) => v.code === artifact.code) ?? artifact}
          versions={versionsOf(artifact.title)}
          onSelect={setArtifact}
          onClose={() => setArtifact(null)}
          onAsk={(t) => void send(t, [])}
        />
      )}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </div>
    {searchOpen && <SearchPalette onOpen={openChat} onClose={() => setSearchOpen(false)} />}
    {sheetOpen && <ShortcutsSheet onClose={() => setSheetOpen(false)} />}
    </div>
  );
}
