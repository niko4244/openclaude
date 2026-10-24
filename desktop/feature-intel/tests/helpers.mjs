// Test fixtures: a throwaway repository layout, a fake HTTP layer, and
// deterministic clocks. No test touches the network or the real registry.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeRepo(sources = [], { legacy = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oc-evo-"));
  const dir = join(root, "desktop", "feature-intel");
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "sources.json"), JSON.stringify({ sources }, null, 2), "utf8");
  for (const [id, state] of Object.entries(legacy)) {
    writeFileSync(join(dir, "state", `${id}.json`), JSON.stringify(state, null, 2), "utf8");
  }
  return { root, dir };
}

export function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

export function githubSource(overrides = {}) {
  return { id: "releases", title: "Claude releases", kind: "github_releases", repo: "anthropics/claude-code", category: "claude-desktop", ...overrides };
}

export function release(tag, name, published = "2026-10-01T00:00:00Z") {
  return { tag_name: tag, name, html_url: `https://example.test/${tag}`, published_at: published, id: tag };
}

/** fetch stub returning a queue of responses (last one repeats). */
export function queueFetch(...entries) {
  let i = 0;
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const entry = entries[Math.min(i, entries.length - 1)];
    i += 1;
    if (typeof entry === "function") return entry(url);
    if (entry instanceof Error) throw entry;
    return entry;
  };
  fn.calls = calls;
  return fn;
}

export const failingFetch = (status = 500) => async () => response({ message: "boom" }, { status });
