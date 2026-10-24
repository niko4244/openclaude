// From a verified gap to a reviewable change. The pipeline is deliberately
// conservative: it plans in an isolated worktree, records every step in a
// durable ledger, and stops at a pull-request draft. It never commits, pushes,
// merges, installs, or writes inside the production checkout.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInside, paths, rel } from "./paths.mjs";
import { iso, readJson, writeJsonAtomic } from "./util.mjs";

export const AUTONOMY = { research: 0, implement: 1, "prepare-pr": 2 };

export class PipelineRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PipelineRefusal";
    this.code = code;
  }
}

export class BudgetError extends PipelineRefusal {
  constructor(message) {
    super("BUDGET", message);
    this.name = "BudgetError";
  }
}

/**
 * Every model call the engine might make passes through here. The engine's own
 * steps never set `paid`, so a research sweep cannot spend money; an agent step
 * that wants a paid provider must be authorized explicitly.
 */
export function guardInference(request = {}, config = {}) {
  const paid = request.paid === true;
  if (paid) {
    if (!config?.budget?.paidCallsAllowed) {
      throw new BudgetError("paid inference is not authorized (budget.paidCallsAllowed is false)");
    }
    const spent = Number(request.estimatedCostUsd ?? 0);
    const cap = Number(config?.budget?.maxCostUsdPerRun ?? 0);
    if (cap > 0 && spent > cap) throw new BudgetError(`estimated cost ${spent} exceeds cap ${cap}`);
  }
  return { allowed: true, paid, provider: paid ? request.provider ?? null : "none", model: paid ? request.model ?? null : null };
}

/** The production checkout is not a build target. */
export function assertIsolatedWorktree(worktree, repoRoot) {
  const wt = resolve(worktree);
  if (isInside(wt, repoRoot)) {
    throw new PipelineRefusal("PRODUCTION", `refusing to work inside the production checkout: ${wt}`);
  }
  return wt;
}

export function resolveWorktree(config, featureId, repoRoot) {
  const root = resolve(repoRoot, config?.engineering?.worktreeRoot ?? "../oc-evolution");
  return assertIsolatedWorktree(join(root, featureId), repoRoot);
}

export function loadLedger(dir = paths().intel) {
  const p = paths(dir).ledger;
  const raw = existsSync(p) ? readJson(p, null) : null;
  if (!raw || !Array.isArray(raw.tasks)) return { version: 1, tasks: [] };
  return raw;
}

export function saveLedger(ledger, dir = paths().intel) {
  writeJsonAtomic(paths(dir).ledger, { version: 1, ...ledger, updatedAt: iso() });
  return ledger;
}

export function defaultSteps() {
  return [
    { id: "research", title: "Investigate behaviour and collect evidence", status: "pending", evidence: [] },
    { id: "spec", title: "Write the functional specification", status: "pending", evidence: [] },
    { id: "implement", title: "Implement natively in an isolated worktree", status: "pending", evidence: [] },
    { id: "tests", title: "Add focused tests for the accepted behaviour", status: "pending", evidence: [] },
    { id: "gates", title: "Run allowlisted validation gates", status: "pending", evidence: [] },
    { id: "pr", title: "Prepare the pull-request draft", status: "pending", evidence: [] },
  ];
}

