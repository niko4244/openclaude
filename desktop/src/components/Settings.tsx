import { useEffect, useState } from "react";
import { api, type ProbeReport, type GatewayStatus, type ImportCandidate, type ModelEntry, type Project, type ServerConfig, type ServerStatus } from "../api";
import { fmtTokens } from "./ModelPicker";

type Tab = "general" | "gateway" | "models" | "connectors" | "projects" | "about";
const TABS: [Tab, string][] = [
  ["general", "General"],
  ["gateway", "Gateway"],
  ["models", "Models"],
  ["connectors", "Connectors (MCP)"],
  ["projects", "Projects"],
  ["about", "About"],
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
}: {
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
  useEffect(() => { if (initialTab) setTab(initialTab as Tab); }, [initialTab]);
  return (
    <div className="settings">
      <div className="settings-inner">
        <h2>Settings</h2>
        <div className="settings-tabs" role="tablist">
          {TABS.map(([t, l]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{l}</button>
          ))}
        </div>
        {tab === "general" && <General theme={theme} onTheme={onTheme} toast={toast} />}
        {tab === "gateway" && <Gateway onChanged={onGatewayChanged} toast={toast} />}
        {tab === "models" && <Models models={models} onRefresh={onModelsChanged} />}
        {tab === "connectors" && <Connectors toast={toast} />}
        {tab === "projects" && <Projects projects={projects} models={models} onChanged={onProjectsChanged} toast={toast} />}
        {tab === "about" && <About />}
      </div>
    </div>
  );
}

function General({ theme, onTheme, toast }: { theme: string; onTheme: (t: string) => void; toast: (m: string) => void }) {
  const [sys, setSys] = useState("");
  const [tools, setTools] = useState(true);
  const [hotkey, setHotkey] = useState("");
  useEffect(() => {
    void api.getSetting("system_prompt").then((v) => setSys(v || ""));
    void api.getSetting("tools_enabled").then((v) => setTools(v !== "false"));
    void api.getSetting("quick_entry_shortcut").then((v) => setHotkey(v ?? "CommandOrControl+Alt+Space"));
  }, []);
  return (
    <>
      <div className="field">
        <label htmlFor="theme">Appearance</label>
        <select id="theme" value={theme} onChange={(e) => onTheme(e.target.value)}>
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
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
        <label htmlFor="hk">Quick entry shortcut</label>
        <input id="hk" value={hotkey} onChange={(e) => setHotkey(e.target.value)} placeholder="CommandOrControl+Alt+Space" />
        <span className="help">Global shortcut that brings OpenClaude to the front with a new chat. Leave empty to disable. Applies on save.</span>
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
            <tr><th>Alias</th><th>Where</th><th>Backend</th><th>Context</th><th>Tools (decl.)</th><th>Vision (decl.)</th><th title="Measured: chat · stream · system · tools · json · vision">Measured c/s/sys/t/j/v</th><th></th></tr>
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
      ? { type: "http", url: form.url.trim() }
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
            <span className={`dot ${s.state === "connected" ? "ok" : s.state === "connecting" ? "warn" : s.state === "error" ? "err" : ""}`} />
            <span className="name">{s.name}</span>
            <span className="badge">{s.transport}</span>
            <span className="muted">{s.state}{s.server_info?.name ? ` · ${s.server_info.name} ${s.server_info.version ?? ""}` : ""}</span>
            <span className="spacer" />
            <button className="btn" onClick={() => setOpen(open === s.name ? null : s.name)}>{open === s.name ? "Hide" : "Details"}</button>
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
          <h3>Import from other apps</h3>
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

      <h3>Add a connector</h3>
      <div className="field"><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="filesystem" /></div>
      <div className="field"><label>Command (stdio)</label><input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" /></div>
      <div className="field"><label>Arguments</label><input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder='-y @modelcontextprotocol/server-filesystem "C:\Users\me\Documents"' /></div>
      <div className="field"><label>Environment (KEY=value per line)</label><textarea value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} style={{ minHeight: 50 }} /></div>
      <div className="field"><label>…or URL (Streamable HTTP)</label><input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" /></div>
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
      <h3>{edit.id ? `Edit “${edit.name}”` : "New project"}</h3>
      <div className="field"><label>Name</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
      <div className="field"><label>Instructions</label><textarea value={edit.instructions} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} placeholder="Context and rules every chat in this project should follow." /></div>
      <div className="field">
        <label>Default model</label>
        <select value={edit.default_model || ""} onChange={(e) => setEdit({ ...edit, default_model: e.target.value || null })}>
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
  useEffect(() => { void api.appInfo().then(setInfo); }, []);
  return (
    <div className="card">
      <div className="card-head"><span className="name">OpenClaude Desktop {info?.version}</span></div>
      <div className="muted">An independent desktop client for your own LiteLLM gateway, local models and MCP connectors. Not affiliated with Anthropic.</div>
      <div className="muted mono" style={{ marginTop: 8 }}>data: {info?.data_dir}</div>
      <div className="muted mono">connectors: {info?.mcp_config}</div>
    </div>
  );
}
