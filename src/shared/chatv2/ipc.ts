/**
 * Chat v2 contract: the renderer ↔ main IPC channels, the main ↔ daemon RPC
 * methods, their params/results, the push events, error codes and the rules
 * every side follows. Limits live in limits.ts.
 *
 * A chat-v2 conversation is a daemon-owned agent process (a 'driver') that
 * speaks the agent's structured protocol, bound to one pane. The pane keeps
 * its shell PTY as its anchor: `paneId` everywhere below is that PTY's daemon
 * session id (`Surface.ptyId`). There is no PTY-less surface.
 *
 * ## Ownership (single writer)
 * - A pane is free for a driver only when no agent process is tracked alive in
 *   it AND its anchor shell is idle with no child processes. `create`, and
 *   every later driver (re)start, re-checks this and fails with
 *   `agent-running-in-pane` otherwise.
 * - `toTerminal` is the only handoff: the host stops the driver, waits until
 *   its process tree is reaped, persists the record as `handed-off` (a
 *   tombstone), then types the agent's resume command into the anchor shell.
 *   A `handed-off` record refuses `send` (`handed-off`) and never restarts;
 *   `close` drops it. Terminal → chat is not offered.
 * - Every method is first-party only (the main app's socket). A renderer never
 *   supplies argv, env, account or cwd: the daemon derives them from the pane.
 *
 * ## Seq, epoch, persistence
 * - The daemon stamps every HarnessEvent with `seq` and `at` and folds it into
 *   its authoritative session with `applyHarnessEvent`. `seq` starts at 1 per
 *   chat session and never restarts; it is gapless within an epoch.
 * - `epoch` (`CHATV2_EPOCH`, 16 random lowercase hex) names one load of a
 *   record. A new one is drawn whenever the daemon creates or (re)loads the
 *   record; it then continues at persisted seq + 1. Events after the last
 *   persist are lost with the old epoch, and every client re-snapshots on the
 *   epoch change, so their block ids never mix with the new ones.
 * - The record (folded session, seq, overflow bodies, send ledger, process
 *   identity, state) is written atomically (temp file + rename) under
 *   `chat-sessions/v2/`, mode 0600: at most `CHATV2_PERSIST_DEBOUNCE_MS` after
 *   a change, and at once on turn end, a decision, handoff, close and dispose.
 * - Send ledger: the last `CHATV2_SEND_LEDGER_MAX` clientMessageIds with a
 *   digest of their text and attachments. A repeat with the same digest
 *   answers `ok` with the original seq and `duplicate: true`; the same id with
 *   a different payload is `client-message-conflict`.
 *
 * ## Subscribe, snapshot, pushes
 * - Order: `subscribe`, then `snapshot`. Pushes that arrive before the
 *   snapshot are buffered, then applied by the rule below.
 * - Apply rule: drop every pushed event whose seq <= lastSeq; apply the rest
 *   only if its first seq is lastSeq + 1 and the epoch matches, otherwise
 *   re-snapshot.
 * - `snapshot` returns the head, a tail window of blocks (`baseIndex` = index
 *   of its first block) and the `seq` it reflects. The window starts at or
 *   before the last user block whenever the blocks from there fit
 *   `CHATV2_PAGE_BUDGET_BYTES` (a turn's end and metrics update that block);
 *   a window or page always holds at least one block, even one over budget.
 * - A push carries consecutive stamped events and the daemon's fold result
 *   after them: `blockCount`, `lastBlockId`, `touchedFrom` (lowest changed
 *   block index, `blockChangeFrom`). A client also re-snapshots when
 *   `touchedFrom < baseIndex`, or when after folding
 *   `baseIndex + blocks.length !== blockCount` or its last id !== lastBlockId.
 *   Those two values detect structural divergence only; content agreement
 *   comes from the deterministic fold and the window rules.
 * - A push applies to the whole session, head included. When the binding
 *   changed (status, error, providerSessionId, capabilities) the push carries
 *   the whole new `binding`.
 * - Backpressure: when a push cannot be written to a socket (`sendTo` false)
 *   the host drops every subscription of that socket. The socket is gone;
 *   main reconnects and follows the reconnect rule.
 * - Reconnect: after main reconnects to the daemon it calls `subscribe` again
 *   for every pane it had subscribed, then sends the renderer
 *   `chatv2:resync` with those pane ids; the renderer re-snapshots each.
 * - `history` pages older blocks by block id (`beforeBlockId`), not by index,
 *   so removed or settled blocks cannot misalign pages. An unknown block id or
 *   a changed epoch is `stale-epoch`: re-snapshot and drop loaded pages.
 *
 * ## Caps and bodies
 * The fold caps block text, tool detail and preview output in bytes
 * (limits.ts) and marks the block's `overflow`. `bodies` returns the full
 * value from the daemon's uncapped shadow fold (or the persisted overflow
 * store) while it is kept; otherwise `body-gone`. A long value comes in pages
 * that each stay far below the pipe's frame limit: a result with `nextOffset`
 * is continued by calling again with `offset: nextOffset`.
 *
 * ## Restore
 * - Records are keyed by `paneId`. After a daemon restart a record is
 *   `stopped`; the next `send` re-checks the pane and respawns the driver with
 *   the agent's resume option for the bound `providerSessionId` (which must
 *   match `CHATV2_PROVIDER_SESSION_ID`). Nothing is resent or sent on restore.
 * - On daemon start the host kills a driver left from a previous run only when
 *   the recorded pid, its start time and an argv marker (the provider session
 *   id in its command line) all match; it then expires that record's pending
 *   approvals.
 * - View selection (renderer): a surface with `viewMode: 'chat'` shows the
 *   chat-v2 view when `bindingForPane` returns a binding; without one it shows
 *   the terminal-projection chat while an agent runs in the pane, and the
 *   chat-v2 empty composer (which calls `create`) when the pane is free.
 *
 * ## Approvals and questions
 * - The host records a driver decision in the ApprovalRegistry
 *   (`noteNativeDecision`, `native: { adapter: 'claude', requestId,
 *   threadId: chatSessionId, relayId: epoch }`) BEFORE it stamps the matching
 *   `approval.requested` / `question.asked`, so `requestedAt` is never earlier
 *   than the registry record. Buttons arm at `requestedAt + CHATV2_ANSWER_ARM_MS`.
 * - `answer` names the request by `requestId` (what the transcript holds); the
 *   host finds the registry record and resolves it as the first-party human
 *   answer. A phone answers the same record through
 *   `/api/approvals/:id/answer`. First answer wins; the driver writes exactly
 *   one reply per request id.
 * - Fail-closed: when there is no registry or `noteNativeDecision` returns
 *   null, the host at once calls `driver.answer(deny)` and emits
 *   `approval.resolved` / `question.resolved` with `cancelled`. A record on
 *   the `none` channel (native phone decisions switched off) stays a
 *   view-only card for the phone; the desktop still answers it through
 *   `answer`, with the same arming delay.
 * - Question keys follow questions.ts: question ids `q0…`, option ids = form
 *   keys, free text as `other`.
 * - v1 permission replies are allow/deny; edited tool input and lasting rules
 *   are not offered.
 *
 * ## Attachments
 * Main copies a picked image into `<wmux data dir>/${CHATV2_ATTACHMENT_DIR}/`
 * (`chatv2:stage-attachment`, main only) and sends that path. The daemon
 * accepts only a path directly inside that directory that `lstat` shows to be
 * a regular file (not a symlink) of at most `CHAT_IMAGE_MAX_BYTES` with an
 * image extension; anything else is `attachment-refused`.
 */
