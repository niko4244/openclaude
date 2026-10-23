// Typed bridge to the Rust backend. All privileged work happens there.
import { Channel, invoke } from "@tauri-apps/api/core";

export type ModelEntry = {
  id: string;
  provider: string;
  backend_model: string | null;
  backend_host: string | null;
  local: boolean;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  input_cost_per_mtok: number | null;
  output_cost_per_mtok: number | null;
  supports_tools: boolean | null;
  supports_vision: boolean | null;
  supports_reasoning: boolean | null;
  supports_json: boolean | null;
  mode: string | null;
  /** Results of the opt-in capability probe (live requests), keyed by check name. */
  measured?: Record<string, boolean>;
};

export type GatewayStatus = {
  reachable: boolean;
  authenticated: boolean;
  base_url: string;
  latency_ms: number | null;
  error: string | null;
};

export type Project = {
  id: string;
  name: string;
  instructions: string;
  default_model: string | null;
  updated_at: number;
};

export type ProjectFile = { id: string; name: string; size: number; chars: number; created_at: number };

export type Conversation = {
  id: string;
  project_id: string | null;
  title: string;
  model: string | null;
  pinned: boolean;
  draft: string;
  created_at: number;
  updated_at: number;
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ToolCall = { id: string; name: string; arguments: string };

export type Message = {
  id: string;
  conversation_id: string;
  seq: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string | ContentPart[];
  reasoning: string | null;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  name: string | null;
  model_requested: string | null;
  model_served: string | null;
  routed_host: string | null;
  fallbacks: string | null;
  usage: Record<string, number | null> | null;
  cost: number | null;
  status: "complete" | "cancelled" | "error";
  error: string | null;
  created_at: number;
  parent_id: string | null;
  /** Other versions of this turn (edits/regenerations), oldest first; empty when there is only one. */
  sibling_ids: string[];
};

export type ChatEvent =
  | { type: "started"; run_id: string }
  | { type: "user_message"; message: Message }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call_delta"; index: number; name: string | null }
  | { type: "assistant_message"; message: Message }
  | { type: "tool_approval"; request_id: string; tool: string; server: string; arguments: unknown }
  | { type: "tool_result"; message: Message }
  | { type: "error"; message: string }
  | { type: "done"; cancelled: boolean }
  | { type: "compacted"; summarized: number };

export type ToolDef = { name: string; description: string | null; inputSchema: unknown };
export type ServerStatus = {
  name: string;
  transport: string;
  state: "connected" | "connecting" | "error" | "stopped" | "disabled" | "auth_required";
  error: string | null;
  server_info: { name?: string; version?: string } | null;
  tools: ToolDef[];
  resources: number;
  prompts: number;
  log_tail: string[];
  disabled: boolean;
};
export type ServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  disabled?: boolean;
};
export type Task = {
  id: string;
  title: string;
  prompt: string;
  model: string;
  schedule: string;
  enabled: boolean;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_conversation_id: string | null;
  running: boolean;
};

export type ExtensionPreview = {
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: string | null;
  server_type: string;
  tools: string[];
  user_config: { key: string; kind: string; title: string; description: string | null; required: boolean; sensitive: boolean; default: unknown }[];
  signature: string;
  manifest_version: string;
};
export type ImportCandidate = { source: string; path: string; servers: Record<string, ServerConfig> };

export type ProbeReport = {
  model: string;
  at_ms: number;
  served_model: string | null;
  checks: { name: string; ok: boolean; ms: number; detail: string }[];
};

export type Attachment = {
  name: string;
  mime: string;
  kind: "image" | "text";
  text: string | null;
  data_url: string | null;
  size: number;
};
export type AttachmentResult = { Ok: Attachment } | { Err: string };

