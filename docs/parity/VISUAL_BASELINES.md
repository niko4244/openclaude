# Visual Baselines: placeholder & capture plan

Status: **layout geometry and shell landmarks measured against the reference; no reference images stored in the repo.** The landmarks below come from static assets
and window options in the pristine 3.6556.2 archive (`REA_EVIDENCE.md` E-25, E-06) and, since 2026-10-23, from the layout
tokens in the installed app's bundled web UI (§1b). Values are facts about geometry, not copied assets.

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

## 1b. Layout tokens measured from the bundled web UI (3.6556.2, `resources/ion-dist/assets/v1/*.css`)

Read statically from the CSS custom properties (the bundle could not be rendered offline: it needs its backend and shows
an error boundary even with a mocked bootstrap). Only geometry is adopted; palette, fonts and assets stay original.

| Token (reference) | Reference value | OpenClaude before | OpenClaude now |
|---|---|---|---|
| `--df-sidebar-width` | 288 px | 288 px | 288 px |
| `--chat-column-measure` / `--max-content-width` | 768 px default (960 / 1280 wide variants) | 712 px content | 768 px (`--chat-measure`) |
| `--cds-radius-composer` | 18 px (14 px compact) | 20 px | 18 px |
| `--cds-radius` | 8 px (6 px compact) | 10 px | 8 px |
| `--chat-body` / `--chat-leading` | 15 px / 1.4667 (14 px / 1.4286 compact) | 15.5 px / 1.7 | 15 px / 1.4667 |
| `--cds-font-size-body` | 14 px | 14 px | 14 px |
| `--cds-font-size-title` | 20–22 px | n/a | unchanged |
| `--session-rail-w` (Code session rail) | 280 px | n/a | not adopted |

## 1c. Shell side by side (measured 2026-10-23)

The reference shell was rendered from the installed bundle (`resources/ion-dist`) in an isolated headless Chromium at
1200x800 with every non-loopback request blocked, nothing sent anywhere, and a minimal mocked bootstrap. Its DOM boxes were
measured, and OpenClaude was measured from `e2e/out/01-home.png` and `05-tool-result.png`. The rendering is kept outside
the repo for comparison only. The bundle's chat surface stays behind its server-side permission gating, so the chat
column was compared by tokens (§1b), not pixels.

| Landmark | Reference | OpenClaude (now) | Notes |
|---|---|---|---|
| Sidebar | x 0, full height, 288 px | x 0, full height, 288 px | Matches. Previously a 36 px app title bar sat above it |
| Title row | 48 px; sidebar header (wordmark at y≈24) shares it; overlay window controls top-right | 48 px; wordmark at y≈24; own min/max/close float top-right; `--wc-inset` keeps rows clear | Matches |
| Header icons | 32x32, radius 8, right edge inset ≈ 9 px | Menu + collapse, about 32 px, same row | Reference has collapse + search; ours collapse + app menu (search is a nav row) |
| First nav row | "New", center y≈68 | "New chat", center y≈68 | Matches |
| Nav rows | 32 px, 8 px side inset | 32 px (+1 px gap), 8 px side inset | Matches |
| Footer rows | 32 px, 8 px inset | Account row (avatar, name, gateway status) | Content differs by design (gateway status instead of account plan) |
| Neutral surfaces (sampled pixels) | light: sidebar #fbfbf9, main #fcfcfb, divider #e2e2e1; dark: sidebar #111111, main #151515, divider #292929 | light: #f9f9f6, #fcfcfa, #e4e3de; dark: #121211, #161615, #2b2b29 (max 3 levels per channel) | Same lightness; our own faint warm tint, teal accent, logo and type stay original |
| Chat title | Centered in the title row | Centered in the title row | Matches |
| Settings | Centered modal (about 1024x768, 16 px inset) over the dimmed app; left nav with search and groups (Settings / Customize) and icons; close x; label-left / control-right rows with hairlines; switches; theme as a 3-icon segmented control | Same structure: modal over the page you came from, grouped icon nav with filter, close x, hairline rows, switches, segmented theme control | Our sections differ (gateway, models, plugins instead of account/billing) |
| Pages (Tasks etc.) | Full content width, 40 px padding, serif title about 26 px at y≈72, actions right | Full width, 40 px padding, 26 px serif title at y≈76, actions right | Matches |

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
- Sidebar width, column measure, composer radius and chat type scale: measured (§1b).
- Pixel-level comparison still needs reference screenshots (drop them into `docs/parity/reference/`).
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
