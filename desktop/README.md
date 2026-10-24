# OpenClaude Desktop

A Windows desktop AI workspace that runs on **your own LiteLLM gateway**: local models (Ollama, vLLM, llama.cpp…) and any
cloud provider behind it. No Anthropic account needed. Built with Tauri 2 (Rust) + React/TypeScript.

Architecture and security model: [`docs/desktop/ARCHITECTURE.md`](../docs/desktop/ARCHITECTURE.md).
Parity status vs Claude Desktop: [`docs/parity/FEATURE_MATRIX.md`](../docs/parity/FEATURE_MATRIX.md).

## Install

Run the installer from `src-tauri/target/release/bundle/nsis/` (per-user, no admin) or the MSI from `bundle/msi/`.
On first launch open **Settings → Gateway**:

- **Gateway URL**, default `http://127.0.0.1:4000`
- **API key**, a LiteLLM key, stored in Windows Credential Manager

Alternatively set `OPENCLAUDE_LITELLM_KEY` (or `LITELLM_API_KEY`) and optionally `OPENCLAUDE_GATEWAY_URL` in the environment.

## Develop

Requirements: Node 20+, Rust 1.90+, MSVC C++ x64 toolset, WebView2.

```powershell
npm install
.\scripts\with-msvc.ps1 npx tauri dev       # dev window with HMR
.\scripts\with-msvc.ps1 npx tauri build     # release exe + NSIS + MSI
```

`scripts/with-msvc.ps1` picks a Visual Studio instance that actually has the C++ toolset. It exists because rustc's
auto-detection can pick an instance without one and fail with `LNK1104 msvcrt.lib`.

## Test

```powershell
npm run typecheck
.\scripts\with-msvc.ps1 cargo test --manifest-path src-tauri/Cargo.toml --lib                     # unit + MCP stdio round-trip
$env:OPENCLAUDE_LITELLM_KEY="..."; .\scripts\with-msvc.ps1 cargo test --manifest-path src-tauri/Cargo.toml --lib live_ '--' --ignored --nocapture   # live gateway
$env:OPENCLAUDE_LITELLM_KEY="..."; node e2e/desktop.e2e.mjs                                      # real GUI acceptance on the release exe
```

The E2E harness launches the packaged exe with an isolated profile (`OPENCLAUDE_DATA_DIR`) and attaches to WebView2 over CDP.
It drives chat, streaming, MCP connector setup, tool approval, cancellation, artifacts, and restart persistence against the
live gateway. Screenshots and `results.json` go to `e2e/out/`.

## Data locations

| What | Where |
|---|---|
| Conversations, projects, settings | `%APPDATA%\dev.openclaude.desktop\openclaude.db` (SQLite) |
| Connectors (MCP) | `%APPDATA%\dev.openclaude.desktop\mcp.json` (`mcpServers` format, `.bak` on every write) |
| Gateway key | Windows Credential Manager → `openclaude-desktop` / `litellm-api-key` |

Existing registries (`~/.openclaude.json`, `~/.claude.json`, Claude Desktop's `claude_desktop_config.json`) can be imported from
**Settings → Connectors**. They are only read, never modified.
