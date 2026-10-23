//! SQLite persistence: projects, conversations, messages, settings.
//! Edits and regenerations never delete history; replaced turns are marked `superseded`.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
        default_model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE conversations(
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL, model TEXT, pinned INTEGER NOT NULL DEFAULT 0, draft TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE messages(
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT,
        tool_calls TEXT, tool_call_id TEXT, name TEXT,
        model_requested TEXT, model_served TEXT, routed_host TEXT, fallbacks TEXT,
        usage TEXT, cost REAL, status TEXT NOT NULL DEFAULT 'complete', error TEXT,
        superseded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
     CREATE INDEX messages_conv ON messages(conversation_id, seq);
     CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    // v2: lineage for branch navigation. Existing rows chain to the previous row by seq.
    "ALTER TABLE messages ADD COLUMN parent_id TEXT;
     UPDATE messages SET parent_id = (
        SELECT m2.id FROM messages m2 WHERE m2.conversation_id = messages.conversation_id AND m2.seq < messages.seq
        ORDER BY m2.seq DESC LIMIT 1);
     CREATE INDEX messages_parent ON messages(conversation_id, parent_id);",
    // v3: project knowledge files (extracted text)
    "CREATE TABLE project_files(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
     CREATE INDEX project_files_p ON project_files(project_id);",
    // v4: tasks (scheduled / background prompts)
    "CREATE TABLE tasks(
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT NOT NULL,
        schedule TEXT NOT NULL DEFAULT 'manual', enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER, last_run_at INTEGER, last_status TEXT, last_conversation_id TEXT,
        created_at INTEGER NOT NULL);",
    // v5: folder tasks (Cowork-style): run the coding agent in a granted folder
    "ALTER TABLE tasks ADD COLUMN workspace TEXT;",
];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectFile {
    pub id: String,
    pub name: String,
    pub size: i64,
    pub chars: i64,
    pub created_at: i64,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub struct Db {
    pub conn: Connection,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub default_model: Option<String>,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Conversation {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub model: Option<String>,
    pub pinned: bool,
    pub draft: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub seq: i64,
    pub role: String,
    /// String or OpenAI content-part array.
    pub content: Value,
    pub reasoning: Option<String>,
    pub tool_calls: Option<Value>,
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
    pub model_requested: Option<String>,
    pub model_served: Option<String>,
    pub routed_host: Option<String>,
    pub fallbacks: Option<String>,
    pub usage: Option<Value>,
    pub cost: Option<f64>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Alternatives at this point in the conversation (edits / regenerations), oldest first.
    #[serde(default)]
    pub sibling_ids: Vec<String>,
}

fn parse_json(s: Option<String>) -> Option<Value> {
    s.and_then(|s| serde_json::from_str(&s).ok())
}

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> anyhow::Result<Self> {
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")?;
        let mut db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&mut self) -> anyhow::Result<()> {
        let version: i64 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
            tx.commit()?;
        }
        Ok(())
    }

    // ---- settings
    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }
    pub fn set_setting(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn settings_with_prefix(&self, prefix: &str) -> anyhow::Result<Vec<(String, String)>> {
        let mut st = self.conn.prepare("SELECT key, value FROM settings WHERE substr(key, 1, length(?1)) = ?1")?;
        let rows = st.query_map([prefix], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // ---- projects
    pub fn list_projects(&self) -> anyhow::Result<Vec<Project>> {
        let mut st = self
            .conn
            .prepare("SELECT id,name,instructions,default_model,updated_at FROM projects ORDER BY updated_at DESC")?;
        let rows = st.query_map([], |r| {
            Ok(Project { id: r.get(0)?, name: r.get(1)?, instructions: r.get(2)?, default_model: r.get(3)?, updated_at: r.get(4)? })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
    pub fn upsert_project(&self, p: &Project) -> anyhow::Result<()> {
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO projects(id,name,instructions,default_model,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, instructions=excluded.instructions,
             default_model=excluded.default_model, updated_at=excluded.updated_at",
            params![p.id, p.name, p.instructions, p.default_model, now],
        )?;
        Ok(())
    }
    pub fn get_project(&self, id: &str) -> anyhow::Result<Option<Project>> {
        Ok(self.list_projects()?.into_iter().find(|p| p.id == id))
    }
    pub fn add_project_file(&self, project_id: &str, name: &str, text: &str, size: i64) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO project_files(id,project_id,name,text,size,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![new_id(), project_id, name, text, size, now_ms()],
        )?;
        Ok(())
    }
    pub fn project_files(&self, project_id: &str) -> anyhow::Result<Vec<ProjectFile>> {
        let mut st = self.conn.prepare(
            "SELECT id,name,size,length(text),created_at FROM project_files WHERE project_id=?1 ORDER BY created_at",
        )?;
        let rows = st.query_map([project_id], |r| {
            Ok(ProjectFile { id: r.get(0)?, name: r.get(1)?, size: r.get(2)?, chars: r.get(3)?, created_at: r.get(4)? })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
    pub fn project_docs(&self, project_id: &str) -> anyhow::Result<Vec<crate::knowledge::Doc>> {
        let mut st = self.conn.prepare("SELECT name,text FROM project_files WHERE project_id=?1 ORDER BY created_at")?;
        let rows = st.query_map([project_id], |r| Ok(crate::knowledge::Doc { name: r.get(0)?, text: r.get(1)? }))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
    pub fn remove_project_file(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM project_files WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn delete_project(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM projects WHERE id=?1", [id])?;
        Ok(())
    }

    // ---- conversations
    fn conv_row(r: &rusqlite::Row) -> rusqlite::Result<Conversation> {
        Ok(Conversation {
            id: r.get(0)?,
            project_id: r.get(1)?,
            title: r.get(2)?,
            model: r.get(3)?,
            pinned: r.get::<_, i64>(4)? != 0,
            draft: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        })
    }
    const CONV_COLS: &'static str = "id,project_id,title,model,pinned,draft,created_at,updated_at";

    pub fn list_conversations(&self, query: Option<&str>, project_id: Option<&str>) -> anyhow::Result<Vec<Conversation>> {
        let q = query.map(|q| format!("%{}%", q.replace('%', "\\%").replace('_', "\\_")));
        let sql = format!(
            "SELECT {} FROM conversations c WHERE (?1 IS NULL OR c.project_id = ?1)
             AND (?2 IS NULL OR c.title LIKE ?2 ESCAPE '\\' OR EXISTS(
                SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ?2 ESCAPE '\\'))
             ORDER BY pinned DESC, updated_at DESC LIMIT 500",
            Self::CONV_COLS
        );
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(params![project_id, q], Self::conv_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
    pub fn get_conversation(&self, id: &str) -> anyhow::Result<Option<Conversation>> {
        let sql = format!("SELECT {} FROM conversations WHERE id=?1", Self::CONV_COLS);
        Ok(self.conn.query_row(&sql, [id], Self::conv_row).optional()?)
    }
    pub fn create_conversation(&self, project_id: Option<&str>, model: Option<&str>) -> anyhow::Result<Conversation> {
        let id = new_id();
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO conversations(id,project_id,title,model,created_at,updated_at) VALUES(?1,?2,'New chat',?3,?4,?4)",
            params![id, project_id, model, now],
        )?;
        Ok(self.get_conversation(&id)?.expect("just inserted"))
    }
    pub fn update_conversation(&self, c: &Conversation) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE conversations SET project_id=?2,title=?3,model=?4,pinned=?5,draft=?6 WHERE id=?1",
            params![c.id, c.project_id, c.title, c.model, c.pinned as i64, c.draft],
        )?;
        Ok(())
    }
    pub fn touch_conversation(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("UPDATE conversations SET updated_at=?2 WHERE id=?1", params![id, now_ms()])?;
        Ok(())
    }
    pub fn delete_conversation(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM conversations WHERE id=?1", [id])?;
        Ok(())
    }

    // ---- messages
    pub fn messages(&self, conversation_id: &str) -> anyhow::Result<Vec<Message>> {
        let mut st = self.conn.prepare(
            "SELECT id,conversation_id,seq,role,content,reasoning,tool_calls,tool_call_id,name,model_requested,
                    model_served,routed_host,fallbacks,usage,cost,status,error,created_at,parent_id
             FROM messages WHERE conversation_id=?1 AND superseded=0 ORDER BY seq",
        )?;
        let rows = st.query_map([conversation_id], |r| {
            let content: String = r.get(4)?;
            Ok(Message {
                id: r.get(0)?,
                conversation_id: r.get(1)?,
                seq: r.get(2)?,
                role: r.get(3)?,
                content: serde_json::from_str(&content).unwrap_or(Value::String(content)),
                reasoning: r.get(5)?,
                tool_calls: parse_json(r.get(6)?),
                tool_call_id: r.get(7)?,
                name: r.get(8)?,
                model_requested: r.get(9)?,
                model_served: r.get(10)?,
                routed_host: r.get(11)?,
                fallbacks: r.get(12)?,
                usage: parse_json(r.get(13)?),
                cost: r.get(14)?,
                status: r.get(15)?,
                error: r.get(16)?,
                created_at: r.get(17)?,
                parent_id: r.get(18)?,
                sibling_ids: vec![],
            })
        })?;
        let mut out: Vec<Message> = rows.collect::<Result<_, _>>()?;
        // Siblings share parent and role. Only user/assistant turns are navigable.
        let mut st = self.conn.prepare(
            "SELECT id, parent_id, role FROM messages WHERE conversation_id=?1 AND role IN ('user','assistant') ORDER BY created_at, seq",
        )?;
        let all: Vec<(String, Option<String>, String)> =
            st.query_map([conversation_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
        for m in out.iter_mut().filter(|m| m.role == "user" || m.role == "assistant") {
            let sibs: Vec<String> = all.iter().filter(|(_, p, r)| *p == m.parent_id && *r == m.role).map(|(id, _, _)| id.clone()).collect();
            if sibs.len() > 1 {
                m.sibling_ids = sibs;
            }
        }
        Ok(out)
    }

    /// Show another version of a turn: hide the current branch from that point and
    /// restore the chosen sibling with its most recent continuation.
    pub fn switch_branch(&self, conversation_id: &str, target_id: &str) -> anyhow::Result<()> {
        let (parent, role): (Option<String>, String) = self.conn.query_row(
            "SELECT parent_id, role FROM messages WHERE id=?1 AND conversation_id=?2",
            params![target_id, conversation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let current: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM messages WHERE conversation_id=?1 AND superseded=0 AND role=?2 AND parent_id IS ?3 ORDER BY seq LIMIT 1",
                params![conversation_id, role, parent],
                |r| r.get(0),
            )
            .optional()?;
        if current.as_deref() == Some(target_id) {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        if let Some(cur) = &current {
            tx.execute(
                "UPDATE messages SET superseded=1 WHERE conversation_id=?1 AND seq >= (SELECT seq FROM messages WHERE id=?2)",
                params![conversation_id, cur],
            )?;
        }
        let mut node = target_id.to_string();
        loop {
            tx.execute("UPDATE messages SET superseded=0 WHERE id=?1", [&node])?;
            let next: Option<String> = tx
                .query_row(
                    "SELECT id FROM messages WHERE conversation_id=?1 AND parent_id=?2 ORDER BY created_at DESC, seq DESC LIMIT 1",
                    params![conversation_id, node],
                    |r| r.get(0),
                )
                .optional()?;
            match next {
                Some(n) => node = n,
                None => break,
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn insert_message(&self, m: &mut Message) -> anyhow::Result<()> {
        if m.id.is_empty() {
            m.id = new_id();
        }
        m.created_at = now_ms();
        m.seq = self.conn.query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE conversation_id=?1",
            [&m.conversation_id],
            |r| r.get(0),
        )?;
        if m.status.is_empty() {
            m.status = "complete".into();
        }
        m.parent_id = self
            .conn
            .query_row(
                "SELECT id FROM messages WHERE conversation_id=?1 AND superseded=0 ORDER BY seq DESC LIMIT 1",
                [&m.conversation_id],
                |r| r.get(0),
            )
            .optional()?;
        self.conn.execute(
            "INSERT INTO messages(id,conversation_id,seq,role,content,reasoning,tool_calls,tool_call_id,name,
               model_requested,model_served,routed_host,fallbacks,usage,cost,status,error,created_at,parent_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            params![
                m.id, m.conversation_id, m.seq, m.role, m.content.to_string(), m.reasoning,
                m.tool_calls.as_ref().map(|v| v.to_string()), m.tool_call_id, m.name,
                m.model_requested, m.model_served, m.routed_host, m.fallbacks,
                m.usage.as_ref().map(|v| v.to_string()), m.cost, m.status, m.error, m.created_at, m.parent_id
            ],
        )?;
        self.touch_conversation(&m.conversation_id)?;
        Ok(())
    }

    /// Hide `message_id` and everything after it (kept on disk, not deleted).
    pub fn supersede_from(&self, conversation_id: &str, message_id: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE messages SET superseded=1 WHERE conversation_id=?1 AND seq >= (SELECT seq FROM messages WHERE id=?2)",
            params![conversation_id, message_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_crud_and_supersede() {
        let db = Db::open_in_memory().unwrap();
        let c = db.create_conversation(None, Some("qwen-local")).unwrap();
        for (role, text) in [("user", "hi"), ("assistant", "hello"), ("user", "again"), ("assistant", "yes")] {
            let mut m = Message { conversation_id: c.id.clone(), role: role.into(), content: Value::String(text.into()), ..Default::default() };
            db.insert_message(&mut m).unwrap();
        }
        let msgs = db.messages(&c.id).unwrap();
        assert_eq!(msgs.len(), 4);
        db.supersede_from(&c.id, &msgs[2].id).unwrap();
        assert_eq!(db.messages(&c.id).unwrap().len(), 2);
        let n: i64 = db.conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4, "superseded turns stay on disk");
        assert_eq!(db.list_conversations(Some("again"), None).unwrap().len(), 1);
        assert_eq!(db.list_conversations(Some("nomatch"), None).unwrap().len(), 0);
    }

    #[test]
    fn branches_regenerate_edit_and_switch() {
        let db = Db::open_in_memory().unwrap();
        let c = db.create_conversation(None, None).unwrap();
        let add = |role: &str, text: &str| {
            let mut m = Message { conversation_id: c.id.clone(), role: role.into(), content: Value::String(text.into()), ..Default::default() };
            db.insert_message(&mut m).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
            m.id
        };
        let _u1 = add("user", "q1");
        let a1 = add("assistant", "a1");
        // regenerate: replace a1 with a2
        db.supersede_from(&c.id, &a1).unwrap();
        let a2 = add("assistant", "a2");
        let ms = db.messages(&c.id).unwrap();
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[1].sibling_ids, vec![a1.clone(), a2.clone()]);
        // continue on a2, then switch back to a1: a2's continuation is hidden, a1 visible
        let u2 = add("user", "q2");
        db.switch_branch(&c.id, &a1).unwrap();
        let ms = db.messages(&c.id).unwrap();
        assert_eq!(ms.iter().map(|m| m.content.as_str().unwrap()).collect::<Vec<_>>(), ["q1", "a1"]);
        // switch forward again restores a2 and its follow-up q2
        db.switch_branch(&c.id, &a2).unwrap();
        let ms = db.messages(&c.id).unwrap();
        assert_eq!(ms.iter().map(|m| m.id.clone()).collect::<Vec<_>>()[1..], [a2, u2]);
    }

    #[test]
    fn reopen_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.db");
        Db::open(&p).unwrap().set_setting("k", "v").unwrap();
        let db = Db::open(&p).unwrap();
        assert_eq!(db.get_setting("k").as_deref(), Some("v"));
    }
}
