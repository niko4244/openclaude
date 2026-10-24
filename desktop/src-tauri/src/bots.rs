//! Persistent bots (the "roster" shape): each bot gets a persona, its own memory,
//! a model, a folder, and one continuing thread.
//!
//! The thread is an ordinary conversation, so history, branching, export, search
//! and the approvals inbox keep working unchanged. What makes it a bot is the
//! stable conversation link and the prompt block below, which is added to the
//! system prompt for that conversation only. Nothing here runs automatically.
use crate::db::{new_id, now_ms, Db};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub persona: String,
    pub memory: String,
    pub model: Option<String>,
    /// Preferred folder. It is context for the model, not a granted workspace:
    /// the existing folder grant and the approvals inbox still decide what runs.
    pub workspace: Option<String>,
    pub conversation_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Bot> {
    Ok(Bot {
        id: r.get(0)?,
        name: r.get(1)?,
        persona: r.get(2)?,
        memory: r.get(3)?,
        model: r.get(4)?,
        workspace: r.get(5)?,
        conversation_id: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

impl Db {
    pub fn bots(&self) -> anyhow::Result<Vec<Bot>> {
        let mut st = self.conn.prepare(
            "SELECT id,name,persona,memory,model,workspace,conversation_id,created_at,updated_at
             FROM bots ORDER BY name COLLATE NOCASE",
        )?;
        Ok(st.query_map([], row)?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_bot(&self, id: &str) -> anyhow::Result<Option<Bot>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id,name,persona,memory,model,workspace,conversation_id,created_at,updated_at FROM bots WHERE id=?1",
                [id],
                row,
            )
            .optional()?)
    }

    /// Insert when the id is empty, otherwise update. Unknown keys never invented.
    pub fn save_bot(&self, bot: &mut Bot) -> anyhow::Result<()> {
        if bot.name.trim().is_empty() {
            anyhow::bail!("a bot needs a name");
        }
        bot.name = bot.name.trim().to_string();
        bot.updated_at = now_ms();
        if bot.id.trim().is_empty() {
            bot.id = new_id();
            bot.created_at = bot.updated_at;
            self.conn.execute(
                "INSERT INTO bots(id,name,persona,memory,model,workspace,conversation_id,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)",
                params![
                    bot.id,
                    bot.name,
                    bot.persona,
                    bot.memory,
                    bot.model,
                    bot.workspace,
                    bot.conversation_id,
                    bot.created_at
                ],
            )?;
        } else {
            let n = self.conn.execute(
                "UPDATE bots SET name=?2,persona=?3,memory=?4,model=?5,workspace=?6,conversation_id=?7,updated_at=?8 WHERE id=?1",
                params![
                    bot.id,
                    bot.name,
                    bot.persona,
                    bot.memory,
                    bot.model,
                    bot.workspace,
                    bot.conversation_id,
                    bot.updated_at
                ],
            )?;
            if n == 0 {
                anyhow::bail!("unknown bot");
            }
        }
        Ok(())
    }

    /// The bot's chat is kept: it is a normal conversation in Chats afterwards.
    pub fn delete_bot(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM bots WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn bot_for_conversation(&self, conversation_id: &str) -> Option<Bot> {
        self.conn
            .query_row(
                "SELECT id,name,persona,memory,model,workspace,conversation_id,created_at,updated_at
                 FROM bots WHERE conversation_id=?1",
                [conversation_id],
                row,
            )
            .optional()
            .ok()
            .flatten()
    }
}

/// The block added to this conversation's system prompt. It states the persona and
/// memory as context, and repeats the two rules that keep a bot honest: no invented
/// actions, and risky actions still go through approvals.
pub fn prompt_block(bot: &Bot) -> String {
    let mut s = format!(
        "You are {}, one of the user's persistent bots in OpenClaude Desktop.\n\nPersona:\n{}",
        bot.name,
        bot.persona.trim()
    );
    if !bot.memory.trim().is_empty() {
        s.push_str(&format!(
            "\n\nWhat you remember with this user (use it; do not invent more):\n{}",
            bot.memory.trim()
        ));
    }
    if let Some(w) = bot.workspace.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        s.push_str(&format!(
            "\n\nThe user keeps this bot's files in {w}. Treat it as the working folder; ask before changing anything outside it."
        ));
    }
    s.push_str(
        "\n\nStay in character. Never claim an action you did not take. Anything that needs permission waits in the approvals inbox.",
    );
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bot(name: &str) -> Bot {
        Bot {
            id: String::new(),
            name: name.into(),
            persona: "Dry, precise, no filler.".into(),
            memory: "Prefers short answers.".into(),
            model: Some("stub::stub-model".into()),
            workspace: Some("C:/tmp/bot-work".into()),
            conversation_id: None,
            ..Default::default()
        }
    }

    #[test]
    fn bots_save_list_update_and_delete() {
        let db = Db::open_in_memory().unwrap();
        let mut b = bot("Ada");
        db.save_bot(&mut b).unwrap();
        assert!(!b.id.is_empty() && b.created_at > 0);
        assert_eq!(db.bots().unwrap().len(), 1);

        let mut again = b.clone();
        again.memory = "Remembers the release checklist.".into();
        let created = b.created_at;
        db.save_bot(&mut again).unwrap();
        let read = db.get_bot(&b.id).unwrap().unwrap();
        assert_eq!(read.memory, "Remembers the release checklist.");
        assert_eq!(read.created_at, created, "update keeps created_at");
        assert_eq!(db.bots().unwrap().len(), 1, "update, not a second row");

        db.delete_bot(&b.id).unwrap();
        assert!(db.get_bot(&b.id).unwrap().is_none());
    }

    #[test]
    fn a_conversation_maps_back_to_its_bot() {
        let db = Db::open_in_memory().unwrap();
        let c = db.create_conversation(None, None).unwrap();
        let mut b = bot("Ada");
        b.conversation_id = Some(c.id.clone());
        db.save_bot(&mut b).unwrap();
        let found = db.bot_for_conversation(&c.id).expect("linked");
        assert_eq!((found.id.as_str(), found.name.as_str()), (b.id.as_str(), "Ada"));
        assert!(db.bot_for_conversation("nope").is_none());
    }

    #[test]
    fn a_bot_needs_a_name_and_an_unknown_id_is_rejected() {
        let db = Db::open_in_memory().unwrap();
        let mut nameless = bot("  ");
        assert!(db.save_bot(&mut nameless).is_err());
        let mut ghost = bot("Ghost");
        ghost.id = "does-not-exist".into();
        assert!(db.save_bot(&mut ghost).is_err());
    }

    #[test]
    fn the_prompt_block_carries_persona_memory_and_folder() {
        let text = prompt_block(&bot("Ada"));
        assert!(text.contains("You are Ada"));
        assert!(text.contains("Dry, precise, no filler."));
        assert!(text.contains("Prefers short answers."));
        assert!(text.contains("C:/tmp/bot-work"));
        assert!(text.contains("Never claim an action you did not take"));

        let mut blank = bot("Ada");
        blank.memory = "   ".into();
        blank.workspace = None;
        let text = prompt_block(&blank);
        assert!(!text.contains("What you remember"), "empty memory is omitted");
        assert!(!text.contains("working folder"), "no folder, no folder line");
    }

    #[test]
    fn a_bot_thread_is_a_normal_conversation() {
        let db = Db::open_in_memory().unwrap();
        let mut b = bot("Ada");
        db.save_bot(&mut b).unwrap();
        let c = db.create_conversation(None, b.model.as_deref()).unwrap();
        let mut link = b.clone();
        link.conversation_id = Some(c.id.clone());
        db.save_bot(&mut link).unwrap();
        // history works like any chat
        let mut m = crate::db::Message {
            conversation_id: c.id.clone(),
            role: "user".into(),
            content: json!("hi"),
            ..Default::default()
        };
        db.insert_message(&mut m).unwrap();
        assert_eq!(db.messages(&c.id).unwrap().len(), 1);
        assert_eq!(db.get_conversation(&c.id).unwrap().unwrap().model.as_deref(), Some("stub::stub-model"));
    }
}
