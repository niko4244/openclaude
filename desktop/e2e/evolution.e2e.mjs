// Evolution page E2E: real app, isolated profile, three registry states.
//
//  1. no registry at all       -> explicit empty state, checks disabled
//  2. a populated registry     -> cards, sources, features, ledger, read-only
//  3. an engine with a stub CLI-> Check now (IPC + JSON contract + refresh),
//                                Pause, frequency and autonomy writes
//  4. a corrupt registry file  -> named as corrupt, not missing; no invented
//                                data; the broken file is left untouched
//  5. an engine that exits 3   -> the failure (status, exit code, stderr) is
//                                reported, no success toast, registry intact
//
// No network and no model: the stubs print the JSON contract the real engine
// prints, and write the registry the page reloads.
//
//   node e2e/evolution.e2e.mjs [path\to\openclaude-desktop.exe]
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

// The app is single-instance, so only one E2E may drive it at a time. This is the
// shared lock documented in docs/desktop/HANDOFF.md.
const lock = join(tmpdir(), "oc-e2e.lock");
let holdsLock = false;
async function takeLock() {
  for (let i = 0; i < 450; i++) {
    try {
      mkdirSync(lock);
      holdsLock = true;
      return;
    } catch {
      let age = 0;
      try { age = (Date.now() - statSync(lock).mtimeMs) / 60_000; } catch { /* vanished */ }
      if (age > 10) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ } continue; }
      if (i === 449) throw new Error(`another E2E holds ${lock}; remove it if that run is gone`);
      await sleep(200);
    }
  }
}

const fixtureRegistry = {
  schemaVersion: 1,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-24T09:00:00.000Z",
  lastCheck: { startedAt: "2026-10-24T08:59:00.000Z", finishedAt: "2026-10-24T09:00:00.000Z", status: "ok", added: 3, changed: 1, failed: 0, sources: 2 },
  sources: {
    "claude-release-notes": { status: "ok", checkedAt: "2026-10-24T09:00:00.000Z", itemCount: 69, error: null },
    "mcp-spec-releases": { status: "failed", checkedAt: "2026-10-24T09:00:00.000Z", itemCount: 0, error: "HTTP 500" },
  },
  signals: [
    { id: "sig_a", sourceId: "claude-release-notes", status: "new", featureId: null, title: "Scheduled tasks in Cowork" },
    { id: "sig_b", sourceId: "claude-release-notes", status: "classified", featureId: "feat_b", title: "Branching" },
  ],
  features: [
    {
      id: "feat_a", name: "Scheduled tasks in Cowork", summary: "Cowork can schedule recurring and on-demand tasks.",
      product: "cowork", category: "tasks", status: "announced", platforms: ["windows"],
      parity: { status: "missing", percent: 0, openclaudeFeature: null, notes: "", evidence: [] },
      sourceUrls: ["https://example.test/release-notes"], blockers: ["No Cowork VM"], tests: [],
      investigation: { status: "not-started", planPath: null }, implementation: { status: "not-started" },
      createdAt: "2026-10-24T08:00:00.000Z", updatedAt: "2026-10-24T08:00:00.000Z",
    },
    {
      id: "feat_b", name: "Chat branching", summary: "Edit or regenerate a turn and switch between versions.",
      product: "claude-desktop", category: "conversation", status: "implemented", platforms: ["windows"],
      parity: { status: "equivalent", percent: 100, openclaudeFeature: "Branch navigation", notes: "", evidence: [] },
      sourceUrls: [], blockers: [], tests: [],
      investigation: { status: "not-started", planPath: null }, implementation: { status: "delivered" },
      createdAt: "2026-10-24T08:00:00.000Z", updatedAt: "2026-10-24T08:00:00.000Z",
    },
  ],
};

const fixtureConfig = {
  version: 1, enabled: true, intervalHours: 6, autonomy: "research",
  monitoring: { repositoryWorkflow: true, desktopApp: true },
  budget: { paidCallsAllowed: false, maxImplementationsPerRun: 1 },
  engineering: { worktreeRoot: "../oc-evolution" },
};

const fixtureLedger = {
  version: 1,
  tasks: [{
    id: "task_a", featureId: "feat_a", title: "Scheduled tasks in Cowork", status: "queued",
    branch: "evolution/scheduled-tasks", worktree: "C:/tmp/oc-evolution/feat_a", prDraft: null,
  }],
};

