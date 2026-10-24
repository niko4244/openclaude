//! Claude-format plugins (the Claude Code / Claude Desktop layout): skills, slash commands,
//! agents, MCP servers and context hooks. Installed from GitHub with git and kept current
//! automatically, or read in place from Claude Code, Claude Desktop and user skill folders.

use crate::mcp::ServerConfig;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const OFFICIAL: &str = "anthropics/claude-plugins-official";
pub const KNOWLEDGE_WORK: &str = "anthropics/knowledge-work-plugins";
pub const PONYTAIL: &str = "DietrichGebert/ponytail";
/// How often installed GitHub plugins are checked for new commits.
pub const CHECK_EVERY: Duration = Duration::from_secs(15 * 60);
/// Longest a chat waits on plugin hooks.
const HOOK_CAP_SECS: u64 = 30;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Source {
    /// A git repository; `subdir` is the plugin root inside it.
    Git {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marketplace: Option<String>,
    },
    /// Read in place; another app (or the user) keeps it current.
    Local { path: PathBuf, origin: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: Option<String>,
    pub source: Source,
    pub root: PathBuf,
    /// The git checkout (Git sources only).
    #[serde(default)]
    pub repo_dir: Option<PathBuf>,
    pub enabled: bool,
    pub auto_update: bool,
    /// Run its SessionStart / UserPromptSubmit hooks.
    pub hooks: bool,
    /// A user folder such as ~/.claude: skills, commands and agents only.
    #[serde(default)]
    pub user_scope: bool,
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub prev_sha: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub checked_at: i64,
    #[serde(default)]
    pub error: Option<String>,
    /// Connector names this plugin added to mcp.json.
    #[serde(default)]
    pub mcp_servers: Vec<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Registry {
    #[serde(default)]
    pub plugins: Vec<Plugin>,
}

impl Registry {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct Component {
    /// "skill" | "command" | "agent"
    pub kind: &'static str,
    /// Invocation name: `plugin:name`, or the bare name for user folders.
    pub name: String,
    pub plugin: String,
    pub description: String,
    pub arg_hint: Option<String>,
    pub path: PathBuf,
}

pub struct Plugins {
    pub dir: PathBuf,
    index: Mutex<Option<(Instant, Arc<Vec<Component>>)>>,
    session_ctx: Mutex<HashMap<String, String>>,
    /// Serializes installs and updates.
    pub busy: tokio::sync::Mutex<()>,
}

pub fn now() -> i64 {
    crate::db::now_ms()
}

impl Plugins {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, index: Mutex::new(None), session_ctx: Mutex::new(HashMap::new()), busy: tokio::sync::Mutex::new(()) }
    }
    pub fn registry_path(&self) -> PathBuf {
        self.dir.join("registry.json")
    }
    pub fn registry(&self) -> Registry {
        Registry::load(&self.registry_path())
    }
    pub fn save(&self, r: &Registry) -> Result<()> {
        r.save(&self.registry_path())?;
        *self.index.lock().unwrap() = None;
        Ok(())
    }
    fn repos_dir(&self) -> PathBuf {
        self.dir.join("repos")
    }
    /// CLAUDE_CONFIG_DIR for hooks: an app-owned folder, so plugins never write into ~/.claude.
    /// Its settings declare an empty status line (this app has none to set up).
    pub fn config_dir(&self) -> PathBuf {
        let d = self.dir.join("claude-config");
        let settings = d.join("settings.json");
        if !settings.exists() {
            let _ = std::fs::create_dir_all(&d);
            let _ = std::fs::write(&settings, r#"{"statusLine":{"type":"command","command":""}}"#);
        }
        d
    }
    /// Working directory for hooks of plain chats (no project folder).
    fn hook_cwd(&self) -> PathBuf {
        let d = self.dir.join("workspace");
        let _ = std::fs::create_dir_all(&d);
        d
    }

    /// Skills, commands and agents of enabled plugins (cached briefly; folders change outside the app).
    pub fn index(&self) -> Arc<Vec<Component>> {
        if let Some((t, idx)) = self.index.lock().unwrap().as_ref() {
            if t.elapsed() < Duration::from_secs(30) {
                return idx.clone();
            }
        }
        let mut seen = std::collections::HashSet::new();
        let mut all: Vec<Component> = self
            .registry()
            .plugins
            .iter()
            .filter(|p| p.enabled)
            .flat_map(components)
            .filter(|c| seen.insert(c.name.clone()))
            .collect();
        all.sort_by(|a, b| a.name.cmp(&b.name));
        let idx = Arc::new(all);
        *self.index.lock().unwrap() = Some((Instant::now(), idx.clone()));
        idx
    }

    /// Drop the cached index after a component file was written.
    pub fn reindex(&self) {
        *self.index.lock().unwrap() = None;
    }

    pub fn find(&self, name: &str) -> Option<Component> {
        let idx = self.index();
        let name = name.trim().trim_start_matches('/');
        if let Some(c) = idx.iter().find(|c| c.name == name) {
            return Some(c.clone());
        }
        // `ponytail` for `ponytail:ponytail` when unambiguous.
        let mut short = idx.iter().filter(|c| c.name.rsplit(':').next() == Some(name));
        match (short.next(), short.next()) {
            (Some(c), None) => Some(c.clone()),
            _ => None,
        }
    }

    /// Plugin folders for the OpenClaude CLI (Code tab, folder tasks), which loads them natively.
    /// Skips plugins the CLI already loads from its own ~/.claude install, so hooks never run twice.
    pub fn cli_plugin_dirs(&self) -> Vec<PathBuf> {
        let own = dirs::home_dir().and_then(|h| read_json(&h.join(".claude").join("plugins").join("installed_plugins.json"))).unwrap_or(Value::Null);
        let cli_has = |name: &str| own["plugins"].as_object().is_some_and(|m| m.keys().any(|k| k.split('@').next() == Some(name)));
        self.registry()
            .plugins
            .into_iter()
            .filter(|p| p.enabled && !p.user_scope && !cli_has(&p.name) && p.root.join(".claude-plugin").join("plugin.json").is_file())
            .map(|p| p.root)
            .collect()
    }

    // ---------- hooks

    /// SessionStart context for a chat; runs once per chat per app run.
    pub async fn session_context(&self, cid: &str, fresh: bool) -> String {
        if let Some(c) = self.session_ctx.lock().unwrap().get(cid) {
            return c.clone();
        }
        let source = if fresh { "startup" } else { "resume" };
        let (ctx, _) = self.run_event("SessionStart", source, json!({"session_id": cid, "source": source})).await;
        self.session_ctx.lock().unwrap().insert(cid.to_string(), ctx.clone());
        ctx
    }

    /// UserPromptSubmit context; Err(reason) when a hook blocks the prompt.
    pub async fn prompt_context(&self, cid: &str, prompt: &str) -> std::result::Result<String, String> {
        let (ctx, block) = self.run_event("UserPromptSubmit", "", json!({"session_id": cid, "prompt": prompt})).await;
        match block {
            Some(reason) => Err(reason),
            None => Ok(ctx),
        }
    }

    async fn run_event(&self, event: &str, source: &str, mut input: Value) -> (String, Option<String>) {
        let cmds: Vec<HookCmd> = self
            .registry()
            .plugins
            .iter()
            .filter(|p| p.enabled && p.hooks && !p.user_scope)
            .flat_map(|p| hooks_for(p, event, source))
            .collect();
        if cmds.is_empty() {
            return (String::new(), None);
        }
        let cwd = self.hook_cwd();
        let cfg = self.config_dir();
        input["hook_event_name"] = json!(event);
        input["cwd"] = json!(cwd);
        input["transcript_path"] = json!("");
        input["permission_mode"] = json!("default");
        let runs = cmds.iter().map(|h| run_hook(h, &input, &cwd, &cfg));
        let results = futures_util::future::join_all(runs).await;
        let mut parts = vec![];
        let mut block = None;
        for (h, r) in cmds.iter().zip(results) {
            match r {
                Ok(o) => {
                    if let Some(c) = o.context {
                        parts.push(format!("<plugin-context plugin=\"{}\">\n{}\n</plugin-context>", h.plugin, c.trim()));
                    }
                    if block.is_none() {
                        block = o.block.map(|b| format!("{} ({}): {b}", h.plugin, event));
                    }
                }
                Err(e) => eprintln!("plugin hook {} {event} failed: {e}", h.plugin),
            }
        }
        (parts.join("\n\n"), block)
    }

    // ---------- install / update

    pub async fn install(&self, name_hint: &str, source: Source) -> Result<Plugin> {
        let _g = self.busy.lock().await;
        let mut reg = self.registry();
        let mut p = match &source {
            Source::Local { path, origin } => local_plugin(path, origin, false, Some(name_hint)),
            Source::Git { url, git_ref, subdir, marketplace } => {
                let dest = self.repos_dir().join(slug(&format!("{}-{}", marketplace.as_deref().unwrap_or("gh"), name_hint)));
                if dest.exists() {
                    self.remove_tree(&dest)?;
                }
                std::fs::create_dir_all(self.repos_dir())?;
                clone(url, git_ref.as_deref(), subdir.as_deref(), &dest).await?;
                let root = subdir.as_ref().map(|s| dest.join(s)).unwrap_or_else(|| dest.clone());
                if !root.is_dir() {
                    let _ = self.remove_tree(&dest);
                    bail!("{} has no folder {}", url, subdir.as_deref().unwrap_or(""));
                }
                let mut p = local_plugin(&root, "", false, Some(name_hint));
                p.source = source.clone();
                p.repo_dir = Some(dest.clone());
                p.sha = git(Some(&dest), &["rev-parse", "HEAD"]).await.ok();
                p.auto_update = true;
                if let Some(m) = marketplace {
                    p.id = format!("{}@{m}", p.name);
                }
                p
            }
        };
        p.updated_at = now();
        if let Some(old) = reg.plugins.iter().find(|x| x.id == p.id) {
            // Reinstall keeps the user's switches.
            p.enabled = old.enabled;
            p.hooks = old.hooks;
            p.mcp_servers = old.mcp_servers.clone();
        }
        reg.plugins.retain(|x| x.id != p.id);
        reg.plugins.push(p.clone());
        self.save(&reg)?;
        Ok(p)
    }

    pub fn add_local(&self, path: &Path, origin: &str, user_scope: bool, name_hint: Option<&str>) -> Result<Plugin> {
        let mut reg = self.registry();
        let p = local_plugin(path, origin, user_scope, name_hint);
        reg.plugins.retain(|x| x.id != p.id);
        reg.plugins.push(p.clone());
        self.save(&reg)?;
        Ok(p)
    }

    /// Removes the registry entry and, for GitHub installs, its checkout. Returns the removed plugin.
    pub fn remove(&self, id: &str) -> Result<Plugin> {
        let mut reg = self.registry();
        let pos = reg.plugins.iter().position(|p| p.id == id).ok_or_else(|| anyhow!("no plugin {id}"))?;
        let p = reg.plugins.remove(pos);
        if let Some(d) = &p.repo_dir {
            self.remove_tree(d)?;
        }
        self.save(&reg)?;
        Ok(p)
    }

    pub fn update_entry(&self, id: &str, f: impl FnOnce(&mut Plugin)) -> Result<Plugin> {
        let mut reg = self.registry();
        let p = reg.plugins.iter_mut().find(|p| p.id == id).ok_or_else(|| anyhow!("no plugin {id}"))?;
        f(p);
        let out = p.clone();
        self.save(&reg)?;
        Ok(out)
    }

    /// Checks one GitHub plugin; with `apply`, moves it to the newest commit.
    /// Ok(Some(changed)) when there was a new commit; `changed` is false when only other parts
    /// of a shared marketplace repo moved.
    pub async fn update(&self, id: &str, apply: bool) -> Result<Option<bool>> {
        let p = self.registry().plugins.into_iter().find(|p| p.id == id).ok_or_else(|| anyhow!("no plugin {id}"))?;
        let (Source::Git { git_ref, subdir, .. }, Some(dir)) = (&p.source, &p.repo_dir) else {
            return Ok(None);
        };
        let r = git_ref.as_deref().unwrap_or("HEAD");
        let result: Result<Option<(String, String, bool)>> = async {
            let remote = git(Some(dir), &["ls-remote", "origin", r]).await?;
            let remote = remote.split_whitespace().next().ok_or_else(|| anyhow!("{r} not found on the remote"))?.to_string();
            let local = git(Some(dir), &["rev-parse", "HEAD"]).await?;
            if remote == local || !apply {
                return Ok((remote != local).then(|| (local.clone(), remote, true)));
            }
            let _g = self.busy.lock().await;
            git(Some(dir), &["fetch", "--depth", "1", "--quiet", "origin", r]).await?;
            let changed = match subdir {
                Some(s) => git(Some(dir), &["rev-parse", &format!("FETCH_HEAD:{s}")]).await.ok() != git(Some(dir), &["rev-parse", &format!("HEAD:{s}")]).await.ok(),
                None => true,
            };
            git(Some(dir), &["reset", "--hard", "--quiet", "FETCH_HEAD"]).await?;
            let new = git(Some(dir), &["rev-parse", "HEAD"]).await?;
            Ok(Some((local, new, changed)))
        }
        .await;
        let manifest = plugin_manifest(&p.root);
        let out = match &result {
            Ok(Some((_, _, changed))) => Some(*changed),
            _ => None,
        };
        self.update_entry(id, |e| {
            e.checked_at = now();
            match result {
                Ok(Some((old, new, _))) if apply => {
                    e.prev_sha = Some(old);
                    e.sha = Some(new);
                    e.updated_at = now();
                    e.version = manifest["version"].as_str().map(str::to_string).or(e.version.take());
                    e.error = None;
                }
                Ok(_) => e.error = None,
                Err(err) => e.error = Some(err.to_string()),
            }
        })?;
        Ok(out)
    }

    /// Back to the commit before the last update; pins the plugin (auto-update off).
    pub async fn rollback(&self, id: &str) -> Result<Plugin> {
        let p = self.registry().plugins.into_iter().find(|p| p.id == id).ok_or_else(|| anyhow!("no plugin {id}"))?;
        let (Some(dir), Some(prev)) = (&p.repo_dir, &p.prev_sha) else { bail!("nothing to roll back to") };
        let _g = self.busy.lock().await;
        git(Some(dir), &["reset", "--hard", "--quiet", prev]).await?;
        let prev = prev.clone();
        self.update_entry(id, |e| {
            e.prev_sha = e.sha.take();
            e.sha = Some(prev);
            e.auto_update = false;
            e.updated_at = now();
        })
    }

    /// Updates every enabled, auto-updating GitHub plugin. Returns names whose contents changed.
    pub async fn update_all(&self) -> Vec<String> {
        let ids: Vec<(String, String)> = self
            .registry()
            .plugins
            .into_iter()
            .filter(|p| p.enabled && p.auto_update && p.repo_dir.is_some())
            .map(|p| (p.id, p.name))
            .collect();
        let mut changed = vec![];
        for (id, name) in ids {
            if let Ok(Some(true)) = self.update(&id, true).await {
                changed.push(name);
            }
        }
        if !changed.is_empty() {
            self.session_ctx.lock().unwrap().clear();
        }
        changed
    }

    /// Deletes a checkout; refuses anything outside the plugin repos folder.
    fn remove_tree(&self, p: &Path) -> Result<()> {
        if !p.starts_with(self.repos_dir()) || p == self.repos_dir() {
            bail!("refusing to delete {}", p.display());
        }
        // git marks pack files read-only, which remove_dir_all cannot delete on Windows.
        fn writable(p: &Path) {
            if let Ok(rd) = std::fs::read_dir(p) {
                for e in rd.flatten() {
                    let path = e.path();
                    if path.is_dir() {
                        writable(&path);
                    } else if let Ok(m) = std::fs::metadata(&path) {
                        let mut perm = m.permissions();
                        #[allow(clippy::permissions_set_readonly_false)]
                        perm.set_readonly(false);
                        let _ = std::fs::set_permissions(&path, perm);
                    }
                }
            }
        }
        writable(p);
        std::fs::remove_dir_all(p).with_context(|| format!("delete {}", p.display()))
    }
}

pub fn slug(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c.to_ascii_lowercase() } else { '-' }).collect()
}

