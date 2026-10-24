import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

type CmdEvent = { type: "out"; line: string } | { type: "err"; line: string } | { type: "exited"; code: number | null };
type Line = { kind: "cmd" | "out" | "err" | "meta"; text: string };

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const DEV_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s"'<>)`\\]*/i;
/** First local dev-server URL in a line of output (mirrors detect_dev_url in agent.rs). */
export function detectDevUrl(line: string): string | null {
  const m = DEV_URL.exec(line.replace(ANSI, ""));
  return m ? m[0].replace(/[.,;:]+$/, "") : null;
}

/**
 * Command runner for the open workspace. Each command runs in its own
 * PowerShell process (not a persistent PTY), so `cd` does not carry over.
 */
export function Terminal({ cwd, onDevicePreview }: { cwd: string; onDevicePreview?: (url: string) => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const [devUrl, setDevUrl] = useState<string | null>(null);
  const out = useRef<HTMLDivElement>(null);

  useEffect(() => { out.current?.scrollTo(0, out.current.scrollHeight); }, [lines]);
  useEffect(() => { setLines([{ kind: "meta", text: `cwd: ${cwd}` }]); setDevUrl(null); }, [cwd]);

  const push = (l: Line) => setLines((xs) => (xs.length > 5000 ? [...xs.slice(-4000), l] : [...xs, l]));

  const run = async () => {
    const command = input.trim();
    if (!command || running) return;
    setHistory((h) => [command, ...h.filter((x) => x !== command)].slice(0, 50));
    setHIdx(-1);
    setInput("");
    push({ kind: "cmd", text: `> ${command}` });
    const ch = new Channel<CmdEvent>();
    const t0 = Date.now();
    ch.onmessage = (e) => {
      if (e.type === "out" || e.type === "err") { const u = detectDevUrl(e.line); if (u) setDevUrl(u); }
      if (e.type === "out") push({ kind: "out", text: e.line });
      else if (e.type === "err") push({ kind: "err", text: e.line });
      else {
        push({ kind: "meta", text: `exit ${e.code ?? "?"} · ${((Date.now() - t0) / 1000).toFixed(1)} s` });
        setRunning(null);
        setDevUrl(null);
      }
    };
    try {
      setRunning(await invoke<string>("cmd_run", { cwd, command, onEvent: ch }));
    } catch (err) {
      push({ kind: "err", text: String(err) });
    }
  };

  return (
    <div className="term" aria-label="Terminal">
      <div className="term-out" ref={out}>
        {lines.map((l, i) => <div key={i} className={l.kind === "err" ? "err" : l.kind === "cmd" ? "cmd" : l.kind === "meta" ? "muted" : undefined}>{l.text || " "}</div>)}
      </div>
      {devUrl && (
        <div className="term-in">
          <button className="btn primary" onClick={() => invoke("preview_open", { url: devUrl }).catch((err) => push({ kind: "err", text: String(err) }))}>Preview {devUrl}</button>
          {onDevicePreview && <button className="btn" onClick={() => onDevicePreview(devUrl)}>📱 Device preview</button>}
        </div>
      )}
      <div className="term-in">
        <span className="mono">PS&gt;</span>
        <input
          value={input}
          aria-label="Command"
          placeholder={running ? "running… (Stop to cancel)" : "npm test, git log --oneline -5, …"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
            else if (e.key === "ArrowUp" && history.length) { e.preventDefault(); const i = Math.min(hIdx + 1, history.length - 1); setHIdx(i); setInput(history[i]); }
            else if (e.key === "ArrowDown") { e.preventDefault(); const i = hIdx - 1; setHIdx(i); setInput(i >= 0 ? history[i] : ""); }
          }}
        />
        {running ? (
          <button className="btn danger" onClick={() => invoke("cmd_kill", { id: running })}>Stop</button>
        ) : (
          <button className="btn" onClick={() => setLines([])}>Clear</button>
        )}
      </div>
    </div>
  );
}
