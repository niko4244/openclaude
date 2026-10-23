import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type Attachment, type AttachmentResult, type ContentPart } from "../api";

export function buildContent(text: string, atts: Attachment[]): string | ContentPart[] {
  if (!atts.length) return text;
  const parts: ContentPart[] = [];
  const docs = atts.filter((a) => a.kind === "text");
  const body = docs.map((a) => `<file name="${a.name}">\n${a.text}\n</file>`).join("\n\n");
  parts.push({ type: "text", text: [body, text].filter(Boolean).join("\n\n") });
  for (const a of atts) if (a.kind === "image" && a.data_url) parts.push({ type: "image_url", image_url: { url: a.data_url } });
  return parts;
}

export function Composer({
  onSend,
  onStop,
  busy,
  modelSlot,
  initialDraft = "",
  onDraftChange,
  placeholder = "How can I help you today?",
  autoFocus,
  focusKey,
  onError,
}: {
  onSend: (text: string, atts: Attachment[]) => void;
  onStop?: () => void;
  busy: boolean;
  modelSlot?: ReactNode;
  initialDraft?: string;
  onDraftChange?: (t: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  focusKey?: string;
  onError: (msg: string) => void;
}) {
  const [text, setText] = useState(initialDraft);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setText(initialDraft), [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (autoFocus) ta.current?.focus();
  }, [focusKey, autoFocus]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 280) + "px";
  }, [text]);

  const addResults = (rs: AttachmentResult[]) => {
    for (const r of rs) {
      if ("Ok" in r) setAtts((a) => [...a, r.Ok]);
      else onError(r.Err);
    }
  };

  useEffect(() => {
    const un1 = listen<AttachmentResult[]>("attachments-dropped", (e) => {
      setDrag(false);
      addResults(e.payload);
    });
    const un2 = listen("tauri://drag-enter", () => setDrag(true));
    const un3 = listen("tauri://drag-leave", () => setDrag(false));
    return () => {
      for (const u of [un1, un2, un3]) void u.then((f) => f());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = () => {
    if (busy || (!text.trim() && !atts.length)) return;
    onSend(text.trim(), atts);
    setText("");
    setAtts([]);
    onDraftChange?.("");
  };

  return (
    <div className={`composer ${drag ? "drag" : ""}`}>
      {atts.length > 0 && (
        <div className="chips">
          {atts.map((a, i) => (
            <span className="chip" key={i} title={`${a.name} · ${(a.size / 1024).toFixed(1)} KB`}>
              {a.kind === "image" && a.data_url ? <img src={a.data_url} alt="" /> : <span>📄</span>}
              {a.name}
              <button className="icon-btn" style={{ width: 20, height: 20 }} aria-label={`Remove ${a.name}`} onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => {
          setText(e.target.value);
          onDraftChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (!files.length) return;
          e.preventDefault();
          for (const f of files) {
            const r = new FileReader();
            r.onload = () => setAtts((a) => [...a, { name: f.name || "pasted-image.png", mime: f.type, kind: "image", text: null, data_url: String(r.result), size: f.size }]);
            r.readAsDataURL(f);
          }
        }}
      />
      <div className="composer-row">
        <button className="icon-btn" title="Attach files" aria-label="Attach files" onClick={async () => addResults(await api.pickAttachments())}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden><path d="M8 3v10M3 8h10" /></svg>
        </button>
        <span className="spacer" />
        {modelSlot}
        {busy ? (
          <button className="send-btn" onClick={onStop} title="Stop (Esc)" aria-label="Stop generating">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect width="12" height="12" rx="2" fill="currentColor" /></svg>
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={!text.trim() && !atts.length} title="Send (Enter)" aria-label="Send message">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
