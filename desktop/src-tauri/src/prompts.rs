//! Prompt library: reusable prompts the user browses, searches and inserts into the composer.
//! A collection is a Claude plugin (its `commands/`), a plain folder of markdown prompts (front
//! matter `title` / `description` / `tags` optional), or "My prompts", written in the app.
//! GitHub collections reuse the plugin installer with a registry of their own under
//! `<data>/prompts`: sparse shallow clones, checked every 15 minutes, rollback pins.

use crate::plugins::{self, Offer, OfferItem, Plugin, Plugins, Source};
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Registry id of the user's own collection.
pub const MINE: &str = "mine";
/// Repository files that document a collection rather than hold a prompt.
const NOT_PROMPTS: &[&str] = &["readme", "changelog", "contributing", "license", "code_of_conduct", "security", "claude", "agents"];

#[derive(Serialize, Clone, Debug)]
pub struct Prompt {
    /// Stable key (favorites): `<collection id>/<name in the collection>`.
    pub id: String,
    /// `/` menu name: `<collection>:<name>`, bare for My prompts.
    pub name: String,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub arg_hint: Option<String>,
    pub body: String,
    pub collection: String,
    pub collection_name: String,
    pub path: PathBuf,
    pub favorite: bool,
    /// In My prompts: edited and deleted in the app.
    pub editable: bool,
}

#[derive(Deserialize, Debug)]
pub struct Draft {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub body: String,
}

pub fn mine_dir(lib: &Plugins) -> PathBuf {
    lib.dir.join("mine")
}

fn favorites_path(lib: &Plugins) -> PathBuf {
    lib.dir.join("favorites.json")
}

/// Registers My prompts on first use.
pub fn ensure_mine(lib: &Plugins) -> Result<()> {
    let mut reg = lib.registry();
    if reg.plugins.iter().any(|p| p.id == MINE) {
        return Ok(());
    }
    let dir = mine_dir(lib);
    std::fs::create_dir_all(&dir)?;
    let mut p = plugins::local_plugin(&dir, "My prompts", true, Some(MINE));
    p.name = "My prompts".into();
    p.description = "Prompts you write in the app.".into();
    reg.plugins.insert(0, p);
    lib.save(&reg)
}

/// Prompts of one collection: `commands/**/*.md` when it has that folder, else every `*.md`
/// outside hidden folders, minus repository docs (README, LICENSE, ...).
pub fn collection_prompts(c: &Plugin) -> Vec<Prompt> {
    let mut files = vec![];
    let cmds = c.root.join("commands");
    if cmds.is_dir() {
        plugins::md_files(&cmds, "", &mut files);
    } else {
        plugins::md_files(&c.root, "", &mut files);
        files.retain(|(rel, _)| !NOT_PROMPTS.contains(&rel.rsplit(':').next().unwrap_or(rel).to_ascii_lowercase().as_str()));
    }
    files.into_iter().filter_map(|(rel, f)| Some(parse(c, &rel, &f, &std::fs::read_to_string(&f).ok()?))).collect()
}

fn parse(c: &Plugin, rel: &str, path: &Path, text: &str) -> Prompt {
    let (fm, body) = plugins::frontmatter(text);
    let mut body = body.trim().to_string();
    let get = |k: &str| fm.get(k).filter(|v| !v.is_empty()).cloned();
    let title = get("title").unwrap_or_else(|| match body.lines().next().and_then(|l| l.strip_prefix("# ")).map(|h| h.trim().to_string()) {
        // A leading `# Heading` names the prompt; it is not part of the text to insert.
        Some(h) => {
            body = body.lines().skip(1).collect::<Vec<_>>().join("\n").trim().to_string();
            h
        }
        None => humanize(rel.rsplit(':').next().unwrap_or(rel)),
    });
    let mut tags = get("tags").map(|t| parse_tags(&t)).unwrap_or_default();
    if let Some(cat) = get("category").filter(|c| !tags.iter().any(|t| t.eq_ignore_ascii_case(c))) {
        tags.push(cat);
    }
    Prompt {
        id: format!("{}/{rel}", c.id),
        name: if c.user_scope { rel.to_string() } else { format!("{}:{rel}", plugins::slug(&c.name)) },
        title,
        description: get("description").unwrap_or_default(),
        tags,
        arg_hint: get("argument-hint"),
        body,
        collection: c.id.clone(),
        collection_name: c.name.clone(),
        path: path.to_path_buf(),
        favorite: false,
        editable: c.id == MINE,
    }
}

fn humanize(s: &str) -> String {
    let s = s.replace(['-', '_'], " ");
    let mut cs = s.trim().chars();
    cs.next().map(|f| f.to_uppercase().chain(cs).collect()).unwrap_or_default()
}

