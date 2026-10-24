import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { investigate, probeRea, reaSetupRequest } from "../lib/rea.mjs";
import { emptyRegistry, recordSignal, classifySignal } from "../lib/registry.mjs";
import { makeRepo } from "./helpers.mjs";

const now = "2026-10-24T00:00:00.000Z";

function featureFixture() {
  const r = emptyRegistry(now);
  const { signal } = recordSignal(r, "s", { key: "x", title: "Cowork", url: "https://example.test/cowork" }, now);
  const { feature } = classifySignal(r, signal.id, { name: "Cowork" }, now);
  return feature;
}

const spawnUnavailable = () => ({ error: Object.assign(new Error("not found"), { code: "ENOENT" }), status: null, stdout: "" });
const spawnAvailable = () => ({ status: 0, stdout: "rea 1.4.0\n", stderr: "" });

test("a missing REA is reported unavailable, not silently ignored", () => {
  const p = probeRea({ command: "rea" }, { spawnSync: spawnUnavailable });
  assert.equal(p.available, false);
  assert.match(p.reason, /ENOENT/);
  assert.equal(typeof p.setupCommand === "string" || p.setupCommand === undefined, true);
});

test("an investigation without REA is blocked, never marked done", () => {
  const { dir, root } = makeRepo([]);
  const feature = featureFixture();
  const r = investigate(feature, { config: { rea: { enabled: true } }, dir, now, probeFn: (c) => probeRea(c, { spawnSync: spawnUnavailable }) });

  assert.equal(r.status, "blocked");
  assert.match(r.blockedReason, /REA unavailable/);
  const plan = readFileSync(join(root, r.planPath), "utf8");
  assert.match(plan, /\*\*blocked\*\*|blocked/);
  assert.match(plan, /Observation/);
});

test("an available REA produces a ready plan with boundaries", () => {
  const { dir, root } = makeRepo([]);
  const feature = featureFixture();
  const r = investigate(feature, { config: { rea: { enabled: true } }, dir, now, probeFn: (c) => probeRea(c, { spawnSync: spawnAvailable }) });

  assert.equal(r.status, "ready");
  assert.equal(existsSync(join(root, r.planPath)), true);
  const plan = readFileSync(join(root, r.planPath), "utf8");
  assert.match(plan, /No copying proprietary source/);
  assert.match(plan, /Acceptance tests/);
});

test("the setup command needs explicit authorization and is never run here", () => {
  const denied = reaSetupRequest({ enabled: true, setupAuthorized: false, setupCommand: "npx rea-agents@latest setup" }, {});
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /explicit approval/);

  const allowed = reaSetupRequest({ enabled: true, setupAuthorized: true, setupCommand: "npx rea-agents@latest setup" }, { setupAuthorized: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.setupCommand, "npx rea-agents@latest setup");
});
