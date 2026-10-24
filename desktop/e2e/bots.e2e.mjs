// Bots E2E: the roster of persistent teammates, with a stub model server.
//
//  1. add a provider that points at the stub, then restart so the app's model
//     list and default model come from it (the real startup path)
//  2. create a bot from the UI (name, persona, memory, folder), open its chat
//  3. the stub captures the request: persona, memory and folder are in the
//     system prompt, and the bot's model is the one requested
//  4. reopening the bot resumes the same thread
//  5. editing the memory changes the next request
//  6. deleting the bot keeps its chat
//
// No real model and no network outside 127.0.0.1.
//   node e2e/bots.e2e.mjs [path\to\openclaude-desktop.exe]
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

/** OpenAI-compatible stub: lists one model and streams one sentence. */
const requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model", created: 0, owned_by: "stub" }] }));
      return;
    }
    if (req.url.endsWith("/chat/completions")) {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* keep {} */ }
      requests.push(parsed);
      const model = parsed.model || "stub-model";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0, model };
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      send({ role: "assistant", content: "" });
      send({ content: "Stub reply: brief received." });
      send({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const dataDir = mkdtempSync(join(tmpdir(), "oc-bots-"));
let browser;
let app;
let page;
let port = 0;

async function launch() {
  port = 10100 + Math.floor(Math.random() * 300);
  app = spawn(exe, [], {
    env: { ...process.env, OPENCLAUDE_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore",
  });
  for (let i = 0; i < 150 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); }
  }
  if (!browser) throw new Error(`could not attach to WebView2 (exit ${app.exitCode ?? "running"})`);
  page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".sidebar", { timeout: 30000 });
}

async function close() {
  await browser?.close().catch(() => {});
  browser = undefined;
  if (app) {
    try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" }); } catch { /* gone */ }
    app = undefined;
  }
  await sleep(1000);
}

const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const systemText = (req) => {
  const m = (req?.messages ?? []).find((x) => x.role === "system");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((p) => p.text ?? "").join("\n");
};

try {
  // ---- 1. provider and default model, then a restart --------------------------
  await launch();
  try {
    await invoke("provider_save", {
      provider: { id: "stub", name: "Stub", base_url: base, preset: "openai", enabled: true },
      apiKey: "stub-key",
    });
    const models = await invoke("list_models", { refresh: true });
    const ids = (models ?? []).map((m) => m.id);
    record("the stub provider contributes a model", ids.includes("stub::stub-model"), ids.filter((i) => /stub/.test(i)).join(", ") || ids.slice(0, 4).join(", "));
    await invoke("set_setting", { key: "default_model", value: "stub::stub-model" });
  } finally {
    await close();
  }

  // ---- 2. the roster, from the UI -------------------------------------------
  await launch();
  try {
    await page.click('.nav-item:has-text("Bots")');
    await page.waitForSelector('.page h1:has-text("Bots")', { timeout: 15000 });
    record("an empty roster says so", /No bots yet/.test(await page.locator(".page-inner").innerText()));

    await page.click('button:has-text("New bot")');
    await page.fill("#bot-name", "Ada");
    await page.fill("#bot-persona", "Dry, precise, no filler. You are a release engineer.");
    await page.fill("#bot-memory", "The user ships on Thursdays.");
    await page.fill("#bot-workspace", "C:/tmp/ada-work");
    const picked = await page.locator("#bot-model").inputValue();
    record("the default model is the one the app started with", picked === "stub::stub-model", picked);
    await page.click('button:has-text("Save bot")');
    await page.waitForSelector('[data-bot]', { timeout: 10000 });
    const card = await page.locator('[data-bot]').innerText();
    record("the bot is saved with persona, memory and folder", /Ada/.test(card) && /release engineer/.test(card) && /chars of memory/.test(card) && /ada-work/.test(card), card.replace(/\s+/g, " ").slice(0, 180));

    await page.click('[data-bot] button:has-text("Chat")');
    await page.waitForSelector(".composer textarea", { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector(".topbar .title-btn .title")?.textContent?.includes("Ada"), null, { timeout: 10000 }).catch(() => {});
    const conv = await page.locator(".topbar .title-btn .title").innerText().catch(() => "");
    record("the thread is named after the bot", /Ada/.test(conv), conv);

    await page.fill(".composer textarea", "Introduce yourself in one line.");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.msg.assistant .assistant-body:has-text("Stub reply")', { timeout: 30000 });
    const req = requests.at(-1);
    const sys = systemText(req);
    record("the system prompt carries the persona", /release engineer/.test(sys) && /You are Ada/.test(sys), sys.slice(0, 120));
    record("the system prompt carries the memory", /ships on Thursdays/.test(sys));
    record("the system prompt carries the folder", /C:\/tmp\/ada-work/.test(sys));
    record("the bot's model is the one requested", /stub-model/.test(req?.model ?? ""), req?.model);

    const bots = await invoke("bots_list");
    record("the bot remembers its thread", bots.length === 1 && !!bots[0].conversation_id, JSON.stringify({ count: bots.length, conversation: bots[0]?.conversation_id }));
    const thread = bots[0].conversation_id;
    const convs = await invoke("list_conversations", { query: null, projectId: null });
    // The title may be replaced by the auto-title after the first reply; the id is the contract.
    record("the thread is an ordinary chat, listed in Chats", convs.some((c) => c.id === thread));

    // ---- 3. reopening resumes the same thread --------------------------------
    await page.click('.nav-item:has-text("Bots")');
    await page.waitForSelector('[data-bot]', { timeout: 10000 });
    await page.click('[data-bot] button:has-text("Chat")');
    await page.waitForSelector(".composer textarea", { timeout: 15000 });
    const msgs = await invoke("get_messages", { conversationId: thread });
    record("reopening keeps the history", msgs.length >= 2, `${msgs.length} message(s)`);

    // ---- 4. editing the memory changes the next request ----------------------
    await page.click('.nav-item:has-text("Bots")');
    await page.click('[aria-label="Edit Ada"]');
    await page.fill("#bot-memory", "The user ships on Thursdays. Prefers a one-line summary first.");
    await page.click('button:has-text("Save bot")');
    await page.waitForSelector('.toast:has-text("Saved Ada")', { timeout: 10000 });
    await page.click('[data-bot] button:has-text("Chat")');
    await page.fill(".composer textarea", "What do you remember?");
    await page.keyboard.press("Enter");
    await page.waitForFunction((n) => document.querySelectorAll(".msg.assistant .assistant-body").length >= n, 2, { timeout: 30000 });
    const sys2 = systemText(requests.at(-1));
    record("edited memory reaches the next request", /one-line summary first/.test(sys2) && !/no filler\. You are a release engineer\.\s*$/.test(sys2), sys2.slice(-160));

    // ---- 5. deleting the bot leaves the chat --------------------------------
    await page.click('.nav-item:has-text("Bots")');
    await page.click('[aria-label="Delete Ada"]');
    await page.waitForTimeout(800);
    record("deleting removes the bot", (await invoke("bots_list")).length === 0);
    const still = await invoke("list_conversations", { query: null, projectId: null });
    record("deleting keeps the chat", still.some((c) => c.id === thread));
    record("the empty roster returns", /No bots yet/.test(await page.locator(".page-inner").innerText()));
  } finally {
    await close();
  }
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 500));
} finally {
  await close();
  server.close();
  process.exit(failed ? 1 : 0);
}
