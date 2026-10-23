import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { api, type Attachment, type Conversation, type GatewayStatus, type Message, type ModelEntry, type Project } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { Composer, buildContent } from "./components/Composer";
import { ModelPicker } from "./components/ModelPicker";
import { Settings } from "./components/Settings";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { CodeView } from "./components/CodeView";
import type { Artifact } from "./components/Markdown";
import { useChat } from "./useChat";

const SUGGESTIONS = ["Explain a concept simply", "Review this code for bugs", "Draft an email", "Plan a project in steps"];

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Burning the midnight oil?" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function App() {
  const [view, setView] = useState<"chat" | "settings" | "code">("chat");
  const [settingsTab, setSettingsTab] = useState<string | undefined>();
  const [collapsed, setCollapsed] = useState(false);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [theme, setTheme] = useState("system");
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<number | undefined>(undefined);

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const refreshConvs = useCallback(async () => setConvs(await api.listConversations(query, activeProject)), [query, activeProject]);
  const chat = useChat(activeId, refreshConvs);
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

  const checkGateway = useCallback(async () => setStatus(await api.gatewayStatus()), []);

  // ---- boot
  useEffect(() => {
    void (async () => {
      const t = (await api.getSetting("theme")) || "system";
      setTheme(t);
      setFavorites(JSON.parse((await api.getSetting("favorite_models")) || "[]"));
      setProjects(await api.listProjects());
      await checkGateway();
      const ms = await loadModels();
      const saved = await api.getSetting("default_model");
      const pick = (saved && ms.find((m) => m.id === saved)?.id) || ms.find((m) => m.local && m.supports_tools)?.id || ms.find((m) => m.local)?.id || ms[0]?.id || null;
      setModel(pick);
    })();
    const t = setInterval(checkGateway, 30_000);
    return () => clearInterval(t);
  }, [checkGateway, loadModels]);

  useEffect(() => { void refreshConvs(); }, [refreshConvs]);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  // conversation's own model wins when opening it
  useEffect(() => {
    if (active?.model && models.some((m) => m.id === active.model)) setModel(active.model);
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const newChat = useCallback(() => {
    setActiveId(null);
    setView("chat");
    setArtifact(null);
    if (activeProject) {
      const p = projects.find((x) => x.id === activeProject);
      if (p?.default_model) setModel(p.default_model);
    }
  }, [activeProject, projects]);

  // ---- global quick-entry shortcut
  useEffect(() => {
    const apply = async () => {
      try {
        await unregisterAll();
        const s = (await api.getSetting("quick_entry_shortcut")) ?? "CommandOrControl+Alt+Space";
        if (!s) return;
        await register(s, async (e) => {
          if (e.state !== "Pressed") return;
          const w = getCurrentWindow();
          await w.unminimize();
          await w.show();
          await w.setFocus();
          window.dispatchEvent(new Event("oc-new-chat"));
        });
      } catch (err) {
        console.warn("shortcut registration failed", err);
      }
    };
    void apply();
    window.addEventListener("oc-shortcut-changed", apply);
    return () => window.removeEventListener("oc-shortcut-changed", apply);
  }, []);
  useEffect(() => {
    const h = () => newChat();
    window.addEventListener("oc-new-chat", h);
    return () => window.removeEventListener("oc-new-chat", h);
  }, [newChat]);

  useEffect(() => {
    const un = listen("mcp-changed", () => void 0);
    return () => void un.then((f) => f());
  }, []);

  // ---- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newChat(); }
      else if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setCollapsed(false); setTimeout(() => searchRef.current?.focus(), 0); }
      else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); setCollapsed((c) => !c); }
      else if (mod && e.key === ",") { e.preventDefault(); setView("settings"); }
      else if (e.key === "Escape" && activeId && chat.busy) { e.preventDefault(); void chat.stop(activeId); }
      else if (e.key === "Escape" && view === "settings") setView("chat");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, activeId, chat, view]);

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

  const send = async (text: string, atts: Attachment[]) => {
    if (!model) return toast("Pick a model first");
    const vision = models.find((m) => m.id === model)?.supports_vision;
    if (atts.some((a) => a.kind === "image") && vision === false) toast(`${model} does not declare vision support; the request may fail.`);
    let cid = activeId;
    if (!cid) {
      const c = await api.createConversation(activeProject, model);
      cid = c.id;
      setActiveId(cid);
      setConvs((cs) => [c, ...cs]);
    }
    void chat.send(cid, buildContent(text, atts), model);
    setTimeout(refreshConvs, 400);
  };

  const saveDraft = (t: string) => {
    if (!active) return;
    clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => void api.updateConversation({ ...active, draft: t }), 500);
  };

  const picker = (
    <ModelPicker models={models} value={model} onChange={chooseModel} favorites={favorites} onToggleFavorite={toggleFavorite} />
  );
  const projectName = projects.find((p) => p.id === activeProject)?.name;

  return (
    <div className="app">
      <Sidebar
        collapsed={collapsed}
        conversations={convs}
        projects={projects}
        activeId={activeId}
        activeProject={activeProject}
        view={view}
        status={status}
        query={query}
        onQuery={setQuery}
        onNew={newChat}
        onOpen={(id) => { setActiveId(id); setView("chat"); setArtifact(null); }}
        onRename={async (c, title) => { await api.updateConversation({ ...c, title }); void refreshConvs(); }}
        onDelete={async (c) => {
          if (!confirm(`Delete “${c.title}”? This cannot be undone.`)) return;
          await api.deleteConversation(c.id);
          if (c.id === activeId) setActiveId(null);
          void refreshConvs();
        }}
        onTogglePin={async (c) => { await api.updateConversation({ ...c, pinned: !c.pinned }); void refreshConvs(); }}
        onSelectProject={(id) => { setActiveProject(id); setActiveId(null); setView("chat"); }}
        onSettings={(tab) => { setSettingsTab(tab); setView("settings"); }}
        onCode={() => { setView("code"); setArtifact(null); }}
        onToggle={() => setCollapsed((c) => !c)}
        searchRef={searchRef}
      />
      <main className="main">
        <div className="topbar">
          {collapsed && <button className="icon-btn" onClick={() => setCollapsed(false)} aria-label="Open sidebar" title="Open sidebar (Ctrl+B)">☰</button>}
          {view === "settings" ? (
            <>
              <span className="title">Settings</span>
              <span className="spacer" />
              <button className="btn" onClick={() => setView("chat")}>Done</button>
            </>
          ) : view === "code" ? (
            <span className="title">Code</span>
          ) : (
            <>
              <span className="title">{active?.title || (projectName ? `📁 ${projectName}` : "")}</span>
              <span className="spacer" />
              {status && !(status.reachable && status.authenticated) && (
                <button className="btn danger" onClick={() => { setSettingsTab("gateway"); setView("settings"); }}>Gateway: {status.reachable ? "auth failed" : "offline"}</button>
              )}
            </>
          )}
        </div>
        {view === "settings" ? (
          <Settings
            initialTab={settingsTab}
            models={models}
            onModelsChanged={async () => { await loadModels(true); }}
            onGatewayChanged={async () => { await checkGateway(); const ms = await loadModels(true); if (!model && ms[0]) setModel(ms[0].id); }}
            theme={theme}
            onTheme={async (t) => { setTheme(t); await api.setSetting("theme", t); }}
            projects={projects}
            onProjectsChanged={async () => setProjects(await api.listProjects())}
            toast={toast}
          />
        ) : view === "code" ? (
          <CodeView models={models} favorites={favorites} onToggleFavorite={toggleFavorite} defaultModel={model} />
        ) : !activeId ? (
          <div className="home">
            <h1>{projectName ? projectName : greeting()}</h1>
            <div className="composer-wrap">
              <Composer onSend={send} busy={false} modelSlot={picker} autoFocus focusKey={`home-${activeProject}`} onError={toast} />
              <div className="suggestions">
                {SUGGESTIONS.map((s) => <button key={s} className="btn" onClick={() => void send(s, [])}>{s}</button>)}
              </div>
              {!models.length && status && (
                <p className="hint">No models loaded. <a href="#" onClick={(e) => { e.preventDefault(); setSettingsTab("gateway"); setView("settings"); }}>Configure your gateway</a>.</p>
              )}
            </div>
          </div>
        ) : (
          <>
            <ChatView
              messages={chat.messages}
              live={chat.live}
              onRegenerate={(from) => model && void chat.send(activeId, null, model, from)}
              onEdit={(m: Message, text) => model && void chat.send(activeId, text, model, m.id)}
              onDecide={(a, allow, remember) => void chat.decide(activeId, a, allow, remember)}
              onOpenArtifact={setArtifact}
              onDismissError={() => chat.clearError(activeId)}
            />
            <div className="composer-dock">
              <div className="composer-wrap">
                <Composer
                  onSend={send}
                  onStop={() => void chat.stop(activeId)}
                  busy={chat.busy}
                  modelSlot={picker}
                  initialDraft={active?.draft || ""}
                  onDraftChange={saveDraft}
                  placeholder="Reply…"
                  autoFocus
                  focusKey={activeId}
                  onError={toast}
                />
                <div className="hint">Responses come from {model || "your selected model"} via your gateway and can be wrong.</div>
              </div>
            </div>
          </>
        )}
      </main>
      {artifact && view === "chat" && <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </div>
  );
}
