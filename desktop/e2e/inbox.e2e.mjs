// Approvals inbox + proactive assistant E2E (OpenClaude's take on Claude Duet): a background task
// that wants a non-pre-approved connector tool queues it instead of failing; approving runs it and
// the assistant continues in that chat. Uses a direct Ollama provider (no gateway needed).
//   OC_INBOX_MODEL=llama3.2:3b node e2e/inbox.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const model = `ollama::${process.env.OC_INBOX_MODEL || "llama3.2:3b"}`;
const port = 9990 + Math.floor(Math.random() * 9);
const dataDir = mkdtempSync(join(tmpdir(), "oc-inbox-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

const notes = join(dataDir, "notes_mcp.py");
writeFileSync(notes, `import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if 'id' not in m: continue
    if m['method'] == 'initialize':
        r = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'e2e-notes', 'version': '1'}}
    elif m['method'] == 'tools/list':
        r = {'tools': [{'name': 'send_note', 'description': 'Sends a note to the team. Call it whenever the user asks to send a note.', 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}, 'required': ['text']}}]}
    elif m['method'] == 'tools/call':
        r = {'content': [{'type': 'text', 'text': 'Note sent: ' + str(m['params'].get('arguments', {}).get('text', ''))}]}
    else:
        r = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': r}), flush=True)
`);

const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const ui = browser.contexts()[0].pages()[0];
const invoke = (cmd, args = {}) => ui.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const until = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await f(); if (v) return v; await sleep(1500); } return null; };

try {
  await ui.waitForSelector(".sidebar");
  await invoke("mcp_save_server", { name: "e2e-notes", config: { command: "python", args: [notes] } });
  await invoke("provider_save", { provider: { id: "ollama", name: "Ollama", base_url: "http://127.0.0.1:11434/v1", preset: "ollama", enabled: true }, apiKey: null });
  const connected = await until(async () => (await invoke("mcp_status")).some((s) => s.name === "e2e-notes" && s.state === "connected"), 30000);
  record("connector with a side-effect tool is connected", !!connected);
  await invoke("list_models", { refresh: true });

  const task = await invoke("task_save", { task: { id: "", title: "Inbox probe", prompt: "Use the send_note tool to send the note: hello team. Then reply with one short sentence.", model, schedule: "manual", enabled: true, next_run_at: null, last_run_at: null, last_status: null, last_conversation_id: null, running: false, workspace: null } });
  await invoke("task_run_now", { id: task.id });
  await ui.click('.nav-item:has-text("Tasks")');
  const row = ui.locator('.inbox [data-pending="send_note"]');
  const queued = await row.waitFor({ timeout: 240000 }).then(() => true, () => false);
  const listed = (await invoke("pending_list")).filter((p) => p.status === "pending").length;
  record("background run queues the tool call instead of failing", queued, queued ? (await row.innerText()).replace(/\s+/g, " ").slice(0, 120) : `pending_list=${listed}, inbox rows=${await ui.locator(".inbox [data-pending]").count()}, page=${(await ui.locator(".page h1").innerText().catch(() => "?"))}`);
  if (queued) {
    const pending = (await invoke("pending_list")).find((p) => p.tool === "send_note" && p.status === "pending");
    const msgs = await invoke("get_messages", { conversationId: pending.conversation_id });
    record("the chat records that the action is waiting", msgs.some((m) => m.role === "tool" && /Queued for the user's approval/.test(JSON.stringify(m.content))));
    await row.locator('button:has-text("Approve")').click();
    const done = await until(async () => (await invoke("pending_list")).find((p) => p.id === pending.id && p.status !== "pending"), 30000);
    record("approving runs the tool", done?.status === "done" && /Note sent/.test(done.result || ""), `${done?.status}: ${done?.result}`);
    const cont = await until(async () => {
      const m = await invoke("get_messages", { conversationId: pending.conversation_id });
      const i = m.findIndex((x) => x.role === "user" && /I approved the waiting action/.test(JSON.stringify(x.content)));
      return i >= 0 && m.slice(i + 1).some((x) => x.role === "assistant" && x.status !== "error") ? m : null;
    }, 180000);
    record("the assistant continues in that chat after approval", !!cont);
    record("nothing is left waiting", (await invoke("pending_list")).every((p) => p.status !== "pending"));
  }

  // proactive assistant: one click creates a morning brief and check-ins
  const card = ui.locator('[aria-label="Proactive assistant"]');
  await card.locator('select[aria-label="Model"]').selectOption(model).catch(() => {});
  await card.locator('button:has-text("Turn on")').click();
  const p = await until(async () => { const x = await invoke("proactive_get"); return x.enabled ? x : null; }, 10000);
  const tasks = await invoke("tasks_list");
  record("proactive assistant schedules a brief and check-ins", !!p && tasks.some((t) => t.title === "Morning brief" && t.schedule.startsWith("daily:") && t.enabled) && tasks.some((t) => t.title === "Check-in" && t.schedule.startsWith("every:") && t.enabled), JSON.stringify(p));
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 400));
} finally {
  await browser.close().catch(() => {});
  app.kill();
  process.exit(failed ? 1 : 0);
}