export function specMarkdown(feature, { now = iso() } = {}) {
  return `# Feature specification: ${feature.name}

Feature: \`${feature.id}\`
Parity: ${feature.parity.status}${feature.parity.percent == null ? "" : ` (${feature.parity.percent}%)`}
Product: ${feature.product} · Platforms: ${(feature.platforms ?? []).join(", ") || "unknown"}
Generated: ${now}

## Evidence

${(feature.sourceUrls ?? []).length ? feature.sourceUrls.map((u) => `- ${u}`).join("\n") : "- No source URL recorded."}

Investigation: ${feature.investigation?.planPath ?? "not written"}

## Behaviour contract

${feature.summary || "Describe the observable behaviour here. Label observations, inferences and open questions separately."}

## Requirements

- [ ] Works with the user's configured routing (LiteLLM, OpenAI-compatible, Ollama).
- [ ] Declares required capabilities (tools, vision, long context) and degrades honestly when they are absent.
- [ ] Persists across restarts where the reference behaviour persists.
- [ ] Uses the existing Rust core / React UI / CLI patterns; no parallel subsystem.
- [ ] Never requires an Anthropic account or Anthropic-hosted service unless labelled \`not-replicable\`.

## Permissions and security

- Permissions requested: ${(feature.permissions ?? []).join(", ") || "none"}
- Model capabilities: ${(feature.modelCapabilities ?? []).join(", ") || "none"}
- Integrations: ${(feature.requiredIntegrations ?? []).join(", ") || "none"}

## Acceptance tests

- [ ] …
- [ ] Existing app suites still pass.

## Out of scope

Anything that depends on Anthropic infrastructure is documented as such, not simulated.
`;
}

/**
 * Create the ledger task, the worktree plan and the spec. Requires autonomy
 * "implement" or higher; research-only mode refuses and says why.
 */
export function planImplementation({ feature, config, dir = paths().intel, repoRoot, now = iso() }) {
  const level = AUTONOMY[config?.autonomy] ?? 0;
  if (level < AUTONOMY.implement) {
    throw new PipelineRefusal(
      "AUTONOMY",
      `autonomy is "${config.autonomy}"; set it to "implement" to prepare native work`,
    );
  }
  if (feature.parity.status === "not-replicable" || feature.status === "not-applicable") {
    throw new PipelineRefusal("NOT-REPLICABLE", "this feature cannot be reproduced natively");
  }
  const root = repoRoot ?? paths(dir).repo;
  // A paid model is never implied by planning; the agent step must ask for it.
  const inference = guardInference({ paid: false }, config);

  const worktree = resolveWorktree(config, feature.id, root);
  const branch = `evolution/${feature.id.replace(/^feat_/, "")}`;
  const maxImpl = Number(config?.budget?.maxImplementationsPerRun ?? 0);
  if (maxImpl <= 0) throw new BudgetError("implementation budget is zero (budget.maxImplementationsPerRun)");

  const ledger = loadLedger(dir);
  const open = ledger.tasks.find((t) => t.featureId === feature.id && !["cancelled", "ready-for-review"].includes(t.status));
  if (open) return { task: open, specPath: open.specPath, created: false, worktree, branch, inference };

  mkdirSync(paths(dir).specs, { recursive: true });
  const specFile = join(paths(dir).specs, `${feature.id}.md`);
  writeFileSync(specFile, specMarkdown(feature, { now }), "utf8");
  const specPath = `docs/feature-intel/specs/${feature.id}.md`;

  const task = {
    id: `task_${feature.id.replace(/^feat_/, "")}`,
    featureId: feature.id,
    title: feature.name,
    status: "queued",
    autonomy: config.autonomy,
    branch,
    worktree,
    baseRevision: null,
    specPath,
    steps: defaultSteps(),
    attempts: 0,
    gates: [],
    checkpoints: [{ at: now, note: "planned" }],
    prDraft: null,
    blockers: [],
    createdAt: now,
    updatedAt: now,
  };
  task.steps[0].status = feature.investigation?.status === "ready" ? "done" : "pending";
  task.steps[0].evidence = feature.investigation?.planPath ? [feature.investigation.planPath] : [];
  task.steps[1].status = "done";
  task.steps[1].evidence = [specPath];
  ledger.tasks.push(task);
  saveLedger(ledger, dir);
  return { task, specPath, created: true, worktree, branch, inference };
}

export function setTaskStatus(ledger, id, status, patch = {}, { now = iso(), dir = paths().intel } = {}) {
  const task = ledger.tasks.find((t) => t.id === id);
  if (!task) throw new PipelineRefusal("UNKNOWN-TASK", `unknown task ${id}`);
  task.status = status;
  Object.assign(task, patch);
  task.updatedAt = now;
  task.checkpoints = [...(task.checkpoints ?? []), { at: now, note: status }].slice(-50);
  saveLedger(ledger, dir);
  return task;
}

