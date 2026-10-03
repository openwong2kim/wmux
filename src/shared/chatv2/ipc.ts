/**
 * Chat v2 contract: the renderer ↔ main IPC channels, the main ↔ daemon RPC
 * methods, their params/results, the push event, error codes and limits.
 *
 * A chat-v2 conversation is a daemon-owned agent process (a 'driver') that
 * speaks the agent's structured protocol, bound to one pane. The pane keeps
 * its shell PTY as its anchor: `paneId` everywhere below is that PTY's daemon
 * session id (`Surface.ptyId`). There is no PTY-less surface.
 *
 * ## Ownership
 * - One writer per pane: `create` is refused with `agent-running-in-pane`
 *   while an agent process is alive in the anchor shell, and `toTerminal` is
 *   the only handoff (driver → TUI, after the driver's process tree is
 *   reaped). Terminal → chat is not offered in v1.
 * - Every method is first-party only (the main app's socket). A renderer never
 *   supplies a path, argv, env, account or cwd: the daemon derives them from
 *   the pane.
 *
 * ## Seq, epoch and snapshots
 * - Per chat session the daemon stamps every HarnessEvent with `seq` (1, 2, …,
 *   gapless) and `at`, folds it with `applyHarnessEvent` into its
 *   authoritative session, and persists the folded session (not the events).
 * - `epoch` names one in-memory incarnation of a record. It changes whenever
 *   the daemon (re)loads the record from disk or replaces its history, and
 *   seq restarts at the persisted value + 1 under the new epoch.
 * - `snapshot` returns the folded session's head plus a tail window of blocks
 *   (`baseIndex` = index of the first block returned) and the `seq` it
 *   reflects. Older blocks come from `history`. The window starts at or before
 *   the last user block whenever the blocks from there fit
 *   `CHATV2_PAGE_BUDGET_BYTES`: a turn's end and its metrics update that user
 *   block, so a window that starts after it re-snapshots at every turn end.
 * - A `chatv2.events` push carries consecutive stamped events plus the fold
 *   result the daemon computed after them (`blockCount`, `lastBlockId`,
 *   `touchedFrom`). A client applies a push with `applyHarnessEvents` iff
 *   `epoch` matches and `events[0].seq === lastSeq + 1`; events with
 *   `seq <= lastSeq` are dropped. It must re-snapshot when:
 *     - the epoch differs, or the first seq leaves a gap;
 *     - `touchedFrom < baseIndex` (an event changed a block it does not hold);
 *     - after folding, `baseIndex + blocks.length !== blockCount` or the last
 *       block's id !== `lastBlockId` (its window fold diverged).
 *   These two values detect structural divergence only (an append where the
 *   daemon updated, a lost block). Ids are fixed at creation, so an in-place
 *   patch never changes them; content agreement comes from the deterministic
 *   fold plus the `touchedFrom` and window-start rules, not from a check.
 * - A push applies to the whole session, head included (`busy`,
 *   `backgroundTasks`, `usageLimit`, `context`, `pendingQuestion`, …). Events
 *   that change only the head leave `touchedFrom === blockCount`.
 * - Block ids are deterministic (`<seq>.<n>`), so the same stamped events fold
 *   to the same ids in the daemon and in every client.
 *
 * ## Restore
 * - Records are keyed by `paneId` and persisted under the daemon's
 *   `chat-sessions/v2/` with restrictive permissions. After a daemon restart a
 *   record is `stopped` (no process); the next `send` respawns the driver with
 *   the agent's resume flag and the bound `providerSessionId`. Nothing is
 *   resent and nothing is sent on restore.
 * - On daemon start any driver process left from a previous run is killed
 *   (process tree), and every pending approval of a record is expired.
 * - View selection (renderer): a surface with `viewMode: 'chat'` shows the
 *   chat-v2 view when `bindingForPane` returns a binding; without one it
 *   shows the existing terminal-projection chat while an agent runs in the
 *   pane, and the chat-v2 empty composer (which calls `create`) when the
 *   anchor shell is idle.
 *
 * ## Approvals
 * Driver approvals live in the ApprovalRegistry as native decisions
 * (`NativeDecisionRef.adapter === 'claude'`, `requestId` = the driver's
 * request id). `answer` is the desktop's first-party human answer path; the
 * phone answers through `/api/approvals/:id/answer`. Whichever lands first
 * wins; the driver writes exactly one reply per request id. A record whose
 * decision channel is off (`none`) is denied immediately. v1 replies are
 * allow/deny for permissions and option keys for questions.
 */
