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

/** Frameless window chrome: drag region, app menu, and window controls. */
export function TitleBar({ onMenu }: { onMenu: (id: string) => void }) {
  const win = getCurrentWindow();
  const [maxed, setMaxed] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => void win.isMaximized().then(setMaxed);
    sync();
    const un = win.onResized(sync);
    return () => void un.then((f) => f());
  }, [win]);
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
    <div className="titlebar" data-tauri-drag-region onDoubleClick={(e) => { if (e.target === e.currentTarget) void win.toggleMaximize(); }}>
      <div className="picker" ref={ref}>
        <button className="tb-btn" aria-label="Application menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Menu size={15} /></button>
        {open && (
          <div className="menu" style={{ position: "absolute", top: 34, left: 4 }} role="menu">
            {ITEMS.map((it, i) => it === "sep" ? <div key={i} className="menu-sep" /> : (
              <button key={it.id} role="menuitem" onClick={() => run(it.id)}><span className="grow">{it.label}</span>{it.hint && <span className="muted">{it.hint}</span>}</button>
            ))}
          </div>
        )}
      </div>
      <div className="tb-drag" data-tauri-drag-region />
      <button className="tb-btn" aria-label="Minimize" onClick={() => void win.minimize()}><Minus size={15} /></button>
      <button className="tb-btn" aria-label={maxed ? "Restore" : "Maximize"} onClick={() => void win.toggleMaximize()}>{maxed ? <Copy size={13} /> : <Square size={13} />}</button>
      <button className="tb-btn close" aria-label="Close" onClick={() => void win.close()}><X size={16} /></button>
    </div>
  );
}
