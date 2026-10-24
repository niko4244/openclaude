// One monitoring sweep: fetch every source, fold the results into the
// registry, and write a human-readable report. Failure of a source is never
// allowed to damage registry state.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";
import { acquireLock, releaseLock } from "./lock.mjs";
import { paths } from "./paths.mjs";
import { loadRegistry, markMissing, recordSignal, saveRegistry, paritySummary, sourceHealth } from "./registry.mjs";
import { fetchSource } from "./sources.mjs";
import { errText, iso, readJson, shortHash, writeJsonAtomic } from "./util.mjs";

const RUN_HISTORY = 20;

function readSources(dir) {
  const p = paths(dir).sources;
  const raw = readJson(p, null);
  if (!raw || !Array.isArray(raw.sources)) throw new Error(`cannot read sources at ${p}`);
  return raw.sources;
}

function stateFile(dir, id) {
  return join(paths(dir).stateDir, `${id}.json`);
}

export async function runCheck(options = {}) {
  const dir = options.dir ?? paths().intel;
  const config = options.config ?? loadConfig(dir);
  const now = options.now ?? iso();
  const dryRun = Boolean(options.dryRun);
  const log = options.logger ?? (() => {});
  const startedAt = now;
  const p = paths(dir);

  if (config.enabled === false && !options.force) {
    return { status: "disabled", startedAt, finishedAt: iso(), sources: [], added: 0, changed: 0, features: 0 };
  }

  const lock = options.skipLock ? { acquired: true } : acquireLock(dir, config.limits.lockStaleMinutes);
  if (!lock.acquired) {
    log(`another sweep is running (pid ${lock.holder?.pid ?? "unknown"}); skipping`);
    return { status: "locked", startedAt, finishedAt: iso(), sources: [], added: 0, changed: 0, features: 0 };
  }

  try {
    const sources = readSources(dir);
    let registry;
    try {
      registry = loadRegistry(dir);
    } catch (err) {
      // A corrupt registry is a hard stop: better no sweep than a reset ledger.
      return { status: "registry-error", startedAt, finishedAt: iso(), error: errText(err), sources: [], added: 0, changed: 0, features: 0 };
    }
    const results = [];
    let added = 0;
    let changed = 0;

    for (const src of sources) {
      const statePath = stateFile(dir, src.id);
      const prev = readJson(statePath, null) ?? {};
      let outcome;
      try {
        outcome = await fetchSource(src, prev, {
          timeoutMs: config.limits.requestTimeoutMs,
          retries: config.limits.retries,
          retryDelayMs: config.limits.retryDelayMs,
          maxItems: config.limits.maxItemsPerSource,
          fetchImpl: options.fetchImpl,
        });
      } catch (err) {
        const message = errText(err);
        registry.sources[src.id] = {
          ...(registry.sources[src.id] ?? {}),
          checkedAt: iso(),
          status: "failed",
          error: message,
          itemCount: Array.isArray(prev.items) ? prev.items.length : 0,
        };
        results.push({ id: src.id, title: src.title, status: "failed", error: message, added: 0, removed: 0 });
        log(`${src.id}: failed - ${message}`);
        continue;
      }

      if (outcome.status === "not-modified") {
        registry.sources[src.id] = { ...(registry.sources[src.id] ?? {}), checkedAt: iso(), status: "ok", error: null };
        results.push({ id: src.id, title: src.title, status: "unchanged", added: 0, removed: 0 });
        log(`${src.id}: not modified`);
        continue;
      }

      const seen = new Set();
      let srcAdded = 0;
      let srcChanged = 0;
      for (const item of outcome.items) {
        const r = recordSignal(registry, src.id, item, now);
        seen.add(r.signal.id);
        if (r.created) srcAdded += 1;
        else if (r.updated) srcChanged += 1;
      }
      const removed = markMissing(registry, src.id, seen, now);
      added += srcAdded;
      changed += srcChanged;

      registry.sources[src.id] = {
        checkedAt: iso(),
        status: outcome.status === "unavailable" ? "unavailable" : "ok",
        error: null,
        note: outcome.note ?? null,
        etag: outcome.etag ?? null,
        lastModified: outcome.lastModified ?? null,
        itemCount: outcome.items.length,
        digest: shortHash(outcome.items.map((i) => i.key).join("\n"), 16),
      };
      results.push({ id: src.id, title: src.title, status: outcome.status, note: outcome.note ?? null, added: srcAdded, changed: srcChanged, removed, items: outcome.items.length });
      log(`${src.id}: ${outcome.items.length} item(s), +${srcAdded}, ~${srcChanged}, -${removed}`);

      if (!dryRun) {
        writeJsonAtomic(statePath, {
          checked: iso(),
          digest: registry.sources[src.id].digest,
          etag: outcome.etag ?? null,
          lastModified: outcome.lastModified ?? null,
          items: outcome.items.map((i) => i.title),
          keys: outcome.items.map((i) => i.key),
        });
      }
    }

    const failed = results.filter((r) => r.status === "failed").length;
    const status = failed === 0 ? "ok" : failed === results.length ? "failed" : "degraded";
    const finishedAt = iso();
    registry.lastCheck = {
      startedAt,
      finishedAt,
      status,
      added,
      changed,
      sources: results.length,
      failed,
      lockStale: Boolean(lock.stale),
    };
    registry.runs = [...(registry.runs ?? []), { at: finishedAt, status, added, changed, failed }].slice(-RUN_HISTORY);

    const report = renderReport(registry, results, { now, dryRun });
    if (!dryRun) {
      saveRegistry(registry, dir);
      mkdirSync(p.reports, { recursive: true });
      const day = now.slice(0, 10);
      writeFileSync(join(p.reports, `${day}.md`), report.markdown, "utf8");
      writeFileSync(join(p.reports, `issues-${day}.json`), `${JSON.stringify(report.issues, null, 2)}\n`, "utf8");
      writeFileSync(join(p.reports, "latest.md"), report.markdown, "utf8");
    }

    return {
      status,
      startedAt,
      finishedAt,
      added,
      changed,
      sources: results,
      issues: report.issues,
      markdown: report.markdown,
      summary: paritySummary(registry),
      health: sourceHealth(registry),
    };
  } finally {
    if (!options.skipLock) releaseLock(dir);
  }
}

