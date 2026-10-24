#!/usr/bin/env node
// Backwards-compatible entry point.
//
// This script used to be the whole monitor: per-source snapshots, a markdown
// report and draft issues. It is now a thin wrapper over the Evolution Engine
// (lib/engine.mjs), which keeps the snapshots and adds the durable registry,
// signal deduplication, locking and checkpointed runs.
//
//   node desktop/feature-intel/monitor.mjs            # check all sources
//   node desktop/feature-intel/monitor.mjs --dry-run  # print, don't write
//
// It still never installs binaries, runs downloaded code, or ships changes.
import { loadConfig } from "./lib/config.mjs";
import { runCheck } from "./lib/engine.mjs";
import { paths } from "./lib/paths.mjs";

const dry = process.argv.includes("--dry-run");
const quiet = process.argv.includes("--quiet");

const result = await runCheck({
  dir: paths().intel,
  config: loadConfig(paths().intel),
  dryRun: dry,
  logger: quiet ? () => {} : (m) => console.error(`  ${m}`),
});

console.log(result.markdown ?? "");
console.error(`\n${result.status}: +${result.added} new, ~${result.changed} changed`);
process.exit(result.status === "failed" || result.status === "registry-error" ? 1 : 0);
