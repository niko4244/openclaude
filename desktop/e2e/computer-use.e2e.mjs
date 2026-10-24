// Live computer-use check (screenshot only, no input injection) with a local vision model.
//   OPENCLAUDE_LITELLM_KEY=... OC_VISION_MODEL=gemma4-local node e2e/computer-use.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const model = process.env.OC_VISION_MODEL || "gemma4-local";
const port = 9700 + Math.floor(Math.random() * 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: mkdtempSync(join(tmpdir(), "oc-cu-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const ui = browser.contexts()[0].pages()[0];
try {
  await ui.waitForSelector(".sidebar");
  await ui.keyboard.press("Control+,");
  await ui.locator('label:has-text("Computer use (experimental)") input').check();
  await ui.click('[aria-label="Close settings"]');
  // pick the vision model
  await ui.waitForFunction(() => !/No models|Select a model/.test(document.querySelector(".composer .picker-btn")?.textContent || ""), null, { timeout: 30000 });
  await ui.click(".composer .picker-btn");
  await ui.fill(".picker-pop input", model);
  await ui.locator(".picker-item", { hasText: new RegExp(`^${model}`) }).first().click();
  await ui.fill(".composer textarea", "Call the computer__screenshot tool exactly once, then describe in one short sentence what is visible on the screen. Do not click or type.");
  await ui.keyboard.press("Enter");
  let approvals = 0;
  const until = Date.now() + 600000;
  while (Date.now() < until) {
    const card = ui.locator(".approval");
    if (await card.count()) {
      const label = await card.first().innerText();
      if (!/screenshot/i.test(label)) { await ui.click('.approval button:has-text("Deny")'); record("only screenshot was requested", false, label.slice(0, 80)); continue; }
      approvals++;
      await ui.click('.approval button:has-text("Allow once")');
    }
    if ((await ui.locator(".msg.assistant .assistant-body").count()) && !(await ui.locator('.send-btn[aria-label="Stop generating"]').count())) break;
    await sleep(1000);
  }
  const toolDone = await ui.locator('.tool-card:has-text("screenshot") :text("done")').count();
  const answer = (await ui.locator(".msg.assistant .assistant-body").last().innerText().catch(() => "")).trim();
  record("screenshot approved and executed", approvals >= 1 && toolDone >= 1, `${approvals} approval(s)`);
  record("vision model describes the screen", answer.length > 10, JSON.stringify(answer.slice(0, 140)));
  // never "always": the approval card for computer tools must not persist a global allow
  const policy = await ui.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_setting", { key: "tool_policy:computer__screenshot" }));
  record("no permanent allow stored for computer tools", policy !== "allow", String(policy));
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
  app.kill();
  process.exit(failed ? 1 : 0);
}
