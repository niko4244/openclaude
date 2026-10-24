// The feature registry: the durable, reviewable record shared by the
// repository workflow, the CLI and the desktop dashboard.
//
// Two layers, deliberately separate:
//   signals  - what a monitored source said, verbatim, with provenance.
//   features - what a human or agent decided it means, plus parity and work.
//
// A signal is never upgraded to "available" or "implemented" by name matching.
// Only an explicit classify/set call moves a feature's state.
import { existsSync } from "node:fs";
import { readJson, shortHash, textKey, normalizeText, byKey, iso, writeJsonAtomic } from "./util.mjs";
import { paths } from "./paths.mjs";

export const SCHEMA_VERSION = 1;

export const FEATURE_STATUSES = [
  "announced", // seen in a source, not yet examined
  "investigating", // an investigation was started
  "specified", // behaviour contract written
  "implementing", // native work queued or in progress
  "validating", // implementation exists, gates running
  "implemented", // native code exists and its tests pass
  "tested", // validated end to end (E2E or live evidence)
  "released", // shipped in a release
  "blocked", // cannot proceed (access, infra, decision)
  "deferred", // deliberately not pursued
  "not-applicable", // nothing to reproduce
];

export const PARITY_STATUSES = ["unknown", "missing", "partial", "equivalent", "not-replicable"];
export const SIGNAL_STATUSES = ["new", "classified", "ignored", "missing"];

const PRODUCTS = ["claude-desktop", "claude-code", "claude-web", "cowork", "mcp", "other"];

export function emptyRegistry(now = iso()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    lastCheck: null,
    sources: {},
    signals: [],
    features: [],
  };
}

export function loadRegistry(dir = paths().intel) {
  const p = paths(dir).registry;
  if (!existsSync(p)) return emptyRegistry();
  const raw = readJson(p, null);
  if (!raw) throw new Error(`registry at ${p} is not valid JSON; refusing to overwrite it`);
  return migrate(raw);
}

/** Schema migrations are additive and versioned. Unknown future versions stop. */
export function migrate(raw) {
  if (!raw || typeof raw !== "object") throw new Error("registry is not an object");
  const v = Number(raw.schemaVersion ?? 0);
  if (v > SCHEMA_VERSION) throw new Error(`registry schema ${v} is newer than this engine (${SCHEMA_VERSION})`);
  let r = raw;
  if (v < 1) {
    // First schemaless snapshot: adopt the current shape without inventing data.
    r = { ...emptyRegistry(), ...r, schemaVersion: 1 };
  }
  r.signals = Array.isArray(r.signals) ? r.signals : [];
  r.features = Array.isArray(r.features) ? r.features : [];
  r.sources = r.sources && typeof r.sources === "object" ? r.sources : {};
  return r;
}

export function saveRegistry(registry, dir = paths().intel) {
  const p = paths(dir).registry;
  const next = {
    ...registry,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: iso(),
    signals: [...registry.signals].sort(byKey("id")),
    features: [...registry.features].sort(byKey("id")),
  };
  // writeJsonAtomic keeps a crash from truncating the ledger.
  writeJsonAtomic(p, next);
  return next;
}

export function signalIdFor(sourceId, key) {
  return `sig_${shortHash(`${sourceId}\u0000${key}`)}`;
}

