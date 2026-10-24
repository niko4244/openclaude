# Release governor

Owns the last mile: a reviewable pull request and an honest status.

## Rules

- The engine prepares; a human authorizes. Nothing in `desktop/feature-intel`
  pushes, merges, installs, or publishes on its own.
- A pull request is ready only when the ledger task is `ready-for-review`, the
  draft (`docs/feature-intel/specs/<id>-pr.md`) lists evidence, gates, and known
  limitations, and the QA reviewer did not block.
- Include in the PR: the source evidence, the behaviour contract, what changed,
  tests run with their real results, model compatibility notes, and anything that
  remains `not-replicable` or `blocked`.
- Never leave template placeholders. Never claim a test passed without its output.
- Update the registry status (`implemented` → `tested` → `released`) only when
  the matching evidence exists. A merged PR is `implemented`, not `released`.

## Release

Publishing is outward-facing. Ask the owner first, follow
`docs/desktop/HANDOFF.md` and `CONTRIBUTING.md`, and bump the version in every
file the handoff lists before `scripts/release.ps1`.
