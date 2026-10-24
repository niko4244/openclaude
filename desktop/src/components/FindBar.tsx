import { useEffect, useRef, useState } from "react";

/** Find in the current chat using the CSS Custom Highlight API (no DOM mutation). */
export function FindBar({ root, onClose }: { root: () => HTMLElement | null; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const el = root();
    const found: Range[] = [];
    if (el && q.length >= 1) {
      const needle = q.toLowerCase();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.nodeValue || "").toLowerCase();
        for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
          const r = new Range();
          r.setStart(n, i);
          r.setEnd(n, i + needle.length);
          found.push(r);
        }
      }
    }
    setRanges(found);
    setIdx(0);
  }, [q, root]);

  useEffect(() => {
    CSS.highlights.set("oc-find", new Highlight(...ranges));
    const cur = ranges[idx];
    if (cur) {
      CSS.highlights.set("oc-find-current", new Highlight(cur));
      cur.startContainer.parentElement?.scrollIntoView({ block: "center" });
    } else CSS.highlights.delete("oc-find-current");
  }, [ranges, idx]);

  useEffect(() => () => { CSS.highlights.delete("oc-find"); CSS.highlights.delete("oc-find-current"); }, []);

  const step = (d: number) => ranges.length && setIdx((i) => (i + d + ranges.length) % ranges.length);
  return (
    <div className="findbar" role="search">
      <input
        ref={input}
        value={q}
        placeholder="Find in chat"
        aria-label="Find in chat"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "F3") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          if (e.key === "Escape") onClose();
        }}
      />
      <span className="muted" style={{ minWidth: 56, textAlign: "center" }}>{ranges.length ? `${idx + 1} / ${ranges.length}` : q ? "0 / 0" : ""}</span>
      <button className="icon-btn" aria-label="Previous match" onClick={() => step(-1)}>↑</button>
      <button className="icon-btn" aria-label="Next match" onClick={() => step(1)}>↓</button>
      <button className="icon-btn" aria-label="Close find" onClick={onClose}>✕</button>
    </div>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["Ctrl+N", "New chat"],
  ["Ctrl+Alt+Space", "Quick entry (global, configurable)"],
  ["Ctrl+K", "Search chats"],
  ["Ctrl+B", "Toggle sidebar"],
  ["Ctrl+F / F3 / Shift+F3", "Find in chat, next, previous"],
  ["Ctrl+,", "Settings"],
  ["Ctrl+/", "Keyboard shortcuts"],
  ["Ctrl+= / Ctrl+- / Ctrl+0", "Zoom in, out, reset"],
  ["Enter / Shift+Enter", "Send / new line"],
  ["Esc", "Stop generating, close panels"],
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>Keyboard shortcuts</h2>
        <table>
          <tbody>
            {SHORTCUTS.map(([k, d]) => (
              <tr key={k}><td>{d}</td><td style={{ textAlign: "right" }}>{k.split(" / ").map((x, i) => <span key={x}>{i > 0 && " / "}<kbd>{x}</kbd></span>)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
