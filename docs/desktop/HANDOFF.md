# OpenClaude Desktop: handoff

Keep this file current at every checkpoint, so any model or session can resume cold.

## Where things are
- **Worktree:** `C:\Users\nikma\Desktop\openclaude-desktop`
  - Branch: `feat/desktop-2.0`
  - Remote: `fork` → `niko4244/openclaude`
  - PR: niko4244/openclaude#1
  - The main checkout `C:\Users\nikma\Desktop\openclaude` (with Nik's uncommitted CLI work on `main`) is **untouched**. Never commit there.
- **App:** `desktop/`
  - Rust backend: `desktop/src-tauri/src`
  - React UI: `desktop/src`
  - Real-desktop E2E: `desktop/e2e`
- **Goal and status:**
  - `docs/parity/GOAL.md` (tranches).
  - `docs/parity/FEATURE_MATRIX.md` (per-row status).
  - `docs/desktop/RELEASE_READINESS.md` (evidence).
- **Standing instructions from Nik:**
  - Goal: "Continue until functional and visual parity is exactly the same."
  - No check-ins between tranches.
  - Local checks instead of fork CI (fork Actions never registered).
  - Be aware of rate limits and keep this handoff ready.

## How to build and verify (PowerShell, from `desktop/`)
```powershell
npx tsc -b
.\scripts\with-msvc.ps1 cargo test --manifest-path src-tauri/Cargo.toml --lib          # 63+ tests
.\scripts\with-msvc.ps1 npx tauri build                                                 # release exe + NSIS + MSI
$env:OPENCLAUDE_LITELLM_KEY = <LITELLM_MASTER_KEY from C:\Users\nikma\Brainz\infra\hermes-brainz-stack\.env, never print it>
node e2e/desktop.e2e.mjs            # real GUI over WebView2 CDP, live gateway; last: 32/32
node e2e/a11y.e2e.mjs               # axe audit; exits 1 on critical/serious
node e2e/artifact-isolation.e2e.mjs # 4/4
node e2e/perf.e2e.mjs               # baseline: cold ~0.65 s, idle ~397 MB
```

**Gotchas:**
- MSVC: always use `scripts/with-msvc.ps1`. VS2026 Build Tools has no C++ toolset (LNK1104).
- Window-creating Tauri commands must be `async` (a sync one deadlocks on Windows).
- PowerShell eats a bare `--`, so quote it as `'--'`.
- Writing regex or backslash-heavy code through bash heredocs mangles it. Use the Write tool or a Python script file.
- `npm` lock: `desktop/package-lock.json` is force-tracked (the root .gitignore ignores lockfiles).

## State at last checkpoint
- **Release:** `desktop-v0.1.0` published (approved by Nik). The updater feed returns 200.
- **Committed and pushed:** `f76dd670` (Chrome extension, RGB vision probe, visual baselines doc).
- **Chrome extension E2E:** 4/4 pass.
- **Computer-use E2E** (`e2e/computer-use.e2e.mjs`, `gemma4-local`):
  - The screenshot was approved and ran; no permanent allow was stored.
  - The final reply was HTTP 408 from LiteLLM. A direct replay of the same 1366x768 PNG (739 KB base64) took 148 s and returned empty content.
  - Fix in progress: smaller screenshots (JPEG, lower max side).
- **Nik's latest requests (in progress):**
  1. Port all Claude plugins.
  2. Include Ponytail (`DietrichGebert/ponytail`, MIT; Claude marketplace + plugin).
  3. Install Claude plugin repos natively from GitHub.
  4. Auto-update installed plugins as soon as GitHub has updates.
- **Plugin design (`src-tauri/src/plugins.rs`, being written):**
  - Registry at `<data>/plugins/registry.json`.
  - Git sources: depth-1 clone (sparse for subdirs) into `<data>/plugins/repos/`.
  - Local sources: read in place (Claude Desktop `%APPDATA%/Claude/rpm/*/*/plugin_<id>`, CLI installs, `~/.claude`, `~/.openclaude` user folders).
  - Marketplace JSON is read from `raw.githubusercontent.com/<repo>/HEAD/.claude-plugin/marketplace.json`.
  - Supported source forms: `./sub`, `{source: github|url|git-subdir}`.
  - Desktop `marketplaceName` mapping:
    - `knowledge-work-plugins` resolves to `anthropics/knowledge-work-plugins`.
    - `anthropic-plugin-directory` tries `anthropics/claude-plugins-official`, then the knowledge-work repo, then the `repository` field in plugin.json, then a local reference.
  - Components:
    - `skills/*/SKILL.md`, `commands/**/*.md` (`$ARGUMENTS`), `agents/*.md`. Named `plugin:name`; user folders use bare names.
    - Plugin `.mcp.json` entries go to mcp.json, disabled by default.
    - SessionStart/UserPromptSubmit `command` hooks run through Git Bash with CLAUDE_PLUGIN_ROOT and an isolated CLAUDE_CONFIG_DIR. Their stdout or `additionalContext` is added to the system prompt.
  - Chat tools: `skills__search` / `skills__load`; the composer gets a "/" menu.
  - Auto-update: `git ls-remote` every 15 min; fetch + reset; prev sha kept for rollback; notify only when the plugin subdir tree changed.
  - First run seeds Ponytail and imports Claude plugins, except when `OPENCLAUDE_DATA_DIR` is set (tests).
- **Nik's plugins:**
  - CLI: claude-mem, claude-smart (local npx dir), i-have-adhd.
  - Desktop: design, data, engineering, brand-voice, cowork-plugin-management (knowledge-work); superdesign, gitkraken, github, superpowers, desktop-commander (official); hive, pdf-viewer (local only); claude-review-loop, remotion (their own GitHub repos).
- **Last full gate:** E2E 38/38, a11y 0, Rust 71.

## Next steps (in order)
1. Finish `plugins.rs` and its lib.rs commands, the chat.rs hook/skill wiring, the Settings "Plugins" tab and the Composer "/" menu. Add tests and `e2e/plugins.e2e.mjs`.
2. Smaller computer-use screenshots, then re-run `e2e/computer-use.e2e.mjs`.
3. Full gate (rust tests, build, desktop/a11y E2E), update FEATURE_MATRIX/GOAL, commit and push.
4. Remaining gaps: artifact in-panel editing; Code tab plugin support (CLI-side); non-context hooks (PreToolUse/PostToolUse/Stop) are not ported.
