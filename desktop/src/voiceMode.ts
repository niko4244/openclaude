// Hands-free voice conversation: dictated text is sent immediately and the reply is read aloud.
const KEY = "oc-voice-mode";
let enabled = false;
try { enabled = localStorage.getItem(KEY) === "1"; } catch { /* storage unavailable */ }

export const voiceMode = {
  get: () => enabled,
  set(on: boolean) {
    enabled = on;
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* ignore */ }
    window.dispatchEvent(new Event("oc-voice-mode"));
  },
};

/** Speak text with the OS voices; code blocks are skipped. */
export function speak(text: string) {
  if (!("speechSynthesis" in window) || !text.trim()) return;
  const plain = text.replace(/```[\s\S]*?```/g, " (code block) ").replace(/[*_#>`]/g, "");
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(plain));
}
