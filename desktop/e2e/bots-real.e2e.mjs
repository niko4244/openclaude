// Bots E2E, real model: what the persona and memory actually do to the replies.
//
// Unlike bots.e2e.mjs (a stub that proves the plumbing), this runs against a
// local Ollama model and compares two conversations on the same model:
//
//   A. a plain chat asked about the user's project and release day
//   B. a bot with a persona and memory, asked the identical question
//
// The interesting claim is the difference: the plain model cannot know the
// facts, the bot states them and names itself. Replies are printed verbatim so
// they can be recorded; assertions are deliberately loose (a real model may
// phrase things differently), and the strongest ones are "mentions Tallow",
// "mentions Thursday", "names itself Kestrel".
//
// No network outside 127.0.0.1. First call loads the model, so the ceiling is
// generous; set BOT_E2E_MODEL to pick another installed Ollama model.
//   node e2e/bots-real.e2e.mjs [path\to\openclaude-desktop.exe]
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const model = process.env.BOT_E2E_MODEL || "qwen2.5vl:7b";
const modelId = `ollama::${model}`;
const ollama = "http://127.0.0.1:11434/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };
const dataDir = mkdtempSync(join(tmpdir(), "oc-bots-real-"));

let browser;
let app;
let page;
let port = 0;

async function launch() {
  port = 10500 + Math.floor(Math.random() * 300);
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

async function ask(text, timeoutMs = 300000) {
  const before = await page.locator(".msg.assistant").count();
  const started = Date.now();
  await page.fill(".composer textarea", text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".msg.assistant").length > n, before, { timeout: 180000 });
  await page.waitForFunction((n) => {
    const bodies = document.querySelectorAll(".msg.assistant");
    if (bodies.length <= n) return false;
    const last = bodies[bodies.length - 1];
    const text = (last.querySelector(".assistant-body")?.textContent || "").trim();
    return text.length > 0 && /Send message/.test(document.querySelector(".send-btn")?.getAttribute("aria-label") || "");
  }, before, { timeout: timeoutMs });
  await sleep(500);
  const reply = (await page.locator(".msg.assistant .assistant-body").last().innerText()).trim();
  return { reply, ms: Date.now() - started };
}

try {
  // ---- provider + default model, then a restart ------------------------------
  await launch();
  try {
    await invoke("provider_save", {
      provider: { id: "ollama", name: "Ollama (local)", base_url: ollama, preset: "ollama", enabled: true },
      apiKey: "",
    });
    const models = await invoke("list_models", { refresh: true });
    const ids = (models ?? []).map((m) => m.id);
    record(`Ollama lists ${model}`, ids.includes(modelId), ids.filter((i) => i.startsWith("ollama::")).slice(0, 4).join(", "));
    await invoke("set_setting", { key: "default_model", value: modelId });
  } finally {
    await close();
  }

  // ---- A. the control: a plain chat on the same model ------------------------
  await launch();
  try {
    // The model catalog loads asynchronously at boot; the composer is usable only after it does.
    await page.waitForFunction(() => !/No models|Select a model/.test(document.querySelector(".composer .picker-btn")?.textContent || ""), null, { timeout: 60000 }).catch(() => {});
    const picker = await page.locator(".composer .picker-btn").innerText().catch(() => "");
    record("the app starts on the local model", picker.includes(model.split(":")[0]), picker.replace(/\s+/g, " ").trim());
    const plain = await ask("Without looking anything up: what is my project called, and on which weekday do I release? If you do not know, say so.");
    console.log(`\n[plain chat] ${plain.ms} ms\n${plain.reply}\n`);
    record("the plain chat does not know the project", !/tallow/i.test(plain.reply), plain.reply.replace(/\s+/g, " ").slice(0, 160));
    record("the plain chat does not know the release day", !/thursday/i.test(plain.reply));

    // ---- B. the same question to a bot with persona and memory --------------
    await page.click('.nav-item:has-text("Bots")');
    await page.waitForSelector('.page h1:has-text("Bots")', { timeout: 15000 });
    await page.click('button:has-text("New bot")');
    await page.fill("#bot-name", "Kestrel");
    await page.fill("#bot-persona", "You are Kestrel, a laconic lighthouse keeper. Answer in at most two sentences, in plain prose, and never use exclamation marks.");
    await page.fill("#bot-memory", "The user's project is called Tallow. Tallow ships on Thursdays. The user's team has three engineers and prefers British spelling.");
    await page.click('button:has-text("Save bot")');
    await page.waitForSelector('[data-bot]', { timeout: 10000 });

    await page.click('[data-bot] button:has-text("Chat")');
    await page.waitForSelector(".composer textarea", { timeout: 15000 });
    const who = await ask("Who are you? Introduce yourself in one line.");
    console.log(`\n[bot: who] ${who.ms} ms\n${who.reply}\n`);
    record("the bot answers as its persona", /kestrel/i.test(who.reply), who.reply.replace(/\s+/g, " ").slice(0, 160));
    record("the bot keeps the no-exclamation rule", !who.reply.includes("!"));

    const mem = await ask("What is my project called, and on which weekday do I release? One sentence.");
    console.log(`\n[bot: memory] ${mem.ms} ms\n${mem.reply}\n`);
    record("the bot states the remembered project", /tallow/i.test(mem.reply), mem.reply.replace(/\s+/g, " ").slice(0, 200));
    record("the bot states the remembered release day", /thursday/i.test(mem.reply));

    const recall = await ask("How many engineers are on my team?");
    console.log(`\n[bot: recall] ${recall.ms} ms\n${recall.reply}\n`);
    record("the bot recalls a fact it was only told in memory", /\b(three|3)\b/i.test(recall.reply), recall.reply.replace(/\s+/g, " ").slice(0, 160));

    // The bot's own thread must contain all four turns, with real model metadata.
    const bots = await invoke("bots_list");
    const thread = bots[0]?.conversation_id;
    const msgs = await invoke("get_messages", { conversationId: thread });
    const assistants = msgs.filter((m) => m.role === "assistant");
    const served = assistants.map((m) => m.model_served).filter(Boolean);
    record("every bot turn is stored in its own thread", assistants.length === 3, `${assistants.length} assistant turn(s) of ${msgs.length}`);
    record("the replies came from the local model", served.length > 0 && served.every((m) => m.includes(model.split(":")[0])), served.join(", "));
    // A fresh plain chat is still ignorant: the knowledge lives in the bot, not the app.
    await page.click('.nav-item:has-text("Chats")');
    await page.click('.new-chat');
    const again = await ask("What is my project called? If you do not know, say so.");
    console.log(`\n[plain chat, after the bot] ${again.ms} ms\n${again.reply}\n`);
    record("a new plain chat does not inherit the bot's memory", !/tallow/i.test(again.reply));

    console.log(`\nmodel: ${modelId}\ndata: ${dataDir}`);
  } finally {
    await close();
  }
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 600));
} finally {
  await close();
  process.exit(failed ? 1 : 0);
}
