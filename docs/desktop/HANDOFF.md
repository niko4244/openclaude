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
- **Release:** `desktop-v0.2.0` published 2026-10-24 (approved by Nik) at https://github.com/niko4244/openclaude/releases/tag/desktop-v0.2.0, tagged at `db86d09f`.
  - The feed `releases/latest/download/latest.json` serves 0.2.0.
  - The installer's signature verifies against the embedded pubkey (scratch check with Python `cryptography`; a tampered copy fails).
  - Installed v0.1.0 apps update to it. On first launch, 0.2.0 seeds Ponytail and imports Nik's Claude plugins.
  - There's no installed copy on the dev machine to watch the update live.
- **Plugin system shipped:** commit `fca5dac4` (matrix row 26, tranche T10). Code is in `src-tauri/src/plugins.rs`.
  - Install from GitHub: marketplace.json or a plugin repo. Sparse shallow clones go to `<data>/plugins/repos/`.
  - Auto-update every 15 min. Rollback pins the plugin.
  - Import: the user's Claude Code and Claude Desktop plugins (GitHub source when known), plus `~/.claude` and `~/.openclaude` as user folders.
  - Ponytail is featured, and the first run seeds it plus the import (skipped when `OPENCLAUDE_DATA_DIR` is set, unless `OPENCLAUDE_PLUGIN_SEED=1`).
  - Chat gets `skills__search`/`skills__load`, a composer "/" menu, and SessionStart/UserPromptSubmit hook context. Hooks run through Git Bash with an isolated `CLAUDE_CONFIG_DIR` at `<data>/plugins/claude-config`.
  - Plugin `.mcp.json` entries become connectors: remote ones and those needing `${VAR}` start disabled.
  - Code tab and folder tasks pass `--plugin-dir` for enabled plugins, skipping ones the CLI already loads from `~/.claude`.
  - Evidence: plugins E2E 11/11 (19 of Nik's plugins found, 16 installed from GitHub, 752 components indexed); 9 unit tests.
- **Computer use:** the screenshot path is verified live. The vision reply timed out (HTTP 408); a direct replay ran at 2.7 tok/s with the GPU at 15.6/16.3 GB, so it is a local-throughput limit, not an app defect. Re-run `e2e/computer-use.e2e.mjs` when the GPU is free.
- **Artifacts:** React component artifacts run live in the sandbox (Babel in-frame, import map to esm.sh, Tailwind), Mermaid renders, and select-to-ask offers Improve / Explain. Commit `14cbfebf`.
- **Last full gate (`14cbfebf`):** desktop E2E 38/38, a11y 0, isolation 4/4, artifact-previews 4/4, plugins 11/11, Rust 80 (+9 live tests ignored). The voice E2E check flaked once on a model reply ("spåken") and passed on re-run.
- **Matrix:** every row is Operational except 25 (Office add-ins, simulators, BLE buddy), documented as not applicable.
- **Tranche T11 (since `ca519be8`):**
  - Computer use passes live 3/3 with a warm gemma4.
  - Layout geometry is measured from the reference bundle's CSS tokens (`resources/ion-dist`) and adopted: 768 px column, 18 px composer radius, 8 px base radius, 15 px / 1.4667 chat text.
  - Sync (`src-tauri/src/sync.rs`, Settings → General → Sync across devices; env `OPENCLAUDE_SYNC_DIR` for tests): e2e/sync.e2e.mjs 6/6.
  - Gate: desktop 38/38, a11y 0, Rust 82.
- **Title row (after `c6d44e17`):**
  - The separate 36 px title bar is gone. The sidebar runs to the top, with the wordmark, app menu and collapse in a 48 px draggable header row (`data-tauri-drag-region="deep"`).
  - Window controls (`WindowControls` in TitleBar.tsx) float over the top-right; rows under them reserve `--wc-inset`.
  - This matches the reference shell rendered from `resources/ion-dist` (VISUAL_BASELINES §1c).
  - The quick-entry and voice E2E checks now verify the feature, not the model's exact word.
  - Gate: desktop 38/38, a11y 0, artifacts 4/4.
- **Android devices (row 25, `src-tauri/src/devices.rs`):**
  - Settings → General → Android devices and emulators: SDK/adb discovery, devices + AVDs, create/boot.
  - Approval-gated `device__*` tools, treated like computer use.
  - Unit tests use a stub adb. There's no live E2E: this machine has `~/tools/adb` but no Emulator, system image or device. Installing the Android Emulator is a multi-GB download, so ask Nik first.
  - The Office add-in bridge and the BLE buddy are not reproducible. Microsoft 365 connectors are available through the directory.
- **Environment note:** E2E chat checks time out when two large local models fight for VRAM (qwen-local 11 GB at 262k context, gemma4 10 GB, plus an external `C:\llama.cppin\llama-server.exe` holding about 4.7 GB that something restarts). Unload one (`ollama stop <model>`) and re-run.
- **Visual reference:** a passive screenshot found no visible Claude window on any of the 3 monitors (minimized). Pixel baselines still need a reference image from Nik in `docs/parity/reference/`.

## Next steps (in order)
1. Next releases: bump the version in package.json, package-lock.json (root entries), tauri.conf.json, Cargo.toml and Cargo.lock, then commit, push, and run `scripts/release.ps1 -Publish`. Publishing is outward-facing: ask Nik first.
2. Visual: compare against reference screenshots once Nik drops them into `docs/parity/reference/`.
3. Remaining gaps:
   - Artifact in-panel editing.
   - Chat does not run PreToolUse/PostToolUse/Stop hooks (the CLI does in the Code tab).
   - npm/pip plugin sources.
   - Pixel-level visual baselines (needs reference screenshots).
   - Computer-use vision reply on a faster model or free GPU.
