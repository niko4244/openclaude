import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyRegistry, recordSignal, classifySignal, updateFeature, validateRegistry,
  paritySummary, featureIdFor, markMissing,
} from "../lib/registry.mjs";

const now = "2026-10-24T00:00:00.000Z";

test("signal ids are deterministic per source and key", () => {
  const a = emptyRegistry(now);
  const b = emptyRegistry(now);
  recordSignal(a, "src", { key: "v1", title: "One thing" }, now);
  recordSignal(b, "src", { key: "v1", title: "One thing" }, now);
  assert.equal(a.signals[0].id, b.signals[0].id);
});

test("the same item from different sources stays distinguishable", () => {
  const r = emptyRegistry(now);
  recordSignal(r, "src-a", { key: "v1", title: "One thing" }, now);
  recordSignal(r, "src-b", { key: "v1", title: "One thing" }, now);
  assert.equal(r.signals.length, 2);
});

test("classifying is idempotent", () => {
  const r = emptyRegistry(now);
  const { signal } = recordSignal(r, "src", { key: "v1", title: "Cowork arrives" }, now);
  const first = classifySignal(r, signal.id, { name: "Cowork", product: "claude-desktop" }, now);
  const second = classifySignal(r, signal.id, {}, now);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(r.features.length, 1);
  assert.equal(first.feature.id, second.feature.id);
  assert.equal(signal.featureId, first.feature.id);
});

test("feature ids stay unique when names collide", () => {
  const existing = [{ id: "feat_cowork" }, { id: "feat_cowork-2" }];
  assert.equal(featureIdFor("Cowork", existing), "feat_cowork-3");
});

test("names are never upgraded to parity by similarity", () => {
  const r = emptyRegistry(now);
  const { signal } = recordSignal(r, "src", { key: "v1", title: "Artifacts" }, now);
  const { feature } = classifySignal(r, signal.id, {}, now);
  assert.equal(feature.parity.status, "unknown");
  assert.equal(feature.status, "announced");
});

test("updateFeature rejects unknown fields and invalid states", () => {
  const r = emptyRegistry(now);
  const { signal } = recordSignal(r, "src", { key: "v1", title: "X" }, now);
  const { feature } = classifySignal(r, signal.id, {}, now);

  assert.throws(() => updateFeature(r, feature.id, { madeUp: true }), /cannot set/);
  assert.throws(() => updateFeature(r, feature.id, { status: "done" }), /invalid feature status/);
  updateFeature(r, feature.id, { parity: { status: "partial", percent: 40 } }, now);
  assert.equal(feature.parity.percent, 40);
});

test("coverage counts partial as half and ignores non-replicable", () => {
  const r = emptyRegistry(now);
  const make = (name, status) => {
    const { signal } = recordSignal(r, "s", { key: name, title: name }, now);
    const { feature } = classifySignal(r, signal.id, { name }, now);
    updateFeature(r, feature.id, { parity: { status } }, now);
  };
  make("A", "equivalent");
  make("B", "partial");
  make("C", "missing");
  make("D", "not-replicable");

  const s = paritySummary(r);
  assert.equal(s.total, 4);
  assert.equal(s.notReplicable, 1);
  assert.equal(s.coveragePercent, Math.round((1 + 0.5) / 3 * 100));
});

test("marked-missing signals keep their evidence", () => {
  const r = emptyRegistry(now);
  recordSignal(r, "s", { key: "a", title: "A" }, now);
  markMissing(r, "s", new Set(), now);
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].status, "missing");
});

test("validateRegistry flags a signal pointing at a missing feature", () => {
  const r = emptyRegistry(now);
  recordSignal(r, "s", { key: "a", title: "A" }, now);
  r.signals[0].featureId = "feat_gone";
  assert.match(validateRegistry(r).join("\n"), /points at missing/);
});
