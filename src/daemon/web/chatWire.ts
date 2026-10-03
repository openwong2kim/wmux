import {
  CHAT_LAUNCH_MAX_UNITS,
  CHAT_MESSAGE_RETENTION_MS,
  OPENCODE_MAX_SEND_BYTES,
  checkChatId,
  fileHistoryEpoch,
  type ChatBlocked,
  type ChatCancelOutcome,
  type ChatCancelTag,
  type ChatDequeueResult,
  type ChatQueueItemView,
  type ChatLaunchOutcome,
  type ChatResolution,
  type ChatSendOutcome,
  type ChatSendTag,
  type ChatTurn,
} from '../chat/chatBridge';
import {
  validTerminalLaunchMode,
  type TerminalChatBinding,
  type TerminalLaunchAgent,
  type TerminalLaunchMode,
} from '../../shared/transcript/terminalChat';
import type { MetaEvent, ToolBody, TurnEvent } from '../../shared/transcript/turnEvents';
import type { AgentStatus } from '../../shared/types';
import { chatV2HistoryEpoch, type ChatV2Binding, type ChatV2Status } from '../../shared/chatv2/ipc';
import { truncateUtf8, utf8Bytes } from '../../shared/chatv2/limits';
import { HARNESS_TITLE, type Block, type Session, type ToolPreview, type TurnOutcome } from '../../shared/chatv2/session';
import type { ChatV2Host } from '../chat/v2/types';

/**
 * Wire mapping for the phone chat routes (contract §5.2, §6.2, §6.4). Pure, so
 * every table row is testable without a server; the route handlers own only
 * the principal gates.
 */

export interface WireResponse {
  status: number;
  body: Record<string, unknown>;
}

// --- /turns `chat` object -------------------------------------------------

/**
 * The bridge epoch for the resolution, or undefined when there is none.
 *
 * A file transcript has no native epoch. The bridge may supply one; when it
 * does not, the web server derives the same `h1:` value from the same inputs,
 * so a send that echoes it compares equal on the daemon side.
 */
export function resolutionEpoch(resolution: ChatResolution): string | undefined {
  if (resolution.source === 'none') return undefined;
  if (resolution.source !== 'file') return resolution.epoch;
  if (resolution.epoch) return resolution.epoch;
  const { status } = resolution;
  const agent = status.terminal?.agent;
  const agentSessionId = status.agentSessionId ?? status.terminal?.nativeSessionId;
  return agent && agentSessionId && status.transcriptBasename
    ? fileHistoryEpoch(agent, agentSessionId, status.transcriptBasename)
    : undefined;
}

export function resolutionAgentSessionId(resolution: ChatResolution): string | undefined {
  if (resolution.source === 'none') return undefined;
  return resolution.status.agentSessionId ?? resolution.status.terminal?.nativeSessionId;
}

/** Whether a resolution yields a readable conversation at all. */
export function hasConversation(resolution: ChatResolution): boolean {
  if (resolution.source === 'none') return false;
  if (resolution.source === 'file') return resolution.status.available;
  return true;
}

/** Skills catalogues exist only for the two launchable agents. */
function skillsAgent(agent: string | undefined): boolean {
  return agent === 'claude' || agent === 'codex';
}

/**
 * Build `chat` for a `/turns` body. Everything here is derived from the
 * resolution the daemon computed for this read; nothing is remembered between
 * reads, so the object can never describe a conversation the pane no longer
 * has. `rawEpoch` is never read — it is loopback-token material (N15).
 */
