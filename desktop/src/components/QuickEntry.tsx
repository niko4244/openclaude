import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";

/** Floating prompt bar (Ctrl+Alt+Space). Enter hands the prompt to the main window as a new chat. */
export function QuickEntry() {
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.documentElement.classList.add("quick-root");
    void api.getSetting("default_model").then(setModel);
    void api.getSetting("theme").then((t) => { if (t && t !== "system") document.documentElement.dataset.theme = t; });
    const un = listen("quick-shown", () => {
      void api.getSetting("default_model").then(setModel);
      ref.current?.focus();
      ref.current?.select();
    });
    ref.current?.focus();
    return () => void un.then((f) => f());
  }, []);

  const submit = async () => {
    if (!text.trim()) return;
    await invoke("quick_entry_submit", { text: text.trim(), model });
    setText("");
  };

  return (
    <div className="quick">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder="Ask OpenClaude anything…"
        aria-label="Quick entry prompt"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
          if (e.key === "Escape") void invoke("quick_entry_hide");
        }}
      />
      <div className="quick-foot">
        <span className="muted">{model ? `→ ${model}` : "no default model"} · Enter to send · Esc to close</span>
        <button className="send-btn" onClick={submit} disabled={!text.trim()} aria-label="Send">↑</button>
      </div>
    </div>
  );
}
