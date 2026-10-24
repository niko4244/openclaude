// Prompt library E2E: install a collection from a local git fixture (file://), pick up an upstream
// commit and roll it back, search / preview / favorite / copy / insert a prompt (placeholders ask
// for values), use a prompt from the "/" menu, and create / edit / delete a My prompts entry.
// No model reply is needed.
//   node e2e/prompt-library.e2e.mjs [exe]
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const exe = resolve(process.argv[2] || "src-tauri/target/release/openclaude-desktop.exe");
const port = 9800 + Math.floor(Math.random() * 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const record = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!ok) failed++; };

// Fixture: a git repo holding a plain folder of markdown prompts, plus files that are not prompts.
const fixture = join(mkdtempSync(join(tmpdir(), "oc-prompt-fixture-")), "team-prompts");
const put = (rel, text) => { mkdirSync(dirname(join(fixture, rel)), { recursive: true }); writeFileSync(join(fixture, rel), text); };
put("review-pr.md", "---\ntitle: Review a pull request\ndescription: Severity-ranked review of a change\ntags: [code, review]\n---\nReview pull request $ARGUMENTS. List problems by severity and suggest a fix for each.\n");
put("release/notes.md", "---\ntitle: Draft release notes\ndescription: Notes for users, grouped by impact\ntags:\n  - writing\n  - release\n---\nWrite release notes for version {{version}} aimed at {{audience}}. Lead with what changed for them.\n");
put("README.md", "# Team prompts\nNot a prompt.\n");
put(".github/PULL_REQUEST_TEMPLATE.md", "Not a prompt either.\n");
const git = (args) => execSync(`git -c user.name=e2e -c user.email=e2e@example.invalid ${args}`, { cwd: fixture, stdio: "pipe" });
git("init -q -b main");
git("add .");
git('commit -qm "two prompts"');
const url = `file:///${fixture.replace(/\\/g, "/")}`;

// Copy touches the real clipboard: keep the user's text and put it back afterwards.
const ps = (cmd, input) => execSync(`powershell -NoProfile -Command "${cmd}"`, { encoding: "utf8", input }).replace(/\r?\n$/, "");
let savedClipboard = null;
try { savedClipboard = ps("Get-Clipboard -Raw"); } catch { /* no text on the clipboard */ }

const dataDir = mkdtempSync(join(tmpdir(), "oc-prompts-"));
const app = spawn(exe, [], { env: { ...process.env, OPENCLAUDE_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
let browser;
for (let i = 0; i < 150 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(200); } }
let ui;
for (let i = 0; i < 100 && !ui; i++) {
  ui = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
  if (!ui) await sleep(100);
}
const invoke = (cmd, args = {}) => ui.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const dialog = '[role="dialog"][aria-labelledby="library-title"]';
const titles = () => ui.locator(`${dialog} .library-row .title`).allInnerTexts();
const search = async (q) => { await ui.fill('input[aria-label="Search prompts"]', q); await sleep(150); return titles(); };
const openLibrary = async () => { await ui.click('.composer button[aria-label="Prompt library"]'); await ui.waitForSelector(dialog); await sleep(300); };
const cardText = (id) => ui.locator(`[data-collection="${id}"]`).innerText();
const waitCard = (id, re) => ui.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ""), [`[data-collection="${id}"]`, re.source], { timeout: 60000 });

