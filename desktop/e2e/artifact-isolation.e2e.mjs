// Security check: an artifact iframe must not be able to call app commands.
//   node e2e/artifact-isolation.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const port = 9400 + Math.floor(Math.random() * 50);
const proc = spawn(exe, [], {
  env: { ...process.env, OPENCLAUDE_DATA_DIR: mkdtempSync(join(tmpdir(), "oc-sec-")), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const page = browser.contexts()[0].pages()[0];
await page.waitForSelector(".sidebar");
let failed = 0;
const check = (name, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${d ? "  — " + d : ""}`); if (!ok) failed++; };

// Attacker payload: tries every route to the IPC bridge and reports what happened.
const payload = `<!doctype html><script>
const out = window.__result = { internals: typeof window.__TAURI_INTERNALS__, origin: location.origin, parentAccess: null, invoke: "pending", fetchIpc: "pending" };
try { out.parentAccess = typeof window.parent.__TAURI_INTERNALS__; } catch (e) { out.parentAccess = "blocked: " + e.name; }
const to = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("no response in " + ms + "ms")), ms))]);
(async () => {
  try { const r = await to(window.__TAURI_INTERNALS__.invoke("app_info"), 3000); out.invoke = "SUCCEEDED " + JSON.stringify(r); }
  catch (e) { out.invoke = "rejected: " + String(e).slice(0, 160); }
})();
(async () => {
  try { const r = await to(fetch("http://ipc.localhost/app_info", { method: "POST", body: "{}" }), 3000); out.fetchIpc = "status " + r.status; }
  catch (e) { out.fetchIpc = "blocked: " + String(e).slice(0, 120); }
})();
</script>`;
const url = await page.evaluate((html) => window.__TAURI_INTERNALS__.invoke("artifact_put", { html }), payload);
await page.evaluate((u) => {
  const f = document.createElement("iframe");
  f.id = "sec-probe";
  f.src = u;
  f.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups");
  document.body.appendChild(f);
}, url);
await sleep(5000);
const frame = page.frames().find((f) => f.url().startsWith(url));
check("artifact frame loaded", !!frame, url);
const res = frame ? await frame.evaluate(() => window.__result) : null;
console.log("observed:", JSON.stringify(res));
if (res) {
  check("invoke from artifact is not possible", !String(res.invoke).startsWith("SUCCEEDED"), res.invoke);
  check("parent window not reachable", res.parentAccess !== "object", String(res.parentAccess));
  check("direct IPC fetch blocked", !String(res.fetchIpc).startsWith("status 2"), res.fetchIpc);
}
await browser.close();
proc.kill();
process.exit(failed ? 1 : 0);
