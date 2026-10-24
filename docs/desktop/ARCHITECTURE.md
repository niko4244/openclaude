# OpenClaude Desktop: architecture

Status: accepted, 2026-10-22. Code: `desktop/` (Tauri 2 + React/TS). Tracking: `docs/parity/`.

## ADR-001: Tauri 2 over Electron

| Criterion | Tauri 2 (chosen) | Electron | Evidence on this machine |
|---|---|---|---|
| Startup / memory | System WebView2, single native exe | Bundles Chromium + Node | WebView2 155 installed; measured startup in `e2e/out/results.json` |
| Installer size | Small NSIS/MSI (MBs) | ~100 MB+ | `tauri build` output |
| Streaming | SSE parsed in Rust (`reqwest`), pushed via typed IPC `Channel` | Node streams over IPC | `gateway::stream_chat` |
| MCP stdio processes | `tokio::process`, CREATE_NO_WINDOW, kill-on-drop | Node child_process | `mcp.rs` round-trip test |
| Security isolation | Capability-scoped IPC, CSP, custom-protocol origin for artifacts | Needs careful contextIsolation/preload hardening | `capabilities/default.json`, `serve_artifact` |
| GUI fidelity | Same web stack as Electron (React/CSS) | Same | n/a |
| OpenClaude compatibility | Agent runtime stays the existing TS CLI, driven over stream-json (planned adapter) | Could import TS directly | `gui/server.ts` proves the stream-json path |
| Toolchain | Rust 1.95 + MSVC (VS2019 toolset; see `scripts/with-msvc.ps1`) | Node only | |

Electron would win only if we needed to `import` the OpenClaude CLI modules in-process. We don't. The CLI already speaks a stable
stream-json protocol, so it runs as a child process from either shell.

## Layers

```
React UI (src/)  ── presentation only: no network, no fs, no secrets
   │  invoke()/Channel  (capability-scoped Tauri IPC)
Rust core (src-tauri/src/)
   ├─ gateway.rs   LiteLLM: /health, /v1/models, /model/info → ModelEntry; SSE chat; tool-call merge;
   │               captures requested vs served model + x-litellm-* routing headers
   ├─ chat.rs      context build (global + project instructions), agent/tool loop (≤25 steps),
   │               approval gate, cancellation (Notify), persistence of every turn incl. partial/error
   ├─ mcp.rs       MCP client: stdio + Streamable HTTP, initialize/tools/resources/prompts,
   │               config in Claude-Desktop-compatible `mcpServers` JSON, read-only import
   ├─ db.rs        SQLite (WAL, migrations via PRAGMA user_version); edits supersede, never delete
   ├─ state.rs     shared state; API key from Windows Credential Manager → env fallback
   └─ lib.rs       commands, artifact protocol, drag-drop, plugins, lifecycle
LiteLLM gateway (127.0.0.1:4000) ── the only inference path; local (Ollama/vLLM/…) and cloud behind it
```

Provider routing and agent orchestration live in Rust, outside the presentation layer. The UI never sees credentials.

## Model metadata truthfulness

`ModelEntry` fields come from LiteLLM `/model/info`. Undeclared values are `null` and render as **unknown**. On the live gateway
(124 aliases) most capability fields are undeclared, so the picker only shows badges the gateway actually asserts.
`local` is derived from the backend host (localhost / host.containers.internal / host.docker.internal) or a local provider prefix.
Each reply records `model_requested`, `model_served` (from the response body), `routed_host` (from `x-litellm-model-api-base`) and
`fallbacks` (from `x-litellm-attempted-fallbacks`). The UI shows any difference, so a silent substitution is visible.

## Evolution Engine (feature parity)

`evolution.rs` reads the repository's feature registry (`desktop/feature-intel/registry.json`) and exposes
`evolution_status`, `evolution_check` and `evolution_configure`. It is deliberately read-mostly: the sweep is the
same Node engine the six-hour GitHub workflow runs, so the app cannot drift into a second implementation.
Resolution order is `OPENCLAUDE_EVOLUTION_DIR`, a registry synced into `<data>/evolution`, then a checkout found by
walking up from the working directory or the executable. Without a checkout the page says so and "Check now" stays
disabled. The 15-minute ticker is inert unless `config.json` enables it, Node is present, and a sweep is due; the
engine's own lock prevents a manual and a scheduled sweep from running together. Nothing in this path writes
outside the registry/config/ledger or calls a model.

## Security model

- IPC: one capability (`default`) for the `main` window; plugins limited to dialog, clipboard write, notification, open-url, and global shortcut.
- CSP: `script-src 'self'`, no remote scripts, `frame-src` only the artifact origin.
- Artifacts: untrusted HTML is served from `artifact:` (`http://artifact.localhost` on Windows) with its own CSP that cannot reach
  `ipc.localhost`, inside `<iframe sandbox>` without `allow-same-origin`. The E2E test asserts that `__TAURI_INTERNALS__` is absent.
- Files: the UI cannot read arbitrary paths. Attachments come only from a backend-run file dialog or an OS drag-drop event.
- Tools: every MCP call needs approval unless the user chose "Always allow" for that exact tool (`tool_policy:<name>`).
  Tool output is capped at 60 KB and treated as data.
- Secrets: the gateway key lives in Windows Credential Manager (`openclaude-desktop/litellm-api-key`). It is never stored in SQLite.
  Imported MCP env values are masked in the UI.
- Config writes: `mcp.json` is written atomically with a `.bak`. External registries (`~/.openclaude.json`, `~/.claude.json`,
  Claude Desktop config) are read-only.
- Markdown: `skipHtml`. Links open in the system browser (http/https only). Remote images are not loaded.

## Known gaps (see FEATURE_MATRIX)

Not done yet: the coding-agent adapter (OpenClaude CLI stream-json), message branching UI, context compaction, legacy SSE MCP transport,
MCP resources/prompts UI, OAuth for remote MCP, voice, computer use, scheduled tasks, auto-update, and code signing.
