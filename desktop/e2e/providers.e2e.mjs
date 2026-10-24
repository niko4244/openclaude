// Providers E2E: add a direct provider (Ollama's OpenAI-compatible API, no key), see its models in
// the picker as provider::model, and chat through it without the LiteLLM gateway.
//   OPENCLAUDE_LITELLM_KEY=... OC_PROVIDER_MODEL=llama3.2:3b node e2e/providers.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const want = process.env.OC_PROVIDER_MODEL || "llama3.2:3b";
const port = 9900 + Math.floor(Math.random() * 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: mkdtempSync(join(tmpdir(), "oc-prov-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const ui = browser.contexts()[0].pages()[0];
const invoke = (cmd, args = {}) => ui.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

try {
  await ui.waitForSelector(".sidebar");
  await ui.keyboard.press("Control+,");
  await ui.click('[role="tab"]:has-text("Providers")');
  await ui.selectOption("#pv-preset", "ollama");
  record("preset fills the provider form", (await ui.inputValue("#pv-url")) === "http://127.0.0.1:11434/v1" && (await ui.inputValue("#pv-id")) === "ollama");
  await ui.click('button:has-text("Save provider")');
  const card = ui.locator('[data-provider="ollama"]');
  await card.waitFor({ timeout: 30000 });
  await ui.waitForFunction(() => /\d+ models/.test(document.querySelector('[data-provider="ollama"]')?.textContent || ""), null, { timeout: 30000 });
  record("provider is reachable and lists its models", true, (await card.innerText()).replace(/\s+/g, " ").slice(0, 120));
  const models = await invoke("list_models", { refresh: true });
  const mine = models.filter((m) => m.id.startsWith("ollama::"));
  record("its models join the catalog as provider::model", mine.length > 0 && models.some((m) => !m.id.includes("::")), `${mine.length} provider models, ${models.length - mine.length} gateway models`);
  await ui.click('[aria-label="Close settings"]');

  const id = `ollama::${want}`;
  await ui.click(".composer .picker-btn");
  await ui.fill(".picker-pop input", want);
  await ui.locator(".picker-item", { hasText: id }).first().click();
  await ui.fill(".composer textarea", "Reply with exactly one word: banana");
  await ui.keyboard.press("Enter");
  const until = Date.now() + 240000;
  await sleep(1500);
  while (Date.now() < until) {
    if ((await ui.locator(".msg.assistant .assistant-body").count()) && !(await ui.locator('.send-btn[aria-label="Stop generating"]').count())) break;
    await sleep(1000);
  }
  const reply = (await ui.locator(".msg.assistant .assistant-body").last().innerText().catch(() => "")).trim();
  const meta = await ui.locator(".msg.assistant .meta").last().innerText().catch(() => "");
  record("chat runs through the direct provider", reply.length > 0 && !/HTTP \d|error/i.test(reply), JSON.stringify(reply.slice(0, 60)) + " | " + meta.replace(/\s+/g, " ").slice(0, 80));

  // the stored provider config never contains a key
  const stored = await invoke("get_setting", { key: "providers" });
  record("provider settings hold no secrets", typeof stored === "string" && !/key|sk-/i.test(stored.replace(/"preset":"[^"]*"/, "")));
  await invoke("provider_remove", { id: "ollama" });
  record("removing a provider drops its models", !(await invoke("list_models", { refresh: true })).some((m) => m.id.startsWith("ollama::")));
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
  app.kill();
  process.exit(failed ? 1 : 0);
}