export function buildChatObject(
  resolution: ChatResolution,
  blocked: ChatBlocked | undefined,
  opts: { turn?: ChatTurn; chatCancel?: boolean; queue?: ChatQueueItemView[]; accountStatus?: boolean } = {},
): Record<string, unknown> {
  const { status } = resolution;
  const liveness = {
    ...(status.agentStatus !== undefined ? { agentStatus: status.agentStatus } : {}),
    ...(typeof status.agentAlive === 'boolean' ? { agentAlive: status.agentAlive } : {}),
  };
  const blockedField = blocked
    ? { blocked: { by: blocked.by, ...(blocked.approvalId ? { approvalId: blocked.approvalId } : {}) } }
    : {};
  const closed = { history: false, send: false, permissions: false, cancel: false, fileUndo: false };

  if (resolution.source === 'none' || !hasConversation(resolution)) {
    const launch = resolution.source === 'none' ? resolution.launch : undefined;
    return {
      binding: 'none',
      ...liveness,
      capabilities: {
        ...closed,
        launch: launch?.ready === true,
        // Only while a launcher could run: an agent that is not claude/codex
        // holding the pane (`agent-running`) has no catalogue `/commands` serves.
        skills: launch?.ready === true,
      },
      ...blockedField,
      ...(launch
        ? { launch: { ready: launch.ready, reason: launch.reason, agents: [...launch.agents], maxPromptUnits: launch.maxPromptUnits } }
        : {}),
    };
  }

  const agentSessionId = resolutionAgentSessionId(resolution);
  const historyEpoch = resolutionEpoch(resolution);
  const identity = {
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(historyEpoch ? { historyEpoch } : {}),
  };

  if (resolution.source === 'managed') {
    const managed = status.managed;
    return {
      binding: 'managed',
      ...identity,
      historyTruncated: managed?.historyTruncated === true,
      ...liveness,
      // Phone v1 never sends to a managed record (§6.7), so its capabilities
      // are projected onto the terminal keys with everything but history off.
      capabilities: { ...closed, history: true, launch: false, skills: false },
      ...blockedField,
      ...(managed ? { managed: { provider: { ...managed.provider }, phase: managed.phase } } : {}),
    };
  }

  const terminal = status.terminal;
  const agent = terminal?.agent;
  // `queue` is passed only for a `chat-queue` caller on a daemon whose queue
  // loaded: all three agents then queue in the daemon, so `send` stays open
  // while a turn runs. Without it the capabilities are today's, byte for byte.
  const queueing = opts.queue !== undefined && status.agentAlive === true && !!agent && QUEUE_AGENTS.includes(agent);
  const capabilities = terminal ? phoneTerminalCapabilities(terminal.capabilities, opts.chatCancel === true) : closed;
  return {
    binding: 'terminal',
    ...(agent ? { agent } : {}),
    ...identity,
    historyTruncated: terminal?.historyTruncated === true,
    ...(resolution.source === 'tui' ? { maxSendBytes: OPENCODE_MAX_SEND_BYTES } : {}),
    ...liveness,
    // Additive: the route passes it only to a caller that declared
    // `chat-cancel` or `chat-queue`, so an older client's object is unchanged.
    ...(opts.turn ? { turn: { ...opts.turn } } : {}),
    capabilities: {
      ...capabilities,
      ...(opts.queue !== undefined ? { queue: queueing, send: capabilities.send || queueing } : {}),
      // Rollout and JSONL rows land per record, not per token. OpenCode part
      // streaming is unverified, so its key is omitted (= unknown).
      ...(resolution.source === 'file' ? { streaming: false } : {}),
      launch: false,
      skills: skillsAgent(agent),
      // Contract v-next item 2: the pane's Codex account server answers
      // `GET …/codex/account-status`. Omitted otherwise.
      ...(opts.accountStatus === true && agent === 'codex' ? { accountStatus: true } : {}),
    },
    ...blockedField,
    ...(opts.queue !== undefined ? { queue: opts.queue.map((item) => ({ ...item })) } : {}),
  };
}

/** The agents whose sends the daemon queue can hold. */
const QUEUE_AGENTS: readonly string[] = ['claude', 'codex', 'opencode'];

/**
 * The desktop's terminal capabilities, minus what the phone has no route for:
 * image attachments (`images`), and Stop (`cancel`) unless the caller declared
 * `chat-cancel` — an older client keeps `cancel:false` byte for byte. `queue`
 * passes through; it pairs with a send's `queued:true`.
 */
type TerminalCapabilities = TerminalChatBinding['capabilities'];
function phoneTerminalCapabilities(capabilities: TerminalCapabilities, chatCancel: boolean): Omit<TerminalCapabilities, 'images'> {
  const { images, ...rest } = capabilities;
  void images;
  return { ...rest, cancel: chatCancel && capabilities.cancel };
}

// --- send -----------------------------------------------------------------

export interface SendBody {
  agentSessionId: string;
  historyEpoch: string;
  clientMessageId: string;
  text: string;
}

const SEND_KEYS = ['agentSessionId', 'historyEpoch', 'clientMessageId', 'text'] as const;

/**
 * Exactly the four string fields. Anything else (`mode`, `agent`, `cwd`, …) is
 * refused rather than ignored: a key the route does not understand is a
 * client that believes it is asking for something this route never does.
 */
