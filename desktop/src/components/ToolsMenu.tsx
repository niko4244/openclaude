import { useEffect, useRef, useState } from "react";
import { AudioLines, Brain, Plug, SlidersHorizontal } from "lucide-react";
import { voiceMode } from "../voiceMode";
import { api, type ServerStatus } from "../api";

/** Composer tools popover: per-connector on/off and extended thinking. Both are persisted preferences. */
export function ToolsMenu({ onManage }: { onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<ServerStatus[]>([]);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [thinking, setThinking] = useState(false);
  const [voice, setVoice] = useState(voiceMode.get());
  const ref = useRef<HTMLDivElement>(null);

  const load = async () => {
    setServers(await api.mcpStatus());
    setDisabled(JSON.parse((await api.getSetting("mcp_disabled")) || "[]"));
    setThinking((await api.getSetting("extended_thinking")) === "true");
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!open) return;
    void load();
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const toggleServer = async (name: string) => {
    const next = disabled.includes(name) ? disabled.filter((d) => d !== name) : [...disabled, name];
    setDisabled(next);
    await api.setSetting("mcp_disabled", JSON.stringify(next));
  };
  const active = servers.filter((s) => s.state === "connected" && !disabled.includes(s.name)).length;

  return (
    <div className="picker" ref={ref}>
      <button className={`icon-btn ${thinking || active ? "on" : ""}`} onClick={() => setOpen((o) => !o)} aria-label="Search and tools" aria-expanded={open} title="Tools">
        <SlidersHorizontal size={16} strokeWidth={1.75} />
        {active > 0 && <span className="count">{active}</span>}
      </button>
      {open && (
        <div className="picker-pop tools-pop" role="menu" style={{ left: 0, right: "auto", width: 320 }}>
          <label className="tool-row">
            <Brain size={16} />
            <span className="grow">Extended thinking<span className="sub">Asks the model for deeper reasoning (reasoning_effort=high). Models without support may reject it.</span></span>
            <input type="checkbox" role="switch" checked={thinking} onChange={async (e) => { setThinking(e.target.checked); await api.setSetting("extended_thinking", String(e.target.checked)); }} />
          </label>
          <label className="tool-row">
            <AudioLines size={16} />
            <span className="grow">Voice conversation<span className="sub">Dictation is sent immediately and replies are read aloud.</span></span>
            <input type="checkbox" role="switch" checked={voice} onChange={(e) => { setVoice(e.target.checked); voiceMode.set(e.target.checked); }} />
          </label>
          <div className="picker-group">Connectors</div>
          {servers.map((s) => (
            <label className="tool-row" key={s.name}>
              <Plug size={16} />
              <span className="grow">{s.name}<span className="sub">{s.state === "connected" ? `${s.tools.length} tools` : s.state}</span></span>
              <input type="checkbox" role="switch" disabled={s.state !== "connected"} checked={s.state === "connected" && !disabled.includes(s.name)} onChange={() => toggleServer(s.name)} />
            </label>
          ))}
          {!servers.length && <div className="muted" style={{ padding: "4px 12px" }}>No connectors yet.</div>}
          <button className="tool-row link" onClick={() => { setOpen(false); onManage(); }}>Manage connectors…</button>
        </div>
      )}
    </div>
  );
}
