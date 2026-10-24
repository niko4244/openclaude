// Plugins E2E: install Ponytail from GitHub, import the user's Claude plugins (read-only
// toward Claude's folders; copies go to an isolated profile), use them from chat.
//   OPENCLAUDE_LITELLM_KEY=... node e2e/plugins.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const model = process.env.OC_E2E_MODEL || "qwen-local";
const port = 9750 + Math.floor(Math.random() * 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: mkdtempSync(join(tmpdir(), "oc-plugins-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const ui = browser.contexts()[0].pages()[0];
const invoke = (cmd, args = {}) => ui.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

async function chat(prompt, viaSlash) {
  await ui.keyboard.press("Control+n");
  if (viaSlash) {
    await ui.fill(".composer textarea", viaSlash);
    await ui.waitForSelector(".slash-pop .picker-item", { timeout: 15000 });
    await ui.keyboard.press("Enter");
    await ui.locator(".composer textarea").pressSequentially(prompt);
  } else {
    await ui.fill(".composer textarea", prompt);
  }
  await ui.keyboard.press("Enter");
  const until = Date.now() + 300000;
  await sleep(1500);
  while (Date.now() < until) {
    if ((await ui.locator(".msg.assistant .assistant-body").count()) && !(await ui.locator('.send-btn[aria-label="Stop generating"]').count())) break;
    await sleep(1000);
  }
  return (await ui.locator(".msg.assistant .assistant-body").last().innerText().catch(() => "")).trim();
}

try {
  await ui.waitForSelector(".sidebar");
  await ui.keyboard.press("Control+,");
  await ui.click('[role="tab"]:has-text("Plugins")');

  // 1. Ponytail from GitHub (featured card -> marketplace offer -> install)
  await ui.click('button:has-text("Get Ponytail")');
  await ui.waitForSelector('.offer-row:has-text("ponytail") input:checked', { timeout: 30000 });
  await ui.click('.card button.primary:has-text("Install")');
  const card = ui.locator('[data-plugin="ponytail"]');
  await card.waitFor({ timeout: 120000 });
  const text = await card.innerText();
  const skills = Number(/(\d+) skills?/.exec(text)?.[1] || 0);
  record("Ponytail installs from GitHub", /GitHub DietrichGebert\/ponytail/.test(text) && skills >= 5, text.replace(/\s+/g, " ").slice(0, 160));
  record("Ponytail's session hook is detected", /session hook/.test(text));
  record("installed plugin auto-updates by default", await card.locator('label:has-text("Update automatically") input').isChecked());

  // 2. its SessionStart hook feeds new chats
  await ui.click('button:has-text("Preview chat context")');
  const pre = await ui.locator(".context-preview").innerText({ timeout: 60000 });
  record("hook context reaches the chat system prompt", /plugin-context plugin="ponytail"/.test(pre) && /lazy|ponytail/i.test(pre) && pre.length > 500, `${pre.length} chars`);
  await ui.click('.card button:has-text("Close")');

  // 3. import the user's Claude plugins
  await ui.click('button:has-text("Find Claude plugins")');
  await ui.waitForSelector('.offer-row, :text("No Claude plugins found")', { timeout: 120000 });
  const cands = await invoke("plugins_import_candidates");
  const fromGh = cands.filter((c) => c.github).length;
  record("Claude Code and Claude Desktop plugins are found", cands.length > 0, `${cands.length} found, ${fromGh} with a GitHub source`);
  if (cands.some((c) => !c.imported)) {
    await ui.click('button.primary:has-text("Import")');
    await ui.waitForSelector('.toast:has-text("Imported")', { timeout: 600000 });
  }
  const list = await invoke("plugins_list");
  const broken = list.filter((p) => p.error);
  record("every found plugin is imported", cands.every((c) => list.some((p) => p.name === c.name)), `${list.length} installed, ${list.filter((p) => p.repo_dir).length} from GitHub`);
  record("no plugin reports an error", broken.length === 0, broken.map((p) => `${p.name}: ${p.error}`).join("; ").slice(0, 300));
  const cmds = await invoke("slash_commands");
  record("skills, commands and agents are indexed", cmds.length > 10, `${cmds.length} (${["skill", "command", "agent"].map((k) => `${cmds.filter((c) => c.kind === k).length} ${k}s`).join(", ")})`);

  // 4. updates: everything was just cloned, so a check finds nothing to apply
  await ui.click('button:has-text("Check for updates")');
  const t = await ui.locator('.toast:has-text("up to date"), .toast:has-text("Updated")').last().innerText({ timeout: 300000 }).catch(async () => ui.locator(".toast").last().innerText());
  record("update check runs across GitHub plugins", /up to date|Updated/.test(t), t);
  await ui.click('[aria-label="Close settings"]');

  // 5. "/" menu: pick Ponytail's skill and send a coding request with it
  await ui.waitForFunction(() => !/No models|Select a model/.test(document.querySelector(".composer .picker-btn")?.textContent || ""), null, { timeout: 30000 });
  await ui.click(".composer .picker-btn");
  await ui.fill(".picker-pop input", model);
  await ui.locator(".picker-item", { hasText: new RegExp(`^${model}`) }).first().click();
  const r1 = await chat("write a python function that returns the sum of a list", "/ponytail");
  const chip = await ui.locator('.msg.user .file-chip:has-text("/ponytail")').count();
  record('"/" menu sends the skill with the message', chip >= 1 && r1.length > 0, JSON.stringify(r1.slice(0, 100)));

  // 6. the model finds a skill on its own
  const r2 = await chat("Use the skills__search tool to find an installed skill about brainstorming, then reply with only its exact name.");
  const used = await ui.locator('.tool-card:has-text("skills__search"), .tool-card:has-text("search")').count();
  record("model searches installed skills", used >= 1 && /brainstorm/i.test(r2), JSON.stringify(r2.slice(0, 100)));
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
  app.kill();
  process.exit(failed ? 1 : 0);
}
