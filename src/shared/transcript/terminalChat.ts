/** A chat surface is a projection of an existing terminal conversation.
 * Optional ACP/managed conversations must not impersonate this binding.
 * Adding a provider requires an identity source and a reader; safe input is a
 * separate capability, never inferred from the provider name or available text.
 */
export interface TerminalChatBinding {
  kind: 'terminal';
  agent: string;
  nativeSessionId: string;
  historyTruncated?: boolean;
  capabilities: {
    history: boolean;
    send: boolean;
    /** Approval remains on the terminal unless a native interaction adapter owns it. */
    permissions: boolean;
    cancel: boolean;
    fileUndo: boolean;
  };
}

export type TerminalLaunchAgent = 'claude' | 'codex';
export type TerminalLaunchMode = 'default' | 'bypass' | 'yolo';
export function validTerminalLaunchMode(agent: unknown, mode: unknown): boolean {
  return mode === undefined || mode === 'default' || agent === 'claude' && mode === 'bypass' || agent === 'codex' && mode === 'yolo';
}
