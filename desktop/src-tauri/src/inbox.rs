//! Approvals inbox and the proactive assistant (OpenClaude's take on Claude Duet): background
//! runs cannot ask in the moment, so a tool call that needs approval waits here instead of
//! failing; approving runs it and lets the assistant continue in the same chat. The proactive
//! assistant is a morning brief plus periodic check-ins over the user's connectors.

use crate::db::{Db, new_id, now_ms};
use crate::tasks::Task;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Clone, Debug)]
pub struct Pending {
    pub id: String,
    pub conversation_id: String,
    pub conversation_title: String,
    pub server: String,
    pub tool: String,
    pub arguments: Value,
    pub model: Option<String>,
    pub status: String,
    pub result: Option<String>,
    pub created_at: i64,
}

impl Db {
    pub fn add_pending(&self, conversation_id: &str, server: &str, tool: &str, args: &Value, model: Option<&str>) -> anyhow::Result<String> {
        let id = new_id();
        self.conn.execute(
            "INSERT INTO pending_actions(id,conversation_id,server,tool,arguments,model,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,'pending',?7)",
            params![id, conversation_id, server, tool, args.to_string(), model, now_ms()],
        )?;
        Ok(id)
    }

    fn pending_rows(&self, filter: &str, arg: Option<&str>) -> anyhow::Result<Vec<Pending>> {
        let sql = format!(
            "SELECT p.id,p.conversation_id,COALESCE(c.title,''),p.server,p.tool,p.arguments,p.model,p.status,p.result,p.created_at
             FROM pending_actions p LEFT JOIN conversations c ON c.id = p.conversation_id {filter} ORDER BY p.created_at DESC LIMIT 200"
        );
        let mut st = self.conn.prepare(&sql)?;
        let map = |r: &rusqlite::Row| -> rusqlite::Result<Pending> {
            Ok(Pending {
                id: r.get(0)?,
                conversation_id: r.get(1)?,
                conversation_title: r.get(2)?,
                server: r.get(3)?,
                tool: r.get(4)?,
                arguments: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(Value::Null),
                model: r.get(6)?,
                status: r.get(7)?,
                result: r.get(8)?,
                created_at: r.get(9)?,
            })
        };
        let rows = match arg {
            Some(a) => st.query_map([a], map)?.collect::<rusqlite::Result<Vec<_>>>()?,
            None => st.query_map([], map)?.collect::<rusqlite::Result<Vec<_>>>()?,
        };
        Ok(rows)
    }

    /// Waiting requests first, then the latest decided ones.
    pub fn pending_actions(&self) -> anyhow::Result<Vec<Pending>> {
        let mut v = self.pending_rows("WHERE p.status = 'pending'", None)?;
        v.extend(self.pending_rows("WHERE p.status != 'pending'", None)?.into_iter().take(20));
        Ok(v)
    }

    pub fn get_pending(&self, id: &str) -> anyhow::Result<Option<Pending>> {
        Ok(self.pending_rows("WHERE p.id = ?1", Some(id))?.into_iter().next())
    }

