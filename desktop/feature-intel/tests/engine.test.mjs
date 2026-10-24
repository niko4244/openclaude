import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "../lib/engine.mjs";
import { loadRegistry, saveRegistry, emptyRegistry } from "../lib/registry.mjs";
import { acquireLock, releaseLock } from "../lib/lock.mjs";
import { paths } from "../lib/paths.mjs";
import { makeRepo, githubSource, release, response, queueFetch } from "./helpers.mjs";

const config = (over = {}) => ({
  enabled: true,
  intervalHours: 6,
  autonomy: "research",
  budget: { paidCallsAllowed: false, maxImplementationsPerRun: 1 },
  limits: { requestTimeoutMs: 500, retries: 0, retryDelayMs: 0, maxItemsPerSource: 50, lockStaleMinutes: 20 },
  rea: { enabled: true },
  engineering: { gates: [], worktreeRoot: "../oc-evolution" },
  ...over,
});

test("a new announcement produces exactly one canonical record", async () => {
  const { dir } = makeRepo([githubSource()]);
  const fetchImpl = queueFetch(response([release("v1.0.0", "Cowork arrives")]));

  const r = await runCheck({ dir, config: config(), fetchImpl, skipLock: true });

  assert.equal(r.status, "ok");
  assert.equal(r.added, 1);
  const registry = loadRegistry(dir);
  assert.equal(registry.signals.length, 1);
  assert.equal(registry.signals[0].title.includes("Cowork arrives"), true);
  assert.equal(registry.signals[0].revision, 1);
  assert.equal(registry.sources.releases.status, "ok");
});

test("an unchanged announcement produces no duplicate work", async () => {
  const { dir } = makeRepo([githubSource()]);
  const fetchImpl = queueFetch(response([release("v1.0.0", "Cowork arrives")]));
  await runCheck({ dir, config: config(), fetchImpl, skipLock: true });

  const second = await runCheck({ dir, config: config(), fetchImpl, skipLock: true });

  assert.equal(second.added, 0);
  const registry = loadRegistry(dir);
  assert.equal(registry.signals.length, 1);
  assert.equal(registry.signals[0].revision, 1);
});

test("a modified announcement revises the existing record", async () => {
  const { dir } = makeRepo([githubSource()]);
  const fetchImpl = queueFetch(
    response([release("v1.0.0", "Cowork arrives")]),
    response([release("v1.0.0", "Cowork arrives everywhere")]),
  );
  await runCheck({ dir, config: config(), fetchImpl, skipLock: true });
  const r = await runCheck({ dir, config: config(), fetchImpl, skipLock: true });

  const registry = loadRegistry(dir);
  assert.equal(registry.signals.length, 1, "still one record");
  assert.equal(registry.signals[0].revision, 2);
  assert.match(registry.signals[0].title, /everywhere/);
  assert.equal(r.added, 0);
  assert.equal(r.changed, 1);
});

test("a disappearing item is marked, never deleted", async () => {
  const { dir } = makeRepo([githubSource()]);
  const fetchImpl = queueFetch(response([release("v1.0.0", "A"), release("v1.1.0", "B")]), response([]));
  await runCheck({ dir, config: config(), fetchImpl, skipLock: true });
  await runCheck({ dir, config: config(), fetchImpl, skipLock: true });

  const registry = loadRegistry(dir);
  assert.equal(registry.signals.length, 2);
  assert.equal(registry.signals.every((s) => s.missingSince), true);
  assert.equal(registry.signals.every((s) => s.status === "missing"), true);
});

test("a failing source leaves registry state intact and degrades the run", async () => {
  const { dir } = makeRepo([githubSource()]);
  const ok = queueFetch(response([release("v1.0.0", "A")]));
  await runCheck({ dir, config: config(), fetchImpl: ok, skipLock: true });

  const bad = async () => response({ message: "boom" }, { status: 500 });
  const r = await runCheck({ dir, config: config(), fetchImpl: bad, skipLock: true });

  assert.equal(r.status, "failed");
  const registry = loadRegistry(dir);
  assert.equal(registry.signals.length, 1, "previous evidence kept");
  assert.equal(registry.signals[0].title.includes("A"), true);
  assert.equal(registry.sources.releases.status, "failed");
  assert.match(registry.sources.releases.error, /HTTP 500/);
});