/** An engine directory shaped like `desktop/feature-intel`. */
function engineDir({ registry = true, cli = false, cliScript = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oc-evo-e2e-"));
  const dir = join(root, "desktop", "feature-intel");
  mkdirSync(dir, { recursive: true });
  if (registry) {
    writeFileSync(join(dir, "registry.json"), JSON.stringify(fixtureRegistry, null, 2));
    writeFileSync(join(dir, "config.json"), JSON.stringify(fixtureConfig, null, 2));
    writeFileSync(join(dir, "ledger.json"), JSON.stringify(fixtureLedger, null, 2));
  }
  if (cliScript) {
    writeFileSync(join(dir, "cli.mjs"), cliScript);
  } else if (cli) {
    writeFileSync(join(dir, "cli.mjs"), `import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(dir, "check-called.json"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
const reg = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"));
reg.lastCheck = { finishedAt: new Date().toISOString(), status: "ok", added: 2, changed: 0, failed: 0 };
writeFileSync(join(dir, "registry.json"), JSON.stringify(reg, null, 2));
console.log(JSON.stringify({ status: "ok", added: 2, changed: 0, sources: [], summary: {} }));
`);
  }
  return { root, dir };
}

let browser;
let app;
let port = 0;

/** Ask the OS for a port nothing is listening on; fixed ranges collide with unrelated services. */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function launch(evolutionDir, dataDir) {
  port = await freePort();
  app = spawn(exe, [], {
    env: {
      ...process.env,
      OPENCLAUDE_DATA_DIR: dataDir,
      OPENCLAUDE_EVOLUTION_DIR: evolutionDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 150 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); }
  }
  if (!browser) throw new Error(`could not attach to WebView2 (exe exit code ${app.exitCode ?? "not exited"})`);
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
    if (!page) await sleep(100);
  }
  await page.waitForSelector(".sidebar", { timeout: 30000 });
  await page.click('.nav-item:has-text("Evolution")');
  await page.waitForSelector('.page h1:has-text("Evolution")', { timeout: 15000 });
  return page;
}

async function close() {
  await browser?.close().catch(() => {});
  browser = undefined;
  if (app) {
    // Kill the whole WebView2 tree; a surviving child would make the next launch
    // hand off to the single-instance plugin instead of opening a new window.
    try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
    app = undefined;
  }
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); await sleep(200); } catch { break; }
  }
  await sleep(800);
}

const config = (dir) => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));