import { CHAT_ATTACHMENT_LIMIT, validChatImagePath } from '../transcript/chatAttachments';
import { CHATV2_MAX_PROMPT_BYTES, utf8Bytes } from './limits';
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
  bodies: 'chatv2:bodies',
  toTerminal: 'chatv2:to-terminal',
  close: 'chatv2:close',
  /** Main only: copy a picked image into the staging directory. */
  stageAttachment: 'chatv2:stage-attachment',
  /** main → renderer push; payload `ChatV2EventsPush`. */
  events: 'chatv2:events',
  /** main → renderer push after a daemon reconnect; payload `ChatV2ResyncPush`. */
  resync: 'chatv2:resync',
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
  bodies: 'daemon.chatv2.bodies',
  toTerminal: 'daemon.chatv2.toTerminal',
  close: 'daemon.chatv2.close',
} as const;

export type ChatV2Method = keyof typeof CHATV2_RPC;

/** `DaemonEvent.type` of the unicast push to subscribed sockets. */
export const CHATV2_PUSH_EVENT = 'chatv2.events' as const;

/** Staging directory name under the wmux data dir. */
export const CHATV2_ATTACHMENT_DIR = 'chatv2-attachments';

export const CHATV2_EPOCH = /^[0-9a-f]{16}$/;
/** A provider session id the driver may pass to the agent's resume option. */
export const CHATV2_PROVIDER_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Model ids: first character alphanumeric. Drivers pass it as one `--model=<id>` argument. */
export const CHATV2_MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:[\]/-]{0,127}$/;
export const CHATV2_CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const CHATV2_BLOCK_ID = /^[0-9]{1,15}\.[0-9]{1,6}$/;

