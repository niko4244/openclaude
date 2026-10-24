// Performance baseline for the packaged app: cold/warm start, idle memory, and a 200-message conversation.
//
//   node e2e/perf.e2e.mjs [path\to\openclaude-desktop.exe]
//
// Env: OC_PERF_PORT (default 9533). Gateway key is read from the Brainz stack .env into the child env only.
// Writes e2e/out/perf.json. No pass/fail except crashes (exit 1 on harness error).
//
// Notes on method:
//  - start time = process spawn -> `.sidebar` visible, polled over CDP (50 ms attach polling), so it includes
//    remote-debugging overhead and is a few tens of ms pessimistic vs a plain launch.
//  - memory = sum of WorkingSetSize (and PrivatePageCount) over openclaude-desktop.exe plus every descendant
//    (msedgewebview2.exe browser/renderer/gpu/utility) found by walking ParentProcessId. Working set double counts shared pages.
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
let port = Number(process.env.OC_PERF_PORT || 9533);
const out = resolve("e2e/out");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => Math.round((b / 1048576) * 10) / 10;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

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

async function launch(dataDir) {
  port += 1;
  const t0 = Date.now();
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
  for (let i = 0; i < 600 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(50); }
  }
  if (!browser) { killTree(proc); throw new Error("could not attach to WebView2"); }
  let page;
  for (let i = 0; i < 300 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
    if (!page) await sleep(30);
  }
  await page.waitForSelector(".sidebar", { timeout: 30000, state: "visible" });
  return { proc, browser, page, startMs: Date.now() - t0 };
}

async function stop({ proc, browser }) {
  await browser.close().catch(() => {});
  killTree(proc);
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); await sleep(200); } catch { break; }
  }
  await sleep(700);
}

// Sum memory over the app process and all descendants.
function memory(pid) {
  const ps = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount
$seen = @{}; $q = New-Object System.Collections.Queue; $q.Enqueue([uint32]${pid}); $seen[[uint32]${pid}] = $true
while ($q.Count) { $p = $q.Dequeue(); foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and -not $seen.ContainsKey($c.ProcessId)) { $seen[$c.ProcessId] = $true; $q.Enqueue([uint32]$c.ProcessId) } } }
$mine = $all | Where-Object { $seen.ContainsKey($_.ProcessId) }
$mine | ForEach-Object { [pscustomobject]@{ name = $_.Name; ws = [int64]$_.WorkingSetSize; priv = [int64]$_.PrivatePageCount } } | ConvertTo-Json -Compress`;
  const enc = Buffer.from(ps, "utf16le").toString("base64");
  const raw = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`, { encoding: "utf8" }).trim();
  const rows = raw ? [].concat(JSON.parse(raw)) : [];
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const byName = {};
  for (const r of rows) byName[r.name] = (byName[r.name] || 0) + r.ws;
  return {
    processes: rows.length,
    workingSetMB: mb(sum("ws")),
    privateMB: mb(sum("priv")),
    byNameMB: Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, mb(v)])),
  };
}

function seedConversation(dataDir, n = 200) {
  const db = new DatabaseSync(join(dataDir, "openclaude.db"));
  const t = Date.now() - n * 1000;
  const convId = "perf-conv-200";
  db.prepare("INSERT INTO conversations(id,title,model,created_at,updated_at) VALUES(?,?,?,?,?)").run(convId, "Perf 200 messages", "qwen-local", t, Date.now());
  const ins = db.prepare("INSERT INTO messages(id,conversation_id,seq,role,content,model_requested,model_served,status,created_at,parent_id) VALUES(?,?,?,?,?,?,?,'complete',?,?)");
  const filler = "The quick brown fox jumps over the lazy dog while the build pipeline compiles artifacts, caches dependencies, and reports metrics for every stage of the release. ";
  db.exec("BEGIN");
  let prev = null;
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    let text = `Message ${i}. ` + filler.repeat(3);
    if (role === "assistant") text = `**Answer ${i}.** ` + filler.repeat(2) + `Use \`cargo build --release\` then check the \`size\` of the binary.`;
    text = text.slice(0, 392).trimEnd() + (i === n - 1 ? " END-MARKER-LAST" : " ...");
    const id = `perf-m-${i}`;
    ins.run(id, convId, i + 1, role, JSON.stringify(text), role === "assistant" ? "qwen-local" : null, role === "assistant" ? "qwen-local" : null, t + i * 1000, prev);
    prev = id;
  }
  db.exec("COMMIT");
  db.close();
}