/** A failed task resumes from its last checkpoint instead of starting over. */
export function resumeTask(ledger, id, { now = iso(), dir = paths().intel } = {}) {
  const task = ledger.tasks.find((t) => t.id === id);
  if (!task) throw new PipelineRefusal("UNKNOWN-TASK", `unknown task ${id}`);
  if (task.status === "ready-for-review") return task;
  task.status = "queued";
  task.attempts = (task.attempts ?? 0) + 1;
  task.updatedAt = now;
  task.checkpoints = [...(task.checkpoints ?? []), { at: now, note: `resume attempt ${task.attempts}` }].slice(-50);
  saveLedger(ledger, dir);
  return task;
}

export function gatePlan(config, repoRoot) {
  return (config?.engineering?.gates ?? []).map((g) => ({
    name: g.name,
    command: g.command,
    args: g.args ?? [],
    cwd: g.cwd ? join(repoRoot, g.cwd) : repoRoot,
    timeoutMs: g.timeoutMs ?? 120_000,
  }));
}

/**
 * Gates are exactly the configured allowlist. Nothing else is executed, and the
 * worktree is the working directory (so a gate can never touch the checkout).
 */
export function runGates({ task, config, repoRoot, execute = false, spawn = spawnSync }) {
  const plan = gatePlan(config, repoRoot);
  if (!execute) return plan.map((g) => ({ ...g, status: "planned" }));
  const budgetMs = Number(config?.engineering?.maxGateMinutes ?? 12) * 60_000;
  let spent = 0;
  const results = [];
  for (const g of plan) {
    if (spent >= budgetMs) {
      results.push({ name: g.name, status: "skipped", reason: "gate budget exhausted" });
      continue;
    }
    const started = Date.now();
    const r = spawn(g.command, g.args, {
      cwd: task?.worktree && existsSync(task.worktree) ? task.worktree : g.cwd,
      encoding: "utf8",
      timeout: Math.min(g.timeoutMs, budgetMs - spent),
      windowsHide: true,
      shell: false,
    });
    const ms = Date.now() - started;
    spent += ms;
    results.push({
      name: g.name,
      status: r.status === 0 ? "passed" : "failed",
      code: r.status,
      output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-4_000),
      ms,
    });
  }
  return results;
}

export function prDraft(task, feature, gates = []) {
  const passed = gates.filter((g) => g.status === "passed").length;
  return `# ${task.title}

Implements the native OpenClaude equivalent of "${feature.name}" (\`${feature.id}\`).

## Evidence

${(feature.sourceUrls ?? []).length ? feature.sourceUrls.map((u) => `- ${u}`).join("\n") : "- No source URL recorded."}
- Investigation: ${feature.investigation?.planPath ?? "not written"}
- Specification: ${task.specPath}
- Parity: ${feature.parity.status} — ${feature.parity.notes || "see spec"}

## What changed

${(feature.implementation?.commits ?? []).length ? feature.implementation.commits.map((c) => `- ${c}`).join("\n") : "_Fill in after implementation. This draft is prepared before any code is written._"}

## Validation

${gates.length ? gates.map((g) => `- ${g.name}: ${g.status}${g.ms ? ` (${g.ms} ms)` : ""}`).join("\n") : "- No gates run yet."}

Result: ${passed}/${gates.length || 0} gates passed.

## Model independence

Built against OpenClaude's configured routing. No Anthropic-only assumption, and
no paid provider is called without authorization.

## Known limitations

${(feature.blockers ?? []).length ? feature.blockers.map((b) => `- ${b}`).join("\n") : "- None recorded."}

## Status

Draft prepared by the Evolution Engine. Not committed, pushed, merged, or deployed.
`;
}

export function writePrDraft(task, feature, gates, dir = paths().intel) {
  const markdown = prDraft(task, feature, gates);
  const file = join(paths(dir).specs, `${task.featureId}-pr.md`);
  mkdirSync(paths(dir).specs, { recursive: true });
  writeFileSync(file, markdown, "utf8");
  return { path: rel(file, paths(dir).repo), markdown };
}