pub fn read_json(p: &Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
}

pub fn plugin_manifest(root: &Path) -> Value {
    read_json(&root.join(".claude-plugin").join("plugin.json")).unwrap_or(Value::Null)
}

pub fn local_plugin(root: &Path, origin: &str, user_scope: bool, name_hint: Option<&str>) -> Plugin {
    let m = plugin_manifest(root);
    let dir_name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let name = m["name"].as_str().map(str::to_string).or(name_hint.map(str::to_string)).unwrap_or(dir_name);
    Plugin {
        id: name.clone(),
        name,
        description: m["description"].as_str().unwrap_or_default().to_string(),
        version: m["version"].as_str().map(str::to_string),
        source: Source::Local { path: root.to_path_buf(), origin: origin.to_string() },
        root: root.to_path_buf(),
        repo_dir: None,
        enabled: true,
        auto_update: false,
        hooks: !user_scope,
        user_scope,
        sha: None,
        prev_sha: None,
        updated_at: now(),
        checked_at: 0,
        error: None,
        mcp_servers: vec![],
    }
}

// ---------- components

pub fn components(p: &Plugin) -> Vec<Component> {
    let mut out = vec![];
    let name_for = |n: &str| if p.user_scope { n.to_string() } else { format!("{}:{n}", p.name) };
    let mut push = |kind: &'static str, default_name: String, path: PathBuf| {
        let Ok(text) = std::fs::read_to_string(&path) else { return };
        let (fm, _) = frontmatter(&text);
        let name = fm.get("name").filter(|s| !s.is_empty() && kind != "command").cloned().unwrap_or(default_name);
        out.push(Component {
            kind,
            name: name_for(&name),
            plugin: p.name.clone(),
            description: fm.get("description").cloned().unwrap_or_default(),
            arg_hint: fm.get("argument-hint").cloned().filter(|s| !s.is_empty()),
            path,
        });
    };
    for e in read_dir_sorted(&p.root.join("skills")) {
        let f = e.join("SKILL.md");
        if f.is_file() {
            push("skill", file_name(&e), f);
        }
    }
    let mut cmds = vec![];
    md_files(&p.root.join("commands"), "", &mut cmds);
    for (rel, f) in cmds {
        push("command", rel, f);
    }
    let mut agents = vec![];
    md_files(&p.root.join("agents"), "", &mut agents);
    for (rel, f) in agents {
        push("agent", rel, f);
    }
    out
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

