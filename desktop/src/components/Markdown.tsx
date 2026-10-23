import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";

export type Artifact = { title: string; language: string; code: string };

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

function CodeBlock({ language, children, onOpen }: { language: string; children: ReactNode; onOpen?: (a: Artifact) => void }) {
  const [copied, setCopied] = useState(false);
  const code = nodeText(children).replace(/\n$/, "");
  const lines = code.split("\n").length;
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
        code: ({ className, children }) => {
          const m = /language-([\w+-]+)/.exec(className || "");
          const isBlock = !!m || nodeText(children).includes("\n");
          if (!isBlock) return <code>{children}</code>;
          return (
            <CodeBlock language={(m?.[1] || "").toLowerCase()} onOpen={onOpenArtifact}>
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
