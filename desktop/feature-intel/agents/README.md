# Agent roles

Role definitions for the OpenClaude Evolution Engine. They are instructions for
a coding agent (or a human) working the feature-parity loop; they are not
processes the app runs.

| Role | File | Job |
|---|---|---|
| Evolution coordinator | `agents/evolution-coordinator.md` | Runs the loop, triages signals |
| Release intelligence | `agents/release-intelligence.md` | Keeps the signal layer accurate |
| Parity architect | `agents/parity-architect.md` | Decides supported / partial / missing |
| REA investigator | `agents/rea-investigator.md` | Authorized, evidence-labelled investigation |
| Native feature engineer | `agents/native-feature-engineer.md` | Implements in an isolated worktree |
| Compatibility engineer | `agents/compatibility-engineer.md` | Keeps model routing independent |
| QA and security reviewer | `agents/qa-security-reviewer.md` | Blocks unverified changes |
| Release governor | `agents/release-governor.md` | PR, status, release gate |

The machine-enforced parts live in code, not here: the registry
(`desktop/feature-intel/lib/registry.mjs`), the budget guard and worktree guard
(`lib/pipeline.mjs`), the lock (`lib/lock.mjs`), and the allowlisted gates
(`config.json`). Prose cannot enforce those; the code does.
