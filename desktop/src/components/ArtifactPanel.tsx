import { useEffect, useState } from "react";
import { api } from "../api";
import { copyText, Markdown, type Artifact } from "./Markdown";

/**
 * Untrusted HTML/SVG runs in a sandboxed iframe on a separate origin
 * (`artifact:`) with its own CSP; it can never reach the app's IPC.
 */
export function ArtifactPanel({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const previewable = ["html", "svg", "markdown", "md"].includes(artifact.language);
  const [tab, setTab] = useState<"preview" | "code">(previewable ? "preview" : "code");
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setTab(previewable ? "preview" : "code");
    setUrl(null);
    if (artifact.language === "html" || artifact.language === "svg") {
      const html = artifact.language === "svg" ? `<!doctype html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${artifact.code}</body>` : artifact.code;
      void api.artifactPut(html).then(setUrl);
    }
  }, [artifact]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="artifact-panel" aria-label="Artifact">
      <div className="topbar" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="title">{artifact.title}</span>
        <span className="spacer" />
        {previewable && (
          <div className="tabs">
            <button className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>Preview</button>
            <button className={tab === "code" ? "on" : ""} onClick={() => setTab("code")}>Code</button>
          </div>
        )}
        <button className="btn" onClick={() => copyText(artifact.code)}>Copy</button>
        <button className="icon-btn" onClick={onClose} aria-label="Close artifact">✕</button>
      </div>
      <div className="artifact-body">
        {tab === "code" && <pre>{artifact.code}</pre>}
        {tab === "preview" && (artifact.language === "markdown" || artifact.language === "md") && (
          <div className="assistant-body" style={{ padding: "16px 22px" }}><Markdown text={artifact.code} /></div>
        )}
        {tab === "preview" && url && <iframe title="Artifact preview" src={url} sandbox="allow-scripts allow-forms allow-modals allow-popups" referrerPolicy="no-referrer" />}
      </div>
    </section>
  );
}
