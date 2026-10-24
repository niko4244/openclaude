// Engine configuration. The defaults are the recommended operating defaults:
// check every six hours, repository workflow plus the desktop app, and
// research-only autonomy (no code is written without an explicit opt-in).
import { existsSync } from "node:fs";
import { paths } from "./paths.mjs";
import { readJson, writeJsonAtomic } from "./util.mjs";

export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  /** Master switch for both monitoring modes. */
  enabled: true,
  /** How often the repository workflow and the desktop ticker run. */
  intervalHours: 6,
  monitoring: {
    /** .github/workflows/claude-feature-watch.yml */
    repositoryWorkflow: true,
    /** background ticker while the desktop app is open */
    desktopApp: true,
  },
  /** research | implement | prepare-pr — see pipeline.mjs. */
  autonomy: "research",
  budget: {
    paidCallsAllowed: false,
    maxModelCallsPerRun: 0,
    maxRunMinutes: 15,
    maxInvestigationsPerRun: 3,
    maxImplementationsPerRun: 1,
  },
  limits: {
    requestTimeoutMs: 20_000,
    retries: 2,
    retryDelayMs: 1_500,
    maxItemsPerSource: 200,
    /** A lock older than this is stale and may be taken over. */
    lockStaleMinutes: 20,
  },
  rea: {
    enabled: true,
    /** The setup command is never run automatically; the operator opts in. */
    setupAuthorized: false,
    command: "rea",
    setupCommand: "npx rea-agents@latest setup",
  },
  engineering: {
    /** Created outside the checkout so a generated branch can never land in it. */
    worktreeRoot: "../oc-evolution",
    /** Gates are allowlisted by name; nothing else is executed. */
    gates: [
      { name: "engine-tests", command: "node", args: ["--test", "desktop/feature-intel/tests/"], timeoutMs: 180_000 },
      { name: "desktop-typecheck", command: "npx", args: ["tsc", "-b"], cwd: "desktop", timeoutMs: 300_000 },
    ],
    maxGateMinutes: 12,
  },
};

function merge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== "object" || base === null) return override ?? base;
  if (typeof override !== "object" || override === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function loadConfig(dir = paths().intel) {
  const p = paths(dir).config;
  const raw = existsSync(p) ? readJson(p, {}) : {};
  return merge(structuredClone(DEFAULT_CONFIG), raw);
}

export function saveConfig(patch, dir = paths().intel) {
  const next = merge(loadConfig(dir), patch ?? {});
  next.version = CONFIG_VERSION;
  writeJsonAtomic(paths(dir).config, next);
  return next;
}

/** Interval in ms, floored so a bad value cannot turn into a hot loop. */
export function intervalMs(config) {
  const hours = Number(config?.intervalHours);
  return Math.max(1, Number.isFinite(hours) ? hours : DEFAULT_CONFIG.intervalHours) * 3_600_000;
}