fn read_dir_sorted(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
    v.sort();
    v
}

/// `*.md` under `dir`; subfolders namespace the name with `:` (Claude Code convention).
fn md_files(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    for p in read_dir_sorted(dir) {
        let n = file_name(&p);
        if p.is_dir() {
            md_files(&p, &format!("{prefix}{n}:"), out);
        } else if let Some(stem) = n.strip_suffix(".md") {
            if !stem.eq_ignore_ascii_case("readme") {
                out.push((format!("{prefix}{stem}"), p));
            }
        }
    }
}

/// Minimal YAML front matter: `key: value`, quoted values, `>`/`|` blocks and folded continuations.
pub fn frontmatter(text: &str) -> (HashMap<String, String>, String) {
    let t = text.trim_start_matches('\u{feff}');
    let lines: Vec<&str> = t.lines().collect();
    let mut map = HashMap::new();
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return (map, t.to_string());
    }
    let Some(end) = lines.iter().skip(1).position(|l| l.trim_end() == "---").map(|i| i + 1) else {
        return (map, t.to_string());
    };
    let mut key: Option<String> = None;
    let mut literal = false;
    let mut buf: Vec<String> = vec![];
    let mut flush = |key: &mut Option<String>, literal: bool, buf: &mut Vec<String>| {
        if let Some(k) = key.take() {
            let v = if literal { buf.join("\n").trim().to_string() } else { buf.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ") };
            map.insert(k, v);
        }
        buf.clear();
    };
    for line in &lines[1..end] {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented || line.trim().is_empty() {
            if key.is_some() {
                buf.push(line.trim().to_string());
            }
            continue;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        flush(&mut key, literal, &mut buf);
        let v = v.trim();
        key = Some(k.trim().to_string());
        literal = v.starts_with('|');
        if !v.starts_with('|') && !v.starts_with('>') {
            buf.push(unquote(v));
        }
    }
    flush(&mut key, literal, &mut buf);
    (map, lines[end + 1..].join("\n"))
}

fn unquote(v: &str) -> String {
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            let inner = &v[1..v.len() - 1];
            return if q == '"' { inner.replace("\\\"", "\"") } else { inner.replace("''", "'") };
        }
    }
    v.to_string()
}

