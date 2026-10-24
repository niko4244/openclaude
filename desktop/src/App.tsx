import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { BookOpen, ChevronDown, Code2, Coffee, Download, Lightbulb, PenLine, Pin, PinOff, Pencil, Trash2 } from "lucide-react";
import { api, textOf, type Attachment, type Conversation, type GatewayStatus, type Message, type ModelEntry, type Project, type Prompt, type RecordStatus } from "./api";
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
import { RecordSkillDialog } from "./components/RecordSkillDialog";
import { TasksPage } from "./components/TasksPage";
import { EvolutionPage } from "./components/Evolution";
import { FillPrompt, PromptLibrary, placeholders } from "./components/PromptLibrary";
import { WindowControls } from "./components/TitleBar";
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
  // The page shown under the Settings dialog.
  const [underPage, setUnderPage] = useState<Page>("chat");
  const [codeSeed, setCodeSeed] = useState<{ key: string; cwd: string; prompt: string } | null>(null);
  const [readyUpdate, setReadyUpdate] = useState<Update | null>(null);
  const view: Page = page === "settings" ? underPage : page;
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
  const [library, setLibrary] = useState(false);
  const [filling, setFilling] = useState<Prompt | null>(null);
  const [insertReq, setInsertReq] = useState<{ key: string; text: string } | null>(null);
  const [measured, setMeasured] = useState<Record<string, Record<string, boolean>>>({});
  // A finished screen recording waiting to become a skill.
  const [recorded, setRecorded] = useState<{ key: number; status: RecordStatus } | null>(null);
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
    if (p !== "settings") setUnderPage(p);
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
  // Self-maintenance: report uncaught UI errors to the local diagnostics log.
  useEffect(() => {
    const onErr = (e: ErrorEvent) => void api.reportError(String(e.message || e.error), String(e.error?.stack || `${e.filename}:${e.lineno}`)).catch(() => {});
    const onRej = (e: PromiseRejectionEvent) => void api.reportError(String(e.reason?.message || e.reason), String(e.reason?.stack || "")).catch(() => {});
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => { window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onRej); };
  }, []);
  // Keep itself current: check shortly after start and every 4 hours, download in the background, offer a restart.
  useEffect(() => {
    let stop = false;
    const run = async () => {
      if ((await api.getSetting("auto_update").catch(() => null)) === "false") return;
      try {
        const u = await checkUpdate();
        if (u && !stop) { await u.download(); if (!stop) setReadyUpdate(u); }
      } catch { /* offline or no release: try again later */ }
    };
    const first = setTimeout(run, 20000);
    const every = setInterval(run, 4 * 3600 * 1000);
    return () => { stop = true; clearTimeout(first); clearInterval(every); };
  }, []);
  const menuRef = useRef<(id: string) => void>(() => {});
  const quickRef = useRef<(p: { text: string; model: string | null }) => void>(() => {});
  useEffect(() => {
    const u1 = listen<string>("menu", (e) => menuRef.current(e.payload));
    const u2 = listen<{ text: string; model: string | null }>("quick-submit", (e) => quickRef.current(e.payload));
    // openclaude://new?prompt=… prefills a new chat; the user still presses Send.
    const u3 = listen<string>("deep-link-new", (e) => menuRef.current(`deep:${e.payload}`));
    const u4 = listen<string>("open-chat", (e) => menuRef.current(`open:${e.payload}`));
    const u5 = listen("sync-changed", () => menuRef.current("sync-changed"));
    const u6 = listen<RecordStatus>("record-finished", (e) => setRecorded({ key: Date.now(), status: e.payload }));
    const u7 = listen<string>("record-cancelled", (e) => toast(e.payload));
    return () => {
      void u6.then((f) => f());
      void u7.then((f) => f());
      void u5.then((f) => f());
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
      else if (e.key === "Escape" && page === "settings") go(underPage);
      else if (e.key === "Escape" && activeId && chat.busy) { e.preventDefault(); void chat.stop(activeId); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, activeId, chat, page, underPage, findOpen, sheetOpen, titleMenu, go]);

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
    if (id === "sync-changed") return void refreshConvs();
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

  // Prompt library: a prompt with placeholders asks for their values, then lands in the composer.
  const insertText = (text: string) => setInsertReq({ key: `${Date.now()}`, text });
  const applyPrompt = (p: Prompt) => {
    setLibrary(false);
    if (placeholders(p.body).length) setFilling(p);
    else insertText(p.body);
  };
  const pickPrompt = async (name: string) => {
    const p = (await api.promptsList().catch(() => [])).find((x) => x.name === name);
    if (p) applyPrompt(p);
    else toast(`No prompt /${name}`);
  };
  const composerLibrary = { onOpenLibrary: () => setLibrary(true), onPickPrompt: (n: string) => void pickPrompt(n), insert: insertReq };

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
  const tools = <ToolsMenu onManage={() => go("settings", "connectors")} onError={toast} />;
  const project = projects.find((p) => p.id === activeProject);
  const initials = initialsOf(userName);
  const retryModels = [...new Set([...favorites, ...(model ? [model] : []), ...models.filter((m) => m.local).map((m) => m.id)])].slice(0, 12);
  const gatewayDown = status && !(status.reachable && status.authenticated);

  return (
    <div className="shell">
    <WindowControls />
    {/* While a dialog is open the page behind it is inert (not focusable, hidden from assistive tech). */}
    <div className="app" inert={searchOpen || sheetOpen || library || !!filling || page === "settings" || !!recorded || undefined} aria-hidden={searchOpen || sheetOpen || library || !!filling || page === "settings" || !!recorded || undefined}>
      <Sidebar
        collapsed={collapsed}
        conversations={convs}
        projects={projects}
        activeId={activeId}
        activeProject={activeProject}
        page={view}
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
        onMenu={(id) => menuRef.current(id)}
        onSearch={() => setSearchOpen(true)}
      />
      <main className="main">
        {view === "chat" && activeId && <h1 className="sr-only">{active?.title || "Chat"}</h1>}
        {view === "code" && <h1 className="sr-only">Code workspace</h1>}
        {!(view === "chat" && activeId) && view !== "code" && <div className="main-top" data-tauri-drag-region="deep" />}
        {view === "chat" && activeId && (
          <div className="topbar chat-top" data-tauri-drag-region="deep">
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
        {view === "code" ? (
          <CodeView models={modelsView} favorites={favorites} onToggleFavorite={toggleFavorite} defaultModel={model} seed={codeSeed} />
        ) : view === "evolution" ? (
          <EvolutionPage toast={toast} />
        ) : view === "tasks" ? (
          <TasksPage models={models} defaultModel={model} onOpenChat={(id) => { void refreshConvs(); openChat(id); }} toast={toast} />
        ) : view === "chats" ? (
          <ChatsPage onOpen={openChat} onNew={newChat} />
        ) : view === "projects" ? (
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
                {...composerLibrary}
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
                  {...composerLibrary}
                />
                <div className="hint">OpenClaude can make mistakes. Replies come from {model || "your selected model"} through your gateway.</div>
              </div>
            </div>
          </>
        )}
      </main>

      {artifact && view === "chat" && (
        <ArtifactPanel
          artifact={versionsOf(artifact.title).find((v) => v.code === artifact.code) ?? artifact}
          versions={versionsOf(artifact.title)}
          onSelect={setArtifact}
          onClose={() => setArtifact(null)}
          onAsk={(t) => void send(t, [])}
        />
      )}
      {readyUpdate && (
        <div className="update-banner" role="status">
          OpenClaude {readyUpdate.version} is ready.
          <button className="btn primary" onClick={async () => { await readyUpdate.install(); await relaunch(); }}>Restart to update</button>
          <button className="icon-btn" aria-label="Later" onClick={() => setReadyUpdate(null)}>✕</button>
        </div>
      )}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </div>
    {page === "settings" && (
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
        onClose={() => go(underPage)}
        onFixInCode={(cwd, prompt) => { setCodeSeed({ key: `${Date.now()}`, cwd, prompt }); go("code"); }}
        toast={toast}
      />
    )}
    {searchOpen && <SearchPalette onOpen={openChat} onClose={() => setSearchOpen(false)} />}
    {sheetOpen && <ShortcutsSheet onClose={() => setSheetOpen(false)} />}
    {recorded && <RecordSkillDialog key={recorded.key} status={recorded.status} models={models} defaultModel={model} onClose={() => setRecorded(null)} toast={toast} />}
    {library && (
      <PromptLibrary
        onInsert={applyPrompt}
        onClose={() => { setLibrary(false); insertText(""); }}
        onManage={() => { setLibrary(false); go("settings", "prompts"); }}
        toast={toast}
      />
    )}
    {filling && <FillPrompt prompt={filling} onDone={(t) => { setFilling(null); insertText(t); }} onCancel={() => { setFilling(null); insertText(""); }} />}
    </div>
  );
}
