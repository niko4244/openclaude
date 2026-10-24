//! Local-first sync through a folder the user's own cloud drive keeps in step (OneDrive,
//! Dropbox, a NAS share). Each device writes its snapshot to `<folder>/OpenClaude Sync/<device>.json`
//! and merges the others': projects and knowledge files, chats (newest conversation row wins),
//! messages (a union; branch flags follow the winning conversation), a few preferences, and
//! deletions as tombstones. API keys, tool permissions and connector settings never leave the device.

use crate::db::{Db, now_ms};
use anyhow::Result;
use rusqlite::types::Value as Sql;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Preferences that follow the user across devices.
pub const PREFS: &[&str] = &["system_prompt", "favorite_models", "default_model", "user_name", "theme", "extended_thinking"];
const DIR: &str = "OpenClaude Sync";

fn columns(db: &Db, table: &str) -> Result<Vec<String>> {
    let mut st = db.conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = st.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(cols)
}

fn rows(db: &Db, table: &str) -> Result<Vec<Value>> {
    let cols = columns(db, table)?;
    let mut st = db.conn.prepare(&format!("SELECT {} FROM {table}", cols.join(",")))?;
    let out = st
        .query_map([], |r| {
            let mut m = Map::new();
            for (i, c) in cols.iter().enumerate() {
                let v = match r.get::<_, Sql>(i)? {
                    Sql::Null | Sql::Blob(_) => Value::Null,
                    Sql::Integer(n) => json!(n),
                    Sql::Real(f) => json!(f),
                    Sql::Text(t) => json!(t),
                };
                m.insert(c.clone(), v);
            }
            Ok(Value::Object(m))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(out)
}

fn to_sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(i64::from(*b)),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

/// (kind, id, deleted_at) of chats and projects deleted on this device or learned from others.
pub fn tombstones(db: &Db) -> Vec<(String, String, i64)> {
    db.get_setting("sync_tombstones").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn tombstone(db: &Db, kind: &str, id: &str) {
    let mut t = tombstones(db);
    t.retain(|(_, i, _)| i != id);
    t.push((kind.to_string(), id.to_string(), now_ms()));
    let _ = db.set_setting("sync_tombstones", &serde_json::to_string(&t).unwrap_or_default());
}

pub fn note_pref_change(db: &Db, key: &str) {
    if PREFS.contains(&key) {
        let _ = db.set_setting("sync_prefs_at", &now_ms().to_string());
    }
}

pub fn snapshot(db: &Db, device: &str, name: &str) -> Result<Value> {
    let prefs: Map<String, Value> = PREFS.iter().filter_map(|k| db.get_setting(k).map(|v| (k.to_string(), json!(v)))).collect();
    Ok(json!({
        "format": 1,
        "device_id": device,
        "device_name": name,
        "exported_at": now_ms(),
        "projects": rows(db, "projects")?,
        "project_files": rows(db, "project_files")?,
        "conversations": rows(db, "conversations")?,
        "messages": rows(db, "messages")?,
        "prefs": prefs,
        "prefs_changed_at": db.get_setting("sync_prefs_at").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
        "tombstones": tombstones(db),
    }))
}

fn ids(db: &Db, table: &str) -> Result<HashSet<String>> {
    let mut st = db.conn.prepare(&format!("SELECT id FROM {table}"))?;
    let out = st.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(out)
}

/// Upserts rows by id. With `newer_by`, an existing row is replaced only when the incoming one is newer.
/// Returns the ids that were inserted or replaced.
fn upsert(db: &Db, table: &str, items: &[Value], newer_by: Option<&str>, replace: &[&str], keep: impl Fn(&mut Map<String, Value>) -> bool) -> Result<HashSet<String>> {
    let cols = columns(db, table)?;
    let mut won = HashSet::new();
    for item in items {
        let Some(mut row) = item.as_object().cloned() else { continue };
        if !keep(&mut row) {
            continue;
        }
        let Some(id) = row.get("id").and_then(Value::as_str).map(str::to_string) else { continue };
        let keys: Vec<&String> = cols.iter().filter(|c| row.contains_key(c.as_str())).collect();
        let marks = (1..=keys.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
        let names = keys.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(",");
        let set: Vec<String> = match newer_by {
            Some(_) => keys.iter().filter(|k| k.as_str() != "id").map(|k| format!("{k}=excluded.{k}")).collect(),
            None => replace.iter().filter(|k| keys.iter().any(|c| c == *k)).map(|k| format!("{k}=excluded.{k}")).collect(),
        };
        let sql = match (set.is_empty(), newer_by) {
            (true, _) => format!("INSERT OR IGNORE INTO {table} ({names}) VALUES ({marks})"),
            (false, Some(ts)) => format!("INSERT INTO {table} ({names}) VALUES ({marks}) ON CONFLICT(id) DO UPDATE SET {} WHERE excluded.{ts} > {table}.{ts}", set.join(",")),
            (false, None) => format!("INSERT INTO {table} ({names}) VALUES ({marks}) ON CONFLICT(id) DO UPDATE SET {}", set.join(",")),
        };
        let vals: Vec<Sql> = keys.iter().map(|k| to_sql(&row[k.as_str()])).collect();
        if db.conn.execute(&sql, rusqlite::params_from_iter(vals))? > 0 {
            won.insert(id);
        }
    }
    Ok(won)
}

/// Merges another device's snapshot into this database; returns true when anything changed.
pub fn merge(db: &Db, snap: &Value) -> Result<bool> {
    let before = fingerprint(db)?;
    let tx = db.conn.unchecked_transaction()?;
    let arr = |k: &str| snap[k].as_array().cloned().unwrap_or_default();

    // Deletions: a tombstone wins over a row that was not changed after it.
    let mut local = tombstones(db);
    let remote: Vec<(String, String, i64)> = serde_json::from_value(snap["tombstones"].clone()).unwrap_or_default();
    for (kind, id, at) in &remote {
        let table = if kind == "project" { "projects" } else { "conversations" };
        db.conn.execute(&format!("DELETE FROM {table} WHERE id=?1 AND updated_at<=?2"), rusqlite::params![id, at])?;
        if !local.iter().any(|(_, i, _)| i == id) {
            local.push((kind.clone(), id.clone(), *at));
        }
    }
    db.set_setting("sync_tombstones", &serde_json::to_string(&local)?)?;
    let dead: HashSet<String> = local.iter().map(|(_, i, _)| i.clone()).collect();

    upsert(db, "projects", &arr("projects"), Some("updated_at"), &[], |r| !dead.contains(r["id"].as_str().unwrap_or("")))?;
    let projects = ids(db, "projects")?;
    upsert(db, "project_files", &arr("project_files"), None, &[], |r| projects.contains(r["project_id"].as_str().unwrap_or("")))?;
    let won = upsert(db, "conversations", &arr("conversations"), Some("updated_at"), &[], |r| {
        if r.get("project_id").and_then(Value::as_str).is_some_and(|p| !projects.contains(p)) {
            r.insert("project_id".into(), Value::Null);
        }
        !dead.contains(r["id"].as_str().unwrap_or(""))
    })?;
    let convs = ids(db, "conversations")?;
    let msgs = arr("messages");
    let (follow, add): (Vec<Value>, Vec<Value>) = msgs.into_iter().partition(|m| won.contains(m["conversation_id"].as_str().unwrap_or("")));
    let ok = |r: &mut Map<String, Value>| convs.contains(r["conversation_id"].as_str().unwrap_or(""));
    upsert(db, "messages", &follow, None, &["superseded"], ok)?;
    upsert(db, "messages", &add, None, &[], ok)?;

    let remote_prefs_at = snap["prefs_changed_at"].as_i64().unwrap_or(0);
    let local_prefs_at = db.get_setting("sync_prefs_at").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    if remote_prefs_at > local_prefs_at {
        for (k, v) in snap["prefs"].as_object().into_iter().flatten() {
            if let (true, Some(v)) = (PREFS.contains(&k.as_str()), v.as_str()) {
                db.set_setting(k, v)?;
            }
        }
        db.set_setting("sync_prefs_at", &remote_prefs_at.to_string())?;
    }
    tx.commit()?;
    Ok(fingerprint(db)? != before)
}

/// Changes whenever anything a snapshot carries changes.
pub fn fingerprint(db: &Db) -> Result<String> {
    Ok(db.conn.query_row(
        "SELECT (SELECT count(*)||':'||ifnull(max(updated_at),0) FROM projects)||'|'||
                (SELECT count(*) FROM project_files)||'|'||
                (SELECT count(*)||':'||ifnull(max(updated_at),0)||':'||ifnull(sum(length(title)),0) FROM conversations)||'|'||
                (SELECT count(*)||':'||ifnull(sum(superseded),0) FROM messages)||'|'||
                ifnull((SELECT value FROM settings WHERE key='sync_prefs_at'),'')||'|'||
                ifnull((SELECT length(value) FROM settings WHERE key='sync_tombstones'),0)",
        [],
        |r| r.get(0),
    )?)
}

pub fn folder(db: &Db) -> Option<PathBuf> {
    db.get_setting("sync_folder")
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("OPENCLAUDE_SYNC_DIR").ok())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

pub fn device(db: &Db) -> (String, String) {
    let id = db.get_setting("sync_device_id").unwrap_or_else(|| {
        let id = crate::db::new_id();
        let _ = db.set_setting("sync_device_id", &id);
        id
    });
    let name = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "This device".into());
    (id, name)
}

#[derive(Serialize, Clone, Default, Debug)]
pub struct Status {
    pub folder: Option<String>,
    pub device_name: String,
    pub last_at: i64,
    pub devices: Vec<String>,
    pub error: Option<String>,
}

/// What a sync pass remembers between runs.
#[derive(Default)]
pub struct Memory {
    exported: String,
    seen: HashMap<PathBuf, (SystemTime, String)>,
    pub status: Status,
}

/// One pass: merge other devices' snapshots that changed, then write ours if anything changed.
/// Returns true when this database changed (the UI should reload).
pub fn run_once(db: &Db, mem: &mut Memory) -> Result<bool> {
    let (dev, name) = device(db);
    mem.status.device_name = name.clone();
    let Some(root) = folder(db) else {
        mem.status.folder = None;
        return Ok(false);
    };
    mem.status.folder = Some(root.to_string_lossy().to_string());
    let dir = root.join(DIR);
    std::fs::create_dir_all(&dir)?;
    let mut changed = false;
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") || p.file_stem().and_then(|s| s.to_str()) == Some(dev.as_str()) {
            continue;
        }
        let Ok(mt) = entry.metadata().and_then(|m| m.modified()) else { continue };
        if mem.seen.get(&p).map(|(t, _)| *t) == Some(mt) {
            continue;
        }
        let snap: Value = match std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()) {
            Some(v) => v,
            None => continue, // a partial file while the cloud client is still writing it
        };
        if snap["format"] != 1 {
            continue;
        }
        changed |= merge(db, &snap)?;
        mem.seen.insert(p, (mt, snap["device_name"].as_str().unwrap_or("another device").to_string()));
    }
    mem.status.devices = mem.seen.values().map(|(_, n)| n.clone()).collect();
    mem.status.devices.sort();
    let fp = fingerprint(db)?;
    if fp != mem.exported {
        write_atomic(&dir.join(format!("{dev}.json")), &serde_json::to_vec(&snapshot(db, &dev, &name)?)?)?;
        mem.exported = fp;
    }
    mem.status.last_at = now_ms();
    mem.status.error = None;
    Ok(changed)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Message;

    fn chat(db: &Db, text: &str) -> String {
        let c = db.create_conversation(None, Some("m")).unwrap();
        let mut m = Message { conversation_id: c.id.clone(), role: "user".into(), content: json!(text), ..Default::default() };
        db.insert_message(&mut m).unwrap();
        c.id
    }

    fn texts(db: &Db, cid: &str) -> Vec<String> {
        db.messages(cid).unwrap().into_iter().map(|m| m.content.as_str().unwrap_or_default().to_string()).collect()
    }

    #[test]
    fn two_devices_converge_through_a_folder() {
        let folder = tempfile::tempdir().unwrap();
        let (a, b) = (Db::open_in_memory().unwrap(), Db::open_in_memory().unwrap());
        for d in [&a, &b] {
            d.set_setting("sync_folder", &folder.path().to_string_lossy()).unwrap();
        }
        let (mut ma, mut mb) = (Memory::default(), Memory::default());

        // A writes a chat and a preference; B picks both up
        let cid = chat(&a, "hello from A");
        a.set_setting("system_prompt", "Be brief.").unwrap();
        note_pref_change(&a, "system_prompt");
        run_once(&a, &mut ma).unwrap();
        assert!(run_once(&b, &mut mb).unwrap(), "B changed");
        assert_eq!(texts(&b, &cid), ["hello from A"]);
        assert_eq!(b.get_setting("system_prompt").as_deref(), Some("Be brief."));
        assert_eq!(mb.status.devices.len(), 1);

        // B replies in the same chat; A merges it (union of messages)
        let mut m = Message { conversation_id: cid.clone(), role: "assistant".into(), content: json!("reply on B"), ..Default::default() };
        b.insert_message(&mut m).unwrap();
        b.touch_conversation(&cid).unwrap();
        run_once(&b, &mut mb).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        run_once(&a, &mut ma).unwrap();
        assert_eq!(texts(&a, &cid), ["hello from A", "reply on B"]);

        // nothing new: no change, no rewrite loop
        assert!(!run_once(&a, &mut ma).unwrap());

        // A deletes the chat; the tombstone removes it on B and it never comes back
        a.delete_conversation(&cid).unwrap();
        tombstone(&a, "conversation", &cid);
        run_once(&a, &mut ma).unwrap();
        run_once(&b, &mut mb).unwrap();
        assert!(b.get_conversation(&cid).unwrap().is_none());
        run_once(&b, &mut mb).unwrap();
        run_once(&a, &mut ma).unwrap();
        assert!(a.get_conversation(&cid).unwrap().is_none(), "no resurrection");

        // secrets and permissions never leave the device
        a.set_setting("tool_policy:mcp__x__y", "allow").unwrap();
        let snap = snapshot(&a, "a", "A").unwrap().to_string();
        assert!(!snap.contains("tool_policy") && !snap.contains("api-key"));
    }

    #[test]
    fn newer_conversation_row_wins_and_orphans_are_skipped() {
        let a = Db::open_in_memory().unwrap();
        let cid = chat(&a, "x");
        let mut snap = snapshot(&a, "a", "A").unwrap();
        // older remote title loses, newer wins
        let b = Db::open_in_memory().unwrap();
        merge(&b, &snap).unwrap();
        let mut c = b.get_conversation(&cid).unwrap().unwrap();
        c.title = "local title".into();
        b.update_conversation(&c).unwrap();
        merge(&b, &snap).unwrap();
        assert_eq!(b.get_conversation(&cid).unwrap().unwrap().title, "local title");
        snap["conversations"][0]["title"] = json!("remote newer");
        snap["conversations"][0]["updated_at"] = json!(now_ms() + 60_000);
        merge(&b, &snap).unwrap();
        assert_eq!(b.get_conversation(&cid).unwrap().unwrap().title, "remote newer");
        // a message for a chat this device does not have, and a missing project, do not break the merge
        snap["messages"][0]["conversation_id"] = json!("missing");
        snap["messages"][0]["id"] = json!("m-orphan");
        snap["conversations"][0]["project_id"] = json!("gone");
        snap["conversations"][0]["updated_at"] = json!(now_ms() + 120_000);
        assert!(merge(&b, &snap).is_ok());
        assert_eq!(b.get_conversation(&cid).unwrap().unwrap().project_id, None);
    }
}
