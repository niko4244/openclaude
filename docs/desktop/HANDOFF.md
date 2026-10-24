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
node e2e/evolution.e2e.mjs          # 43/43, no model or network
node e2e/perf.e2e.mjs               # baseline: cold ~0.65 s, idle ~397 MB
```

**Gotchas:**
- MSVC: always use `scripts/with-msvc.ps1`. VS2026 Build Tools has no C++ toolset (LNK1104).
- Window-creating Tauri commands must be `async` (a sync one deadlocks on Windows).
- PowerShell eats a bare `--`, so quote it as `'--'`.
- Writing regex or backslash-heavy code through bash heredocs mangles it. Use the Write tool or a Python script file.
- `npm` lock: `desktop/package-lock.json` is force-tracked (the root .gitignore ignores lockfiles).

## State at last checkpoint
- **Release:** `desktop-v0.3.0` published 2026-10-24 (approved by Nik), Latest, at https://github.com/niko4244/openclaude/releases/tag/desktop-v0.3.0.
  - It was built from a clean worktree at `d5bc3652` (on G:) because another agent had uncommitted changes in this checkout (`mod evolution` in lib.rs, `evolution.rs`, `AGENTS.md`, `feature-intel/monitor.mjs`). Those changes are not in the release and were left untouched.
  - The feed serves 0.3.0; the installer signature verifies and a tampered copy fails.
  - Installed 0.1.0/0.2.0 apps update automatically (0.2.0 and later check every 4 h; 0.1.0 through About → Check for updates).
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
- **Settings dialog (`fbcfe1e6`):**
  - Settings is now a modal over the page you came from (`underPage`/`view` in App.tsx), with a grouped icon nav, filter, close × (`aria-label="Close settings"`, the E2E selector), switches and a segmented theme control.
  - Pages are full width.
  - Gate: desktop 38/38, a11y 0, plugins 11/11.
- **Neutral palette:** sidebar, main and divider are pixel-identical to the reference in light and dark (VISUAL_BASELINES §1c). The accent, logo and fonts stay ours by mission rule. a11y 0 in both themes.
- **iPhone / live device test:** skipped at Nik's request (2026-10-24). The phone was only on Bluetooth. Android device tools stay verified by unit tests against a stub adb (matrix row 25: Partial). Revisit only if Nik connects an Android device or enables Windows Hypervisor Platform for the emulator.
- **System prompt (`src-tauri/src/sysprompt.rs`):** OpenClaude's own wording, not copied from anywhere.
  - Structure: a core under 400 words (honest identity as `{model}`, answer first, scope, one question at most, finish-or-say, cutoff honesty, short refusals, wellbeing), plus modules added only when active:
    - artifacts (always)
    - tools: tool output is data, never invent results, denied means adjust, spell out irreversible actions, look before deleting
    - no-search notice
    - skills
    - screen/browser tier order and failure stop
    - background runs (actions go to the inbox)
  - Order: core, modules, then the user's custom instructions and project instructions, so they win.
  - How it was written: Nik pointed at `asgeirtj/system_prompts_leaks`. A research agent read the Claude prompts there as data and produced a paraphrased behavior checklist. The leaked text is proprietary and is not used. Unit tests check the module selection and the core length.
- **Merged 2026-10-24 (approved by Nik):** `feat/record-skill`, `feat/desktop-prompt-library` and `feat/desktop-code-extras` are merged into `feat/desktop-2.0`.
  - Full gate on the merged tree: tsc 0, Rust 120, desktop 38/38, a11y 0, providers 6/6, diagnostics 6/6, inbox 7/7, record-skill 13/13, prompt-library 20/20, code-extras 20/20, artifact previews 4/4, isolation 4/4, sync 6/6, plugins 11/11.
  - Model-dependent suites need warm models (pre-warm qwen-local / llama3.2:3b). A full GPU (other llama-server processes) makes cold loads exceed test timeouts.
  - C: was down to 1.8 GB. Clearing `src-tauri/target/debug` and the record-skill worktree's target freed about 25 GB; both regenerate.
- **Session 2026-10-24 (after the v0.2.0 release):**
  - Providers (row 27), self-maintenance (row 28), Duet-style proactive assistant and approvals inbox (row 29), and the repo secret scan (clean).
  - Ponytail (row 26) re-verified on the installed 0.3.0 build (2026-10-24): `e2e/plugins.e2e.mjs` **11/11** with the gateway and `qwen-local`. It installed `DietrichGebert/ponytail` v5.3.2 from GitHub, detected its session hook, put 2911 chars of hook context in the system prompt, imported 20 plugins (16 from GitHub) out of 19 found, indexed 755 components, checked for updates, sent `/ponytail` from the composer and let the model find a skill itself. No repository change was needed: the plugin manager, the featured card and the first-run seed already exist.
  - Duet (row 29) re-verified on this build (2026-10-24): `e2e/inbox.e2e.mjs` **7/7** with a direct Ollama model (`OC_INBOX_MODEL=qwen3.8-9b-abliterated:q4_K_M`): a background run queues the unapproved connector tool, the chat records that it is waiting, approving runs it, the assistant continues in that chat, the inbox clears, and the Proactive assistant card creates the morning brief and check-ins. `llama3.2:3b` instead wrote a text-shaped pseudo tool call and queued nothing, so 3B models cannot drive this suite on this machine. The Rust side is covered by `inbox::tests` 2/2.
  - Parallel sessions, each in its own worktree and branch, to be merged after review:
    - `record-skill`: Record a skill (Claude Cowork, July 2026).
    - `prompt-library`: prompt library with GitHub collections.
    - `code-extras`: web device emulation, SSH remote coding, original pixel mascot.
  - Shared E2E lock: `mkdir "$TEMP/oc-e2e.lock"` before any app launch, `rmdir` after. The app is single-instance.
  - Gateway outage since about 00:57 on 2026-10-24: LiteLLM's local routes (qwen-local, gemma4-local) return "Connection error". Ollama restarted (v0.40.8) and the container can't reach it, though 127.0.0.1:11434 works. Model E2E steps use the direct Ollama provider meanwhile. Fixing it is Nik's call (firewall or Ollama binding).
- **Environment note:** E2E chat checks time out when two large local models fight for VRAM (qwen-local 11 GB at 262k context, gemma4 10 GB, plus an external `C:\llama.cppin\llama-server.exe` holding about 4.7 GB that something restarts). Unload one (`ollama stop <model>`) and re-run.
- **Visual reference:** a passive screenshot found no visible Claude window on any of the 3 monitors (minimized). Pixel baselines still need a reference image from Nik in `docs/parity/reference/`.

## Record a skill (branch `feat/record-skill`)
- **What:** Cowork-style "Record a skill". Composer tools menu → Record a skill → the main window minimizes and a small always-on-top indicator (`recorder` window) records the primary screen. Narrate by microphone (setting `record_mic`) or type notes in the indicator; Stop opens a review dialog in the main window; the chosen vision model (setting `record_model`, default `gemma4-local`) drafts a SKILL.md you edit and save.
- **Code:**
  - `src-tauri/src/recorder.rs`: sampler (64x36 luma fingerprints; visible change ≥1% of pixels is kept at once, smaller changes every 2 s, ≤0.2% is a duplicate; cap 60 thins the most redundant interior frame), session (one at a time, static), prompt, draft parsing, `write_skill`, `register`.
  - `computer.rs` now exposes `grab`/`fit`/`png` for reuse. `plugins.rs` has `reindex()`.
  - `shell.rs` `open_recorder`/`close_recorder`. The indicator uses `content_protected(true)` (WDA_EXCLUDEFROMCAPTURE), so it is not in its own frames, and is on the window-state denylist.
  - Commands `record_*` in `lib.rs`; UI `components/RecorderBar.tsx` (indicator) and `components/RecordSkillDialog.tsx` (review).
- **Files:** frames in `<data>/recordings/<id>/` (deleted on save, cancel, discard, when the indicator window is destroyed while recording, and at app start). Skills in `<data>/recorded-skills/skills/<name>/SKILL.md`, registered once as the user-scope plugin `recorded-skills`.
- **Test:** `node e2e/record-skill.e2e.mjs` (13/13 twice with gemma4-local through the gateway; generation took 152 s and 177 s). If the gateway's local models are down, `OC_RECORD_MODEL=ollama::gemma4-12b-64k:latest` makes the E2E add the direct Ollama provider. Unit tests: `cargo test --lib record` (10).
- **Gotchas:** a cold gemma4 load takes about 2 minutes, so warm it first. The E2E uses typed notes, so the microphone path is untested live (it reuses `voice::transcribe`). Recorded skills reach chat (the "/" menu, skills__search / skills__load) but not the Code tab CLI, because user-scope plugins are not passed as `--plugin-dir`.

## Prompt library (matrix row 31, branch `feat/desktop-prompt-library`)
- **Worktree:** `C:\Users\nikma\Desktop\oc-prompt-library`, branched from `feat/desktop-2.0` at `a03782ad`. Not merged.
- **Code:**
  - Backend: `src-tauri/src/prompts.rs`. It reuses `plugins.rs` (install, update, rollback, remove, `md_files`, `frontmatter`) through a second `Plugins` instance, `AppState.prompts`, rooted at `<data>/prompts`. So prompt collections never run hooks, add MCP connectors or reach the CLI's `--plugin-dir`.
  - UI: `src/components/PromptLibrary.tsx`, with the library dialog, the fill-in dialog and the Settings tab.
  - Hooks in other files: `Composer.tsx` (book button, `insert` prop, a "/" pick of a prompt) and `App.tsx` (dialogs; `.app` goes inert while one is open).
- **Collection layouts:**
  - (a) A Claude plugin's `commands/**/*.md`: when a `commands/` folder exists, only it is read.
  - (b) A plain folder of `*.md`: hidden folders and README / LICENSE / CONTRIBUTING / CHANGELOG / CODE_OF_CONDUCT / SECURITY / CLAUDE / AGENTS are skipped. The front matter `title`, `description`, `tags` (list or `[a, b]`) and `category` are read. A leading `# Heading` becomes the title and is not inserted.
  - (c) "My prompts": registry id `mine`, files in `<data>/prompts/mine/<kebab-title>.md`, created on first use. It can't be removed or switched off.
