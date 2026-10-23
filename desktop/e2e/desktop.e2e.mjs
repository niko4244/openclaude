// Real-desktop acceptance test: launches the built OpenClaude exe with an
// isolated profile, attaches to its WebView2 over CDP, and drives real flows
// against the live LiteLLM gateway. No mocks.
//
//   OPENCLAUDE_LITELLM_KEY=... node e2e/desktop.e2e.mjs [path\to\openclaude-desktop.exe]
//
// Env: OC_E2E_MODEL (default qwen-local), OPENCLAUDE_GATEWAY_URL.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const model = process.env.OC_E2E_MODEL || "qwen-local";
let port = 9333;
const out = resolve("e2e/out");
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "oc-e2e-"));
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function launch() {
  port += 1; // a fresh port per launch so we can never attach to a previous instance
  const t0 = Date.now();
  const proc = spawn(exe, [], {
    env: {
      ...process.env,
      OPENCLAUDE_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  });
  let browser;
  for (let i = 0; i < 100 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); }
  }
  if (!browser) throw new Error("could not attach to WebView2");
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
    if (!page) await sleep(100);
  }
  await page.waitForSelector(".sidebar", { timeout: 30000 });
  return { proc, browser, page, startMs: Date.now() - t0 };
}

async function stop({ proc, browser }) {
  await browser.close().catch(() => {});
  proc.kill();
  // wait until the app's WebView2 tree is really gone (single-instance would otherwise swallow the relaunch)
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); await sleep(200); } catch { break; }
  }
  await sleep(500);
}

async function sendMessage(page, text, timeout = 120000) {
  const before = await page.locator(".msg.user").count();
  await page.fill(".composer textarea", text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".msg.user").length > n, before, { timeout: 20000 });
}

// A tiny stdio MCP server used to verify the tool loop end to end.
const echoPath = join(dataDir, "echo_mcp.py");
writeFileSync(echoPath, `import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if 'id' not in m: continue
    if m['method'] == 'initialize':
        r = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'e2e-echo', 'version': '1'}}
    elif m['method'] == 'tools/list':
        r = {'tools': [{'name': 'secret_word', 'description': 'Returns the secret word of the day. Call this whenever the user asks for the secret word.', 'inputSchema': {'type': 'object', 'properties': {}}}]}
    elif m['method'] == 'tools/call':
        r = {'content': [{'type': 'text', 'text': 'The secret word is PAPAYA-42.'}]}
    else:
        r = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': r}), flush=True)
`);

