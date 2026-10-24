import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { api, type RegistryEntry, type ExtensionPreview, type ProbeReport, type GatewayStatus, type ImportCandidate, type ModelEntry, type PluginCandidate, type PluginOffer, type PluginView, type SyncStatus, type DeviceInventory, type ProviderPreset, type ProviderView, type Project, type ServerConfig, type ServerStatus } from "../api";
import { fmtTokens } from "./ModelPicker";
import { copyText } from "./Markdown";
import { Blocks, Cloud, Cpu, Folder, Info, Monitor, Moon, Network, Package, Plug, Search, Settings2, Sun, X, type LucideIcon } from "lucide-react";

type Tab = "general" | "gateway" | "providers" | "models" | "connectors" | "plugins" | "extensions" | "projects" | "about";
const GROUPS: [string, [Tab, string, LucideIcon][]][] = [
  ["Settings", [["general", "General", Settings2], ["gateway", "Gateway", Network], ["providers", "Providers", Cloud], ["models", "Models", Cpu], ["projects", "Projects", Folder], ["about", "About", Info]]],
  ["Customize", [["connectors", "Connectors (MCP)", Blocks], ["plugins", "Plugins", Plug], ["extensions", "Extensions", Package]]],
];

function Unk({ v }: { v: string | number | boolean | null | undefined }) {
  if (v == null) return <td className="unk">unknown</td>;
  if (typeof v === "boolean") return <td>{v ? "yes" : "no"}</td>;
  return <td>{v}</td>;
}

