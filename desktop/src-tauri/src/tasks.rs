//! Tasks: saved prompts that run on demand or on a schedule, in the background,
//! while the app is running (it stays alive in the tray). Each run is a normal
//! chat, so results are browsable and continuable. Background runs cannot
//! answer approval prompts, so only "Always allow" tools are usable.

use crate::chat::{ChatEvent, Run, SendArgs, Sink};
use crate::db::{Db, new_id, now_ms};
use crate::state::AppState;
use chrono::{Local, NaiveTime, TimeZone};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub model: String,
    /// "manual" | "every:<minutes>" | "daily:HH:MM" (local time)
    pub schedule: String,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_conversation_id: Option<String>,
    pub running: bool,
    /// Granted folder: when set, the coding agent works in it (edits allowed, commands denied).
    #[serde(default)]
    pub workspace: Option<String>,
}

/// Next run strictly after `from_ms`, or None for manual/invalid schedules.
pub fn next_run(schedule: &str, from_ms: i64) -> Option<i64> {
    if let Some(m) = schedule.strip_prefix("every:") {
        let mins: i64 = m.parse().ok()?;
        return (mins >= 5).then(|| from_ms + mins * 60_000);
    }
    if let Some(t) = schedule.strip_prefix("daily:") {
        let time = NaiveTime::parse_from_str(t, "%H:%M").ok()?;
        let now = Local.timestamp_millis_opt(from_ms).single()?;
        let today = now.date_naive().and_time(time);
        let mut at = Local.from_local_datetime(&today).earliest()?;
        if at.timestamp_millis() <= from_ms {
            at = Local.from_local_datetime(&(today + chrono::Duration::days(1))).earliest()?;
        }
        return Some(at.timestamp_millis());
    }
    None
}

pub fn valid_schedule(s: &str) -> bool {
    s == "manual" || next_run(s, now_ms()).is_some()
}

impl Db {
    fn task_row(r: &rusqlite::Row) -> rusqlite::Result<Task> {
        Ok(Task {
            id: r.get(0)?,
            title: r.get(1)?,
            prompt: r.get(2)?,
            model: r.get(3)?,
            schedule: r.get(4)?,
            enabled: r.get::<_, i64>(5)? != 0,
            next_run_at: r.get(6)?,
            last_run_at: r.get(7)?,
            last_status: r.get(8)?,
            last_conversation_id: r.get(9)?,
            running: false,
            workspace: r.get(10)?,
        })
    }
    const TASK_COLS: &'static str = "id,title,prompt,model,schedule,enabled,next_run_at,last_run_at,last_status,last_conversation_id,workspace";