import { validChatAttachments } from '../transcript/chatAttachments';
import type { HarnessId, Session } from './session';
import type { StampedHarnessEvent } from './harnessEvents';

/** Private desktop IPC (renderer ↔ main); never registered on the MCP router. */
export const CHATV2_IPC = {
  create: 'chatv2:create',
  bindingForPane: 'chatv2:binding-for-pane',
  snapshot: 'chatv2:snapshot',
  history: 'chatv2:history',
  subscribe: 'chatv2:subscribe',
  unsubscribe: 'chatv2:unsubscribe',
  send: 'chatv2:send',
  interrupt: 'chatv2:interrupt',
  answer: 'chatv2:answer',
  toTerminal: 'chatv2:to-terminal',
  close: 'chatv2:close',
  /** main → renderer push; payload `ChatV2EventsPush`. */
  events: 'chatv2:events',
} as const;

/** Daemon RPC (main ↔ daemon). Same params/results as the IPC of the same key. */
export const CHATV2_RPC = {
  create: 'daemon.chatv2.create',
  bindingForPane: 'daemon.chatv2.bindingForPane',
  snapshot: 'daemon.chatv2.snapshot',
  history: 'daemon.chatv2.history',
  subscribe: 'daemon.chatv2.subscribe',
  unsubscribe: 'daemon.chatv2.unsubscribe',
  send: 'daemon.chatv2.send',
  interrupt: 'daemon.chatv2.interrupt',
  answer: 'daemon.chatv2.answer',
  toTerminal: 'daemon.chatv2.toTerminal',
  close: 'daemon.chatv2.close',
} as const;

export type ChatV2Method = keyof typeof CHATV2_RPC;

/** `DaemonEvent.type` of the unicast push to subscribed sockets. */
export const CHATV2_PUSH_EVENT = 'chatv2.events' as const;

// --- limits -------------------------------------------------------------

/** Main's control pipe drops its buffer above 1 MiB; one push or result stays far below. */
export const CHATV2_MAX_PUSH_BYTES = 128 * 1024;
/** Serialized budget for one snapshot's tail window or one history page. */
export const CHATV2_PAGE_BUDGET_BYTES = 96 * 1024;
/** Longest prompt text a send accepts, in UTF-16 units. */
export const CHATV2_MAX_PROMPT_CHARS = 64_000;
/** Daemon-side delta batching window; approvals, errors and turn ends flush at once. */
export const CHATV2_BATCH_MS = 120;
/** Events a renderer may keep folding before it should re-snapshot anyway. */
export const CHATV2_MAX_EVENTS_PER_PUSH = 512;

// --- shared shapes ------------------------------------------------------

/** Agents v1 creates. The fold model (`HarnessId`) is wider; creation is not. */
export type ChatV2Agent = Extract<HarnessId, 'claude'>;
export const CHATV2_AGENTS: readonly ChatV2Agent[] = ['claude'];

/** `default` adds no permission flags; `bypass` = the agent's skip-permissions mode. */
export type ChatV2RunMode = 'default' | 'bypass';

/**
 * Record state. `starting`: process spawned, not yet initialized. `idle`:
 * live, no turn. `running`: a turn is open. `needs-input`: a turn waits on an
 * approval or a question. `stopped`: no process (restored, closed by the
 * agent, or handed to the terminal); a send restarts it. `failed`: the last
 * start failed; `error` says why.
 */
export type ChatV2Status = 'starting' | 'idle' | 'running' | 'needs-input' | 'stopped' | 'failed';

