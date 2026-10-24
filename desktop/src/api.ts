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
  /** Granted folder for Cowork-style runs (coding agent; in-folder edits allowed, other approvals denied). */
  workspace?: string | null;
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
export type RegistryEntry = {
  name: string;
  title: string | null;
  description: string;
  version: string | null;
  website: string | null;
  remotes: { kind: string; url: string }[];
  packages: { registry: string; identifier: string; version: string | null; required_env: string[] }[];
};
export type RegistryPage = { entries: RegistryEntry[]; next_cursor: string | null };
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
  registrySearch: (query: string | null, cursor: string | null) => invoke<RegistryPage>("registry_search", { query, cursor }),

  pluginsList: () => invoke<PluginView[]>("plugins_list"),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  providerPresets: () => invoke<ProviderPreset[]>("provider_presets"),
  reportError: (message: string, detail: string) => invoke<void>("report_error", { message, detail }),
  diagnostics: () => invoke<{ groups: ErrorGroup[]; source_repo: string | null; version: string }>("diagnostics"),
  clearErrors: () => invoke<void>("clear_errors"),
  selfTest: () => invoke<{ name: string; ok: boolean; detail: string }[]>("self_test"),
  diagFix: (fingerprint: string) => invoke<[string, string]>("diag_fix", { fingerprint }),
  diagReport: (fingerprint: string) => invoke<void>("diag_report", { fingerprint }),
  diagPickRepo: () => invoke<string | null>("diag_pick_repo"),
  providersList: () => invoke<ProviderView[]>("providers_list"),
  providerSave: (provider: ProviderConfig, apiKey: string | null) => invoke<void>("provider_save", { provider, apiKey }),
  providerRemove: (id: string) => invoke<void>("provider_remove", { id }),
  devicesInfo: () => invoke<DeviceInventory>("devices_info"),
  deviceBoot: (avd: string) => invoke<void>("device_boot", { avd }),
  deviceCreate: (name: string, image: string, device: string) => invoke<void>("device_create", { name, image, device }),
  syncNow: () => invoke<SyncStatus>("sync_now"),
  syncChooseFolder: () => invoke<SyncStatus>("sync_choose_folder"),
  syncOff: () => invoke<SyncStatus>("sync_off"),
  pluginInspect: (spec: string) => invoke<PluginOffer>("plugin_inspect", { spec }),
  pluginInstall: (spec: string, names: string[]) => invoke<string[]>("plugin_install", { spec, names }),
  pluginRemove: (id: string) => invoke<void>("plugin_remove", { id }),
  pluginSet: (id: string, p: { enabled?: boolean; autoUpdate?: boolean; hooks?: boolean }) =>
    invoke<void>("plugin_set", { id, enabled: p.enabled ?? null, autoUpdate: p.autoUpdate ?? null, hooks: p.hooks ?? null }),
  pluginUpdate: (id: string) => invoke<boolean | null>("plugin_update", { id }),
  pluginRollback: (id: string) => invoke<void>("plugin_rollback", { id }),
  pluginsUpdateAll: () => invoke<string[]>("plugins_update_all"),
  pluginsImportCandidates: () => invoke<PluginCandidate[]>("plugins_import_candidates"),
  pluginsImport: (keys: string[]) => invoke<string[]>("plugins_import", { keys }),
  pluginContextPreview: () => invoke<string>("plugin_context_preview"),
  slashCommands: () => invoke<SlashCommand[]>("slash_commands"),
  slashExpand: (name: string, args: string) => invoke<string>("slash_expand", { name, args }),

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

export type PluginSource =
  | { kind: "git"; url: string; git_ref?: string; subdir?: string; marketplace?: string }
  | { kind: "local"; path: string; origin: string };
export type PluginView = {
  id: string;
  name: string;
  description: string;
  version: string | null;
  source: PluginSource;
  root: string;
  repo_dir: string | null;
  enabled: boolean;
  auto_update: boolean;
  hooks: boolean;
  user_scope: boolean;
  sha: string | null;
  prev_sha: string | null;
  updated_at: number;
  checked_at: number;
  error: string | null;
  mcp_servers: string[];
  skills: number;
  commands: number;
  agents: number;
  hook_commands: number;
};
export type PluginOffer = { repo: string; marketplace: string | null; items: { name: string; description: string; source: PluginSource | null; note: string | null }[] };
export type PluginCandidate = { key: string; name: string; origin: string; local: string; github: PluginSource | null; user_scope: boolean; imported: boolean };
export type SlashCommand = { kind: "skill" | "command" | "agent"; name: string; plugin: string; description: string; arg_hint: string | null; path: string };
export type SyncStatus = { folder: string | null; device_name: string; last_at: number; devices: string[]; error: string | null };
export type DeviceInventory = {
  sdk: { adb: string; emulator: string | null; avdmanager: string | null; root: string | null } | null;
  devices: { serial: string; state: string; model: string | null; emulator: boolean }[];
  avds: string[];
  images: string[];
};
export type ProviderPreset = { id: string; name: string; base_url: string; needs_key: boolean };
export type ProviderConfig = { id: string; name: string; base_url: string; preset: string | null; enabled: boolean };
export type ProviderView = ProviderConfig & { has_key: boolean; models: number; status: GatewayStatus | null };
export type ErrorGroup = { fingerprint: string; kind: string; message: string; count: number; first_at: number; last_at: number; detail: string };
