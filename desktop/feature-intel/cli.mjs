#!/usr/bin/env node
// OpenClaude Evolution Engine — manual entry point.
//
//   node desktop/feature-intel/cli.mjs check [--dry-run] [--force] [--json]
//   node desktop/feature-intel/cli.mjs status [--json]
//   node desktop/feature-intel/cli.mjs classify <signal-id> --name "…" [--parity missing] [--percent 0]
//   node desktop/feature-intel/cli.mjs investigate <feature-id>
//   node desktop/feature-intel/cli.mjs plan <feature-id>
//   node desktop/feature-intel/cli.mjs verify <task-id> [--execute]
//   node desktop/feature-intel/cli.mjs draft-pr <task-id>
//   node desktop/feature-intel/cli.mjs resume <task-id>
//   node desktop/feature-intel/cli.mjs enable|disable
//   node desktop/feature-intel/cli.mjs config [--set key=value]
//   node desktop/feature-intel/cli.mjs rea
//   node desktop/feature-intel/cli.mjs report-parity
//
// Exit codes: 0 success, 1 failure, 2 nothing to do / blocked.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadConfig, saveConfig } from "./lib/config.mjs";
import { runCheck, statusView } from "./lib/engine.mjs";
import { paths } from "./lib/paths.mjs";
import {
  classifySignal, loadRegistry, saveRegistry, updateFeature, paritySummary,
} from "./lib/registry.mjs";
import { investigate, probeRea, reaSetupRequest } from "./lib/rea.mjs";
import {
  loadLedger, saveLedger, planImplementation, runGates, writePrDraft, resumeTask, PipelineRefusal,
} from "./lib/pipeline.mjs";
import { iso } from "./lib/util.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "status";
const has = (flag) => argv.includes(flag);
const value = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] ?? "").startsWith("--"));

const dir = paths().intel;
const json = has("--json");
const print = (o) => (json ? console.log(JSON.stringify(o, null, 2)) : console.log(o));

function fail(message, code = 1) {
  console.error(`evolution: ${message}`);
  process.exit(code);
}