export interface ChatV2Capabilities {
  send: boolean;
  interrupt: boolean;
  /** Tool permissions are answered in chat. */
  approvals: boolean;
  /** AskUserQuestion is answered in chat. */
  questions: boolean;
  /** Image attachments (staged absolute paths, `validChatAttachments`). */
  images: boolean;
  /** `toTerminal` can hand the conversation to a TUI in the anchor shell. */
  toTerminal: boolean;
}

export interface ChatV2Binding {
  paneId: string;
  chatSessionId: string;
  agent: ChatV2Agent;
  mode: ChatV2RunMode;
  /** '' = the agent's default model. */
  model: string;
  status: ChatV2Status;
  /** The agent's own conversation id, once the driver reported it. */
  providerSessionId?: string;
  epoch: string;
  seq: number;
  capabilities: ChatV2Capabilities;
  /** Set with `failed`, and on `stopped` after an unexpected exit. */
  error?: { code: ChatV2ErrorCode; message: string };
}

/** The session without its blocks. */
export type ChatV2SessionHead = Omit<Session, 'blocks'>;

export interface ChatV2Snapshot {
  binding: ChatV2Binding;
  head: ChatV2SessionHead;
  /** Index (in the full transcript) of `blocks[0]`. */
  baseIndex: number;
  /** Tail of the transcript, newest last, within `CHATV2_PAGE_BUDGET_BYTES`. */
  blocks: Session['blocks'];
  /** Total blocks in the full transcript. */
  blockCount: number;
}

export interface ChatV2HistoryPage {
  epoch: string;
  seq: number;
  /** Index of `blocks[0]`; 0 means the start was reached. */
  baseIndex: number;
  blocks: Session['blocks'];
}

/** Payload of `DaemonEvent` `chatv2.events` and of the `chatv2:events` IPC push. */
export interface ChatV2EventsPush {
  paneId: string;
  chatSessionId: string;
  epoch: string;
  /** Consecutive by seq; never empty. */
  events: StampedHarnessEvent[];
  /** Fold result after the last event (see the header comment). */
  blockCount: number;
  lastBlockId: string | null;
  touchedFrom: number;
  /** Present when the status changed in this batch. */
  status?: ChatV2Status;
}

// --- errors -------------------------------------------------------------

export type ChatV2ErrorCode =
  /** PR0 stub: the method exists but nothing implements it yet. */
  | 'not-implemented'
  /** Not the main app's socket, or the daemon has no chat-v2 host. */
  | 'unavailable'
  | 'invalid-params'
  /** No live anchor PTY with that id. */
  | 'pane-not-found'
  /** No chat-v2 record for that pane (or a different chatSessionId). */
  | 'session-not-found'
  /** create: the pane already has a record. */
  | 'already-exists'
  /** create: an agent process is alive in the anchor shell. */
  | 'agent-running-in-pane'
  /** create/send: the agent CLI is missing, or failed its startup probe. */
  | 'driver-unavailable'
  /** create: an agent v1 does not run. */
  | 'unsupported-agent'
  /** The caller's epoch is not the record's current one; re-snapshot. */
  | 'stale-epoch'
  /** send: a turn is open. v1 does not queue. */
  | 'turn-running'
  /** send: an approval or question is waiting. */
  | 'needs-input'
  /** answer: no pending approval with that id on this pane. */
  | 'approval-not-found'
  /** answer: the registry refused (already answered, too soon, …); `message` names it. */
  | 'approval-refused'
  /** send: the same clientMessageId was already accepted; the result echoes it. */
  | 'duplicate'
  | 'payload-too-large'
  /** toTerminal: the driver could not be stopped and reaped, or the shell is not at a prompt. */
  | 'handoff-refused'
  /** The driver process exited or failed mid-call. */
  | 'driver-failed';

export interface ChatV2Error {
  code: ChatV2ErrorCode;
  message: string;
}

export type ChatV2Result<T> = ({ ok: true } & T) | { ok: false; error: ChatV2Error };

export function chatV2Error(code: ChatV2ErrorCode, message: string): { ok: false; error: ChatV2Error } {
  return { ok: false, error: { code, message } };
}

// --- params / results ---------------------------------------------------