    pub fn tasks(&self) -> anyhow::Result<Vec<Task>> {
        let mut st = self.conn.prepare(&format!("SELECT {} FROM tasks ORDER BY created_at DESC", Self::TASK_COLS))?;
        let rows = st.query_map([], Self::task_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
    pub fn task(&self, id: &str) -> anyhow::Result<Option<Task>> {
        Ok(self.conn.query_row(&format!("SELECT {} FROM tasks WHERE id=?1", Self::TASK_COLS), [id], Self::task_row).optional()?)
    }
    pub fn save_task(&self, t: &mut Task) -> anyhow::Result<()> {
        if t.id.is_empty() {
            t.id = new_id();
        }
        t.next_run_at = if t.enabled { next_run(&t.schedule, now_ms()) } else { None };
        self.conn.execute(
            "INSERT INTO tasks(id,title,prompt,model,schedule,enabled,next_run_at,created_at,workspace) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, prompt=excluded.prompt, model=excluded.model,
             schedule=excluded.schedule, enabled=excluded.enabled, next_run_at=excluded.next_run_at, workspace=excluded.workspace",
            params![t.id, t.title, t.prompt, t.model, t.schedule, t.enabled as i64, t.next_run_at, now_ms(), t.workspace],
        )?;
        Ok(())
    }
    pub fn delete_task(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM tasks WHERE id=?1", [id])?;
        Ok(())
    }
    /// Claim due tasks: advance next_run_at first so a slow run is never started twice.
    pub fn claim_due_tasks(&self, now: i64) -> anyhow::Result<Vec<Task>> {
        let due: Vec<Task> = self
            .tasks()?
            .into_iter()
            .filter(|t| t.enabled && t.next_run_at.is_some_and(|n| n <= now))
            .collect();
        for t in &due {
            self.conn.execute("UPDATE tasks SET next_run_at=?2 WHERE id=?1", params![t.id, next_run(&t.schedule, now)])?;
        }
        Ok(due)
    }
    pub fn finish_task(&self, id: &str, status: &str, conversation_id: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE tasks SET last_run_at=?2, last_status=?3, last_conversation_id=?4 WHERE id=?1",
            params![id, now_ms(), status, conversation_id],
        )?;
        Ok(())
    }
}

/// Run one task now as a new chat. Returns the conversation id.
pub async fn run_task(state: Arc<AppState>, app: AppHandle, task: Task) -> anyhow::Result<String> {
    let conv = {
        let db = state.db.lock().unwrap();
        let mut c = db.create_conversation(None, Some(&task.model))?;
        c.title = format!("⏱ {} · {}", task.title, Local::now().format("%b %d %H:%M"));
        db.update_conversation(&c)?;
        c
    };
    state.running_tasks.lock().unwrap().insert(task.id.clone());
    let _ = app.emit("tasks-changed", ());
    if let Some(ws) = task.workspace.clone().filter(|w| !w.is_empty()) {
        return run_folder_task(state, app, task, ws, conv.id).await;
    }
    let outcome: Arc<std::sync::Mutex<(Option<String>, bool)>> = Default::default();
    let o2 = outcome.clone();
    let sink = Sink::background(move |e| {
        let mut o = o2.lock().unwrap();
        match e {
            ChatEvent::Error { message } => o.0 = Some(message),
            ChatEvent::AssistantMessage { message } if message.status == "error" => o.0 = message.error,
            ChatEvent::AssistantMessage { .. } => o.1 = true,
            _ => {}
        }
    });
    let run = Arc::new(Run { cancel: tokio::sync::Notify::new() });
    let args = SendArgs { conversation_id: conv.id.clone(), content: Some(serde_json::Value::String(task.prompt.clone())), model: task.model.clone(), replace_from: None };
    crate::chat::run(state.clone(), new_id(), run, args, sink).await;
    let (err, answered) = outcome.lock().unwrap().clone();
    let status = match (err, answered) {
        (Some(e), _) => format!("error: {}", e.chars().take(200).collect::<String>()),
        (None, true) => "ok".into(),
        (None, false) => "no reply".into(),
    };
    state.db.lock().unwrap().finish_task(&task.id, &status, &conv.id)?;
    state.running_tasks.lock().unwrap().remove(&task.id);
    let _ = app.emit("tasks-changed", ());
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(format!("Task {}: {}", if status == "ok" { "finished" } else { "needs attention" }, task.title))
            .body(if status == "ok" { "Open OpenClaude to see the result.".to_string() } else { status.clone() })
            .show();
    }
    Ok(conv.id)
}

