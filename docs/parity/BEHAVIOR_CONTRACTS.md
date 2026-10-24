# Behavior Contracts: OpenClaude Desktop 2.0

These are contracts for an **original** implementation (Tauri 2 + React/TS + Rust, LiteLLM
gateway). They describe user-visible behavior that matches Claude Desktop; they do not
describe Anthropic's code. `[E-xx]` points at `REA_EVIDENCE.md`. Unmarked details are our own
design choices.

Conventions: **MUST** = parity requirement. **SHOULD** = expected. **OC** = an OpenClaude design
choice where the reference app relies on Anthropic-hosted services.

---

## C1. Application shell & windows [E-06, E-25, E-03]
- MUST be a single-instance app. A second launch focuses the existing window and passes along any
  deep link or file argument.
- Main window: default 1200×800, size and position persisted per display, frameless or hidden title
  bar with native window controls on Windows (overlay), title row about 48 px. Shows a themed boot
  placeholder (sidebar + title row skeleton in light or dark) until the UI is ready.
- Secondary windows: Quick Entry (C8), About (modal, fixed 320×428), Find-in-page (C9), consent
  dialogs, Settings (in-app route).
- States: `booting → signed-out (onboarding/connect gateway) → ready`, plus `offline` and `gateway-error`.
- Security posture (OC, mirrors the shipped fuses): no Node in the webview, no remote-debug flags in
  release builds, the UI is loaded only from bundled assets, and every IPC command checks which
  window or origin sent it.

## C2. Navigation shell: sidebar, surfaces, command palette [E-13, E-24]
- Three top-level surfaces: **Chat** (`chats`), **Tasks/Agent** (`tasks`, Cowork-equivalent),
  **Code** (`sessions`). "New" (`Ctrl+N`) creates an item for the active surface; its label changes
  with the surface (New Chat / New Task / New Session).
- Sidebar toggled with `Ctrl+B`. It lists recents grouped by surface, plus projects and search. The
  sidebar collapse state persists.
