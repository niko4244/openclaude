import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff, Square, X } from "lucide-react";
import { api, type RecordStatus } from "../api";
import { toBase64 } from "./VoiceButton";

/** Matches recorder::MAX_DURATION: capture stops there anyway. */
const MAX_MS = 10 * 60 * 1000;

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** The recording indicator window (always on top, never in its own frames): time, frames,
 *  microphone narration, typed notes, Stop and Cancel. */
export function RecorderBar() {
  const [st, setSt] = useState<RecordStatus | null>(null);
  const [mic, setMic] = useState<"off" | "on" | "paused" | "denied">("off");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const micAsked = useRef(false);

  const startMic = async () => {
    if (micAsked.current) return;
    micAsked.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } : undefined);
      mr.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      mr.start(1000);
      rec.current = mr;
      setMic("on");
    } catch {
      setMic("denied");
    }
  };

  const toggleMic = async () => {
    const mr = rec.current;
    const on = !mr || mr.state !== "recording";
    await api.setSetting("record_mic", String(on));
    if (!mr) return startMic();
    if (on) { mr.resume(); setMic("on"); } else { mr.pause(); setMic("paused"); }
  };

  /** Stops the microphone; resolves with the narration, or null when nothing was said. */
  const finishMic = () => new Promise<Blob | null>((resolve) => {
    const mr = rec.current;
    rec.current = null;
    if (!mr) return resolve(null);
    const done = () => {
      mr.stream.getTracks().forEach((t) => t.stop());
      resolve(chunks.current.length ? new Blob(chunks.current, { type: mr.mimeType || "audio/webm" }) : null);
    };
    if (mr.state === "inactive") return done();
    mr.onstop = done;
    mr.stop();
  });

  const stop = async () => {
    if (busy) return;
    setBusy("Finishing…");
    const blob = await finishMic();
    try {
      await api.recordStop(blob ? await toBase64(blob) : null, blob?.type || null);
    } catch {
      setBusy(null); // the main window shows why
    }
  };

  const cancel = async () => {
    if (busy) return;
    setBusy("Discarding…");
    await finishMic();
    chunks.current = [];
    await api.recordCancel();
  };

  const addNote = async () => {
    const t = note.trim();
    if (!t) return;
    setNote("");
    await api.recordNote(t).catch(() => {});
  };

  useEffect(() => {
    document.documentElement.classList.add("recorder-root");
    void api.getSetting("theme").then((t) => { if (t && t !== "system") document.documentElement.dataset.theme = t; });
    void api.getSetting("record_mic").then((m) => { if (m !== "false") void startMic(); });
    const poll = () => void api.recordStatus().then(setSt, () => {});
    poll();
    const t = window.setInterval(poll, 1000);
    return () => window.clearInterval(t);
  }, []);

  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    if (st?.recording && st.elapsed_ms >= MAX_MS) void stopRef.current();
  }, [st]);

  const micLabel = mic === "on" ? "Pause microphone narration" : mic === "denied" ? "Microphone unavailable" : "Narrate with the microphone";
  return (
    <div className="recorder" role="region" aria-label="Recording a skill">
      <span className="rec-live" data-tauri-drag-region>
        <span className="rec-dot" aria-hidden="true" />
        <span className="rec-time" data-tauri-drag-region>{clock(st?.elapsed_ms ?? 0)}</span>
      </span>
      <span className="muted rec-count" title={st?.error ?? "Frames kept so far"} data-tauri-drag-region>
        {st?.frames ?? 0} frames{st?.notes.length ? ` · ${st.notes.length} notes` : ""}{st?.error ? " · !" : ""}
      </span>
      <button type="button" className={"icon-btn" + (mic === "on" ? " on" : "")} aria-label={micLabel} title={micLabel} aria-pressed={mic === "on"} disabled={mic === "denied" || !!busy} onClick={() => void toggleMic()}>
        {mic === "on" ? <Mic size={16} /> : <MicOff size={16} />}
      </button>
      <input
        className="rec-note"
        aria-label="Narration note"
        placeholder={mic === "on" ? "Talk, or type a note and press Enter" : "Type what you are doing and press Enter"}
        value={note}
        disabled={!!busy}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addNote(); } }}
      />
      {busy ? (
        <span className="muted rec-busy"><Loader2 size={14} className="logo-spin" /> {busy}</span>
      ) : (
        <>
          <button type="button" className="btn primary rec-stop" onClick={() => void stop()} title="Stop and turn the recording into a skill">
            <Square size={10} fill="currentColor" /> Stop
          </button>
          <button type="button" className="icon-btn" onClick={() => void cancel()} aria-label="Cancel recording" title="Cancel and delete the recording">
            <X size={16} />
          </button>
        </>
      )}
    </div>
  );
}