// --- shared shapes ------------------------------------------------------

/** Agents v1 creates. The fold model (`HarnessId`) is wider; creation is not. */
export type ChatV2Agent = Extract<HarnessId, 'claude'>;
export const CHATV2_AGENTS: readonly ChatV2Agent[] = ['claude'];

/** `default` adds no permission flags; `bypass` = the agent's skip-permissions mode. */
export type ChatV2RunMode = 'default' | 'bypass';

/**
 * Record state. `starting`: process spawned, not yet initialized. `idle`:
 * live, no turn. `running`: a turn is open. `needs-input`: a turn waits on an
 * approval or a question. `stopped`: no process (restored, or the agent
 * exited); a send restarts it. `failed`: the last start failed; `error` says
 * why. `handed-off`: the conversation moved to the terminal (tombstone).
 */
export type ChatV2Status = 'starting' | 'idle' | 'running' | 'needs-input' | 'stopped' | 'failed' | 'handed-off';

export interface ChatV2Capabilities {
  send: boolean;
  interrupt: boolean;
  /** Tool permissions are answered in chat. */
  approvals: boolean;
  /** AskUserQuestion is answered in chat. */
  questions: boolean;
  /** Image attachments (staged, see the header). */
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
  /** The agent's own conversation id (`CHATV2_PROVIDER_SESSION_ID`), known from spawn. */
  providerSessionId?: string;
  epoch: string;
  seq: number;
  capabilities: ChatV2Capabilities;
  /** Set with `failed`, and on `stopped` after an unexpected exit. */
  error?: ChatV2Error;
}

/** The session without its blocks. */
export type ChatV2SessionHead = Omit<Session, 'blocks'>;

export interface ChatV2Snapshot {
  binding: ChatV2Binding;
  head: ChatV2SessionHead;
  /** Index (in the full transcript) of `blocks[0]`. */
  baseIndex: number;
  /** Tail of the transcript, newest last. */
  blocks: Session['blocks'];
  /** Total blocks in the full transcript. */
  blockCount: number;
}

export interface ChatV2HistoryPage {
  epoch: string;
  seq: number;
  /** Index of `blocks[0]` at `seq`. */
  baseIndex: number;
  /** The blocks right before `beforeBlockId`, newest last. */
  blocks: Session['blocks'];
  /** `blocks[0]` is the first block of the transcript. */
  reachedStart: boolean;
}

