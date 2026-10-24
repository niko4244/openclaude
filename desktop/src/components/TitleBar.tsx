import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Menu, Minus, Square, X } from "lucide-react";

type Item = { id: string; label: string; hint?: string } | "sep";
const ITEMS: Item[] = [
  { id: "new_chat", label: "New chat", hint: "Ctrl+N" },
  { id: "quick_entry", label: "Quick entry", hint: "Ctrl+Alt+Space" },
  { id: "search", label: "Search chats", hint: "Ctrl+K" },
  { id: "find", label: "Find in chat", hint: "Ctrl+F" },
  "sep",
  { id: "toggle_sidebar", label: "Toggle sidebar", hint: "Ctrl+B" },
  { id: "zoom_in", label: "Zoom in", hint: "Ctrl+=" },
  { id: "zoom_out", label: "Zoom out", hint: "Ctrl+-" },
  { id: "zoom_reset", label: "Actual size", hint: "Ctrl+0" },
  "sep",
  { id: "settings", label: "Settings", hint: "Ctrl+," },
  { id: "shortcuts", label: "Keyboard shortcuts", hint: "Ctrl+/" },
  { id: "about", label: "About OpenClaude" },
  "sep",
  { id: "quit", label: "Quit OpenClaude" },
];

/** The application menu (☰), shown in the sidebar header's title row. */
export function AppMenu({ onMenu }: { onMenu: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const run = (id: string) => {
    setOpen(false);
    if (["zoom_in", "zoom_out", "zoom_reset", "quick_entry", "quit"].includes(id)) void invoke("menu_action", { id });
    else onMenu(id);
  };

  return (
    <div className="picker" ref={ref}>
      <button className="icon-btn" aria-label="Application menu" title="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Menu size={17} strokeWidth={1.75} /></button>
      {open && (
        <div className="menu" style={{ position: "absolute", top: 34, left: 0, zIndex: 70 }} role="menu">
          {ITEMS.map((it, i) => it === "sep" ? <div key={i} className="menu-sep" /> : (
            <button key={it.id} role="menuitem" onClick={() => run(it.id)}><span className="grow">{it.label}</span>{it.hint && <span className="muted">{it.hint}</span>}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Frameless window: minimize / maximize / close float over the top-right of the 48 px title row,
 * like the reference app's overlay controls; rows under them reserve `--wc-inset`.
 */
export function WindowControls() {
  const win = getCurrentWindow();
  const [maxed, setMaxed] = useState(false);
  useEffect(() => {
    const sync = () => void win.isMaximized().then(setMaxed);
    sync();
    const un = win.onResized(sync);
    return () => void un.then((f) => f());
  }, [win]);
  return (
    <div className="win-controls">
      <button className="tb-btn" aria-label="Minimize" onClick={() => void win.minimize()}><Minus size={15} /></button>
      <button className="tb-btn" aria-label={maxed ? "Restore" : "Maximize"} onClick={() => void win.toggleMaximize()}>{maxed ? <Copy size={13} /> : <Square size={13} />}</button>
      <button className="tb-btn close" aria-label="Close" onClick={() => void win.close()}><X size={16} /></button>
    </div>
  );
}