export function parseSendBody(body: unknown): { ok: true; value: SendBody } | { ok: false; detail: string; clientMessageId?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, detail: 'body must be a JSON object' };
  const o = body as Record<string, unknown>;
  const cmid = typeof o.clientMessageId === 'string' ? o.clientMessageId : undefined;
  const extra = Object.keys(o).filter((k) => !(SEND_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) return { ok: false, detail: `unknown field: ${extra[0].slice(0, 64)}`, clientMessageId: cmid };
  for (const key of SEND_KEYS) {
    if (typeof o[key] !== 'string') return { ok: false, detail: `${key} must be a string`, clientMessageId: cmid };
  }
  return { ok: true, value: { agentSessionId: o.agentSessionId as string, historyEpoch: o.historyEpoch as string, clientMessageId: o.clientMessageId as string, text: o.text as string } };
}

function sendStatus(tag: ChatSendTag): number {
  switch (tag) {
    case 'authorization-expired': return 401;
    case 'text-too-long':
    case 'invalid-chat-request':
    case 'message-id-expired': return 400;
    case 'chat-persist-failed': return 500;
    case 'queue-full': return 429;
    default: return 409;
  }
}

/** `DELETE /api/sessions/:id/chat/queue/:clientMessageId`. */
export function dequeueResponse(result: ChatDequeueResult, clientMessageId: string): WireResponse {
  if (result.ok) return { status: 200, body: { state: 'canceled', clientMessageId } };
  if (result.error === 'queue-item-not-found') return { status: 404, body: { error: result.error, clientMessageId } };
  return {
    status: 409,
    body: { error: result.error, ...(result.state ? { state: result.state } : {}), ...(result.reason ? { reason: result.reason } : {}), clientMessageId },
  };
}

/**
 * §6.2 response table. `effect` is the field the phone acts on; `result` stays
 * the desktop's verbatim enum so `unconfirmed` keeps the desktop meaning.
 */
export function sendResponse(outcome: ChatSendOutcome, clientMessageId: string): WireResponse {
  if (outcome.queueState) {
    // The daemon queue holds (or held) the message: `effect` says what that
    // did to the pane so far. A replay answers 200 with the current state.
    const state = outcome.queueState;
    const effect = state === 'queued' || state === 'delivering' ? 'queued'
      : state === 'delivered' ? 'submitted' : state === 'uncertain' ? 'uncertain' : 'none';
    return {
      status: outcome.replayed ? 200 : 202,
      body: { state, ...(outcome.queueReason ? { reason: outcome.queueReason } : {}), replayed: outcome.replayed, clientMessageId, effect },
    };
  }
  if (outcome.pending) {
    // The one non-final answer: no effect, the client polls the receipt.
    return { status: 202, body: { state: 'pending', replayed: true, clientMessageId } };
  }
  // A final outcome without an effect cannot prove nothing was written.
  const effect = outcome.effect ?? 'uncertain';
  let response: WireResponse;
  if (!outcome.error && outcome.result === 'sent') {
    // `queued`: the agent's composer holds the prompt behind its running turn.
    response = { status: 202, body: { result: 'sent', replayed: false, clientMessageId, effect, ...(outcome.queued ? { queued: true } : {}) } };
  } else if (!outcome.error) {
    response = {
      status: 500,
      body: { error: 'chat-send-failed', ...(outcome.result ? { result: outcome.result } : {}), effect, clientMessageId },
    };
  } else {
    response = {
      status: sendStatus(outcome.error),
      body: {
        error: outcome.error,
        ...(outcome.result ? { result: outcome.result } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(outcome.blockedBy ? { blockedBy: outcome.blockedBy } : {}),
        ...(outcome.limit ? { limit: outcome.limit } : {}),
        ...(typeof outcome.maxSendBytes === 'number' ? { maxSendBytes: outcome.maxSendBytes } : {}),
        ...(outcome.agentSessionId ? { agentSessionId: outcome.agentSessionId } : {}),
        ...(outcome.historyEpoch ? { historyEpoch: outcome.historyEpoch } : {}),
        effect,
        clientMessageId,
      },
    };
  }
  if (outcome.replayed) {
    return { status: 200, body: { ...response.body, replayed: true } };
  }
  return response;
}

// --- launch ---------------------------------------------------------------

export interface LaunchBody {
  agent: TerminalLaunchAgent;
  mode: TerminalLaunchMode;
  confirm?: string;
  clientLaunchId: string;
  prompt: string;
}

const LAUNCH_KEYS = ['agent', 'mode', 'confirm', 'clientLaunchId', 'prompt'] as const;

/**
 * The launcher prompt rule, restated from `terminalLaunchCommand` so the route
 * refuses before any receipt exists: non-blank, ≤ 2,000 UTF-16 units, newline
 * allowed, every other C0 control and DEL refused.
 */
export function validLaunchPrompt(prompt: string): boolean {
  if (!prompt.trim() || prompt.length > CHAT_LAUNCH_MAX_UNITS) return false;
  for (const c of prompt) {
    const code = c.charCodeAt(0);
    if ((code < 32 && c !== '\n') || code === 127) return false;
  }
  return true;
}

export function parseLaunchBody(body: unknown): { ok: true; value: LaunchBody } | { ok: false; detail: string; clientLaunchId?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, detail: 'body must be a JSON object' };
  const o = body as Record<string, unknown>;
  const clid = typeof o.clientLaunchId === 'string' ? o.clientLaunchId : undefined;
  const refuse = (detail: string) => ({ ok: false as const, detail, clientLaunchId: clid });
  const extra = Object.keys(o).filter((k) => !(LAUNCH_KEYS as readonly string[]).includes(k));
  // Model, effort, args, cwd and env stay on `POST /api/sessions {agentLaunch}`.
  if (extra.length > 0) return refuse(`unknown field: ${extra[0].slice(0, 64)}`);
  if (o.agent !== 'claude' && o.agent !== 'codex') return refuse('agent must be claude or codex');
  if (o.mode !== undefined && o.mode !== 'default' && o.mode !== 'bypass' && o.mode !== 'yolo') return refuse('unknown mode');
  if (!validTerminalLaunchMode(o.agent, o.mode)) return refuse(`mode ${String(o.mode)} is not valid for ${o.agent}`);
  if (o.confirm !== undefined && typeof o.confirm !== 'string') return refuse('confirm must be a string');
  if (typeof o.clientLaunchId !== 'string') return refuse('clientLaunchId must be a string');
  if (typeof o.prompt !== 'string' || !validLaunchPrompt(o.prompt)) {
    return refuse(`prompt must be non-blank, at most ${CHAT_LAUNCH_MAX_UNITS} UTF-16 units, without control characters other than newline`);
  }
  return {
    ok: true,
    value: {
      agent: o.agent,
      mode: (o.mode ?? 'default') as TerminalLaunchMode,
      ...(typeof o.confirm === 'string' ? { confirm: o.confirm } : {}),
      clientLaunchId: o.clientLaunchId,
      prompt: o.prompt,
    },
  };
}