export interface ChatV2CreateParams {
  paneId: string;
  agent: ChatV2Agent;
  mode: ChatV2RunMode;
  /** '' or absent = the agent's default model. */
  model?: string;
}
export type ChatV2CreateResult = ChatV2Result<{ binding: ChatV2Binding }>;

export interface ChatV2PaneParams {
  paneId: string;
}
/** `binding: null` = the pane has no chat-v2 record. */
export type ChatV2BindingResult = ChatV2Result<{ binding: ChatV2Binding | null }>;

export interface ChatV2SessionParams {
  paneId: string;
  chatSessionId: string;
}
export type ChatV2SnapshotResult = ChatV2Result<{ snapshot: ChatV2Snapshot }>;

export interface ChatV2HistoryParams extends ChatV2SessionParams {
  epoch: string;
  /** Return blocks with index < beforeIndex, newest last. */
  beforeIndex: number;
}
export type ChatV2HistoryResult = ChatV2Result<{ page: ChatV2HistoryPage }>;

/** subscribe/unsubscribe: per socket. A subscriber gets every push for the pane. */
export type ChatV2SubscribeResult = ChatV2Result<{ binding: ChatV2Binding }>;
export type ChatV2AckResult = ChatV2Result<Record<string, never>>;

export interface ChatV2SendParams extends ChatV2SessionParams {
  epoch: string;
  /** The sender's idempotency key, `CHATV2_CLIENT_MESSAGE_ID`. */
  clientMessageId: string;
  text: string;
  /** Staged absolute image paths (`validChatAttachments`). */
  attachments?: string[];
}
/** `seq` = the seq of the `user.message` event the send produced. */
export type ChatV2SendResult = ChatV2Result<{ clientMessageId: string; seq: number }>;

export type ChatV2InterruptResult = ChatV2Result<{ interrupted: boolean }>;

export interface ChatV2AnswerParams extends ChatV2SessionParams {
  /** ApprovalRegistry record id. */
  approvalId: string;
  /** Permission: allow/deny. Question: approve with `answers`, or deny to skip. */
  decision: 'allow' | 'deny';
  /** Questions only: one entry per question, in form order (form option keys). */
  answers?: Array<{ keys: string[]; other?: string }>;
}
export type ChatV2AnswerResult = ChatV2Result<Record<string, never>>;

/** toTerminal: stop the driver and resume the conversation in the anchor shell's TUI. */
export type ChatV2ToTerminalResult = ChatV2Result<{ command: 'resumed' }>;

/** close: stop the driver and drop the record (the agent's own history stays). */
export type ChatV2CloseResult = ChatV2Result<Record<string, never>>;

export interface ChatV2ParamsByMethod {
  create: ChatV2CreateParams;
  bindingForPane: ChatV2PaneParams;
  snapshot: ChatV2SessionParams;
  history: ChatV2HistoryParams;
  subscribe: ChatV2PaneParams;
  unsubscribe: ChatV2PaneParams;
  send: ChatV2SendParams;
  interrupt: ChatV2SessionParams;
  answer: ChatV2AnswerParams;
  toTerminal: ChatV2SessionParams;
  close: ChatV2SessionParams;
}

export interface ChatV2ResultByMethod {
  create: ChatV2CreateResult;
  bindingForPane: ChatV2BindingResult;
  snapshot: ChatV2SnapshotResult;
  history: ChatV2HistoryResult;
  subscribe: ChatV2SubscribeResult;
  unsubscribe: ChatV2AckResult;
  send: ChatV2SendResult;
  interrupt: ChatV2InterruptResult;
  answer: ChatV2AnswerResult;
  toTerminal: ChatV2ToTerminalResult;
  close: ChatV2CloseResult;
}

/**
 * The renderer's API, exposed by preload as `window.electronAPI.chatv2`. Main
 * forwards `call` to `CHATV2_RPC[method]` after `parseChatV2Params`, and
 * forwards `chatv2.events` pushes for subscribed panes to `onEvents`.
 */
export interface ChatV2BridgeApi {
  call<M extends ChatV2Method>(method: M, params: ChatV2ParamsByMethod[M]): Promise<ChatV2ResultByMethod[M]>;
  /** Returns an unsubscribe. */
  onEvents(listener: (push: ChatV2EventsPush) => void): () => void;
}