const result = { exe, at: new Date().toISOString(), coldStartMs: [], warmStartMs: [] };
let exit = 0;
try {
  // cold: three fresh profiles
  let lastProfile;
  for (let i = 0; i < 3; i++) {
    const dir = mkdtempSync(join(tmpdir(), "oc-perf-cold-"));
    const app = await launch(dir);
    result.coldStartMs.push(app.startMs);
    console.log(`cold #${i + 1}: ${app.startMs} ms`);
    await sleep(1000); // let the first-run DB writes settle before killing
    await stop(app);
    lastProfile = dir;
  }

  // seed the conversation into the (now migrated) profile before any further launch
  seedConversation(lastProfile, 200);

  // warm: same profile x3
  for (let i = 0; i < 3; i++) {
    const app = await launch(lastProfile);
    result.warmStartMs.push(app.startMs);
    console.log(`warm #${i + 1}: ${app.startMs} ms`);
    await sleep(500);
    await stop(app);
  }

  // idle memory + big conversation
  const app = await launch(lastProfile);
  const { page } = app;
  await page.waitForSelector(".sidebar-foot .dot.ok", { timeout: 15000 }).catch(() => {});
  console.log("idling 20 s ...");
  await sleep(20000);
  result.idleMemory = memory(app.proc.pid);
  console.log("idle memory:", JSON.stringify(result.idleMemory));

  // click -> last message visible, measured inside the page (click capture -> rAF poll for the last message in the viewport)
  const row = page.locator(".conv-item", { hasText: "Perf 200 messages" }).first();
  await row.waitFor({ timeout: 10000 });
  await page.evaluate(() => {
    window.__renderMs = new Promise((resolve) => {
      document.addEventListener("click", () => {
        const t0 = performance.now();
        const tick = () => {
          const msgs = document.querySelectorAll(".msg");
          const last = msgs[msgs.length - 1];
          const sc = document.querySelector(".chat-scroll");
          if (last && /END-MARKER-LAST/.test(last.textContent || "") && sc) {
            const r = last.getBoundingClientRect(), s = sc.getBoundingClientRect();
            if (r.top < s.bottom && r.bottom > s.top) {
              return resolve({ ms: Math.round((performance.now() - t0) * 10) / 10, msgNodes: msgs.length });
            }
          }
          if (performance.now() - t0 > 20000) return resolve({ ms: null, msgNodes: msgs.length, timeout: true });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, { capture: true, once: true });
    });
  });
  await row.click();
  result.conversationRender = await page.evaluate(() => window.__renderMs);
  console.log("render:", JSON.stringify(result.conversationRender));
  await sleep(3000);
  result.memoryWithConversation = memory(app.proc.pid);
  console.log("memory with 200-msg conversation:", JSON.stringify(result.memoryWithConversation));
  result.dom = await page.evaluate(() => ({ nodes: document.getElementsByTagName("*").length, msgs: document.querySelectorAll(".msg").length }));

  // scroll FPS proxy: programmatic scroll from bottom to top over rAF frames
  result.scroll = await page.evaluate(async () => {
    const sc = document.querySelector(".chat-scroll");
    if (!sc) return null;
    sc.scrollTop = sc.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => r()));
    const deltas = [];
    let last = performance.now();
    const total = sc.scrollHeight - sc.clientHeight;
    const frames = 180;
    for (let i = 0; i < frames; i++) {
      sc.scrollTop = total - (total * (i + 1)) / frames;
      await new Promise((r) => requestAnimationFrame(() => r()));
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    deltas.sort((a, b) => a - b);
    const sum = deltas.reduce((a, b) => a + b, 0);
    return {
      frames, avgFps: Math.round((1000 * frames) / sum), p95FrameMs: Math.round(deltas[Math.floor(frames * 0.95)] * 10) / 10,
      maxFrameMs: Math.round(deltas[frames - 1] * 10) / 10, framesOver33ms: deltas.filter((d) => d > 33.4).length, scrollHeightPx: total + sc.clientHeight,
    };
  });
  console.log("scroll:", JSON.stringify(result.scroll));
  await stop(app);

  result.summary = {
    coldMedianMs: median(result.coldStartMs), warmMedianMs: median(result.warmStartMs),
    idleWorkingSetMB: result.idleMemory.workingSetMB, idlePrivateMB: result.idleMemory.privateMB,
    convWorkingSetMB: result.memoryWithConversation.workingSetMB, convPrivateMB: result.memoryWithConversation.privateMB,
    convRenderMs: result.conversationRender?.ms,
  };
  console.log("\nmetric                         value");
  console.log(`cold start (ms) x3             ${result.coldStartMs.join(", ")}  (median ${result.summary.coldMedianMs})`);
  console.log(`warm start (ms) x3             ${result.warmStartMs.join(", ")}  (median ${result.summary.warmMedianMs})`);
  console.log(`idle 20s working set / private ${result.idleMemory.workingSetMB} MB / ${result.idleMemory.privateMB} MB  (${result.idleMemory.processes} procs)`);
  console.log(`200-msg conv working / private ${result.memoryWithConversation.workingSetMB} MB / ${result.memoryWithConversation.privateMB} MB`);
  console.log(`200-msg render (click->last)   ${result.conversationRender?.ms} ms  (${result.dom?.msgs} .msg nodes, ${result.dom?.nodes} DOM nodes)`);
  if (result.scroll) console.log(`scroll proxy                   ${result.scroll.avgFps} fps avg, p95 ${result.scroll.p95FrameMs} ms, max ${result.scroll.maxFrameMs} ms, ${result.scroll.framesOver33ms}/${result.scroll.frames} frames >33ms`);
} catch (e) {
  console.log("HARNESS ERROR", String(e?.stack || e));
  result.error = String(e?.stack || e).slice(0, 600);
  exit = 1;
} finally {
  writeFileSync(join(out, "perf.json"), JSON.stringify(result, null, 2));
  console.log(`\nWrote ${join(out, "perf.json")}`);
  process.exit(exit);
}
