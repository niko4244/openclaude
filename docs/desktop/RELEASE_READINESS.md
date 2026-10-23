# OpenClaude Desktop 0.1.0: release readiness

Date: 2026-10-23 · Branch: `feat/desktop-2.0` · Verdict: **developer preview (not full parity)**

This is a working, installable Windows app for chat, MCP tools, projects, artifacts and a coding workspace on your own
LiteLLM gateway. It is **not** at full Claude Desktop parity: 6 of 25 matrix rows are operational, 10 partial, 9 missing or not planned.
See `docs/parity/FEATURE_MATRIX.md`.

## Build artifacts (reproducible: `scripts/with-msvc.ps1 npx tauri build`)

| Artifact | Size |
|---|---|
| `bundle/nsis/OpenClaude_0.1.0_x64-setup.exe` (per-user, no admin) | 4.4 MB |
| `bundle/msi/OpenClaude_0.1.0_x64_en-US.msi` | 6.2 MB |
| `release/openclaude-desktop.exe` (portable; needs WebView2, which ships with Windows 11) | single exe |

Not signed. Windows SmartScreen will warn until a code-signing certificate is configured (`bundle.windows.certificateThumbprint`).

## Evidence

### Real desktop E2E on the packaged exe (`e2e/desktop.e2e.mjs`): 15/15 pass
Launches `openclaude-desktop.exe` with an isolated profile, attaches to WebView2 over CDP, and runs against the live gateway
with `qwen-local`.

| Check | Result |
|---|---|
| Cold start → UI | 3.3 s (fresh profile) |
| Gateway online + authenticated | ✅ |
| Live catalog in picker | ✅ 124 models |
| Streaming chat | ✅ first token 207 ms, total 603 ms |
| Routing metadata (requested model, routed host, tokens, latency) | ✅ |
| Conversation persisted + auto-titled | ✅ |
| MCP stdio connector added via Settings UI → connected | ✅ |
| Tool call → approval card → Allow → result used in answer | ✅ "PAPAYA-42" |
| Stop generation keeps partial reply (status `cancelled`) | ✅ |
| HTML artifact renders in side pane | ✅ |
| Artifact frame cannot invoke app commands | ✅ |
| History survives restart (4 chats) | ✅ |
| Warm start → UI | 1.3 s |
| Reopened chat shows messages | ✅ |

### Artifact isolation (`e2e/artifact-isolation.e2e.mjs`): 4/4 pass
A hostile artifact tried every route to the backend. Tauri does inject its IPC shim (`__TAURI_INTERNALS__`) into subframes, but:
`invoke` gets no response (the capability origin check fails); `window.parent` access throws SecurityError (opaque sandbox
origin); and `fetch` to `ipc.localhost` is blocked by the artifact CSP.

### Capability probe (live, content-validated)
| Model | chat | stream | system | tools | json | vision |
|---|---|---|---|---|---|---|
| qwen-local | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ backend: no mmproj |
| coder-local | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ backend: no mmproj |
| brainz-chain | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ HTTP 200, but the model could not see the image |
| gemma4-local, spark-x2.6-local, zen-deepseek-v4.1-flash-free | ⏱ no reply in 90 s | | | | | |
| openrouter-qwen3.8-flash, routeway-glm-5.3-flash | ❌ 402 no credits | | | | | |
| tokenrouter-kimi-k3 | ❌ 403 quota | | | | | |
| fireworks-qwen3-coder-32b | ❌ 404 not deployed | | | | | |

The chat runtime stops offering tools to any model whose declared or measured tool support is "no".

### Rust (12 tests, `cargo test --lib`)
Gateway metadata normalization (unknowns stay unknown, no secret leakage), fragmented tool-call merge, SQLite migrations, CRUD
and non-destructive supersede, reopen idempotence, MCP config compatibility, tool-name sanitization, **real stdio MCP round-trip**,
orphaned tool-call repair, CLI adapter flags (gateway URL, no `--dangerously-*`), and git status on a real repo.

### Live gateway (`live_gateway_catalog_stream_and_tools`, ignored by default)
124 aliases discovered (56 routed to local backends).

| Model | Chat stream | Tool call | Note |
|---|---|---|---|
| qwen-local | ✅ TTFT 179 ms | ✅ `get_weather{"city":"Paris"}` | Ollama via LiteLLM |
| coder-local | ✅ TTFT 329 ms | ✅ | |
| groq-gptoss-120b | ❌ upstream 403 "Access denied" | ❌ | provider/network, not app |
| nvidia-nemotron-super | ❌ upstream 404 then cooldown 429 | ❌ | provider account |
| claude-haiku-5-5 | ❌ Anthropic "credit balance too low" | ❌ | provider billing |

Errors are surfaced verbatim in the chat (with LiteLLM's "No fallback was attempted" note). No silent substitution.

### Coding agent adapter
The OpenClaude CLI ran headless (`--input-format/--output-format stream-json --provider openai --model coder-local
--permission-mode acceptEdits`) against LiteLLM in a scratch git repo. It created `hello.py` through its Write tool and ended
with `result: success`.

### Feature intelligence
`node desktop/feature-intel/monitor.mjs` baselined 8 sources (local Claude builds, MCP spec, TS SDK, npm SDK, MCPB, Claude Code,
LiteLLM, Claude apps release notes). It writes reports and draft issues to `docs/feature-intel/reports/`. It never installs or executes
anything.

## Known issues / not done
- The very first launch of a freshly built exe took 16 s in one run (AV scan + WebView2 profile creation). Later cold starts took 3.3 s.
- Model capability metadata: the live gateway declares almost none. Use Settings → Models → Probe to measure them. Probe results feed tool gating, but not the picker badges yet.
- Not done: Tasks/Cowork, tray, find-in-page, native menu, `.mcpb` extensions, OAuth MCP, voice, computer use, auto-update,
  code signing, Code-tab terminal/worktrees, artifact versions, context compaction, branch navigation UI.
