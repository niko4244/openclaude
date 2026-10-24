import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import { copyText, Markdown, type Artifact } from "./Markdown";

const isReact = (a: Artifact) => ["jsx", "tsx", "react"].includes(a.language) && /export\s+default/.test(a.code);

function b64(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const decode = (v: string) => `new TextDecoder().decode(Uint8Array.from(atob("${v}"), (c) => c.charCodeAt(0)))`;
const errBox = `<pre id="err" style="display:none;margin:0;padding:12px;color:#b3261e;white-space:pre-wrap;font:12.5px/1.5 ui-monospace,monospace"></pre>
<script>window.__fail = (e) => { const el = document.getElementById("err"); el.style.display = "block"; el.textContent = String((e && e.stack) || e); };
addEventListener("error", (e) => __fail(e.error || e.message)); addEventListener("unhandledrejection", (e) => __fail(e.reason));</script>`;

/** A React component artifact (default export), like Claude's: JSX/TSX compiled in the sandbox, Tailwind available. */
function reactDoc(code: string) {
  const imports = {
    react: "https://esm.sh/react@18.3.1",
    "react/": "https://esm.sh/react@18.3.1/",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
    "lucide-react": "https://esm.sh/lucide-react@0.460.0?external=react",
    recharts: "https://esm.sh/recharts@2.13.3?external=react,react-dom",
    lodash: "https://esm.sh/lodash@4.17.21",
    d3: "https://esm.sh/d3@7.9.0",
    papaparse: "https://esm.sh/papaparse@5.4.1",
    three: "https://esm.sh/three@0.170.0",
  };
  return `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.tailwindcss.com/3.4.16"></script>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.4/babel.min.js"></script>
</head><body><div id="root"></div>${errBox}
<script type="module">
try {
  const src = ${decode(b64(code))};
  const out = Babel.transform(src, { filename: "App.tsx", presets: [["react", { runtime: "automatic" }], ["typescript", { isTSX: true, allExtensions: true }]] }).code;
  const url = URL.createObjectURL(new Blob([out], { type: "text/javascript" }));
  const [{ default: App }, { createRoot }, React] = await Promise.all([import(url), import("react-dom/client"), import("react")]);
  createRoot(document.getElementById("root")).render(React.createElement(App));
} catch (e) { __fail(e); }
</script></body></html>`;
}

function mermaidDoc(code: string) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;display:flex;justify-content:center">
<div id="m"></div>${errBox}
<script type="module">
try {
  const { default: mermaid } = await import("https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  const { svg } = await mermaid.render("diagram", ${decode(b64(code))});
  document.getElementById("m").innerHTML = svg;
} catch (e) { __fail(e); }
</script></body></html>`;
}

function docFor(a: Artifact): string | null {
  if (a.language === "html") return a.code;
  if (a.language === "svg") return `<!doctype html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${a.code}</body>`;
  if (a.language === "mermaid") return mermaidDoc(a.code);
  if (isReact(a)) return reactDoc(a.code);
  return null;
}

/**
 * Untrusted HTML/SVG/React/Mermaid runs in a sandboxed iframe on a separate origin
 * (`artifact:`) with its own CSP; it can never reach the app's IPC.
 */
export function ArtifactPanel({ artifact, versions = [], onSelect, onClose, onAsk }: { artifact: Artifact; versions?: Artifact[]; onSelect?: (a: Artifact) => void; onClose: () => void; onAsk?: (prompt: string) => void }) {
  const previewable = ["html", "svg", "markdown", "md", "mermaid"].includes(artifact.language) || isReact(artifact);
  const [tab, setTab] = useState<"preview" | "code">(previewable ? "preview" : "code");
  const [url, setUrl] = useState<string | null>(null);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    setTab(previewable ? "preview" : "code");
    setUrl(null);
    setSel(null);
    const doc = docFor(artifact);
    if (doc) void api.artifactPut(doc).then(setUrl);
  }, [artifact]); // eslint-disable-line react-hooks/exhaustive-deps

  // Select part of the code or document, then ask about just that part (Claude's "Improve" / "Explain").
  const onMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    const text = window.getSelection()?.toString().trim() ?? "";
    if (!onAsk || text.length < 2) return setSel(null);
    const box = e.currentTarget.getBoundingClientRect();
    setSel({ text, x: Math.min(e.clientX - box.left, box.width - 190), y: e.clientY - box.top + e.currentTarget.scrollTop + 10 });
  };
  const ask = (verb: "Improve" | "Explain") => {
    if (!sel || !onAsk) return;
    const quoted = "```\n" + sel.text + "\n```";
    onAsk(verb === "Improve"
      ? `In the artifact "${artifact.title}", improve this part:\n\n${quoted}\n\nReturn the complete updated artifact with the same title.`
      : `In the artifact "${artifact.title}", explain this part:\n\n${quoted}`);
    setSel(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <section className="artifact-panel" aria-label="Artifact">
      <div className="topbar" data-tauri-drag-region="deep" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="title">{artifact.title}</span>
        {versions.length > 1 && (
          <select className="btn" aria-label="Artifact version" value={versions.indexOf(artifact) >= 0 ? versions.indexOf(artifact) : versions.length - 1}
            onChange={(e) => onSelect?.(versions[Number(e.target.value)])}>
            {versions.map((_, i) => <option key={i} value={i}>Version {i + 1}{i === versions.length - 1 ? " (latest)" : ""}</option>)}
          </select>
        )}
        <span className="spacer" />
        {previewable && (
          <div className="tabs">
            <button className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>Preview</button>
            <button className={tab === "code" ? "on" : ""} onClick={() => setTab("code")}>Code</button>
          </div>
        )}
        <button className="btn" onClick={() => copyText(artifact.code)}>Copy</button>
        <button className="btn" onClick={() => void invoke("artifact_save", { title: artifact.title, language: artifact.language, code: artifact.code })}>Download</button>
        <button className="icon-btn" onClick={onClose} aria-label="Close artifact">✕</button>
      </div>
      <div className="artifact-body" onMouseUp={onMouseUp} onScroll={() => setSel(null)}>
        {tab === "code" && <pre>{artifact.code}</pre>}
        {tab === "preview" && (artifact.language === "markdown" || artifact.language === "md") && (
          <div className="assistant-body" style={{ padding: "16px 22px" }}><Markdown text={artifact.code} /></div>
        )}
        {tab === "preview" && url && <iframe title="Artifact preview" src={url} sandbox="allow-scripts allow-forms allow-modals allow-popups" referrerPolicy="no-referrer" />}
        {sel && (
          <div className="ask-bar" style={{ left: Math.max(8, sel.x), top: sel.y }} onMouseUp={(e) => e.stopPropagation()}>
            <button className="btn" onClick={() => ask("Improve")}>Improve</button>
            <button className="btn" onClick={() => ask("Explain")}>Explain</button>
          </div>
        )}
      </div>
    </section>
  );
}
