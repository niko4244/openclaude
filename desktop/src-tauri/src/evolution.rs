// Read-only view over the Evolution Engine's registry, plus the two controls a
// desktop app can honestly offer: run a sweep now, and pause/resume monitoring.
//
// The engine itself lives in `desktop/feature-intel/` and is shared with the
// GitHub workflow. This module never invents data: if the registry is missing it
// says so, and if no checkout is reachable it explains why "Check now" cannot
// run instead of pretending the check succeeded.
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const CHECK_TIMEOUT: Duration = Duration::from_secs(240);
const TICK_MS: Duration = Duration::from_secs(15 * 60);

type Res<T> = Result<T, String>;

#[derive(Serialize, Clone, Debug, Default)]
pub struct SourceRow {
    pub id: String,
    pub status: String,
    pub last_checked: Option<String>,
    pub error: Option<String>,
    pub items: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct FeatureRow {
    pub id: String,
    pub name: String,
    pub product: String,
    pub category: String,
    pub status: String,
    pub parity: String,
    pub percent: Option<i64>,
    pub summary: String,
    pub source_urls: Vec<String>,
    pub blockers: Vec<String>,
    pub investigation: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct TaskRow {
    pub id: String,
    pub feature_id: String,
    pub title: String,
    pub status: String,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub pr_draft: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct CheckRow {
    pub at: Option<String>,
    pub status: Option<String>,
    pub added: u64,
    pub changed: u64,
    pub failed: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SummaryRow {
    pub total: u64,
    pub signals: u64,
    pub untriaged: u64,
    pub equivalent: u64,
    pub partial: u64,
    pub missing: u64,
    pub unknown_count: u64,
    pub not_replicable: u64,
    pub blocked: u64,
    pub implemented: u64,
    pub coverage_percent: Option<i64>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct EvolutionStatus {
    pub available: bool,
    pub reason: Option<String>,
    pub engine_dir: String,
    pub registry_path: Option<String>,
    /// "ok", "missing", "invalid" (the file exists but is not JSON) or
    /// "unreadable" (permissions, I/O). A truncated file must not look like a
    /// machine that never synced.
    pub registry_state: String,
    pub enabled: bool,
    pub interval_hours: u32,
    pub autonomy: String,
    pub last_check: Option<CheckRow>,
    pub summary: SummaryRow,
    pub sources: Vec<SourceRow>,
    pub features: Vec<FeatureRow>,
    pub tasks: Vec<TaskRow>,
    pub can_check: bool,
    pub check_reason: Option<String>,
    pub node: Option<String>,
    pub checkout: Option<String>,
}

fn read_json(p: &Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())
}

/// Read the registry while keeping the three failure modes apart: absent,
/// present but invalid JSON, and present but unreadable.
fn read_registry(dir: &Path) -> (Option<Value>, &'static str, Option<String>) {
    let path = dir.join("registry.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v) => (Some(v), "ok", None),
            Err(e) => (
                None,
                "invalid",
                Some(format!(
                    "{} is not valid JSON ({}). It was left untouched so it can be inspected or restored.",
                    path.display(),
                    e
                )),
            ),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, "missing", None),
        Err(e) => (
            None,
            "unreadable",
            Some(format!("Could not read {}: {e}.", path.display())),
        ),
    }
}

fn node_version() -> Option<String> {
    static NODE: OnceLock<Option<String>> = OnceLock::new();
    NODE.get_or_init(|| {
        let mut cmd = Command::new("node");
        cmd.arg("--version").stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .clone()
}

/// Walk up from the working directory and the executable looking for a checkout.
fn find_checkout_intel() -> Option<PathBuf> {
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    for start in starts {
        let mut cur: Option<&Path> = Some(start.as_path());
        for _ in 0..8 {
            let Some(dir) = cur else { break };
            let candidate = dir.join("desktop").join("feature-intel");
            if candidate.join("cli.mjs").is_file() {
                return Some(candidate);
            }
            if dir.file_name().and_then(|s| s.to_str()) == Some("feature-intel") && dir.join("cli.mjs").is_file() {
                return Some(dir.to_path_buf());
            }
            cur = dir.parent();
        }
    }
    None
}

/// Resolution order: explicit override, a synced registry in app data, a checkout.
/// An explicit override always wins, even when it holds nothing: tests and
/// portable setups must be able to say "this is the directory" without the app
/// silently reading a different registry from a checkout.
pub fn resolve_dir(data_dir: &Path) -> Option<PathBuf> {
    if let Some(v) = std::env::var_os("OPENCLAUDE_EVOLUTION_DIR") {
        return Some(PathBuf::from(v));
    }
    let synced = data_dir.join("evolution");
    if synced.join("registry.json").is_file() {
        return Some(synced);
    }
    find_checkout_intel()
}

fn u64_of(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(|x| x.as_u64()).unwrap_or(0)
}
fn str_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn build_features(registry: &Value) -> Vec<FeatureRow> {
    let mut rows: Vec<FeatureRow> = registry
        .get("features")
        .and_then(|f| f.as_array())
        .map(|arr| {
            arr.iter()
                .map(|f| {
                    let parity = f.get("parity").cloned().unwrap_or(Value::Null);
                    FeatureRow {
                        id: str_of(f, "id").unwrap_or_default(),
                        name: str_of(f, "name").unwrap_or_default(),
                        product: str_of(f, "product").unwrap_or_default(),
                        category: str_of(f, "category").unwrap_or_default(),
                        status: str_of(f, "status").unwrap_or_else(|| "announced".into()),
                        parity: str_of(&parity, "status").unwrap_or_else(|| "unknown".into()),
                        percent: parity.get("percent").and_then(|p| p.as_i64()),
                        summary: str_of(f, "summary").unwrap_or_default(),
                        source_urls: f
                            .get("sourceUrls")
                            .and_then(|u| u.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                            .unwrap_or_default(),
                        blockers: f
                            .get("blockers")
                            .and_then(|u| u.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                            .unwrap_or_default(),
                        investigation: f.get("investigation").and_then(|i| str_of(i, "planPath")),
                        updated_at: str_of(f, "updatedAt"),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let rank = |s: &str| match s {
        "missing" => 0,
        "partial" => 1,
        "unknown" => 2,
        "equivalent" => 3,
        _ => 4,
    };
    rows.sort_by(|a, b| rank(&a.parity).cmp(&rank(&b.parity)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    rows
}

fn build_sources(registry: &Value) -> Vec<SourceRow> {
    let mut rows: Vec<SourceRow> = registry
        .get("sources")
        .and_then(|s| s.as_object())
        .map(|obj| {
            obj.iter()
                .map(|(id, s)| SourceRow {
                    id: id.clone(),
                    status: str_of(s, "status").unwrap_or_else(|| "unknown".into()),
                    last_checked: str_of(s, "checkedAt"),
                    error: str_of(s, "error"),
                    items: s.get("itemCount").and_then(|x| x.as_u64()),
                })
                .collect()
        })
        .unwrap_or_default();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

fn build_tasks(ledger: &Value) -> Vec<TaskRow> {
    ledger
        .get("tasks")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| TaskRow {
                    id: str_of(t, "id").unwrap_or_default(),
                    feature_id: str_of(t, "featureId").unwrap_or_default(),
                    title: str_of(t, "title").unwrap_or_default(),
                    status: str_of(t, "status").unwrap_or_default(),
                    branch: str_of(t, "branch"),
                    worktree: str_of(t, "worktree"),
                    pr_draft: str_of(t, "prDraft"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn summary_of(registry: &Value) -> SummaryRow {
    let features = registry.get("features").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    let count = |s: &str| {
        features
            .iter()
            .filter(|f| f.get("parity").and_then(|p| p.get("status")).and_then(|x| x.as_str()) == Some(s))
            .count() as u64
    };
    let status_count = |s: &str| features.iter().filter(|f| f.get("status").and_then(|x| x.as_str()) == Some(s)).count() as u64;
    let equivalent = count("equivalent");
    let partial = count("partial");
    let missing = count("missing");
    let known = equivalent + partial + missing;
    let signals = registry.get("signals").and_then(|s| s.as_array()).cloned().unwrap_or_default();
    let untriaged = signals
        .iter()
        .filter(|s| s.get("status").and_then(|x| x.as_str()) == Some("new") && s.get("featureId").map(|v| v.is_null()).unwrap_or(true))
        .count() as u64;
    SummaryRow {
        total: features.len() as u64,
        signals: signals.len() as u64,
        untriaged,
        equivalent,
        partial,
        missing,
        unknown_count: count("unknown"),
        not_replicable: count("not-replicable"),
        blocked: status_count("blocked"),
        implemented: ["implemented", "tested", "released"]
            .iter()
            .map(|s| status_count(s))
            .sum(),
        coverage_percent: if known == 0 {
            None
        } else {
            Some((((equivalent as f64 + partial as f64 * 0.5) / known as f64) * 100.0).round() as i64)
        },
    }
}

/// Pure over the files on disk: no network, no process spawn beyond `node --version`.
pub fn build(dir: &Path) -> EvolutionStatus {
    let (registry, registry_state, registry_error) = read_registry(dir);
    let config = read_json(&dir.join("config.json")).unwrap_or_else(|| json!({}));
    let ledger = read_json(&dir.join("ledger.json")).unwrap_or_else(|| json!({ "tasks": [] }));
    let cli = dir.join("cli.mjs");
    let node = node_version();
    let enabled = config.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    let checkout = dir.parent().and_then(|p| p.parent()).map(|p| p.to_string_lossy().to_string());
    let (can_check, check_reason) = if !cli.is_file() {
        (false, Some("The Evolution Engine checkout is not present on this machine; the repository workflow keeps the registry current.".to_string()))
    } else if node.is_none() {
        (false, Some("Node.js 22+ is required to run the engine on this machine.".to_string()))
    } else {
        (true, None)
    };

    match registry {
        Some(reg) => {
            let last = reg.get("lastCheck").cloned().unwrap_or(Value::Null);
            EvolutionStatus {
                available: true,
                reason: None,
                engine_dir: dir.to_string_lossy().to_string(),
                registry_path: Some(dir.join("registry.json").to_string_lossy().to_string()),
                registry_state: registry_state.to_string(),
                enabled,
                interval_hours: config.get("intervalHours").and_then(|v| v.as_u64()).unwrap_or(6) as u32,
                autonomy: str_of(&config, "autonomy").unwrap_or_else(|| "research".into()),
                last_check: if last.is_null() {
                    None
                } else {
                    Some(CheckRow {
                        at: str_of(&last, "finishedAt"),
                        status: str_of(&last, "status"),
                        added: u64_of(&last, "added"),
                        changed: u64_of(&last, "changed"),
                        failed: u64_of(&last, "failed"),
                    })
                },
                summary: summary_of(&reg),
                sources: build_sources(&reg),
                features: build_features(&reg),
                tasks: build_tasks(&ledger),
                can_check,
                check_reason,
                node,
                checkout,
            }
        }
        None => EvolutionStatus {
            available: false,
            reason: Some(registry_error.unwrap_or_else(|| {
                format!("No registry yet at {}.", dir.join("registry.json").display())
            })),
            engine_dir: dir.to_string_lossy().to_string(),
            registry_path: None,
            registry_state: registry_state.to_string(),
            enabled,
            interval_hours: config.get("intervalHours").and_then(|v| v.as_u64()).unwrap_or(6) as u32,
            autonomy: str_of(&config, "autonomy").unwrap_or_else(|| "research".into()),
            last_check: None,
            summary: SummaryRow::default(),
            sources: Vec::new(),
            features: build_features(&Value::Null),
            tasks: build_tasks(&ledger),
            can_check,
            check_reason,
            node,
            checkout,
        },
    }
}

pub fn status(data_dir: &Path) -> EvolutionStatus {
    match resolve_dir(data_dir) {
        Some(dir) => build(&dir),
        None => EvolutionStatus {
            available: false,
            reason: Some("The Evolution Engine is not installed on this machine. The repository workflow records the registry; install a checkout or point OPENCLAUDE_EVOLUTION_DIR at one to see it here.".into()),
            registry_state: "missing".into(),
            ..Default::default()
        },
    }
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Res<(Option<i32>, String, String)> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                return Ok((
                    status.code(),
                    String::from_utf8_lossy(&out.stdout).to_string(),
                    String::from_utf8_lossy(&out.stderr).to_string(),
                ));
            }
            None if started.elapsed() > timeout => {
                let _ = child.kill();
                return Err(format!("the sweep exceeded {} s and was stopped", timeout.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(120)),
        }
    }
}

/// Run one sweep with the shared engine. The engine's own lock prevents a second
/// concurrent sweep (from the ticker or another process); that returns "locked".
pub fn run_check(data_dir: &Path) -> Res<Value> {
    let dir = resolve_dir(data_dir).ok_or("The Evolution Engine is not installed on this machine.")?;
    run_check_at(&dir)
}

pub fn run_check_at(dir: &Path) -> Res<Value> {
    let cli = dir.join("cli.mjs");
    if !cli.is_file() {
        return Err("This registry was synced from another machine; there is no engine here to run.".into());
    }
    let repo = dir
        .parent()
        .and_then(|p| p.parent())
        .ok_or("cannot locate the repository root from the engine directory")?;
    if node_version().is_none() {
        return Err("Node.js 22+ was not found on PATH.".into());
    }
    let mut cmd = Command::new("node");
    cmd.arg(&cli)
        .arg("check")
        .arg("--quiet")
        .arg("--json")
        .current_dir(repo);
    let (code, stdout, stderr) = run_with_timeout(cmd, CHECK_TIMEOUT)?;
    let parsed: Option<Value> = serde_json::from_str(stdout.trim()).ok();
    let status = parsed
        .as_ref()
        .and_then(|v| v.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or(if code == Some(0) { "ok" } else { "failed" })
        .to_string();
    Ok(json!({
        "status": status,
        "exit_code": code,
        "added": parsed.as_ref().map(|v| u64_of(v, "added")).unwrap_or(0),
        "changed": parsed.as_ref().map(|v| u64_of(v, "changed")).unwrap_or(0),
        "stderr": stderr.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"),
        "engine_dir": dir.to_string_lossy(),
    }))
}

/// Only the three settings the dashboard exposes. Unknown keys are preserved.
pub fn configure(data_dir: &Path, enabled: Option<bool>, interval_hours: Option<u32>, autonomy: Option<&str>) -> Res<EvolutionStatus> {
    let dir = resolve_dir(data_dir).ok_or("The Evolution Engine is not installed on this machine.")?;
    configure_at(&dir, enabled, interval_hours, autonomy)
}

pub fn configure_at(dir: &Path, enabled: Option<bool>, interval_hours: Option<u32>, autonomy: Option<&str>) -> Res<EvolutionStatus> {
    let path = dir.join("config.json");
    let mut config = read_json(&path).unwrap_or_else(|| json!({ "version": 1 }));
    if let Some(v) = enabled {
        config["enabled"] = json!(v);
    }
    if let Some(h) = interval_hours {
        if !(1..=168).contains(&h) {
            return Err("interval must be between 1 and 168 hours".into());
        }
        config["intervalHours"] = json!(h);
    }
    if let Some(a) = autonomy {
        if !["research", "implement", "prepare-pr"].contains(&a) {
            return Err("autonomy must be research, implement, or prepare-pr".into());
        }
        config["autonomy"] = json!(a);
    }
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{text}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(build(&dir))
}

fn should_run(data_dir: &Path) -> bool {
    let Some(dir) = resolve_dir(data_dir) else { return false };
    let config = read_json(&dir.join("config.json")).unwrap_or_else(|| json!({}));
    if config.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
        return false;
    }
    if config.get("monitoring").and_then(|m| m.get("desktopApp")).and_then(|v| v.as_bool()) == Some(false) {
        return false;
    }
    if !dir.join("cli.mjs").is_file() || node_version().is_none() {
        return false;
    }
    let interval = config.get("intervalHours").and_then(|v| v.as_u64()).unwrap_or(6).max(1) as i64;
    let last = read_json(&dir.join("registry.json"))
        .and_then(|r| str_of(r.get("lastCheck")?, "finishedAt"))
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
        .map(|d| d.timestamp());
    match last {
        None => true,
        Some(t) => chrono::Utc::now().timestamp() - t >= interval * 3_600,
    }
}

/// Lightweight desktop scheduler. It only checks "is a sweep due" every 15
/// minutes; the sweep itself is the same code path as "Check now".
pub fn start_ticker(data_dir: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK_MS);
        if should_run(&data_dir) {
            let _ = run_check(&data_dir);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Tests run in parallel in one process and the clock can be coarse, so a
    /// name made only of the current time can collide between two tests.
    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn tempdir() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "oc-evo-rs-{}-{}-{}",
            std::process::id(),
            rand_suffix(),
            n
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    fn registry() -> Value {
        json!({
            "schemaVersion": 1,
            "lastCheck": { "finishedAt": "2026-10-24T00:00:00Z", "status": "ok", "added": 3, "changed": 1, "failed": 0 },
            "sources": {
                "b": { "status": "ok", "checkedAt": "2026-10-24T00:00:00Z", "itemCount": 4 },
                "a": { "status": "failed", "error": "HTTP 500" }
            },
            "signals": [
                { "id": "sig_1", "status": "new", "featureId": null },
                { "id": "sig_2", "status": "classified", "featureId": "feat_x" }
            ],
            "features": [
                { "id": "feat_a", "name": "Alpha", "product": "claude-desktop", "status": "announced", "parity": { "status": "missing", "percent": 0 }, "sourceUrls": ["https://example.test"], "blockers": ["needs REA"] },
                { "id": "feat_b", "name": "Beta", "product": "claude-desktop", "status": "implemented", "parity": { "status": "equivalent", "percent": 100 } },
                { "id": "feat_c", "name": "Gamma", "product": "cowork", "status": "blocked", "parity": { "status": "partial", "percent": 50 } }
            ]
        })
    }

    #[test]
    fn summary_matches_the_registry() {
        let s = summary_of(&registry());
        assert_eq!(s.total, 3);
        assert_eq!(s.signals, 2);
        assert_eq!(s.untriaged, 1);
        assert_eq!(s.equivalent, 1);
        assert_eq!(s.partial, 1);
        assert_eq!(s.missing, 1);
        assert_eq!(s.blocked, 1);
        assert_eq!(s.implemented, 1);
        assert_eq!(s.coverage_percent, Some(50));
    }

    #[test]
    fn features_are_ordered_by_gap_first() {
        let rows = build_features(&registry());
        assert_eq!(rows[0].id, "feat_a");
        assert_eq!(rows[1].id, "feat_c");
        assert_eq!(rows[2].id, "feat_b");
        assert_eq!(rows[0].percent, Some(0));
    }

    #[test]
    fn sources_are_sorted_and_keep_errors() {
        let rows = build_sources(&registry());
        assert_eq!(rows[0].id, "a");
        assert_eq!(rows[0].error.as_deref(), Some("HTTP 500"));
        assert_eq!(rows[1].items, Some(4));
    }

    #[test]
    fn build_reports_missing_registry_without_inventing_one() {
        let dir = tempdir();
        let st = build(&dir);
        assert!(!st.available);
        assert_eq!(st.registry_state, "missing");
        assert!(st.reason.unwrap().contains("No registry"));
        assert!(!st.can_check);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn build_reports_a_corrupt_registry_instead_of_pretending_it_is_missing() {
        let dir = tempdir();
        // a file truncated mid-write, as a killed sweep would leave it
        let broken = "{\n  \"schemaVersion\": 1,\n  \"features\": [\n";
        fs::write(dir.join("registry.json"), broken).unwrap();
        let st = build(&dir);
        assert!(!st.available);
        assert_eq!(st.registry_state, "invalid");
        let reason = st.reason.unwrap_or_default();
        assert!(reason.contains("not valid JSON"), "{reason}");
        assert!(reason.contains("registry.json"), "{reason}");
        assert_eq!(st.summary.total, 0, "no data may be invented from a broken file");
        assert!(st.features.is_empty() && st.sources.is_empty());
        // the file is evidence: the dashboard must not rewrite or repair it
        assert_eq!(fs::read_to_string(dir.join("registry.json")).unwrap(), broken);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn run_check_reports_a_non_zero_engine_exit() {
        let root = tempdir();
        let dir = root.join("desktop").join("feature-intel");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("cli.mjs"),
            "process.stderr.write('boom: upstream 502\\n');\nprocess.exit(3);\n",
        )
        .unwrap();
        assert!(dir.join("cli.mjs").is_file());
        let r = run_check_at(&dir).expect("a finished process is not an IPC error");
        assert_eq!(r["exit_code"], 3);
        assert_eq!(r["status"], "failed");
        assert_eq!(r["added"], 0);
        assert!(r["stderr"].as_str().unwrap_or_default().contains("upstream 502"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn configure_preserves_unknown_keys_and_validates_input() {
        let dir = tempdir();
        fs::write(dir.join("config.json"), r#"{"version":1,"enabled":true,"custom":42}"#).unwrap();
        fs::write(dir.join("registry.json"), registry().to_string()).unwrap();

        let st = configure_at(&dir, Some(false), Some(3), Some("implement")).unwrap();
        assert!(!st.enabled);
        assert_eq!(st.interval_hours, 3);
        assert_eq!(st.autonomy, "implement");
        let written: Value = serde_json::from_str(&fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        assert_eq!(written["custom"], 42);

        assert!(configure_at(&dir, None, Some(0), None).is_err());
        assert!(configure_at(&dir, None, None, Some("yolo")).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
