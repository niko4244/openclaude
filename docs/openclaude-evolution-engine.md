# OpenClaude Evolution Engine

A persistent subsystem that watches Claude's public release surface, records what
changed with provenance, decides what OpenClaude is missing, and prepares native
work for review. It is not an agent prompt and not a wishlist: the registry, the
scheduler, the guards and the tests are code in this repository.

Status: implemented and tested (engine unit/acceptance tests, live source sweep).
The desktop panel reads the same registry. Nothing is auto-merged or auto-installed.

## Shape

```
desktop/feature-intel/            engine (Node 22, no dependencies)
  config.json                     interval, autonomy, budgets, gates, REA settings
  sources.json                    official source allowlist
  registry.json                   durable signals + features + parity (schema v1)
  ledger.json                     implementation task ledger
  state/<source>.json             per-source snapshot, ETag/Last-Modified
  lib/
    engine.mjs                    one sweep: fetch -> registry -> report
    registry.mjs                  schema, migration, dedupe, state machine
    sources.mjs                   adapters, conditional requests, retries
    lock.mjs                      one writer at a time, stale takeover
    rea.mjs                       REA probe + evidence-labelled investigation plan
    pipeline.mjs                  spec, worktree plan, ledger, gates, PR draft
  agents/*.md                     the eight roles and their operating rules
  cli.mjs                         manual entry point
  monitor.mjs                     old entry point, now a wrapper
  tests/*.test.mjs                fixture-based acceptance tests
docs/feature-intel/
  reports/latest.md               newest sweep report
  reports/YYYY-MM-DD.md           daily report + issues JSON (drafts, never posted)
  investigations/<feature>.md     investigation plans (evidence labels)
  specs/<feature>.md              behaviour contracts
  specs/<feature>-pr.md           pull-request drafts
docs/feature-parity.md            generated parity table (do not hand-edit)
.github/workflows/claude-feature-watch.yml   six-hourly repository sweep
```

The desktop app's **Evolution** page reads `registry.json` and runs a check when
a checkout of this repository is available (dev machines). On an installed build
without a checkout it shows the synced registry and says why "Check now" is
unavailable; the GitHub workflow is what keeps the registry current in that case.

## Two layers, deliberately

**Signals** are what a source said: `{ id, sourceId, key, title, url, publishedAt,
firstSeen, lastSeen, digest, revision, status, featureId, missingSince }`.

**Features** are what a human or agent decided it means: behaviour summary,
product, parity, feasibility, permissions, capabilities, investigation,
implementation, tests, blockers.

The engine never promotes a signal to "available" or "implemented" by matching a
name. `classify` is the only door, and `updateFeature` rejects invalid states.

## States

Feature: `announced → investigating → specified → implementing → validating →
implemented → tested → released`, plus `blocked`, `deferred`, `not-applicable`.

Parity: `unknown`, `missing`, `partial`, `equivalent`, `not-replicable`.
Coverage counts `equivalent` as 1 and `partial` as 0.5, and excludes
`not-replicable`.

## Scheduling

- **Repository workflow** (`claude-feature-watch.yml`): every six hours and on
  demand. Minimal permissions, `concurrency` group, no dependency install, no
  third-party action beyond checkout/setup-node/upload-artifact. It commits the
  registry to `evolution/registry` and opens or updates a PR. It never pushes to
  `main`.
- **Desktop ticker**: while the app is open, the same sweep runs on the configured
  interval if a checkout is reachable and monitoring is enabled.
- **Manual**: `Check for Claude updates` on the Evolution page, or the CLI.

There is no other polling loop. `enabled: false` (or **Pause** in the app) stops
both the ticker and the CLI; the workflow is disabled in GitHub's UI or by
removing the schedule.

## Commands

```bash
node desktop/feature-intel/cli.mjs status [--json]
node desktop/feature-intel/cli.mjs check [--dry-run] [--force]
node desktop/feature-intel/cli.mjs classify <signal-id> --name "Cowork" --parity missing
node desktop/feature-intel/cli.mjs investigate <feature-id>
node desktop/feature-intel/cli.mjs plan <feature-id>
node desktop/feature-intel/cli.mjs verify <task-id> [--execute]
node desktop/feature-intel/cli.mjs draft-pr <task-id>
node desktop/feature-intel/cli.mjs resume <task-id>
node desktop/feature-intel/cli.mjs enable | disable
node desktop/feature-intel/cli.mjs config --set autonomy=implement
node desktop/feature-intel/cli.mjs rea
node desktop/feature-intel/cli.mjs report-parity
```

`bun run evolution` (root package.json) is the same CLI.

## What is enforced in code

| Requirement | Where |
|---|---|
| One canonical record per announcement | `recordSignal` keys on `(sourceId, key)`; a rerun records nothing |
| Edited announcement updates, not duplicates | same key + new digest → `revision += 1` |
| A bad source cannot destroy the registry | per-source try/catch; registry write is separate and atomic |
| A corrupt registry is never silently reset | `loadRegistry` throws; the sweep returns `registry-error` |
| No concurrent writers | `state/.engine.lock`, `wx` create, stale takeover after 20 min |
| Crash never truncates the ledger | temp file + rename in `writeJsonAtomic` |
| Blocked investigation is not success | `investigate` returns `blocked` when REA is absent |
| No unauthorized paid inference | `guardInference` throws `BudgetError`; engine steps never set `paid` |
| Nothing writes in the production checkout | `assertIsolatedWorktree`, worktree root is `../oc-evolution` |
| Only allowlisted gates run | `runGates` uses `config.engineering.gates`, array args, no shell |
| Failed work resumes | `resumeTask` keeps checkpoints and increments attempts |
| PRs carry evidence | `prDraft` includes sources, spec, gates, limitations |
| Source text cannot instruct the engine | no model is called on fetched text; report quotes it |

## Security and privacy

- Fetched text is untrusted. It is normalised, stored and quoted; it is never
  executed, never interpolated into a shell, and never sent to a model by the
  engine. A human or agent reading a report must treat it the same way.
- No credentials are read or written. There is no Anthropic account involved.
- Captures, binaries, tokens and user data are never committed. REA runs only on
  an operator-authorized machine; CI queues those investigations instead.
- The workflow uses `contents: write` and `pull-requests: write` only, and only
  for the registry branch/PR.

## Autonomy

`research` (default): discovery, classification, investigation plans, specs. No
code is written.

`implement`: the pipeline may prepare an isolated worktree, a ledger task and a
branch plan. A coding agent (or human) writes the code there.

`prepare-pr`: additionally allows the PR draft to be produced. Pushing, merging,
releasing and installing remain human actions — the engine has no code path for
them.

## Initial state

The registry starts empty on first use; the first sweep records a baseline from
the official sources. `docs/feature-parity.md` is generated from classified
features, not from the existing hand-maintained matrix — both are kept because
the matrix covers the reference app in more detail than a signal can.