/// The text sent to the model when a component is invoked from the "/" menu or `skills__load`.
pub fn render(c: &Component, args: &str) -> Result<String> {
    let text = std::fs::read_to_string(&c.path)?;
    let (_, body) = frontmatter(&text);
    if c.kind == "command" {
        return Ok(substitute_args(body.trim(), args));
    }
    let dir = c.path.parent().unwrap_or(Path::new(""));
    let mut s = format!("Base directory for this {}: {}\n\n{}", c.kind, dir.display(), body.trim());
    if !args.trim().is_empty() {
        s.push_str(&format!("\n\nARGUMENTS: {}", args.trim()));
    }
    Ok(s)
}

pub fn substitute_args(body: &str, args: &str) -> String {
    let words: Vec<&str> = args.split_whitespace().collect();
    let has_placeholder = body.contains("$ARGUMENTS") || (1..=9).any(|i| body.contains(&format!("${i}")));
    let mut s = body.replace("$ARGUMENTS", args.trim());
    for i in 1..=9 {
        s = s.replace(&format!("${i}"), words.get(i - 1).copied().unwrap_or(""));
    }
    if !has_placeholder && !args.trim().is_empty() {
        s.push_str(&format!("\n\nARGUMENTS: {}", args.trim()));
    }
    s
}

// ---------- chat tools

pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({"type": "function", "function": {
            "name": "skills__search",
            "description": "Search the user's installed skills, slash commands and agents (from Claude plugins and skill folders). Returns names and descriptions; load the best match with skills__load.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "What the task is about, in a few words"}}, "required": ["query"]}}}),
        json!({"type": "function", "function": {
            "name": "skills__load",
            "description": "Load an installed skill, command or agent by name and return its instructions. Follow them for the current task.",
            "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "arguments": {"type": "string", "description": "Optional arguments for a command"}}, "required": ["name"]}}}),
    ]
}

pub fn search(index: &[Component], query: &str, limit: usize) -> Vec<Component> {
    let words: Vec<String> = query.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 1).map(str::to_string).collect();
    let mut scored: Vec<(usize, &Component)> = index
        .iter()
        .map(|c| {
            let (n, d) = (c.name.to_lowercase(), c.description.to_lowercase());
            (words.iter().map(|w| 3 * usize::from(n.contains(w.as_str())) + usize::from(d.contains(w.as_str()))).sum(), c)
        })
        .filter(|(s, _)| *s > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.name.cmp(&b.1.name)));
    scored.into_iter().take(limit).map(|(_, c)| c.clone()).collect()
}

pub fn execute(plugins: &Plugins, name: &str, args: &Value) -> Result<String> {
    match name {
        "skills__search" => {
            let hits = search(&plugins.index(), args["query"].as_str().unwrap_or_default(), 10);
            if hits.is_empty() {
                return Ok("No matching skills.".into());
            }
            Ok(hits.iter().map(|c| format!("- {} ({}): {}", c.name, c.kind, c.description.chars().take(240).collect::<String>())).collect::<Vec<_>>().join("\n"))
        }
        "skills__load" => {
            let n = args["name"].as_str().unwrap_or_default();
            let c = plugins.find(n).ok_or_else(|| anyhow!("No skill named `{n}`. Use skills__search to find one."))?;
            render(&c, args["arguments"].as_str().unwrap_or_default())
        }
        _ => bail!("unknown tool {name}"),
    }
}

// ---------- hooks

#[derive(Clone, Debug)]
pub struct HookCmd {
    pub plugin: String,
    pub root: PathBuf,
    pub command: String,
    pub timeout: u64,
}

#[derive(Default, Debug, PartialEq)]
pub struct HookOutput {
    pub context: Option<String>,
    pub block: Option<String>,
}

/// Hook configs: hooks/hooks.json plus whatever plugin.json `hooks` names or inlines.
fn hook_configs(root: &Path) -> Vec<Value> {
    let m = plugin_manifest(root);
    let mut files = vec!["hooks/hooks.json".to_string()];
    let mut inline = vec![];
    match &m["hooks"] {
        Value::String(s) => files.push(s.clone()),
        Value::Array(a) => files.extend(a.iter().filter_map(|v| v.as_str().map(str::to_string))),
        v @ Value::Object(_) => inline.push(v.clone()),
        _ => {}
    }
    let mut seen = std::collections::HashSet::new();
    files
        .iter()
        .map(|f| f.trim_start_matches("./").replace('\\', "/"))
        .filter(|f| !f.split('/').any(|c| c == "..") && seen.insert(f.clone()))
        .filter_map(|f| read_json(&root.join(f)))
        .chain(inline)
        .collect()
}

pub fn hooks_for(p: &Plugin, event: &str, source: &str) -> Vec<HookCmd> {
    let mut out = vec![];
    for cfg in hook_configs(&p.root) {
        let events = if cfg.get("hooks").is_some_and(Value::is_object) { &cfg["hooks"] } else { &cfg };
        for group in events[event].as_array().into_iter().flatten() {
            let m = group["matcher"].as_str().unwrap_or("").trim();
            if !(m.is_empty() || m == "*" || source.is_empty() || m.split('|').any(|x| x.trim() == source)) {
                continue;
            }
            for h in group["hooks"].as_array().into_iter().flatten() {
                if h["type"].as_str().unwrap_or("command") != "command" {
                    continue;
                }
                if let Some(cmd) = h["command"].as_str() {
                    out.push(HookCmd { plugin: p.name.clone(), root: p.root.clone(), command: cmd.to_string(), timeout: h["timeout"].as_u64().unwrap_or(60) });
                }
            }
        }
    }
    out
}

/// Git Bash, the shell Claude Code runs hooks with on Windows (never WSL's bash.exe).
fn hook_shell() -> Option<PathBuf> {
    static SHELL: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    SHELL
        .get_or_init(|| {
            if !cfg!(windows) {
                return Some(PathBuf::from("bash"));
            }
            if let Some(p) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").map(PathBuf::from).filter(|p| p.is_file()) {
                return Some(p);
            }
            let from_git = std::env::var_os("PATH").and_then(|path| {
                std::env::split_paths(&path).find_map(|d| {
                    let git = d.join("git.exe");
                    git.is_file().then(|| d.parent().map(|g| g.join("bin").join("bash.exe"))).flatten().filter(|b| b.is_file())
                })
            });
            from_git.or_else(|| {
                ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"].iter().find_map(|v| {
                    let base = PathBuf::from(std::env::var_os(v)?);
                    [base.join("Git").join("bin").join("bash.exe"), base.join("Programs").join("Git").join("bin").join("bash.exe")].into_iter().find(|p| p.is_file())
                })
            })
        })
        .clone()
}

pub async fn run_hook(h: &HookCmd, input: &Value, cwd: &Path, config_dir: &Path) -> Result<HookOutput> {
    use tokio::io::AsyncWriteExt;
    let root = h.root.to_string_lossy().replace('\\', "/");
    let mut c = match hook_shell() {
        Some(sh) => {
            let mut c = tokio::process::Command::new(sh);
            c.arg("-c").arg(&h.command);
            c
        }
        None => {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(h.command.replace("${CLAUDE_PLUGIN_ROOT}", &root));
            c
        }
    };
    c.current_dir(cwd)
        .env("CLAUDE_PLUGIN_ROOT", &root)
        .env("CLAUDE_PROJECT_DIR", cwd)
        .env("CLAUDE_CONFIG_DIR", config_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = c.spawn().context("start hook")?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.to_string().as_bytes()).await;
    }
    let secs = h.timeout.clamp(1, HOOK_CAP_SECS);
    let out = tokio::time::timeout(Duration::from_secs(secs), child.wait_with_output()).await.map_err(|_| anyhow!("timed out after {secs}s"))??;
    Ok(parse_hook_output(out.status.code(), &String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr)))
}

