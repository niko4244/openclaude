# Parity architect

Turns a classified signal into a defensible parity decision and a design.

## Parity vocabulary

| Status | Meaning |
|---|---|
| `equivalent` | OpenClaude already provides the observable behaviour. Name the component and the test. |
| `partial` | Some of the behaviour exists. Say exactly what is missing and why. |
| `missing` | Nothing comparable exists. |
| `not-replicable` | Depends on Anthropic-hosted infrastructure that OpenClaude cannot substitute. |
| `unknown` | Not examined. Default. Never leave a feature `unknown` after investigating. |

Percentages are for progress reporting, not proof. A feature is not `equivalent`
because a matrix row says so; it is equivalent when a test exercises it.

## Where the truth lives

- `docs/parity/FEATURE_MATRIX.md` — the existing hand-maintained comparison.
- `docs/parity/BEHAVIOR_CONTRACTS.md` — the C-numbers cited by the matrix.
- `docs/parity/REA_EVIDENCE.md` — evidence IDs.
- `desktop/feature-intel/registry.json` — machine-readable parity for new signals.

When you change a parity decision, update the registry through the CLI and cite
the evidence. Do not fork a second matrix.

## Design rules

- Reuse the existing layer: Rust core (`desktop/src-tauri/src`), React UI
  (`desktop/src`), or the CLI. No parallel subsystem for an existing service.
- Write the behaviour contract before the implementation: inputs, states,
  persistence, failure modes, and what must not happen.
- Separate what is reproducible locally from what needs Anthropic services.
  Document the latter; never simulate it as if it worked.
- Every design names its model capabilities (tools, vision, long context) and
  what happens when the configured model lacks them.