function launchStatus(tag: string): number {
  switch (tag) {
    case 'authorization-expired': return 401;
    case 'invalid-chat-request': return 400;
    case 'agent-runtime-unavailable':
    case 'launch-unconfirmed': return 502;
    default: return 409;
  }
}

/** §6.4 response table. */
export function launchResponse(outcome: ChatLaunchOutcome, clientLaunchId: string): WireResponse {
  if (outcome.ok) {
    return { status: 202, body: { ok: true, replayed: false, clientLaunchId, effect: 'submitted' } };
  }
  return {
    status: launchStatus(outcome.error),
    body: {
      error: outcome.error,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      effect: outcome.effect,
      clientLaunchId,
    },
  };
}

// --- cancel ---------------------------------------------------------------

export interface CancelBody {
  agentSessionId: string;
  clientCancelId: string;
  turnId?: string;
  historyEpoch?: string;
}

const CANCEL_REQUIRED = ['agentSessionId', 'clientCancelId'] as const;
const CANCEL_OPTIONAL = ['turnId', 'historyEpoch'] as const;

/** Two required strings, two optional ones; any other key is refused, as on send. */
export function parseCancelBody(body: unknown): { ok: true; value: CancelBody } | { ok: false; detail: string; clientCancelId?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, detail: 'body must be a JSON object' };
  const o = body as Record<string, unknown>;
  const ccid = typeof o.clientCancelId === 'string' ? o.clientCancelId : undefined;
  const known: readonly string[] = [...CANCEL_REQUIRED, ...CANCEL_OPTIONAL];
  const extra = Object.keys(o).filter((k) => !known.includes(k));
  if (extra.length > 0) return { ok: false, detail: `unknown field: ${extra[0].slice(0, 64)}`, clientCancelId: ccid };
  for (const key of CANCEL_REQUIRED) {
    if (typeof o[key] !== 'string') return { ok: false, detail: `${key} must be a string`, clientCancelId: ccid };
  }
  for (const key of CANCEL_OPTIONAL) {
    // Empty is refused, not read as absent: the receipt fingerprint could not tell them apart.
    if (o[key] !== undefined && (typeof o[key] !== 'string' || !(o[key] as string) || (o[key] as string).length > 256)) {
      return { ok: false, detail: `${key} must be a non-empty string when present`, clientCancelId: ccid };
    }
  }
  return {
    ok: true,
    value: {
      agentSessionId: o.agentSessionId as string,
      clientCancelId: o.clientCancelId as string,
      ...(typeof o.turnId === 'string' ? { turnId: o.turnId } : {}),
      ...(typeof o.historyEpoch === 'string' ? { historyEpoch: o.historyEpoch } : {}),
    },
  };
}