async function pickModel(page, id) {
  await page.click(".composer .picker-btn");
  await page.fill(".picker-pop input", id);
  await page.locator(".picker-item", { hasText: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
}

async function lastAssistantText(page) {
  return (await page.locator(".msg.assistant .assistant-body").last().innerText().catch(() => "")).trim();
}

async function waitIdle(page, timeout = 120000) {
  await page.waitForSelector('.send-btn[aria-label="Send message"]', { timeout });
}

let app;
try {
  app = await launch();
  const { page } = app;
  record("cold start to UI", true, `${app.startMs} ms`);

  // 1. gateway + catalog
  await page.waitForSelector(".sidebar-foot .dot.ok", { timeout: 20000 }).then(
    () => record("gateway online + authenticated", true),
    async () => record("gateway online + authenticated", false, await page.locator(".sidebar-foot").innerText()),
  );
  await page.click(".composer .picker-btn");
  const placeholder = await page.getAttribute(".picker-pop input", "placeholder");
  const n = Number(/Search (\d+)/.exec(placeholder || "")?.[1] || 0);
  record("live model catalog in picker", n > 0, `${n} models`);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(out, "01-home.png") });

  // 2. streaming chat
  await pickModel(page, model);
  await sendMessage(page, "Reply with exactly one word: pong");
  const sawCursor = await page.waitForSelector(".cursor", { timeout: 15000 }).then(() => true, () => false);
  await waitIdle(page);
  const reply = await lastAssistantText(page);
  record("streaming chat with " + model, /pong/i.test(reply) && sawCursor, JSON.stringify(reply.slice(0, 80)));
  const meta = await page.locator(".msg.assistant .meta").last().innerText();
  record("routing metadata shown", meta.includes(model), meta.replace(/\s+/g, " "));
  const title = await page.locator(".conv-item.active .conv-title").innerText();
  record("conversation saved + titled", title.length > 0, title);
  await page.screenshot({ path: join(out, "02-chat.png") });

  // 3. MCP connector via Settings UI
  await page.keyboard.press("Control+,");
  await page.click('button[role="tab"]:has-text("Connectors")');
  await page.fill('.field:has(label:text-is("Name")) input', "e2e-echo");
  await page.fill('.field:has(label:text-is("Command (stdio)")) input', "python");
  await page.fill('.field:has(label:text-is("Arguments")) input', `"${echoPath}"`);
  await page.click('button:has-text("Add connector")');
  const connected = await page.waitForSelector('.card:has(.name:text-is("e2e-echo")) .dot.ok', { timeout: 20000 }).then(() => true, () => false);
  record("MCP stdio connector connects", connected, connected ? "" : await page.locator('.card:has(.name:text-is("e2e-echo"))').innerText().catch(() => ""));
  await page.screenshot({ path: join(out, "03-connectors.png") });
  await page.click('button:has-text("Done")');

  // 4. tool call with approval
  await page.keyboard.press("Control+n");
  await sendMessage(page, "What is the secret word of the day? Use the secret_word tool, then tell me the word.");
  const approval = await page.waitForSelector(".approval", { timeout: 90000 }).then(() => true, () => false);
  record("tool approval requested", approval);
  if (approval) {
    await page.screenshot({ path: join(out, "04-approval.png") });
    await page.click('.approval button:has-text("Allow once")');
    await waitIdle(page, 120000);
    const answer = await lastAssistantText(page);
    const toolCard = await page.locator(".tool-card").count();
    record("tool executed + answer uses result", toolCard > 0 && /PAPAYA/i.test(answer), JSON.stringify(answer.slice(0, 100)));
    await page.screenshot({ path: join(out, "05-tool-result.png") });
  }

  // 5. cancellation
  await page.keyboard.press("Control+n");
  await sendMessage(page, "Write a 600-word essay about rivers.");
  await page.waitForSelector(".assistant-body .cursor", { timeout: 30000 }).catch(() => {});
  await sleep(800);
  await page.click('.send-btn[aria-label="Stop generating"]');
  await waitIdle(page, 20000);
  const stopped = await page.locator(".msg.assistant .meta .warn", { hasText: "stopped" }).count();
  record("stop generation keeps partial reply", stopped > 0);

  // 6. artifact preview in isolated origin
  await page.keyboard.press("Control+n");
  await sendMessage(page, "Output only a complete HTML document in a ```html code block: a page with <h1 id=\"t\">Hello Artifact</h1>. No explanation.");
  await waitIdle(page);
  const previewBtn = page.locator('.codeblock-head button:has-text("Preview")').last();
  if (await previewBtn.count()) {
    await previewBtn.click();
    const frame = page.frameLocator(".artifact-panel iframe");
    const ok = await frame.locator("h1").first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    // Tauri injects its IPC shim into subframes too; what matters is that calls from the
    // artifact origin never succeed (capability origin check + artifact CSP).
    const ipcBlocked = ok
      ? await page.frames().find((f) => f.url().includes("artifact.localhost"))?.evaluate(async () => {
          const t = new Promise((r) => setTimeout(() => r("timeout"), 3000));
          const call = (window.__TAURI_INTERNALS__?.invoke("app_info") ?? Promise.reject("no ipc")).then(() => "succeeded", () => "rejected");
          return (await Promise.race([call, t])) !== "succeeded";
        }).catch(() => true)
      : false;
    record("HTML artifact renders sandboxed", ok, ok ? "" : "h1 not found in preview");
    record("artifact has no Tauri IPC access", ipcBlocked === true);
    await page.screenshot({ path: join(out, "06-artifact.png") });
  } else {
    record("HTML artifact renders sandboxed", false, "model did not return an html code block");
  }

  // 7. theme
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.screenshot({ path: join(out, "07-dark.png") });
  await page.evaluate(() => delete document.documentElement.dataset.theme);

  const convCount = await page.locator(".conv-item").count();
  await stop(app);

  // 8. persistence across restart
  app = await launch();
  const after = await app.page.locator(".conv-item").count();
  record("history survives restart", after === convCount && after >= 4, `${after} chats`);
  record("warm start to UI", true, `${app.startMs} ms`);
  await app.page.locator(".conv-item .conv-title", { hasText: "pong" }).first().click();
  await app.page.waitForSelector(".msg.assistant", { timeout: 10000 });
  record("reopened chat shows messages", (await app.page.locator(".msg").count()) >= 2);
} catch (e) {
  record("harness", false, String(e?.stack || e));
} finally {
  if (app) await stop(app);
  writeFileSync(join(out, "results.json"), JSON.stringify({ model, exe, at: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed. Screenshots + results.json in ${out}`);
  process.exit(failed ? 1 : 0);
}