test("a 304 keeps the previous snapshot and records no new signal", async () => {
  const { dir } = makeRepo([githubSource()]);
  const fetchImpl = queueFetch(response([release("v1.0.0", "A")]), response(null, { status: 304 }));
  await runCheck({ dir, config: config(), fetchImpl, skipLock: true });
  const r = await runCheck({ dir, config: config(), fetchImpl, skipLock: true });

  assert.equal(r.sources[0].status, "unchanged");
  assert.equal(loadRegistry(dir).signals.length, 1);
});

test("a corrupt registry stops the sweep instead of resetting it", async () => {
  const { dir } = makeRepo([githubSource()]);
  const file = join(dir, "registry.json");
  const original = "{ this is not json";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, original, "utf8");

  const r = await runCheck({ dir, config: config(), fetchImpl: queueFetch(response([])), skipLock: true });

  assert.equal(r.status, "registry-error");
  assert.equal(readFileSync(file, "utf8"), original);
});

test("a held lock blocks a concurrent sweep; a stale lock is taken over", async () => {
  const { dir } = makeRepo([githubSource()]);
  const held = acquireLock(dir, 20);
  assert.equal(held.acquired, true);

  const r = await runCheck({ dir, config: config(), fetchImpl: queueFetch(response([])) });
  assert.equal(r.status, "locked");
  releaseLock(dir);

  // Age the lock past the threshold.
  const file = paths(dir).lock;
  const again = acquireLock(dir, 20);
  assert.equal(again.acquired, true);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(file, old, old);

  const r2 = await runCheck({ dir, config: config(), fetchImpl: queueFetch(response([])) });
  assert.notEqual(r2.status, "locked");
  assert.equal(existsSync(file), false, "released after the run");
});

test("a dry run writes neither registry nor snapshots", async () => {
  const { dir } = makeRepo([githubSource()]);
  saveRegistry(emptyRegistry(), dir);
  const before = readFileSync(join(dir, "registry.json"), "utf8");

  const r = await runCheck({ dir, config: config(), fetchImpl: queueFetch(response([release("v9", "New")])), dryRun: true, skipLock: true });

  assert.equal(r.added, 1);
  assert.equal(readFileSync(join(dir, "registry.json"), "utf8"), before);
  assert.equal(existsSync(join(dir, "state", "releases.json")), false);
});

test("the first run records a baseline and the next run adds nothing", async () => {
  const { dir } = makeRepo([githubSource()], {
    legacy: { releases: { checked: "2026-10-23T00:00:00.000Z", digest: "abc", items: ["v0.9.0: Older release"] } },
  });
  const fetchImpl = queueFetch(response([release("v1.1.0", "New release")]));

  const first = await runCheck({ dir, config: config(), fetchImpl, skipLock: true });
  assert.equal(first.added, 1, "the old snapshot is not re-imported under a different key");

  const second = await runCheck({ dir, config: config(), fetchImpl, skipLock: true });
  assert.equal(second.added, 0);
  assert.equal(loadRegistry(dir).signals.length, 1);
});

test("one sweep writes one report and one draft issue set", async () => {
  const { dir } = makeRepo([githubSource()]);
  const r = await runCheck({
    dir,
    config: config(),
    fetchImpl: queueFetch(response([release("v1.0.0", "Cowork arrives")])),
    skipLock: true,
    now: "2026-10-24T12:00:00.000Z",
  });

  const report = join(paths(dir).reports, "2026-10-24.md");
  assert.equal(existsSync(report), true);
  assert.match(readFileSync(report, "utf8"), /Untriaged signals/);
  assert.equal(r.issues.length, 1);
  assert.ok(statSync(report).size > 0);
});
