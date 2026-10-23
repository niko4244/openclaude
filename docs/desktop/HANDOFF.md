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
- **Release:** `desktop-v0.1.0` published (approved by Nik): https://github.com/niko4244/openclaude/releases/tag/desktop-v0.1.0. The updater feed returns 200.
- **Nik's decisions:**
  - Publish: done.
  - Vision model: pulled `qwen2.5vl:7b` (vision but no tools in Ollama). `gemma4-local` → `gemma4-12b-64k` already has vision and tools.
  - Visual reference: "you figure it out".
  - Build the Chrome extension: in progress.
- **Chrome extension (uncommitted until its E2E passes):**
  - `desktop/chrome-extension/` (MV3), `src-tauri/src/chrome_bridge.rs` (token + `chrome-extension://` origin on `127.0.0.1:48751`), chat.rs `chrome__*` tools (approval-gated, never background or "always"), and a Settings panel.
  - Rust 71/71.
  - `e2e/chrome-extension.e2e.mjs` failed on a non-optimistic toggle. Fixed; re-run pending.
- **Vision:** the probe's 8×8 1-bit palette PNG is rejected by Ollama ("Failed to load image"). Switching to an RGB PNG, then re-probing `gemma4-local`. If vision works, run live computer use (screenshot only).
- **Last full gate:** E2E 38/38, a11y 0.

## Next steps (in order)
1. After the Chrome E2E and vision probe pass:
   - Commit, then work on visual reference (Nik said figure it out): compare against Anthropic's public Claude Desktop screenshots (help center), layout only, never brand colors.
2. Remaining partials:
   - Row 9: no public extension directory exists.
   - Row 18: computer use needs a vision model on the gateway.
   - Row 20: a published release; ask Nik first.
   - Row 24: a Chrome extension; deliberately replaced by the built-in browser.
   - Visual parity: needs side-by-side reference screenshots (ask Nik).
3. Remaining parity gaps:
   - An extension directory (needs a hosted index; none exists for MCPB yet).
   - Artifact in-panel editing.
   - Visual side-by-side baselines (needs reference screenshots Nik can provide; don't drive the Claude window, since it hosts this session).
   - Publishing a signed release (`scripts/release.ps1 -Publish`) is outward-facing. Ask first.
4. Verify these live when the resources exist: computer use (needs a vision model on the gateway), dictation (needs a mic), and remote MCP OAuth (needs a real provider).