function cancelStatus(tag: ChatCancelTag): number {
  switch (tag) {
    case 'authorization-expired': return 401;
    case 'invalid-chat-request':
    case 'message-id-expired': return 400;
    case 'cancel-unsupported': return 422;
    case 'message-history-full': return 507;
    case 'chat-persist-failed':
    case 'cancel-failed': return 500;
    default: return 409;
  }
}

/**
 * Cancel response table. 202 means one ESC was written for `turnId`; whether
 * the agent stopped shows later as `chat.turn.state` (an interrupt fires no
 * Stop hook, so `running` can linger briefly).
 */
export function cancelResponse(outcome: ChatCancelOutcome): WireResponse {
  const { clientCancelId, effect } = outcome;
  let response: WireResponse;
  if (!outcome.error) {
    response = { status: 202, body: { result: 'sent', replayed: false, ...(outcome.turnId ? { turnId: outcome.turnId } : {}), clientCancelId, effect,
      ...(outcome.cancel ? { cancel: outcome.cancel } : {}), ...(outcome.escRefused ? { escRefused: outcome.escRefused } : {}) } };
  } else {
    response = {
      status: cancelStatus(outcome.error),
      body: {
        error: outcome.error,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(outcome.turn ? { turn: { id: outcome.turn.id, state: outcome.turn.state } } : {}),
        ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
        ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
        ...(outcome.by ? { by: outcome.by } : {}),
        ...(typeof outcome.retryAfterMs === 'number' ? { retryAfterMs: outcome.retryAfterMs } : {}),
        ...(outcome.agentSessionId ? { agentSessionId: outcome.agentSessionId } : {}),
        ...(outcome.historyEpoch ? { historyEpoch: outcome.historyEpoch } : {}),
        effect,
        clientCancelId,
      },
    };
  }
  // A replayed success is 200; a replayed failure keeps its status (an
  // uncertain ESC stays 500) and only gains `replayed:true`.
  if (!outcome.replayed) return response;
  return { status: outcome.error ? response.status : 200,
    body: { ...response.body, replayed: true, ...(outcome.cancel ? { cancel: outcome.cancel } : {}) } };
}

// --- chat v2 (driver-owned conversations) ---------------------------------

/**
 * What the phone routes read from the chat-v2 host. A record that is
 * `handed-off` is not served here: its conversation now runs in the pane's
 * TUI, so the ordinary terminal binding describes it.
 */
export type ChatV2PhoneHost = Pick<ChatV2Host, 'bindingForPane' | 'sessionForPane' | 'call' | 'onPush'>;

/** Inline head of one tool body; v2 rows have no `srcOffset`, so the head is all a phone can open. */
const CHATV2_INLINE_BODY_BYTES = 4 * 1024;
/** Meta labels are one line in the phone's row; the block itself keeps the full text. */
const CHATV2_LABEL_MAX = 500;
/** The same bounds a managed page keeps (ChatSessionService.snapshot). */
const CHATV2_PAGE_MAX_EVENTS = 80;
const CHATV2_PAGE_MAX_BYTES = 192_000;

const TOOL_DONE = new Set(['completed', 'success', 'failed', 'error', 'cancelled', 'canceled']);
const TOOL_FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolBody(text: string): ToolBody {
  const bytes = utf8Bytes(text);
  if (bytes <= CHATV2_INLINE_BODY_BYTES) return { n: 1, bytes, inline: text };
  return { n: 1, bytes, inline: truncateUtf8(text, CHATV2_INLINE_BODY_BYTES), truncated: true };
}

function previewText(preview: ToolPreview | undefined): string | undefined {
  if (!preview) return undefined;
  if (preview.output) return preview.output;
  if (!preview.lines?.length) return undefined;
  const mark = { add: '+', del: '-', context: ' ' } as const;
  return preview.lines.map((line) => `${mark[line.kind]} ${line.text}`).join('\n');
}

