// REA ("Reverse Engineer Anything") is an on-demand investigation tool, not a
// dependency of the scheduler. This module only ever:
//   1. detects whether the operator has REA installed,
//   2. writes a bounded, evidence-labelled investigation plan,
//   3. records the outcome honestly (ready, blocked, or not run).
//
// It never downloads or executes REA's setup script, never runs an
// investigation against software the operator has not authorized, and never
// sends captured material anywhere.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.mjs";
import { iso } from "./util.mjs";

export function probeRea(config = {}, options = {}) {
  const command = config.command || "rea";
  if (process.env.OPENCLAUDE_EVOLUTION_DISABLE_REA === "1") {
    return { available: false, command, version: null, reason: "disabled by OPENCLAUDE_EVOLUTION_DISABLE_REA" };
  }
  const run = options.spawnSync ?? spawnSync;
  try {
    const r = run(command, ["--version"], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 8_000,
      windowsHide: true,
      shell: false,
    });
    if (r.error || r.status !== 0) {
      return {
        available: false,
        command,
        version: null,
        reason: r.error ? String(r.error.code || r.error.message) : `exit ${r.status}`,
        setupCommand: config.setupCommand,
      };
    }
    return { available: true, command, version: String(r.stdout || "").trim().slice(0, 120) || "unknown" };
  } catch (err) {
    return { available: false, command, version: null, reason: String(err?.message ?? err), setupCommand: config.setupCommand };
  }
}

/**
 * The setup command a human may choose to run. It is returned for display and
 * approval only; nothing here executes it.
 */
export function reaSetupRequest(config = {}, authorization = {}) {
  const setupCommand = config.setupCommand || "npx rea-agents@latest setup";
  if (!config.enabled) return { allowed: false, setupCommand, reason: "REA is disabled in config.json" };
  if (authorization.setupAuthorized && config.setupAuthorized) return { allowed: true, setupCommand, reason: "operator authorized" };
  return {
    allowed: false,
    setupCommand,
    reason: "needs explicit approval: run it yourself, or set rea.setupAuthorized and pass --authorized",
  };
}

const EVIDENCE_RULES = `\
- **Observation** — seen directly in a capture, screen recording, official doc, or the app's own files.
- **Inference** — a conclusion drawn from observations; label it as such and say what would falsify it.
- **Open question** — not established. Never present it as fact.
`;

export function investigationPlan(feature, { rea, now = iso() } = {}) {
  const available = rea?.available === true;
  const title = feature.name;
  // The plan states what the investigation is, not what the feature claimed before it.
  const status = available ? feature.status : "blocked (REA unavailable)";
  return `# Investigation: ${title}

Feature: \`${feature.id}\`
Product: ${feature.product}
Status: ${status}
Generated: ${now}
REA: ${available ? `available (${rea.command} ${rea.version})` : `not available (${rea.reason ?? "not probed"})`}

## 1. Question

What observable behaviour does "${title}" provide, and what is the smallest
architecture in OpenClaude that reproduces that behaviour without Anthropic's
services?

## 2. Official evidence first

${(feature.sourceUrls ?? []).length ? (feature.sourceUrls ?? []).map((u) => `- ${u}`).join("\n") : "- No source URL recorded. Add one before investigating."}

Check the official documentation and changelog for this feature. Record the
release date, the platforms, and whether it is generally available, staged, or
announced only. A community post is a discovery signal, never proof of release.

## 3. Availability check

- [ ] Confirm the feature is actually present in an authorized copy (installed build, official docs, or a recording).
- [ ] Record the exact version and platform examined.
- [ ] If it is not available, stop: status becomes \`blocked\` with the reason, not \`done\`.

## 4. Controlled investigation

${available
    ? `REA is available. Use only software the operator has authorized, read-only:\n\n- Compare the installed versions around this feature (e.g. \`compare_application_versions\` on \`resources/app.asar\`).\n- Record workflows, states, persistence, events, IPC boundaries and user-visible affordances.`
    : `REA is not installed. This investigation is **blocked** until the operator either installs it (\`${rea?.setupCommand ?? "npx rea-agents@latest setup"}\`, run manually) or authorizes a documentation-only analysis.\n\nA documentation-only pass may still proceed with public specifications and official documentation.`}

Boundaries (non-negotiable):

- No copying proprietary source, assets, or text.
- No bypassing access controls, licence checks, encryption, or credentials.
- No undocumented private APIs where the applicable terms forbid it.
- No captures, binaries, tokens, or user data leave the machine or enter the repository.

## 5. Evidence labels

${EVIDENCE_RULES}
## 6. Functional specification

Write the behaviour contract from the evidence:

- Inputs and states.
- What the user sees at each step.
- Persistence and recovery expectations.
- Failure modes and what the app must not do.
- Which parts need Anthropic infrastructure, and therefore cannot be replicated.

## 7. Acceptance tests

Each test must be runnable without Anthropic services:

1. …
2. …

## 8. Independent implementation

- Where it belongs in OpenClaude (Rust core, React UI, or CLI).
- Which existing services it reuses.
- Which model capabilities it needs (tools, vision, long context) and the
  capability check when they are absent.
- How it behaves with local and OpenAI-compatible models.

## 9. Outcome

- Status: (pending | ready | blocked | not-replicable)
- Blockers:
- Evidence links:
`;
}

/**
 * Write the plan for a feature and return the investigation state transition.
 * Nothing is executed and no model is called.
 */
export function investigate(feature, { config, dir = paths().intel, now = iso(), probeFn = probeRea } = {}) {
  const reaConfig = config?.rea ?? {};
  const rea = probeFn(reaConfig);
  const outDir = paths(dir).investigations;
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${feature.id}.md`);
  const markdown = investigationPlan(feature, { rea, now });
  writeFileSync(file, markdown, "utf8");
  const relPath = `docs/feature-intel/investigations/${feature.id}.md`;
  const blocked = !rea.available && reaConfig.enabled !== false;
  return {
    rea,
    planPath: relPath,
    status: blocked ? "blocked" : "ready",
    blockedReason: blocked ? `REA unavailable: ${rea.reason ?? "not installed"}` : null,
    now,
  };
}
