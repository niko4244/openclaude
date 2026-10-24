// Where the Evolution Engine reads and writes. Everything is derived from the
// module location so the CLI, the tests and the desktop app agree, and can be
// redirected with OPENCLAUDE_EVOLUTION_DIR (tests, packaged builds).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const libDir = dirname(fileURLToPath(import.meta.url));

/** `desktop/feature-intel` */
export const INTEL_DIR = normalize(resolve(process.env.OPENCLAUDE_EVOLUTION_DIR || join(libDir, "..")));
/** repository root */
export const REPO_ROOT = normalize(resolve(process.env.OPENCLAUDE_EVOLUTION_ROOT || join(INTEL_DIR, "..", "..")));

function normalize(p) {
  return p.replace(/\\/g, "/").replace(/\/$/, "");
}

export function paths(dir = INTEL_DIR) {
  const repo = dir === INTEL_DIR ? REPO_ROOT : resolve(dir, "..", "..").replace(/\\/g, "/");
  return {
    intel: dir,
    repo,
    config: join(dir, "config.json"),
    registry: join(dir, "registry.json"),
    ledger: join(dir, "ledger.json"),
    sources: join(dir, "sources.json"),
    lock: join(dir, "state", ".engine.lock"),
    stateDir: join(dir, "state"),
    docs: join(repo, "docs", "feature-intel"),
    reports: join(repo, "docs", "feature-intel", "reports"),
    specs: join(repo, "docs", "feature-intel", "specs"),
    investigations: join(repo, "docs", "feature-intel", "investigations"),
  };
}

export function rel(p, base = REPO_ROOT) {
  const a = String(p).replace(/\\/g, "/");
  return a.startsWith(`${base}/`) ? a.slice(base.length + 1) : a;
}

/** true when `child` is the same path as, or inside, `parent`. */
export function isInside(child, parent) {
  const c = resolve(child).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const p = resolve(parent).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return c === p || c.startsWith(`${p}/`);
}