/// Cowork-style run: the coding agent works inside the granted folder. File edits inside
/// it are approved automatically; anything else that asks for approval is denied.
async fn run_folder_task(state: Arc<AppState>, app: AppHandle, task: Task, ws: String, cid: String) -> anyhow::Result<String> {
    use crate::db::Message;
    let granted: Vec<String> = state.db.lock().unwrap().get_setting("workspaces").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let outcome = if !granted.contains(&ws) {
        Err(anyhow::anyhow!("folder {ws} is no longer granted"))
    } else {
        let cli = crate::agent::locate_cli(state.db.lock().unwrap().get_setting("openclaude_cli_path"))
            .ok_or_else(|| anyhow::anyhow!("OpenClaude CLI not found"));
        match cli {
            Err(e) => Err(e),
            Ok(cli) => {
                let gw = state.gateway.read().await.clone();
                let plugin_dirs = state.plugins.cli_plugin_dirs();
                let args = crate::agent::StartArgs {
                    cli: &cli,
                    cwd: std::path::Path::new(&ws),
                    model: &task.model,
                    permission_mode: "default",
                    gateway_base: &gw.base_url,
                    api_key: gw.api_key.as_deref(),
                    plugin_dirs: &plugin_dirs,
                };
                let root = std::path::PathBuf::from(&ws);
                crate::agent::run_headless(args, &task.prompt, std::time::Duration::from_secs(15 * 60), |t, i| crate::agent::allow_in_folder(&root, t, i)).await
            }
        }
    };
    let (status, body) = match &outcome {
        Ok(o) => {
            let mut b = o.result.clone();
            if !o.actions.is_empty() {
                b.push_str(&format!("\n\n**Actions**\n{}", o.actions.iter().map(|a| format!("- {a}")).collect::<Vec<_>>().join("\n")));
            }
            if !o.denied.is_empty() {
                b.push_str(&format!("\n\n**Denied (need interactive approval)**\n{}", o.denied.iter().map(|a| format!("- {a}")).collect::<Vec<_>>().join("\n")));
            }
            (if o.is_error { "error: agent reported an error".to_string() } else { "ok".to_string() }, b)
        }
        Err(e) => (format!("error: {e}"), String::new()),
    };
    {
        let db = state.db.lock().unwrap();
        let mut u = Message { conversation_id: cid.clone(), role: "user".into(), content: serde_json::Value::String(format!("{}\n\n_Folder: {ws}_", task.prompt)), ..Default::default() };
        db.insert_message(&mut u)?;
        let mut m = Message {
            conversation_id: cid.clone(),
            role: "assistant".into(),
            content: serde_json::Value::String(body),
            model_requested: Some(task.model.clone()),
            status: if status == "ok" { "complete".into() } else { "error".into() },
            error: (status != "ok").then(|| status.clone()),
            ..Default::default()
        };
        db.insert_message(&mut m)?;
        db.finish_task(&task.id, &status, &cid)?;
    }
    state.running_tasks.lock().unwrap().remove(&task.id);
    let _ = app.emit("tasks-changed", ());
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(format!("Folder task {}: {}", if status == "ok" { "finished" } else { "needs attention" }, task.title)).body(if status == "ok" { "Open OpenClaude to see what changed." } else { status.as_str() }).show();
    }
    Ok(cid)
}

/// Checks for due tasks every 30 s for the lifetime of the app.
pub fn start_scheduler(state: Arc<AppState>, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tick.tick().await;
            let due = state.db.lock().unwrap().claim_due_tasks(now_ms()).unwrap_or_default();
            for t in due {
                if state.running_tasks.lock().unwrap().contains(&t.id) {
                    continue;
                }
                tauri::async_runtime::spawn(run_task(state.clone(), app.clone(), t));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules() {
        let now = now_ms();
        assert_eq!(next_run("every:15", now), Some(now + 15 * 60_000));
        assert_eq!(next_run("every:1", now), None, "minimum interval is 5 minutes");
        assert_eq!(next_run("manual", now), None);
        let d = next_run("daily:09:30", now).unwrap();
        assert!(d > now && d <= now + 86_400_000 + 3_600_000);
        let t = Local.timestamp_millis_opt(d).unwrap();
        assert_eq!(t.format("%H:%M").to_string(), "09:30");
        assert!(!valid_schedule("daily:25:00"));
    }

    #[test]
    fn claim_advances_so_runs_are_not_duplicated() {
        let db = Db::open_in_memory().unwrap();
        let mut t = Task { title: "t".into(), prompt: "p".into(), model: "m".into(), schedule: "every:10".into(), enabled: true, ..Default::default() };
        db.save_task(&mut t).unwrap();
        let first = t.next_run_at.unwrap();
        assert!(db.claim_due_tasks(first - 1).unwrap().is_empty());
        assert_eq!(db.claim_due_tasks(first).unwrap().len(), 1);
        assert!(db.claim_due_tasks(first).unwrap().is_empty(), "already advanced");
        assert_eq!(db.task(&t.id).unwrap().unwrap().next_run_at, Some(first + 10 * 60_000));
    }
}
