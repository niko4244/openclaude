import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, type ModelEntry, type RecordStatus, type SkillDraft } from "../api";

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
/** Preview of the folder name the backend will use (recorder::safe_name). */
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "") || "recorded-skill";
const DEFAULT_MODEL = "gemma4-local";

type Frame = { t_ms: number; data_url: string };

/** Review a finished recording: narration, the frames the model will see, the model; then an
 *  editable SKILL.md preview that is saved to the recorded-skills folder. */
export function RecordSkillDialog({ status, models, defaultModel, onClose, toast }: {
  status: RecordStatus;
  models: ModelEntry[];
  defaultModel: string | null;
  onClose: () => void;
  toast: (m: string) => void;
}) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [narration, setNarration] = useState("");
  const [model, setModel] = useState("");
  const [step, setStep] = useState<"transcribing" | "ready" | "generating" | "review" | "saving">(status.has_audio ? "transcribing" : "ready");
  const [stream, setStream] = useState("");
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api.recordFrames().then(setFrames, (e) => setErr(String(e)));
    void api.getSetting("record_model").then((saved) => {
      const has = (id: string | null | undefined) => !!id && models.some((m) => m.id === id);
      setModel(has(saved) ? saved! : has(DEFAULT_MODEL) ? DEFAULT_MODEL : defaultModel || models[0]?.id || "");
    });
    if (status.has_audio) {
      api.recordTranscribe()
        .then((t) => setNarration(t), (e) => setErr(`Narration could not be transcribed (${e}). Type it below instead.`))
        .finally(() => setStep("ready"));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = models.find((m) => m.id === model);
  const generate = async () => {
    setErr(null);
    setStream("");
    setStep("generating");
    void api.setSetting("record_model", model);
    try {
      setDraft(await api.recordGenerate(model, narration, (t) => setStream((s) => s + t)));
      setStep("review");
    } catch (e) {
      setErr(String(e));
      setStep(draft ? "review" : "ready");
    }
  };
  const save = async () => {
    if (!draft) return;
    setErr(null);
    setStep("saving");
    try {
      const saved = await api.recordSave(draft.name, draft.description, draft.body);
      toast(`Saved the skill /${saved.name}. Use it from the / menu.`);
      onClose();
    } catch (e) {
      setErr(String(e));
      setStep("review");
    }
  };
  const discard = async () => {
    await api.recordDiscard();
    onClose();
  };

  const reviewing = draft && (step === "review" || step === "saving");
  return (
    <div className="palette-backdrop">
      <div className="palette record-dialog" role="dialog" aria-modal="true" aria-label="Record a skill">
        <div className="rd-head">
          <h2>{reviewing ? "Review your skill" : "Turn your recording into a skill"}</h2>
          <button className="icon-btn" aria-label="Discard recording" title="Discard recording" onClick={() => void discard()}><X size={16} /></button>
        </div>
        <div className="rd-body">
          <div className="muted">
            {clock(status.elapsed_ms)} recorded · {status.frames} frames kept · {status.notes.length} typed notes
          </div>
          {reviewing ? (
            <>
              <div className="field">
                <label htmlFor="rs-name">Name</label>
                <input id="rs-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                <div className="help">You will run it as /{slugOf(draft.name)}</div>
              </div>
              <div className="field">
                <label htmlFor="rs-description">Description</label>
                <textarea id="rs-description" rows={2} style={{ minHeight: 0 }} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                <div className="help">Tells the assistant when to use this skill.</div>
              </div>
              <div className="field">
                <label htmlFor="rs-body">Instructions</label>
                <textarea id="rs-body" className="mono rd-skill" rows={14} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </div>
            </>
          ) : (
            <>
              <div className="rd-frames" role="list" aria-label="Frames sent to the model">
                {frames.map((f) => (
                  <figure key={f.t_ms} role="listitem">
                    <img src={f.data_url} alt={`Screen at ${clock(f.t_ms)}`} />
                    <figcaption>{clock(f.t_ms)}</figcaption>
                  </figure>
                ))}
              </div>
              <div className="field">
                <label htmlFor="rs-narration">Narration</label>
                <textarea
                  id="rs-narration"
                  value={narration}
                  disabled={step === "transcribing"}
                  placeholder={step === "transcribing" ? "Transcribing your narration…" : "What you did and why. Transcribed from the microphone, or type it here."}
                  onChange={(e) => setNarration(e.target.value)}
                />
              </div>
              {status.notes.length > 0 && (
                <div className="field">
                  <span className="label">Typed notes</span>
                  <ul className="rd-notes">
                    {status.notes.map((n, i) => <li key={i}><span className="mono">[{clock(n.t_ms)}]</span> {n.text}</li>)}
                  </ul>
                </div>
              )}
              <div className="field">
                <label htmlFor="rs-model">Model</label>
                <select id="rs-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={step === "generating"}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.id}{m.local ? " (local)" : ""}{m.supports_vision === false ? " (no vision)" : ""}</option>)}
                </select>
                <div className="help">
                  {frames.length} frames, the narration and the notes go to {model || "the model"}
                  {chosen ? (chosen.local ? ", which runs on your machine" : ", a cloud model") : ""}. Nothing else leaves this device, and the recording is deleted when you save or discard.
                </div>
              </div>
              {step === "generating" && <pre className="rd-stream" aria-live="polite" aria-label="Model output">{stream || "Waiting for the model…"}</pre>}
            </>
          )}
          {err && <div className="banner" role="alert">{err}</div>}
        </div>
        <div className="rd-foot">
          <button className="btn" onClick={() => void discard()}>Discard</button>
          <span className="spacer" />
          {reviewing ? (
            <>
              <button className="btn" onClick={() => setStep("ready")} disabled={step === "saving"}>Back</button>
              <button className="btn primary" onClick={() => void save()} disabled={step === "saving" || !draft.description.trim() || !draft.body.trim()}>
                {step === "saving" ? "Saving…" : "Save skill"}
              </button>
            </>
          ) : (
            <>
              {draft && step === "ready" && <button className="btn" onClick={() => setStep("review")}>Back to draft</button>}
              <button className="btn primary" onClick={() => void generate()} disabled={step !== "ready" || !model || !frames.length}>
                {step === "generating" ? "Generating…" : step === "transcribing" ? "Transcribing…" : draft ? "Generate again" : "Generate skill"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
