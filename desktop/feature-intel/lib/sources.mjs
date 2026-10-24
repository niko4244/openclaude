// Source adapters. Each one returns structured items with a stable key, so a
// re-run of an unchanged source produces no new records, and an edited entry
// revises its existing record instead of creating a second one.
//
// Everything fetched here is untrusted data. It is stored and rendered as
// text; it is never executed and never fed to a model as instructions.
import { existsSync, readdirSync } from "node:fs";
import { sleep, shortHash } from "./util.mjs";

const UA = "openclaude-evolution-engine (+https://github.com/GitLawb/openclaude)";

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|li|h[1-6]|div|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 2)
    .join("\n");
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function retryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 30_000) : null;
}

/**
 * One GET with the caller's conditional headers. `get` is the only way an
 * extractor touches the network, so tests inject their own.
 */
function makeGet(fetchImpl, conditional) {
  return async (url, { signal, headers = {} } = {}) => {
    const r = await fetchImpl(url, {
      signal,
      redirect: "follow",
      headers: { "User-Agent": UA, ...conditional, ...headers },
    });
    if (r.status === 304) {
      const e = new Error("HTTP 304");
      e.status = 304;
      throw e;
    }
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      err.retryable = r.status === 429 || r.status >= 500;
      err.retryAfterMs = retryAfter(r.headers.get("retry-after"));
      throw err;
    }
    return r;
  };
}

/** Each extractor returns { items: [{key, title, url, publishedAt}] }. */
const extractors = {
  async github_releases(src, { get, signal }) {
    const perPage = Math.min(src.limit ?? 15, 50);
    const r = await get(`https://api.github.com/repos/${src.repo}/releases?per_page=${perPage}`, {
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    const body = await r.json();
    if (!Array.isArray(body)) throw new Error("GitHub returned an unexpected payload");
    const items = body
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        key: String(x.tag_name ?? x.id ?? ""),
        title: `${x.tag_name ?? ""}${x.name ? `: ${String(x.name).slice(0, 160)}` : ""}`,
        url: typeof x.html_url === "string" ? x.html_url : null,
        publishedAt: x.published_at ?? null,
      }))
      .filter((x) => x.key);
    return { items };
  },

  async npm_latest(src, { get, signal }) {
    const r = await get(`https://registry.npmjs.org/${src.package}/latest`, { signal });
    const j = await r.json();
    if (!j?.version) throw new Error("npm returned no version");
    return {
      items: [{
        key: String(j.version),
        title: `${src.package}@${j.version}`,
        url: `https://www.npmjs.com/package/${src.package}`,
        publishedAt: null,
      }],
    };
  },

  async page_lines(src, { get, signal }) {
    const r = await get(src.url, { signal });
    const text = htmlToText(await r.text());
    const re = src.match ? new RegExp(src.match, "i") : null;
    const seen = new Set();
    const items = [];
    for (const line of text.split("\n")) {
      if (re && !re.test(line)) continue;
      const key = shortHash(line, 16);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ key, title: line, url: src.url, publishedAt: null });
    }
    return { items };
  },

  async local_claude_versions(src) {
    const base = String(src.path).replace("%LOCALAPPDATA%", process.env.LOCALAPPDATA || "");
    if (!existsSync(base)) return { items: [], note: "Claude Desktop is not installed on this machine" };
    const items = readdirSync(base)
      .filter((d) => /^app-\d/.test(d))
      .sort()
      .map((d) => ({ key: d, title: d, url: null, publishedAt: null }));
    return { items };
  },
};

export const SOURCE_KINDS = Object.keys(extractors);

/**
 * Fetch one source with a conditional request, timeout and bounded retries.
 * A 304 is a success with no items: "unchanged", not "empty".
 */
export async function fetchSource(src, prev = {}, options = {}) {
  const {
    timeoutMs = 20_000,
    retries = 2,
    retryDelayMs = 1_500,
    fetchImpl = globalThis.fetch,
    maxItems = 200,
  } = options;
  const extract = extractors[src.kind];
  if (!extract) throw new Error(`unknown source kind "${src.kind}"`);

  const conditional = {};
  if (prev.etag) conditional["If-None-Match"] = prev.etag;
  if (prev.lastModified) conditional["If-Modified-Since"] = prev.lastModified;
  const get = makeGet(fetchImpl, conditional);

  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await extract(src, { get, signal: controller.signal });
      const items = (res.items ?? []).slice(0, maxItems);
      return {
        status: res.note ? "unavailable" : "ok",
        items,
        etag: prev.etag ?? null,
        lastModified: prev.lastModified ?? null,
        note: res.note ?? null,
      };
    } catch (err) {
      if (err?.name === "AbortError") err.message = `timed out after ${timeoutMs} ms`;
      if (err?.status === 304) {
        return { status: "not-modified", items: [], etag: prev.etag ?? null, lastModified: prev.lastModified ?? null };
      }
      if (attempt >= retries || !err.retryable) throw err;
      await sleep(err.retryAfterMs ?? retryDelayMs * (attempt + 1));
      attempt += 1;
    } finally {
      clearTimeout(timer);
    }
  }
}