function meta(id: string, subtype: MetaEvent['subtype'], label: string, ts?: number): MetaEvent {
  return { id, kind: 'meta', subtype, label: oneLine(label, CHATV2_LABEL_MAX), ...(ts !== undefined ? { ts } : {}) };
}

const ABORTED_LABEL: Record<Exclude<TurnOutcome, 'completed'>, string> = {
  interrupted: 'Interrupted',
  failed: 'The turn failed',
  'usage-limited': 'Usage limit reached',
};

const APPROVAL_LABEL = { allow: 'Allowed', deny: 'Denied', cancelled: 'Approval cancelled' } as const;

/** The rows one folded block reads as on the phone. Pure; ids derive from the block id. */
export function projectChatV2Block(block: Block): TurnEvent[] {
  const truncated = block.overflow?.text ? { truncated: true } : {};
  switch (block.role) {
    case 'user': {
      const images = block.attachments?.map((a) => a.path) ?? [];
      return [{
        id: block.id, kind: 'user_text', text: block.text, ...truncated,
        ...(block.startedAt !== undefined ? { ts: block.startedAt } : {}),
        ...(images.length ? { hasImage: true, images } : {}),
      }];
    }
    case 'assistant':
      return block.text ? [{ id: block.id, kind: 'assistant_text', text: block.text, ...truncated }] : [];
    case 'reasoning':
      return block.text ? [{ id: block.id, kind: 'assistant_text', text: block.text, thinking: true, ...truncated }] : [];
    case 'plan':
      return block.text ? [{ id: block.id, kind: 'assistant_text', text: block.text, ...truncated }] : [];
    case 'tasks': {
      const list = block.taskList;
      if (!list?.items.length) return [];
      const lines = list.items.map((item) =>
        `- [${item.status === 'completed' ? 'x' : ' '}] ${item.text}${item.status === 'in_progress' ? ' (in progress)' : ''}`);
      return [{ id: block.id, kind: 'assistant_text', text: [list.explanation, ...lines].filter(Boolean).join('\n') }];
    }
    case 'image':
      return [meta(block.id, 'unknown', `Image: ${block.image?.name ?? 'generated image'}`)];
    case 'system':
      if (block.notice === 'interrupt') return [meta(block.id, 'turn_aborted', block.text || 'Interrupted')];
      return block.text ? [meta(block.id, 'unknown', block.text)] : [];
    case 'tool':
    case 'approval':
      return projectToolBlock(block);
    default:
      return [];
  }
}

function projectToolBlock(block: Block): TurnEvent[] {
  const tool = block.tool;
  const toolUseId = tool?.callId ?? block.id;
  const name = tool?.title || block.text || tool?.kind || 'Tool';
  const preview = tool?.preview;
  const summary = preview?.path ?? preview?.query ?? (tool?.detail ? tool.detail : '');
  const rows: TurnEvent[] = [{
    id: block.id, kind: 'tool_use', toolUseId, name: oneLine(name, 120), argSummary: oneLine(summary, 120),
    ...(tool?.detail ? { input: toolBody(tool.detail) } : {}),
  }];
  const run = block.agentRun;
  if (run) {
    rows.push(meta(`${block.id}:agent`, 'subagent', `${run.name}: ${run.steps.length} step${run.steps.length === 1 ? '' : 's'}`));
  }
  const approval = block.approval;
  if (approval) {
    rows.push(meta(`${block.id}:approval`, 'unknown',
      approval.decided ? APPROVAL_LABEL[approval.decided] : `Waiting for approval: ${name}`, approval.requestedAt));
  }
  const status = tool?.status;
  if (status && TOOL_DONE.has(status)) {
    const output = previewText(preview);
    rows.push({
      id: `${block.id}:result`, kind: 'tool_result', toolUseId, ok: !TOOL_FAILED.has(status),
      bytes: output ? utf8Bytes(output) : 0,
      ...(output ? { output: toolBody(output) } : {}),
    });
  }
  return rows;
}

/**
 * The phone rows of a whole folded session, oldest first. A turn that did not
 * complete closes with a `turn_aborted` row; a pending question is the last
 * row (it is answered through `/api/approvals`, like the approval rows).
 */
