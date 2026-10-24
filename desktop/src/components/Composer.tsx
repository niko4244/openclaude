import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowUp, BookMarked, FileText, Plus, Square } from "lucide-react";
import { api, type Attachment, type AttachmentResult, type ContentPart, type SlashCommand } from "../api";
import { VoiceButton } from "./VoiceButton";
import { voiceMode } from "../voiceMode";

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
  toolsSlot,
  onOpenLibrary,
  onPickPrompt,
  insert,
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
  toolsSlot?: ReactNode;
  onOpenLibrary?: () => void;
  /** A prompt picked from the "/" menu; the library flow fills and inserts it. */
  onPickPrompt?: (name: string) => void;
  /** Text to add to the draft (empty: just focus); a new key applies it once. */
  insert?: { key: string; text: string } | null;
}) {
  const [text, setText] = useState(initialDraft);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [cmds, setCmds] = useState<SlashCommand[] | null>(null);
  const [hl, setHl] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const slashQ = /^\/(\S*)$/.exec(text)?.[1];
  useEffect(() => {
    if (slashQ !== undefined && !cmds) void api.slashCommands().then(setCmds, () => setCmds([]));
  }, [slashQ, cmds]);
  useEffect(() => {
    const uns = ["plugins-changed", "prompts-changed"].map((ev) => listen(ev, () => setCmds(null)));
    return () => uns.forEach((un) => void un.then((f) => f()));
  }, []);
  useEffect(() => setHl(0), [slashQ]);
  const q = (slashQ ?? "").toLowerCase();
  const matches = slashQ === undefined || menuOff || !cmds ? [] : cmds.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  const pick = (c: SlashCommand) => {
    if (c.kind === "prompt" && onPickPrompt) {
      setText("");
      onDraftChange?.("");
      onPickPrompt(c.name);
      return;
    }
    const t = `/${c.name} `;
    setText(t);
    onDraftChange?.(t);
    ta.current?.focus();
  };

  useEffect(() => setText(initialDraft), [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const textRef = useRef(text);
  textRef.current = text;
  const applied = useRef(insert?.key);
  useEffect(() => {
    if (!insert || insert.key === applied.current) return;
    applied.current = insert.key;
    const t = textRef.current;
    if (insert.text) {
      const next = t.trim() ? `${t.trimEnd()}\n\n${insert.text}` : insert.text;
      setText(next);
      onDraftChange?.(next);
    }
    requestAnimationFrame(() => {
      const el = ta.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [insert]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const send = async () => {
    if (busy || (!text.trim() && !atts.length)) return;
    // `/name args`: the command, skill or agent goes along as a document the model reads.
    const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const list = m ? cmds ?? (await api.slashCommands().catch(() => [])) : [];
    const hit = m && list.find((c) => c.name === m[1] || c.name.endsWith(":" + m[1]));
    let extra: Attachment[] = [];
    if (m && hit) {
      try {
        const body = await api.slashExpand(hit.name, m[2] ?? "");
        extra = [{ name: `/${hit.name}`, mime: "text/markdown", kind: "text", text: body, data_url: null, size: body.length }];
      } catch (e) {
        onError(String(e));
        return;
      }
    }
    onSend(text.trim(), [...atts, ...extra]);
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
              {a.kind === "image" && a.data_url ? <img src={a.data_url} alt="" /> : <FileText size={16} />}
              {a.name}
              <button className="icon-btn" style={{ width: 20, height: 20 }} aria-label={`Remove ${a.name}`} onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {matches.length > 0 && (
        <div className="picker-pop slash-pop" role="listbox" aria-label="Commands and skills">
          <div className="picker-list">
            {matches.map((c, i) => (
              <button
                key={c.name}
                role="option"
                aria-selected={i === hl}
                className={`picker-item ${i === hl ? "hl" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); pick(c); }}
                onMouseEnter={() => setHl(i)}
              >
                <span className="name"><span className="mono">/{c.name}</span><span className="badge">{c.kind}</span>{c.arg_hint && <span className="sub">{c.arg_hint}</span>}</span>
                {c.description && <span className="sub">{c.description}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => {
          setMenuOff(false);
          setText(e.target.value);
          onDraftChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setHl((h) => (h + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
              e.preventDefault();
              pick(matches[hl] ?? matches[0]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setMenuOff(true);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
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
        <button className="icon-btn bordered" title="Add files and photos" aria-label="Attach files" onClick={async () => addResults(await api.pickAttachments())}>
          <Plus size={17} strokeWidth={1.75} />
        </button>
        {onOpenLibrary && (
          <button className="icon-btn" title="Prompt library" aria-label="Prompt library" onClick={onOpenLibrary}>
            <BookMarked size={16} strokeWidth={1.75} />
          </button>
        )}
        {toolsSlot}
        <VoiceButton
          onText={(t) => {
            // Voice conversation: send the dictation straight away.
            if (voiceMode.get() && !busy && t.trim()) { onSend(t.trim(), []); return; }
            setText((x) => (x ? x + " " : "") + t);
            ta.current?.focus();
          }}
          onError={onError}
        />
        <span className="spacer" />
        {modelSlot}
        {busy ? (
          <button className="send-btn" onClick={onStop} title="Stop (Esc)" aria-label="Stop generating">
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button className="send-btn" onClick={() => void send()} disabled={!text.trim() && !atts.length} title="Send (Enter)" aria-label="Send message">
            <ArrowUp size={17} strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  );
}