/** Payload of `DaemonEvent` `chatv2.events` and of the `chatv2:events` IPC push. */
export interface ChatV2EventsPush {
  paneId: string;
  chatSessionId: string;
  epoch: string;
  /** Consecutive by seq; never empty; at most CHATV2_MAX_EVENTS_PER_PUSH. */
  events: StampedHarnessEvent[];
  /** Fold result after the last event (see the header). */
  blockCount: number;
  lastBlockId: string | null;
  touchedFrom: number;
  /** The whole binding, present when any part of it changed in this batch. */
  binding?: ChatV2Binding;
}

/** Payload of the `chatv2:resync` IPC push: re-snapshot these panes. */
export interface ChatV2ResyncPush {
  paneIds: string[];
}

// --- errors -------------------------------------------------------------

export type ChatV2ErrorCode =
  /** The method exists but the daemon does not implement it (yet). */
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
  /** create / driver restart: an agent or another process runs in the anchor shell. */
  | 'agent-running-in-pane'
  /** create/send: the agent CLI is missing, or failed its startup probe. */
  | 'driver-unavailable'
  /** create: an agent v1 does not run. */
  | 'unsupported-agent'
  /** The caller's epoch is not the record's current one, or a history anchor is gone; re-snapshot. */
  | 'stale-epoch'
  /** send: a turn is open. v1 does not queue. */
  | 'turn-running'
  /** send: an approval or question is waiting. */
  | 'needs-input'
  /** send: the record was handed to the terminal. */
  | 'handed-off'
  /** send: this clientMessageId was used with a different payload. */
  | 'client-message-conflict'
  /** send: an attachment path failed the staging checks. */
  | 'attachment-refused'
  /** answer: no pending decision with that request id on this record. */
  | 'approval-not-found'
  /** answer: the registry refused (answered elsewhere, too soon, …); `message` names it. */
  | 'approval-refused'
  /** bodies: the full value is no longer kept. */
  | 'body-gone'
  | 'payload-too-large'
  /** toTerminal: the driver could not be stopped and reaped, or the shell is not free. */
  | 'handoff-refused'
  /** The driver process exited or failed mid-call. */
  | 'driver-failed';

export interface ChatV2Error {
  code: ChatV2ErrorCode;
  message: string;
}

/** Success carries `ok: true` plus the method's fields; failure carries one error. */
export type ChatV2Result<T extends object = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: ChatV2Error };

export function chatV2Error(code: ChatV2ErrorCode, message: string): { ok: false; error: ChatV2Error } {
  return { ok: false, error: { code, message } };
}

// --- params / results ---------------------------------------------------

export interface ChatV2CreateParams {
  paneId: string;
  agent: ChatV2Agent;
  mode: ChatV2RunMode;
  /** Absent = the agent's default model. */
  model?: string;
}

export interface ChatV2PaneParams {
  paneId: string;
}

export interface ChatV2SessionParams {
  paneId: string;
  chatSessionId: string;
}

/**
 * Both guards are optional and checked by the host in the same step that
 * writes the interrupt: `epoch` other than the record's is `stale-epoch`;
 * `turnId` other than the open turn's user block id answers
 * `interrupted: false`.
 */
export interface ChatV2InterruptParams extends ChatV2SessionParams {
  epoch?: string;
  /** The user block id that opened the turn the caller means to stop. */
  turnId?: string;
}

export interface ChatV2HistoryParams extends ChatV2SessionParams {
  epoch: string;
  /** Return the blocks before this block, newest last. */
  beforeBlockId: string;
}

export interface ChatV2SendParams extends ChatV2SessionParams {
  epoch: string;
  /** The sender's idempotency key, `CHATV2_CLIENT_MESSAGE_ID`. */
  clientMessageId: string;
  /** At most `CHATV2_MAX_PROMPT_BYTES` UTF-8 bytes. */
  text: string;
  /** Staged image paths (see the header). */
  attachments?: string[];
}

export interface ChatV2AnswerParams extends ChatV2SessionParams {
  /** The driver request id from `Block.approval.requestId` / `pendingQuestion.requestId`. */
  requestId: string;
  /** Permission: allow/deny. Question: allow with `answers`, deny to skip. */
  decision: 'allow' | 'deny';
  /** Questions only: one entry per question in order (`answersFromReply`). */
  answers?: Array<{ keys: string[]; other?: string }>;
}

