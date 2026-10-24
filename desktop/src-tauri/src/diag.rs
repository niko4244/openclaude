//! Self-maintenance: a local, secret-redacted error log (frontend errors, failed chats, panics),
//! grouped for the Diagnostics page, plus self-tests. The app never sends it anywhere; the user
//! can hand a group to the coding agent (to patch OpenClaude's own repo) or file a GitHub issue.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static LOG: OnceLock<PathBuf> = OnceLock::new();
static WRITE: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 1_000_000;

pub fn init(data_dir: &Path) {
    let dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let _ = LOG.set(dir.join("errors.jsonl"));
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".into());
        record("panic", &msg, &at);
        prev(info);
    }));
}

/// Removes things that look like credentials: `sk-…` keys, bearer tokens, `key=…` values, long hex/base64 runs.
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.split_inclusive(|c: char| c.is_whitespace() || "\"',;&()[]{}<>".contains(c)).peekable();
    let mut after_secret_word = false;
    while let Some(tok) = it.next() {
        let (word, sep) = tok.split_at(tok.trim_end_matches(|c: char| c.is_whitespace() || "\"',;&()[]{}<>".contains(c)).len());
        let lower = word.to_ascii_lowercase();
        let hidden = after_secret_word && word.len() >= 6
            || word.starts_with("sk-") && word.len() > 10
            || ["ghp_", "gho_", "github_pat_", "xox", "AKIA", "AIza", "hf_"].iter().any(|p| word.starts_with(p)) && word.len() > 12
            || word.len() >= 32 && word.chars().all(|c| c.is_ascii_alphanumeric() || "-_=+/.".contains(c)) && word.chars().any(|c| c.is_ascii_digit());
        if let Some((k, _)) = word.split_once('=').filter(|(k, v)| is_secret_word(k) && !v.is_empty()) {
            out.push_str(k);
            out.push_str("=[redacted]");
        } else if hidden {
            out.push_str("[redacted]");
        } else {
            out.push_str(word);
        }
        out.push_str(sep);
        after_secret_word = lower == "bearer" || is_secret_word(lower.trim_end_matches(':'));
    }
    out
}

