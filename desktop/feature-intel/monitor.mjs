// Feature Intelligence monitor: detects changes in Claude Desktop and related
// public sources, and writes an evidence-backed change report plus draft
// issues for triage. It never installs binaries, runs downloaded code, or
// ships changes. Humans or agents pick items up through normal review.
//
//   node feature-intel/monitor.mjs            # check all sources, write report
//   node feature-intel/monitor.mjs --dry-run  # print, don't update snapshots
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "sources.json"), "utf8"));
const stateDir = join(here, "state");
const reportDir = resolve(here, "../../docs/feature-intel/reports");
const dry = process.argv.includes("--dry-run");
mkdirSync(stateDir, { recursive: true });
mkdirSync(reportDir, { recursive: true });

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const today = new Date().toISOString().slice(0, 10);

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 2).join("\n");
}

/** Each extractor returns a list of stable "items" (strings) for diffing. */
const extractors = {
  async github_releases(src) {
    const r = await fetch(`https://api.github.com/repos/${src.repo}/releases?per_page=15`, { headers: { "User-Agent": "openclaude-feature-intel" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).map((x) => `${x.tag_name} (${x.published_at?.slice(0, 10)}): ${(x.name || "").slice(0, 120)} — ${x.html_url}`);
  },
  async npm_latest(src) {
    const r = await fetch(`https://registry.npmjs.org/${src.package}/latest`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return [`${src.package}@${j.version}`];
  },
  async page_lines(src) {
    const r = await fetch(src.url, { headers: { "User-Agent": "Mozilla/5.0 openclaude-feature-intel" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = htmlToText(await r.text());
    const lines = text.split("\n");
    return src.match ? lines.filter((l) => new RegExp(src.match, "i").test(l)) : lines;
  },
  async local_claude_versions(src) {
    const base = src.path.replace("%LOCALAPPDATA%", process.env.LOCALAPPDATA || "");
    if (!existsSync(base)) return [];
    return readdirSync(base).filter((d) => /^app-\d/.test(d)).sort();
  },
};

const report = [`# Feature intelligence report — ${today}`, "", "Automated. Each item needs human/agent triage before any implementation.", ""];
const issues = [];
let changed = 0;

for (const src of cfg.sources) {
  const statePath = join(stateDir, `${src.id}.json`);
  const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  let items;
  try {
    items = await extractors[src.kind](src);
  } catch (e) {
    report.push(`## ${src.title}`, `- ⚠ fetch failed: ${e.message} (source: ${src.url || src.repo || src.package || src.path})`, "");
    continue;
  }
  const prevSet = new Set(prev?.items || []);
  const added = prev ? items.filter((i) => !prevSet.has(i)) : [];
  const removed = prev ? (prev.items || []).filter((i) => !items.includes(i)) : [];
  report.push(`## ${src.title}`, `- source: ${src.url || src.repo || src.package || src.path}`, `- category: ${src.category}`, `- items: ${items.length} · digest ${sha(items.join("\n"))}${prev ? ` (prev ${prev.digest})` : " (first baseline)"}`);
  if (!prev) report.push("- baseline recorded; future runs report differences");
  if (added.length) {
    changed++;
    report.push(`- **new (${added.length})**:`, ...added.slice(0, 40).map((a) => `  - ${a}`));
    issues.push({
      title: `[feature-intel] ${src.title}: ${added.length} change(s) on ${today}`,
      labels: ["feature-intel", src.category],
      body: [
        `Detected by \`desktop/feature-intel/monitor.mjs\` on ${today}.`,
        `Source: ${src.url || src.repo || src.package || src.path}`,
        "",
        "New items:",
        ...added.slice(0, 40).map((a) => `- ${a}`),
        "",
        "Triage checklist:",
        "- [ ] Does this affect desktop-visible behavior?",
        "- [ ] Compare with OpenClaude (docs/parity/FEATURE_MATRIX.md)",
        "- [ ] REA analysis warranted? (new app version locally installed → compare_application_versions)",
        "- [ ] Classify: supported / supported-with-differences / missing / proprietary-infra / blocked",
        "- [ ] If missing: write behavior contract, assign workstream, open PR",
      ].join("\n"),
    });
  }
  if (removed.length) report.push(`- removed (${removed.length}):`, ...removed.slice(0, 20).map((a) => `  - ${a}`));
  if (src.kind === "local_claude_versions" && added.length) {
    report.push(`- ➜ New Claude Desktop build(s) on disk. Suggested read-only REA diff: \`compare_application_versions\` between the previous baseline \`${(prev?.items || []).at(-1)}\` and \`${items.at(-1)}\` resources/app.asar.`);
  }
  report.push("");
  if (!dry) writeFileSync(statePath, JSON.stringify({ checked: new Date().toISOString(), digest: sha(items.join("\n")), items }, null, 2));
}

report.push(`---`, `${changed} source(s) changed. ${issues.length} draft issue(s) written to issues-${today}.json (not posted).`);
const md = report.join("\n");
if (dry) console.log(md);
else {
  writeFileSync(join(reportDir, `${today}.md`), md);
  writeFileSync(join(reportDir, `issues-${today}.json`), JSON.stringify(issues, null, 2));
  console.log(md);
}