export interface ChatV2BodiesParams extends ChatV2SessionParams {
  epoch: string;
  blockId: string;
  field: 'text' | 'detail' | 'output';
  /** Continue a long value from here: the previous page's `nextOffset` (UTF-16 index). */
  offset?: number;
}

export interface ChatV2ParamsByMethod {
  create: ChatV2CreateParams;
  bindingForPane: ChatV2PaneParams;
  snapshot: ChatV2SessionParams;
  history: ChatV2HistoryParams;
  subscribe: ChatV2PaneParams;
  unsubscribe: ChatV2PaneParams;
  send: ChatV2SendParams;
  interrupt: ChatV2InterruptParams;
  answer: ChatV2AnswerParams;
  bodies: ChatV2BodiesParams;
  toTerminal: ChatV2SessionParams;
  close: ChatV2SessionParams;
}

export interface ChatV2ResultByMethod {
  create: ChatV2Result<{ binding: ChatV2Binding }>;
  /**
   * `binding: null` = the pane has no chat-v2 record; `cwd` is then the
   * directory a chat created now would run in (the shell's verified working
   * directory, else where the pane started), when the host knows it.
   */
  bindingForPane: ChatV2Result<{ binding: ChatV2Binding | null; cwd?: string }>;
  snapshot: ChatV2Result<{ snapshot: ChatV2Snapshot }>;
  history: ChatV2Result<{ page: ChatV2HistoryPage }>;
  /** Per socket; a subscriber gets every push for the pane. `binding: null` = no record yet. */
  subscribe: ChatV2Result<{ binding: ChatV2Binding | null }>;
  unsubscribe: ChatV2Result;
  /** `seq` = the seq of the `user.message` event; `duplicate` = an earlier send with this id and payload. */
  send: ChatV2Result<{ clientMessageId: string; seq: number; duplicate?: true }>;
  interrupt: ChatV2Result<{ interrupted: boolean }>;
  answer: ChatV2Result;
  /** One page of the value; `nextOffset` = more follows (call again with it as `offset`). */
  bodies: ChatV2Result<{ text: string; nextOffset?: number }>;
  /** The driver is reaped, the record is `handed-off`, and the resume command was typed. */
  toTerminal: ChatV2Result;
  /** The driver is stopped and the record dropped (the agent's own history stays). */
  close: ChatV2Result;
}

export type ChatV2StageAttachmentResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing' | 'not-image' | 'too-large' };

/**
 * The renderer's API, exposed by preload as `window.electronAPI.chatv2`. Main
 * validates with `parseChatV2Params`, forwards `call` to `CHATV2_RPC[method]`,
 * and forwards `chatv2.events` pushes for subscribed panes to `onEvents`.
 */
export interface ChatV2BridgeApi {
  call<M extends ChatV2Method>(method: M, params: ChatV2ParamsByMethod[M]): Promise<ChatV2ResultByMethod[M]>;
  stageAttachment(path: string): Promise<ChatV2StageAttachmentResult>;
  /** Returns an unsubscribe. */
  onEvents(listener: (push: ChatV2EventsPush) => void): () => void;
  /** Returns an unsubscribe. */
  onResync(listener: (push: ChatV2ResyncPush) => void): () => void;
}

// --- validation (shared by the daemon RPC and the main IPC handler) ------

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function answers(value: unknown): value is Array<{ keys: string[]; other?: string }> {
  return Array.isArray(value) && value.length <= 16 && value.every((entry) => {
    const o = record(entry);
    return !!o && Array.isArray(o.keys) && o.keys.length <= 32
      && o.keys.every((key) => typeof key === 'string' && key.length <= 64)
      && (o.other === undefined || (typeof o.other === 'string' && utf8Bytes(o.other) <= 4096));
  });
}