export const api = {
  gatewayStatus: () => invoke<GatewayStatus>("gateway_status"),
  listModels: (refresh = false) => invoke<ModelEntry[]>("list_models", { refresh }),
  getGatewaySettings: () => invoke<{ base_url: string; has_key: boolean }>("get_gateway_settings"),
  setGatewaySettings: (baseUrl: string, apiKey: string | null) =>
    invoke<void>("set_gateway_settings", { baseUrl, apiKey }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),

  listProjects: () => invoke<Project[]>("list_projects"),
  saveProject: (project: Project) => invoke<Project>("save_project", { project }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),
  projectFiles: (projectId: string) => invoke<ProjectFile[]>("project_files", { projectId }),
  projectAddFiles: (projectId: string) => invoke<string[]>("project_add_files", { projectId }),
  projectRemoveFile: (id: string) => invoke<void>("project_remove_file", { id }),

  listConversations: (query?: string, projectId?: string | null) =>
    invoke<Conversation[]>("list_conversations", { query: query || null, projectId: projectId ?? null }),
  createConversation: (projectId: string | null, model: string | null) =>
    invoke<Conversation>("create_conversation", { projectId, model }),
  updateConversation: (conversation: Conversation) => invoke<void>("update_conversation", { conversation }),
  deleteConversation: (id: string) => invoke<void>("delete_conversation", { id }),
  getMessages: (conversationId: string) => invoke<Message[]>("get_messages", { conversationId }),
  switchBranch: (conversationId: string, messageId: string) => invoke<void>("switch_branch", { conversationId, messageId }),

  chatSend: (
    conversationId: string,
    content: string | ContentPart[] | null,
    model: string,
    replaceFrom: string | null,
    onEvent: (e: ChatEvent) => void,
  ) => {
    const ch = new Channel<ChatEvent>();
    ch.onmessage = onEvent;
    return invoke<string>("chat_send", { conversationId, content, model, replaceFrom, onEvent: ch });
  },
  chatCancel: (runId: string) => invoke<void>("chat_cancel", { runId }),
  toolDecision: (requestId: string, allow: boolean, scope: "once" | "chat" | "always") =>
    invoke<void>("tool_decision", { requestId, allow, scope }),
  exportChat: (conversationId: string) => invoke<string | null>("export_chat", { conversationId }),

  mcpStatus: () => invoke<ServerStatus[]>("mcp_status"),
  mcpGetConfig: () => invoke<{ mcpServers: Record<string, ServerConfig> }>("mcp_get_config"),
  mcpSaveServer: (name: string, config: ServerConfig) => invoke<void>("mcp_save_server", { name, config }),
  mcpRemoveServer: (name: string) => invoke<void>("mcp_remove_server", { name }),
  mcpRestart: (name: string) => invoke<void>("mcp_restart", { name }),
  mcpAuthorize: (name: string) => invoke<void>("mcp_authorize", { name }),
  mcpSignOut: (name: string) => invoke<void>("mcp_sign_out", { name }),
  mcpImportCandidates: () => invoke<ImportCandidate[]>("mcp_import_candidates"),
  mcpImport: (path: string, names: string[]) => invoke<number>("mcp_import", { path, names }),

  tasksList: () => invoke<Task[]>("tasks_list"),
  taskSave: (task: Task) => invoke<Task>("task_save", { task }),
  taskDelete: (id: string) => invoke<void>("task_delete", { id }),
  taskRunNow: (id: string) => invoke<void>("task_run_now", { id }),
  extensionPick: () => invoke<{ token: string; preview: ExtensionPreview } | null>("extension_pick"),
  extensionInstall: (token: string, values: Record<string, string>) => invoke<string>("extension_install", { token, values }),
  pickAttachments: () => invoke<AttachmentResult[]>("pick_attachments"),
  artifactPut: (html: string) => invoke<string>("artifact_put", { html }),
  probeModel: (model: string) => invoke<ProbeReport>("probe_model", { model }),
  getProbes: () => invoke<ProbeReport[]>("get_probes"),
  appInfo: () => invoke<{ version: string; username: string; data_dir: string; mcp_config: string }>("app_info"),
};

export function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}
