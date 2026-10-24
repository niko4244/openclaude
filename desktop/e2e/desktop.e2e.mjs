// Real-desktop acceptance test: launches the built OpenClaude exe with an
// isolated profile, attaches to its WebView2 over CDP, and drives real flows
// against the live LiteLLM gateway. No mocks.
//
//   OPENCLAUDE_LITELLM_KEY=... node e2e/desktop.e2e.mjs [path\to\openclaude-desktop.exe]
//
// Env: OC_E2E_MODEL (default qwen-local), OPENCLAUDE_GATEWAY_URL.
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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

const within = (ms, p) => Promise.race([p, sleep(ms).then(() => false)]);

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
  await page.waitForFunction(() => !/No models|Select a model/.test(document.querySelector(".composer .picker-btn")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
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
  const voices = await page.evaluate(() => new Promise((r) => {
    const n = () => speechSynthesis.getVoices().length;
    if (n()) return r(n());
    speechSynthesis.onvoiceschanged = () => r(n());
    setTimeout(() => r(n()), 3000);
  }));
  record("read aloud available (OS voices)", (await page.locator('[aria-label="Read aloud"]').count()) > 0 && voices > 0, `${voices} voices`);
  const title = await page.locator(".conv-item.active .conv-title").innerText();
  record("conversation saved + titled", title.length > 0, title);
  await page.screenshot({ path: join(out, "02-chat.png") });

  // 2b. voice conversation: replies are spoken (speech engine stubbed so the test is silent)
  await page.evaluate(() => { window.__spoken = []; speechSynthesis.speak = (u) => window.__spoken.push(u.text); });
  await page.click('[aria-label="Search and tools"]');
  await page.locator('.tool-row:has-text("Voice conversation") input').check();
  await page.click('[aria-label="Search and tools"]');
  await sendMessage(page, "Reply with exactly one word: spoken");
  await waitIdle(page);
  const spoken = await page.waitForFunction(() => window.__spoken.length > 0 && window.__spoken.join(" "), null, { timeout: 10000 }).then((h) => h.jsonValue(), () => "");
  const shownReply = (await lastAssistantText(page)).replace(/\s+/g, " ").trim();
  const said = String(spoken).replace(/\s+/g, " ").trim();
  record("voice conversation reads replies aloud", said.length > 0 && shownReply.length > 0 && (said.includes(shownReply.slice(0, 20)) || shownReply.includes(said.slice(0, 20))), JSON.stringify(said.slice(0, 60)));
  await page.click('[aria-label="Search and tools"]');
  await page.locator('.tool-row:has-text("Voice conversation") input').uncheck();
  await page.click('[aria-label="Search and tools"]');

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
  // connector directory: search the official MCP Registry and add the first remote server
  await page.fill('[aria-label="Search the MCP Registry"]', "github");
  await page.keyboard.press("Enter");
  const firstRemote = page.locator('.card:has(.badge:text-matches("^remote")) button:has-text("Add")').first();
  const found = await firstRemote.waitFor({ timeout: 20000 }).then(() => true, () => false);
  let dirOk = false, dirDetail = "no remote results";
  if (found) {
    const before = await page.locator('.card .card-head .dot').count();
    await firstRemote.click();
    dirOk = await page.waitForFunction((n) => document.querySelectorAll(".card .card-head .dot").length > n, before, { timeout: 30000 }).then(() => true, () => false);
    dirDetail = (await page.locator(".card").filter({ has: page.locator(".dot") }).last().innerText()).replace(/\s+/g, " ").slice(0, 110);
  }
  record("connector directory adds a registry server", dirOk, dirDetail);
  await page.click('[aria-label="Close settings"]');

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
  await sendMessage(page, "Create a complete HTML page with <h1 id=\"t\">Hello Artifact</h1>. Reply with only one fenced code block whose opening line is exactly: ```html title=\"Hello page\" — no explanation.");
  await waitIdle(page, 300000);
  // Titled blocks become artifact cards and auto-open; untitled html still offers Preview.
  const autoOpened = await page.waitForSelector(".artifact-panel iframe", { timeout: 4000 }).then(() => true, () => false);
  const card = await page.locator(".artifact-card").count();
  record("artifact auto-opens as a card", autoOpened && card > 0, `auto-opened=${autoOpened}, cards=${card}`);
  const previewBtn = page.locator('.codeblock-head button:has-text("Preview")').last();
  if (autoOpened || (await previewBtn.count())) {
    if (!autoOpened) await previewBtn.click();
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
    record("artifact panel offers Download", (await page.locator('.artifact-panel button:has-text("Download")').count()) === 1);
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

  // seed a granted workspace for the Code tab, as the native folder picker would
  const repo = join(dataDir, "ws-repo");
  mkdirSync(repo, { recursive: true });
  execSync("git init -q && git -c user.email=e@e -c user.name=e commit -q --allow-empty -m init", { cwd: repo, shell: true });
  writeFileSync(join(repo, "new-file.txt"), "hello");
  const db = new DatabaseSync(join(dataDir, "openclaude.db"));
  db.prepare("INSERT INTO settings(key,value) VALUES('workspaces',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([repo]));
  // a project with a knowledge file, as the Add files dialog would have stored it
  const now = Date.now();
  db.prepare("INSERT INTO projects(id,name,instructions,default_model,created_at,updated_at) VALUES('p-e2e','Heron Project','Answer briefly.',?,?,?)").run(model, now, now);
  db.prepare("INSERT INTO project_files(id,project_id,name,text,size,created_at) VALUES('f-e2e','p-e2e','brief.md',?,100,?)").run("Internal brief. The project codename is BLUE-HERON-7. Launch is planned for spring.", now);
  db.close();

  // 8. persistence across restart
  app = await launch();
  const after = await app.page.locator(".conv-item").count();
  record("history survives restart", after === convCount && after >= 4, `${after} chats`);
  record("warm start to UI", true, `${app.startMs} ms`);
  await app.page.locator(".conv-item .conv-title", { hasText: "pong" }).first().click();
  await app.page.waitForSelector(".msg.assistant", { timeout: 10000 });
  record("reopened chat shows messages", (await app.page.locator(".msg").count()) >= 2);
  const p2 = app.page;

  // 9. find in chat
  await p2.keyboard.press("Control+f");
  await p2.fill(".findbar input", "pong");
  await p2.waitForFunction(() => /^\d+ \/ [1-9]/.test(document.querySelector(".findbar .muted")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  const findCount = await p2.locator(".findbar .muted").innerText();
  record("find in chat highlights matches", /^1 \/ [1-9]/.test(findCount), findCount);
  await p2.screenshot({ path: join(out, "08-find.png") });
  await p2.keyboard.press("Escape");

  // 9b. regenerate creates a second version; branch nav switches between them
  await p2.locator('[aria-label="Retry"]').last().click();
  await p2.waitForSelector('.send-btn[aria-label="Stop generating"]', { timeout: 10000 }).catch(() => {});
  await waitIdle(p2);
  const nav2 = await p2.locator(".msg.assistant .branch-nav span").last().innerText().catch(() => "");
  await p2.locator('.msg.assistant [aria-label="Previous version"]').last().click().catch(() => {});
  await sleep(500);
  const nav1 = await p2.locator(".msg.assistant .branch-nav span").last().innerText().catch(() => "");
  record("regenerate + branch navigation", nav2.replace(/\s/g, "") === "2/2" && nav1.replace(/\s/g, "") === "1/2", `after retry: ${nav2} → after prev: ${nav1}`);

  // 10. shortcuts sheet
  await p2.keyboard.press("Control+/");
  const sheet = await p2.locator('[role="dialog"][aria-label="Keyboard shortcuts"]').isVisible();
  record("shortcuts sheet (Ctrl+/)", sheet);
  await p2.keyboard.press("Escape");

  // 11. UI cannot grant itself folders or swap the agent binary
  const blocked = await p2.evaluate(async () => {
    const r = [];
    for (const key of ["workspaces", "openclaude_cli_path"]) {
      try { await window.__TAURI_INTERNALS__.invoke("set_setting", { key, value: "x" }); r.push(`${key}:allowed`); }
      catch { r.push(`${key}:blocked`); }
    }
    return r.join(",");
  });
  record("security settings are backend-only", !blocked.includes("allowed"), blocked);

  // 12. quick entry window -> new chat in main window
  const before = await p2.locator(".conv-item").count();
  const toggled = await within(5000, p2.evaluate(() => window.__TAURI_INTERNALS__.invoke("quick_entry_toggle").then(() => true)));
  if (!toggled) record("quick_entry_toggle returns", false, "command hung");
  let quick;
  for (let i = 0; i < 50 && !quick; i++) {
    for (const pg of app.browser.contexts().flatMap((c) => c.pages())) {
      if (pg !== p2 && (await within(1500, pg.locator(".quick textarea").count().catch(() => 0)))) quick = pg;
    }
    if (!quick) await sleep(200);
  }
  record("quick entry window opens", !!quick);
  if (quick) {
    // A hidden WebView2 never paints, so guard every call on the quick window with a timeout.
    await within(5000, quick.screenshot({ path: join(out, "09-quick-entry.png") }));
    const typed = await within(8000, (async () => {
      await quick.fill(".quick textarea", "Reply with exactly one word: quick");
      await quick.keyboard.press("Enter");
      return true;
    })());
    if (!typed) record("quick entry accepts typing", false, "quick window not interactable (hidden on blur?)");
    await p2.waitForFunction((n) => document.querySelectorAll(".conv-item").length > n, before, { timeout: 20000 }).catch(() => {});
    await waitIdle(p2).catch(() => {});
    const r = await lastAssistantText(p2);
    const asked = await p2.locator(".msg.user").last().innerText().catch(() => "");
    record("quick entry starts a chat in main window", /exactly one word: quick/.test(asked) && r.length > 0 && (await p2.locator(".conv-item").count()) > before, JSON.stringify(r.slice(0, 60)));
  }

  // 12b. quick entry recents jump to an existing chat
  await within(5000, p2.evaluate(() => window.__TAURI_INTERNALS__.invoke("quick_entry_toggle")));
  await sleep(1000);
  let qr = null;
  for (const pg of app.browser.contexts().flatMap((c) => c.pages())) {
    if (pg !== p2 && (await within(1500, pg.locator(".quick-recents button").count().catch(() => 0)))) qr = pg;
  }
  if (qr) {
    const firstTitle = await within(3000, qr.locator(".quick-recents button").first().getAttribute("title"));
    await within(5000, qr.locator(".quick-recents button").first().click());
    const opened = await p2.waitForFunction((t) => (document.querySelector(".chat-top .title")?.textContent || "") === t, firstTitle, { timeout: 10000 }).then(() => true, () => false);
    record("quick entry recents open a chat", opened, String(firstTitle).slice(0, 50));
  } else record("quick entry recents open a chat", false, "no recents row found");

  // 13. code tab: recent folder + terminal
  await p2.click('.nav-item:has-text("Code")');
  await p2.locator(".nav-item.mono").first().click();
  await p2.click('button:has-text("Terminal")');
  await p2.fill(".term-in input", "git status --short; echo done-marker");
  await p2.keyboard.press("Enter");
  const termOk = await p2.waitForFunction(() => /done-marker[\s\S]*exit 0/.test(document.querySelector(".term-out")?.textContent || ""), null, { timeout: 30000 }).then(() => true, () => false);
  const termText = await p2.locator(".term-out").innerText();
  record("code terminal runs in workspace", termOk && termText.includes("new-file.txt"), termText.split("\n").slice(-4).join(" | "));
  const gitPanel = await p2.locator('.artifact-panel .nav-item:has-text("new-file.txt")').count();
  record("code tab shows git status", gitPanel > 0);
  // worktree: create from the UI; the new worktree must be listed and opened (granted)
  await p2.fill('[aria-label="New worktree branch"]', "e2e-wt");
  await p2.click('button:has-text("New worktree")');
  const wtOk = await p2.waitForSelector('[aria-label="Worktrees"] :text("e2e-wt")', { timeout: 20000 }).then(() => true, () => false);
  const switched = await p2.waitForFunction(() => /e2e-wt/.test(document.body.innerText), null, { timeout: 5000 }).then(() => true, () => false);
  record("git worktree created from Code tab", wtOk && switched);
  await p2.screenshot({ path: join(out, "10-code-terminal.png") });

  // 14. project knowledge reaches the model
  await p2.click('.nav-item:has-text("Projects")');
  await p2.click('.project-card:has-text("Heron Project")');
  const kcard = await p2.waitForSelector('.knowledge .kfile:has-text("brief.md")', { timeout: 10000 }).then(() => 1, () => 0);
  record("project shows knowledge files", kcard === 1);
  await p2.screenshot({ path: join(out, "11-project.png") });
  await sendMessage(p2, "What is the project codename? Answer with just the codename.");
  await waitIdle(p2);
  const kr = await lastAssistantText(p2);
  record("project knowledge used in answer", /BLUE-HERON-7/i.test(kr), JSON.stringify(kr.slice(0, 80)));

  // 15. tasks: create, run now, open result
  await p2.click('.nav-item:has-text("Tasks")');
  await p2.click('button:has-text("New task")');
  await p2.fill('.field:has(label:text-is("Title")) input', "E2E ping");
  await p2.fill('.field:has(label:text-is("Prompt")) textarea', "Reply with exactly one word: tasked");
  await p2.selectOption('.field:has(label:text-is("Model")) select', model);
  await p2.click('button:has-text("Save task")');
  await p2.click('.task-row:has-text("E2E ping") button:has-text("Run now")');
  const taskOk = await p2.waitForSelector('.task-row:has-text("E2E ping") :text("ok")', { timeout: 120000 }).then(() => true, () => false);
  const tstatus = await p2.locator('.task-row:has-text("E2E ping")').innerText();
  record("task runs in background", taskOk, tstatus.replace(/\s+/g, " ").slice(0, 120));
  await p2.screenshot({ path: join(out, "12-tasks.png") });
  if (taskOk) {
    await p2.click('.task-row:has-text("E2E ping") button:has-text("Open result")');
    const opened = await p2.waitForFunction(() => /tasked/i.test([...document.querySelectorAll(".msg.assistant .assistant-body")].pop()?.textContent || ""), null, { timeout: 10000 }).then(() => true, () => false);
    record("task result opens as a chat", opened, JSON.stringify((await lastAssistantText(p2)).slice(0, 60)));
  }

  // 15b. folder task (Cowork-style): coding agent writes inside the granted folder in the background
  await p2.click('.nav-item:has-text("Tasks")');
  await p2.click('button:has-text("New task")');
  await p2.fill('.field:has(label:text-is("Title")) input', "E2E folder");
  await p2.fill('.field:has(label:text-is("Prompt")) textarea', "Use the Write tool to create a file named task_output.txt containing the word done. Then stop.");
  await p2.selectOption('.field:has(label:text-is("Model")) select', "coder-local");
  await p2.selectOption('[aria-label="Task folder"]', repo);
  await p2.click('button:has-text("Save task")');
  await p2.click('.task-row:has-text("E2E folder") button:has-text("Run now")');
  await p2.waitForSelector('.task-row:has-text("E2E folder") :text("ok")', { timeout: 600000 }).catch(() => {});
  const { existsSync } = await import("node:fs");
  record("folder task edits files in background", existsSync(join(repo, "task_output.txt")), (await p2.locator('.task-row:has-text("E2E folder")').innerText()).replace(/\s+/g, " ").slice(0, 120));

  // 17. deep link opened while running: forwarded by single-instance, prefilled, not sent
  const before2 = await p2.locator(".conv-item").count();
  spawn(exe, ["openclaude://new?prompt=Hello%20from%20a%20link"], { env: { ...process.env, OPENCLAUDE_DATA_DIR: dataDir }, stdio: "ignore" });
  const prefilled = await p2.waitForFunction(() => document.querySelector(".home .composer textarea")?.value === "Hello from a link", null, { timeout: 15000 }).then(() => true, () => false);
  record("deep link prefills a new chat (not sent)", prefilled && (await p2.locator(".conv-item").count()) === before2);

  // 18. built-in browser tools: enable in Settings, model navigates + reads a local page, approvals per chat
  const http = await import("node:http");
  const pageSrv = http.createServer((_, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>Marker page</title><h1>The magic marker is ORCHID-58</h1>"); });
  await new Promise((r) => pageSrv.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${pageSrv.address().port}/`;
  await p2.keyboard.press("Control+,");
  await p2.click('button[role="tab"]:has-text("General")');
  await p2.locator('label:has-text("Browser tools") input[type="checkbox"]').check();
  await p2.click('[aria-label="Close settings"]');
  await p2.keyboard.press("Control+n");
  await sendMessage(p2, `Use the browser tools: navigate to ${pageUrl} then read the page and tell me the magic marker.`);
  // Approve every browser step for this chat while the run is busy (slow models can take minutes).
  const until = Date.now() + 300000;
  while (Date.now() < until) {
    if (await p2.locator(".approval").count()) await p2.click('.approval button:has-text("Allow for this chat")').catch(() => {});
    if (!(await p2.locator('.send-btn[aria-label="Stop generating"]').count())) break;
    await sleep(1000);
  }
  await waitIdle(p2, 30000);
  const br = await lastAssistantText(p2);
  record("browser tools read a live page", /ORCHID-58/.test(br), JSON.stringify(br.slice(0, 80)));
  pageSrv.close();

  // 16. update check reports a status (no release is published yet, so a failure message is expected)
  await p2.keyboard.press("Control+,");
  await p2.click('button[role="tab"]:has-text("About")');
  await p2.click('button:has-text("Check for updates")');
  const upd = await p2.waitForFunction(() => {
    const t = [...document.querySelectorAll(".settings .muted")].map((e) => e.textContent || "").find((x) => /latest version|is available|Update check failed/.test(x));
    return t || null;
  }, null, { timeout: 30000 }).then((h) => h.jsonValue(), () => "");
  record("update check reports status", !!upd, String(upd).slice(0, 120));
} catch (e) {
  record("harness", false, String(e?.stack || e));
} finally {
  if (app) await stop(app);
  writeFileSync(join(out, "results.json"), JSON.stringify({ model, exe, at: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed. Screenshots + results.json in ${out}`);
  process.exit(failed ? 1 : 0);
}
