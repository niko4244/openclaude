// Small shared helpers for the Evolution Engine core. No dependencies: the
// engine has to run in a bare GitHub Actions runner and inside the desktop
// app's dev checkout without an install step.
import { createHash } from "node:crypto";
import { renameSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const shortHash = (s, n = 12) => sha256(s).slice(0, n);

/** Collapse whitespace, trim, drop trailing punctuation noise. */
export function normalizeText(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim()
    // Trailing separators vary between runs of the same release note ("— url").
    .replace(/[\s,;:.\-–—]+$/u, "");
}

/** Stable comparison key: casefolded, punctuation-insensitive text. */
export function textKey(s) {
  return normalizeText(s)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Atomic JSON write: a crash mid-write must never truncate the ledger. Writes
 * to a sibling temp file and renames over the target (same volume, atomic on
 * Windows for an existing target).
 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function readJsonStrict(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export const iso = (d = new Date()) => new Date(d).toISOString();

export function daysAgo(isoDate, now = Date.now()) {
  const t = Date.parse(isoDate);
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deterministic sort so registry diffs are reviewable. */
export function byKey(key) {
  return (a, b) => {
    const av = typeof key === "function" ? key(a) : a[key];
    const bv = typeof key === "function" ? key(b) : b[key];
    return av < bv ? -1 : av > bv ? 1 : 0;
  };
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Bounded, human-readable error text; never include response bodies (untrusted). */
export function errText(err) {
  if (!err) return "unknown error";
  const msg = err.name === "AbortError" ? "timed out" : String(err.message || err);
  return msg.slice(0, 300);
}
