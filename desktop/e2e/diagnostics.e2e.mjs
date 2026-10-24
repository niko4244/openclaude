// Self-maintenance E2E: an uncaught UI error lands in the local log (redacted), the self-test runs,
// and "Fix with the coding agent" opens the Code tab on OpenClaude's own checkout with a prefilled,
// unsent fix prompt.
//   OPENCLAUDE_LITELLM_KEY=... node e2e/diagnostics.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const port = 9950 + Math.floor(Math.random() * 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: mkdtempSync(join(tmpdir(), "oc-diag-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const ui = browser.contexts()[0].pages()[0];

try {
  await ui.waitForSelector(".sidebar");
  const fakeKey = "sk-e2eFAKEdiagnosticKey1234567890";
  await ui.evaluate((k) => setTimeout(() => { throw new Error(`E2E diag probe failed with ${k}`); }), fakeKey);
  await sleep(1500);

  await ui.keyboard.press("Control+,");
  await ui.click('[role="tab"]:has-text("Diagnostics")');
  const card = ui.locator('.card:has-text("E2E diag probe")');
  await card.waitFor({ timeout: 10000 });
  const text = await card.innerText();
  record("uncaught UI errors land in the local log", /frontend/.test(text) && /1×/.test(text), text.replace(/\s+/g, " ").slice(0, 100));
  record("secrets are redacted in the log", !text.includes(fakeKey) && text.includes("[redacted]"));

  await ui.click('button:has-text("Run self-test")');
  await ui.waitForSelector('.offer-row:has-text("Update feed")', { timeout: 60000 });
  const checks = await ui.locator(".offer-row").allInnerTexts();
  const gw = checks.find((c) => c.startsWith("Gateway")) || "";
  const feed = checks.find((c) => c.startsWith("Update feed")) || "";
  record("self-test checks gateway, connectors, plugins, update feed, errors", ["Gateway", "Connectors", "Plugins", "Update feed", "Errors"].every((n) => checks.some((c) => c.startsWith(n))), checks.map((c) => c.split("·")[0].trim()).join(", "));
  record("self-test sees the live gateway and the release feed", (await ui.locator('.offer-row:has-text("Gateway") .dot.ok').count()) === 1 && /latest \d/.test(feed), `${gw.replace(/\s+/g, " ").slice(0, 60)} | ${feed.replace(/\s+/g, " ")}`);

  const repo = await ui.locator('.field:has-text("Source folder") .mono').innerText();
  record("OpenClaude's own checkout is detected for self-repair", /openclaude/i.test(repo), repo);
  await card.locator('button:has-text("Fix with the coding agent")').click();
  await ui.waitForSelector(".code-view textarea, textarea[placeholder*='coding task'], textarea[placeholder*='Start the agent']", { timeout: 10000 });
  const prompt = await ui.locator("textarea").last().inputValue();
  const folder = await ui.locator('button:has-text("📂")').first().innerText();
  record("the Code tab opens on the repo with an unsent fix prompt", /E2E diag probe/.test(prompt) && /regression test/.test(prompt) && /Do not push/.test(prompt) && /openclaude/i.test(folder) && (await ui.locator(".msg.user").count()) === 0, folder.trim());
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
  app.kill();
  process.exit(failed ? 1 : 0);
}
