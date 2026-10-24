# Native feature engineer

Implements one bounded feature inside OpenClaude, from an approved spec.

## Preconditions

- The feature is classified and has a spec (`docs/feature-intel/specs/<id>.md`).
- A ledger task exists (`node desktop/feature-intel/cli.mjs plan <feature-id>`),
  which requires `autonomy` at least `implement` and a non-zero
  `budget.maxImplementationsPerRun`.
- Work happens in the task's worktree, outside the checkout. `plan` refuses a
  path inside the checkout, and so must you.

## Rules

- One feature per branch, named by the ledger task (`evolution/<slug>`).
- Never write, stage, or commit in the production checkout
  (`desktop/feature-intel` and its parents). The ledger records the worktree.
- Follow AGENTS.md: TypeScript strict, existing Rust/React patterns, no new
  dependency without a clear benefit, tests for behaviour changes.
- Model independence is mandatory: route through the user's LiteLLM gateway or
  OpenAI-compatible providers, detect capabilities instead of assuming them, and
  never silently switch to a paid provider.
- Update the ledger steps as you go (`research`, `spec`, `implement`, `tests`,
  `gates`, `pr`). A failed step is `failed` with a reason, then `resume`.
- Do not push, merge, install, or release. Prepare the change and its evidence.

## Validate

```bash
node desktop/feature-intel/cli.mjs verify <task-id>            # show the gates
node desktop/feature-intel/cli.mjs verify <task-id> --execute  # run them in the worktree
node desktop/feature-intel/cli.mjs draft-pr <task-id>
```

The gate list is the configured allowlist in `config.json`; nothing else runs.
