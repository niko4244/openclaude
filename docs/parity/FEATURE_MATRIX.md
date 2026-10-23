# Feature Matrix: Claude Desktop reference vs OpenClaude Desktop 2.0

Reference versions: **3.1623.0** (running) and **3.6556.2** (staged). "Both" = present in both
pristine archives. Dependency: **local** = works without Anthropic services; **proprietary-infra** =
needs Anthropic-hosted services in the reference app (OpenClaude must substitute LiteLLM or local
storage). Evidence IDs refer to `REA_EVIDENCE.md`; contracts to `BEHAVIOR_CONTRACTS.md`.

| # | Feature | Ref. version | Observable behavior (summary) | Dependency | OpenClaude status (2026-10-23, branch feat/desktop-2.0) | Priority | Contract / Evidence |
|---|---|---|---|---|---|---|---|
| 1 | App shell (single window, frameless title bar, boot placeholder, window-state persistence) | Both | 1200×800 main window, hidden title bar with overlay controls, themed skeleton while loading | local | Partial: single window, light/dark/system themes, min size; native title bar, no window-state persistence | P0 | C1 / E-06, E-25 |
| 2 | Conversation (stream, tools, stop/retry/edit, attachments) | Both | Remote claude.ai web UI in main view; desktop adds menus/shortcuts | proprietary-infra (claude.ai API) → OC: LiteLLM | Operational (E2E): streaming, MCP tools, stop keeps partial; edit/regenerate (supersede, no delete) and attachments implemented, not yet E2E-tested | P0 | C4 / E-11, E-12 |
| 3 | Model picker | Both | Model list from the account or catalog (`downloads.claude.ai/model-catalog`); 3P gateway routes must use Anthropic model names | proprietary-infra (catalog/account) → OC: LiteLLM `/models` | Operational (E2E): live LiteLLM catalog (124), search, provider groups, local/cloud + capability filters, favorites; capabilities shown only when the gateway declares them | P0 | C5 / E-21, E-23 |
| 4 | Sidebar + surfaces (Chat / Tasks / Code), new item, command palette, search | Both | `Ctrl+B` sidebar, `Ctrl+K` palette, `Ctrl+N` new per surface, prev/next item | UI local; data proprietary-infra | Partial: Chat + Code surfaces, search, Ctrl+N/K/B; no Tasks surface, no command palette | P0 | C2 / E-13, E-24 |
| 5 | Menus & keyboard shortcuts | Both | File/Edit/View/Developer/Help with accelerators; shortcuts sheet `Ctrl+/` | local | Partial: Ctrl+N, Ctrl+K, Ctrl+B, Ctrl+comma, Esc; no native menu bar or shortcuts sheet | P1 | C3 / E-13 |
| 6 | MCP local servers (`claude_desktop_config.json`, stdio) | Both | Per-entry validation, warning dialog, status list, logs, reload, built-in Node | local | Operational (E2E): stdio servers, status, tools/resources/prompts counts, log tail, restart, read-only import from OpenClaude/Claude Code/Claude Desktop configs | P0 | C6 / E-16, E-17 |
| 7 | MCP tool approval policy | Both | allow / ask / ask-session / blocked per tool | local | Operational: allow / ask / block per tool, approval card in chat (E2E for ask); no ask-session | P0 | C6 / E-18 |
| 8 | Remote MCP connectors (HTTP + OAuth) | Both | Account connectors via claude.ai; managed http servers in enterprise config; `mcp-proxy.anthropic.com` | proprietary-infra → OC: direct HTTP MCP | Partial: Streamable HTTP client implemented, not yet tested against a live server; no OAuth, no legacy SSE | P1 | C6 / E-21, E-23 |
| 9 | Desktop Extensions (.mcpb/.dxt) | Both | Preview → install → user_config → managed MCP entry; signatures; directory; auto-update | local (directory is hosted) | Missing | P1 | C7 / E-19, W-02 |
| 10 | Settings (General, Developer, Extensions, Shortcuts, Privacy) | Both | Desktop prefs (123 keys) + config file; managed policy overrides | local | Partial: General, Gateway (Credential Manager key), Models, Connectors, Projects, About | P0 | C11 / E-20, E-21 |
| 11 | Quick Entry window + global hotkey | Both | `Ctrl+Alt+Space` default on Windows, floating window, remembered position, recents | local | Partial: global hotkey (default Ctrl+Alt+Space) focuses the main window with a new chat; no separate floating window | P1 | C8 / E-14 |
| 12 | Tray / run on login | Both | Show App / Exit, close-to-tray notice | local | Missing | P1 | C10 / E-15 |
| 13 | Find in page | Both | `Ctrl+F`, `F3`/`Shift+F3` | local | Missing | P1 | C9 / E-07, E-13 |
| 14 | Projects | Both (web UI) | Instructions + knowledge + grouped chats | proprietary-infra → OC: local store | Partial: projects with instructions, default model, grouped chats; no knowledge files | P1 | C12 |
| 15 | Artifacts (side pane, versions, sandboxed render) | Both | Artifact pane bridge `claudeDesktopArtifactPane`; 3.6556 adds `artifactShell` namespace | render local; hosting/publishing proprietary-infra | Partial: side pane, HTML/SVG served from an isolated artifact origin with sandboxed iframe + strict CSP, Markdown preview, copy; no versions/edit/export | P1 | C13 / E-08, E-09 |
| 16 | Code tab (local/SSH sessions, terminal, diff, worktrees, preview browser) | Both; 3.6556 adds SSH command hosts, SSH-host MCP, remote browser | Largest IPC surface (LocalSessions 352 methods) | mostly local (+ `downloads.claude.ai` binaries, cloud sessions proprietary) | Partial: folder grant via native picker, OpenClaude CLI agent over LiteLLM (stream-json, permission modes, CLI smoke-tested), git status + diff; no terminal, worktrees, preview browser, or interactive per-command approval | P1 | C15 / E-09, E-10, E-24 |
| 17 | Agent tasks / Cowork (spaces, scheduled tasks, VM, memory) | Both | Folder grants, VM on Windows (VirtualMachinePlatform), scheduled routines, keep-awake | VM images + account proprietary-infra; execution local | Missing | P2 | C14 / E-09, E-20 |
| 18 | Computer use | Both | OS permission flow, app allowlist, global `Esc` abort, live preview | local exec; model proprietary-infra → OC via gateway | Missing | P2 | C16 / E-09 |
| 19 | Voice / dictation | Both | Hotkey dictation, hold modes, custom terms | proprietary-infra (stream credential) → OC: local or gateway STT | Missing | P2 | C17 / E-09, E-14 |
| 20 | Auto-update | Both | Hourly check, Squirrel/MSIX feed, channels, restart-when-idle, enterprise cap | proprietary-infra (update API) → OC: Tauri updater | Missing (Tauri updater not wired; reference tracking via desktop/feature-intel) | P1 | C18 / E-22 |
| 21 | Sync (chats, projects, prefs across devices) | Both | Via claude.ai account | proprietary-infra | Not planned (local-first) | P3 | C19 |
| 22 | Third-party inference mode (Bedrock / Vertex / Foundry / gateway) with bundled local SPA | Both | Setup window "Configure Third-Party Inference…", app runs from `app://localhost` | local + chosen provider | Operational: the core design; every request goes through the user's LiteLLM gateway, no Anthropic account | P0 | E-11, E-21 |
| 23 | Deep links (`claude://…`) | Both | `claude://code/new`, `/continue`, `/needs-input` | local | Missing | P2 | C15 / E-24 |
| 24 | Chrome extension / browser tools | Both | Native host + pairing | local + extension | Missing | P3 | E-20, E-26 |
| 25 | Office add-in, device simulators, hardware buddy (BLE) | Both; simulator device creation new in 3.6556 | Niche surfaces | mixed | Not planned | P3 | E-09, E-10 |

## Top P0/P1 for parity (recommended order)
1. Shell + sidebar/surfaces (1, 4)  2. Conversation via LiteLLM (2)  3. Model picker (3)
4. Settings + gateway config (10, 22)  5. MCP local servers + approvals (6, 7)
6. Menus/shortcuts + find (5, 13)  7. Quick Entry + tray (11, 12)  8. Extensions .mcpb (9)
9. Projects + artifacts (14, 15)  10. Auto-update (20), then Code tab (16)