export function projectChatV2Session(session: Readonly<Session>): TurnEvent[] {
  const rows: TurnEvent[] = [];
  let openUser: Block | undefined;
  const closeTurn = () => {
    if (openUser?.outcome && openUser.outcome !== 'completed') {
      rows.push(meta(`${openUser.id}:end`, 'turn_aborted', ABORTED_LABEL[openUser.outcome]));
    }
  };
  for (const block of session.blocks) {
    if (block.role === 'user') {
      closeTurn();
      openUser = block;
    }
    rows.push(...projectChatV2Block(block));
  }
  closeTurn();
  const question = session.pendingQuestion;
  if (question) {
    const first = question.questions[0];
    rows.push(meta(`question:${question.requestId}`, 'unknown',
      `Question: ${question.title ?? first?.header ?? first?.prompt ?? 'the agent is asking'}`, question.requestedAt));
  }
  return rows;
}

/** The tail of the rows within the managed page bounds; always at least one row when there is one. */
export function chatV2Page(session: Readonly<Session>): { events: TurnEvent[]; truncatedHead: boolean } {
  const all = projectChatV2Session(session);
  let start = all.length;
  let bytes = 0;
  while (start > 0 && all.length - start < CHATV2_PAGE_MAX_EVENTS) {
    const size = utf8Bytes(JSON.stringify(all[start - 1]));
    if (bytes + size > CHATV2_PAGE_MAX_BYTES && start < all.length) break;
    bytes += size;
    start--;
  }
  return { events: all.slice(start), truncatedHead: start > 0 };
}

/** The open (or last) turn, keyed by its user block id. */
export function chatV2Turn(session: Readonly<Session>): ChatTurn | undefined {
  const user = [...session.blocks].reverse().find((block) => block.role === 'user');
  if (!user) return undefined;
  return { id: user.id, state: session.busy ? 'running' : 'idle', ...(user.startedAt !== undefined ? { startedAt: user.startedAt } : {}) };
}

/** The identity a phone holds for a v2 record: the agent's id once bound, the record's id before. */
export function chatV2Identity(binding: ChatV2Binding): { agentSessionId: string; historyEpoch: string } {
  return {
    agentSessionId: binding.providerSessionId ?? binding.chatSessionId,
    historyEpoch: chatV2HistoryEpoch(binding.chatSessionId, binding.epoch),
  };
}

const V2_STATE: Record<Exclude<ChatV2Status, 'handed-off'>, { agentStatus: AgentStatus; agentAlive: boolean; phase: string }> = {
  starting: { agentStatus: 'running', agentAlive: true, phase: 'connecting' },
  idle: { agentStatus: 'idle', agentAlive: true, phase: 'ready' },
  running: { agentStatus: 'running', agentAlive: true, phase: 'running' },
  'needs-input': { agentStatus: 'awaiting_input', agentAlive: true, phase: 'blocked' },
  stopped: { agentStatus: 'idle', agentAlive: false, phase: 'disconnected' },
  failed: { agentStatus: 'error', agentAlive: false, phase: 'disconnected' },
};

/**
 * `/turns` `chat` for a v2 record: the managed object's keys exactly, plus
 * `streaming:false`. Read + approve only: `send` stays false (the route answers
 * `409 managed-read-only`). `cancel` and `turn` are shown only to a caller that
 * declared `chat-cancel`, as on a terminal binding.
 */
export function buildChatV2Object(
  binding: ChatV2Binding,
  session: Readonly<Session> | null,
  blocked: ChatBlocked | undefined,
  opts: { chatCancel?: boolean } = {},
): Record<string, unknown> {
  const state = V2_STATE[binding.status === 'handed-off' ? 'stopped' : binding.status];
  const turn = opts.chatCancel && session ? chatV2Turn(session) : undefined;
  return {
    binding: 'managed',
    ...chatV2Identity(binding),
    historyTruncated: false,
    agentStatus: state.agentStatus,
    agentAlive: state.agentAlive,
    capabilities: {
      history: true, send: false, permissions: false,
      cancel: opts.chatCancel === true && binding.capabilities.interrupt && session?.busy === true,
      fileUndo: false, streaming: false, launch: false, skills: false,
    },
    ...(blocked ? { blocked: { by: blocked.by, ...(blocked.approvalId ? { approvalId: blocked.approvalId } : {}) } } : {}),
    ...(turn ? { turn } : {}),
    managed: { provider: { id: binding.agent, name: HARNESS_TITLE[binding.agent] }, phase: state.phase },
  };
}

/** The send refusal a v2 record answers, the same body a managed record gets. */
export function chatV2SendResponse(clientMessageId: string): WireResponse {
  return sendResponse({ clientMessageId, replayed: false, effect: 'none', error: 'managed-read-only' }, clientMessageId);
}

