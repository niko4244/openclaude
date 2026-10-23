import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Mic, Square } from "lucide-react";

const MAX_MS = 2 * 60 * 1000;

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Mic button: record (max 2 min) -> `voice_transcribe` -> onText. */
export function VoiceButton({ onText, onError }: { onText: (t: string) => void; onError: (m: string) => void }) {
  const [state, setState] = useState<"idle" | "rec" | "busy">("idle");
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const stop = () => {
    window.clearTimeout(timer.current);
    if (rec.current?.state === "recording") rec.current.stop();
  };
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    const r = rec.current;
    if (r && r.state === "recording") {
      r.onstop = null; // unmounted: discard
      r.stop();
      r.stream.getTracks().forEach((t) => t.stop());
    }
  }, []);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } : undefined);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        rec.current = null;
        if (!chunks.length) return setState("idle");
        setState("busy");
        try {
          const mime = mr.mimeType || "audio/webm";
          const audioB64 = await toBase64(new Blob(chunks, { type: mime }));
          const text = await invoke<string>("voice_transcribe", { audioB64, mime });
          if (text.trim()) onText(text.trim());
        } catch (e) {
          onError(String(e));
        } finally {
          setState("idle");
        }
      };
      rec.current = mr;
      mr.start();
      setState("rec");
      timer.current = window.setTimeout(stop, MAX_MS);
    } catch (e) {
      onError(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`);
      setState("idle");
    }
  };

  return (
    <button
      type="button"
      className={"icon-btn" + (state === "rec" ? " on" : "")}
      aria-label={state === "rec" ? "Stop dictation" : "Dictate"}
      title={state === "rec" ? "Stop dictation" : "Dictate"}
      disabled={state === "busy"}
      onClick={() => (state === "rec" ? stop() : void start())}
    >
      {state === "busy" ? <Loader2 size={16} className="logo-spin" /> : state === "rec" ? <Square size={14} fill="currentColor" /> : <Mic size={16} />}
    </button>
  );
}