export function Settings({
  initialTab,
  models,
  onModelsChanged,
  onGatewayChanged,
  theme,
  onTheme,
  projects,
  onProjectsChanged,
  toast,
  onProfileChanged,
  onClose,
}: {
  onProfileChanged: () => void;
  onClose: () => void;
  initialTab?: string;
  models: ModelEntry[];
  onModelsChanged: () => Promise<void>;
  onGatewayChanged: () => void;
  theme: string;
  onTheme: (t: string) => void;
  projects: Project[];
  onProjectsChanged: () => void;
  toast: (m: string) => void;
}) {
  const [tab, setTab] = useState<Tab>((initialTab as Tab) || "general");
  const [filter, setFilter] = useState("");
  useEffect(() => { if (initialTab) setTab(initialTab as Tab); }, [initialTab]);
  const q = filter.trim().toLowerCase();
  return (
    <div className="settings-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="settings-nav">
          <h1 id="settings-title" className="sr-only">Settings</h1>
          <label className="settings-search"><Search size={15} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search" aria-label="Search settings" /></label>
          <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
            {GROUPS.map(([group, items]) => {
              const shown = items.filter(([, l]) => !q || l.toLowerCase().includes(q));
              return shown.length > 0 && (
                <div key={group} role="none">
                  <div className="settings-group" aria-hidden="true">{group}</div>
                  {shown.map(([t, l, Icon]) => (
                    <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}><Icon size={16} strokeWidth={1.75} />{l}</button>
                  ))}
                </div>
              );
            })}
          </div>
        </nav>
        <button className="icon-btn settings-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)"><X size={18} /></button>
        <div className="settings-body">
        {tab === "general" && <General theme={theme} onTheme={onTheme} toast={toast} onProfileChanged={onProfileChanged} />}
        {tab === "gateway" && <Gateway onChanged={onGatewayChanged} toast={toast} />}
        {tab === "providers" && <ProvidersTab toast={toast} onModelsChanged={onModelsChanged} />}
        {tab === "models" && <Models models={models} onRefresh={onModelsChanged} />}
        {tab === "connectors" && <Connectors toast={toast} />}
        {tab === "plugins" && <PluginsTab toast={toast} />}
        {tab === "extensions" && <Extensions toast={toast} />}
        {tab === "projects" && <Projects projects={projects} models={models} onChanged={onProjectsChanged} toast={toast} />}
        {tab === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

function General({ theme, onTheme, toast, onProfileChanged }: { theme: string; onTheme: (t: string) => void; toast: (m: string) => void; onProfileChanged: () => void }) {
  const [name, setName] = useState("");
  useEffect(() => { void api.getSetting("user_name").then((v) => setName(v || "")); }, []);
  const [sys, setSys] = useState("");
  const [tools, setTools] = useState(true);
  const [hotkey, setHotkey] = useState("");
  const [tray, setTray] = useState(true);
  const [login, setLogin] = useState(false);
  useEffect(() => {
    void api.getSetting("system_prompt").then((v) => setSys(v || ""));
    void api.getSetting("tools_enabled").then((v) => setTools(v !== "false"));
    void api.getSetting("close_to_tray").then((v) => setTray(v !== "false"));
    void autostartEnabled().then(setLogin).catch(() => setLogin(false));
    void api.getSetting("quick_entry_shortcut").then((v) => setHotkey(v ?? "CommandOrControl+Alt+Space"));
  }, []);
  return (
    <>
      <div className="field">
        <label htmlFor="uname">What should OpenClaude call you?</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="uname" style={{ flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
          <button className="btn" onClick={async () => { await api.setSetting("user_name", name.trim()); onProfileChanged(); toast("Name saved"); }}>Save</button>
        </div>
      </div>
      <div className="field">
        <div className="setting-row">
          <span className="label" id="theme-label">Theme</span>
          <div className="segmented" role="radiogroup" aria-labelledby="theme-label">
            {([["system", "Match system", Monitor], ["light", "Light", Sun], ["dark", "Dark", Moon]] as const).map(([v, l, Icon]) => (
              <button key={v} role="radio" aria-checked={theme === v} aria-label={l} title={l} className={theme === v ? "on" : ""} onClick={() => onTheme(v)}><Icon size={16} strokeWidth={1.75} /></button>
            ))}
          </div>
        </div>
      </div>
      <div className="field">
        <label htmlFor="sys">Custom instructions (all chats)</label>
        <textarea id="sys" value={sys} onChange={(e) => setSys(e.target.value)} placeholder="e.g. Be concise. Prefer TypeScript." />
        <div><button className="btn" onClick={async () => { await api.setSetting("system_prompt", sys); toast("Instructions saved"); }}>Save instructions</button></div>
      </div>
      <div className="field">
        <label><input type="checkbox" checked={tools} onChange={async (e) => { setTools(e.target.checked); await api.setSetting("tools_enabled", String(e.target.checked)); }} /> Offer connector (MCP) tools to models</label>
        <span className="help">Models whose metadata says they cannot call tools never receive them. Every tool call needs your approval unless you chose “Always allow”.</span>
      </div>
      <div className="field">
        <label><input type="checkbox" checked={tray} onChange={async (e) => { setTray(e.target.checked); await api.setSetting("close_to_tray", String(e.target.checked)); }} /> Keep running in the system tray when the window is closed</label>
        <span className="help">Keeps connectors and background agents alive. Quit from the tray icon or the app menu.</span>
      </div>
      <div className="field">
        <label><input type="checkbox" checked={login} onChange={async (e) => {
          try { if (e.target.checked) await enableAutostart(); else await disableAutostart(); setLogin(await autostartEnabled()); }
          catch (err) { toast(`Could not change run-on-login: ${err}`); }
        }} /> Start OpenClaude when you sign in to Windows</label>
        <span className="help">Starts minimized to the tray so scheduled tasks can run.</span>
      </div>
      <SttField toast={toast} />
      <SyncField toast={toast} />
      <DevicesField toast={toast} />
      <ComputerUseField />
      <BrowserToolsField />
      <ChromeExtensionField />
      <div className="field">
        <label htmlFor="hk">Quick entry shortcut</label>
        <input id="hk" value={hotkey} onChange={(e) => setHotkey(e.target.value)} placeholder="CommandOrControl+Alt+Space" />
        <span className="help">Global shortcut that opens the floating Quick Entry box; Enter starts a new chat in the main window. Leave empty to disable. Applies on save.</span>
        <div><button className="btn" onClick={async () => { await api.setSetting("quick_entry_shortcut", hotkey.trim()); window.dispatchEvent(new Event("oc-shortcut-changed")); toast("Shortcut saved"); }}>Save shortcut</button></div>
      </div>
    </>
  );
}

function Gateway({ onChanged, toast }: { onChanged: () => void; toast: (m: string) => void }) {
  const [url, setUrl] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    const s = await api.getGatewaySettings();
    setUrl(s.base_url);
    setHasKey(s.has_key);
    setStatus(await api.gatewayStatus());
  };
  useEffect(() => { void load(); }, []);
  return (
    <>
      <p className="muted">OpenClaude sends every model request through your LiteLLM gateway. No Anthropic account is required.</p>
      <div className="field">
        <label htmlFor="gw">Gateway URL</label>
        <input id="gw" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:4000" />
      </div>
      <div className="field">
        <label htmlFor="key">API key {hasKey && <span className="badge local">stored</span>}</label>
        <input id="key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? "•••••••• (leave blank to keep)" : "sk-…"} autoComplete="off" />
        <span className="help">Stored in Windows Credential Manager, never in the app database or logs. Environment variables OPENCLAUDE_LITELLM_KEY / LITELLM_API_KEY are used when no key is stored.</span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" onClick={async () => {
          setErr(null);
          try {
            await api.setGatewaySettings(url.trim(), key ? key : null);
            setKey("");
            await load();
            onChanged();
            toast("Gateway settings saved");
          } catch (e) { setErr(String(e)); }
        }}>Save & test</button>
        {hasKey && <button className="btn danger" onClick={async () => { await api.setGatewaySettings(url.trim(), ""); await load(); onChanged(); }}>Remove stored key</button>}
      </div>
      {err && <div className="error-box" style={{ marginTop: 10 }}>{err}</div>}
      {status && (
        <div className="card">
          <div className="card-head">
            <span className={`dot ${status.reachable && status.authenticated ? "ok" : status.reachable ? "warn" : "err"}`} />
            <span className="name">{status.base_url}</span>
          </div>
          <div className="muted">
            reachable: {String(status.reachable)} · authenticated: {String(status.authenticated)}
            {status.latency_ms != null && ` · ${status.latency_ms} ms`}
          </div>
          {status.error && <div className="muted" style={{ color: "var(--err)" }}>{status.error}</div>}
        </div>
      )}
    </>
  );
}

function Models({ models, onRefresh }: { models: ModelEntry[]; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeReport>>({});
  const [probing, setProbing] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { void api.getProbes().then((ps) => setProbes(Object.fromEntries(ps.map((p) => [p.model, p])))); }, []);
  const local = models.filter((m) => m.local).length;
  const shown = models.filter((m) => !q || m.id.toLowerCase().includes(q.toLowerCase()));
  const measured = (m: string, check: string) => {
    const c = probes[m]?.checks.find((x) => x.name === check);
    return c ? <span title={`${c.detail} (${c.ms} ms)`} style={{ color: c.ok ? "var(--ok)" : "var(--err)" }}>{c.ok ? "✓" : "✗"}</span> : <span className="muted">·</span>;
  };
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="muted">{models.length} models from the gateway · {local} local · {models.length - local} cloud. “unknown” = not declared by the gateway. ✓/✗ = measured by the probe (live requests).</span>
        <span className="spacer" />
        <input className="search" style={{ width: 200, margin: 0 }} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await onRefresh(); } finally { setBusy(false); } }}>{busy ? "Refreshing…" : "Refresh catalog"}</button>
      </div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table className="models">
          <thead>
            <tr><th>Alias</th><th>Where</th><th>Backend</th><th>Context</th><th>Tools (decl.)</th><th>Vision (decl.)</th><th title="Measured: chat · stream · system · tools · json · vision">Measured c/s/sys/t/j/v</th><th><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id}>
                <td className="mono">{m.id}</td>
                <td>{m.local ? "local" : "cloud"}</td>
                <Unk v={m.backend_model} />
                <Unk v={fmtTokens(m.max_input_tokens)} />
                <Unk v={m.supports_tools} />
                <Unk v={m.supports_vision} />
                <td style={{ letterSpacing: 3 }}>{["chat", "streaming", "system", "tools", "json", "vision"].map((c) => <span key={c}>{measured(m.id, c)}</span>)}</td>
                <td>
                  <button className="btn" disabled={!!probing} onClick={async () => {
                    setProbing(m.id);
                    try { const r = await api.probeModel(m.id); setProbes((p) => ({ ...p, [m.id]: r })); } finally { setProbing(null); }
                  }}>{probing === m.id ? "Probing…" : probes[m.id] ? "Re-probe" : "Probe"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Connectors({ toast }: { toast: (m: string) => void }) {
  const [servers, setServers] = useState<ServerStatus[]>([]);
  const [cands, setCands] = useState<ImportCandidate[]>([]);
  const [form, setForm] = useState({ name: "", command: "", args: "", url: "", env: "" });
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const refresh = async () => setServers(await api.mcpStatus());
  useEffect(() => {
    void refresh();
    void api.mcpImportCandidates().then(setCands);
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, []);
  const existing = new Set(servers.map((s) => s.name));

  const add = async () => {
    setErr(null);
    const env: Record<string, string> = {};
    for (const line of form.env.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const cfg: ServerConfig = form.url.trim()
      ? { type: /\/sse\/?$/.test(form.url.trim()) ? "sse" : "http", url: form.url.trim() }
      : { command: form.command.trim(), args: form.args.trim() ? form.args.match(/(?:[^\s"]+|"[^"]*")+/g)!.map((a) => a.replace(/^"|"$/g, "")) : [], env };
    if (!cfg.url && !cfg.command) return setErr("Enter a command (stdio) or a URL (HTTP).");
    try {
      await api.mcpSaveServer(form.name, cfg);
      setForm({ name: "", command: "", args: "", url: "", env: "" });
      toast(`Added ${form.name}`);
      await refresh();
    } catch (e) { setErr(String(e)); }
  };

  return (
    <>
      <p className="muted">Connectors are MCP servers. OpenClaude starts stdio servers locally and connects to Streamable HTTP servers. Their output is treated as untrusted.</p>
      {servers.map((s) => (
        <div className="card" key={s.name}>
          <div className="card-head">
            <span className={`dot ${s.state === "connected" ? "ok" : s.state === "connecting" || s.state === "auth_required" ? "warn" : s.state === "error" ? "err" : ""}`} />
            <span className="name">{s.name}</span>
            <span className="badge">{s.transport}</span>
            <span className="muted">{s.state}{s.server_info?.name ? ` · ${s.server_info.name} ${s.server_info.version ?? ""}` : ""}</span>
            <span className="spacer" />
            <button className="btn" onClick={() => setOpen(open === s.name ? null : s.name)}>{open === s.name ? "Hide" : "Details"}</button>
            {s.state === "auth_required" && (
              <button className="btn primary" disabled={signing === s.name} onClick={async () => {
                setSigning(s.name);
                try { await api.mcpAuthorize(s.name); toast(`Signed in to ${s.name}`); } catch (err) { toast(String(err)); } finally { setSigning(null); await refresh(); }
              }}>{signing === s.name ? "Waiting for browser sign-in…" : "Sign in"}</button>
            )}
            {(s.transport === "http" || s.transport === "sse") && s.state === "connected" && (
              <button className="btn" onClick={async () => { await api.mcpSignOut(s.name); await refresh(); }}>Sign out</button>
            )}
            <button className="btn" onClick={async () => { await api.mcpRestart(s.name); await refresh(); }}>Restart</button>
            <button className="btn danger" onClick={async () => { await api.mcpRemoveServer(s.name); await refresh(); }}>Remove</button>
          </div>
          {s.error && <div className="muted" style={{ color: "var(--err)", marginTop: 6 }}>{s.error}</div>}
          <div className="muted" style={{ marginTop: 4 }}>{s.tools.length} tools · {s.resources} resources · {s.prompts} prompts</div>
          {open === s.name && (
            <>
              <div style={{ marginTop: 8 }}>{s.tools.map((t) => <ToolPolicy key={t.name} server={s.name} tool={t.name} description={t.description} />)}</div>
              {s.log_tail.length > 0 && <div className="log" style={{ marginTop: 8 }}>{s.log_tail.join("\n")}</div>}
            </>
          )}
        </div>
      ))}
      {!servers.length && <div className="muted">No connectors yet.</div>}

      {cands.length > 0 && (
        <>
          <h2 className="section-h">Import from other apps</h2>
          <p className="muted">Read-only scan of existing registries. Importing copies the entry into OpenClaude’s own config; the source file is never modified.</p>
          {cands.map((c) => (
            <div className="card" key={c.path}>
              <div className="card-head"><span className="name">{c.source}</span><span className="muted mono">{c.path}</span></div>
              <div className="tool-list">
                {Object.entries(c.servers).map(([name, cfg]) => (
                  <button key={name} className="btn" disabled={existing.has(name)} title={cfg.command ? `${cfg.command} ${(cfg.args || []).join(" ")}` : cfg.url}
                    onClick={async () => { const n = await api.mcpImport(c.path, [name]); toast(`Imported ${n} connector`); setTimeout(refresh, 300); }}>
                    {existing.has(name) ? `✓ ${name}` : `+ ${name}`}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      <Directory existing={existing} toast={toast} onAdded={refresh} />
      <h2 className="section-h">Add a connector</h2>
      <div className="field"><label>Name</label><input aria-label="Connector name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="filesystem" /></div>
      <div className="field"><label>Command (stdio)</label><input aria-label="Command" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" /></div>
      <div className="field"><label>Arguments</label><input aria-label="Arguments" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder='-y @modelcontextprotocol/server-filesystem "C:\Users\me\Documents"' /></div>
      <div className="field"><label>Environment (KEY=value per line)</label><textarea aria-label="Environment variables" value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} style={{ minHeight: 50 }} /></div>
      <div className="field"><label>…or URL (Streamable HTTP or SSE)</label><input aria-label="Server URL" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" /></div>
      <button className="btn primary" disabled={!form.name.trim()} onClick={add}>Add connector</button>
      {err && <div className="error-box" style={{ marginTop: 10 }}>{err}</div>}
    </>
  );
}

function ToolPolicy({ server, tool, description }: { server: string; tool: string; description: string | null }) {
  // Must match mcp::qualified_name in the backend.
  const clean = (x: string) => x.replace(/[^A-Za-z0-9_-]/g, "_");
  const key = `tool_policy:${`mcp__${clean(server)}__${clean(tool)}`.slice(0, 64)}`;
  const [v, setV] = useState("ask");
  useEffect(() => { void api.getSetting(key).then((x) => setV(x || "ask")); }, [key]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
      <span className="mono" style={{ flex: 1 }} title={description || ""}>{tool}</span>
      <select value={v} aria-label={`Policy for ${tool}`} onChange={async (e) => { setV(e.target.value); await api.setSetting(key, e.target.value); }}>
        <option value="ask">Ask every time</option>
        <option value="allow">Always allow</option>
        <option value="block">Block</option>
      </select>
    </div>
  );
}

function Projects({ projects, models, onChanged, toast }: { projects: Project[]; models: ModelEntry[]; onChanged: () => void; toast: (m: string) => void }) {
  const blank: Project = { id: "", name: "", instructions: "", default_model: null, updated_at: 0 };
  const [edit, setEdit] = useState<Project>(blank);
  return (
    <>
      <p className="muted">Projects group chats and give them shared instructions and a default model.</p>
      {projects.map((p) => (
        <div className="card" key={p.id}>
          <div className="card-head">
            <span className="name">📁 {p.name}</span>
            <span className="muted">{p.default_model || "no default model"}</span>
            <span className="spacer" />
            <button className="btn" onClick={() => setEdit(p)}>Edit</button>
            <button className="btn danger" onClick={async () => { await api.deleteProject(p.id); onChanged(); }}>Delete</button>
          </div>
          {p.instructions && <div className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{p.instructions.slice(0, 300)}</div>}
        </div>
      ))}
      <h2 className="section-h">{edit.id ? `Edit “${edit.name}”` : "New project"}</h2>
      <div className="field"><label>Name</label><input aria-label="Project name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
      <div className="field"><label>Instructions</label><textarea aria-label="Project instructions" value={edit.instructions} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} placeholder="Context and rules every chat in this project should follow." /></div>
      <div className="field">
        <label>Default model</label>
        <select aria-label="Default model" value={edit.default_model || ""} onChange={(e) => setEdit({ ...edit, default_model: e.target.value || null })}>
          <option value="">(use global default)</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" disabled={!edit.name.trim()} onClick={async () => { await api.saveProject(edit); setEdit(blank); onChanged(); toast("Project saved"); }}>Save project</button>
        {edit.id && <button className="btn" onClick={() => setEdit(blank)}>Cancel</button>}
      </div>
    </>
  );
}

function About() {
  const [info, setInfo] = useState<{ version: string; data_dir: string; mcp_config: string } | null>(null);
  const [upd, setUpd] = useState<string | null>(null);
  const [pending, setPending] = useState<Update | null>(null);
  useEffect(() => { void api.appInfo().then(setInfo); }, []);
  return (
    <div className="card">
      <div className="card-head"><span className="name">OpenClaude Desktop {info?.version}</span></div>
      <div className="muted">An independent desktop client for your own LiteLLM gateway, local models and MCP connectors. Not affiliated with Anthropic.</div>
      <div className="muted mono" style={{ marginTop: 8 }}>data: {info?.data_dir}</div>
      <div className="muted mono">connectors: {info?.mcp_config}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
        <button className="btn" onClick={async () => {
          setUpd("Checking…");
          try {
            const u = await check();
            setPending(u);
            setUpd(u ? `Version ${u.version} is available.` : "You are on the latest version.");
          } catch (e) { setUpd(`Update check failed: ${String(e).slice(0, 160)}`); }
        }}>Check for updates</button>
        {pending && <button className="btn primary" onClick={async () => { setUpd("Downloading and installing…"); await pending.downloadAndInstall(); await relaunch(); }}>Install and restart</button>}
        {upd && <span className="muted">{upd}</span>}
      </div>
      <div className="muted" style={{ marginTop: 6 }}>Updates are signed; the app only installs packages signed with the OpenClaude release key.</div>
    </div>
  );
}

function Extensions({ toast }: { toast: (m: string) => void }) {
  const [pick, setPick] = useState<{ token: string; preview: ExtensionPreview } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <p className="muted">Desktop extensions are packaged MCP servers (<span className="mono">.mcpb</span>, formerly <span className="mono">.dxt</span>). Installing extracts the bundle into OpenClaude’s data folder and adds it as a connector. Sensitive settings are stored in Windows Credential Manager.</p>
      <button className="btn primary" onClick={async () => {
        setErr(null);
        try {
          const p = await api.extensionPick();
          if (p) {
            setPick(p);
            setValues(Object.fromEntries(p.preview.user_config.map((f) => [f.key, f.default == null ? "" : String(f.default)])));
          }
        } catch (e) { setErr(String(e)); }
      }}>Install extension…</button>
      {err && <div className="error-box" style={{ marginTop: 10 }}>{err}</div>}
      {pick && (
        <div className="card">
          <div className="card-head">
            <span className="name">{pick.preview.display_name}</span>
            <span className="badge">v{pick.preview.version}</span>
            <span className="badge">{pick.preview.server_type}</span>
            <span className={`badge ${pick.preview.signature.startsWith("verified") ? "local" : ""}`} style={pick.preview.signature.startsWith("INVALID") ? { color: "var(--err)", borderColor: "var(--err)" } : undefined}>{pick.preview.signature}</span>
          </div>
          <div className="muted" style={{ margin: "6px 0" }}>{pick.preview.description}{pick.preview.author ? ` · by ${pick.preview.author}` : ""}</div>
          {pick.preview.tools.length > 0 && <div className="tool-list">{pick.preview.tools.map((t) => <span key={t} className="badge">{t}</span>)}</div>}
          {pick.preview.user_config.map((f) => (
            <div className="field" key={f.key}>
              <label>{f.title}{f.required ? " *" : ""}</label>
              <input type={f.sensitive ? "password" : "text"} value={values[f.key] ?? ""} autoComplete="off" onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.kind} />
              {f.description && <span className="help">{f.description}</span>}
            </div>
          ))}
          <div className="muted" style={{ margin: "8px 0" }}>This extension will run local code on your computer with your user permissions. Only install extensions you trust.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" disabled={busy} onClick={async () => {
              setBusy(true); setErr(null);
              try { const n = await api.extensionInstall(pick.token, values); toast(`Installed ${n}`); setPick(null); }
              catch (e) { setErr(String(e)); }
              finally { setBusy(false); }
            }}>{busy ? "Installing…" : "Install"}</button>
            <button className="btn" onClick={() => setPick(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

function SttField({ toast }: { toast: (m: string) => void }) {
  const [v, setV] = useState("");
  useEffect(() => { void api.getSetting("stt_model").then((x) => setV(x || "")); }, []);
  return (
    <div className="field">
      <label htmlFor="stt">Dictation model</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input id="stt" style={{ flex: 1 }} value={v} onChange={(e) => setV(e.target.value)} placeholder="empty = local faster-whisper (e.g. whisper-1 on your gateway)" />
        <button className="btn" onClick={async () => { await api.setSetting("stt_model", v.trim()); toast("Dictation model saved"); }}>Save</button>
      </div>
      <span className="help">A speech-to-text model alias on your LiteLLM gateway. Leave empty to transcribe locally with faster-whisper (Python); the first use downloads the Whisper model.</span>
    </div>
  );
}

function ComputerUseField() {
  const [on, setOn] = useState(false);
  useEffect(() => { void api.getSetting("computer_use_enabled").then((v) => setOn(v === "true")); }, []);
  return (
    <div className="field">
      <label><input type="checkbox" checked={on} onChange={async (e) => { setOn(e.target.checked); await api.setSetting("computer_use_enabled", String(e.target.checked)); }} /> Computer use (experimental)</label>
      <span className="help">Lets the model see your primary screen and control the mouse and keyboard. Every action asks for approval (at most “for this chat”, never permanently); background tasks can never use it; locking the screen and Ctrl+Alt+Delete are always blocked. Needs a vision-capable model. Press Esc to stop.</span>
    </div>
  );
}

function BrowserToolsField() {
  const [on, setOn] = useState(false);
  useEffect(() => { void api.getSetting("browser_tools_enabled").then((v) => setOn(v === "true")); }, []);
  return (
    <div className="field">
      <label><input type="checkbox" checked={on} onChange={async (e) => { setOn(e.target.checked); await api.setSetting("browser_tools_enabled", String(e.target.checked)); }} /> Browser tools</label>
      <span className="help">Lets the model browse the web in a separate Edge/Chrome window with its own profile (your normal browser, cookies and logins are never used). Every action asks for approval unless you allow it; page content is treated as untrusted.</span>
    </div>
  );
}

/** Connector directory: the official MCP Registry. Remote servers become HTTP connectors;
 * npm/PyPI packages become local npx/uvx connectors (they run code on this computer). */
function Directory({ existing, toast, onAdded }: { existing: Set<string>; toast: (m: string) => void; onAdded: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<RegistryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [envFor, setEnvFor] = useState<{ entry: RegistryEntry; vals: Record<string, string> } | null>(null);
  const load = async (more = false) => {
    setBusy(true); setErr(null);
    try {
      const p = await api.registrySearch(q || null, more ? cursor : null);
      setRows((r) => (more ? [...r, ...p.entries] : p.entries));
      setCursor(p.next_cursor);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const short = (n: string) => n.split("/").pop()!.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  const add = async (e: RegistryEntry, env: Record<string, string> = {}) => {
    const name = short(e.name);
    const remote = e.remotes[0];
    const pkg = e.packages[0];
    const cfg = remote
      ? { type: remote.kind === "sse" ? "sse" : "http", url: remote.url }
      : pkg.registry === "npm"
        ? { command: "npx", args: ["-y", pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier], env }
        : { command: "uvx", args: [pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier], env };
    try { await api.mcpSaveServer(name, cfg); toast(`Added ${name}`); setEnvFor(null); onAdded(); }
    catch (x) { toast(String(x)); }
  };
  return (
    <>
      <h2 className="section-h">Browse the MCP Registry</h2>
      <p className="muted">Public directory at registry.modelcontextprotocol.io. Listings are third-party: check the publisher before adding. Remote servers may ask you to sign in; package servers run locally via npx/uvx.</p>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="search" style={{ flex: 1, margin: 0 }} aria-label="Search the MCP Registry" placeholder="Search connectors (e.g. github, notion, postgres)…" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} />
        <button className="btn" disabled={busy} onClick={() => void load()}>{busy ? "Searching…" : "Search"}</button>
      </div>
      {err && <div className="error-box" style={{ marginTop: 8 }}>{err}</div>}
      {rows.map((e) => {
        const name = short(e.name);
        const remote = e.remotes[0];
        const pkg = e.packages[0];
        return (
          <div className="card" key={e.name + (e.version || "")}>
            <div className="card-head">
              <span className="name">{e.title || e.name}</span>
              {e.version && <span className="badge">v{e.version}</span>}
              <span className="badge">{remote ? `remote · ${new URL(remote.url).host}` : `${pkg.registry} · runs locally`}</span>
              <span className="spacer" />
              <button className="btn" disabled={existing.has(name)} onClick={() => {
                if (pkg && !remote && pkg.required_env.length) setEnvFor({ entry: e, vals: Object.fromEntries(pkg.required_env.map((k) => [k, ""])) });
                else if (!remote && !confirm(`${pkg.identifier} will be downloaded and run on this computer via ${pkg.registry === "npm" ? "npx" : "uvx"}. Continue?`)) return;
                else void add(e);
              }}>{existing.has(name) ? "Added" : "Add"}</button>
            </div>
            <div className="muted" style={{ marginTop: 4 }}>{e.description}</div>
            <div className="muted mono" style={{ marginTop: 2 }}>{e.name}</div>
            {envFor?.entry === e && (
              <div style={{ marginTop: 8 }}>
                {Object.keys(envFor.vals).map((k) => (
                  <div className="field" key={k}><label>{k}</label>
                    <input type="password" aria-label={k} autoComplete="off" value={envFor.vals[k]} onChange={(x) => setEnvFor({ ...envFor, vals: { ...envFor.vals, [k]: x.target.value } })} /></div>
                ))}
                <div className="muted">Runs {pkg.identifier} locally via {pkg.registry === "npm" ? "npx" : "uvx"}. Values are stored in OpenClaude’s connector config.</div>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <button className="btn primary" disabled={Object.values(envFor.vals).some((v) => !v.trim())} onClick={() => void add(e, envFor.vals)}>Add connector</button>
                  <button className="btn" onClick={() => setEnvFor(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {cursor && rows.length > 0 && <button className="btn" disabled={busy} onClick={() => void load(true)}>Load more</button>}
    </>
  );
}

function ChromeExtensionField() {
  const [info, setInfo] = useState<{ enabled: boolean; port: number; token: string | null; connected: string | null } | null>(null);
  const [show, setShow] = useState(false);
  const load = () => void invoke<{ enabled: boolean; port: number; token: string | null; connected: string | null }>("chrome_bridge_info").then(setInfo);
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, []);
  if (!info) return null;
  return (
    <div className="field">
      <label><input type="checkbox" checked={info.enabled} onChange={async (e) => { const on = e.target.checked; setInfo({ ...info, enabled: on }); await invoke("chrome_bridge_enable", { on }); load(); }} /> Chrome extension (your own browser)</label>
      <span className="help">Lets the model read and act in your real Chrome tabs, including logged-in sites. Every action asks for approval (at most “for this chat”); it never runs in background tasks. Load <span className="mono">desktop/chrome-extension</span> in chrome://extensions (Developer mode → Load unpacked), then paste the port and token into the extension popup.</span>
      {info.enabled && (
        <div className="card" style={{ margin: "6px 0 0" }}>
          <div className="muted">Status: {info.connected ? `connected (${info.connected})` : "waiting for the extension"}</div>
          <div className="mono" style={{ marginTop: 4 }}>Port: {info.port}</div>
          <div className="mono" style={{ display: "flex", gap: 8, alignItems: "center" }}>Token: {show ? info.token : "••••••••"}
            <button className="btn" onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Show"}</button>
            {info.token && <button className="btn" onClick={() => copyText(info.token!)}>Copy</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function ago(ms: number) {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function sourceLabel(p: PluginView) {
  if (p.source.kind === "local") return p.user_scope ? p.source.origin : `${p.source.origin || "local"} (read in place)`;
  const repo = p.source.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  return `GitHub ${repo}${p.source.subdir ? ` / ${p.source.subdir}` : ""}`;
}

function PluginsTab({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<PluginView[] | null>(null);
  const [spec, setSpec] = useState("");
  const [offer, setOffer] = useState<PluginOffer | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [cands, setCands] = useState<PluginCandidate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const load = () => void api.pluginsList().then(setList);
  useEffect(() => {
    load();
    const un = listen("plugins-changed", load);
    return () => void un.then((f) => f());
  }, []);
  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    try { await f(); } catch (e) { setErr(String(e)); } finally { setBusy(null); load(); }
  };
  const inspect = (s: string) => run("inspect", async () => {
    const o = await api.pluginInspect(s);
    const ok = o.items.filter((i) => i.source);
    setSpec(s);
    setOffer(o);
    setPicked(ok.length === 1 ? [ok[0].name] : []);
  });
  const set = (id: string, p: { enabled?: boolean; autoUpdate?: boolean; hooks?: boolean }) => run(`set:${id}`, () => api.pluginSet(id, p));
  const hasPonytail = list?.some((p) => p.name === "ponytail");
  const toImport = cands?.filter((c) => !c.imported) ?? [];
  return (
    <>
      <p className="muted">Plugins use the Claude Code format: skills, slash commands, agents, MCP connectors and session hooks. Type <span className="mono">/</span> in the message box to use a command or skill; models can also find skills on their own. Plugins from GitHub update automatically within 15 minutes of a new commit.</p>
      <div className="field">
        <label htmlFor="plugin-spec">Install from GitHub</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="plugin-spec" style={{ flex: 1 }} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="owner/repo or a git URL" onKeyDown={(e) => { if (e.key === "Enter" && spec.trim()) void inspect(spec.trim()); }} />
          <button className="btn" disabled={!spec.trim() || !!busy} onClick={() => void inspect(spec.trim())}>{busy === "inspect" ? "Looking…" : "Find plugins"}</button>
        </div>
        <span className="help">A marketplace repository lists its plugins; a plugin repository installs directly.</span>
      </div>
      {list && !hasPonytail && !offer && (
        <div className="card">
          <div className="card-head"><span className="name">Ponytail</span><span className="badge">featured</span></div>
          <div className="muted" style={{ margin: "6px 0" }}>Lazy senior dev mode: the smallest change that fully solves the task, and a reply you understand in one read. <span className="mono">DietrichGebert/ponytail</span></div>
          <button className="btn primary" disabled={!!busy} onClick={() => void inspect("DietrichGebert/ponytail")}>Get Ponytail</button>
        </div>
      )}
      {offer && (
        <div className="card">
          <div className="card-head"><span className="name">{offer.marketplace ?? offer.repo}</span><span className="badge">{offer.items.length} plugin{offer.items.length === 1 ? "" : "s"}</span></div>
          <div style={{ maxHeight: 280, overflow: "auto", margin: "6px 0" }}>
            {offer.items.map((it) => (
              <label key={it.name} className="offer-row">
                <input type="checkbox" disabled={!it.source} checked={picked.includes(it.name)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, it.name] : p.filter((n) => n !== it.name)))} />
                <span><strong>{it.name}</strong>{it.description && <span className="muted"> · {it.description}</span>}{it.note && <span className="help"> ({it.note})</span>}</span>
              </label>
            ))}
          </div>
          <div className="muted" style={{ margin: "8px 0" }}>Plugins can run code on your computer (hooks and MCP servers) with your permissions. Install only plugins you trust.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" disabled={!picked.length || !!busy} onClick={() => void run("install", async () => {
              const n = await api.pluginInstall(spec, picked);
              toast(`Installed ${n.join(", ")}`);
              setOffer(null);
            })}>{busy === "install" ? "Installing…" : `Install${picked.length > 1 ? ` ${picked.length}` : ""}`}</button>
            <button className="btn" onClick={() => setOffer(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="field">
        <label>Your Claude plugins</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn" disabled={!!busy} onClick={() => void run("scan", async () => setCands(await api.pluginsImportCandidates()))}>{busy === "scan" ? "Looking…" : "Find Claude plugins"}</button>
          {toImport.length > 0 && <button className="btn primary" disabled={!!busy} onClick={() => void run("import", async () => {
            const n = await api.pluginsImport(toImport.map((c) => c.key));
            toast(`Imported ${n.length} plugin${n.length === 1 ? "" : "s"}`);
            setCands(await api.pluginsImportCandidates());
          })}>{busy === "import" ? "Importing…" : `Import ${toImport.length}`}</button>}
        </div>
        <span className="help">Finds plugins installed in Claude Code and Claude Desktop, plus your own skill folders. Ones published on GitHub are installed from there so they stay current; the rest are read in place.</span>
        {cands && (
          <div className="card" style={{ margin: "6px 0 0" }}>
            {cands.length === 0 ? <div className="muted">No Claude plugins found.</div> : cands.map((c) => (
              <div key={c.key} className="offer-row">
                <span style={{ flex: 1 }}><strong>{c.name}</strong> <span className="muted">· {c.origin} · {c.github?.kind === "git" ? `updates from ${c.github.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}` : "read in place"}</span></span>
                {c.imported && <span className="badge local">added</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {err && <div className="error-box" style={{ marginTop: 10 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "18px 0 6px" }}>
        <h2 className="section-h" style={{ margin: 0, flex: 1 }}>Installed{list ? ` (${list.length})` : ""}</h2>
        <button className="btn" disabled={!!busy} onClick={() => void run("preview", async () => setPreview(await api.pluginContextPreview()))}>{busy === "preview" ? "Running hooks…" : "Preview chat context"}</button>
        <button className="btn" disabled={!!busy} onClick={() => void run("updates", async () => {
          const n = await api.pluginsUpdateAll();
          toast(n.length ? `Updated ${n.join(", ")}` : "All plugins are up to date");
        })}>{busy === "updates" ? "Checking…" : "Check for updates"}</button>
      </div>
      {preview !== null && (
        <div className="card">
          <div className="card-head"><span className="name">Added to new chats by plugin hooks</span><button className="btn" onClick={() => setPreview(null)}>Close</button></div>
          <pre className="mono context-preview">{preview || "Nothing: no enabled plugin has session hooks."}</pre>
        </div>
      )}
      {list?.length === 0 && <div className="muted">No plugins yet.</div>}
      {list?.map((p) => (
        <div className="card" key={p.id} data-plugin={p.name}>
          <div className="card-head">
            <span className="name">{p.name}</span>
            {p.version && <span className="badge">v{p.version}</span>}
            <span className="badge">{sourceLabel(p)}</span>
            {!p.enabled && <span className="badge">off</span>}
          </div>
          {p.description && <div className="muted" style={{ margin: "6px 0" }}>{p.description}</div>}
          <div className="plugin-meta">
            <span>{p.skills} skill{p.skills === 1 ? "" : "s"}</span>
            <span>{p.commands} command{p.commands === 1 ? "" : "s"}</span>
            <span>{p.agents} agent{p.agents === 1 ? "" : "s"}</span>
            {p.hook_commands > 0 && <span>{p.hook_commands} session hook{p.hook_commands === 1 ? "" : "s"}</span>}
            {p.mcp_servers.length > 0 && <span>connectors: {p.mcp_servers.join(", ")}</span>}
            {p.repo_dir && <span>updated {ago(p.updated_at)} · checked {ago(p.checked_at)}{p.sha ? ` · ${p.sha.slice(0, 7)}` : ""}</span>}
          </div>
          {p.error && <div className="error-box" style={{ marginTop: 6 }}>{p.error}</div>}
          <div className="plugin-switches">
            <label><input type="checkbox" checked={p.enabled} onChange={(e) => void set(p.id, { enabled: e.target.checked })} /> Enabled</label>
            {p.repo_dir && <label><input type="checkbox" checked={p.auto_update} onChange={(e) => void set(p.id, { autoUpdate: e.target.checked })} /> Update automatically</label>}
            {p.hook_commands > 0 && <label><input type="checkbox" checked={p.hooks} onChange={(e) => void set(p.id, { hooks: e.target.checked })} /> Run session hooks</label>}
          </div>
          <div className="plugin-actions">
            {p.repo_dir && <button className="btn" disabled={!!busy} onClick={() => void run(`update:${p.id}`, async () => {
              const r = await api.pluginUpdate(p.id);
              toast(r == null ? `${p.name} is up to date` : `Updated ${p.name}`);
            })}>{busy === `update:${p.id}` ? "Updating…" : "Update now"}</button>}
            {p.prev_sha && <button className="btn" disabled={!!busy} onClick={() => void run(`rb:${p.id}`, async () => { await api.pluginRollback(p.id); toast(`${p.name} rolled back and pinned`); })}>Roll back</button>}
            <button className="btn" disabled={!!busy} onClick={() => void run(`rm:${p.id}`, async () => { await api.pluginRemove(p.id); toast(`Removed ${p.name}`); })}>Remove</button>
          </div>
        </div>
      ))}
    </>
  );
}

function SyncField({ toast }: { toast: (m: string) => void }) {
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.syncStatus().then(setSt); }, []);
  const run = async (f: () => Promise<SyncStatus>) => {
    setBusy(true);
    try { setSt(await f()); } catch (e) { toast(String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="field">
      <label>Sync across devices</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="mono" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{st?.folder ?? "Off"}</span>
        <button className="btn" disabled={busy} onClick={() => void run(api.syncChooseFolder)}>{st?.folder ? "Change folder…" : "Choose folder…"}</button>
        {st?.folder && <button className="btn" disabled={busy} onClick={() => void run(async () => { const s = await api.syncNow(); toast("Synced"); return s; })}>{busy ? "Syncing…" : "Sync now"}</button>}
        {st?.folder && <button className="btn" disabled={busy} onClick={() => void run(api.syncOff)}>Turn off</button>}
      </div>
      <span className="help">Pick a folder your cloud drive already syncs (OneDrive, Dropbox, a network share). Chats, projects, knowledge files and a few preferences sync through it every minute; no account is involved. API keys, tool permissions and connectors stay on each device.</span>
      {st?.folder && <span className="help">This device: {st.device_name}{st.devices.length ? ` · also syncing: ${st.devices.join(", ")}` : ""}{st.last_at ? ` · last synced ${new Date(st.last_at).toLocaleTimeString()}` : ""}</span>}
      {st?.error && <div className="error-box" style={{ marginTop: 6 }}>{st.error}</div>}
    </div>
  );
}

function DevicesField({ toast }: { toast: (m: string) => void }) {
  const [on, setOn] = useState(false);
  const [inv, setInv] = useState<DeviceInventory | null>(null);
  const [name, setName] = useState("Pixel_API");
  const [image, setImage] = useState("");
  const load = () => void api.devicesInfo().then((i) => { setInv(i); setImage((x) => x || i.images[0] || ""); });
  useEffect(() => { void api.getSetting("android_devices_enabled").then((v) => setOn(v === "true")); }, []);
  useEffect(() => { if (on) load(); }, [on]);
  return (
    <div className="field">
      <label><input type="checkbox" checked={on} onChange={async (e) => { setOn(e.target.checked); await api.setSetting("android_devices_enabled", e.target.checked ? "true" : "false"); }} /> Android devices and emulators</label>
      <span className="help">Lets the model see and drive an Android emulator or a USB-debugging device through adb (screenshot, tap, swipe, type, keys, launch apps). Every action asks for approval (at most “for this chat”); it never runs in background tasks.</span>
      {on && inv && (
        <div className="card" style={{ margin: "6px 0 0" }}>
          {!inv.sdk ? <div className="muted">adb was not found. Install Android Studio, or Android SDK Platform-Tools and the Android Emulator.</div> : (
            <>
              <div className="muted">adb: <span className="mono">{inv.sdk.adb}</span>{inv.sdk.emulator ? "" : " · Android Emulator not installed"}</div>
              <div style={{ marginTop: 6 }}>{inv.devices.length ? inv.devices.map((d) => <div key={d.serial}><span className="mono">{d.serial}</span> {d.model ?? ""} <span className="badge">{d.state}</span></div>) : <span className="muted">No device online.</span>}</div>
              {inv.avds.length > 0 && <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>{inv.avds.map((a) => <button key={a} className="btn" onClick={async () => { try { await api.deviceBoot(a); toast(`Starting ${a}…`); setTimeout(load, 15000); } catch (e) { toast(String(e)); } }}>Start {a}</button>)}</div>}
              {inv.sdk.avdmanager && inv.images.length > 0 && (
                <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <input aria-label="Virtual device name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
                  <select className="btn" aria-label="System image" value={image} onChange={(e) => setImage(e.target.value)}>{inv.images.map((i) => <option key={i} value={i}>{i.replace("system-images;", "")}</option>)}</select>
                  <button className="btn" onClick={async () => { try { await api.deviceCreate(name, image, "pixel"); toast(`Created ${name}`); load(); } catch (e) { toast(String(e)); } }}>Create virtual device</button>
                </div>
              )}
              <button className="btn" style={{ marginTop: 8 }} onClick={load}>Refresh</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ProvidersTab({ toast, onModelsChanged }: { toast: (m: string) => void; onModelsChanged: () => Promise<void> }) {
  const [list, setList] = useState<ProviderView[] | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const blank = { id: "", name: "", base_url: "", preset: null as string | null, enabled: true };
  const [form, setForm] = useState(blank);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => void api.providersList().then(setList);
  useEffect(() => { load(); void api.providerPresets().then(setPresets); }, []);
  const choose = (id: string) => {
    const p = presets.find((x) => x.id === id);
    setForm(p ? { id: p.id, name: p.name, base_url: p.base_url, preset: p.id, enabled: true } : { ...blank, preset: null });
  };
  const save = async (cfg = form, apiKey: string | null = key || null) => {
    setBusy(true); setErr(null);
    try {
      await api.providerSave(cfg, apiKey);
      setForm(blank); setKey("");
      await onModelsChanged();
      load();
      toast(`Saved ${cfg.name || cfg.id}`);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const preset = presets.find((p) => p.id === form.preset);
  return (
    <>
      <p className="muted">Use models from any OpenAI-compatible provider next to your gateway: clouds (OpenAI, Anthropic, Gemini, OpenRouter, Groq…) or local servers (Ollama, LM Studio, llama.cpp, vLLM). They appear in the model picker as <span className="mono">provider::model</span>. Keys are stored in Windows Credential Manager and never shown again.</p>
      {list?.map((p) => (
        <div className="card" key={p.id} data-provider={p.id}>
          <div className="card-head">
            <span className={`dot ${!p.enabled ? "" : p.models > 0 ? "ok" : p.status?.reachable ? "warn" : "err"}`} />
            <span className="name">{p.name}</span>
            <span className="badge">{p.id}</span>
            {p.has_key && <span className="badge local">key stored</span>}
          </div>
          <div className="muted mono" style={{ margin: "4px 0" }}>{p.base_url}</div>
          <div className="muted">{!p.enabled ? "Disabled" : p.models > 0 ? `${p.models} models` : p.status?.error ?? "No models listed"}</div>
          <div className="plugin-switches">
            <label><input type="checkbox" checked={p.enabled} onChange={(e) => void save({ id: p.id, name: p.name, base_url: p.base_url, preset: p.preset, enabled: e.target.checked }, null)} /> Enabled</label>
          </div>
          <div className="plugin-actions">
            <button className="btn" onClick={() => { setForm({ id: p.id, name: p.name, base_url: p.base_url, preset: p.preset, enabled: p.enabled }); setKey(""); }}>Edit</button>
            <button className="btn" disabled={busy} onClick={async () => { await api.providerRemove(p.id); await onModelsChanged(); load(); toast(`Removed ${p.name}`); }}>Remove</button>
          </div>
        </div>
      ))}
      {list?.length === 0 && <div className="muted" style={{ margin: "8px 0" }}>No providers yet. Your gateway's models are always available.</div>}
      <h2 className="section-h">{list?.some((p) => p.id === form.id) ? `Edit ${form.name}` : "Add a provider"}</h2>
      <div className="field">
        <label htmlFor="pv-preset">Preset</label>
        <select id="pv-preset" value={form.preset ?? ""} onChange={(e) => choose(e.target.value)}>
          <option value="">Custom (any OpenAI-compatible URL)</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor="pv-name">Name</label><input id="pv-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My provider" /></div>
      <div className="field"><label htmlFor="pv-id">Id (prefix in the model picker)</label><input id="pv-id" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="my-provider" /></div>
      <div className="field"><label htmlFor="pv-url">Base URL</label><input id="pv-url" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.example.com/v1" /></div>
      <div className="field">
        <label htmlFor="pv-key">API key{preset && !preset.needs_key ? " (not needed for local servers)" : ""}</label>
        <input id="pv-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={list?.find((p) => p.id === form.id)?.has_key ? "•••••••• (leave blank to keep)" : "sk-…"} />
      </div>
      {err && <div className="error-box">{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !form.id || !form.base_url} onClick={() => void save()}>{busy ? "Saving…" : "Save provider"}</button>
        {form.id && <button className="btn" onClick={() => { setForm(blank); setKey(""); }}>Clear</button>}
      </div>
    </>
  );
}
