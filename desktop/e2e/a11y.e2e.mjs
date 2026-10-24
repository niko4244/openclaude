// Accessibility audit of the packaged app: launches the release exe with an isolated profile,
// attaches over CDP, injects axe-core and scans every major UI state (light + dark).
//
//   node e2e/a11y.e2e.mjs [path\to\openclaude-desktop.exe]
//
// Env: OC_E2E_MODEL (default qwen-local), OC_A11Y_PORT (default 9433).
// The gateway key is read from the Brainz stack .env (LITELLM_MASTER_KEY) into the child env only.
// Writes e2e/out/a11y.json; exits 1 when any critical/serious violation remains.
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const model = process.env.OC_E2E_MODEL || "qwen-local";
let port = Number(process.env.OC_A11Y_PORT || 9433);
const out = resolve("e2e/out");
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "oc-a11y-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const axeSrc = readFileSync(resolve("node_modules/axe-core/axe.min.js"), "utf8");

function gatewayKey() {
  if (process.env.OPENCLAUDE_LITELLM_KEY) return process.env.OPENCLAUDE_LITELLM_KEY;
  const f = "C:\\Users\\nikma\\Brainz\\infra\\hermes-brainz-stack\\.env";
  if (!existsSync(f)) return "";
  const m = /^\s*LITELLM_MASTER_KEY\s*=\s*(.*)$/m.exec(readFileSync(f, "utf8"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}
const KEY = gatewayKey();

function killTree(proc) {
  try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
}

async function launch() {
  port += 1;
  const proc = spawn(exe, [], {
    env: {
      ...process.env,
      OPENCLAUDE_DATA_DIR: dataDir,
      ...(KEY ? { OPENCLAUDE_LITELLM_KEY: KEY } : {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  });
  let browser;
  for (let i = 0; i < 150 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); }
  }
  if (!browser) { killTree(proc); throw new Error("could not attach to WebView2"); }
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
    if (!page) await sleep(100);
  }
  await page.waitForSelector(".sidebar", { timeout: 30000 });
  return { proc, browser, page };
}

async function stop({ proc, browser }) {
  await browser.close().catch(() => {});
  killTree(proc);
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); await sleep(200); } catch { break; }
  }
  await sleep(500);
}

// axe-core must run inside the page; the page CSP may forbid inline script tags, so fall back to a raw CDP evaluate.
async function injectAxe(page) {
  const has = () => page.evaluate(() => typeof window.axe?.run === "function").catch(() => false);
  if (await has()) return;
  await page.addScriptTag({ content: axeSrc }).catch(() => {});
  if (await has()) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Runtime.evaluate", { expression: axeSrc });
  await cdp.detach().catch(() => {});
  if (!(await has())) throw new Error("axe-core could not be injected");
}

const findings = []; // {state, theme, ruleId, impact, help, helpUrl, selector, html, summary}
const stateLog = [];

async function scan(page, state, theme = "light") {
  try {
    await injectAxe(page);
    const res = await page.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ["violations"] });
      return r.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => ({ target: n.target.join(" >> "), html: n.html.slice(0, 220), summary: (n.failureSummary || "").split("\n").slice(1, 3).join(" ").trim().slice(0, 240) })),
      }));
    });
    let nodes = 0;
    for (const v of res) {
      nodes += v.nodes.length;
      for (const n of v.nodes) findings.push({ state, theme, ruleId: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, selector: n.target, html: n.html, summary: n.summary });
    }
    stateLog.push({ state, theme, rules: res.length, nodes });
    console.log(`scanned ${state.padEnd(28)} ${theme.padEnd(5)} rules=${res.length} nodes=${nodes}`);
    await page.screenshot({ path: join(out, `a11y-${state.replace(/\W+/g, "-")}-${theme}.png`) }).catch(() => {});
  } catch (e) {
    stateLog.push({ state, theme, error: String(e).slice(0, 200) });
    console.log(`ERROR scanning ${state}: ${String(e).slice(0, 200)}`);
  }
}

