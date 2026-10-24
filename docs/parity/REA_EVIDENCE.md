# REA Evidence Ledger: Claude Desktop (reference target)

Investigation date: 2026-10-23. Method: static analysis only (REA `analyze_javascript_application`,
`inspect_electron_fuses`, `compare_application_versions`, plus targeted string/context reads of an
extracted copy in `%TEMP%\claude\rea-out\`). The reference app was never launched, attached to, or
modified. No proprietary code is reproduced here; only identifiers (channel names, config keys,
accelerators, URLs) are recorded as facts.

Confidence labels: **observed** = literal in shipped artifact; **derived** = follows from several
observed facts; **inferred** = analyst judgement; **external** = public web source.

## 1. Target identity

| Item | 3.1623.0 (running) | 3.6556.2 (staged) |
|---|---|---|
| Pristine archive analysed | `app.asar.bak` (copied out) | `app.asar.bak` (copied out) |
| Pristine SHA-256 | `2e052c563bd0547a0361da031d4c83d8483e0ccb2230cd94628522d091ff1036` | `3e9cb8e8034e75d9e1996f960169877c556e17a454041a25233b372493fec9ac` |
| Installed `app.asar` SHA-256 (locally patched, NOT analysed) | `3711bf06...b333184` | `1b1436a9...18c8bb7` |
| REA analysis (parent Evidence) | `ev_0a847905c852ebb695506890b0683b1b2dce2f4c98ad09793438692d2387929b` | `ev_04e5d4dbdbf0444eb2b4ef3680b51e9cda947687ae025452412c7bff57bca728` |
| REA summary view | `ev_dfdb1d78...7038b` | `ev_4dc767c3...e5760` |
| Package | `@ant/desktop` 3.1623.0, main `.vite/build/index.pre.js` | `@ant/desktop` 3.6556.2 |
| Electron / Chromium | (not checked) | Electron 44.9.3 / Chrome 152.0.7977.167 (string in `claude.exe`) |
| `claude-agent-sdk` / `mcpb` | 0.3.304 / 2.1.2 | 0.3.308 / 2.1.2 |
| Files / parsed JS | 496 / 475 | 573 / 552 |

**Important finding (E-04):** both installs have been altered by a local, non-Anthropic patcher:
the installed `app.asar` differs from the recorded original (`app.asar.bak.json` records
`archiveSha256` equal to the `.bak` hash), `claude.exe.fuse-backup.json` records that fuse index 4
was flipped from `1` (enabled), `resources/ion-dist/` contains an injected `claude-mode-pill.js`,
`claude-mode-state.json` and `index.html.bak-toggle`. All findings below use the pristine `.bak`
archives; on-disk fuse state reflects the patch, not the shipped state.

## 2. Evidence IDs

| ID | Fact (summary) | Source | Conf. |
|---|---|---|---|
| E-01 | Pristine 3.1623 archive identity + REA graph | REA ev_0a847905… | observed |
| E-02 | Pristine 3.6556 archive identity + REA graph | REA ev_04e5d4db… | observed |
| E-03 | Fuses (3.6556 exe, sha `604cfb7b…f360`): RunAsNode off, CookieEncryption on, NODE_OPTIONS off, CLI inspect off, EmbeddedAsarIntegrity **off on disk** (backup says shipped **on**), OnlyLoadAppFromAsar on, BrowserV8Snapshot off, FileProtocolExtraPrivileges on, WasmTrapHandlers on | REA ev_10328244…; `claude.exe.fuse-backup.json` | observed |
| E-04 | Local patch artifacts (see §1) | file hashes, backup JSON | observed |
| E-05 | Version comparison completed, retained but too large for transport (not exported) | REA ev_ebd347b13b9e24fba885a68fcb756666b2cfab4fb999ff97183e66a1fdbe4f81 | observed |
| E-06 | Main bundle layout: `.vite/build/{index.pre.js, index.chunk-*.js (≈415), preload scripts}`, `.vite/renderer/{main_window, quick_window, about_window, find_in_page, buddy_window, file_viewer, local_exec_consent}`; workers: file-index, heavy-work, msal-broker, pty-host, shell-path, stall-sampler, transcript-search, mcp-runtime (`nodeHost.js`, `directMcpHost.js`); 3.6556 adds `frame-local-worker` | extracted tree | observed |
| E-07 | Preload scripts: `mainWindow.js`, `mainView.js`, `quickWindow.js`, `aboutWindow.js`, `findInPage.js`, `buddy.js`, `artifactShell.js`, `coworkArtifact.js`, `designWindow.js`, `claudePagePreview.js`, `computerUseTeach.js`, `computerUseWatchRecord.js`, `watchRecordChooser.js`, `localExecConsent.js` | file list | observed |
| E-08 | `contextBridge` globals: `claudeAppBindings`, `claudeAppSettings`, `claudeDesktopArtifactPane`, `cowork`, `desktopBootFeatures`, `desktopBootPlaceholder`, `desktopDeviceClass`, `desktopEnterpriseConfig`, `desktopEssentialTelemetryDisabled`, `desktopManagedConfig`, `desktopPreferredLanguages`, `desktopTelemetryConfig`, `electronIntl`, `electronWindowControl`, `omeletteDesktopPdf`, `buddy`, `buddyBle`, `process` | grep `exposeInMainWorld` | observed |
| E-09 | IPC convention: generated typed RPC; channel = `$eipc_message$_<uuid>_$_claude.<namespace>_$_<Interface>_$_<method>`. Namespaces: `web, settings, telemetry, hybrid, skills, simulator, buddy, coworkArtifact, designPdf, engineSurface, officeAddin, windowVibrancy` (+`artifactShell` in 3.6556). ~1327 (3.1623) / 1350 (3.6556) `Interface_$_method` names; largest: LocalSessions 352, LocalAgentModeSessions 131, Launch 117, Simulator 71, Custom3pSetup 37, CoworkSpaces 34, Extensions 28 | preload strings; REA IPC stats (1576/1599 ops, mostly dynamic channels) | observed |
| E-10 | IPC diff 3.1623→3.6556: +24/−1 (see §4) | sorted channel lists | observed |
| E-11 | `app://` protocol serves `resources/ion-dist` (a bundled build of the claude.ai web SPA) at `app://localhost`; used for third-party ("3p") deployment mode incl. `/setup-desktop-3p` and `/login`; navigation in bundled-SPA windows is blocked unless it stays under `app://localhost/` | main chunk strings | observed→derived |
| E-12 | IPC sender validation: top-frame origin must be `https://claude.ai`, `https://preview.claude.ai`, `https://preview.claude.com`, or `app://localhost` (dev overrides: `localhost`, `*.ant.dev`) | preload/main strings | observed |
| E-13 | App menus and accelerators (§3.2) | menu template strings | observed |
| E-14 | Global shortcut slots: QUICK_ENTRY, DICTATION, HUSHED_HERON; win32 default Quick Entry `Ctrl+Alt+Space`; enterprise placeholder `Ctrl+Alt+K`; invalid/no-modifier accelerators rejected and previous restored; Quick window = `quick_window/quick-window.html`, position persisted (`quickWindowPosition`), auto-repositions inside the work area | main chunk | observed |
| E-15 | Tray: tooltip = app name, left-click shows app, right-click menu `Show App` / `Exit`, one-time balloon "runs in the system tray"; `menuBarEnabled` pref | main chunk | observed |
| E-16 | `claude_desktop_config.json` schema and validation (§3.3) | main chunk | observed |
| E-17 | Logs: `<logs>/mcp.log`, `<logs>/mcp-server-<name>.log` (path-escape guarded), `main.log` | main chunk | observed |
| E-18 | Per-tool policy values: `allow` ("Always allow"), `ask` ("Ask each time"), `ask-session` ("Ask once per session"), `blocked` | main chunk | observed |
| E-19 | Extensions: `.dxt`/`.mcpb` (and `.skill`) files; stored in `<userData>/Claude Extensions/`, per-extension settings `<userData>/Claude Extensions Settings/<id>.json`; signature status `signed/unsigned/self-signed`; `extensions-blocklist.json` exists in userData | main chunk; userData listing | observed |
| E-20 | Preferences schema: 123 keys in 3.6556 (3 added vs 3.1623: `launchRemoteBrowserAllowed`, `sessionHostSettings`, `userDataOtherDriveAnswer`) | schema key extraction | observed |
| E-21 | Managed/enterprise + third-party inference config: 27 sections (`inference, selfHosted, otlp, dictation, tokenLimits, coworkSurface, codeSurface, chatSurface, sessionRetention, officeSurface, claudeCode, extensions, autoUpdate, featureDiscovery, bootstrap, lifecycle, models, plugins, skills, telemetry, mcp, workspace, builtinBrowser, artifacts, authentication, entra, appearance`); providers `anthropic, bedrock, vertex, foundry, gateway, mantle`; gateway model routes must name an Anthropic model (e.g. `claude-sonnet-4-5`, `anthropic/claude-*`); managed file on Linux `/etc/claude-desktop/managed-settings.json` | main chunk | observed |
| E-22 | Auto-update (§3.6) | main chunk; `packages/RELEASES` | observed |
| E-23 | Hosted origins referenced (§3.5) | URL extraction | observed |
| E-24 | Surfaces enum `chats` / `tasks` / `sessions` (New Chat / New Task / New Session); session environments `local`, `cloud`, `bridge` (remote control), `ssh`; deep links `claude://code/new`, `claude://code/continue`, `claude://code/needs-input` | main chunk | observed |
| E-25 | Window sizes: main 1200×800 (600×600 variant, likely signed-out), About 320×428 modal non-resizable, 3P config window 900×720 (min 720×560); `titleBarStyle` hidden/hiddenInset with overlay; boot placeholder title row 48 px × scale | main chunk; `main_window/index.html` | observed (role mapping partly inferred) |
| E-26 | Unpacked native/bundled: `github-mcp-server.exe`, `office365-mcp` (MSAL runtime), `node-pty`, `@ant/claude-native`; built-in Node MCP host toggle `isUsingBuiltInNodeForMcp` | `app.asar.unpacked` | observed |
| W-01 | Config path `%APPDATA%\Claude\claude_desktop_config.json` (mac `~/Library/Application Support/Claude/`), Settings → Developer → Edit Config, restart required, logs `%APPDATA%\Claude\logs` | https://modelcontextprotocol.io/docs/develop/connect-local-servers | external |
| W-02 | MCPB manifest spec (fields, `server.type`, substitution vars) | https://github.com/anthropics/mcpb/blob/main/MANIFEST.md | external |
| W-03 | Release notes: Cowork GA (Apr 2026), computer use preview (Mar 2026), Cowork on web/mobile (Jul 2026), memory across chat+Cowork (Aug 2026) | https://support.claude.com/en/articles/12138966-release-notes (via search summary, not fetched directly) | external, secondary |

## 3. Questions → findings

### 3.1 Window / IPC structure (Q1)
- **Observed:** Electron main process (`index.pre.js` + chunks) with ≈15 BrowserWindow constructions and
  14 preload scripts (E-06, E-07). All renderer↔main traffic goes through a code-generated RPC layer
  with UUID-salted channel names and per-interface sender-origin checks (E-09, E-12).
- **Derived — chat UI is remote by default:** in first-party (claude.ai account) mode the main view loads
  `https://claude.ai` (configurable `claudeAiUrl`; Developer menu offers Remote/Local/Staging). The
  desktop-native parts are the frame/title bar (`main_window`), quick entry, about, find-in-page, consent
  dialogs. In third-party-inference mode the same SPA is served locally from `ion-dist` via `app://localhost` (E-11).
- **Fuses (shipped):** RunAsNode off, NODE_OPTIONS off, `--inspect` off, ASAR integrity on, app only
  from ASAR, cookie encryption on (E-03, E-04).

### 3.2 Navigation & shell (Q2)
Menus (Windows): **File** (Settings `Ctrl+,`, Exit, Go: Back/Forward, Search…, Previous/Next Chat/Task/Session),
**Edit** (Undo, Redo `Ctrl+Y`, Cut/Copy/Paste, Paste and Match Style `Ctrl+Shift+V`, Select All, Find `Ctrl+F`,
Find Next `F3`, Find Previous `Shift+F3`), **View** (Full Screen `F11`, Command Palette `Ctrl+K`,
Sidebar `Ctrl+B`, Split View: new right `Ctrl+Alt+\`, new below `Ctrl+Alt+-`, focus next/prev `Ctrl+]`/`Ctrl+[`,
close `Ctrl+Alt+W`; panes Terminal/Changes/Browser/Preview/Files/Side Chat; Close Pane `Ctrl+\`;
zoom `Ctrl+0/+/-`), **Developer** (Load Remote/Local/Staging Claude.ai, Open MCP Log File,
Reload MCP Configuration, View Process Logs, Configure Third-Party Inference…), **Help** (Get Support,
About, Claude Help `F1`, Keyboard Shortcuts `Ctrl+/`, Enable Developer Mode).
Other accelerators: New Chat/Task/Session `Ctrl+N`, New Side Chat `Ctrl+;`, Close `Ctrl+W`,
Reopen Closed Session `Ctrl+Shift+T`, Open Folder `Ctrl+Shift+O`, Open File `Ctrl+Alt+Shift+O`,
DevTools `Ctrl+Alt+I`, `F10` app menu (E-13). Global: Quick Entry `Ctrl+Alt+Space` (E-14). Tray (E-15).
Sidebar sections/projects/search UI live in the remote web app; only their menu hooks are local
(MenuEvents_* channels: toggleSidebar, openCommandPalette, cycleSession, switchSurface, newWindow…).

### 3.3 MCP integration (Q3)
- File: `claude_desktop_config.json` in `userData` (`%APPDATA%\Claude` on Windows; W-01). Third-party
  mode uses a separate `%LOCALAPPDATA%\Claude-3p` data root (observed constant `Claude` + `-3p`).
- Top-level keys (E-16): `claudeAiUrl, globalShortcut, mcpServers, features, isHardwareAccelerationDisabled,
  isHardwareAccelerationAutoDisabled, isHardwareAccelerationAutoDisableNoticePending, chromiumFlags,
  isCoworkSdkDebuggingEnabled, isCoworkVmDebugLoggingEnabled, isUsingBuiltInNodeForMcp,
  isDxtAutoUpdatesEnabled, dxtMaxTotalSizeMB, deploymentMode, hybridIdentity, managedConfig,
  coworkUserFilesPath, …, preferences`.
- `mcpServers.<name>`: `command` (string, required), `args` (string[]), `env` (string map),
  `extensionId` (string, set for extension-provided servers). **stdio only** in the local file.
  Invalid entries are dropped and the user gets one warning dialog listing up to 10 names; a JSON parse
  failure shows an error dialog and the app continues.
- `features`: `isDxtEnabled, isDxtDirectoryEnabled, isLocalDevMcpEnabled, isUvSystemPythonEnabled,
  isMidnightOwlEnabled, isDictationAwaitFinalTranscriptEnabled, isChicagoEnabled, isChicagoBatchOnly` (+catch-all booleans).
- Remote (HTTP) MCP servers appear as **connectors** (account-level, claude.ai) or as managed
  `mcp.managedServers` entries with `transport:"http"` and OAuth (`mode:"byo"`) in enterprise/3P config (E-21).
- Approvals: per-tool policy allow / ask / ask-session / blocked (E-18).
- Logs: `mcp.log` + `mcp-server-<name>.log` (E-17, W-01). IPC: `MCP_$_getMcpServersConfigWithStatus,
  setMcpServerConfigs, mcpStatusChanged, revealConfig, revealLogs, revealServerLog`.
- Extensions: `.mcpb`/`.dxt` (zip + `manifest.json`, W-02); install from file, unpacked dir, directory
  (catalogue) or preview; signature check optional/enforceable; settings per extension; auto-update toggle (E-19).

### 3.4 Version diff 3.1623 → 3.6556 (Q4)
Added IPC: `AutoUpdater.settleAncientJournal`, `Custom3pSetup.getEgressOfRedactedKeys`,
`Launch.{disconnectRemoteBrowser, previewToolPoint, remoteBrowserAttachIsOff, remoteBrowserCouldNotSign, setRemoteBrowserAllowed}`,
`LocalAgentModeSessions.{getSessionList, syncRemoteSessionTabGroupTitle}`,
`LocalSessions.{create/cancelSSHCommandHost, getSSHHostCommands, getSSHLocalFolders, sshHostMcpCallTool, sshHostMcpReadResource, get/cancelTranscriptForReport, getTranscriptRetentionDays, getSessionFileOutsideActions}`,
`Simulator.{createDevice, listDeviceTypes, nativeViewTurnPlans}`, `WindowState.{getWindowActive, windowActiveChanged}`.
Removed: `AppConfig.setAppFeature`. New namespace `artifactShell`; new worker `frame-local-worker`.
Theme: remote-browser control for Code/preview, MCP over SSH hosts, device simulators, transcript reporting.
Surfaces present in both: Chat, Cowork (tasks, spaces, scheduled tasks, VM), Code (local sessions,
worktrees, terminal), computer use (codename "chicago"), voice/dictation ("sableOtter"), Chrome extension,
Office add-in, hardware "buddy" (BLE).

### 3.5 Proprietary-infrastructure dependencies (Q5)
`claude.ai` (chat UI + API + auth + sync + projects + artifacts + connectors), `api.anthropic.com`
(update API, OAuth roles/keys), `platform.claude.com` / `console.anthropic.com` (OAuth),
`mcp-proxy.anthropic.com` (remote connector proxy), `microsoft365.mcp.claude.com`,
`downloads.claude.ai` (model catalog, Claude Code + SSH binaries, Cowork VM images),
`config.claude.com` (hybrid bootstrap), `releases.claude.com`, `assets.claude.ai`, `code.claude.com` (docs),
dictation stream credentials (`Dictation_$_getStreamCredential`). Feature gating uses numeric hashed
gate IDs evaluated against server-delivered config (inferred GrowthBook-style; `growthBookHybridAuthedOrigins`).

### 3.6 Auto-update & version metadata (Q6)
- Windows installs via Squirrel (`squirrel.exe`, `packages/RELEASES`, `AnthropicClaude-<ver>-full.nupkg`,
  side-by-side `app-<ver>` dirs). MSIX build variant exists.
- Feed: `{base}/api/desktop/{platform}/{arch}/{squirrel|msix}/update?<query>[&channelUuid=]`, base =
  `https://api.anthropic.com` (or `https://releases.claude.com` / enterprise `updateApiBase`).
  Channels `stable`, `latest`, `staggered`. JSON body carries `currentRelease`/`version`. Check tick ≈1 h.
  Enterprise can disable or cap (`autoUpdate.dangerousMaxVersion`). Restart-to-update waits for idle
  local sessions (`restartToUpdateWhenIdle`, `getRunningLocalSessionCount`).
- **For the feature-intel monitor:** poll the feed URL for the `x64/squirrel` stable channel and diff the
  version; on change, download nupkg out-of-band and rerun this ledger.

## 4. Limitations / unknowns
1. REA semantic coverage partial (budget limits; 721/1052 application unknowns); most IPC channels
   are dynamic so REA paired only 1 transmission. Channel facts come from string extraction.
2. The chat/projects/artifacts/search UI is the remote web app; its behavior is not in the asar except
   as the bundled `ion-dist` SPA (not deeply analysed). Sidebar section inventory = **unknown** statically.
3. Comparison Evidence E-05 retained but not exported; diff in §3.4 is from channel lists.
4. Exact role of 600×600 vs 1200×800 window size, and main-window min size, partly inferred.
5. Release-note dates (W-03) come from a search summary; verify before quoting.
6. Codenames (chicago, sableOtter, hushedHeron, epitaxy, gorse, violinFret) mapped to features by
   inference only.
7. Fuse state on disk is patched; shipped ASAR-integrity state derived from the backup file.
