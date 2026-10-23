import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ChatEvent, type ContentPart, type Message } from "./api";

export type Approval = { request_id: string; tool: string; server: string; arguments: unknown };

export type LiveRun = {
  runId: string | null;
  text: string;
  reasoning: string;
  toolNames: string[];
  approvals: Approval[];
  error: string | null;
};

const emptyRun = (): LiveRun => ({ runId: null, text: "", reasoning: "", toolNames: [], approvals: [], error: null });

/**
 * Chat state for the open conversation. Runs keep going in the backend when the
 * user switches away; everything is persisted there, so we just reload.
 */
export function useChat(conversationId: string | null, onTurnFinished: () => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Record<string, LiveRun>>({});
  const convRef = useRef(conversationId);
  convRef.current = conversationId;

  const reload = useCallback(async (cid: string) => {
    const ms = await api.getMessages(cid);
    if (convRef.current === cid) setMessages(ms);
  }, []);

  useEffect(() => {
    if (conversationId) void reload(conversationId);
    else setMessages([]);
  }, [conversationId, reload]);

  const patch = (cid: string, f: (r: LiveRun) => LiveRun) => setRuns((rs) => ({ ...rs, [cid]: f(rs[cid] ?? emptyRun()) }));

  const send = useCallback(
    async (cid: string, content: string | ContentPart[] | null, model: string, replaceFrom: string | null = null) => {
      patch(cid, () => ({ ...emptyRun(), runId: "pending" }));
      if (replaceFrom && convRef.current === cid) {
        setMessages((ms) => {
          const i = ms.findIndex((m) => m.id === replaceFrom);
          return i >= 0 ? ms.slice(0, i) : ms;
        });
      }
      const onEvent = (e: ChatEvent) => {
        switch (e.type) {
          case "started":
            patch(cid, (r) => ({ ...r, runId: e.run_id }));
            break;
          case "user_message":
          case "tool_result":
            if (convRef.current === cid) setMessages((ms) => [...ms, e.message]);
            break;
          case "text":
            patch(cid, (r) => ({ ...r, text: r.text + e.text }));
            break;
          case "reasoning":
            patch(cid, (r) => ({ ...r, reasoning: r.reasoning + e.text }));
            break;
          case "tool_call_delta":
            if (e.name) patch(cid, (r) => ({ ...r, toolNames: [...r.toolNames, e.name!] }));
            break;
          case "assistant_message":
            if (convRef.current === cid) setMessages((ms) => [...ms, e.message]);
            patch(cid, (r) => ({ ...r, text: "", reasoning: "", toolNames: [] }));
            break;
          case "tool_approval":
            patch(cid, (r) => ({ ...r, approvals: [...r.approvals, e] }));
            break;
          case "error":
            patch(cid, (r) => ({ ...r, error: e.message }));
            break;
          case "done":
            setRuns((rs) => {
              const r = rs[cid];
              const next = { ...rs };
              if (r?.error) next[cid] = { ...emptyRun(), error: r.error };
              else delete next[cid];
              return next;
            });
            void reload(cid);
            onTurnFinished();
            break;
        }
      };
      try {
        await api.chatSend(cid, content, model, replaceFrom, onEvent);
      } catch (err) {
        patch(cid, () => ({ ...emptyRun(), error: String(err) }));
      }
    },
    [reload, onTurnFinished],
  );

  const stop = useCallback(async (cid: string) => {
    const r = runs[cid];
    if (r?.runId && r.runId !== "pending") await api.chatCancel(r.runId);
  }, [runs]);

  const decide = useCallback(async (cid: string, a: Approval, allow: boolean, scope: "once" | "chat" | "always") => {
    await api.toolDecision(a.request_id, allow, scope);
    patch(cid, (r) => ({ ...r, approvals: r.approvals.filter((x) => x.request_id !== a.request_id) }));
  }, []);

  const live = conversationId ? runs[conversationId] : undefined;
  const busy = !!live?.runId;
  return { messages, live, busy, send, stop, decide, reload, clearError: (cid: string) => patch(cid, (r) => ({ ...r, error: null })) };
}
