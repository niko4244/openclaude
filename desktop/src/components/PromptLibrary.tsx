import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Copy, Pencil, Plus, Search, Star, Trash2, X } from "lucide-react";
import { api, type PluginOffer, type Prompt, type PromptCollection } from "../api";
import { copyText } from "./Markdown";
import { ago } from "./Pages";

/** Anthropic's prompt library for Claude Code: linked from the app, never copied into it. */
export const OFFICIAL_LIBRARY = "https://code.claude.com/docs/en/prompt-library";

const PH = /\$ARGUMENTS|\$([1-9])|\{\{\s*([\w.-]+)\s*\}\}/g;
const keyOf = (n?: string, v?: string) => (v ? `{{${v}}}` : n ? `$${n}` : "$ARGUMENTS");

/** Values a prompt asks for, in order: Claude-style `$ARGUMENTS` / `$1`…`$9` and `{{name}}`. */
export function placeholders(body: string) {
  const out: { key: string; label: string }[] = [];
  for (const m of body.matchAll(PH)) {
    const key = keyOf(m[1], m[2]);
    if (!out.some((v) => v.key === key)) out.push({ key, label: m[2] ?? (m[1] ? `Argument ${m[1]}` : "Arguments") });
  }
  return out;
}

/** One pass, so a value is never substituted again; an empty value keeps its placeholder. */
export function fillPrompt(body: string, values: Record<string, string>) {
  return body.replace(PH, (m, n?: string, v?: string) => (values[keyOf(n, v)] ?? "").trim() || m);
}

function score(p: Prompt, words: string[]) {
  const title = p.title.toLowerCase();
  const desc = p.description.toLowerCase();
  const tags = p.tags.map((t) => t.toLowerCase());
  let s = 0;
  for (const w of words) {
    const hit = 3 * +title.includes(w) + 2 * +tags.some((t) => t.includes(w)) + +desc.includes(w) + +p.name.toLowerCase().includes(w);
    if (!hit) return 0;
    s += hit;
  }
  return s;
}

const firstLine = (body: string) => body.split("\n").find((l) => l.trim()) ?? "";

/** Escape closes a dialog wherever focus is, before the app's own Escape handling sees it. */
function useEscape(f: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      f();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
}

function openOfficial(e: { preventDefault: () => void }) {
  e.preventDefault();
  void openUrl(OFFICIAL_LIBRARY);
}

type Draft = { name: string | null; title: string; description: string; tags: string; body: string };

