# OpenClaude Desktop: release readiness

Updated: 2026-10-23 (tranches T1–T8) · Branch: `feat/desktop-2.0` · PR: niko4244/openclaude#1
**Verdict: strong developer preview.** 14 of 25 parity rows operational, 9 partial (computer use, voice and remote-MCP OAuth are implemented and
unit/mock-verified but not exercised live), 1 missing (browser extension), 2 not planned. See `docs/parity/FEATURE_MATRIX.md`.

## Build artifacts

| Artifact | Notes |
|---|---|
| `bundle/nsis/OpenClaude_0.1.0_x64-setup.exe` (~5 MB) | per-user install, registers `openclaude://` |
| `bundle/msi/OpenClaude_0.1.0_x64_en-US.msi` (~7 MB) | |
| `release/openclaude-desktop.exe` | portable; deep links need the installer |

`scripts/release.ps1` produces signed updater artifacts plus `latest.json`. The private key lives outside the repo in
`~\.tauri`. With `-Publish` it creates a GitHub release on the fork. Nothing has been published yet. The binaries are not
Authenticode-signed, so SmartScreen will warn.

## Evidence

### Real-desktop E2E on the packaged exe (`desktop/e2e/desktop.e2e.mjs`): 31/31 pass (cold start 0.8–3.0 s, warm 0.6–1.3 s across runs)
These run against the live LiteLLM gateway with `qwen-local`, using an isolated profile and two launches:

- **Startup and catalog:** cold and warm start; gateway status; live catalog (124 models).
- **Chat:** streaming; routing metadata; persistence and auto-titles; stop keeps the partial reply; find in chat; regenerate plus branch navigation (2/2 → 1/2).
- **Tools:** MCP connector added through Settings; approval card leading to tool execution.
- **Artifacts:** titled artifact auto-opens as a card in the panel; the artifact frame cannot invoke app commands.
- **Shell:** shortcuts sheet; settings lock (the UI cannot grant itself folders or swap the agent binary); Quick Entry window hand-off; deep link `openclaude://new?prompt=…` prefills without sending.
- **Code workspace:** recent folder, command runner, git status.
- **Projects and tasks:** project knowledge answers from the file ("BLUE-HERON-7"); task created in the UI, run in the background, result opened as a chat.
- **Updates:** the update check reports its status. No release is published yet, so it truthfully reports that no release JSON was found.

### Artifact isolation (`desktop/e2e/artifact-isolation.e2e.mjs`): 4/4
A hostile artifact cannot invoke commands, reach `window.parent`, or fetch `ipc.localhost`.

### Rust (`cargo test --lib`): 53 pass, 3 ignored (live gateway, live probe, local Whisper download)
Coverage includes:
- **Gateway and chat:** gateway normalization and tool-call merging; orphan tool-call repair; context compaction cut selection.
- **Storage:** SQLite migrations v1–v4; branch switching.
- **MCP and extensions:** a real stdio MCP round-trip; `.mcpb` install of a real bundle that then runs as a connector; zip-slip and bad-name rejection.
- **Projects:** project-knowledge retrieval (BM25 finds the relevant paragraph in a file far over budget).
- **Tasks:** schedule math and no-double-run claiming.
- **Security and plumbing:** settings allowlist; deep-link parsing; Markdown export; CLI adapter flags; shell runner.

### Live capability probe (opt-in, content-validated)
- `qwen-local`, `coder-local` and `brainz-chain` pass chat, streaming, system prompt, tools and JSON. All three fail vision.
- Most cloud aliases on this gateway currently fail upstream on credits, quota or 404s. That is the provider accounts, not the app.

## Known gaps
- **Built but not verified live:** computer use (no vision model on this gateway), dictation (no microphone in automated runs), and remote MCP OAuth/SSE (mock servers only).
- **Not built yet:**
  - Extension signature verification and an extension directory.
  - A Cowork-style VM and spaces.
  - Interactive per-command approval for the Code-tab CLI agent.
- **Release prerequisites:** a first published release and code signing.
- **Platform:** the menu lives in the frameless title bar (no Win32 menu bar). Keyboard shortcuts are handled in the webview.
- **Attachments:** implemented through the native picker and drag-drop, but not automated in E2E because native dialogs can't be driven over CDP.