fn is_secret_word(w: &str) -> bool {
    let w = w.to_ascii_lowercase();
    ["api_key", "apikey", "api-key", "token", "secret", "password", "authorization", "x-api-key"].iter().any(|k| w.ends_with(k))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Entry {
    at: i64,
    kind: String,
    message: String,
    detail: String,
}

/// Appends one error (redacted, trimmed). Safe to call from anywhere, including the panic hook.
pub fn record(kind: &str, message: &str, detail: &str) {
    let Some(path) = LOG.get() else { return };
    let Ok(_g) = WRITE.lock() else { return };
    if std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("jsonl.1"));
    }
    let e = Entry {
        at: crate::db::now_ms(),
        kind: kind.chars().take(40).collect(),
        message: redact(message).chars().take(600).collect(),
        detail: redact(detail).chars().take(4000).collect(),
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", serde_json::to_string(&e).unwrap_or_default());
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Group {
    pub fingerprint: String,
    pub kind: String,
    pub message: String,
    pub count: usize,
    pub first_at: i64,
    pub last_at: i64,
    pub detail: String,
}

/// Groups by kind + message with digits stripped (ids and ports vary between occurrences).
fn fingerprint(e: &Entry) -> String {
    let norm: String = e.message.chars().map(|c| if c.is_ascii_digit() { '#' } else { c }).collect();
    format!("{}:{}", e.kind, norm.chars().take(160).collect::<String>())
}

pub fn groups() -> Vec<Group> {
    let Some(path) = LOG.get() else { return vec![] };
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut map: BTreeMap<String, Group> = BTreeMap::new();
    for e in text.lines().filter_map(|l| serde_json::from_str::<Entry>(l).ok()) {
        let fp = fingerprint(&e);
        let g = map.entry(fp.clone()).or_insert_with(|| Group { fingerprint: fp, kind: e.kind.clone(), message: e.message.clone(), count: 0, first_at: e.at, last_at: e.at, detail: e.detail.clone() });
        g.count += 1;
        g.last_at = g.last_at.max(e.at);
        g.detail = e.detail.clone();
    }
    let mut v: Vec<Group> = map.into_values().collect();
    v.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    v
}

pub fn clear() {
    if let Some(p) = LOG.get() {
        let _g = WRITE.lock();
        let _ = std::fs::remove_file(p);
        let _ = std::fs::remove_file(p.with_extension("jsonl.1"));
    }
}

/// The prompt handed to the coding agent to fix a group in OpenClaude's own source.
pub fn fix_prompt(g: &Group, version: &str) -> String {
    format!(
        "OpenClaude Desktop {version} (this repository, app in `desktop/`) reported this error {} time(s):\n\n\
         kind: {}\nmessage: {}\ndetail:\n```\n{}\n```\n\n\
         Find the root cause, fix it with the smallest change, and add a regression test. Run `cargo test` in \
         desktop/src-tauri (through scripts/with-msvc.ps1 on Windows) and `npx tsc --noEmit` in desktop. \
         Commit on a new branch named fix/<short-slug>. Do not push and do not publish a release.",
        g.count, g.kind, g.message, g.detail
    )
}

/// A prefilled GitHub "new issue" link (opened only when the user clicks it).
pub fn issue_url(repo: &str, g: &Group, version: &str) -> String {
    let title = format!("[desktop {version}] {}: {}", g.kind, g.message.chars().take(80).collect::<String>());
    let body = format!("Reported from OpenClaude Desktop {version} ({} time(s)).\n\n```\n{}\n{}\n```", g.count, g.message, g.detail.chars().take(1500).collect::<String>());
    let mut u = url::Url::parse(&format!("https://github.com/{repo}/issues/new")).expect("static url");
    u.query_pairs_mut().append_pair("title", &title).append_pair("body", &body).append_pair("labels", "bug,desktop");
    u.to_string()
}

#[derive(Serialize, Clone, Debug)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

pub fn check(name: &str, ok: bool, detail: impl Into<String>) -> Check {
    Check { name: name.into(), ok, detail: detail.into() }
}

/// The checkout this build came from, when running a source build (…/desktop/src-tauri/target/…).
pub fn source_repo() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|p| p.join(".git").exists() && p.join("desktop").join("src-tauri").is_dir()).map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_credentials_but_keeps_context() {
        let s = redact("HTTP 401: invalid key sk-abc123def456ghi789 for Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig api_key=supersecretvalue at host 127.0.0.1:4000");
        assert!(!s.contains("sk-abc123") && !s.contains("eyJhbG") && !s.contains("supersecret"), "{s}");
        assert!(s.contains("HTTP 401") && s.contains("127.0.0.1:4000") && s.contains("api_key=[redacted]"), "{s}");
        assert_eq!(redact("plain error: connection refused"), "plain error: connection refused");
        assert!(!redact("token: ghp_0123456789abcdefghijklmnopqrstuvwxyz").contains("ghp_0123"));
    }

    #[test]
    fn groups_errors_and_builds_fix_and_issue_text() {
        let t = tempfile::tempdir().unwrap();
        let _ = LOG.set(t.path().join("errors.jsonl"));
        let Some(p) = LOG.get().filter(|p| p.starts_with(t.path())) else { return }; // another test set it first
        let _ = p;
        record("chat", "HTTP 500 from model qwen-7 on port 4000", "trace a");
        record("chat", "HTTP 500 from model qwen-8 on port 4001", "trace b");
        record("frontend", "TypeError: x is undefined", "at App.tsx:10");
        let g = groups();
        assert_eq!(g.len(), 2);
        let chat = g.iter().find(|x| x.kind == "chat").unwrap();
        assert_eq!((chat.count, chat.detail.as_str()), (2, "trace b"));
        let prompt = fix_prompt(chat, "0.2.0");
        assert!(prompt.contains("regression test") && prompt.contains("Do not push"));
        let url = issue_url("niko4244/openclaude", chat, "0.2.0");
        assert!(url.starts_with("https://github.com/niko4244/openclaude/issues/new?title=") && url.contains("labels=bug%2Cdesktop"));
        clear();
        assert!(groups().is_empty());
    }
}
