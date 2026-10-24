import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Code2, FileText, Globe, Image as ImageIcon } from "lucide-react";

/** `version`/`count` are set when the same titled artifact appears several times in a chat. */
export type Artifact = { title: string; language: string; code: string; version?: number; count?: number };

/** Fenced blocks tagged ```lang title="…" are artifacts (see the system prompt in chat.rs). */
export const ARTIFACT_RE = /```([\w+-]*)[ \t]+title="([^"\n]+)"[^\n]*\n([\s\S]*?)```/g;

export function extractArtifacts(text: string): Artifact[] {
  return [...text.matchAll(ARTIFACT_RE)].map((m) => ({ language: (m[1] || "text").toLowerCase(), title: m[2], code: m[3].replace(/\n$/, "") }));
}

function ArtifactCard({ a, onOpen }: { a: Artifact; onOpen?: (a: Artifact) => void }) {
  const Icon = a.language === "html" ? Globe : a.language === "svg" ? ImageIcon : a.language === "markdown" || a.language === "md" ? FileText : Code2;
  const kind = a.language === "html" ? "Web page" : a.language === "svg" ? "Image" : a.language === "markdown" || a.language === "md" ? "Document" : `Code · ${a.language || "text"}`;
  return (
    <button className="artifact-card" onClick={() => onOpen?.(a)} title="Open in the side panel">
      <span className="artifact-icon"><Icon size={18} /></span>
      <span className="grow"><span className="artifact-title">{a.title}</span><span className="muted">{kind} · {a.code.split("\n").length} lines · click to open</span></span>
    </button>
  );
}

const PREVIEWABLE = new Set(["html", "svg", "markdown", "md"]);

function nodeText(n: ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join("");
  if (n && typeof n === "object" && "props" in n) return nodeText((n as { props: { children?: ReactNode } }).props.children);
  return "";
}

export async function copyText(text: string) {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

function CodeBlock({ language, children, onOpen, title }: { language: string; children: ReactNode; onOpen?: (a: Artifact) => void; title?: string }) {
  const [copied, setCopied] = useState(false);
  const code = nodeText(children).replace(/\n$/, "");
  const lines = code.split("\n").length;
  if (title) return <ArtifactCard a={{ title, language, code }} onOpen={onOpen} />;
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{language || "text"}</span>
        <span className="spacer" />
        {onOpen && (PREVIEWABLE.has(language) || lines > 12) && (
          <button className="btn" onClick={() => onOpen({ title: `${language || "code"} · ${lines} lines`, language, code })}>
            {PREVIEWABLE.has(language) ? "Preview" : "Open"}
          </button>
        )}
        <button
          className="btn"
          aria-label="Copy code"
          onClick={async () => {
            await copyText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className={language ? `hljs language-${language}` : "hljs"}>{children}</code>
      </pre>
    </div>
  );
}

/** Markdown with GFM + highlighting. Raw HTML in model output is never rendered. */
export const Markdown = memo(function Markdown({ text, onOpenArtifact }: { text: string; onOpenArtifact?: (a: Artifact) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      skipHtml
      components={{
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children, node }) => {
          const m = /language-([\w+-]+)/.exec(className || "");
          const meta = String((node?.data as { meta?: string } | undefined)?.meta ?? "");
          const title = /title="([^"]+)"/.exec(meta)?.[1];
          const isBlock = !!m || nodeText(children).includes("\n");
          if (!isBlock) return <code>{children}</code>;
          return (
            <CodeBlock language={(m?.[1] || "").toLowerCase()} onOpen={onOpenArtifact} title={title}>
              {children}
            </CodeBlock>
          );
        },
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (href && /^https?:\/\//i.test(href)) void openUrl(href);
            }}
            title={href}
          >
            {children}
          </a>
        ),
        img: ({ alt }) => <span className="muted">[image: {alt || "remote image not loaded"}]</span>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
});