// --- validation (shared by the daemon RPC and the main IPC handler) ------

export const CHATV2_CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MODEL = /^[A-Za-z0-9_.:[\]/-]{0,128}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function seqIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function answers(value: unknown): value is Array<{ keys: string[]; other?: string }> {
  return Array.isArray(value) && value.length <= 16 && value.every((entry) => {
    const o = record(entry);
    return !!o && Array.isArray(o.keys) && o.keys.length <= 32
      && o.keys.every((key) => typeof key === 'string' && key.length <= 64)
      && (o.other === undefined || (typeof o.other === 'string' && o.other.length <= 4000));
  });
}

/**
 * Validate one method's params. Returns the params narrowed to their type, or
 * null; callers answer null with `invalid-params`. Unknown keys are ignored
 * and not copied.
 */
export function parseChatV2Params<M extends ChatV2Method>(method: M, value: unknown): ChatV2ParamsByMethod[M] | null {
  const o = record(value);
  if (!o || !id(o.paneId)) return null;
  const paneId = o.paneId;
  const session = id(o.chatSessionId) ? { paneId, chatSessionId: o.chatSessionId } : null;
  let parsed: ChatV2ParamsByMethod[ChatV2Method] | null = null;
  switch (method) {
    case 'create': {
      const agent = o.agent;
      const mode = o.mode;
      const model = o.model === undefined ? '' : o.model;
      if (!CHATV2_AGENTS.includes(agent as ChatV2Agent)) return null;
      if (mode !== 'default' && mode !== 'bypass') return null;
      if (typeof model !== 'string' || !MODEL.test(model)) return null;
      parsed = { paneId, agent: agent as ChatV2Agent, mode, ...(model ? { model } : {}) };
      break;
    }
    case 'bindingForPane':
    case 'subscribe':
    case 'unsubscribe':
      parsed = { paneId };
      break;
    case 'snapshot':
    case 'interrupt':
    case 'toTerminal':
    case 'close':
      parsed = session;
      break;
    case 'history':
      if (!session || !id(o.epoch) || !seqIndex(o.beforeIndex)) return null;
      parsed = { ...session, epoch: o.epoch, beforeIndex: o.beforeIndex };
      break;
    case 'send': {
      if (!session || !id(o.epoch)) return null;
      if (typeof o.clientMessageId !== 'string' || !CHATV2_CLIENT_MESSAGE_ID.test(o.clientMessageId)) return null;
      if (typeof o.text !== 'string' || o.text.length > CHATV2_MAX_PROMPT_CHARS) return null;
      if (!validChatAttachments(o.attachments)) return null;
      if (!o.text.trim() && !(o.attachments as string[] | undefined)?.length) return null;
      parsed = {
        ...session,
        epoch: o.epoch,
        clientMessageId: o.clientMessageId,
        text: o.text,
        ...(o.attachments ? { attachments: [...(o.attachments as string[])] } : {}),
      };
      break;
    }
    case 'answer':
      if (!session || !id(o.approvalId)) return null;
      if (o.decision !== 'allow' && o.decision !== 'deny') return null;
      if (o.answers !== undefined && !answers(o.answers)) return null;
      parsed = {
        ...session,
        approvalId: o.approvalId,
        decision: o.decision,
        ...(o.answers ? { answers: (o.answers as Array<{ keys: string[]; other?: string }>).map((a) => ({ keys: [...a.keys], ...(a.other !== undefined ? { other: a.other } : {}) })) } : {}),
      };
      break;
    default:
      return null;
  }
  return parsed as ChatV2ParamsByMethod[M] | null;
}

// --- phone projection (consumed by the /turns route) ---------------------

/**
 * `historyEpoch` a chat-v2 record presents on the phone's `/turns` `chat`
 * object. The phone sees it as `binding: 'managed'` (read + approve only;
 * send stays `409 managed-read-only`), with `capabilities.streaming: false`.
 */
export function chatV2HistoryEpoch(chatSessionId: string, epoch: string): string {
  return `c2:${chatSessionId}:${epoch}`;
}