/**
 * The report is evidence for a human or agent, not an instruction source.
 * New items are quoted, never interpreted.
 */
export function renderReport(registry, results, { now = iso(), dryRun = false } = {}) {
  const day = now.slice(0, 10);
  const out = [`# Feature intelligence report — ${day}`, ""];
  out.push("Automated. Every item needs triage before any implementation. Text from sources is quoted as data.", "");
  if (dryRun) out.push("_Dry run: registry and snapshots were not written._", "");

  const newSignals = registry.signals.filter((s) => s.status === "new" && !s.featureId);
  out.push("## Summary", "");
  out.push(`- sources checked: ${results.length} (${results.filter((r) => r.status === "failed").length} failed)`);
  out.push(`- untriaged signals: ${newSignals.length}`);
  out.push(`- canonical features: ${registry.features.length}`);
  out.push(`- parity: ${JSON.stringify(paritySummary(registry))}`);
  out.push("");

  const issues = [];
  for (const r of results) {
    out.push(`## ${r.title ?? r.id}`, "");
    out.push(`- source: \`${r.id}\``);
    out.push(`- status: ${r.status}`);
    if (r.error) out.push(`- error: ${r.error}`);
    if (r.note) out.push(`- note: ${r.note}`);
    if (typeof r.items === "number") out.push(`- items: ${r.items} (+${r.added ?? 0} new, ${r.removed ?? 0} missing)`);
    out.push("");
  }

  if (newSignals.length) {
    out.push("## Untriaged signals", "");
    for (const s of newSignals.slice(0, 60)) {
      out.push(`- \`${s.id}\` — ${s.title}${s.url ? ` (${s.url})` : ""}`);
    }
    if (newSignals.length > 60) out.push(`- … ${newSignals.length - 60} more`);
    out.push("");
    issues.push({
      title: `[feature-intel] ${newSignals.length} untriaged signal(s) on ${day}`,
      labels: ["feature-intel"],
      body: [
        `Detected by the Evolution Engine on ${day}.`,
        "",
        "Untriaged signals (quoted source text):",
        ...newSignals.slice(0, 40).map((s) => `- \`${s.id}\` ${s.title}`),
        "",
        "Triage:",
        "- [ ] Does this affect desktop-visible behavior?",
        "- [ ] Compare with OpenClaude (docs/parity/FEATURE_MATRIX.md)",
        "- [ ] Classify with `node desktop/feature-intel/cli.mjs classify <signal> --name \"…\"`",
        "- [ ] If missing: investigate, write a spec, implement in a worktree, open a PR",
      ].join("\n"),
    });
  }

  const byStatus = {};
  for (const f of registry.features) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
  if (Object.keys(byStatus).length) {
    out.push("## Features by status", "", ...Object.entries(byStatus).sort().map(([k, v]) => `- ${k}: ${v}`), "");
  }

  out.push("---", `${registry.lastCheck?.added ?? 0} new signal(s); ${issues.length} draft issue(s) (not posted).`);
  return { markdown: out.join("\n"), issues };
}

/** Read-only view used by the CLI and the desktop dashboard. */
export function statusView(dir = paths().intel) {
  const registry = loadRegistry(dir);
  const config = loadConfig(dir);
  const ledger = readJson(paths(dir).ledger, { tasks: [] });
  return {
    enabled: config.enabled,
    intervalHours: config.intervalHours,
    autonomy: config.autonomy,
    lastCheck: registry.lastCheck,
    summary: paritySummary(registry),
    sources: sourceHealth(registry),
    features: [...registry.features]
      .sort((a, b) => (a.status === "announced" ? 1 : 0) - (b.status === "announced" ? 1 : 0))
      .slice(0, 100),
    tasks: (ledger.tasks ?? []).slice(-50),
    signals: registry.signals.filter((s) => s.status === "new" && !s.featureId).length,
  };
}
