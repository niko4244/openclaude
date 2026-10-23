# Goal: OpenClaude Desktop at Claude Desktop parity

**Target.** Someone who uses Claude Desktop daily opens OpenClaude and finds the same layout, the same interaction patterns and
the same level of polish. Every request runs on our own LiteLLM gateway, local models, MCP servers and agent runtimes.

**Done means** every P0/P1 row in `FEATURE_MATRIX.md` is *Operational* and backed by an E2E check, and every screen in
`VISUAL_BASELINES.md` passes a side-by-side review against the reference. Features that depend on Anthropic-hosted services
get an independent equivalent where practical; otherwise they are marked unavailable, never faked.

**Working rules.** Work tranche by tranche. Each tranche ends with a release build, the full E2E suite, screenshots, a matrix
update, and a commit pushed to the PR branch. No check-ins between tranches. Nik reviews the PR.

## Tranches

| # | Tranche | Matrix rows | Exit check |
|---|---|---|---|
| T1 | Core: gateway, chat, MCP, artifacts, persistence, Code adapter | 2, 3, 6, 7, 22 | ✅ E2E 15/15 |
| T2 | Desktop shell: tray, Quick Entry window, native menu, find, shortcuts sheet, probe badges, Code terminal, settings lock | 4, 5, 11, 12, 13, 16 | E2E extended |
| T3 | **Visual parity**: icon system, reference layout (sidebar sections, starred/recents, account footer), home greeting, composer (+ menu, connectors/tools menu, model menu, extended-thinking toggle), message chrome (action bar, feedback, timestamps), artifact panel chrome, settings as a modal-style page, motion | 1, 4, 10 + visual baselines | Side-by-side screenshots vs reference; E2E green |
| T4 | Conversation depth: branch navigation (‹ 1/2 ›) over superseded turns, auto-artifacts (model emits artifacts that open in the panel) with versions, extended thinking / reasoning effort, per-chat connector toggles, ask-session approvals, context compaction, chat export | 2, 7, 15 | E2E per feature |
| T5 | Projects depth: knowledge files (local indexing + retrieval), project-scoped connectors/models, project home screen | 14 | E2E |
| T6 | Extensions: `.mcpb`/`.dxt` install (manifest, user_config, signatures shown), extension directory UI | 9 | E2E with a real bundle |
| T7 | Tasks/Cowork-lite: background task runner, folder grants, scheduled runs, task history, approvals inbox | 17 | E2E |
| T8 | Release: auto-update (Tauri updater, signed manifests on the fork's releases), code signing hook, perf budget (cold start under 3 s, idle memory), accessibility pass | 20 + release | Packaged-build acceptance |
| T9 | Stretch: voice (local STT through the gateway or Whisper), computer use (approval-gated), deep links, remote MCP OAuth | 8, 18, 19, 23 | E2E where automatable |

## Reference baseline

Visual reference: the user's installed Claude Desktop, captured as screenshots for side-by-side comparison only (never shipped).
Behavioral reference: `BEHAVIOR_CONTRACTS.md`. All implementation is original: own icons (Lucide, ISC license), own palette and
layout code.