/// `[a, "b"]`, `a, b`, or a YAML list (which the front matter reader folds into `- a - b`).
pub fn parse_tags(s: &str) -> Vec<String> {
    let s = s.trim().trim_start_matches('[').trim_end_matches(']').trim();
    let parts: Vec<&str> = match s.strip_prefix("- ") {
        Some(list) => list.split(" - ").collect(),
        None => s.split(',').collect(),
    };
    let mut out: Vec<String> = vec![];
    for t in parts {
        let t = t.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        if !t.is_empty() && !out.iter().any(|x| x.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    out
}

/// Every prompt of the enabled collections, favorites marked.
pub fn list(lib: &Plugins) -> Vec<Prompt> {
    if let Err(err) = ensure_mine(lib) {
        eprintln!("my prompts: {err}");
    }
    let favs = favorites(lib);
    lib.registry()
        .plugins
        .iter()
        .filter(|c| c.enabled)
        .flat_map(collection_prompts)
        .map(|mut p| {
            p.favorite = favs.contains(&p.id);
            p
        })
        .collect()
}

pub fn find(lib: &Plugins, name: &str) -> Option<Prompt> {
    let name = name.trim().trim_start_matches('/');
    list(lib).into_iter().find(|p| p.name == name)
}

pub fn favorites(lib: &Plugins) -> BTreeSet<String> {
    plugins::read_json(&favorites_path(lib)).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

pub fn set_favorite(lib: &Plugins, id: &str, on: bool) -> Result<()> {
    let mut f = favorites(lib);
    if on {
        f.insert(id.to_string());
    } else {
        f.remove(id);
    }
    std::fs::create_dir_all(&lib.dir)?;
    std::fs::write(favorites_path(lib), serde_json::to_string(&f)?)?;
    Ok(())
}

// ---------- My prompts

fn valid_stem(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

/// File name for a new prompt: the title in kebab case, never a Windows device name.
fn stem_for(title: &str) -> String {
    let s: String = title.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    let s: String = s.split('-').filter(|x| !x.is_empty()).collect::<Vec<_>>().join("-").chars().take(60).collect();
    let s = s.trim_end_matches('-').to_string();
    let device = ["con", "prn", "aux", "nul"].contains(&s.as_str()) || (s.len() == 4 && (s.starts_with("com") || s.starts_with("lpt")));
    if s.is_empty() { "prompt".into() } else if device { format!("{s}-prompt") } else { s }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\\\""))
}

/// Creates a prompt in My prompts (`name` None) or rewrites the one named `name`.
pub fn save_mine(lib: &Plugins, name: Option<&str>, d: &Draft) -> Result<Prompt> {
    ensure_mine(lib)?;
    let title = one_line(&d.title);
    if title.is_empty() || d.body.trim().is_empty() {
        bail!("A prompt needs a title and some text.");
    }
    let dir = mine_dir(lib);
    std::fs::create_dir_all(&dir)?;
    let stem = match name {
        Some(n) if valid_stem(n) && dir.join(format!("{n}.md")).is_file() => n.to_string(),
        Some(n) => bail!("No prompt named {n} in My prompts."),
        None => {
            let base = stem_for(&title);
            let mut s = base.clone();
            for i in 2.. {
                if !dir.join(format!("{s}.md")).exists() {
                    break;
                }
                s = format!("{base}-{i}");
            }
            s
        }
    };
    let tags: Vec<String> = d.tags.iter().map(|t| one_line(&t.replace([',', '[', ']', '"'], ""))).filter(|t| !t.is_empty()).collect();
    let text = format!("---\ntitle: {}\ndescription: {}\ntags: [{}]\n---\n{}\n", quote(&title), quote(&one_line(&d.description)), tags.join(", "), d.body.trim());
    let path = dir.join(format!("{stem}.md"));
    std::fs::write(&path, &text)?;
    let c = lib.registry().plugins.into_iter().find(|p| p.id == MINE).ok_or_else(|| anyhow!("My prompts is missing"))?;
    let mut p = parse(&c, &stem, &path, &text);
    p.favorite = favorites(lib).contains(&p.id);
    Ok(p)
}

pub fn delete_mine(lib: &Plugins, name: &str) -> Result<()> {
    let path = mine_dir(lib).join(format!("{name}.md"));
    if !valid_stem(name) || !path.is_file() {
        bail!("No prompt named {name} in My prompts.");
    }
    std::fs::remove_file(path)?;
    set_favorite(lib, &format!("{MINE}/{name}"), false)
}

// ---------- install

/// `https://github.com/<owner>/<repo>/tree/<ref>/<folder>` -> (owner/repo, ref, folder).
pub fn github_folder(spec: &str) -> Option<(String, String, String)> {
    let s = spec.trim().trim_end_matches('/');
    let rest = ["https://github.com/", "http://github.com/", "github.com/"].iter().find_map(|p| s.strip_prefix(p))?;
    let parts: Vec<&str> = rest.split('/').collect();
    (parts.len() >= 5 && parts[2] == "tree").then(|| (format!("{}/{}", parts[0], parts[1]), parts[3].to_string(), parts[4..].join("/")))
}

/// What a spec offers: a GitHub folder installs as one collection; anything else is read like a
/// plugin spec (a marketplace lists its plugins, a repository installs whole).
pub async fn inspect(spec: &str) -> Result<Offer> {
    let Some((repo, git_ref, folder)) = github_folder(spec) else {
        return plugins::inspect(spec).await;
    };
    let (url, _) = plugins::parse_spec(&repo)?;
    let subdir = plugins::norm_subdir(&folder)?;
    let repo_name = repo.rsplit('/').next().unwrap_or(&repo);
    let name = match folder.rsplit('/').next().filter(|f| !f.is_empty()) {
        Some(f) => format!("{repo_name}-{f}"),
        None => repo_name.to_string(),
    };
    Ok(Offer {
        repo: repo.clone(),
        marketplace: None,
        items: vec![OfferItem { name, description: format!("{folder} in {repo}"), source: Some(Source::Git { url, git_ref: Some(git_ref), subdir, marketplace: None }), note: None }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    fn by_name(ps: &[Prompt], n: &str) -> Prompt {
        ps.iter().find(|p| p.name == n).unwrap_or_else(|| panic!("no {n} in {:?}", ps.iter().map(|p| &p.name).collect::<Vec<_>>())).clone()
    }

    #[test]
    fn plain_folder_reads_front_matter_and_skips_docs() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("team-prompts");
        write(&root.join("review.md"), "---\ntitle: Review a pull request\ndescription: Careful review with severity\ntags:\n  - code\n  - review\ncategory: Engineering\n---\nReview PR $ARGUMENTS.\n");
        write(&root.join("notes/standup.md"), "# Daily standup\n\nSummarize {{team}}'s progress since yesterday.\n");
        write(&root.join("release_notes.md"), "Write release notes for {{version}}.");
        for doc in ["README.md", "LICENSE.md", "CONTRIBUTING.md", ".github/PULL_REQUEST_TEMPLATE.md", "notes/readme.md"] {
            write(&root.join(doc), "not a prompt");
        }
        let c = plugins::local_plugin(&root, "test", false, None);
        let ps = collection_prompts(&c);
        assert_eq!(ps.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["team-prompts:notes:standup", "team-prompts:release_notes", "team-prompts:review"]);

        let r = by_name(&ps, "team-prompts:review");
        assert_eq!((r.title.as_str(), r.description.as_str()), ("Review a pull request", "Careful review with severity"));
        assert_eq!(r.tags, ["code", "review", "Engineering"]);
        assert_eq!((r.body.as_str(), r.id.as_str(), r.editable), ("Review PR $ARGUMENTS.", "team-prompts/review", false));

        let s = by_name(&ps, "team-prompts:notes:standup");
        assert_eq!(s.title, "Daily standup", "a leading heading names the prompt");
        assert_eq!(s.body, "Summarize {{team}}'s progress since yesterday.", "and is not inserted");
        assert!(s.description.is_empty());

        assert_eq!(by_name(&ps, "team-prompts:release_notes").title, "Release notes", "file name as the last resort");
    }

    #[test]
    fn plugin_layout_reads_only_commands() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("kit");
        write(&root.join(".claude-plugin/plugin.json"), r#"{"name":"dev-kit"}"#);
        write(&root.join("commands/ship.md"), "---\ndescription: Ship a branch\nargument-hint: <branch>\n---\nShip $ARGUMENTS safely.");
        write(&root.join("commands/git/sync.md"), "Sync with main.");
        write(&root.join("docs/guide.md"), "A guide, not a prompt.");
        write(&root.join("skills/x/SKILL.md"), "---\nname: x\n---\nskill");
        let c = plugins::local_plugin(&root, "", false, None);
        let ps = collection_prompts(&c);
        assert_eq!(ps.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["dev-kit:git:sync", "dev-kit:ship"]);
        let ship = by_name(&ps, "dev-kit:ship");
        assert_eq!((ship.title.as_str(), ship.arg_hint.as_deref(), ship.collection_name.as_str()), ("Ship", Some("<branch>"), "dev-kit"));
        assert_eq!(by_name(&ps, "dev-kit:git:sync").title, "Sync");
    }

    #[test]
    fn tag_forms() {
        assert_eq!(parse_tags("[code, \"review\"]"), ["code", "review"]);
        assert_eq!(parse_tags("code, review, Code"), ["code", "review"]);
        assert_eq!(parse_tags("- code - review"), ["code", "review"]);
        assert!(parse_tags("").is_empty());
    }

    #[test]
    fn my_prompts_create_edit_delete_and_favorites() {
        let t = tempfile::tempdir().unwrap();
        let lib = Plugins::new(t.path().join("prompts"));
        assert!(list(&lib).is_empty());
        assert_eq!(lib.registry().plugins[0].id, MINE, "My prompts is registered on first use");

        let d = Draft { title: "Weekly \"status\" update".into(), description: "For the team\nchannel".into(), tags: vec!["writing".into(), " team, ops ".into(), "".into()], body: "Summarize {{project}} this week.".into() };
        let p = save_mine(&lib, None, &d).unwrap();
        assert_eq!((p.name.as_str(), p.id.as_str(), p.editable), ("weekly-status-update", "mine/weekly-status-update", true));
        assert_eq!((p.title.as_str(), p.description.as_str()), ("Weekly \"status\" update", "For the team channel"));
        assert_eq!(p.tags, ["writing", "team ops"]);
        assert_eq!(save_mine(&lib, None, &d).unwrap().name, "weekly-status-update-2", "a second prompt with the same title gets its own file");

        let edited = save_mine(&lib, Some("weekly-status-update"), &Draft { body: "New text.".into(), ..d }).unwrap();
        assert_eq!(edited.body, "New text.");
        assert_eq!(std::fs::read_dir(mine_dir(&lib)).unwrap().count(), 2, "editing rewrites the same file");

        set_favorite(&lib, "mine/weekly-status-update", true).unwrap();
        let all = list(&lib);
        assert_eq!(all.len(), 2);
        assert!(by_name(&all, "weekly-status-update").favorite && !by_name(&all, "weekly-status-update-2").favorite);
        assert_eq!(find(&lib, "/weekly-status-update").map(|p| p.body), Some("New text.".into()));

        delete_mine(&lib, "weekly-status-update").unwrap();
        assert_eq!(list(&lib).len(), 1);
        assert!(!favorites(&lib).contains("mine/weekly-status-update"), "deleting drops the favorite");
        for bad in ["../registry", "nope", ""] {
            assert!(delete_mine(&lib, bad).is_err() && save_mine(&lib, Some(bad), &Draft { title: "x".into(), description: String::new(), tags: vec![], body: "y".into() }).is_err());
        }
        assert!(save_mine(&lib, None, &Draft { title: " ".into(), description: String::new(), tags: vec![], body: "y".into() }).is_err());
        assert_eq!(stem_for("Con"), "con-prompt");
        assert_eq!(stem_for("¿Qué tal?"), "qué-tal");
    }

    #[test]
    fn specs() {
        assert_eq!(github_folder("https://github.com/o/r/tree/main/prompts/coding/"), Some(("o/r".into(), "main".into(), "prompts/coding".into())));
        assert_eq!(github_folder("https://github.com/o/r"), None);
        assert_eq!(github_folder("https://github.com/o/r/blob/main/a.md"), None);
        assert_eq!(plugins::parse_spec("file:///C:/fixtures/prompts").unwrap(), ("file:///C:/fixtures/prompts".into(), None));
    }

    /// A plain prompt folder from a git repo installs as a collection and picks up new commits.
    #[tokio::test]
    async fn git_collection_installs_and_updates() {
        if plugins::git(None, &["--version"]).await.is_err() {
            return;
        }
        let t = tempfile::tempdir().unwrap();
        let up = t.path().join("upstream");
        write(&up.join("README.md"), "# Prompts");
        write(&up.join("explain.md"), "---\ntitle: Explain code\ntags: [learning]\n---\nExplain $ARGUMENTS.");
        let g = |args: &'static [&'static str]| {
            let up = up.clone();
            async move { plugins::git(Some(&up), args).await.unwrap() }
        };
        g(&["init", "-q", "-b", "main"]).await;
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]).await;
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one"]).await;
        let url = format!("file://{}", up.to_string_lossy().replace('\\', "/"));
        let offer = inspect(&url).await.unwrap();
        assert_eq!(offer.items[0].name, "upstream");

        let lib = Plugins::new(t.path().join("prompts"));
        let c = lib.install("upstream", offer.items[0].source.clone().unwrap()).await.unwrap();
        assert!(c.auto_update);
        assert_eq!(list(&lib).iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["upstream:explain"]);

        write(&up.join("refactor.md"), "Refactor {{file}} for readability.");
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]).await;
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "two"]).await;
        assert_eq!(lib.update_all().await, vec!["upstream".to_string()]);
        assert_eq!(list(&lib).len(), 2, "the new prompt arrives with the update");
    }
}
