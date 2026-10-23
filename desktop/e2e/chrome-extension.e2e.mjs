// Real Chrome-extension E2E: Playwright Chromium loads the unpacked extension, pairs it
// with the running app, and the model reads a real tab through it (actions approved in chat).
//   OPENCLAUDE_LITELLM_KEY=... node e2e/chrome-extension.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const ext = resolve("chrome-extension");
const chromeExe = [process.env.OC_CHROMIUM, join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1234/chrome-win64/chrome.exe"), chromium.executablePath()].find((p) => p && existsSync(p));
const port = 9600 + Math.floor(Math.random() * 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

const page = http.createServer((_, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>Tab marker</title><h1>The tab marker is LILAC-904</h1>"); });
await new Promise((r) => page.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${page.address().port}/`;

const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: mkdtempSync(join(tmpdir(), "oc-chrome-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const ui = browser.contexts()[0].pages()[0];
await ui.waitForSelector(".sidebar");

let ctx;
try {
  // 1. enable the bridge in Settings and read the pairing details
  await ui.keyboard.press("Control+,");
  await ui.locator('label:has-text("Chrome extension (your own browser)") input').check();
  await ui.waitForSelector(':text("waiting for the extension")', { timeout: 10000 });
  const info = await ui.evaluate(() => window.__TAURI_INTERNALS__.invoke("chrome_bridge_info"));
  record("bridge enabled with a pairing token", info.enabled && typeof info.token === "string" && info.token.length >= 32, `port ${info.port}`);

  // 2. real Chromium with the unpacked extension; pair it through its own storage
  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "oc-chromium-")), {
    executablePath: chromeExe, headless: false,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  await sw.evaluate(async ([p, t]) => { await chrome.storage.local.set({ port: p, token: t }); await connect(); }, [info.port, info.token]);
  const tab = await ctx.newPage();
  await tab.goto(pageUrl);
  await tab.bringToFront();
  const linked = await ui.waitForSelector(':text("connected (")', { timeout: 15000 }).then(() => true, () => false);
  record("extension pairs with the app", linked);

  // 3. the model reads the active tab through the extension, approvals in chat
  await ui.click('button:has-text("Done")');
  await ui.keyboard.press("Control+n");
  await ui.fill(".composer textarea", "Use the chrome__read tool to read my active Chrome tab and tell me the tab marker.");
  await ui.keyboard.press("Enter");
  const until = Date.now() + 300000;
  while (Date.now() < until) {
    if (await ui.locator(".approval").count()) await ui.click('.approval button:has-text("Allow once")').catch(() => {});
    if ((await ui.locator(".msg.assistant .assistant-body").count()) && !(await ui.locator('.send-btn[aria-label="Stop generating"]').count())) break;
    await sleep(1000);
  }
  const answer = (await ui.locator(".msg.assistant .assistant-body").last().innerText().catch(() => "")).trim();
  record("model reads a real Chrome tab via the extension", /LILAC-904/.test(answer), JSON.stringify(answer.slice(0, 80)));

  // 4. a web page cannot connect to the bridge, even if it knew the token
  const evil = await tab.evaluate(async ([p, t]) => new Promise((r) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/?token=${t}`);
    ws.onopen = () => r("opened"); ws.onerror = () => r("refused"); setTimeout(() => r("timeout"), 4000);
  }), [info.port, info.token]);
  record("web pages cannot use the bridge", evil !== "opened", evil);
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 400));
} finally {
  await ctx?.close().catch(() => {});
  await browser.close().catch(() => {});
  app.kill();
  page.close();
  process.exit(failed ? 1 : 0);
}
