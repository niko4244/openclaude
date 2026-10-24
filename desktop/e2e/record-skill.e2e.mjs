// Record-a-skill E2E: record the real primary screen for a few seconds with typed narration (no
// microphone), have a vision model on the gateway write a SKILL.md, save it, and find it in the
// "/" menu. Also checks that Cancel deletes a recording and that no frames are left after saving.
//   OPENCLAUDE_LITELLM_KEY=... OC_RECORD_MODEL=gemma4-local node e2e/record-skill.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const model = process.env.OC_RECORD_MODEL || "gemma4-local";
const port = 9600 + Math.floor(Math.random() * 50);
const data = mkdtempSync(join(tmpdir(), "oc-record-"));
const out = resolve("e2e/out");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (ms, p) => Promise.race([p, sleep(ms).then(() => false)]);
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };
const recordings = () => (existsSync(join(data, "recordings")) ? readdirSync(join(data, "recordings")).length : 0);

const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let browser;
for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
const ui = browser.contexts()[0].pages()[0];
const call = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

/** Click "Record a skill" in the composer's tools menu and return the indicator window's page. */
async function startRecording() {
  await ui.click('[aria-label="Search and tools"]');
  await ui.click('.tools-pop button:has-text("Record a skill")');
  for (let i = 0; i < 75; i++) {
    for (const pg of browser.contexts().flatMap((c) => c.pages())) {
      if (pg !== ui && !pg.isClosed() && (await within(1500, pg.locator(".recorder").count().catch(() => 0)))) return pg;
    }
    await sleep(200);
  }
  throw new Error("the recording indicator did not appear");
}

try {
  await ui.waitForSelector(".sidebar");
  await call(ui, "set_setting", { key: "record_mic", value: "false" }); // typed narration only
  const models = await call(ui, "list_models", { refresh: true });
  record("vision model is on the gateway", models.some((m) => m.id === model), model);

  // 1. Cancel: the indicator shows a live recording, Cancel deletes it
  let bar = await startRecording();
  await sleep(2500);
  const live = await call(bar, "record_status");
  const time = await within(3000, bar.locator(".rec-time").innerText());
  record("indicator window shows a live recording", live?.recording && (await bar.locator(".rec-dot").count()) === 1 && /^0:0[1-9]$/.test(time || ""), `${time}, ${live?.frames} frames`);
  record("frames are captured to a temporary folder", live?.frames >= 1 && recordings() === 1, `${live?.frames} frames`);
  const closed = bar.waitForEvent("close", { timeout: 10000 }).then(() => true, () => bar.isClosed());
  await bar.click('[aria-label="Cancel recording"]');
  await ui.waitForSelector('.toast:has-text("Recording discarded")', { timeout: 10000 });
  record("Cancel deletes the recording and closes the indicator", (await call(ui, "record_status")) === null && recordings() === 0 && (await closed));

  // 2. Record with typed narration, then review
  bar = await startRecording();
  const notes = ["I open File Explorer from the taskbar", "I go to the Downloads folder", "I sort the files by Date modified so the newest file is on top"];
  for (const n of notes) {
    await bar.fill('[aria-label="Narration note"]', n);
    await bar.keyboard.press("Enter");
    await sleep(2000);
  }
  const st = await call(bar, "record_status");
  record("typed notes are kept with timestamps", st.notes.length === 3 && st.notes[0].t_ms < st.notes[2].t_ms && st.notes[1].text === notes[1], st.notes.map((n) => n.t_ms).join(", "));
  await within(5000, bar.screenshot({ path: join(out, "record-indicator.png") }));
  await bar.click('button:has-text("Stop")');
  const dlg = ui.locator('[role="dialog"][aria-label="Record a skill"]');
  await dlg.waitFor({ timeout: 20000 });
  await ui.waitForFunction(() => document.querySelectorAll(".rd-frames img").length > 0, null, { timeout: 20000 });
  const shown = await ui.locator(".rd-frames img").count();
  record("review shows the frames the model will see", shown >= 1 && shown <= 8, `${shown} sent of ${st.frames} kept`);
  record("typed notes reach the review", (await dlg.locator(".rd-notes li").count()) === 3);
  await ui.selectOption("#rs-model", model);
  await ui.locator("#rs-narration").fill("Find the newest download.");
  await ui.screenshot({ path: join(out, "record-review.png") });

  // 3. The vision model drafts the skill; edit and save it
  const t0 = Date.now();
  await ui.click('button:has-text("Generate skill")');
  await ui.waitForFunction(() => document.querySelector("#rs-name") || document.querySelector(".record-dialog .banner"), null, { timeout: 600000 });
  const err = await ui.locator(".record-dialog .banner").innerText().catch(() => "");
  const [name, desc, body] = await Promise.all(["#rs-name", "#rs-description", "#rs-body"].map((s) => ui.inputValue(s).catch(() => "")));
  record("the vision model drafts a SKILL.md", !!name && desc.length > 10 && /step/i.test(body), err || `${((Date.now() - t0) / 1000).toFixed(0)} s · ${name}: ${desc.slice(0, 90)}`);
  await ui.screenshot({ path: join(out, "record-draft.png") });
  await ui.click('button:has-text("Save skill")');
  await ui.waitForSelector('.toast:has-text("Saved the skill")', { timeout: 15000 });
  const saved = /\/([a-z0-9-]+)\./.exec(await ui.locator(".toast").innerText())?.[1] || "";
  const file = join(data, "recorded-skills", "skills", saved, "SKILL.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const fm = /^---\nname: ([a-z0-9-]+)\ndescription: '((?:[^'\n]|'')+)'\n---\n\n/.exec(text);
  record("SKILL.md is saved with valid front matter", !!fm && fm[1] === saved && text.length > fm[0].length + 20, file);
  record("temporary frames are deleted after saving", recordings() === 0 && (await call(ui, "record_status")) === null);
  const plugins = (await call(ui, "plugins_list")).filter((p) => p.id === "recorded-skills");
  record("recorded skills are one user plugin", plugins.length === 1 && plugins[0].user_scope && plugins[0].skills === 1);

  // 4. The skill is in the "/" menu and loads like any other skill
  await ui.keyboard.press("Control+n");
  await ui.fill(".composer textarea", `/${saved}`);
  const item = ui.locator(".slash-pop .picker-item", { hasText: `/${saved}` });
  const inMenu = await item.first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  record('the skill appears in the "/" menu', inMenu, inMenu ? (await item.first().innerText()).replace(/\s+/g, " ").slice(0, 120) : "");
  const loaded = await call(ui, "slash_expand", { name: saved, args: "" }).catch((e) => String(e));
  record("it loads as a skill (skills__load path)", loaded.includes(body.trim().split("\n")[0]), loaded.slice(0, 80).replace(/\s+/g, " "));
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 500));
} finally {
  await call(ui, "record_discard").catch(() => {});
  await browser.close().catch(() => {});
  app.kill();
  process.exit(failed ? 1 : 0);
}