function attachments(value: unknown): value is string[] | undefined {
  return value === undefined
    || (Array.isArray(value) && value.length <= CHAT_ATTACHMENT_LIMIT && value.every(validChatImagePath));
}

/**
 * Validate one method's params. Returns the params narrowed to their type, or
 * null; callers answer null with `invalid-params`. Unknown keys are ignored
 * and not copied. Attachment staging is checked by the daemon (it needs the
 * file system), not here.
 */
export function parseChatV2Params<M extends ChatV2Method>(method: M, value: unknown): ChatV2ParamsByMethod[M] | null {
  const o = record(value);
  if (!o || !id(o.paneId)) return null;
  const paneId = o.paneId;
  const session = id(o.chatSessionId) ? { paneId, chatSessionId: o.chatSessionId } : null;
  let parsed: ChatV2ParamsByMethod[ChatV2Method] | null = null;
  switch (method) {
    case 'create': {
      if (!CHATV2_AGENTS.includes(o.agent as ChatV2Agent)) return null;
      if (o.mode !== 'default' && o.mode !== 'bypass') return null;
      if (o.model !== undefined && !matches(o.model, CHATV2_MODEL)) return null;
      parsed = { paneId, agent: o.agent as ChatV2Agent, mode: o.mode, ...(o.model ? { model: o.model as string } : {}) };
      break;
    }
    case 'bindingForPane':
    case 'subscribe':
    case 'unsubscribe':
      parsed = { paneId };
      break;
    case 'interrupt':
      if (!session) return null;
      if (o.epoch !== undefined && !matches(o.epoch, CHATV2_EPOCH)) return null;
      if (o.turnId !== undefined && !matches(o.turnId, CHATV2_BLOCK_ID)) return null;
      parsed = {
        ...session,
        ...(o.epoch !== undefined ? { epoch: o.epoch } : {}),
        ...(o.turnId !== undefined ? { turnId: o.turnId } : {}),
      };
      break;
    case 'snapshot':
    case 'toTerminal':
    case 'close':
      parsed = session;
      break;
    case 'history':
      if (!session || !matches(o.epoch, CHATV2_EPOCH) || !matches(o.beforeBlockId, CHATV2_BLOCK_ID)) return null;
      parsed = { ...session, epoch: o.epoch, beforeBlockId: o.beforeBlockId };
      break;
    case 'send': {
      if (!session || !matches(o.epoch, CHATV2_EPOCH)) return null;
      if (!matches(o.clientMessageId, CHATV2_CLIENT_MESSAGE_ID)) return null;
      if (typeof o.text !== 'string' || utf8Bytes(o.text) > CHATV2_MAX_PROMPT_BYTES) return null;
      if (!attachments(o.attachments)) return null;
      if (!o.text.trim() && !o.attachments?.length) return null;
      parsed = {
        ...session,
        epoch: o.epoch,
        clientMessageId: o.clientMessageId,
        text: o.text,
        ...(o.attachments ? { attachments: [...o.attachments] } : {}),
      };
      break;
    }
    case 'answer':
      if (!session || !id(o.requestId)) return null;
      if (o.decision !== 'allow' && o.decision !== 'deny') return null;
      if (o.answers !== undefined && !answers(o.answers)) return null;
      parsed = {
        ...session,
        requestId: o.requestId,
        decision: o.decision,
        ...(o.answers ? { answers: o.answers.map((a) => ({ keys: [...a.keys], ...(a.other !== undefined ? { other: a.other } : {}) })) } : {}),
      };
      break;
    case 'bodies':
      if (!session || !matches(o.epoch, CHATV2_EPOCH) || !matches(o.blockId, CHATV2_BLOCK_ID)) return null;
      if (o.field !== 'text' && o.field !== 'detail' && o.field !== 'output') return null;
      if (o.offset !== undefined && (!Number.isSafeInteger(o.offset) || (o.offset as number) < 0)) return null;
      parsed = { ...session, epoch: o.epoch, blockId: o.blockId, field: o.field, ...(o.offset !== undefined ? { offset: o.offset as number } : {}) };
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
