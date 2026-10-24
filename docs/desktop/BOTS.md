# Bots (persistent teammates)

OpenClaude Desktop's take on the "roster of bots" shape that Grok Bot popularised and that
[rakazo](https://github.com/elie222/rakazo) and [OpenMausBot](https://github.com/milind-soni/OpenMausBot)
implement in the open: a small team of named bots you talk to like contacts, each with its own
persona, memory, model, folder and continuing thread.

Neither project's code was copied. Their public descriptions were read for the shape worth keeping:
a persona per bot, memory that survives the session, the model chosen per bot, approvals for risky
actions, and chats that behave like messages rather than a single assistant window. Everything below
is implemented against OpenClaude's own storage, prompting and approval machinery.

## What exists

- **Storage** (`src-tauri/src/db.rs`, migration v7, `src-tauri/src/bots.rs`): a `bots` table with
  `name`, `persona`, `memory`, `model`, `workspace`, and `conversation_id`. A bot's thread is an
  ordinary conversation, so history, branching, export, search, renaming and deletion work
  unchanged; deleting a bot leaves its chat in Chats.
- **Prompting** (`src-tauri/src/chat.rs`): for the bot's conversation only, the system prompt gains a
  block with the persona, the memory ("use it; do not invent more"), the folder as context, and two
  rules: stay in character, never claim an action you did not take. Approval-gated tools still queue
  in the inbox, so a bot cannot act silently.
- **Commands** (`src-tauri/src/lib.rs`): `bots_list`, `bot_save`, `bot_delete`, `bot_chat`.
  `bot_chat` creates the thread on first use with the bot's model and names it after the bot, then
  reuses it.
- **UI** (`src/components/BotsPage.tsx`, `src/components/Sidebar.tsx`): a **Bots** page with the
  roster, a create/edit form (name, persona, memory, model, folder), Chat, Edit and Delete. The
  empty state explains what a bot is instead of showing fake cards.

## Deliberately out of scope in v1

- No autonomous routines: a bot only runs when you open it. Tasks and the proactive assistant cover
  scheduling; wiring bots into that is a separate decision.
- No per-bot cloud computer or VM. The folder is context, not a granted workspace; the existing
  folder grant and approvals still decide what may run.
- Memory is written by the person, not accumulated automatically from the conversation.
- No bot-to-bot delegation, channels, or a marketplace of prebuilt bot teams.

## Evidence (2026-10-24)

- Rust: `bots::tests` 5/5 (CRUD, conversation link, name/unknown-id validation, prompt contents,
  thread acts like a chat); full library 134 passed, 0 failed.
- Real-app E2E (`e2e/bots.e2e.mjs`, **16/16**, stub OpenAI-compatible server on loopback, no model):
  a provider is added, the app restarts so the model catalog and default model are the real startup
  path, a bot is created from the form, its chat opens, the stub captures the request and asserts the
  persona, memory and folder are in the system prompt and the bot's model is requested; reopening
  resumes the same thread; editing the memory changes the next request; deleting the bot keeps
  the chat and returns the empty roster.
- `tsc -b` 0, eslint 0 errors.
- Real model (`e2e/bots-real.e2e.mjs`, **9/9**, Ollama `qwen2.5vl:7b` on loopback, no network): a
  plain chat and a bot were asked the identical question on the same model. The plain chat said it
  could not determine the project or the release day; the bot, whose persona is a laconic lighthouse
  keeper and whose memory names the project, the weekday and the team size, replied *"I am Kestrel,
  the lighthouse keeper's assistant."*, then *"Your project is called Tallow, and you release it on
  Thursdays."*, then *"Your team has three engineers."* A fresh plain chat afterwards still did not
  know the project, so the knowledge lives in that bot's thread rather than in the app. Cold start
  was 105 s (model load); warm turns took 0.7–13.5 s.

  What this shows, precisely: the persona produced the name and the terse, no-exclamation style, and
  the memory produced facts the same model could not answer without it. It is an influence, not a
  guarantee — the model described itself as the keeper's *assistant* rather than the keeper. The run
  is manual because it needs a local Ollama; run
  `node e2e/bots-real.e2e.mjs` (optionally `BOT_E2E_MODEL=llama3.2:3b`) and it prints every reply.

## REA note

`npx rea-agents@latest setup` was run with explicit approval. It configured the MCP clients it
detected, but the package does not install a `rea` binary, and this session has no MCP client that
can call it. `desktop/feature-intel/cli.mjs rea` therefore still reports `available: false`
(`ENOENT`). The research above comes from reading the two repositories directly; no REA
investigation ran, and none is claimed.
