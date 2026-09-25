import { createHash } from 'node:crypto';
import type { ChatSendResult, TranscriptPage, TranscriptStatus } from '../../shared/transcript/turnEvents';
import type { ChatSkillCatalog } from '../../shared/transcript/chatSkills';
import type { TerminalLaunchAgent, TerminalLaunchMode } from '../../shared/transcript/terminalChat';

/**
 * Phone native chat bridge (contract v0.3.1, N1-N19): the daemon-side seam the
 * web server and the private desktop RPCs share, so the two transports cannot
 * drift on binding resolution, send receipts, launch readiness or skills.
 *
 * Every security decision that does not depend on the HTTP principal lives on
 * the daemon side of this interface. The web server adds only the principal
 * gates (grants, pane ownership, re-authentication) and the wire mapping.
 */

/** Which reader owns the pane's chat, in the fixed daemon order (contract §2.1). */
export type ChatSource = 'tui' | 'managed' | 'file' | 'none';

/** What a final write outcome did to the pane (contract §6.0). */
export type ChatEffect = 'none' | 'uncertain' | 'submitted';

/** Disjoint receipt owner namespaces: first-party desktop, a paired device, the operator token. */
export type ChatOwner = 'desktop' | 'operator' | `device:${string}`;

export type ChatLaunchReason =
  | 'ok' | 'shell-busy' | 'shell-not-empty' | 'unsupported-shell' | 'shell-has-children'
  | 'approval-pending' | 'launch-pending' | 'not-integrated' | 'agent-running';

export interface ChatLaunchPreview {
  ready: boolean;
  reason: ChatLaunchReason;
  /** Installed launchers only. */
  agents: TerminalLaunchAgent[];
  maxPromptUnits: number;
}

export interface ChatBlocked { by: 'approval' | 'terminal'; approvalId?: string }

/**
 * One pane's chat binding, computed from fresh daemon state on every call.
 * `rawEpoch` (OpenCode) is loopback-token material and must never leave the
 * daemon; only `epoch` (the `t1:` hash) may be serialized.
 */
export type ChatResolution =
  | { source: 'tui'; status: TranscriptStatus; page: TranscriptPage; epoch: string; rawEpoch: string }
  | { source: 'managed'; status: TranscriptStatus; epoch: string }
  | { source: 'file'; status: TranscriptStatus; epoch?: string }
  | { source: 'none'; status: TranscriptStatus; launch: ChatLaunchPreview };

export interface ChatSendRequest {
  owner: ChatOwner;
  /** Pane id. */
  id: string;
  agentSessionId: string;
  /** Bridge epoch (`h1:`/`t1:`/`m1:`). Required from the phone, absent from the desktop. */
  historyEpoch?: string;
  text: string;
  /** `<13-digit ms>-<lowercase uuid>`. */
  clientMessageId: string;
  /** Phone: refuse managed bindings (read-only in v1). The desktop keeps managed send. */
  managedReadOnly?: boolean;
  /**
   * Re-authorization, called immediately before the first PTY/plugin write
   * (`first-write`) and again immediately before Enter on the paste path
   * (`submit`). `false` writes nothing more.
   */
  authorized?: (stage?: 'first-write' | 'submit') => Promise<boolean>;
  /** Desktop only: absolute image paths pasted ahead of the text (file binding, Claude). */
  attachments?: readonly string[];
}

/** HTTP-facing error tags a send can end in (contract §6.2 table). */
export type ChatSendTag =
  | 'chat-busy' | 'chat-blocked' | 'session-changed' | 'chat-unavailable' | 'input-not-provably-empty'
  | 'send-interrupted' | 'delivery-unconfirmed' | 'authorization-expired' | 'invalid-chat-request'
  | 'text-too-long' | 'message-id-expired' | 'message-id-conflict' | 'message-history-full'
  | 'opencode-receipts-full' | 'no-conversation' | 'managed-read-only' | 'chat-persist-failed';

export interface ChatSendOutcome {
  clientMessageId: string;
  replayed: boolean;
  /** Same id, same fingerprint, first dispatch still running: poll the receipt. No `effect`. */
  pending?: true;
  /** Verbatim desktop enum when the send reached a daemon verdict. */
  result?: ChatSendResult;
  /** Absent only on `pending`. */
  effect?: ChatEffect;
  /** Absent on `sent`. */
  error?: ChatSendTag;
  detail?: string;
  blockedBy?: 'approval' | 'terminal';
  limit?: 'units' | 'bytes';
  maxSendBytes?: number;
  /** Current identity, on `session-changed`. */
  agentSessionId?: string;
  historyEpoch?: string;
  /** `sent` while the agent's turn ran: its composer queued the prompt. Absent otherwise. */
  queued?: true;
}

export type ChatReceiptState = 'pending' | 'submitted' | 'refused' | 'uncertain' | 'unknown';

export interface ChatSendReceiptView {
  clientMessageId: string;
  state: ChatReceiptState;
  result?: ChatSendResult;
  error?: ChatSendTag;
  agentSessionId?: string;
  historyEpoch?: string;
  /** Receipt creation, epoch ms. */
  at?: number;
  /** A `submitted` send the agent queued behind its running turn. */
  queued?: true;
}

export interface ChatLaunchRequest {
  id: string;
  agent: TerminalLaunchAgent;
  prompt: string;
  mode?: TerminalLaunchMode;
  /** Phone: refuse a pane that already has a readable conversation (desktop eligibility rule). */
  refuseConversation?: boolean;
  /** Called (`first-write`) immediately before the launcher is typed. `false` types nothing. */
  authorized?: (stage?: 'first-write' | 'submit') => Promise<boolean>;
}

