import type { ChatCapabilities, ChatInteraction, ChatInteractionAnswer, ChatProviderInfo } from '../../shared/transcript/chatSession';
import type { TurnEvent } from '../../shared/transcript/turnEvents';

export interface ChatAdapterContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId?: string;
  emit: (event: TurnEvent) => void;
  request: (request: Omit<ChatInteraction, 'id'>) => Promise<ChatInteractionAnswer>;
  disconnected: (reason: string) => void;
}
export interface ChatAdapter {
  readonly capabilities: ChatCapabilities;
  connect(context: ChatAdapterContext): Promise<string>;
  /** Settles at a provider-confirmed turn boundary, never merely after writing. */
  prompt(text: string, requestId: string): Promise<void>;
  cancel(): Promise<void>;
  close(): void;
}
export interface ChatProvider extends ChatProviderInfo { create: () => ChatAdapter; }

export const BASE_CAPABILITIES: ChatCapabilities = {
  send: true, cancel: true, resume: false, permissions: true, questions: false,
  fileDiff: false, fileUndo: false, liveTerminalAttach: false,
};

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}
export function body(text: string) {
  return { n: 0, bytes: Buffer.byteLength(text), inline: text.slice(0, 32_000), truncated: text.length > 32_000 };
}
export function deadline<T>(operation: Promise<T>, ms = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Agent connection timed out')), ms);
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