export function PromptLibrary({ onInsert, onClose, onManage, toast }: { onInsert: (p: Prompt) => void; onClose: () => void; onManage: () => void; toast: (m: string) => void }) {
  const [all, setAll] = useState<Prompt[] | null>(null);
  const [q, setQ] = useState("");
  const [coll, setColl] = useState<string | null>(null);
  const [favOnly, setFavOnly] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = () => api.promptsList().then(setAll, (e) => toast(String(e)));
  useEffect(() => {
    void load();
    input.current?.focus();
    const un = listen("prompts-changed", () => void load());
    return () => void un.then((f) => f());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).map((w) => w.replace(/^#/, "")).filter(Boolean);
    return (all ?? [])
      .filter((p) => (!coll || p.collection === coll) && (!favOnly || p.favorite))
      .map((p, i) => ({ p, i, s: words.length ? score(p, words) : 1 }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || +b.p.favorite - +a.p.favorite || a.i - b.i)
      .map((r) => r.p);
  }, [all, q, coll, favOnly]);
  const sel = rows.find((p) => p.id === selId) ?? rows[0] ?? null;
  const colls = [...new Map((all ?? []).map((p) => [p.collection, p.collection_name])).entries()];

  const move = (d: number) => {
    const i = sel ? rows.indexOf(sel) : -1;
    const next = rows[Math.min(Math.max(i + d, 0), rows.length - 1)];
    if (next) {
      setSelId(next.id);
      document.querySelector(`[data-prompt-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  };
  const toggleFav = async (p: Prompt) => {
    setAll((xs) => xs?.map((x) => (x.id === p.id ? { ...x, favorite: !p.favorite } : x)) ?? null);
    await api.promptFavorite(p.id, !p.favorite).catch((e) => toast(String(e)));
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      const p = await api.promptSave(editing.name, { title: editing.title, description: editing.description, tags: editing.tags.split(",").map((t) => t.trim()).filter(Boolean), body: editing.body });
      await load();
      stopEditing();
      setQ("");
      setColl(null);
      setFavOnly(false);
      setSelId(p.id);
      toast(editing.name ? "Prompt saved" : "Added to My prompts");
    } catch (err) {
      toast(String(err));
    }
  };
  const remove = async (p: Prompt) => {
    if (!confirm(`Delete “${p.title}” from My prompts?`)) return;
    try {
      await api.promptDelete(p.name);
      setSelId(null);
      await load();
      input.current?.focus();
      toast("Prompt deleted");
    } catch (err) {
      toast(String(err));
    }
  };
  const edit = (d: Partial<Draft>) => setEditing((x) => (x ? { ...x, ...d } : x));
  const stopEditing = () => {
    setEditing(null);
    requestAnimationFrame(() => input.current?.focus());
  };
  useEscape(() => (editing ? stopEditing() : onClose()));

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette library" role="dialog" aria-modal="true" aria-labelledby="library-title">
        <div className="library-head">
          <h2 id="library-title">Prompt library</h2>
          <span className="spacer" />
          <button className="btn" onClick={() => setEditing({ name: null, title: "", description: "", tags: "", body: "" })}><Plus size={15} /> New prompt</button>
          <button className="icon-btn" onClick={onClose} aria-label="Close prompt library" title="Close (Esc)"><X size={17} /></button>
        </div>
        <div className="palette-input">
          <Search size={16} className="muted" />
          <input
            ref={input}
            value={q}
            placeholder="Search by title, description or #tag"
            aria-label="Search prompts"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(e.key === "ArrowDown" ? 1 : -1); }
              else if (e.key === "Enter" && sel && !editing) { e.preventDefault(); onInsert(sel); }
            }}
          />
        </div>
        <div className="library-filters" role="group" aria-label="Filter prompts">
          <button aria-pressed={!coll && !favOnly} onClick={() => { setColl(null); setFavOnly(false); }}>All</button>
          <button aria-pressed={favOnly} onClick={() => setFavOnly((f) => !f)}><Star size={12} /> Favorites</button>
          {colls.length > 1 && colls.map(([id, name]) => (
            <button key={id} aria-pressed={coll === id} onClick={() => setColl(coll === id ? null : id)}>{name}</button>
          ))}
        </div>
        <div className="library-body">
          <div className="library-list">
            {rows.length > 0 && (
              <div role="listbox" aria-label="Prompts">
                {rows.map((p) => (
                  <button key={p.id} role="option" aria-selected={sel?.id === p.id} className="library-row" data-prompt-id={p.id} data-prompt={p.name} onClick={() => setSelId(p.id)} onDoubleClick={() => onInsert(p)}>
                    <span className="title">{p.favorite && <><Star size={12} className="fav" /><span className="sr-only">Favorite: </span></>}{p.title}</span>
                    <span className="sub">{p.collection_name} · {p.description || firstLine(p.body)}</span>
                  </button>
                ))}
              </div>
            )}
            {all && !rows.length && (
              <div className="muted library-empty">
                {all.length ? "No prompts match." : "No prompts yet. Write one with New prompt, or install a collection."}
              </div>
            )}
          </div>
          <div className="library-preview">
            {editing ? (
              <form className="library-edit" onSubmit={(e) => void save(e)} aria-labelledby="edit-title">
                <h3 id="edit-title">{editing.name ? "Edit prompt" : "New prompt"}</h3>
                <div className="field"><label htmlFor="pe-title">Title</label><input id="pe-title" autoFocus value={editing.title} onChange={(e) => edit({ title: e.target.value })} /></div>
                <div className="field"><label htmlFor="pe-desc">Description</label><input id="pe-desc" value={editing.description} onChange={(e) => edit({ description: e.target.value })} /></div>
                <div className="field">
                  <label htmlFor="pe-tags">Tags</label>
                  <input id="pe-tags" value={editing.tags} placeholder="writing, review" onChange={(e) => edit({ tags: e.target.value })} />
                  <span className="help">Separate tags with commas.</span>
                </div>
                <div className="field">
                  <label htmlFor="pe-body">Prompt</label>
                  <textarea id="pe-body" rows={8} value={editing.body} onChange={(e) => edit({ body: e.target.value })} />
                  <span className="help">Write <span className="mono">$ARGUMENTS</span> or <span className="mono">{"{{name}}"}</span> where a value goes; you fill it in when you insert the prompt.</span>
                </div>
                <div className="library-actions">
                  <button className="btn primary" type="submit" disabled={!editing.title.trim() || !editing.body.trim()}>Save</button>
                  <button className="btn" type="button" onClick={stopEditing}>Cancel</button>
                </div>
              </form>
            ) : sel ? (
              <>
                <div className="library-preview-head">
                  <h3>{sel.title}</h3>
                  <button className={`icon-btn ${sel.favorite ? "on" : ""}`} aria-pressed={sel.favorite} aria-label="Favorite" title={sel.favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => void toggleFav(sel)}>
                    <Star size={17} fill={sel.favorite ? "currentColor" : "none"} />
                  </button>
                </div>
                <div className="muted">{sel.collection_name} · <span className="mono">/{sel.name}</span>{sel.arg_hint && <span className="mono"> {sel.arg_hint}</span>}</div>
                {sel.description && <p className="library-desc">{sel.description}</p>}
                {sel.tags.length > 0 && (
                  <div className="library-tags">
                    {sel.tags.map((t) => <button key={t} className="tag" title={`Show prompts tagged ${t}`} onClick={() => setQ(`#${t}`)}>#{t}</button>)}
                  </div>
                )}
                <pre className="library-text">{sel.body}</pre>
                <div className="library-actions">
                  <button className="btn primary" onClick={() => onInsert(sel)}>Insert</button>
                  <button className="btn" onClick={async () => { await copyText(sel.body); toast("Copied to the clipboard"); }}><Copy size={14} /> Copy</button>
                  {sel.editable && (
                    <>
                      <button className="btn" onClick={() => setEditing({ name: sel.name, title: sel.title, description: sel.description, tags: sel.tags.join(", "), body: sel.body })}><Pencil size={14} /> Edit</button>
                      <button className="btn danger" onClick={() => void remove(sel)}><Trash2 size={14} /> Delete</button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="muted">Pick a prompt to preview it.</div>
            )}
          </div>
        </div>
        <div className="library-foot muted">
          <span>More ideas: Anthropic's <a className="text-link" href={OFFICIAL_LIBRARY} onClick={openOfficial}>Claude Code prompt library</a> (opens in your browser).</span>
          <span className="spacer" />
          <button className="btn" onClick={onManage}>Manage collections</button>
        </div>
      </div>
    </div>
  );
}

/** Asks for the values a prompt's placeholders need, then hands back the filled text. */
export function FillPrompt({ prompt, onDone, onCancel }: { prompt: Prompt; onDone: (text: string) => void; onCancel: () => void }) {
  const vars = placeholders(prompt.body);
  const [values, setValues] = useState<Record<string, string>>({});
  useEscape(onCancel);
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="palette sheet fill-dialog" role="dialog" aria-modal="true" aria-labelledby="fill-title">
        <form onSubmit={(e) => { e.preventDefault(); onDone(fillPrompt(prompt.body, values)); }}>
          <h2 id="fill-title">{prompt.title}</h2>
          <p className="muted">Fill in the values this prompt asks for. An empty value keeps its placeholder.</p>
          {vars.map((v, i) => (
            <div className="field" key={v.key}>
              <label htmlFor={`fill-${i}`}>{v.label}</label>
              <input id={`fill-${i}`} autoFocus={i === 0} value={values[v.key] ?? ""} placeholder={v.key === "$ARGUMENTS" ? prompt.arg_hint ?? "" : ""} onChange={(e) => setValues((x) => ({ ...x, [v.key]: e.target.value }))} />
            </div>
          ))}
          <pre className="library-text fill-preview">{fillPrompt(prompt.body, values)}</pre>
          <div className="library-actions">
            <button className="btn primary" type="submit">Insert</button>
            <button className="btn" type="button" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function sourceOf(c: PromptCollection) {
  if (c.id === "mine") return "Written in the app";
  if (c.source.kind === "local") return `${c.source.origin || "Local folder"} (read in place)`;
  const gh = /^https:\/\/github\.com\//.test(c.source.url);
  const repo = c.source.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  return `${gh ? "GitHub " : ""}${repo}${c.source.subdir ? ` / ${c.source.subdir}` : ""}`;
}

/** Settings → Prompt library: install, update, roll back and remove collections. */
export function PromptCollectionsTab({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<PromptCollection[] | null>(null);
  const [spec, setSpec] = useState("");
  const [offer, setOffer] = useState<PluginOffer | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => void api.promptCollections().then(setList);
  useEffect(() => {
    load();
    const un = listen("prompts-changed", load);
    return () => void un.then((f) => f());
  }, []);
  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    try { await f(); } catch (e) { setErr(String(e)); } finally { setBusy(null); load(); }
  };
  const find = () => run("inspect", async () => {
    const o = await api.promptsInspect(spec.trim());
    const ok = o.items.filter((i) => i.source);
    setOffer(o);
    setPicked(ok.length === 1 ? [ok[0].name] : []);
  });
  return (
    <>
      <p className="muted">
        Reusable prompts for the message box: open the library with the book button, or type <span className="mono">/</span> and a prompt's name. A collection is a folder of
        markdown prompts (optional front matter: <span className="mono">title</span>, <span className="mono">description</span>, <span className="mono">tags</span>) or a Claude plugin's
        {" "}<span className="mono">commands/</span>. Collections from GitHub update automatically within 15 minutes of a new commit.
      </p>
      <div className="field">
        <label htmlFor="prompt-spec">Install a collection</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="prompt-spec" style={{ flex: 1 }} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="owner/repo, a GitHub folder URL, or a git URL" onKeyDown={(e) => { if (e.key === "Enter" && spec.trim()) void find(); }} />
          <button className="btn" disabled={!spec.trim() || !!busy} onClick={() => void find()}>{busy === "inspect" ? "Looking…" : "Find prompts"}</button>
        </div>
        <span className="help">
          For ideas, browse Anthropic's <a className="text-link" href={OFFICIAL_LIBRARY} onClick={openOfficial}>Claude Code prompt library</a> (opens in your browser). Nothing is added
          until you install a collection you choose.
        </span>
      </div>
      {offer && (
        <div className="card">
          <div className="card-head"><span className="name">{offer.marketplace ?? offer.repo}</span><span className="badge">{offer.items.length} collection{offer.items.length === 1 ? "" : "s"}</span></div>
          <div style={{ maxHeight: 280, overflow: "auto", margin: "6px 0" }}>
            {offer.items.map((it) => (
              <label key={it.name} className="offer-row">
                <input type="checkbox" disabled={!it.source} checked={picked.includes(it.name)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, it.name] : p.filter((n) => n !== it.name)))} />
                <span><strong>{it.name}</strong>{it.description && <span className="muted"> · {it.description}</span>}{it.note && <span className="help"> ({it.note})</span>}</span>
              </label>
            ))}
          </div>
          <div className="muted" style={{ margin: "8px 0" }}>Prompt collections are text only: installing one never runs code.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" disabled={!picked.length || !!busy} onClick={() => void run("install", async () => {
              const n = await api.promptsInstall(spec.trim(), picked);
              toast(`Installed ${n.join(", ")}`);
              setOffer(null);
            })}>{busy === "install" ? "Installing…" : `Install${picked.length > 1 ? ` ${picked.length}` : ""}`}</button>
            <button className="btn" onClick={() => setOffer(null)}>Cancel</button>
          </div>
        </div>
      )}
      {err && <div className="error-box" style={{ marginTop: 10 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "18px 0 6px" }}>
        <h2 className="section-h" style={{ margin: 0, flex: 1 }}>Collections{list ? ` (${list.length})` : ""}</h2>
        <button className="btn" disabled={!!busy} onClick={() => void run("updates", async () => {
          const n = await api.promptsUpdateAll();
          toast(n.length ? `Updated ${n.join(", ")}` : "All collections are up to date");
        })}>{busy === "updates" ? "Checking…" : "Check for updates"}</button>
      </div>
      {list?.map((c) => (
        <div className="card" key={c.id} data-collection={c.id}>
          <div className="card-head">
            <span className="name">{c.name}</span>
            <span className="badge">{c.prompts} prompt{c.prompts === 1 ? "" : "s"}</span>
            {c.version && <span className="badge">v{c.version}</span>}
            {!c.enabled && <span className="badge">off</span>}
          </div>
          {c.description && <div className="muted" style={{ margin: "6px 0" }}>{c.description}</div>}
          <div className="plugin-meta">
            <span className="collection-source">{sourceOf(c)}</span>
            {c.repo_dir && <span>updated {ago(c.updated_at)} · checked {c.checked_at ? ago(c.checked_at) : "never"}{c.sha ? ` · ${c.sha.slice(0, 7)}` : ""}</span>}
          </div>
          {c.error && <div className="error-box" style={{ marginTop: 6 }}>{c.error}</div>}
          <div className="plugin-switches">
            {c.id !== "mine" && <label><input type="checkbox" checked={c.enabled} onChange={(e) => void run(`set:${c.id}`, () => api.promptCollectionSet(c.id, { enabled: e.target.checked }))} /> Enabled</label>}
            {c.repo_dir && <label><input type="checkbox" checked={c.auto_update} onChange={(e) => void run(`set:${c.id}`, () => api.promptCollectionSet(c.id, { autoUpdate: e.target.checked }))} /> Update automatically</label>}
          </div>
          {c.id !== "mine" && (
            <div className="plugin-actions">
              {c.repo_dir && <button className="btn" disabled={!!busy} onClick={() => void run(`update:${c.id}`, async () => {
                const r = await api.promptCollectionUpdate(c.id);
                toast(r == null ? `${c.name} is up to date` : `Updated ${c.name}`);
              })}>{busy === `update:${c.id}` ? "Updating…" : "Update now"}</button>}
              {c.prev_sha && <button className="btn" disabled={!!busy} onClick={() => void run(`rb:${c.id}`, async () => { await api.promptCollectionRollback(c.id); toast(`${c.name} rolled back and pinned`); })}>Roll back</button>}
              <button className="btn" disabled={!!busy} onClick={() => void run(`rm:${c.id}`, async () => { await api.promptCollectionRemove(c.id); toast(`Removed ${c.name}`); })}>Remove</button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