export type ChatLaunchTag =
  | 'launch-pending' | 'conversation-exists' | 'launch-not-ready' | 'launch-unsupported'
  | 'agent-not-installed' | 'agent-runtime-unavailable' | 'launch-unconfirmed'
  | 'authorization-expired' | 'invalid-chat-request';

export type ChatLaunchOutcome =
  | { ok: true; effect: 'submitted' }
  | { ok: false; error: ChatLaunchTag; reason?: ChatLaunchReason; effect: ChatEffect };

export interface DangerousLaunchTrace {
  at: number;
  owner: ChatOwner;
  paneId: string;
  agent: TerminalLaunchAgent;
  mode: TerminalLaunchMode;
  clientLaunchId: string;
  /** `submitted`/`launch-unconfirmed` notify the desktop; refusals are logged only. */
  outcome: string;
}

/** Daemon functions behind the phone chat routes. Injected lazily into WebTerminalServer. */
export interface ChatBridge {
  resolve(id: string): Promise<ChatResolution>;
  /** Tail snapshot of a managed record (read-only in phone v1), or null. */
  managedSnapshot(id: string): TranscriptPage | null;
  /** Read-time blocked state (contract §5.2). Always undefined for a brain pane. */
  blocked(id: string, resolution: ChatResolution): Promise<ChatBlocked | undefined>;
  send(request: ChatSendRequest): Promise<ChatSendOutcome>;
  /** Owner-bound receipt read; never dispatches. `unknown` when absent, for another owner or another pane. */
  receipt(owner: ChatOwner, id: string, clientMessageId: string): ChatSendReceiptView;
  launch(request: ChatLaunchRequest): Promise<ChatLaunchOutcome>;
  /** Phone skills rule: Claude `spawnCwd`; Codex live relay selection cwd, else `spawnCwd`. */
  skills(id: string, agent: TerminalLaunchAgent): Promise<ChatSkillCatalog>;
  /** Bridge-owned OpenCode watch: nudges phone watchers on TUI changes until `unwatch`. */
  watch(id: string): void;
  unwatch(id: string): void;
  /** Audit record in the daemon log; desktop notification when the launch reached typing. */
  traceDangerousLaunch(trace: DangerousLaunchTrace): void;
}

// ---------------------------------------------------------------------------
// Pure helpers shared by the daemon and the web server.

/** 24 h, the input-receipt retention (`InputReceiptStore`). */
export const CHAT_MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 10 min, the memory-only launch receipt lifetime. */
export const CHAT_LAUNCH_RETENTION_MS = 10 * 60 * 1000;
export const CHAT_ID_CLOCK_SKEW_MS = 60_000;
export const CHAT_SEND_MAX_UNITS = 16_000;
export const CHAT_LAUNCH_MAX_UNITS = 2_000;
/** The OpenCode plugin destroys any loopback request body above this many bytes. */
export const OPENCODE_REQUEST_MAX_BYTES = 24_000;

const CHAT_ID = /^(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * `<13-digit ms>-<lowercase uuid>`. The time prefix lets the daemon refuse a
 * reused id after its receipt was pruned, so `unknown` can never lead to a
 * second dispatch of an old message.
 */
export function checkChatId(id: unknown, now: number, retentionMs: number): 'ok' | 'invalid' | 'expired' {
  if (typeof id !== 'string') return 'invalid';
  const match = CHAT_ID.exec(id);
  if (!match) return 'invalid';
  const at = Number(match[1]);
  return at <= now - retentionMs || at > now + CHAT_ID_CLOCK_SKEW_MS ? 'expired' : 'ok';
}

export function chatIdTime(id: string): number {
  return Number(id.slice(0, 13));
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

/** File transcripts have no native epoch; bind the cursor to the native id and file. */
export function fileHistoryEpoch(agent: string, agentSessionId: string, transcriptBasename: string): string {
  return 'h1:' + sha(JSON.stringify([agent, agentSessionId, transcriptBasename])).slice(0, 16);
}

/** The raw OpenCode epoch may start with half the loopback token: expose a hash only. */
export function tuiHistoryEpoch(rawEpoch: string): string {
  return 't1:' + sha(rawEpoch).slice(0, 32);
}

/** Managed epoch for the phone: conversation identity, not eviction-rotated. */
export function managedHistoryEpoch(recordId: string, replayGeneration: number): string {
  return 'm1:' + sha(JSON.stringify([recordId, replayGeneration])).slice(0, 16);
}

/**
 * Text budget advertised as `chat.maxSendBytes`: the plugin cap minus the
 * largest envelope the bridge can build (a `ses_` id, a 256-char epoch, a
 * 50-char request id, JSON punctuation), rounded down to a thousand.
 */
export const OPENCODE_MAX_SEND_BYTES = Math.floor((OPENCODE_REQUEST_MAX_BYTES - Buffer.byteLength(JSON.stringify({
  action: 'send', sessionId: 'ses_' + 'x'.repeat(64), epoch: 'x'.repeat(256), text: '', requestId: 'x'.repeat(50),
}))) / 1000) * 1000;

/** The exact serialized plugin request, measured before any receipt exists (N16). */
export function openCodeSendBytes(sessionId: string, rawEpoch: string, text: string, requestId: string): number {
  return Buffer.byteLength(JSON.stringify({ action: 'send', sessionId, epoch: rawEpoch, text, requestId }));
}
