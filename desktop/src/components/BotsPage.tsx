import { useCallback, useEffect, useState } from "react";
import { Bot as BotIcon, MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type Bot, type ModelEntry } from "../api";

const blank = (model: string | null): Bot => ({
  id: "",
  name: "",
  persona: "",
  memory: "",
  model,
  workspace: null,
  conversation_id: null,
  created_at: 0,
  updated_at: 0,
});

export function BotsPage({
  models,
  defaultModel,
  onOpenChat,
  toast,
}: {
  models: ModelEntry[];
  defaultModel: string | null;
  onOpenChat: (id: string) => void;
  toast: (m: string) => void;
}) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [draft, setDraft] = useState<Bot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBots(await api.botsList());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    try {
      const saved = await api.botSave(draft);
      setDraft(null);
      toast(`Saved ${saved.name}`);
      await load();
    } catch (e) {
      toast(`Could not save: ${e}`);
    }
  };

  const chat = async (b: Bot) => {
    try {
      const c = await api.botChat(b.id);
      await load();
      onOpenChat(c.id);
    } catch (e) {
      toast(`Could not open the chat: ${e}`);
    }
  };

  const remove = async (b: Bot) => {
    try {
      await api.botDelete(b.id);
      toast(`${b.name} deleted; its chat stays in Chats.`);
      await load();
    } catch (e) {
      toast(String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-inner" data-bots={bots?.length ?? "loading"}>
        <div className="page-head">
          <h1>Bots</h1>
          <span className="spacer" />
          <button className="btn primary" onClick={() => setDraft(blank(defaultModel))} disabled={!!draft}>
            <Plus size={15} /> New bot
          </button>
        </div>

        <p className="muted" style={{ marginTop: -4 }}>
          Persistent teammates. Each bot keeps its own persona, memory, model and folder, and one thread that continues where it
          left off. Anything that needs permission still waits in the approvals inbox.
        </p>

        {error && <div className="banner" role="alert">Could not read the bots: {error}</div>}

        {draft && (
          <div className="card" aria-label={draft.id ? `Edit ${draft.name}` : "New bot"}>
            <div className="card-head">
              <span className="name">{draft.id ? `Edit ${draft.name}` : "New bot"}</span>
            </div>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <label className="muted" htmlFor="bot-name">Name</label>
              <input id="bot-name" value={draft.name} placeholder="Ada" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <label className="muted" htmlFor="bot-persona">Persona</label>
              <textarea
                id="bot-persona"
                rows={3}
                value={draft.persona}
                placeholder="How this bot thinks and talks. Staying in character is the point."
                onChange={(e) => setDraft({ ...draft, persona: e.target.value })}
              />
              <label className="muted" htmlFor="bot-memory">Memory</label>
              <textarea
                id="bot-memory"
                rows={3}
                value={draft.memory}
                placeholder="Facts to carry between sessions: decisions, preferences, open threads."
                onChange={(e) => setDraft({ ...draft, memory: e.target.value })}
              />
              <label className="muted" htmlFor="bot-model">Model</label>
              <select id="bot-model" className="btn" value={draft.model ?? ""} onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}>
                <option value="">Default model</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                {draft.model && !models.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
              </select>
              <label className="muted" htmlFor="bot-workspace">Folder</label>
              <input
                id="bot-workspace"
                value={draft.workspace ?? ""}
                placeholder="C:\\Users\\you\\work\\ada (optional)"
                onChange={(e) => setDraft({ ...draft, workspace: e.target.value || null })}
              />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="btn primary" onClick={() => void save()} disabled={!draft.name.trim()}>Save bot</button>
              <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </div>
        )}

        {bots === null && <div className="muted">Loading bots…</div>}
        {bots?.length === 0 && !draft && (
          <div className="card">
            <div className="card-head"><span className="name">No bots yet</span><span className="badge">roster empty</span></div>
            <p className="muted">A bot is a chat with a standing brief: give it a persona and the facts it should remember, then talk to it like a contact.</p>
          </div>
        )}

        {bots?.map((b) => (
          <div key={b.id} className="card" data-bot={b.id}>
            <div className="card-head">
              <BotIcon size={16} />
              <span className="name">{b.name}</span>
              <span className="badge">{b.model ?? "default model"}</span>
              {b.memory.trim() && <span className="badge local">memory</span>}
              <span className="spacer" />
              <button className="btn" onClick={() => void chat(b)}><MessageSquare size={14} /> Chat</button>
              <button className="btn" onClick={() => setDraft(b)} aria-label={`Edit ${b.name}`}><Pencil size={14} /></button>
              <button className="btn danger" onClick={() => void remove(b)} aria-label={`Delete ${b.name}`}><Trash2 size={14} /></button>
            </div>
            {b.persona.trim() && <p className="muted">{b.persona.trim()}</p>}
            <p className="muted">
              {b.memory.trim() ? `${b.memory.trim().length} chars of memory` : "no memory yet"}
              {b.workspace ? ` · ${b.workspace}` : ""}
              {b.conversation_id ? " · one continuing thread" : " · thread starts on first chat"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