/// Claude Code hook semantics: exit 2 blocks (stderr is the reason); exit 0 stdout is context,
/// or JSON with `hookSpecificOutput.additionalContext` / `decision: "block"` / `continue: false`.
pub fn parse_hook_output(code: Option<i32>, stdout: &str, stderr: &str) -> HookOutput {
    let blocked = |r: &str| Some(if r.trim().is_empty() { "Blocked by a plugin hook.".to_string() } else { r.trim().to_string() });
    if code == Some(2) {
        return HookOutput { context: None, block: blocked(stderr) };
    }
    let s = stdout.trim();
    if code != Some(0) || s.is_empty() {
        return HookOutput::default();
    }
    match serde_json::from_str::<Value>(s) {
        Ok(v) if v.is_object() => HookOutput {
            context: v["hookSpecificOutput"]["additionalContext"].as_str().or(v["additionalContext"].as_str()).map(str::to_string).filter(|c| !c.trim().is_empty()),
            block: if v["decision"] == "block" {
                blocked(v["reason"].as_str().unwrap_or(""))
            } else if v["continue"] == false {
                blocked(v["stopReason"].as_str().unwrap_or(""))
            } else {
                None
            },
        },
        _ => HookOutput { context: Some(s.to_string()), block: None },
    }
}

// ---------- MCP servers

/// The plugin's MCP servers as connectors named `<plugin>-<server>`. Remote servers and any
/// needing settings (`${VAR}`) start disabled; the user turns them on in Connectors.
pub fn mcp_servers(p: &Plugin) -> BTreeMap<String, ServerConfig> {
    let mut out = BTreeMap::new();
    if p.user_scope {
        return out;
    }
    let m = plugin_manifest(&p.root);
    let raw = match &m["mcpServers"] {
        v @ Value::Object(_) => Some(v.clone()),
        Value::String(s) => read_json(&p.root.join(s.trim_start_matches("./"))),
        _ => read_json(&p.root.join(".mcp.json")),
    };
    let Some(raw) = raw else { return out };
    let map = raw.get("mcpServers").filter(|v| v.is_object()).cloned().unwrap_or(raw);
    let root = p.root.to_string_lossy().replace('\\', "/");
    for (k, v) in map.as_object().into_iter().flatten() {
        let text = v.to_string().replace("${CLAUDE_PLUGIN_ROOT}", &root);
        let Ok(mut cfg) = serde_json::from_str::<ServerConfig>(&text) else { continue };
        cfg.disabled = cfg.url.is_some() || text.contains("${");
        let name = if k == &p.name { k.clone() } else { format!("{}-{k}", p.name) };
        out.insert(name, cfg);
    }
    out
}

/// `${VAR}` / `${VAR:-default}` from the environment, as Claude Code does for .mcp.json.
pub fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('}') else {
            out.push_str(&rest[i..]);
            return out;
        };
        let expr = &rest[i + 2..i + j];
        let (var, default) = expr.split_once(":-").map_or((expr, None), |(a, b)| (a, Some(b)));
        match std::env::var(var).ok().filter(|v| !v.is_empty()).or(default.map(str::to_string)) {
            Some(v) => out.push_str(&v),
            None => out.push_str(&rest[i..i + j + 1]),
        }
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);
    out
}

pub fn expand_config(cfg: &ServerConfig) -> ServerConfig {
    let mut c = cfg.clone();
    c.command = c.command.map(|s| expand_env(&s));
    c.args = c.args.iter().map(|s| expand_env(s)).collect();
    c.env = c.env.iter().map(|(k, v)| (k.clone(), expand_env(v))).collect();
    c.url = c.url.map(|s| expand_env(&s));
    c.headers = c.headers.iter().map(|(k, v)| (k.clone(), expand_env(v))).collect();
    c
}

// ---------- git

