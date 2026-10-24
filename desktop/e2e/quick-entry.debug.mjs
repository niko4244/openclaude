// Debug probe for the Quick Entry window: what targets exist and is the window visible?
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve("src-tauri/target/release/openclaude-desktop.exe");
const port = 9500 + Math.floor(Math.random() * 50);
const proc = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: mkdtempSync(join(tmpdir(), "oc-q-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (ms, p) => Promise.race([p, sleep(ms).then(() => "TIMEOUT")]);
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const main = browser.contexts()[0].pages()[0];
await main.waitForSelector(".sidebar");
console.log("toggle:", await within(5000, main.evaluate(() => window.__TAURI_INTERNALS__.invoke("quick_entry_toggle").then(() => "ok", (e) => "err " + e))));
await sleep(2500);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
console.log("cdp targets:", targets.map((t) => `${t.type} ${t.title} ${t.url}`));
const pages = browser.contexts().flatMap((c) => c.pages());
console.log("playwright pages:", pages.length);
for (const pg of pages) {
  console.log(" page", pg.url(), "visibility:", await within(3000, pg.evaluate(() => document.visibilityState)), "quick:", await within(3000, pg.locator(".quick textarea").count()));
}
// window state from the backend's point of view
console.log("quick visible (via window API):", await within(3000, main.evaluate(async () => {
  try { return await window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "quick" }); } catch (e) { return "n/a: " + String(e).slice(0, 80); }
})));
await browser.close();
proc.kill();
process.exit(0);