try {
  await ui.waitForSelector(".sidebar");

  // 1. Settings → Prompt library: install the fixture collection
  await ui.keyboard.press("Control+,");
  await ui.click('[role="tab"]:has-text("Prompt library")');
  await ui.fill("#prompt-spec", url);
  await ui.click('button:has-text("Find prompts")');
  await ui.waitForSelector('.offer-row:has-text("team-prompts") input:checked', { timeout: 30000 });
  await ui.click('.card button.primary:has-text("Install")');
  await waitCard("team-prompts", /2 prompts/);
  const card = await cardText("team-prompts");
  record("collection installs from a git URL (README and .github skipped)", /2 prompts/.test(card), card.replace(/\s+/g, " ").slice(0, 160));
  record("installed collection updates automatically by default", await ui.locator('[data-collection="team-prompts"] label:has-text("Update automatically") input').isChecked());
  record("My prompts is listed as a collection", (await ui.locator('[data-collection="mine"]').count()) === 1);

  // 2. an upstream commit arrives through the same routine the 15-minute updater runs, and rolls back
  put("refactor.md", "---\ntitle: Refactor for readability\ntags: [code]\n---\nRefactor {{file}} for readability without changing behavior.\n");
  git("add .");
  git('commit -qm "third prompt"');
  await ui.click('button:has-text("Check for updates")');
  await waitCard("team-prompts", /3 prompts/);
  record("Check for updates pulls the new commit", /3 prompts/.test(await cardText("team-prompts")));
  await ui.click('[data-collection="team-prompts"] button:has-text("Roll back")');
  await waitCard("team-prompts", /2 prompts/);
  const pinned = !(await ui.locator('[data-collection="team-prompts"] label:has-text("Update automatically") input').isChecked());
  record("Roll back restores the previous commit and pins the collection", pinned);
  await ui.click('[data-collection="team-prompts"] label:has-text("Update automatically") input');
  await ui.click('[data-collection="team-prompts"] button:has-text("Update now")');
  await waitCard("team-prompts", /3 prompts/);
  await ui.click('[aria-label="Close settings"]');

  // 3. library: search across title, description and tags
  await openLibrary();
  const everything = await titles();
  record("library lists the collection's prompts", everything.length === 3 && everything.includes("Draft release notes"), everything.join(" | "));
  const byTitle = await search("release");
  const byTag = await search("#review");
  const byDesc = await search("impact");
  const none = await search("zzzz");
  record("search matches titles, tags and descriptions", byTitle.join() === "Draft release notes" && byTag.join() === "Review a pull request" && byDesc.join() === "Draft release notes" && none.length === 0 && (await ui.locator(`${dialog} .library-empty`).count()) === 1, `release→${byTitle} | #review→${byTag} | impact→${byDesc} | zzzz→${none.length}`);

  // 4. preview + favorite
  await search("release");
  await ui.click(`${dialog} .library-row:has-text("Draft release notes")`);
  const head = await ui.locator(`${dialog} .library-preview h3`).innerText();
  const text = await ui.locator(`${dialog} .library-text`).innerText();
  const tags = await ui.locator(`${dialog} .library-tags .tag`).allInnerTexts();
  record("preview shows title, tags and the prompt text", head === "Draft release notes" && text.includes("{{version}}") && tags.join() === "#writing,#release", `${head} | ${tags.join(" ")}`);
  await ui.click(`${dialog} button[aria-label="Favorite"]`);
  await search("");
  const favFirst = (await titles())[0];
  await ui.click(`${dialog} .library-filters button:has-text("Favorites")`);
  const favs = await titles();
  await ui.click(`${dialog} .library-filters button:has-text("All")`);
  const stored = (await invoke("prompts_list")).find((p) => p.title === "Draft release notes")?.favorite;
  record("favorites sort first, filter, and persist", favFirst === "Draft release notes" && favs.join() === "Draft release notes" && stored === true, `first=${favFirst} filter=${favs.join()} stored=${stored}`);

  // 5. copy
  await ui.click(`${dialog} .library-row:has-text("Review a pull request")`);
  await ui.click(`${dialog} .library-actions button:has-text("Copy")`);
  await sleep(500);
  const clip = ps("Get-Clipboard -Raw");
  record("Copy puts the prompt text on the clipboard", clip.startsWith("Review pull request $ARGUMENTS."), JSON.stringify(clip.slice(0, 50)));

  // 6. insert: {{var}} placeholders ask for values, then the text lands in the composer
  await ui.click(`${dialog} .library-row:has-text("Draft release notes")`);
  await ui.click(`${dialog} .library-actions button.primary:has-text("Insert")`);
  await ui.waitForSelector('[role="dialog"][aria-labelledby="fill-title"]');
  const labels = await ui.locator(".fill-dialog .field label").allInnerTexts();
  await ui.getByLabel("version", { exact: true }).fill("2.1");
  await ui.getByLabel("audience", { exact: true }).fill("admins");
  await ui.click('.fill-dialog button.primary:has-text("Insert")');
  await ui.waitForSelector('[role="dialog"][aria-labelledby="fill-title"]', { state: "detached" });
  await sleep(300);
  const composed = await ui.inputValue(".composer textarea");
  const focused = await ui.evaluate(() => document.activeElement?.matches(".composer textarea") ?? false);
  record("Insert asks for {{var}} values and fills the composer", labels.join() === "version,audience" && composed === "Write release notes for version 2.1 aimed at admins. Lead with what changed for them." && focused, JSON.stringify(composed));

  // 7. "/" menu: prompts appear next to commands; picking one asks for $ARGUMENTS
  await ui.fill(".composer textarea", "/team-prompts:review");
  const item = ui.locator('.slash-pop .picker-item:has-text("team-prompts:review-pr")');
  await item.waitFor({ timeout: 15000 });
  const badge = await item.locator(".badge").innerText();
  await ui.keyboard.press("Enter");
  await ui.waitForSelector('[role="dialog"][aria-labelledby="fill-title"]');
  const argLabel = await ui.locator(".fill-dialog .field label").allInnerTexts();
  await ui.fill("#fill-0", "#42");
  await ui.press("#fill-0", "Enter");
  await ui.waitForSelector('[role="dialog"][aria-labelledby="fill-title"]', { state: "detached" });
  await sleep(300);
  const viaSlash = await ui.inputValue(".composer textarea");
  record('"/" menu lists prompts and inserts them with $ARGUMENTS filled', badge === "prompt" && argLabel.join() === "Arguments" && viaSlash === "Review pull request #42. List problems by severity and suggest a fix for each.", `${badge} | ${JSON.stringify(viaSlash.slice(0, 60))}`);
  const expanded = await invoke("slash_expand", { name: "team-prompts:review-pr", args: "#7" });
  record('a typed "/prompt args" still expands like a command', expanded.startsWith("Review pull request #7."), JSON.stringify(expanded.slice(0, 40)));
  await ui.fill(".composer textarea", "");

  // 8. My prompts: create, edit, delete
  await openLibrary();
  await ui.click(`${dialog} .library-head button:has-text("New prompt")`);
  await ui.fill("#pe-title", "Standup summary");
  await ui.fill("#pe-desc", "Daily update for the team");
  await ui.fill("#pe-tags", "team, daily");
  await ui.fill("#pe-body", "Summarize what {{person}} did yesterday.");
  await ui.click(`${dialog} .library-edit button.primary:has-text("Save")`);
  await ui.waitForSelector(`${dialog} .library-preview h3:has-text("Standup summary")`);
  const mineDir = join(dataDir, "prompts", "mine");
  const file = join(mineDir, "standup-summary.md");
  const saved = existsSync(file) ? readFileSync(file, "utf8") : "";
  const meta = await ui.locator(`${dialog} .library-preview .muted`).first().innerText();
  record("New prompt saves to My prompts as markdown with front matter", /title: "Standup summary"/.test(saved) && /tags: \[team, daily\]/.test(saved) && saved.includes("{{person}}") && /My prompts/.test(meta), meta);
  await ui.click(`${dialog} .library-actions button:has-text("Edit")`);
  record("Edit opens with the saved values", (await ui.inputValue("#pe-desc")) === "Daily update for the team" && (await ui.inputValue("#pe-tags")) === "team, daily");
  await ui.fill("#pe-body", "Summarize what {{person}} did yesterday and plans today.");
  await ui.click(`${dialog} .library-edit button.primary:has-text("Save")`);
  await ui.waitForSelector(`${dialog} .library-text:has-text("plans today")`);
  record("Edit rewrites the same prompt", readFileSync(file, "utf8").includes("plans today") && readdirSync(mineDir).length === 1, readdirSync(mineDir).join(","));
  const byMineTag = await search("#daily");
  record("My prompts are searchable by tag", byMineTag.join() === "Standup summary", byMineTag.join());
  ui.once("dialog", (d) => void d.accept());
  await ui.click(`${dialog} .library-actions button:has-text("Delete")`);
  await ui.waitForSelector(`${dialog} .library-row:has-text("Standup summary")`, { state: "detached" });
  record("Delete removes the prompt and its file", !existsSync(file));
  await ui.keyboard.press("Escape");
  await ui.waitForSelector(dialog, { state: "detached" });
  record("Escape closes the library", (await ui.locator(dialog).count()) === 0);

  // 9. removing a collection drops its prompts and checkout
  await ui.keyboard.press("Control+,");
  await ui.click('[role="tab"]:has-text("Prompt library")');
  await ui.click('[data-collection="team-prompts"] button:has-text("Remove")');
  await ui.waitForSelector('[data-collection="team-prompts"]', { state: "detached" });
  const left = (await invoke("prompts_list")).filter((p) => p.collection === "team-prompts").length;
  const repos = join(dataDir, "prompts", "repos");
  record("Remove drops the collection's prompts and checkout", left === 0 && (!existsSync(repos) || readdirSync(repos).length === 0));
} catch (e) {
  record("harness", false, String(e?.stack || e).slice(0, 600));
} finally {
  if (savedClipboard) { try { ps("$input | Set-Clipboard", savedClipboard); } catch { /* best effort */ } }
  await browser?.close().catch(() => {});
  try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
  process.exit(failed ? 1 : 0);
}