export function featureIdFor(name, existing = []) {
  const base = `feat_${textKey(name).replace(/\s+/g, "-").slice(0, 60) || "unnamed"}`;
  if (!existing.some((f) => f.id === base)) return base;
  for (let i = 2; i < 1000; i++) if (!existing.some((f) => f.id === `${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${shortHash(String(Date.now()))}`;
}

/**
 * Insert or update the signal for one source item.
 * Same (source, key) + same text => touch only. Changed text => revise.
 */
export function recordSignal(registry, sourceId, item, now = iso()) {
  const key = normalizeText(item.key ?? item.title);
  const id = signalIdFor(sourceId, key);
  const title = normalizeText(item.title);
  const digest = shortHash(`${title}\u0000${item.url ?? ""}`, 16);
  const existing = registry.signals.find((s) => s.id === id);
  if (!existing) {
    const signal = {
      id,
      sourceId,
      key,
      title,
      url: item.url ?? null,
      publishedAt: item.publishedAt ?? null,
      firstSeen: now,
      lastSeen: now,
      digest,
      revision: 1,
      status: "new",
      featureId: null,
      missingSince: null,
    };
    registry.signals.push(signal);
    return { signal, created: true, updated: false };
  }
  existing.lastSeen = now;
  existing.missingSince = null;
  if (existing.digest !== digest) {
    existing.title = title;
    existing.url = item.url ?? existing.url ?? null;
    existing.publishedAt = item.publishedAt ?? existing.publishedAt ?? null;
    existing.digest = digest;
    existing.revision += 1;
    return { signal: existing, created: false, updated: true };
  }
  return { signal: existing, created: false, updated: false };
}

/** Items that disappeared from a source are marked, never deleted. */
export function markMissing(registry, sourceId, seenIds, now = iso()) {
  let marked = 0;
  for (const s of registry.signals) {
    if (s.sourceId !== sourceId) continue;
    if (seenIds.has(s.id)) continue;
    if (s.status === "classified" || s.status === "ignored") continue;
    if (!s.missingSince) {
      s.missingSince = now;
      s.status = "missing";
      marked += 1;
    }
  }
  return marked;
}

/**
 * Promote a signal to a feature. Idempotent: classifying an already-classified
 * signal returns the existing feature instead of creating a duplicate.
 */
export function classifySignal(registry, signalId, patch = {}, now = iso()) {
  const signal = registry.signals.find((s) => s.id === signalId);
  if (!signal) throw new Error(`unknown signal ${signalId}`);
  if (signal.featureId) {
    const existing = registry.features.find((f) => f.id === signal.featureId);
    if (existing) return { feature: existing, created: false };
  }
  const name = normalizeText(patch.name || signal.title).slice(0, 160);
  const feature = createFeature(registry, {
    name,
    summary: patch.summary ?? signal.title,
    product: PRODUCTS.includes(patch.product) ? patch.product : "claude-desktop",
    category: patch.category ?? "uncategorised",
    platforms: patch.platforms ?? ["windows", "macos"],
    releaseDate: patch.releaseDate ?? signal.publishedAt ?? null,
    sourceUrls: [signal.url].filter(Boolean),
    signalIds: [signal.id],
    parity: patch.parity,
    now,
  });
  signal.featureId = feature.id;
  signal.status = "classified";
  return { feature, created: true };
}

export function createFeature(registry, input, now = iso()) {
  const existing = registry.features.find(
    (f) => textKey(f.name) === textKey(input.name) && f.product === input.product,
  );
  if (existing) {
    existing.signalIds = [...new Set([...(existing.signalIds ?? []), ...(input.signalIds ?? [])])];
    existing.sourceUrls = [...new Set([...(existing.sourceUrls ?? []), ...(input.sourceUrls ?? [])])];
    existing.lastChecked = now;
    return existing;
  }
  const feature = {
    id: featureIdFor(input.name, registry.features),
    name: normalizeText(input.name),
    summary: normalizeText(input.summary ?? ""),
    product: input.product ?? "claude-desktop",
    category: input.category ?? "uncategorised",
    platforms: input.platforms ?? [],
    status: "announced",
    releaseDate: input.releaseDate ?? null,
    sourceUrls: input.sourceUrls ?? [],
    signalIds: input.signalIds ?? [],
    parity: {
      status: input.parity?.status ?? "unknown",
      percent: input.parity?.percent ?? null,
      openclaudeFeature: input.parity?.openclaudeFeature ?? null,
      notes: input.parity?.notes ?? "",
      evidence: input.parity?.evidence ?? [],
    },
    feasibility: input.feasibility ?? "unknown",
    complexity: input.complexity ?? "M",
    permissions: input.permissions ?? [],
    modelCapabilities: input.modelCapabilities ?? [],
    requiredIntegrations: input.requiredIntegrations ?? [],
    investigation: { status: "not-started", planPath: null, specPath: null, blockedReason: null, evidence: [] },
    implementation: { status: "not-started", branch: null, worktree: null, commits: [], prUrl: null, prDraft: null },
    tests: [],
    blockers: [],
    notes: "",
    createdAt: now,
    updatedAt: now,
    lastChecked: now,
  };
  registry.features.push(feature);
  return feature;
}

const ALLOWED_PATCH = new Set([
  "summary", "category", "platforms", "status", "releaseDate", "feasibility", "complexity",
  "permissions", "modelCapabilities", "requiredIntegrations", "notes", "blockers",
]);

export function updateFeature(registry, id, patch, now = iso()) {
  const f = registry.features.find((x) => x.id === id);
  if (!f) throw new Error(`unknown feature ${id}`);
  // Validate a candidate first: a rejected patch must not corrupt the record.
  const next = { ...f };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (ALLOWED_PATCH.has(k)) next[k] = v;
    else if (k === "parity") next.parity = { ...f.parity, ...v };
    else if (k === "investigation") next.investigation = { ...f.investigation, ...v };
    else if (k === "implementation") next.implementation = { ...f.implementation, ...v };
    else if (k === "status" || k === "name") next[k] = v;
    else throw new Error(`cannot set feature field "${k}"`);
  }
  if (!FEATURE_STATUSES.includes(next.status)) throw new Error(`invalid feature status ${next.status}`);
  if (!PARITY_STATUSES.includes(next.parity.status)) throw new Error(`invalid parity status ${next.parity.status}`);
  Object.assign(f, next);
  f.updatedAt = now;
  return f;
}

export function validateRegistry(registry) {
  const problems = [];
  if (registry.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion ${registry.schemaVersion}`);
  const signalIds = new Set();
  for (const s of registry.signals) {
    if (signalIds.has(s.id)) problems.push(`duplicate signal ${s.id}`);
    signalIds.add(s.id);
    if (!SIGNAL_STATUSES.includes(s.status)) problems.push(`signal ${s.id} status ${s.status}`);
  }
  const featureIds = new Set();
  for (const f of registry.features) {
    if (featureIds.has(f.id)) problems.push(`duplicate feature ${f.id}`);
    featureIds.add(f.id);
    if (!FEATURE_STATUSES.includes(f.status)) problems.push(`feature ${f.id} status ${f.status}`);
    if (!PARITY_STATUSES.includes(f.parity.status)) problems.push(`feature ${f.id} parity ${f.parity.status}`);
  }
  for (const s of registry.signals) {
    if (s.featureId && !featureIds.has(s.featureId)) problems.push(`signal ${s.id} points at missing ${s.featureId}`);
  }
  return problems;
}

/** Deterministic counts used by the dashboard and the parity report. */
export function paritySummary(registry) {
  const considered = registry.features.filter((f) => f.parity.status !== "not-replicable");
  const count = (s) => considered.filter((f) => f.parity.status === s).length;
  const equivalent = count("equivalent");
  const partial = count("partial");
  const missing = count("missing");
  const known = equivalent + partial + missing;
  return {
    total: registry.features.length,
    signals: registry.signals.length,
    unclassified: registry.signals.filter((s) => !s.featureId && s.status === "new").length,
    equivalent,
    partial,
    missing,
    unknown: considered.filter((f) => f.parity.status === "unknown").length,
    notReplicable: registry.features.length - considered.length,
    blocked: registry.features.filter((f) => f.status === "blocked").length,
    implemented: registry.features.filter((f) => ["implemented", "tested", "released"].includes(f.status)).length,
    coveragePercent: known === 0 ? null : Math.round(((equivalent + partial * 0.5) / known) * 100),
  };
}

export function sourceHealth(registry) {
  return Object.entries(registry.sources)
    .map(([id, s]) => ({
      id,
      status: s.status ?? "unknown",
      lastChecked: s.checkedAt ?? null,
      error: s.error ?? null,
      items: s.itemCount ?? null,
    }))
    .sort(byKey("id"));
}
