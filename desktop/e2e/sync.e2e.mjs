// Sync E2E: two app profiles share one sync folder (as two devices would through a cloud drive).
// Device A creates a project and a chat, device B receives them, B deletes the chat, A drops it.
//   node e2e/sync.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const folder = mkdtempSync(join(tmpdir(), "oc-syncdir-"));
const profiles = { A: mkdtempSync(join(tmpdir(), "oc-syncA-")), B: mkdtempSync(join(tmpdir(), "oc-syncB-")) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

// One instance at a time (the app is single-instance), like a laptop and a desktop used in turn.
async function device(name, fn) {
  const port = 9850 + Math.floor(Math.random() * 50);
  const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: profiles[name], OPENCLAUDE_SYNC_DIR: folder, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
  let browser;
  for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
  const ui = browser.contexts()[0].pages()[0];
  await ui.waitForSelector(".sidebar");
  const invoke = (cmd, args = {}) => ui.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  try { return await fn(ui, invoke); } finally { await browser.close().catch(() => {}); app.kill(); await sleep(1500); }
}

try {
  const ids = await device("A", async (ui, invoke) => {
    const p = await invoke("save_project", { project: { id: "", name: "Synced project", instructions: "Answer in French.", default_model: null, updated_at: 0 } });
    const c = await invoke("create_conversation", { projectId: p.id, model: null });
    await invoke("update_conversation", { conversation: { ...c, title: "Trip planning (from A)" } });
    await invoke("set_setting", { key: "system_prompt", value: "Always cite sources." });
    const st = await invoke("sync_now");
    return { project: p.id, chat: c.id, st };
  });
  const files = readdirSync(join(folder, "OpenClaude Sync"));
  const snap = readFileSync(join(folder, "OpenClaude Sync", files[0]), "utf8");
  record("device A writes its snapshot to the sync folder", files.length === 1 && snap.includes("Trip planning (from A)"), files.join(", "));
  record("snapshot carries no secrets or permissions", !/tool_policy|api.?key|LITELLM/i.test(snap));

  await device("B", async (ui, invoke) => {
    const st = await invoke("sync_now");
    await ui.waitForSelector('.conv-title:has-text("Trip planning (from A)")', { timeout: 10000 }).catch(() => {});
    const convs = await invoke("list_conversations", { query: null, projectId: null });
    const projects = await invoke("list_projects");
    const sys = await invoke("get_setting", { key: "system_prompt" });
    const shown = await ui.locator('.conv-title:has-text("Trip planning (from A)")').count();
    record("device B receives the chat, project and preference", convs.some((c) => c.id === ids.chat && c.project_id === ids.project) && projects.some((p) => p.instructions === "Answer in French.") && sys === "Always cite sources.", `devices seen: ${st.devices.join(", ")}`);
    record("the sidebar updates without a restart", shown >= 1);
    await ui.keyboard.press("Control+,");
    const tail = folder.split(/[\\/]/).pop();
    await ui.waitForFunction((t) => [...document.querySelectorAll(".field")].some((f) => f.textContent.includes("Sync across devices") && f.textContent.includes(t) && f.textContent.includes("also syncing")), tail, { timeout: 10000 }).catch(() => {});
    const help = await ui.locator('.field:has-text("Sync across devices")').innerText();
    record("Settings shows the sync folder and the other device", help.includes("OpenClaude Sync") === false && help.includes(folder.split(/[\\/]/).pop()) && /also syncing/.test(help), help.replace(/\s+/g, " ").slice(0, 140));
    await invoke("delete_conversation", { id: ids.chat });
    await invoke("sync_now");
  });

  await device("A", async (_ui, invoke) => {
    await invoke("sync_now");
    const convs = await invoke("list_conversations", { query: null, projectId: null });
    record("a chat deleted on B is removed on A", !convs.some((c) => c.id === ids.chat));
  });
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 400));
} finally {
  process.exit(failed ? 1 : 0);
}