async function step(name, fn) {
  try { await fn(); } catch (e) { stateLog.push({ state: name, error: String(e).slice(0, 200) }); console.log(`ERROR ${name}: ${String(e).slice(0, 200)}`); }
}

async function waitIdle(page, timeout = 120000) {
  await page.waitForSelector('.send-btn[aria-label="Send message"]', { timeout });
}

let app;
try {
  // First launch creates the schema; seed a project, a task and a workspace so those pages are scanned with content.
  const first = await launch();
  await stop(first);
  const repo = join(dataDir, "ws-repo");
  mkdirSync(repo, { recursive: true });
  execSync("git init -q && git -c user.email=e@e -c user.name=e commit -q --allow-empty -m init", { cwd: repo, shell: true });
  writeFileSync(join(repo, "new-file.txt"), "hello");
  const db = new DatabaseSync(join(dataDir, "openclaude.db"));
  const now = Date.now();
  db.prepare("INSERT INTO settings(key,value) VALUES('workspaces',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([repo]));
  db.prepare("INSERT INTO projects(id,name,instructions,default_model,created_at,updated_at) VALUES('p-a11y','Heron Project','Answer briefly.',?,?,?)").run(model, now, now);
  db.prepare("INSERT INTO project_files(id,project_id,name,text,size,created_at) VALUES('f-a11y','p-a11y','brief.md',?,100,?)").run("Internal brief. Codename BLUE-HERON-7.", now);
  db.prepare("INSERT INTO tasks(id,title,prompt,model,schedule,enabled,created_at) VALUES('t-a11y','Daily ping','Reply with one word.',?,'manual',1,?)").run(model, now);
  db.close();

  app = await launch();
  const { page } = app;
  await page.waitForSelector(".sidebar-foot .dot.ok", { timeout: 20000 }).catch(() => console.log("note: gateway not online (dot.ok not seen)"));
  await page.waitForFunction(() => !/No models|Select a model/.test(document.querySelector(".composer .picker-btn")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
  await sleep(500);

  await scan(page, "home");

  // settings, every tab
  await step("settings", async () => {
    await page.keyboard.press("Control+,");
    await page.waitForSelector('button[role="tab"]', { timeout: 5000 });
    for (const tab of ["General", "Gateway", "Providers", "Models", "Connectors", "Plugins", "Extensions", "Projects", "Diagnostics", "About"]) {
      const t = page.locator(`button[role="tab"]:has-text("${tab}")`).first();
      if (!(await t.count())) { stateLog.push({ state: `settings:${tab}`, error: "tab not found" }); continue; }
      await t.click();
      await sleep(400);
      await scan(page, `settings:${tab}`);
    }
    await page.click('[aria-label="Close settings"]').catch(() => page.keyboard.press("Escape"));
    await sleep(300);
  });

  for (const [label, name] of [["Chats", "chats page"], ["Projects", "projects page"], ["Tasks", "tasks page"], ["Code", "code page"]]) {
    await step(name, async () => {
      await page.click(`.nav-item[aria-label="${label}"]`);
      await sleep(600);
      await scan(page, name);
      if (label === "Projects") {
        const card = page.locator(".project-card").first();
        if (await card.count()) { await card.click(); await sleep(500); await scan(page, "project detail"); }
      }
      if (label === "Code") {
        const ws = page.locator(".nav-item.mono").first();
        if (await ws.count()) { await ws.click(); await sleep(1200); await scan(page, "code workspace"); }
        await page.click('button[aria-haspopup="menu"]');
        await scan(page, "code folder menu");
        await page.click('[role="menuitem"]:has-text("Remote (SSH)")');
        await sleep(300);
        await scan(page, "code remote (SSH) form");
        await page.click('form[aria-label="Remote folder over SSH"] button:has-text("Cancel")');
        await page.click('button:has-text("📱 Device")');
        await sleep(800);
        await scan(page, "code device preview");
        await page.click('[aria-label="Close device preview"]');
      }
    });
  }

  // a chat with one real exchange
  await step("chat", async () => {
    await page.keyboard.press("Control+n");
    await sleep(300);
    await page.click(".composer .picker-btn");
    await page.fill(".picker-pop input", model);
    await page.locator(".picker-item", { hasText: new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
    await page.fill(".composer textarea", "Reply with exactly: ok");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".msg.user").length > 0, null, { timeout: 20000 });
    await page.waitForSelector(".msg.assistant", { timeout: 60000 });
    await waitIdle(page);
    await sleep(500);
    await scan(page, "chat (1 message)");
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await sleep(300);
    await scan(page, "chat (1 message)", "dark");
    await page.evaluate(() => delete document.documentElement.dataset.theme);
  });

  await step("palette", async () => {
    await page.keyboard.press("Control+k");
    await page.waitForSelector('[role="dialog"][aria-label="Search chats"]', { timeout: 5000 });
    await sleep(300);
    await scan(page, "search palette");
    await page.keyboard.press("Escape");
    await sleep(300);
  });
  await step("shortcuts", async () => {
    await page.keyboard.press("Control+/");
    await page.waitForSelector('[role="dialog"][aria-label="Keyboard shortcuts"]', { timeout: 5000 });
    await sleep(300);
    await scan(page, "shortcuts sheet");
    await page.keyboard.press("Escape");
    await sleep(300);
  });

  // dark theme: home + settings General for good measure
  await step("dark home", async () => {
    await page.keyboard.press("Control+n");
    await sleep(400);
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await sleep(300);
    await scan(page, "home", "dark");
    await page.keyboard.press("Control+,");
    await sleep(500);
    await scan(page, "settings:General", "dark");
    await page.click('[aria-label="Close settings"]').catch(() => page.keyboard.press("Escape"));
    await page.evaluate(() => delete document.documentElement.dataset.theme);
  });
} catch (e) {
  console.log("HARNESS ERROR", String(e?.stack || e));
  stateLog.push({ state: "harness", error: String(e?.stack || e).slice(0, 400) });
} finally {
  if (app) await stop(app);
}

// ---- aggregate by rule
const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const byRule = new Map();
for (const f of findings) {
  const r = byRule.get(f.ruleId) || { ruleId: f.ruleId, impact: f.impact, help: f.help, helpUrl: f.helpUrl, count: 0, states: new Set(), example: null, themes: new Set() };
  r.count++;
  r.states.add(f.state);
  r.themes.add(f.theme);
  r.example ||= { state: f.state, theme: f.theme, selector: f.selector, html: f.html, summary: f.summary };
  byRule.set(f.ruleId, r);
}
const rules = [...byRule.values()]
  .map((r) => ({ ...r, states: [...r.states], themes: [...r.themes] }))
  .sort((a, b) => (order[a.impact] ?? 9) - (order[b.impact] ?? 9) || b.count - a.count);
const blocking = rules.filter((r) => r.impact === "critical" || r.impact === "serious");

writeFileSync(join(out, "a11y.json"), JSON.stringify({
  exe, at: new Date().toISOString(), axe: "4.10.3", states: stateLog, rules,
  totals: { rules: rules.length, nodes: findings.length, blockingRules: blocking.length, blockingNodes: blocking.reduce((n, r) => n + r.count, 0) },
  findings,
}, null, 2));

console.log("\nimpact    rule                         count  states / example selector");
for (const r of rules) {
  console.log(`${String(r.impact).padEnd(9)} ${r.ruleId.padEnd(28)} ${String(r.count).padStart(5)}  [${r.states.join("; ")}]  ${r.example.selector}`);
}
console.log(`\n${rules.length} rules, ${findings.length} nodes; ${blocking.length} critical/serious rule(s). Details: ${join(out, "a11y.json")}`);
const errored = stateLog.filter((s) => s.error).length;
if (errored) console.log(`${errored} state(s) could not be scanned (see a11y.json states[])`);
process.exit(blocking.length ? 1 : 0);
