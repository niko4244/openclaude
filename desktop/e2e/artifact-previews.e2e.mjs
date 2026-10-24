// Artifact previews like Claude's: a React component runs live in the sandbox, a Mermaid
// diagram renders, and selecting part of an artifact offers Improve / Explain.
//   OPENCLAUDE_LITELLM_KEY=... node e2e/artifact-previews.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const model = process.env.OC_E2E_MODEL || "qwen-local";
const port = 9800 + Math.floor(Math.random() * 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: mkdtempSync(join(tmpdir(), "oc-art-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const ui = browser.contexts()[0].pages()[0];

const fence = "```";
const REACT = `${fence}jsx title="Counter"
import { useState } from "react";
import { Plus } from "lucide-react";

export default function App() {
  const [n, setN] = useState(0);
  return (
    <button id="inc" className="m-6 px-4 py-2 rounded bg-blue-600 text-white flex gap-2" onClick={() => setN(n + 1)}>
      <Plus size={16} /> Count {n}
    </button>
  );
}
${fence}`;
const MERMAID = `${fence}mermaid title="Flow"
graph TD
  Start --> Finish
${fence}`;

let prev = null;
async function echo(block) {
  await ui.keyboard.press("Control+n");
  await ui.fill(".composer textarea", `Reply with exactly the following and nothing else, keeping the code fence and its title:\n\n${block}`);
  await ui.keyboard.press("Enter");
  const until = Date.now() + 240000;
  await sleep(1500);
  while (Date.now() < until) {
    if ((await ui.locator(".msg.assistant .assistant-body").count()) && !(await ui.locator('.send-btn[aria-label="Stop generating"]').count())) break;
    await sleep(1000);
  }
  await ui.waitForFunction((old) => { const f = document.querySelector(".artifact-panel iframe"); return f && f.src && f.src !== old; }, prev, { timeout: 20000 });
  const src = await ui.locator(".artifact-panel iframe").getAttribute("src");
  prev = src;
  for (let i = 0; i < 60; i++) {
    const f = ui.frames().find((fr) => fr.url() === src);
    if (f) return f;
    await sleep(250);
  }
  throw new Error("preview frame not found");
}

try {
  await ui.waitForSelector(".sidebar");
  await ui.waitForFunction(() => !/No models|Select a model/.test(document.querySelector(".composer .picker-btn")?.textContent || ""), null, { timeout: 30000 });
  await ui.click(".composer .picker-btn");
  await ui.fill(".picker-pop input", model);
  await ui.locator(".picker-item", { hasText: new RegExp(`^${model}`) }).first().click();

  // React: compiled in the sandbox, imports resolved, state works
  const rf = await echo(REACT);
  const btn = rf.locator("#inc");
  await btn.waitFor({ timeout: 60000 });
  const before = (await btn.innerText()).trim();
  await btn.click();
  const after = (await btn.innerText()).trim();
  const icon = await rf.locator("#inc svg").count();
  const tw = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
  record("React artifact runs live (state, lucide-react, Tailwind)", before === "Count 0" && after === "Count 1" && icon === 1 && tw !== "rgba(0, 0, 0, 0)", `${before} -> ${after}, icon ${icon}, bg ${tw}`);
  const ipc = await rf.evaluate(() => Promise.race([
    Promise.resolve().then(() => window.__TAURI_INTERNALS__.invoke("app_info")).then(() => "SUCCEEDED", (e) => "rejected: " + String(e).slice(0, 80)),
    new Promise((r) => setTimeout(() => r("no response"), 3000)),
  ]));
  record("React preview cannot call the app", !/SUCCEEDED/.test(ipc), ipc);

  // select part of the code -> Explain sends a targeted question
  await ui.click('.artifact-panel .tabs button:has-text("Code")');
  await ui.evaluate(() => {
    const pre = document.querySelector(".artifact-body pre");
    const r = document.createRange();
    r.selectNodeContents(pre);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    const b = pre.getBoundingClientRect();
    document.querySelector(".artifact-body").dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: b.left + 40, clientY: b.top + 20 }));
  });
  await ui.waitForSelector('.ask-bar button:has-text("Explain")', { timeout: 5000 });
  const users = await ui.locator(".msg.user").count();
  await ui.click('.ask-bar button:has-text("Explain")');
  await ui.waitForFunction((n) => document.querySelectorAll(".msg.user").length > n, users, { timeout: 15000 });
  const q = await ui.locator(".msg.user").last().innerText();
  record("selecting part of an artifact offers Explain and asks about that part", /explain this part/.test(q) && /useState/.test(q), q.replace(/\s+/g, " ").slice(0, 90));
  await ui.click('.send-btn[aria-label="Stop generating"]').catch(() => {});

  // Mermaid
  const mf = await echo(MERMAID);
  await mf.waitForSelector("#m svg", { timeout: 60000 });
  const label = await mf.locator("#m svg").evaluate((el) => el.textContent || "");
  record("Mermaid artifact renders as a diagram", /Start/.test(label) && /Finish/.test(label), label.replace(/\s+/g, " ").slice(0, 60));
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
  app.kill();
  process.exit(failed ? 1 : 0);
}
