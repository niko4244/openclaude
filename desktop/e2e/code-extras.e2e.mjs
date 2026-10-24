// Code tab extras E2E: device emulation preview, the Pip mascot, and the Remote (SSH) form.
// Launches the release exe with an isolated profile and drives WebView2 over CDP.
//
//   node e2e/code-extras.e2e.mjs [path\to\openclaude-desktop.exe]
//
// Device emulation is asserted from INSIDE the previewed page: a local test server serves a page
// that reports its own innerWidth, user agent and touch support back to the server.
// The working indicator runs against a stub CLI (OPENCLAUDE_BIN) that speaks stream-json, so no
// model is needed. Live SSH is not exercised (no sshd on the test machine); unit tests cover it.
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const out = resolve("e2e/out");
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "oc-extras-"));
let port = 9600 + Math.floor(Math.random() * 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

function gatewayKey() {
  if (process.env.OPENCLAUDE_LITELLM_KEY) return process.env.OPENCLAUDE_LITELLM_KEY;
  const f = "C:\\Users\\nikma\\Brainz\\infra\\hermes-brainz-stack\\.env";
  if (!existsSync(f)) return "";
  const m = /^\s*LITELLM_MASTER_KEY\s*=\s*(.*)$/m.exec(readFileSync(f, "utf8"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

// ---- the page under test: reports what it sees about itself
const reports = [];
const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Device test</title>
<style>body{margin:0;font:16px system-ui;background:#eef7f4} #tap{display:block;width:100%;height:160px;margin-top:120px;font-size:24px}</style>
<button id=tap>Tap me</button><p id=out>ready</p>
<script>
const send = (kind, extra = {}) => fetch('/report?d=' + encodeURIComponent(JSON.stringify({ kind, w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
  ua: navigator.userAgent, touch: 'ontouchstart' in window, points: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches, ...extra })));
send('load');
addEventListener('resize', () => send('resize'));
let touched = false;
tap.addEventListener('touchstart', () => { touched = true; });
tap.addEventListener('click', () => { out.textContent = 'tapped'; send('tap', { touched }); });
</script>`;
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/report") { try { reports.push(JSON.parse(u.searchParams.get("d"))); } catch { /* ignore */ } res.end("ok"); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
async function waitReport(pred, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = [...reports].reverse().find(pred);
    if (r) return r;
    await sleep(200);
  }
  return null;
}

// ---- a stub OpenClaude CLI: init, then for each task a reply and (after a pause) a result
const stub = join(dataDir, "stub-cli.mjs");
writeFileSync(stub, `import readline from "node:readline";
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
say({ type: "system", subtype: "init", model: "stub", tools: [] });
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type !== "user") return;
  setTimeout(() => say({ type: "assistant", message: { content: [{ type: "text", text: "stub is working" }] } }), 300);
  setTimeout(() => say({ type: "result", is_error: false, duration_ms: 4000 }), 4000);
});
`);

function killTree(proc) {
  try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" }); } catch { /* gone */ }
}
async function launch() {
  port += 1;
  const KEY = gatewayKey();
  const proc = spawn(exe, [], {
    env: { ...process.env, OPENCLAUDE_DATA_DIR: dataDir, OPENCLAUDE_BIN: stub, ...(KEY ? { OPENCLAUDE_LITELLM_KEY: KEY } : {}), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore",
  });
  let browser;
  for (let i = 0; i < 150 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
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
  await sleep(1500);
}

let app;
try {
  app = await launch();
  const ui = app.page;
  await ui.click('.nav-item[aria-label="Code"]');

  // 1. Pip in the empty state: original pixel art in our teal accent, honouring reduced motion
  const pip = ui.locator('.code-empty svg[data-mascot="pip"]');
  await pip.waitFor({ timeout: 10000 });
  const art = await pip.evaluate((svg) => {
    const fills = [...svg.querySelectorAll("rect")].map((r) => getComputedStyle(r).fill);
    const probe = document.createElement("i");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { rects: fills.length, colors: [...new Set(fills)], accent, label: svg.getAttribute("aria-label"), w: svg.getBoundingClientRect().width };
  });
  const clay = ["rgb(217, 119, 87)", "rgb(204, 120, 92)", "rgb(218, 119, 86)"];
  record("mascot renders as a pixel grid in the Code empty state", art.rects >= 20 && art.w >= 60 && /Pip/.test(art.label || ""), `${art.rects} pixel runs, ${art.colors.length} colors, ${Math.round(art.w)} px`);
  record("mascot uses the teal accent, not clay", art.colors.includes(art.accent) && !art.colors.some((c) => clay.includes(c)), `accent ${art.accent}`);
  record("empty state copy is shown", /Ready when you are/.test(await ui.locator(".code-empty").innerText()));
  const anim = () => ui.locator(".code-empty .pip-eyes").evaluate((g) => getComputedStyle(g).animationName);
  const idle = await anim();
  await ui.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await anim();
  await ui.emulateMedia({ reducedMotion: "no-preference" });
  record("mascot blinks, and stops under prefers-reduced-motion", idle === "pip-blink" && reduced === "none", `${idle} → ${reduced}`);
  await pip.screenshot({ path: join(out, "code-extras-pip.png") });

  // 2. Device preview: web emulation of phones, asserted from inside the page
  await ui.click('button:has-text("📱 Device")');
  const panel = ui.locator('[aria-label="Device preview"]');
  await panel.waitFor({ timeout: 10000 });
  record("device preview is labelled as web emulation, not a native simulator", (await panel.locator(".badge", { hasText: "Web emulation" }).count()) === 1 && /not a native simulator/.test(await panel.innerText()));
  const presets = await panel.locator('select[aria-label="Device"] option').allInnerTexts();
  record("device presets offered", ["iPhone 16 Pro", "iPhone SE", "Pixel 8", "Galaxy S24", "iPad"].every((p) => presets.includes(p)), presets.join(", "));
  await panel.locator('select[aria-label="Device"]').selectOption({ label: "iPhone 16 Pro" }); // the last choice is remembered
  await panel.locator('input[aria-label="Preview URL"]').fill(pageUrl);
  await panel.locator('button:has-text("Open")').click();
  const first = await waitReport((r) => r.kind === "load" && r.w === 402, 30000);
  record("iPhone 16 Pro: the page sees a 402 px viewport, iPhone UA and touch", !!first && /iPhone/.test(first.ua) && first.touch && first.points > 0, first ? `${first.w}×${first.h} @${first.dpr} ${first.ua.slice(13, 45)}… touch=${first.touch}` : `reports: ${JSON.stringify(reports.slice(-2))}`);
  await panel.locator(".device-screen img").waitFor({ timeout: 15000 });
  const img = await panel.locator(".device-screen img").evaluate((i) => ({ src: i.src.slice(0, 23), w: i.naturalWidth }));
  record("screencast frames render inside the device outline", img.src === "data:image/jpeg;base64," && img.w > 0 && (await panel.locator(".device-frame.frame-island .device-notch").count()) === 1, `${img.w} px frame`);

  await panel.locator('select[aria-label="Device"]').selectOption({ label: "Pixel 8" });
  const pixel = await waitReport((r) => r.kind === "load" && r.w === 412, 20000);
  record("switching to Pixel 8 reloads as Android Chrome", !!pixel && /Android/.test(pixel.ua) && pixel.touch, pixel ? `${pixel.w}px ${pixel.ua.slice(13, 40)}…` : "no report");

  reports.length = 0;
  await panel.locator('select[aria-label="Device"]').selectOption({ label: "iPhone SE" });
  const se = await waitReport((r) => r.kind === "load" && r.w === 375, 20000);
  record("switching to iPhone SE: viewport 375 px, iPhone UA, touch, coarse pointer", !!se && /iPhone/.test(se.ua) && se.touch && se.points > 0 && se.coarse, se ? `${se.w}×${se.h} @${se.dpr} points=${se.points} coarse=${se.coarse}` : "no report");
  const geo = await panel.evaluate((p) => {
    const f = p.querySelector(".device-frame").getBoundingClientRect(), s = p.querySelector(".device-screen").getBoundingClientRect();
    return { fw: f.width, fh: f.height, sw: s.width, sh: s.height };
  });
  // iPhone SE outline: 375 + 2×14 bezel wide, 667 + 2×64 chin tall
  const hugs = Math.abs(geo.fw / geo.sw - 403 / 375) < 0.02 && Math.abs(geo.fh / geo.sh - 795 / 667) < 0.02;
  record("iPhone SE outline hugs the screen and has a home button", hugs && (await panel.locator(".device-frame.frame-home .device-home").count()) === 1, `frame ${Math.round(geo.fw)}×${Math.round(geo.fh)}, screen ${Math.round(geo.sw)}×${Math.round(geo.sh)}`);
  await ui.waitForFunction(() => /375×667/.test(document.querySelector(".device-status")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
  record("status line shows what the page reports", /375×667 CSS px · @2x · touch/.test(await panel.locator(".device-status").innerText()), await panel.locator(".device-status").innerText());

  // a tap on the outline reaches the page as a touch, then a click
  await sleep(800);
  const box = await panel.locator(".device-screen").boundingBox();
  await ui.mouse.click(box.x + box.width / 2, box.y + (200 / 667) * box.height);
  const tap = await waitReport((r) => r.kind === "tap", 10000);
  record("tapping the preview sends touch input to the page", !!tap && tap.touched === true, tap ? "touchstart + click" : "no tap report");
  await panel.screenshot({ path: join(out, "code-extras-device.png") });

  await panel.locator('button[title="Rotate"]').click();
  const rot = await waitReport((r) => r.kind === "resize" && r.w === 667, 10000);
  record("rotate turns the viewport to landscape without a reload", !!rot && rot.h === 375 && (await panel.locator(".device-frame.landscape").count()) === 1, rot ? `${rot.w}×${rot.h}` : "no resize report");
  await panel.screenshot({ path: join(out, "code-extras-device-landscape.png") });

  const nativeText = await panel.locator(".device-native").innerText();
  record("native Android Emulator: setup hint when none is installed (no settings changed)", /Android Emulator/.test(nativeText) && (/not installed|no virtual device|Start /.test(nativeText)), nativeText.replace(/\s+/g, " ").slice(0, 160));

  await panel.locator('button[aria-label="Close device preview"]').click();
  await ui.waitForSelector('[aria-label="Repository"]', { timeout: 10000 });
  await sleep(500);
  const closed = await ui.evaluate(() => window.__TAURI_INTERNALS__.invoke("device_preview_info").then(() => false, () => true));
  record("closing the panel shuts the preview browser", closed);

  // 3. Remote (SSH) option in the folder picker; input is validated before anything connects
  await ui.click('button[aria-haspopup="menu"]:has-text("Open folder")');
  await ui.click('[role="menuitem"]:has-text("Remote (SSH)")');
  const form = ui.locator('form[aria-label="Remote folder over SSH"]');
  await form.waitFor({ timeout: 5000 });
  await form.locator("#oc-ssh-host").fill("-oProxyCommand=calc");
  await form.locator("#oc-ssh-dir").fill("~/src/app");
  await form.locator('button:has-text("Connect")').click();
  const bad = await form.locator(".error-box").innerText({ timeout: 5000 }).catch(() => "");
  await form.locator("#oc-ssh-host").fill("devbox");
  await form.locator("#oc-ssh-dir").fill("relative/dir");
  await form.locator('button:has-text("Connect")').click();
  await sleep(300);
  const bad2 = await form.locator(".error-box").innerText().catch(() => "");
  record("Remote (SSH) form rejects option-like hosts and relative folders", /alias|hostname/.test(bad) && /absolute/.test(bad2), `${bad.slice(0, 50)} | ${bad2.slice(0, 50)}`);
  record("Remote (SSH) form explains the tunnel and the requirements", /reverse tunnel/.test(await form.innerText()) && /Node\.js 20\+/.test(await form.innerText()));
  await ui.screenshot({ path: join(out, "code-extras-remote-form.png") });
  await form.locator('button:has-text("Cancel")').click();
  await stop(app);

  // 4. Pip as the working indicator while the agent runs (stub CLI, granted folder)
  const repo = join(dataDir, "ws-repo");
  mkdirSync(repo, { recursive: true });
  execSync("git init -q && git -c user.email=e@e -c user.name=e commit -q --allow-empty -m init", { cwd: repo, shell: true });
  const db = new DatabaseSync(join(dataDir, "openclaude.db"));
  db.prepare("INSERT INTO settings(key,value) VALUES('workspaces',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([repo]));
  db.close();
  app = await launch();
  const u2 = app.page;
  await u2.click('.nav-item[aria-label="Code"]');
  await u2.locator(".nav-item.mono").first().click();
  const startBtn = u2.locator('button:has-text("Start agent")');
  await u2.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Start agent"); return b && !b.disabled; }, null, { timeout: 30000 }).catch(() => {});
  if (await startBtn.isDisabled()) {
    record("working indicator (needs a model id from the gateway for the picker)", false, "no model listed; set OPENCLAUDE_LITELLM_KEY");
  } else {
    await startBtn.click();
    await u2.waitForSelector("text=Agent ready", { timeout: 20000 });
    await u2.fill(".composer textarea", "say hi");
    await u2.keyboard.press("Enter");
    const working = u2.locator('.pip-working[role="status"] svg.pip.working');
    await working.waitFor({ timeout: 5000 });
    const hop = await u2.locator(".pip-working .pip-all").evaluate((g) => getComputedStyle(g).animationName);
    await u2.locator(".pip-working").screenshot({ path: join(out, "code-extras-pip-working.png") });
    await u2.emulateMedia({ reducedMotion: "reduce" });
    const still = await u2.locator(".pip-working .pip-all").evaluate((g) => getComputedStyle(g).animationName);
    await u2.emulateMedia({ reducedMotion: "no-preference" });
    record("Pip hops as the working indicator, still under reduced motion", hop === "pip-hop" && still === "none", `${hop} → ${still}`);
    const gone = await u2.waitForSelector(".pip-working", { state: "detached", timeout: 15000 }).then(() => true, () => false);
    record("the indicator goes away when the agent finishes", gone && /stub is working/.test(await u2.locator(".chat-scroll").innerText()));
    await u2.click('button:has-text("Stop agent")').catch(() => {});
  }
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 500));
} finally {
  if (app) await stop(app);
  server.close();
  process.exit(failed ? 1 : 0);
}
