import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyRegistry, recordSignal, classifySignal, updateFeature } from "../lib/registry.mjs";
import {
  BudgetError, PipelineRefusal, assertIsolatedWorktree, guardInference, planImplementation,
  loadLedger, resumeTask, runGates, writePrDraft, resolveWorktree, specMarkdown,
} from "../lib/pipeline.mjs";
import { paths } from "../lib/paths.mjs";
import { makeRepo } from "./helpers.mjs";

const now = "2026-10-24T00:00:00.000Z";
const config = (over = {}) => ({
  autonomy: "implement",
  budget: { paidCallsAllowed: false, maxImplementationsPerRun: 1 },
  engineering: {
    worktreeRoot: "../oc-evolution",
    gates: [{ name: "only-gate", command: "node", args: ["--version"], timeoutMs: 5_000 }],
    maxGateMinutes: 1,
  },
  ...over,
});

function featureFixture(name = "Branching") {
  const registry = emptyRegistry(now);
  const { signal } = recordSignal(registry, "s", { key: name, title: name, url: "https://example.test/x" }, now);
  const { feature } = classifySignal(registry, signal.id, { name }, now);
  updateFeature(registry, feature.id, { parity: { status: "missing", percent: 0 } }, now);
  return feature;
}

test("research cannot spend on a paid model", () => {
  assert.throws(() => guardInference({ paid: true, provider: "anthropic" }, config()), BudgetError);
  assert.deepEqual(guardInference({ paid: false }, config()), { allowed: true, paid: false, provider: "none", model: null });
  assert.equal(guardInference({ paid: true }, config({ budget: { paidCallsAllowed: true, maxCostUsdPerRun: 5 } })).paid, true);
});

test("research-only autonomy refuses to plan native work", () => {
  const { dir, root } = makeRepo([]);
  const feature = featureFixture();
  assert.throws(
    () => planImplementation({ feature, config: config({ autonomy: "research" }), dir, repoRoot: root }),
    (err) => err instanceof PipelineRefusal && err.code === "AUTONOMY",
  );
});

test("the production checkout is never a worktree", () => {
  const repo = "C:/work/openclaude";
  assert.throws(() => assertIsolatedWorktree(repo, repo), PipelineRefusal);
  assert.throws(() => assertIsolatedWorktree(`${repo}/desktop/x`, repo), PipelineRefusal);
  const wt = resolveWorktree(config(), "feat_x", "C:/work/openclaude").replace(/\\/g, "/");
  assert.equal(wt, "C:/work/oc-evolution/feat_x");
});

test("planning creates one ledger task, a spec and an isolated branch", () => {
  const { dir, root } = makeRepo([]);
  const feature = featureFixture();

  const first = planImplementation({ feature, config: config(), dir, repoRoot: root, now });
  assert.equal(first.created, true);
  assert.equal(first.task.status, "queued");
  assert.equal(first.task.branch, "evolution/branching");
  assert.equal(first.task.worktree.startsWith(root), false);
  assert.equal(existsSync(join(root, first.specPath)), true);

  const second = planImplementation({ feature, config: config(), dir, repoRoot: root, now });
  assert.equal(second.created, false);
  assert.equal(loadLedger(dir).tasks.length, 1);
});

test("a zero implementation budget refuses to plan", () => {
  const { dir, root } = makeRepo([]);
  const feature = featureFixture();
  assert.throws(
    () => planImplementation({ feature, config: config({ budget: { paidCallsAllowed: false, maxImplementationsPerRun: 0 } }), dir, repoRoot: root }),
    BudgetError,
  );
});

test("a failed task resumes without losing its checkpoints", () => {
  const { dir, root } = makeRepo([]);
  const feature = featureFixture();
  const { task } = planImplementation({ feature, config: config(), dir, repoRoot: root, now });

  const ledger = loadLedger(dir);
  ledger.tasks[0].status = "failed";
  const resumed = resumeTask(ledger, task.id, { dir });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.attempts, 1);
  assert.ok(resumed.checkpoints.length >= 2);
});

test("gates are the configured allowlist only", () => {
  const gates = runGates({ task: null, config: config(), repoRoot: "/tmp/x", execute: false });
  assert.deepEqual(gates.map((g) => g.name), ["only-gate"]);
  assert.equal(gates[0].status, "planned");
});

test("the PR draft carries evidence, validation and limitations", () => {
  const { dir, root } = makeRepo([]);
  const feature = featureFixture();
  const { task } = planImplementation({ feature, config: config(), dir, repoRoot: root, now });
  const draft = writePrDraft(task, feature, [{ name: "only-gate", status: "passed", ms: 12 }], dir);

  const body = readFileSync(join(root, draft.path), "utf8");
  assert.match(body, /https:\/\/example\.test\/x/);
  assert.match(body, /only-gate: passed/);
  assert.match(body, /Not committed, pushed, merged, or deployed/);
  assert.match(body, /Known limitations/);
});

test("the spec states model independence and acceptance tests", () => {
  const md = specMarkdown(featureFixture());
  assert.match(md, /LiteLLM/);
  assert.match(md, /Acceptance tests/);
  assert.match(md, /not-replicable/);
});