try {
  await takeLock();

  // ---- 1. no registry -------------------------------------------------------
  {
    const { dir } = engineDir({ registry: false });
    const dataDir = mkdtempSync(join(tmpdir(), "oc-evo-profile-"));
    const ui = await launch(dir, dataDir);
    try {
      await ui.waitForSelector('.card:has-text("No feature registry on this machine")', { timeout: 15000 });
      const text = await ui.locator(".card").first().innerText();
      const check = ui.locator('button:has-text("Check for Claude updates")');
      record("empty state names the missing registry", /No registry yet/.test(text) && /does not invent one/.test(text), text.replace(/\s+/g, " ").slice(0, 120));
      record("Check now is disabled without an engine", await check.isDisabled());
      record("Pause is not offered when the registry is read-only", (await ui.locator('button:has-text("Pause")').count()) === 0);
      record("no summary cards are invented", (await ui.locator('.card:has-text("Parity coverage")').count()) === 0);
    } finally {
      await close();
    }
  }

  // ---- 2. populated registry, no engine on this machine ---------------------
  {
    const { dir } = engineDir({ registry: true, cli: false });
    const dataDir = mkdtempSync(join(tmpdir(), "oc-evo-profile-"));
    const ui = await launch(dir, dataDir);
    try {
      await ui.waitForSelector('.card:has-text("Untriaged signals")', { timeout: 15000 });
      const untriaged = await ui.locator('.card:has-text("Untriaged signals")').innerText();
      const coverage = await ui.locator('.card:has-text("Parity coverage")').innerText();
      const work = await ui.locator('.card:has-text("Native work")').innerText();
      const sweep = await ui.locator('.card:has-text("Last sweep")').innerText();
      record("untriaged signals are counted", /\b1\b/.test(untriaged) && /of 2 recorded/.test(untriaged), untriaged.replace(/\s+/g, " "));
      record("coverage treats partial as half", /50%/.test(coverage) && /1 equivalent/.test(coverage) && /1 missing/.test(coverage), coverage.replace(/\s+/g, " "));
      record("implemented work and the ledger are shown", /\b1\b/.test(work) && /1 task\(s\)/.test(work), work.replace(/\s+/g, " "));
      record("the last sweep numbers come from the registry", /\b3\b/.test(sweep) && /1 revised/.test(sweep), sweep.replace(/\s+/g, " "));

      const sources = await ui.locator('[data-source="mcp-spec-releases"]').innerText();
      record("a failed source keeps its error", /failed/.test(sources) && /HTTP 500/.test(sources), sources.replace(/\s+/g, " "));

      const names = await ui.locator("[data-feature] .card-head .name").allInnerTexts();
      record("gaps are listed before equivalent features", names[0] === "Scheduled tasks in Cowork" && names.includes("Chat branching"), names.join(" | "));
      const gap = await ui.locator('[data-feature="feat_a"]').innerText();
      record("a feature shows parity, blocker and its source", /missing/.test(gap) && /No Cowork VM/.test(gap) && /example\.test/.test(gap), gap.replace(/\s+/g, " ").slice(0, 160));

      const task = await ui.locator('[data-task="task_a"]').innerText();
      record("the implementation ledger is visible", /queued/.test(task), task.replace(/\s+/g, " "));

      record("a readable registry is reported as ok", (await ui.locator("[data-registry-state]").first().getAttribute("data-registry-state")) === "ok");
      record("a synced registry is labelled read-only", /read-only/.test(await ui.locator(".card").first().innerText()));
      record("Check now explains why it cannot run", await ui.locator('button:has-text("Check for Claude updates")').isDisabled());
      record("frequency and autonomy are not editable without an engine", (await ui.locator("#evo-interval").count()) === 0 && (await ui.locator("#evo-autonomy").count()) === 0);
    } finally {
      await close();
    }
  }

  // ---- 3. Check now, Pause, frequency, autonomy -----------------------------
  {
    const { root, dir } = engineDir({ registry: true, cli: true });
    const dataDir = mkdtempSync(join(tmpdir(), "oc-evo-profile-"));
    const ui = await launch(dir, dataDir);
    try {
      await ui.waitForSelector('.card:has-text("Untriaged signals")', { timeout: 15000 });
      record("an engine on this machine enables checks", /every 6 h/.test(await ui.locator(".card").first().innerText()));
      record("Pause is offered when the engine can run", (await ui.locator('button:has-text("Pause")').count()) === 1);

      const check = ui.locator('button:has-text("Check for Claude updates")');
      record("Check now is enabled", !(await check.isDisabled()));
      await check.click();
      await ui.waitForSelector('.toast:has-text("+2 new")', { timeout: 30000 });
      record("the toast reports the sweep result", true);

      const called = JSON.parse(readFileSync(join(dir, "check-called.json"), "utf8"));
      record("the app runs the shared engine contract", called.argv.join(" ") === "check --quiet --json" && resolve(called.cwd) === resolve(root), `${called.argv.join(" ")} @ ${called.cwd}`);
      const sweep = await ui.locator('.card:has-text("Last sweep")').innerText();
      record("the page reloads the registry after the check", /\b2\b/.test(sweep), sweep.replace(/\s+/g, " "));

      await ui.click('button:has-text("Pause")');
      await ui.waitForSelector('button:has-text("Resume")', { timeout: 10000 });
      record("Pause writes enabled:false", config(dir).enabled === false, JSON.stringify({ enabled: config(dir).enabled }));
      record("the paused state is visible", /paused/.test(await ui.locator(".card").first().innerText()));

      await ui.selectOption("#evo-interval", "12");
      await ui.waitForFunction(() => document.querySelector("#evo-interval")?.value === "12");
      record("frequency is written to config.json", config(dir).intervalHours === 12, String(config(dir).intervalHours));

      await ui.selectOption("#evo-autonomy", "implement");
      await ui.waitForFunction(() => document.querySelector("#evo-autonomy")?.value === "implement");
      record("autonomy is written to config.json", config(dir).autonomy === "implement", config(dir).autonomy);
      const hint = await ui.locator(".card").first().innerText();
      record("the autonomy hint explains the consequence", /isolated worktree/.test(hint), hint.replace(/\s+/g, " ").slice(0, 160));

      await ui.click('button:has-text("Resume")');
      await ui.waitForSelector('button:has-text("Pause")', { timeout: 10000 });
      record("Resume restores enabled:true", config(dir).enabled === true);
      record("the config keeps unrelated keys", config(dir).version === 1 && config(dir).monitoring?.desktopApp === true && existsSync(join(dir, "registry.json")));
    } finally {
      await close();
    }
  }

  // ---- 4. a corrupt registry file -------------------------------------------
  {
    const { dir } = engineDir({ registry: false });
    // what a killed sweep leaves behind: a file that exists but is truncated
    const broken = '{\n  "schemaVersion": 1,\n  "features": [\n';
    writeFileSync(join(dir, "registry.json"), broken);
    const dataDir = mkdtempSync(join(tmpdir(), "oc-evo-profile-"));
    const ui = await launch(dir, dataDir);
    try {
      await ui.waitForSelector('.card:has-text("Feature registry could not be read")', { timeout: 15000 });
      const card = await ui.locator('.card:has-text("Feature registry could not be read")').innerText();
      const state = await ui.locator("[data-registry-state]").first().getAttribute("data-registry-state");
      record("a corrupt registry is named as corrupt, not as missing", state === "invalid" && /corrupt/.test(card) && !/No feature registry/.test(card), `${state}: ${card.replace(/\s+/g, " ").slice(0, 140)}`);
      record("the parse failure and the file behind it are shown", /not valid JSON/.test(card) && /registry\.json/.test(card), card.replace(/\s+/g, " ").slice(0, 200));
      record("a corrupt registry is not replaced by invented data", (await ui.locator('.card:has-text("Parity coverage")').count()) === 0 && (await ui.locator('[data-source]').count()) === 0);
      record("Check now is disabled when only a broken file is present", await ui.locator('button:has-text("Check for Claude updates")').isDisabled());
      record("Pause is not offered for a broken registry", (await ui.locator('button:has-text("Pause")').count()) === 0);
      record("the broken file is left for a person to inspect", readFileSync(join(dir, "registry.json"), "utf8") === broken);
    } finally {
      await close();
    }
  }

  // ---- 5. a sweep whose engine exits non-zero -------------------------------
  {
    const { dir } = engineDir({
      registry: true,
      cliScript: 'process.stderr.write("simulated upstream failure: 502 bad gateway\\n");\nprocess.exit(3);\n',
    });
    const dataDir = mkdtempSync(join(tmpdir(), "oc-evo-profile-"));
    const ui = await launch(dir, dataDir);
    try {
      await ui.waitForSelector('.card:has-text("Untriaged signals")', { timeout: 15000 });
      const before = readFileSync(join(dir, "registry.json"), "utf8");
      const startSweep = await ui.locator('.card:has-text("Last sweep")').innerText();
      record("the failing engine starts from the last good sweep", /\b3\b/.test(startSweep) && /0 source\(s\) failed/.test(startSweep), startSweep.replace(/\s+/g, " "));

      await ui.click('button:has-text("Check for Claude updates")');
      await ui.waitForSelector('.toast:has-text("Check failed")', { timeout: 30000 });
      const toast = await ui.locator(".toast").innerText();
      record("a non-zero engine exit is reported as a failure", /Check failed/.test(toast) && /exit 3/.test(toast) && /failed/.test(toast), toast);
      record("the engine's stderr reaches the user", /502 bad gateway/.test(toast), toast);
      record("a failed sweep shows no success toast", (await ui.locator('.toast:has-text("Checked official sources")').count()) === 0 && /\+0 new/.test(toast) === false);
      record("a failed sweep cannot rewrite the registry", readFileSync(join(dir, "registry.json"), "utf8") === before);
      const sweep = await ui.locator('.card:has-text("Last sweep")').innerText();
      record("the page keeps the last good numbers", /\b3\b/.test(sweep) && /0 source\(s\) failed/.test(sweep), sweep.replace(/\s+/g, " "));
      await ui.waitForFunction(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Check for Claude updates"));
        return !!b && !b.disabled && !b.textContent.includes("Checking");
      }, null, { timeout: 10000 });
      record("Check now is usable again after a failure", true);
    } finally {
      await close();
    }
  }
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 600));
} finally {
  await close();
  if (holdsLock) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.exit(failed ? 1 : 0);
}