- **Install specs:** `owner/repo`, a GitHub folder URL `https://github.com/o/r/tree/<ref>/<path>` (installed as `<repo>-<folder>`), a marketplace repo (pick entries), or any git URL. `file://` git URLs are now accepted, for plugins too.
- **Updates:** the 15-minute plugin loop also runs `state.prompts.update_all()` and emits `prompts-changed`. The Composer's "/" cache and the open dialogs listen for that event.
- **Favorites:** `<data>/prompts/favorites.json`, keyed by prompt id `<collection id>/<name>`.
- **Placeholders:** `$ARGUMENTS`, `$1`-`$9` and `{{name}}` are filled in one pass. An empty value keeps its placeholder.
  - A prompt picked in the "/" menu opens the same fill-in dialog and inserts its text.
  - A fully typed `/collection:prompt args` that is sent still expands like a command (`slash_expand` falls back to prompts).
- **Anthropic's library:** https://code.claude.com/docs/en/prompt-library is linked from the library footer and from Settings. Its text is never bundled or copied, and no collection is preinstalled.
- **Verify:**
  - `cargo test --lib` (`prompts::tests`, 6 tests).
  - `node e2e/prompt-library.e2e.mjs`: no model or gateway needed. It builds a `file://` git fixture and restores the clipboard text after the Copy check.
  - `node e2e/a11y.e2e.mjs`: now also scans the library (light and dark), the new-prompt form, the fill-in dialog and Settings → Prompt library.