try {
  switch (cmd) {
    case "check": {
      const r = await runCheck({
        dir,
        config: loadConfig(dir),
        dryRun: has("--dry-run"),
        force: has("--force"),
        logger: has("--quiet") || json ? () => {} : (m) => console.error(`  ${m}`),
      });
      if (json) {
        // Keep machine output small: the markdown report is on disk.
        const { markdown, issues, ...rest } = r;
        print(rest);
      } else {
        print(r.markdown ?? "");
        console.error(`\n${r.status}: +${r.added} new, ~${r.changed} changed, ${r.sources.filter((s) => s.status === "failed").length} source(s) failed`);
      }
      process.exit(r.status === "failed" || r.status === "registry-error" ? 1 : 0);
      break;
    }

    case "status": {
      const view = statusView(dir);
      if (json) print(view);
      else {
        const s = view.summary;
        console.log(`OpenClaude Evolution Engine`);
        console.log(`  enabled: ${view.enabled} · every ${view.intervalHours}h · autonomy ${view.autonomy}`);
        console.log(`  last check: ${view.lastCheck ? `${view.lastCheck.finishedAt} (${view.lastCheck.status})` : "never"}`);
        console.log(`  signals: ${s.signals} · features: ${s.total} · untriaged: ${s.unclassified}`);
        console.log(`  parity: ${s.equivalent} equivalent, ${s.partial} partial, ${s.missing} missing${s.coveragePercent == null ? "" : ` — ${s.coveragePercent}%`}`);
        console.log(`  sources: ${view.sources.map((x) => `${x.id}=${x.status}`).join(" ")}`);
        if (view.tasks.length) console.log(`  tasks: ${view.tasks.map((t) => `${t.id}=${t.status}`).join(" ")}`);
      }
      break;
    }

    case "classify": {
      const id = positional[0];
      if (!id) fail("classify needs a signal id (see `status`)", 2);
      const registry = loadRegistry(dir);
      const { feature, created } = classifySignal(registry, id, {
        name: value("--name") ?? undefined,
        product: value("--product") ?? undefined,
        category: value("--category") ?? undefined,
        summary: value("--summary") ?? undefined,
      });
      const parity = value("--parity");
      if (parity) {
        updateFeature(registry, feature.id, {
          parity: {
            status: parity,
            percent: value("--percent") == null ? (parity === "equivalent" ? 100 : parity === "missing" ? 0 : null) : Number(value("--percent")),
            openclaudeFeature: value("--openclaude"),
            notes: value("--notes") ?? "",
          },
        });
      }
      saveRegistry(registry, dir);
      print(created ? `classified ${id} as ${feature.id}` : `${id} was already classified as ${feature.id}`);
      break;
    }

    case "investigate": {
      const id = positional[0];
      if (!id) fail("investigate needs a feature id", 2);
      const registry = loadRegistry(dir);
      const feature = registry.features.find((f) => f.id === id);
      if (!feature) fail(`unknown feature ${id}`);
      const config = loadConfig(dir);
      const r = investigate(feature, { config, dir, now: iso() });
      updateFeature(registry, feature.id, {
        status: r.status === "blocked" ? "blocked" : "investigating",
        investigation: { status: r.status, planPath: r.planPath, blockedReason: r.blockedReason },
        blockers: r.blockedReason ? [...new Set([...(feature.blockers ?? []), r.blockedReason])] : feature.blockers,
      });
      saveRegistry(registry, dir);
      print({ ...r, feature: feature.id });
      process.exit(r.status === "blocked" ? 2 : 0);
      break;
    }

    case "plan": {
      const id = positional[0];
      if (!id) fail("plan needs a feature id", 2);
      const registry = loadRegistry(dir);
      const feature = registry.features.find((f) => f.id === id);
      if (!feature) fail(`unknown feature ${id}`);
      const config = loadConfig(dir);
      const { task, specPath, created, worktree, branch } = planImplementation({ feature, config, dir, repoRoot: paths().repo });
      updateFeature(registry, feature.id, { status: "specified", investigation: { specPath } });
      saveRegistry(registry, dir);
      print({ task: task.id, created, specPath, worktree, branch, status: task.status, autonomy: config.autonomy });
      break;
    }

    case "verify": {
      const id = positional[0];
      if (!id) fail("verify needs a task id", 2);
      const ledger = loadLedger(dir);
      const task = ledger.tasks.find((t) => t.id === id);
      if (!task) fail(`unknown task ${id}`);
      const config = loadConfig(dir);
      const executed = has("--execute");
      const results = runGates({ task, config, repoRoot: paths().repo, execute: executed });
      if (executed) {
        // Persist the real results so the PR draft carries them.
        const fresh = loadLedger(dir);
        const t = fresh.tasks.find((x) => x.id === id);
        t.gates = results;
        t.updatedAt = iso();
        const failed = results.some((r) => r.status === "failed" || r.status === "skipped");
        t.steps = t.steps.map((s) => (s.id === "gates" ? { ...s, status: failed ? "blocked" : "done", evidence: results.map((r) => `${r.name}:${r.status}`) } : s));
        t.status = failed ? "failed" : "validating";
        saveLedger(fresh, dir);
      }
      print(results);
      process.exit(executed && results.some((r) => r.status === "failed") ? 1 : 0);
      break;
    }

    case "draft-pr": {
      const id = positional[0];
      if (!id) fail("draft-pr needs a task id", 2);
      const ledger = loadLedger(dir);
      const task = ledger.tasks.find((t) => t.id === id);
      if (!task) fail(`unknown task ${id}`);
      const registry = loadRegistry(dir);
      const feature = registry.features.find((f) => f.id === task.featureId);
      if (!feature) fail(`task ${id} points at missing feature ${task.featureId}`);
      const gates = task.gates ?? [];
      const r = writePrDraft(task, feature, gates, dir);
      const gateFailure = gates.some((g) => g.status === "failed" || g.status === "skipped");
      const notValidated = gates.length === 0;
      const next = loadLedger(dir);
      const t = next.tasks.find((x) => x.id === id);
      t.prDraft = r.path;
      // A draft without validation, or with a failed gate, is not reviewable yet.
      t.status = gateFailure ? "failed" : notValidated ? "validating" : "ready-for-review";
      t.updatedAt = iso();
      t.steps = t.steps.map((s) => (s.id === "pr" ? { ...s, status: notValidated || gateFailure ? "blocked" : "done", evidence: [r.path] } : s));
      saveLedger(next, dir);
      print({ draft: r.path, status: t.status, gates: gates.length });
      if (gateFailure) process.exit(1);
      if (notValidated) {
        console.error("evolution: run `verify <task-id> --execute` before treating this draft as reviewable");
        process.exit(2);
      }
      break;
    }

    case "resume": {
      const id = positional[0];
      if (!id) fail("resume needs a task id", 2);
      const ledger = loadLedger(dir);
      const task = resumeTask(ledger, id, { dir });
      print({ task: task.id, status: task.status, attempts: task.attempts });
      break;
    }

    case "enable":
    case "disable": {
      const config = saveConfig({ enabled: cmd === "enable" }, dir);
      print(`monitoring ${config.enabled ? "enabled" : "paused"}`);
      break;
    }

    case "config": {
      if (has("--set")) {
        const [key, raw] = String(value("--set")).split("=");
        if (!key || raw === undefined) fail("--set needs key=value");
        const parsed = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
        const patch = key.split(".").reduceRight((acc, k) => ({ [k]: acc }), parsed);
        print(saveConfig(patch, dir));
      } else {
        print(loadConfig(dir));
      }
      break;
    }

    case "rea": {
      const config = loadConfig(dir);
      const probe = probeRea(config.rea);
      const setup = reaSetupRequest(config.rea, { setupAuthorized: has("--authorized") });
      print({ probe, setup, note: "The engine never runs the setup command; it is shown for you to run." });
      break;
    }

    case "report-parity": {
      const registry = loadRegistry(dir);
      const md = parityMarkdown(registry);
      const file = join(paths().repo, "docs", "feature-parity.md");
      writeFileSync(file, md, "utf8");
      print(file);
      break;
    }

    default:
      fail(`unknown command "${cmd}". See the header of cli.mjs for the list.`, 2);
  }
} catch (err) {
  if (err instanceof PipelineRefusal) fail(`${err.code}: ${err.message}`, 2);
  fail(err?.stack || String(err));
}

export function parityMarkdown(registry) {
  const s = paritySummary(registry);
  const rows = [...registry.features]
    .sort((a, b) => a.status.localeCompare(b.status) || a.id.localeCompare(b.id))
    .map((f) => `| \`${f.id}\` | ${f.name.replace(/\|/g, "\\|")} | ${f.product} | ${f.status} | ${f.parity.status} | ${f.parity.percent ?? "—"} | ${(f.blockers ?? []).join("; ").replace(/\|/g, "\\|") || "—"} |`);
  return `# Feature parity

Generated from \`desktop/feature-intel/registry.json\` by \`node desktop/feature-intel/cli.mjs report-parity\`.
Do not hand-edit; classify signals instead.

Coverage: ${s.coveragePercent == null ? "unknown" : `${s.coveragePercent}%`} ·
${s.equivalent} equivalent · ${s.partial} partial · ${s.missing} missing · ${s.unknown} unknown ·
${s.notReplicable} not replicable · ${s.blocked} blocked.

| Feature | Name | Product | Status | Parity | % | Blockers |
|---|---|---|---|---|---|---|
${rows.join("\n") || "| — | — | — | — | — | — | — |"}
`;
}
