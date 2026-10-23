# Visual Baselines: placeholder & capture plan

Status: **placeholder**. No screenshots of the reference app are stored. The landmarks below come
from static assets and window options in the pristine 3.6556.2 archive (`REA_EVIDENCE.md` E-25,
E-06). Values are facts about window geometry, not copied assets.

## 1. Known geometry (static)

| Surface | Size | Notes |
|---|---|---|
| Main window (signed in, inferred) | 1200 × 800 default | Hidden title bar with native overlay controls on Windows (`titleBarStyle` hidden/hiddenInset) |
| Main window (alt, inferred signed-out) | 600 × 600 | Used by the window-size helper before sign-in state is known |
| Title row (boot placeholder) | 48 px × UI scale | Skeleton drawn by `main_window/index.html` before the web UI reports real layout |
| Boot placeholder colors | Light sidebar ≈ off-white mix (#f9f9f7/#fcfcfb), dark ≈ #151515 mixed toward black; seam 10% alpha, rows 5–7.5% alpha | The live UI reports its actual sidebar/seam colors back to the shell (`WindowControl_$_reportBootPlaceholderColors`, `reportSidebarPlaceholder`, `reportFrameLayout`, `reportTitleRowCenter`) |
| About window | 320 × 428, modal, not resizable | |
| Third-party inference setup window | 900 × 720, min 720 × 560 | |
| Quick Entry | Floating, small. Size not extracted (inferred about 600 wide) | Position persisted; kept inside the work area |
| Fonts | Anthropic Sans / Anthropic Serif variable fonts (proprietary, do NOT reuse) | OC must pick its own type stack |
| HTML theme attributes (bundled SPA) | `data-theme`, `data-mode=system`, `data-density=comfortable` | Shows light/dark/system and density modes exist |

## 2. Landmarks to baseline (per screen)
1. Shell: title row, window controls region, sidebar (collapsed/expanded), main content, composer.
2. Sidebar: surface switcher (Chat / Tasks / Code), New button, recents list, projects, search entry, account/settings footer.
3. Conversation: empty state, streaming message, tool-call card (collapsed/expanded), approval card, error banner.
4. Model picker open; "+" menu open (attach / connectors / tools).
5. Settings › General, Developer (MCP list with statuses), Extensions (installed + preview dialog).
6. Quick Entry window (empty, typing, recents).
7. Find bar; command palette; keyboard-shortcuts sheet.
8. Code surface: split view with terminal + changes panes.
9. Tray menu; About window.
Each in light + dark, at 100% and 150% scale, window sizes 1200×800 and 720×560 (min).

## 3. Capture procedure (later phase, needs explicit user approval)
- The reference app is captured manually by the user, or through an approved REA runtime scenario
  (`capture_electron_scenario`). Capturing it is out of scope for the current static-only mandate.
- OpenClaude is captured automatically: Playwright against the Tauri webview (or the `tauri-driver`
  WebDriver) with a fixed window size, the OS theme forced, animations disabled and fonts preloaded.
- Store results at `docs/parity/baselines/<screen>/<theme>-<scale>.png`, plus a JSON landmark map
  (bounding boxes of the landmarks in §2).
- Comparison: compare structure and layout via landmark boxes, with ±8 px tolerance on positions
  and ±5% on sizes. Pixel diffs are informational only, since the visual design is meant to be
  original and not a copy.

## 4. Open items
- Sidebar width, composer max width and message column width live in the remote web app's CSS and
  were not extracted statically. Measure them from user-provided screenshots.
- Quick Entry exact size and corner radius are unknown.

## OpenClaude baselines (2026-10-23)

Captured by `desktop/e2e/*.e2e.mjs` into `desktop/e2e/out/` (gitignored, regenerated every run).

| State | File | Matches the reference layout | Deliberate difference |
|---|---|---|---|
| Home | `01-home.png` | Collapsible left sidebar (New chat, Search, Chats, Projects, Tasks, Code; Starred and Recents; account footer); centered serif greeting with mark; rounded composer with +, tools and model menus and a send button; starter chips | Original mark and teal accent (no Anthropic brand assets or colors) |
| Chat | `02-chat.png`, `05-tool-result.png` | User turns in a warm bubble with avatar; assistant text unboxed in serif; action bar (copy, feedback, retry with model); tool cards; centered title menu | Routing metadata (model / host / tokens) shown inline, because users pick their own backends |
| Artifact | `06-artifact.png` | Right-hand panel with Preview/Code tabs, version selector, Copy, Download, close | No "publish" (needs hosting) |
| Frameless shell | `11-project.png`, `12-tasks.png` | Own title bar with app menu and window controls | |
| Dialogs | a11y run | Ctrl+K palette, Ctrl+/ sheet, modal with inert background | |

**Measuring parity.** No reference screenshots exist in the repo. The only Claude Desktop window on the dev machine hosts the agent session, and Anthropic's public pages don't show the app UI. Pixel-exact sameness is also not a goal: the mission requires original branding. Visual parity is therefore tracked as layout and interaction parity against `BEHAVIOR_CONTRACTS.md`. To diff side by side, drop reference PNGs into `docs/parity/reference/` named like the files above.