- **Last run:** prompt-library E2E 20/20; a11y 0 across 28 states; Rust 96 passed, 9 ignored. The a11y dark scan surfaced a gap that predates this work: dark theme never redefined `--err`, so `.btn.danger` was 3.2:1. Dark now uses `--err: #f07a73` (about 6:1).
- **Disk:** C: had under 2 GB free, so this worktree builds with `CARGO_BUILD_BUILD_DIR` pointing at the main checkout's `src-tauri/target`, `node_modules` as a junction to the main checkout's, and `npx tauri build --no-bundle`.

## Code tab extras (branch `feat/desktop-code-extras`, not merged)
- **Where:** worktree `G:\oc-build\oc-code-extras` (G: because C: was nearly full and the side-session Write/Edit hook blocks everything under `C:\Users\nikma`). Build with `$env:CARGO_TARGET_DIR = "G:\oc-build\code-extras"`; the exe is `G:\oc-build\code-extras\release\openclaude-desktop.exe`. `desktop/node_modules` there is a junction to the main checkout's.
- **Device preview (web emulation):** Code tab → **📱 Device**, or **📱 Device preview** next to a detected dev-server URL in the Terminal.
  - Backend: `browser.rs` § device preview. A separate **headless** Edge/Chrome on `<data>/device-preview` (not the model's browser profile).
  - CDP: `Emulation.setDeviceMetricsOverride` + `setTouchEmulationEnabled` + `setUserAgentOverride` (UA client hints for Android), and `Page.startScreencast` frames streamed to `DevicePreview.tsx`. The panel draws the device outline (island / home button / punch hole / tablet) and forwards taps (`Input.dispatchTouchEvent`), wheel and keys.
  - Presets: iPhone 16 Pro 402×874@3, iPhone SE 375×667@2, Pixel 8 412×915@2.625, Galaxy S24 360×780@3, iPad 820×1180@2. Rotate resizes without a reload; a device switch reloads (touch and UA are read at document load).
  - Local URLs only (`is_local_preview_url`). It is labelled "Web emulation", not a native simulator: no WebKit, no OS chrome, no native APIs.
  - Gotcha: start the screencast **before** `Page.navigate` / `Page.reload`; mid-navigation Chromium answers "Not attached to an active page".
- **Android emulator from the Code tab:** the device panel's footer reuses `devices_info`. It shows Start buttons for AVDs when an Emulator exists; otherwise a setup hint. `devices.rs` now also reports Windows Hypervisor Platform read-only (`Win32_OptionalFeature`, no elevation); it is off on this PC (InstallState 2). Nothing changes system settings.
- **Remote (SSH):** the folder button is now a menu: Local folder… / Remote (SSH)….
  - Host comes from the `~/.ssh/config` Host entries (datalist) or typed `user@host`; the folder must be absolute or `~/…`.
  - `remote_add` asks in a **native** dialog (page script can't answer it), like the folder picker grants local folders. Grants live in setting `remote_workspaces`, which the UI can't write directly.
  - `remote_check` runs a read-only script over ssh: Node, `command -v openclaude`, git. When the CLI is missing it shows `npm install -g @gitlawb/openclaude` (Node 20+).
  - `code_start{host}` spawns `ssh -T -o BatchMode=yes … -o ExitOnForwardFailure=yes -R 127.0.0.1:<rand>:127.0.0.1:4000 -- host '<script>'`. The script runs `exec openclaude --print … --input-format/--output-format stream-json [--permission-prompt-tool stdio]`, so approvals work exactly as locally.
  - The API key is the **first stdin line**, read by `IFS= read -r` (a shell builtin): never on a command line on either machine, never logged.
  - git status/diff go over ssh (remote status polls every 15 s). The terminal and worktrees are local-only and hidden for SSH folders. Plugins aren't passed to remote sessions.
  - Known ssh failures (host key, publickey, forwarding refused, unreachable, missing folder or CLI) become plain-words hints (`ssh_error_hint`).
- **SSH not live-tested:** there is no local sshd (`Get-Service sshd` → none). Command construction, quoting, injection rejection, tunnel rewrite, config parsing and hints are unit-tested (`agent::tests::ssh_*`, `tunnel_*`, `remote_*`). The running podman WSL machine exposes an sshd, but it wasn't used: it's infrastructure, and the brief said to test only against an existing sshd service.
- **Pip, the mascot** (`Pip.tsx`): an original 15×15 pixel robot in our teal (`--accent`) with an amber antenna spark (not a crab, not clay). Shown in the Code empty state ("Ready when you are") and as the working indicator (`.pip-working`, role=status). It blinks when idle; working, it hops, glances and its spark flickers. Under `prefers-reduced-motion` everything stops.
- **Evidence (2026-10-24):**
  - `e2e/code-extras.e2e.mjs` 20/20. It needs no model: the working indicator runs against a stub CLI via `OPENCLAUDE_BIN`.
  - a11y 0 across 26 states, including the new code folder menu, Remote (SSH) form and device preview.
  - Rust lib 102 passed (10 live tests ignored), plus the ignored live `device_preview_live_emulates_iphone` passing.
  - `diagnostics.e2e` passes its Code-tab flow, but its `/openclaude/i` check on the checkout path fails for this worktree's name (`oc-code-extras`).
  - The gateway's local models were down this session (LiteLLM can't reach Ollama), so `desktop.e2e` wasn't re-run. Its step 13 selectors (`.nav-item.mono`, Terminal) are unchanged.
- **Merge note:** the sibling branches (record-skill, prompt-library) also touch `lib.rs` command registration, `styles.css`, the matrix and this file. Expect small textual conflicts.

## Evolution Engine (feature parity, 2026-10-24)
- **What:** `desktop/feature-intel/` is now the OpenClaude Evolution Engine, not a one-off script.
  - Durable `registry.json` (signals with provenance + classified features with parity/state) and `ledger.json` (implementation tasks).
  - One sweep (`lib/engine.mjs`) shared by the CLI, the desktop ticker and CI; conditional requests, retries, per-source failure isolation, lock with stale takeover, atomic writes.
  - REA (`lib/rea.mjs`) is a probe + plan writer. It never installs REA and records `blocked` when it is absent.
  - Pipeline (`lib/pipeline.mjs`): spec, isolated worktree plan, ledger, allowlisted gates, PR draft. Guards: `guardInference` (no unauthorized paid calls), `assertIsolatedWorktree` (never the checkout).
  - Roles in `desktop/feature-intel/agents/`; design in `docs/openclaude-evolution-engine.md`.
- **App:** new **Evolution** page (`src/components/Evolution.tsx`, `src-tauri/src/evolution.rs`), sidebar entry, commands `evolution_status`, `evolution_check`, `evolution_configure`, plus a 15-minute ticker that only runs a sweep when one is due.
- **CI:** `.github/workflows/claude-feature-watch.yml` runs every 6 h, commits the registry to `evolution/registry` and opens/updates a PR. It never pushes to `main` and never runs third-party code.
- **Commands:** `bun run evolution` (CLI), `bun run evolution:check`, `bun run test:evolution`; in the app, Evolution → Check for Claude updates / Pause.
- **Verified 2026-10-24:** engine tests 33/33, Rust lib 129 passed (7 `evolution::` tests), `tsc -b` 0, `vite build` ok, eslint 0 errors. Live sweep: 141 signals from 8 sources, second run +0 (idempotent). Three real signals classified as `partial` with matrix-based notes; `docs/feature-parity.md` generated. REA is not installed on this machine, so `investigate` correctly returned **blocked** (exit 2). A temp-copy end-to-end run produced a ledger task, executed a real gate, and wrote a PR draft with the gate result (`ready-for-review`).
- **Real-app E2E (`e2e/evolution.e2e.mjs`, 43/43 on 2026-10-24):** five launches against a rebuilt release exe.
  - No registry (explicit `OPENCLAUDE_EVOLUTION_DIR`): empty state, disabled Check, no Pause, no invented cards.
  - Populated registry, no CLI: counts, 50% coverage, failed-source error, gap-first ordering, blocker + source, ledger row, read-only label, no editable controls.
  - Engine with a stub CLI: `check --quiet --json` is what the app runs (asserted from the stub's argv and cwd), toast shows +2, the page reloads the new registry, Pause/Resume and interval/autonomy write `config.json` while preserving other keys.
  - Corrupt registry (a file truncated mid-write): the page says **Feature registry could not be read** with a `corrupt` badge, names the parse error and the path, invents no counts, disables Check, and leaves the broken file untouched. `evolution_status` now reports `registry_state` = `ok` / `missing` / `invalid` / `unreadable`, so a truncated file no longer looks like a machine that never synced.
  - Engine exits 3: the toast is `Check failed (failed, exit 3): …` with the engine's stderr, no success toast, the registry still holds the last good numbers, and Check is usable again afterwards. The success path, partial failures and `locked` / `disabled` remain distinct.
  - Runs under the shared `%TEMP%/oc-e2e.lock`; each launch gets an OS-assigned port (fixed ranges collided with an unrelated service).
- **Accessibility (`e2e/a11y.e2e.mjs`, 2026-10-24):** the audit now scans the Evolution page in six states — empty, populated and corrupt-registry, each light and dark (37 states total, still **0** violations, exit 0). The empty state is scanned first; the audit then writes a fixture registry into the same `OPENCLAUDE_EVOLUTION_DIR` and presses Refresh, so the states come from one launch. The corrupt state overwrites `registry.json` with truncated JSON, refreshes, and first asserts the card names the parse failure ("not valid JSON", with the path) and carries the `corrupt` badge — so it cannot silently pass as the empty state — then scans light and dark (`a11y-evolution-corrupt-light.png` / `-dark.png`).
- **Error states (2026-10-24):** `evolution_status` distinguishes a missing registry from an unreadable or invalid one (`registry_state`), and the page renders that difference instead of claiming "No registry yet". A sweep whose engine exits non-zero is reported as a failure with the exit code and the engine's stderr, and never as a `+0 new` success. Rust `evolution::` tests 7/7 (corrupt registry, non-zero exit, and a test tempdir fix: two parallel tests could share a name and race).
- **Not verified:** the desktop ticker was not observed firing (it needs 15 minutes plus a due registry). The workflow has not run on GitHub.

## Bots (persistent teammates, 2026-10-24)
- **What:** a **Bots** page and a roster of persistent bots, shaped after the Grok Bot roster as the open-source takes describe it (persona, memory, per-bot model, folder, one continuing thread, approvals for risky actions). Design and scope in [BOTS.md](BOTS.md). No third-party code was copied.
- **Where:** migration v7 in `src-tauri/src/db.rs`, logic and prompt block in `src-tauri/src/bots.rs`, injection in `chat.rs` (`system_prompt`), commands `bots_list` / `bot_save` / `bot_delete` / `bot_chat` in `lib.rs`, UI in `src/components/BotsPage.tsx` + the sidebar entry.
- **Verified:** `bots::tests` 5/5 and the full Rust library 134 passed; `e2e/bots.e2e.mjs` **16/16** against a stub OpenAI-compatible server (no model): provider added, app restarted so the catalog is the real startup path, bot created from the form, persona/memory/folder asserted in the captured system prompt, per-bot model requested, thread reused on reopen, edited memory reaches the next request, deletion keeps the chat. `tsc -b` 0, eslint 0 errors.
- **Real model (`e2e/bots-real.e2e.mjs`, 12/12, 2026-10-24):** with Ollama `qwen2.5vl:7b`, a plain chat could not name the project or release day; a bot with the persona "laconic lighthouse keeper" and memory naming Tallow/Thursday/three engineers answered "I am Kestrel…", "Your project is called Tallow, and you release it on Thursdays.", "Your team has three engineers." A fresh plain chat afterwards still did not know the project, so the knowledge is in that bot's thread. Cold start 105 s, warm turns 0.7–13.5 s. Persona shaped name and style but the model called itself the keeper's *assistant*, so treat persona as an influence, not a guarantee. Manual (needs local Ollama).
- **REA:** `npx rea-agents@latest setup` ran with approval and configured detected MCP clients, but ships no `rea` binary and no MCP client is available here; `cli.mjs rea` still reports `ENOENT`. The research was direct reading of rakazo and OpenMausBot; no REA run is claimed.
- **Not built:** autonomous routines, a per-bot cloud computer/VM, automatic memory accumulation, bot-to-bot delegation, channels, or prebuilt bot teams.

## Installer-owned shortcuts (2026-10-24)
- **Change:** `src-tauri/installer/nsis-hooks.nsh`, wired through `bundle.windows.nsis.installerHooks`, creates the Desktop and Start Menu shortcuts on every NSIS install, in `$INSTDIR`. Previously the Desktop shortcut depended on the finish-page checkbox (or a silent install), and the shortcuts in use were made by hand against `target/release`, which a `cargo clean` or a moved checkout would break. WiX already declares both (`ApplicationShortcutDesktop`, `ApplicationShortcut`), so neither installer needs a second mechanism.
- **Verified:** built `OpenClaude_0.3.0_x64-setup.exe`, installed silently (`/S`, exit 0) to `%LOCALAPPDATA%\OpenClaude`. `Desktop\OpenClaude.lnk` and `%APPDATA%\Microsoft\Windows\Start Menu\Programs\OpenClaude.lnk` both target the installed `openclaude-desktop.exe` (product version 0.3.0), and launching the Desktop shortcut started that exe with a responding "OpenClaude" window. The old hand-made `OpenClaude Desktop.lnk` pair was removed, leaving one installer-owned shortcut per location.
- **Not verified:** the uninstall path (the template removes both shortcuts; the hook repeats the Desktop delete), and an MSI install on this machine (the bundle builds; its WiX template already defines the shortcuts).

## Next steps (in order)
1. Next releases: bump the version in package.json, package-lock.json (root entries), tauri.conf.json, Cargo.toml and Cargo.lock, then commit, push, and run `scripts/release.ps1 -Publish`. Publishing is outward-facing: ask Nik first.
2. Visual: compare against reference screenshots once Nik drops them into `docs/parity/reference/`.
3. Remaining gaps:
   - Artifact in-panel editing.
   - Chat does not run PreToolUse/PostToolUse/Stop hooks (the CLI does in the Code tab).
   - npm/pip plugin sources.
   - Pixel-level visual baselines (needs reference screenshots).
   - Computer-use vision reply on a faster model or free GPU.