- Command palette `Ctrl+K`: fuzzy search over commands, chats, projects and settings. `Esc` closes it.
- History navigation: Back/Forward, Previous/Next item in the active surface.
- Split view (Code/Tasks): new pane right `Ctrl+Alt+\`, below `Ctrl+Alt+-`, focus next/prev
  `Ctrl+]`/`Ctrl+[`, close split `Ctrl+Alt+W`, close pane `Ctrl+\`. Reopen the last closed session
  with `Ctrl+Shift+T`.
- Side chat `Ctrl+;`: a secondary conversation docked beside the current one.
- Edge cases: closing the last pane falls back to the surface's empty state. Reopen-closed works
  only while the closed session still exists.

## C3. Menus & keyboard shortcuts [E-13]
- MUST provide menus File / Edit / View / Developer / Help with the accelerators listed in
  REA_EVIDENCE §3.2. Windows Redo is `Ctrl+Y`. Zoom uses `Ctrl+0`, `Ctrl+=`/`Ctrl+Plus`,
  `Ctrl+-`, with numpad variants that don't appear in the menu. `F11` toggles fullscreen and `F10`
  opens the menu.
- `Ctrl+/` opens a Keyboard Shortcuts sheet generated from the same registry as the menus, so the
  two never drift apart.
- Edit commands go to the focused editor first and fall back to webview roles.
- Developer menu (OC equivalents): Open MCP Log, Reload MCP Configuration, View Process Logs,
  Configure Gateway… (replaces "Configure Third-Party Inference…"). It is visible only when
  Developer Mode is on (enabled from Help with a confirm dialog).

## C4. Conversation [proprietary in reference; OC via LiteLLM]
- Input: multiline composer. `Enter` sends, `Shift+Enter` adds a newline. Supports attachments
  (files, images, paste, drag and drop) and the "+" menu (attach, connectors/MCP tools, project
  context).
- Output: streaming tokens, markdown, code blocks with copy, thinking blocks (collapsible), and tool
  calls rendered as expandable cards showing input and output.
- States: `idle → sending → streaming → (tool_pending_approval ↔ tool_running) → done | stopped | error`.
  Stop cancels the upstream request. Retry and edit-and-resend branch the conversation.
- Errors: show gateway, HTTP or model errors inline with a Retry button. Don't lose the draft.
- Persistence (OC): local SQLite. Each conversation has id, title (auto-generated after the first
  turn), model, project, timestamps and messages.

## C5. Model picker [OC]
- Lists models from the LiteLLM `/models` endpoint, grouped by provider and filtered by
  capabilities (tools, vision, thinking). The selection persists per conversation, with a global
  default.
- Edge cases: if the selected model disappears, fall back to the default model and show a
  non-blocking notice. Hide or disable thinking and effort controls when the model doesn't support
  them. The reference app requires gateway routes to be named after Anthropic models [E-21]. OC
  does not have this restriction.

## C6. MCP servers (local) [E-16, E-17, E-18, W-01]
- Config file: `claude_desktop_config.json`-compatible schema in our app-data directory. The app MUST
  import an existing `%APPDATA%\Claude\claude_desktop_config.json` (read-only, opt-in).
- Entry: `mcpServers.<name> = { command: string (required), args?: string[], env?: map<string,string> }`,
  plus OC-reserved `extensionId?`. Remote servers: OC extension `{ url, transport: "http"|"sse", headers?, oauth? }`
  (the reference app keeps these out of the local file).
- Load: validate each entry on its own. Drop invalid entries and show one warning naming up to 10
  of them. If the JSON can't be parsed, show an error, keep the last good config, and keep running.
- Lifecycle per server: `starting → connected(tools n) | failed(reason) | disabled`. stderr goes to
  `logs/mcp-server-<name>.log` and connection events go to `logs/mcp.log`. The log name is built
  from a sanitized server name and can't escape the logs folder.
- Settings › Developer: list servers with status, then Edit Config (opens the file),
  Reveal Logs, Reload (no full restart needed; the reference app shows a Reload menu item).
- Option "Use built-in Node.js for MCP": run `node`/`npx` commands through a bundled runtime.
- Tool approval: per-tool policy `allow | ask | ask-session | blocked`. The default is `ask`. The
  approval card shows the server, tool, arguments and Allow once / Allow for session / Always allow /
  Deny. Blocked tools are hidden from the model.

## C7. Extensions (.mcpb / .dxt) [E-19, W-02]
- Install sources: open or drag a `.mcpb`/`.dxt` file, a URL ending in those extensions, an unpacked
  folder (developer), or an optional directory catalogue.
- Flow: parse `manifest.json` → compatibility check (platforms, runtimes, app version) → preview
  (name, author, tools, prompts, requested `user_config`, signature status signed/unsigned/self-signed)
  → user confirms → extract into `<appdata>/Extensions/<id>` → generate an MCP entry with `extensionId`
  → prompt for required `user_config`. Sensitive values go to the OS keychain.
- Variable substitution: `${__dirname}`, `${HOME}`, `${DESKTOP}`, `${DOCUMENTS}`, `${DOWNLOADS}`,
  `${/}`, `${user_config.KEY}`.
- Manage: enable/disable, settings, version, update available, uninstall (with confirmation),
  "open extensions folder". Policy hooks: allowlist/blocklist, require signatures, disable local
  installs.

## C8. Quick Entry window & global hotkey [E-14]
- Global hotkey, default `Ctrl+Alt+Space` on Windows, user-configurable. Registration fails
  gracefully: reject accelerators without a modifier, and if registration fails restore the
  previous binding and show the reason.
- Small floating, always-on-top window. Its position is remembered per monitor and nudged back
  inside the work area if it would fall off-screen. `Esc` or losing focus dismisses it.
- Submit creates a new chat (or continues a recent one picked from a short recents list), then
  brings the main window forward on that chat. Optional: screenshot or window context attach, and a
  dictation hotkey slot.

## C9. Find in page [E-07]
- `Ctrl+F` opens a find bar over the current view. `F3`/`Enter` goes to the next match,
  `Shift+F3`/`Shift+Enter` to the previous one, and it shows a match counter. `Esc` closes it and
  clears the highlights.

## C10. Tray & startup [E-15, E-20]
- Tray icon with light and dark variants. Left-click shows or focuses the app. The right-click
  menu has Show App and Exit. The first time the window is closed to the tray, show a one-time
  notice.
- Settings: "Run on login" and "Show in tray/menu bar". When the tray is enabled, closing the
  window hides it instead of quitting.

## C11. Settings [E-20, E-21]
- Panes (OC): General (theme, language, startup, tray, notifications, keep-awake), Account/Gateway
  (LiteLLM URL, key in the keychain, test connection), Models, Developer (MCP, logs, dev mode,
  built-in Node), Extensions, Shortcuts (quick entry, dictation), Privacy (telemetry off by default).
- Every setting persists right away and applies live unless it's marked "restart required"
  (hardware acceleration).
- Managed policy (OC, optional): a read-only policy file overrides user settings and is shown as
  locked.

## C12. Projects [proprietary in reference]
- A project is a name, instructions, knowledge files and a list of conversations. New chats inside
  a project inherit its instructions and files as context. Supports CRUD, archive and search. OC
  stores projects locally.

## C13. Artifacts [proprietary hosting in reference]
- The assistant can emit artifact blocks (code, HTML, SVG, markdown, mermaid). These render in a
  side pane with versions, copy, download and open-in-window. HTML runs in a sandboxed iframe or
  webview with no network by default. OC has no hosted publishing.

## C14. Agent tasks (Cowork-equivalent) [E-09: LocalAgentModeSessions, CoworkSpaces, CoworkScheduledTasks]
- A long-running task works in a user-granted folder, with a visible plan or progress, a file
  activity list, approval prompts for risky actions, and pause/stop. Scheduled tasks run on a
  cron-like schedule with keep-awake and resume handling.
- Folder grants are explicit and revocable. Nothing outside the grants can be touched.

## C15. Code surface [E-09: LocalSessions, ClaudeCode; E-24]
- Sessions are bound to a folder or repo, run locally or over SSH, and have a terminal pane
  (pty), a changes/diff pane, a files pane and a preview/browser pane. Each session can use its
  own git worktree (branch prefix, auto-archive). Deep links `openclaude://code/new|continue`.
- The permission mode is per session. Auto-update waits until running sessions are idle.

## C16. Computer use [E-09: ComputerUseTcc; prefs chicago*]
- Requires explicit OS permissions (accessibility, screen capture). Keeps an allow/deny list of
  apps, shows a live preview, and registers a global `Esc` that aborts at once. Opt-in only.

## C17. Voice / dictation [prefs sableOtter*, Dictation]
- Hotkey push-to-talk dictation into the composer or Quick Entry, with configurable hold behavior,
  custom terms and excluded apps. OC routes it to a local or LiteLLM speech-to-text endpoint.

## C18. Auto-update [E-22]
- Check about once an hour plus on demand ("Check for Updates"). Download in the background, then
  show "Restart to update". If agent or code sessions are running, offer "restart when idle".
  Supports stable and beta channels. Policy can disable updates or pin a maximum version. Detect a
  rollback and clear any staged update. OC uses the Tauri updater with signed manifests.

## C19. Sync [proprietary in reference]
- The reference app syncs everything through the claude.ai account. OC is local-first. Optional
  export/import, and later an opt-in self-hosted sync, are out of scope for parity v1.
