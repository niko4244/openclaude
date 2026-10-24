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
| T1 | Core: gateway, chat, MCP, artifacts, persistence, Code adapter | 2, 3, 6, 7, 22 | ✅ done |
| T2 | Desktop shell: tray, Quick Entry window, native menu, find, shortcuts sheet, probe badges, Code terminal, settings lock | 4, 5, 11, 12, 13, 16 | ✅ done (E2E) |
| T3 | **Visual parity**: icon system, reference layout (sidebar sections, starred/recents, account footer), home greeting, composer (+ menu, connectors/tools menu, model menu, extended-thinking toggle), message chrome (action bar, feedback, timestamps), artifact panel chrome, settings as a modal-style page, motion | 1, 4, 10 + visual baselines | ✅ done incl. frameless title bar (TitleBar.tsx, own window controls) |
| T4 | Conversation depth: branch navigation (‹ 1/2 ›) over superseded turns, auto-artifacts (model emits artifacts that open in the panel) with versions, extended thinking / reasoning effort, per-chat connector toggles, ask-session approvals, context compaction, chat export | 2, 7, 15 | ✅ branches, auto-artifacts + versions, approval scopes, export, extended-thinking toggle, context compaction (cached summary); React + Mermaid artifact previews and select-to-ask (Improve / Explain) |
| T5 | Projects depth: knowledge files (local indexing + retrieval), project-scoped connectors/models, project home screen | 14 | ✅ text knowledge (full or retrieved) incl. PDF text extraction |
| T6 | Extensions: `.mcpb`/`.dxt` install (manifest, user_config, signatures shown), extension directory UI | 9 | ✅ install path (Rust E2E, real bundle), MCPB signature verification (Windows CryptoAPI), connector directory (official MCP Registry) |
| T7 | Tasks/Cowork-lite: background task runner, folder grants, scheduled runs, task history, approvals inbox | 17 | ✅ scheduled and background tasks, folder tasks (CLI headless in a granted folder with our own allow policy) |
| T8 | Release: auto-update (Tauri updater, signed manifests on the fork's releases), code signing hook, perf budget (cold start under 3 s, idle memory), accessibility pass | 20 + release | ✅ signed updater + release script, deep links, window state, desktop-v0.1.0 and v0.2.0 published; ⏳ Authenticode code signing (needs a certificate) |
| T9 | Stretch: voice (local STT through the gateway or Whisper), computer use (approval-gated), deep links, remote MCP OAuth | 8, 18, 19, 23 | ✅ deep links (E2E); ✅ MCP OAuth + SSE (mock-verified); ✅ computer use + dictation implemented (unit/mock-verified; live E2E needs a vision model and a mic) |
| T10 | Plugins: Claude-format plugins from GitHub with auto-update, import of the user's Claude plugins, Ponytail, `/` menu, skills tools, context hooks, plugin connectors, CLI plugin dirs | 26 | ✅ Evidence: e2e/plugins.e2e.mjs 11/11 (Ponytail installed from GitHub with its session hook feeding chat context; 19 of Nik's Claude Code/Desktop plugins found and imported, 16 installed from GitHub; 752 skills/commands/agents indexed; update check; '/' menu send; the model finds a skill via skills__search on its own); 9 unit tests incl. real git install/update/rollback and real hooks; CLI --plugin-dir load verified. |
| T11 | Remaining gaps: live computer use (vision), measured layout geometry, local-first sync | 18, 21, visual | ✅ computer-use E2E 3/3, layout tokens from the reference bundle adopted (VISUAL_BASELINES §1b), sync E2E 6/6; row 25 documented as not applicable |

## Reference baseline

Visual reference: the user's installed Claude Desktop, captured as screenshots for side-by-side comparison only (never shipped).
Behavioral reference: `BEHAVIOR_CONTRACTS.md`. All implementation is original: own icons (Lucide, ISC license), own palette and
layout code.
