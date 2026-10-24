import { useCallback, useEffect, useState } from "react";
import { CircleDot, Pause, Play, RefreshCw, Sparkles } from "lucide-react";
import { api, type EvolutionStatus } from "../api";

const INTERVALS = [1, 6, 12, 24];
const AUTONOMY = [
  { id: "research", label: "Research only", hint: "Discover, classify, investigate, write specs. No code is written." },
  { id: "implement", label: "Prepare native work", hint: "Also plan an isolated worktree and a ledger task for an agent or human." },
  { id: "prepare-pr", label: "Prepare pull requests", hint: "Also draft the PR. Nothing is committed, pushed, or merged." },
];

function ago(iso?: string | null) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

export function EvolutionPage({ toast }: { toast: (m: string) => void }) {
  const [status, setStatus] = useState<EvolutionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.evolutionStatus());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const checkNow = async () => {
    setBusy(true);
    try {
      const r = await api.evolutionCheck();
      toast(`Checked official sources: +${r.added} new, ~${r.changed} changed (${r.status}).`);
      await load();
    } catch (e) {
      toast(`Check failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const configure = async (patch: { enabled?: boolean; intervalHours?: number; autonomy?: string }) => {
    try {
      setStatus(await api.evolutionConfigure(patch));
      toast("Evolution settings saved");
    } catch (e) {
      toast(`Could not save: ${e}`);
    }
  };

  const s = status?.summary;
  const nextDue = status?.last_check?.at
    ? Date.parse(status.last_check.at) + status.interval_hours * 3_600_000
    : null;
  const nextText = nextDue == null
    ? null
    : nextDue <= Date.now()
      ? "a sweep is due"
      : `next in about ${Math.max(1, Math.round((nextDue - Date.now()) / 3_600_000))} h`;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <h1>Evolution</h1>
          <span className="spacer" />
          <button className="btn" onClick={() => void load()} aria-label="Refresh status">
            <RefreshCw size={15} /> Refresh
          </button>
          <button className="btn primary" onClick={() => void checkNow()} disabled={busy || !status?.can_check}>
            {busy ? <CircleDot size={15} /> : <Sparkles size={15} />} {busy ? "Checking…" : "Check for Claude updates"}
          </button>
        </div>

        {error && (
          <div className="banner" role="alert">
            Could not read the feature registry: {error}
          </div>
        )}

        {!status ? (
          <div className="muted">Loading the feature registry…</div>
        ) : !status.available ? (
          <div className="card">
            <div className="card-head">
              <span className="name">No feature registry on this machine</span>
              <span className="badge">not synced</span>
            </div>
            <p className="muted">{status.reason}</p>
            <p className="muted">
              The repository workflow (<code>claude-feature-watch.yml</code>) keeps the registry current and opens a
              pull request with each change. This page reads the same ledger; it does not invent one.
            </p>
          </div>
        ) : (
          <>
            <div className="card">
              <div className="card-head">
                <span className="name">{status.enabled ? "Watching Claude's release surface" : "Monitoring paused"}</span>
                <span className="badge">{status.can_check ? (status.enabled ? "every " + status.interval_hours + " h" : "paused") : "read-only"}</span>
                <span className="spacer" />
                {status.can_check && (
                  <button className="btn" onClick={() => void configure({ enabled: !status.enabled })}>
                    {status.enabled ? <Pause size={14} /> : <Play size={14} />} {status.enabled ? "Pause" : "Resume"}
                  </button>
                )}
              </div>
              <p className="muted">
                Last check {ago(status.last_check?.at)}
                {status.last_check?.status ? ` (${status.last_check.status})` : ""}
                {nextText ? ` · ${nextText}` : ""}
                {" · "}autonomy: {status.autonomy}
              </p>
              {!status.can_check && status.check_reason && <p className="muted">{status.check_reason}</p>}
              {status.can_check && status.enabled && (
                <p className="muted">
                  The desktop check runs only while the app is open. The six-hour workflow continues without it.
                </p>
              )}
              {status.can_check && (
                <>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
                    <label className="muted" htmlFor="evo-interval">Check frequency</label>
                    <select
                      id="evo-interval"
                      className="btn"
                      value={status.interval_hours}
                      onChange={(e) => void configure({ intervalHours: Number(e.target.value) })}
                    >
                      {INTERVALS.map((h) => <option key={h} value={h}>{h === 1 ? "Every hour" : h === 24 ? "Once a day" : `Every ${h} hours`}</option>)}
                    </select>
                    <label className="muted" htmlFor="evo-autonomy">Engineering autonomy</label>
                    <select
                      id="evo-autonomy"
                      className="btn"
                      value={status.autonomy}
                      onChange={(e) => void configure({ autonomy: e.target.value })}
                    >
                      {AUTONOMY.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                  </div>
                  <p className="muted">{AUTONOMY.find((a) => a.id === status.autonomy)?.hint}</p>
                </>
              )}
            </div>

            <div className="grid">
              <div className="card">
                <div className="muted">Untriaged signals</div>
                <div style={{ fontSize: 26 }}>{s?.untriaged ?? 0}</div>
                <div className="muted">of {s?.signals ?? 0} recorded</div>
              </div>
              <div className="card">
                <div className="muted">Parity coverage</div>
                <div style={{ fontSize: 26 }}>{s?.coverage_percent == null ? "—" : `${s.coverage_percent}%`}</div>
                <div className="muted">{s?.equivalent ?? 0} equivalent · {s?.partial ?? 0} partial · {s?.missing ?? 0} missing</div>
              </div>
              <div className="card">
                <div className="muted">Native work</div>
                <div style={{ fontSize: 26 }}>{s?.implemented ?? 0}</div>
                <div className="muted">{status.tasks.length} task(s) in the ledger · {s?.blocked ?? 0} blocked</div>
              </div>
              <div className="card">
                <div className="muted">Last sweep</div>
                <div style={{ fontSize: 26 }}>{status.last_check?.added ?? 0}</div>
                <div className="muted">new · {status.last_check?.changed ?? 0} revised · {status.last_check?.failed ?? 0} source(s) failed</div>
              </div>
            </div>

            <div className="section-label">Sources</div>
            {status.sources.length === 0 && <div className="muted">No source has been checked yet.</div>}
            {status.sources.map((src) => (
              <div key={src.id} className="list-row" data-source={src.id}>
                <span className="list-title">
                  {src.id} <span className={`badge ${src.status === "ok" ? "local" : ""}`}>{src.status}</span>
                </span>
                <span className="muted">
                  {src.items == null ? "no items" : `${src.items} item(s)`} · {ago(src.last_checked)}
                  {src.error ? ` · ${src.error}` : ""}
                </span>
              </div>
            ))}

            <div className="section-label">Features</div>
            {status.features.length === 0 && (
              <div className="muted">
                No feature has been classified yet. New signals are listed in <code>docs/feature-intel/reports/latest.md</code>;
                classify the relevant ones with <code>node desktop/feature-intel/cli.mjs classify &lt;signal-id&gt;</code>.
              </div>
            )}
            {status.features.map((f) => (
              <div key={f.id} className="card" data-feature={f.id}>
                <div className="card-head">
                  <span className="name">{f.name}</span>
                  <span className="badge">{f.status}</span>
                  <span className={`badge ${f.parity === "equivalent" ? "local" : f.parity === "missing" ? "" : "cap"}`}>{f.parity}</span>
                  {f.percent != null && <span className="badge">{f.percent}%</span>}
                  <span className="spacer" />
                  <span className="muted">{f.product}</span>
                </div>
                {f.summary && <p className="muted">{f.summary}</p>}
                {f.blockers.length > 0 && <p className="muted">Blocked: {f.blockers.join("; ")}</p>}
                {f.source_urls.length > 0 && <p className="muted">{f.source_urls[0]}</p>}
              </div>
            ))}

            <div className="section-label">Implementation ledger</div>
            {status.tasks.length === 0 && <div className="muted">No native work has been planned.</div>}
            {status.tasks.map((t) => (
              <div key={t.id} className="list-row" data-task={t.id}>
                <span className="list-title">{t.title} <span className="badge">{t.status}</span></span>
                <span className="muted">{t.branch ?? "no branch"}{t.pr_draft ? ` · ${t.pr_draft}` : ""}</span>
              </div>
            ))}

            <p className="muted" style={{ marginTop: 18 }}>
              Read-only view of <code>{status.registry_path}</code>. Nothing here is merged, installed, or deployed
              automatically; a change becomes a pull request that a person reviews.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
