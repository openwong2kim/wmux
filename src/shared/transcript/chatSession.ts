/** Provider-independent chat contract. No SDK types cross the IPC boundary. */
export interface ChatCapabilities {
  send: boolean;
  cancel: boolean;
  resume: boolean;
  permissions: boolean;
  questions: boolean;
  fileDiff: boolean;
  /** File undo requires a separate, conflict-aware implementation. */
  fileUndo: boolean;
  liveTerminalAttach: boolean;
}

export interface ChatProviderInfo { id: string; name: string; transport: 'codex' | 'opencode' | 'acp'; }
export interface ChatQuestion {
  id: string;
  text: string;
  options?: string[];
  multiple?: boolean;
  secret?: boolean;
}
export interface ChatInteraction {
  id: string;
  title: string;
  detail?: string;
  kind: 'permission' | 'question';
  options: { id: string; label: string }[];
  questions?: ChatQuestion[];
}
export interface ChatInteractionAnswer {
  optionId?: string;
  answers?: Record<string, string[]>;
}
export interface ManagedChatStatus {
  provider: ChatProviderInfo;
  phase: 'connecting' | 'ready' | 'running' | 'blocked' | 'disconnected' | 'unconfirmed';
  capabilities: ChatCapabilities;
  pending: ChatInteraction[];
  error?: string;
  historyTruncated?: boolean;
}
export interface ChatControlResult { ok: boolean; error?: string; }
export interface ChatControls {
  providers: () => Promise<ChatProviderInfo[]>;
  start: (args: { ptyId: string; providerId: string }) => Promise<ChatControlResult>;
  close: (args: { ptyId: string; agentSessionId: string }) => Promise<ChatControlResult>;
  reconnect: (args: { ptyId: string; agentSessionId: string }) => Promise<ChatControlResult>;
  cancel: (args: { ptyId: string; agentSessionId: string }) => Promise<ChatControlResult>;
  respond: (args: { ptyId: string; agentSessionId: string; requestId: string; answer: ChatInteractionAnswer }) => Promise<ChatControlResult>;
}