pub async fn git(dir: Option<&Path>, args: &[&str]) -> Result<String> {
    let mut c = tokio::process::Command::new("git");
    if let Some(d) = dir {
        c.current_dir(d);
    }
    c.args(args).env("GIT_TERMINAL_PROMPT", "0").stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(Duration::from_secs(300), c.output())
        .await
        .map_err(|_| anyhow!("git {} timed out", args.first().unwrap_or(&"")))?
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { anyhow!("Git is required to install plugins from GitHub (https://git-scm.com)") } else { e.into() })?;
    if !out.status.success() {
        bail!("git {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Shallow clone; a plugin inside a larger repo gets a sparse checkout of just its folder.
async fn clone(url: &str, git_ref: Option<&str>, subdir: Option<&str>, dest: &Path) -> Result<()> {
    let d = dest.to_string_lossy().to_string();
    let mut args = vec!["clone", "--depth", "1", "--quiet"];
    if let Some(r) = git_ref {
        args.extend(["--branch", r]);
    }
    if subdir.is_some() {
        args.extend(["--filter=blob:none", "--sparse"]);
    }
    args.extend([url, d.as_str()]);
    git(None, &args).await?;
    if let Some(s) = subdir {
        git(Some(dest), &["sparse-checkout", "set", "--no-cone", &format!("/{s}/")]).await?;
    }
    Ok(())
}

// ---------- GitHub marketplaces

#[derive(Serialize, Clone, Debug)]
pub struct OfferItem {
    pub name: String,
    pub description: String,
    pub source: Option<Source>,
    /// Why it cannot be installed (unsupported source).
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Offer {
    pub repo: String,
    pub marketplace: Option<String>,
    pub items: Vec<OfferItem>,
}

/// `owner/repo`, a GitHub URL, or any git URL -> (clone URL, `owner/repo` when on GitHub).
pub fn parse_spec(spec: &str) -> Result<(String, Option<String>)> {
    let s = spec.trim().trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s);
    let gh_rest = ["https://github.com/", "http://github.com/", "github.com/"].iter().find_map(|p| s.strip_prefix(p));
    let valid = |x: &str| !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && x != "." && x != "..";
    let gh = match gh_rest {
        Some(rest) => {
            let parts: Vec<&str> = rest.split('/').collect();
            (parts.len() >= 2 && valid(parts[0]) && valid(parts[1])).then(|| format!("{}/{}", parts[0], parts[1]))
        }
        None => s.split_once('/').filter(|(o, r)| !s.contains("://") && !s.contains(':') && valid(o) && valid(r)).map(|_| s.to_string()),
    };
    if let Some(gh) = gh {
        return Ok((format!("https://github.com/{gh}.git"), Some(gh)));
    }
    if s.starts_with("https://") || s.starts_with("git@") || s.starts_with("ssh://") {
        return Ok((spec.trim().to_string(), None));
    }
    bail!("Enter a GitHub repository as owner/repo, or a git URL")
}

fn norm_subdir(s: &str) -> Result<Option<String>> {
    let t = s.trim().replace('\\', "/");
    let t = t.trim_start_matches("./").trim_matches('/');
    if t.split('/').any(|c| c == "..") {
        bail!("invalid plugin path {s}");
    }
    Ok((!t.is_empty() && t != ".").then(|| t.to_string()))
}

/// A marketplace entry's `source` -> how to fetch it.
pub fn entry_source(src: &Value, repo_url: &str, marketplace: &str) -> Result<Source> {
    let git = |url: String, git_ref: Option<&str>, subdir: Option<String>| Source::Git { url, git_ref: git_ref.map(str::to_string), subdir, marketplace: Some(marketplace.to_string()) };
    match src {
        Value::String(s) if !s.contains("://") => Ok(git(repo_url.to_string(), None, norm_subdir(s)?)),
        Value::Object(o) => {
            let r = o.get("ref").and_then(Value::as_str);
            match o.get("source").and_then(Value::as_str) {
                Some("github") => {
                    let repo = o.get("repo").and_then(Value::as_str).ok_or_else(|| anyhow!("github source without repo"))?;
                    let (url, _) = parse_spec(repo)?;
                    Ok(git(url, r, None))
                }
                Some("url") => Ok(git(o.get("url").and_then(Value::as_str).ok_or_else(|| anyhow!("url source without url"))?.to_string(), r, None)),
                Some("git-subdir") => Ok(git(
                    o.get("url").and_then(Value::as_str).ok_or_else(|| anyhow!("git-subdir source without url"))?.to_string(),
                    r,
                    norm_subdir(o.get("path").and_then(Value::as_str).unwrap_or(""))?,
                )),
                Some(other) => bail!("{other} sources are not supported yet"),
                None => bail!("source has no type"),
            }
        }
        _ => bail!("unsupported source"),
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().user_agent("OpenClaude-Desktop").timeout(Duration::from_secs(20)).build().unwrap_or_default()
}

async fn raw_github(repo: &str, path: &str) -> Result<Option<Value>> {
    let r = http().get(format!("https://raw.githubusercontent.com/{repo}/HEAD/{path}")).send().await?;
    if r.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !r.status().is_success() {
        bail!("GitHub returned {} for {repo}", r.status());
    }
    Ok(Some(r.json().await?))
}

pub async fn inspect(spec: &str) -> Result<Offer> {
    let (url, gh) = parse_spec(spec)?;
    if let Some(gh) = &gh {
        if let Some(m) = raw_github(gh, ".claude-plugin/marketplace.json").await? {
            let mk = m["name"].as_str().unwrap_or(gh).to_string();
            let items = m["plugins"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| {
                    let src = entry_source(&p["source"], &url, &mk);
                    OfferItem {
                        name: p["name"].as_str().unwrap_or("plugin").to_string(),
                        description: p["description"].as_str().unwrap_or_default().to_string(),
                        note: src.as_ref().err().map(|e| e.to_string()),
                        source: src.ok(),
                    }
                })
                .collect();
            return Ok(Offer { repo: gh.clone(), marketplace: Some(mk), items });
        }
    }
    let manifest = match &gh {
        Some(g) => raw_github(g, ".claude-plugin/plugin.json").await.ok().flatten(),
        None => None,
    }
    .unwrap_or(Value::Null);
    let name = manifest["name"].as_str().map(str::to_string).unwrap_or_else(|| url.trim_end_matches(".git").rsplit('/').next().unwrap_or("plugin").to_string());
    Ok(Offer {
        repo: gh.unwrap_or_else(|| url.clone()),
        marketplace: None,
        items: vec![OfferItem {
            name,
            description: manifest["description"].as_str().unwrap_or_default().to_string(),
            source: Some(Source::Git { url, git_ref: None, subdir: None, marketplace: None }),
            note: None,
        }],
    })
}

// ---------- import from Claude

#[derive(Serialize, Clone, Debug)]
pub struct Candidate {
    pub key: String,
    pub name: String,
    pub origin: String,
    pub local: PathBuf,
    /// Where it updates from on GitHub, when known.
    pub github: Option<Source>,
    pub user_scope: bool,
    pub imported: bool,
}

/// Finds a plugin by name in a GitHub marketplace, or a repo that is itself that plugin.
async fn resolve_named(repo: &str, name: &str, cache: &mut HashMap<String, Option<Value>>) -> Option<Source> {
    if !cache.contains_key(repo) {
        cache.insert(repo.to_string(), raw_github(repo, ".claude-plugin/marketplace.json").await.ok().flatten());
    }
    let (url, _) = parse_spec(repo).ok()?;
    match cache.get(repo)? {
        Some(m) => {
            let mk = m["name"].as_str().unwrap_or(repo);
            let e = m["plugins"].as_array()?.iter().find(|p| p["name"] == name)?;
            entry_source(&e["source"], &url, mk).ok()
        }
        None => {
            let pj = raw_github(repo, ".claude-plugin/plugin.json").await.ok().flatten()?;
            (pj["name"] == name).then_some(Source::Git { url, git_ref: None, subdir: None, marketplace: None })
        }
    }
}

fn github_repo_of(url: &str) -> Option<String> {
    parse_spec(url).ok()?.1
}

pub async fn import_candidates(installed: &Registry) -> Vec<Candidate> {
    let mut out = vec![];
    let mut cache = HashMap::new();
    let imported = |name: &str, local: &Path| installed.plugins.iter().any(|p| p.name == name || p.root == local);
    let Some(home) = dirs::home_dir() else { return out };

    // Claude Code (CLI) plugins
    let cc = home.join(".claude").join("plugins");
    let known = read_json(&cc.join("known_marketplaces.json")).unwrap_or(Value::Null);
    if let Some(ip) = read_json(&cc.join("installed_plugins.json")) {
        for (key, v) in ip["plugins"].as_object().into_iter().flatten() {
            let (name, mkt) = key.split_once('@').unwrap_or((key, ""));
            let Some(local) = v[0]["installPath"].as_str().map(PathBuf::from) else { continue };
            let src = &known[mkt]["source"];
            let github = match (src["source"].as_str(), src["repo"].as_str()) {
                (Some("github"), Some(repo)) => resolve_named(repo, name, &mut cache).await,
                _ => None,
            };
            out.push(Candidate { key: format!("cc:{key}"), name: name.to_string(), origin: "Claude Code".into(), imported: imported(name, &local), local, github, user_scope: false });
        }
    }

    // Claude Desktop plugins
    if let Some(appdata) = dirs::config_dir() {
        for a in read_dir_sorted(&appdata.join("Claude").join("rpm")) {
            for b in read_dir_sorted(&a) {
                let Some(m) = read_json(&b.join("manifest.json")) else { continue };
                for p in m["plugins"].as_array().into_iter().flatten() {
                    let Some(id) = p["id"].as_str() else { continue };
                    let local = b.join(id);
                    let pj = plugin_manifest(&local);
                    let Some(name) = pj["name"].as_str().map(str::to_string) else { continue };
                    let repos: &[&str] = match p["marketplaceName"].as_str() {
                        Some("knowledge-work-plugins") => &[KNOWLEDGE_WORK],
                        Some("anthropic-plugin-directory") => &[OFFICIAL, KNOWLEDGE_WORK],
                        _ => &[],
                    };
                    let mut github = None;
                    for r in repos {
                        github = resolve_named(r, &name, &mut cache).await;
                        if github.is_some() {
                            break;
                        }
                    }
                    if github.is_none() {
                        if let Some(repo) = pj["repository"].as_str().or(pj["homepage"].as_str()).and_then(github_repo_of) {
                            github = resolve_named(&repo, &name, &mut cache).await;
                        }
                    }
                    out.push(Candidate { key: format!("cd:{id}"), imported: imported(&name, &local), name, origin: "Claude Desktop".into(), local, github, user_scope: false });
                }
            }
        }
    }

    // User folders: skills, commands and agents written by hand or by other tools
    for (dir, label) in [(home.join(".claude"), "Claude Code (your skills, commands, agents)"), (home.join(".openclaude"), "OpenClaude CLI (your skills, commands, agents)")] {
        if ["skills", "commands", "agents"].iter().any(|s| dir.join(s).is_dir()) {
            let name = format!("user-{}", file_name(&dir).trim_start_matches('.'));
            out.push(Candidate { key: format!("user:{name}"), imported: imported(&name, &dir), name, origin: label.into(), local: dir, github: None, user_scope: true });
        }
    }
    out
}

/// Imports one candidate: from GitHub when its source is known (so it auto-updates), else read in place.
pub async fn import(plugins: &Plugins, c: &Candidate) -> Result<Plugin> {
    if c.user_scope {
        return plugins.add_local(&c.local, &c.origin, true, Some(&c.name));
    }
    if let Some(src) = &c.github {
        match plugins.install(&c.name, src.clone()).await {
            Ok(p) => return Ok(p),
            Err(e) => eprintln!("GitHub install of {} failed, reading it in place: {e}", c.name),
        }
    }
    plugins.add_local(&c.local, &c.origin, false, Some(&c.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn frontmatter_handles_blocks_and_quotes() {
        let (fm, body) = frontmatter("---\nname: ponytail\ndescription: >\n  Lazy senior dev mode:\n  the smallest change.\nargument-hint: \"[lite|full]\"\nnotes: |\n  a\n  b\n---\n# Body\ntext");
        assert_eq!(fm["name"], "ponytail");
        assert_eq!(fm["description"], "Lazy senior dev mode: the smallest change.");
        assert_eq!(fm["argument-hint"], "[lite|full]");
        assert_eq!(fm["notes"], "a\nb");
        assert_eq!(body, "# Body\ntext");
        let (none, all) = frontmatter("no front matter");
        assert!(none.is_empty() && all == "no front matter");
    }

    #[test]
    fn arguments_are_substituted_like_claude_code() {
        assert_eq!(substitute_args("Review $ARGUMENTS now", "pr 12"), "Review pr 12 now");
        assert_eq!(substitute_args("From $1 to $2", "a b"), "From a to b");
        assert_eq!(substitute_args("No placeholder", "x y"), "No placeholder\n\nARGUMENTS: x y");
        assert_eq!(substitute_args("No placeholder", ""), "No placeholder");
    }

    #[test]
    fn specs_and_marketplace_sources_parse() {
        assert_eq!(parse_spec("DietrichGebert/ponytail").unwrap(), ("https://github.com/DietrichGebert/ponytail.git".into(), Some("DietrichGebert/ponytail".into())));
        assert_eq!(parse_spec("https://github.com/obra/superpowers.git").unwrap().1.as_deref(), Some("obra/superpowers"));
        assert_eq!(parse_spec("https://github.com/a/b/tree/main/x").unwrap().1.as_deref(), Some("a/b"));
        assert!(parse_spec("C:\\evil").is_err() && parse_spec("../x").is_err());
        let url = "https://github.com/anthropics/knowledge-work-plugins.git";
        assert_eq!(
            entry_source(&json!("./partner-built/brand-voice"), url, "kw").unwrap(),
            Source::Git { url: url.into(), git_ref: None, subdir: Some("partner-built/brand-voice".into()), marketplace: Some("kw".into()) }
        );
        assert_eq!(entry_source(&json!("./"), url, "kw").unwrap(), Source::Git { url: url.into(), git_ref: None, subdir: None, marketplace: Some("kw".into()) });
        let sub = entry_source(&json!({"source": "git-subdir", "url": "https://x/y.git", "path": "plugins/claude", "ref": "main"}), url, "o").unwrap();
        assert_eq!(sub, Source::Git { url: "https://x/y.git".into(), git_ref: Some("main".into()), subdir: Some("plugins/claude".into()), marketplace: Some("o".into()) });
        assert!(entry_source(&json!("../../etc"), url, "kw").is_err());
        assert!(entry_source(&json!({"source": "npm", "package": "x"}), url, "kw").is_err());
    }

    #[test]
    fn hook_output_follows_claude_code_semantics() {
        assert_eq!(parse_hook_output(Some(0), "plain context\n", ""), HookOutput { context: Some("plain context".into()), block: None });
        let j = r#"{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"RULES"}}"#;
        assert_eq!(parse_hook_output(Some(0), j, "").context.as_deref(), Some("RULES"));
        assert_eq!(parse_hook_output(Some(2), "", "no secrets").block.as_deref(), Some("no secrets"));
        assert_eq!(parse_hook_output(Some(0), r#"{"decision":"block","reason":"nope"}"#, "").block.as_deref(), Some("nope"));
        assert_eq!(parse_hook_output(Some(1), "ignored", "err"), HookOutput::default());
        assert_eq!(parse_hook_output(Some(0), r#"{"suppressOutput":true}"#, ""), HookOutput::default());
    }

    #[test]
    fn env_expansion() {
        unsafe { std::env::set_var("OC_TEST_TOKEN", "abc") };
        assert_eq!(expand_env("Bearer ${OC_TEST_TOKEN}"), "Bearer abc");
        assert_eq!(expand_env("${OC_MISSING_VAR:-dflt}/x"), "dflt/x");
        assert_eq!(expand_env("${OC_MISSING_VAR}"), "${OC_MISSING_VAR}");
        assert_eq!(expand_env("plain ${unclosed"), "plain ${unclosed");
    }

    fn sample_plugin(dir: &Path) -> Plugin {
        let root = dir.join("ponytail");
        write(&root.join(".claude-plugin/plugin.json"), r#"{"name":"ponytail","version":"5.3.2","description":"Lazy senior dev","hooks":["./hooks/h.json"]}"#);
        write(&root.join("skills/ponytail/SKILL.md"), "---\nname: ponytail\ndescription: Lazy senior dev mode for coding tasks\n---\nBe lazy.");
        write(&root.join("skills/ponytail-review/SKILL.md"), "---\nname: ponytail-review\ndescription: Review a diff for bloat\n---\nReview.");
        write(&root.join("commands/ship.md"), "---\ndescription: Ship it\nargument-hint: <branch>\n---\nShip $ARGUMENTS");
        write(&root.join("commands/git/sync.md"), "Sync");
        write(&root.join("agents/reviewer.md"), "---\nname: reviewer\ndescription: Code reviewer\n---\nYou review.");
        write(&root.join(".mcp.json"), r#"{"mcpServers":{"local":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"]},"remote":{"type":"http","url":"https://mcp.example.com"}}}"#);
        write(
            &root.join("hooks/h.json"),
            r#"{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"echo RULES-$CLAUDE_PLUGIN_ROOT","timeout":5}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"cat >/dev/null; echo prompt-ctx"}]}],"Stop":[{"hooks":[{"type":"command","command":"echo no"}]}]}}"#,
        );
        local_plugin(&root, "test", false, None)
    }

    #[test]
    fn discovers_components_mcp_and_hooks() {
        let t = tempfile::tempdir().unwrap();
        let p = sample_plugin(t.path());
        assert_eq!((p.name.as_str(), p.version.as_deref()), ("ponytail", Some("5.3.2")));
        let names: Vec<String> = components(&p).into_iter().map(|c| format!("{}:{}", c.kind, c.name)).collect();
        assert_eq!(names, ["skill:ponytail:ponytail", "skill:ponytail:ponytail-review", "command:ponytail:git:sync", "command:ponytail:ship", "agent:ponytail:reviewer"]);
        let cmd = components(&p).into_iter().find(|c| c.name == "ponytail:ship").unwrap();
        assert_eq!(cmd.arg_hint.as_deref(), Some("<branch>"));
        assert_eq!(render(&cmd, "main").unwrap(), "Ship main");
        let skill = components(&p).into_iter().next().unwrap();
        assert!(render(&skill, "").unwrap().ends_with("Be lazy."));

        let mcp = mcp_servers(&p);
        let local = &mcp["ponytail-local"];
        assert!(!local.disabled && local.args[0].ends_with("/ponytail/server.js") && !local.args[0].contains('\\'));
        assert!(mcp["ponytail-remote"].disabled);

        assert_eq!(hooks_for(&p, "SessionStart", "startup").len(), 1);
        assert_eq!(hooks_for(&p, "SessionStart", "compact").len(), 0);
        assert_eq!(hooks_for(&p, "UserPromptSubmit", "").len(), 1);
        let mut user = local_plugin(&t.path().join("ponytail"), "u", true, Some("user-claude"));
        user.name = "user-claude".into();
        assert!(components(&user).iter().any(|c| c.name == "ponytail"), "user folders use bare names");
        assert!(mcp_servers(&user).is_empty());
    }

    #[test]
    fn search_ranks_name_hits_first() {
        let t = tempfile::tempdir().unwrap();
        let idx = components(&sample_plugin(t.path()));
        let hits = search(&idx, "review the diff", 5);
        assert_eq!(hits[0].name, "ponytail:ponytail-review");
        assert!(search(&idx, "zzz", 5).is_empty());
    }

    #[tokio::test]
    async fn hooks_run_and_feed_chat_context() {
        if hook_shell().is_none() {
            return;
        }
        let t = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(t.path().join("plugins"));
        let p = sample_plugin(t.path());
        let mut reg = Registry::default();
        reg.plugins.push(p);
        plugins.save(&reg).unwrap();
        let ctx = plugins.session_context("c1", true).await;
        assert!(ctx.contains("<plugin-context plugin=\"ponytail\">") && ctx.contains("RULES-") && ctx.contains("/ponytail"), "{ctx}");
        assert!(plugins.prompt_context("c1", "hi").await.unwrap().contains("prompt-ctx"));
        // isolated config dir, never ~/.claude
        assert!(plugins.config_dir().join("settings.json").is_file());
        // hooks off: no context
        plugins.update_entry("ponytail", |e| e.hooks = false).unwrap();
        assert_eq!(plugins.session_context("c2", true).await, "");
        // index and find
        assert_eq!(plugins.find("ponytail-review").map(|c| c.name), Some("ponytail:ponytail-review".to_string()));
        assert!(execute(&plugins, "skills__load", &json!({"name": "ponytail:ship", "arguments": "dev"})).unwrap().contains("Ship dev"));
    }

    /// Install from a local git repo (marketplace layout with a subdir), update, roll back.
    #[tokio::test]
    async fn git_install_update_and_rollback() {
        if git(None, &["--version"]).await.is_err() {
            return;
        }
        let t = tempfile::tempdir().unwrap();
        let upstream = t.path().join("upstream");
        write(&upstream.join("plugins/demo/.claude-plugin/plugin.json"), r#"{"name":"demo","version":"1.0.0"}"#);
        write(&upstream.join("plugins/demo/skills/a/SKILL.md"), "---\nname: a\ndescription: first\n---\nA");
        write(&upstream.join("other/readme.txt"), "x");
        let g = |args: &'static [&'static str]| {
            let up = upstream.clone();
            async move { git(Some(&up), args).await.unwrap() }
        };
        g(&["init", "-q", "-b", "main"]).await;
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]).await;
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one"]).await;
        let url = format!("file://{}", upstream.to_string_lossy().replace('\\', "/"));

        let plugins = Plugins::new(t.path().join("data"));
        let src = Source::Git { url, git_ref: None, subdir: Some("plugins/demo".into()), marketplace: Some("mk".into()) };
        let p = plugins.install("demo", src).await.unwrap();
        assert_eq!((p.id.as_str(), p.version.as_deref(), p.auto_update), ("demo@mk", Some("1.0.0"), true));
        assert!(p.root.join("skills/a/SKILL.md").is_file());
        assert!(!p.repo_dir.as_ref().unwrap().join("other").exists(), "sparse checkout keeps only the plugin folder");
        assert_eq!(plugins.update("demo@mk", false).await.unwrap(), None, "up to date");

        // a commit elsewhere in the repo moves HEAD but does not count as a change
        write(&upstream.join("other/readme.txt"), "y");
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "other"]).await;
        assert_eq!(plugins.update("demo@mk", true).await.unwrap(), Some(false));

        // a change to the plugin is an update
        write(&upstream.join("plugins/demo/.claude-plugin/plugin.json"), r#"{"name":"demo","version":"1.1.0"}"#);
        write(&upstream.join("plugins/demo/skills/a/SKILL.md"), "---\nname: a\ndescription: second\n---\nA2");
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "two"]).await;
        assert_eq!(plugins.update_all().await, vec!["demo".to_string()]);
        let p = plugins.registry().plugins.into_iter().next().unwrap();
        assert_eq!(p.version.as_deref(), Some("1.1.0"));
        assert!(std::fs::read_to_string(p.root.join("skills/a/SKILL.md")).unwrap().contains("A2"));

        let r = plugins.rollback("demo@mk").await.unwrap();
        assert!(!r.auto_update, "rollback pins the plugin");
        assert!(!std::fs::read_to_string(r.root.join("skills/a/SKILL.md")).unwrap().contains("A2"));

        let removed = plugins.remove("demo@mk").unwrap();
        assert!(!removed.repo_dir.unwrap().exists());
        assert!(plugins.remove_tree(t.path()).is_err(), "never deletes outside the repos folder");
    }
}