/** The launch refusal on a pane a v2 record owns: a second agent would be a second writer. */
export function chatV2LaunchResponse(clientLaunchId: string): WireResponse {
  return launchResponse({ ok: false, error: 'launch-not-ready', reason: 'agent-running', effect: 'none' }, clientLaunchId);
}

/** Owner-bound cancel receipts for v2 records, memory only and bounded: a replay, never a second interrupt. */
export class ChatV2CancelReceipts {
  private readonly entries = new Map<string, { fingerprint: string; outcome: ChatCancelOutcome }>();
  constructor(private readonly max = 256) {}

  get(key: string): { fingerprint: string; outcome: ChatCancelOutcome } | undefined {
    return this.entries.get(key);
  }

  set(key: string, fingerprint: string, outcome: ChatCancelOutcome): void {
    this.entries.delete(key);
    this.entries.set(key, { fingerprint, outcome });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
  }
}

export interface ChatV2CancelInput {
  owner: string;
  paneId: string;
  body: CancelBody;
  now: number;
  host: ChatV2PhoneHost;
  receipts: ChatV2CancelReceipts;
  /** Re-authorization immediately before the interrupt; false sends nothing. */
  authorized: () => Promise<boolean>;
}

/**
 * `POST …/chat/cancel` on a v2 record: the host's `interrupt`, under the
 * cancel response table. A refusal stores no receipt; a sent or uncertain
 * interrupt does, so a retry replays instead of interrupting the next turn.
 */
export async function chatV2Cancel(input: ChatV2CancelInput): Promise<ChatCancelOutcome> {
  const { body, receipts } = input;
  const { clientCancelId } = body;
  const refuse = (error: ChatCancelTag, extra: Partial<ChatCancelOutcome> = {}): ChatCancelOutcome =>
    ({ clientCancelId, replayed: false, effect: 'none', error, ...extra });
  const idCheck = checkChatId(clientCancelId, input.now, CHAT_MESSAGE_RETENTION_MS);
  if (idCheck === 'invalid') return refuse('invalid-chat-request', { detail: 'clientCancelId' });
  if (idCheck === 'expired') return refuse('message-id-expired');

  const key = JSON.stringify([input.owner, input.paneId, clientCancelId]);
  const fingerprint = JSON.stringify([body.agentSessionId, body.turnId ?? null, body.historyEpoch ?? null]);
  const stored = receipts.get(key);
  if (stored) return stored.fingerprint === fingerprint ? { ...stored.outcome, replayed: true } : refuse('cancel-id-conflict');

  const binding = input.host.bindingForPane(input.paneId);
  const session = input.host.sessionForPane(input.paneId);
  if (!binding || binding.status === 'handed-off' || !session) return refuse('chat-unavailable');
  const identity = chatV2Identity(binding);
  if (body.agentSessionId !== identity.agentSessionId || (body.historyEpoch !== undefined && body.historyEpoch !== identity.historyEpoch)) {
    return refuse('session-changed', identity);
  }
  if (!binding.capabilities.interrupt) return refuse('cancel-unsupported');
  const turn = chatV2Turn(session);
  if (!turn || !session.busy || (body.turnId !== undefined && body.turnId !== turn.id)) {
    return refuse('turn-not-running', turn ? { turn } : {});
  }
  if (!(await input.authorized())) return refuse('authorization-expired');

  let outcome: ChatCancelOutcome;
  try {
    const result = await input.host.call('interrupt', { paneId: input.paneId, chatSessionId: binding.chatSessionId }, 'web');
    if (result.ok && result.interrupted) {
      outcome = { clientCancelId, replayed: false, effect: 'interrupt-requested', turnId: turn.id };
    } else if (result.ok) {
      return refuse('turn-not-running', { turn: { ...turn, state: 'idle' } });
    } else if (result.error.code === 'driver-failed') {
      outcome = { clientCancelId, replayed: false, effect: 'uncertain', error: 'cancel-failed', turnId: turn.id };
    } else if (result.error.code === 'session-not-found' || result.error.code === 'stale-epoch') {
      return refuse('session-changed', identity);
    } else {
      return refuse('chat-unavailable', { detail: result.error.code });
    }
  } catch {
    outcome = { clientCancelId, replayed: false, effect: 'uncertain', error: 'cancel-failed', turnId: turn.id };
  }
  receipts.set(key, fingerprint, outcome);
  return outcome;
}
