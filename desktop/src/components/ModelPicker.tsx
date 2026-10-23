import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelEntry } from "../api";

type Filter = "local" | "cloud" | "tools" | "vision" | "reasoning";
const FILTERS: [Filter, string][] = [
  ["local", "Local"],
  ["cloud", "Cloud"],
  ["tools", "Tools"],
  ["vision", "Vision"],
  ["reasoning", "Reasoning"],
];

export function fmtTokens(n: number | null) {
  if (n == null) return null;
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;
}

function matches(m: ModelEntry, f: Filter) {
  switch (f) {
    case "local": return m.local;
    case "cloud": return !m.local;
    case "tools": return m.supports_tools === true;
    case "vision": return m.supports_vision === true;
    case "reasoning": return m.supports_reasoning === true;
  }
}

export function ModelPicker({
  models,
  value,
  onChange,
  direction = "up",
  favorites,
  onToggleFavorite,
}: {
  models: ModelEntry[];
  value: string | null;
  onChange: (id: string) => void;
  direction?: "up" | "down";
  favorites: string[];
  onToggleFavorite: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filter[]>([]);
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const groups = useMemo(() => {
    const needle = q.toLowerCase();
    const list = models.filter(
      (m) =>
        (!needle || m.id.toLowerCase().includes(needle) || m.provider.toLowerCase().includes(needle) || (m.backend_model || "").toLowerCase().includes(needle)) &&
        filters.every((f) => matches(m, f)),
    );
    const by = new Map<string, ModelEntry[]>();
    const fav = list.filter((m) => favorites.includes(m.id));
    if (fav.length) by.set("★ Favorites", fav);
    for (const m of list) {
      const g = m.local ? `Local · ${m.provider}` : m.provider;
      if (!by.has(g)) by.set(g, []);
      by.get(g)!.push(m);
    }
    return [...by.entries()].sort(([a], [b]) => (a.startsWith("★") ? -1 : b.startsWith("★") ? 1 : a.localeCompare(b)));
  }, [models, q, filters, favorites]);
  const flat = useMemo(() => groups.flatMap(([, ms]) => ms), [groups]);

  useEffect(() => setHl(0), [q, filters]);
  useEffect(() => {
    listRef.current?.querySelector(".picker-item.hl")?.scrollIntoView({ block: "nearest" });
  }, [hl]);

  const current = models.find((m) => m.id === value);
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ("");
  };

  let idx = -1;
  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title={current?.backend_model || value || ""}>
        <span>{value || (models.length ? "Select a model" : "No models")}</span>
        {current?.local && <span className="badge local">local</span>}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 4l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.5" /></svg>
      </button>
      {open && (
        <div className={`picker-pop ${direction === "down" ? "down" : ""}`} role="listbox">
          <input
            autoFocus
            placeholder={`Search ${models.length} models…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, flat.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
              else if (e.key === "Enter" && flat[hl]) pick(flat[hl].id);
              else if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="picker-filters">
            {FILTERS.map(([f, label]) => (
              <button key={f} className={filters.includes(f) ? "on" : ""} onClick={() => setFilters((fs) => (fs.includes(f) ? fs.filter((x) => x !== f) : [...fs, f]))}>
                {label}
              </button>
            ))}
            <span className="muted" style={{ marginLeft: "auto", alignSelf: "center" }}>{flat.length} shown</span>
          </div>
          <div className="picker-list" ref={listRef}>
            {groups.map(([g, ms]) => (
              <div key={g}>
                <div className="picker-group">{g}</div>
                {ms.map((m) => {
                  idx++;
                  const i = idx;
                  const ctx = fmtTokens(m.max_input_tokens);
                  return (
                    <div key={g + m.id} style={{ display: "flex", alignItems: "center" }}>
                      <button className={`picker-item ${m.id === value ? "sel" : ""} ${i === hl ? "hl" : ""}`} onMouseEnter={() => setHl(i)} onClick={() => pick(m.id)} role="option" aria-selected={m.id === value}>
                        <div className="name">
                          {m.id}
                          {m.local && <span className="badge local">local</span>}
                          {m.supports_tools && <span className="badge cap">tools</span>}
                          {m.supports_vision && <span className="badge cap">vision</span>}
                          {m.supports_reasoning && <span className="badge cap">reasoning</span>}
                          {ctx && <span className="badge">{ctx}</span>}
                        </div>
                        <div className="sub">
                          {m.backend_model || "backend unknown"}
                          {m.input_cost_per_mtok != null && ` · $${m.input_cost_per_mtok.toFixed(2)}/$${(m.output_cost_per_mtok ?? 0).toFixed(2)} per Mtok`}
                        </div>
                      </button>
                      <button className="icon-btn" title={favorites.includes(m.id) ? "Unfavorite" : "Favorite"} onClick={() => onToggleFavorite(m.id)}>
                        {favorites.includes(m.id) ? "★" : "☆"}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
            {!flat.length && <div className="muted" style={{ padding: 12 }}>No models match.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
