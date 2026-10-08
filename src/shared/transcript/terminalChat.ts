import type { AgentSlug } from '../agentIdentity';

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
    /** Image paths pasted before the prompt become attachments (Claude Code). */
    images?: boolean;
    /** A prompt sent mid-turn is queued by the agent's own composer (Claude Code). */
    queue?: boolean;
  };
}

// TODO(#1904): launching from the phone/web is built for these two agents'
// flags only; opening it to every registry row needs per-row launch modes.
export type TerminalLaunchAgent = Extract<AgentSlug, 'claude' | 'codex'>;
export type TerminalLaunchMode = 'default' | 'bypass' | 'yolo';
export function validTerminalLaunchMode(agent: unknown, mode: unknown): boolean {
  return mode === undefined || mode === 'default' || agent === 'claude' && mode === 'bypass' || agent === 'codex' && mode === 'yolo';
}