    pub fn count_pending(&self) -> i64 {
        self.conn.query_row("SELECT count(*) FROM pending_actions WHERE status='pending'", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn decide_pending(&self, id: &str, status: &str, result: Option<&str>) -> anyhow::Result<bool> {
        Ok(self.conn.execute(
            "UPDATE pending_actions SET status=?2, result=?3, decided_at=?4 WHERE id=?1 AND status='pending'",
            params![id, status, result, now_ms()],
        )? == 1)
    }
}

/// What the assistant reads after the user decides.
pub fn decision_prompt(p: &Pending, ran: bool, result: &str) -> String {
    format!(
        "I approved the waiting action {} › {}. It {}. Result:\n```\n{}\n```\nContinue the task.",
        p.server,
        p.tool,
        if ran { "ran" } else { "failed" },
        result.chars().take(4000).collect::<String>()
    )
}

// ---------- proactive assistant

const BRIEF: &str = "This is my morning brief. Using my connected tools (mail, calendar, messages, tasks, files: whatever is \
available), tell me what is new since yesterday and what needs my attention today, most important first, and propose concrete \
next actions. Read freely. When an action would change something (send, reply, schedule, buy, delete), call the tool: it waits \
for my approval in the inbox, so say which actions are waiting.";
const CHECK_IN: &str = "Check my connected apps for anything new since the last check-in that needs my attention. If nothing does, \
reply exactly: Nothing new. Otherwise list the items briefly and propose next actions; tool calls that change something wait for \
my approval in the inbox.";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Proactive {
    pub enabled: bool,
    /// "HH:MM", local time.
    pub brief_at: String,
    /// 0 = no check-ins.
    pub every_hours: u32,
    pub model: String,
}

fn ids(db: &Db) -> (Option<String>, Option<String>) {
    let v: Value = db.get_setting("proactive_tasks").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    (v["brief"].as_str().map(str::to_string), v["check_in"].as_str().map(str::to_string))
}

pub fn get(db: &Db) -> anyhow::Result<Proactive> {
    let (b, c) = ids(db);
    let brief = b.and_then(|id| db.task(&id).ok().flatten());
    let check = c.and_then(|id| db.task(&id).ok().flatten());
    Ok(Proactive {
        enabled: brief.as_ref().is_some_and(|t| t.enabled),
        brief_at: brief.as_ref().and_then(|t| t.schedule.strip_prefix("daily:").map(str::to_string)).unwrap_or_else(|| "08:00".into()),
        every_hours: check.as_ref().filter(|t| t.enabled).and_then(|t| t.schedule.strip_prefix("every:")?.parse::<u32>().ok()).map(|m| m / 60).unwrap_or(3),
        model: brief.map(|t| t.model).or_else(|| db.get_setting("default_model")).unwrap_or_default(),
    })
}

/// Creates or updates the two tasks behind the proactive assistant.
pub fn set(db: &Db, p: &Proactive) -> anyhow::Result<()> {
    if p.enabled && p.model.trim().is_empty() {
        anyhow::bail!("choose a model for the proactive assistant");
    }
    if !crate::tasks::valid_schedule(&format!("daily:{}", p.brief_at)) {
        anyhow::bail!("brief time must be HH:MM");
    }
    let (b, c) = ids(db);
    let mut brief = Task {
        id: b.unwrap_or_default(),
        title: "Morning brief".into(),
        prompt: BRIEF.into(),
        model: p.model.clone(),
        schedule: format!("daily:{}", p.brief_at),
        enabled: p.enabled,
        ..Default::default()
    };
    db.save_task(&mut brief)?;
    let hours = p.every_hours.clamp(1, 24);
    let mut check = Task {
        id: c.unwrap_or_default(),
        title: "Check-in".into(),
        prompt: CHECK_IN.into(),
        model: p.model.clone(),
        schedule: format!("every:{}", hours * 60),
        enabled: p.enabled && p.every_hours > 0,
        ..Default::default()
    };
    db.save_task(&mut check)?;
    db.set_setting("proactive_tasks", &serde_json::json!({"brief": brief.id, "check_in": check.id}).to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pending_lifecycle() {
        let db = Db::open_in_memory().unwrap();
        let c = db.create_conversation(None, Some("m")).unwrap();
        let id = db.add_pending(&c.id, "mail", "send_email", &json!({"to": "a@b.c"}), Some("m")).unwrap();
        assert_eq!(db.count_pending(), 1);
        let p = db.get_pending(&id).unwrap().unwrap();
        assert_eq!((p.tool.as_str(), p.arguments["to"].as_str(), p.conversation_title.as_str()), ("send_email", Some("a@b.c"), "New chat"));
        assert!(db.decide_pending(&id, "done", Some("sent")).unwrap());
        assert!(!db.decide_pending(&id, "denied", None).unwrap(), "decided once");
        assert_eq!(db.count_pending(), 0);
        assert_eq!(db.pending_actions().unwrap()[0].status, "done");
        assert!(decision_prompt(&p, true, "sent").contains("Continue the task"));
        // deleting the chat removes its requests
        db.delete_conversation(&c.id).unwrap();
        assert!(db.get_pending(&id).unwrap().is_none());
    }

    #[test]
    fn proactive_assistant_creates_and_updates_two_tasks() {
        let db = Db::open_in_memory().unwrap();
        assert!(!get(&db).unwrap().enabled);
        set(&db, &Proactive { enabled: true, brief_at: "07:30".into(), every_hours: 2, model: "m".into() }).unwrap();
        let p = get(&db).unwrap();
        assert_eq!(p, Proactive { enabled: true, brief_at: "07:30".into(), every_hours: 2, model: "m".into() });
        let tasks = db.tasks().unwrap();
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().any(|t| t.schedule == "every:120" && t.enabled) && tasks.iter().any(|t| t.schedule == "daily:07:30"));
        set(&db, &Proactive { enabled: false, ..p }).unwrap();
        assert_eq!(db.tasks().unwrap().len(), 2, "updated in place");
        assert!(db.tasks().unwrap().iter().all(|t| !t.enabled));
        assert!(set(&db, &Proactive { enabled: true, brief_at: "25:00".into(), every_hours: 2, model: "m".into() }).is_err());
    }
}
