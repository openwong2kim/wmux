import {
  CHAT_LAUNCH_MAX_UNITS,
  OPENCODE_MAX_SEND_BYTES,
  fileHistoryEpoch,
  type ChatBlocked,
  type ChatLaunchOutcome,
  type ChatResolution,
  type ChatSendOutcome,
  type ChatSendTag,
} from '../chat/chatBridge';
import {
  validTerminalLaunchMode,
  type TerminalChatBinding,
  type TerminalLaunchAgent,
  type TerminalLaunchMode,
} from '../../shared/transcript/terminalChat';

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
export function buildChatObject(resolution: ChatResolution, blocked: ChatBlocked | undefined): Record<string, unknown> {
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
  return {
    binding: 'terminal',
    ...(agent ? { agent } : {}),
    ...identity,
    historyTruncated: terminal?.historyTruncated === true,
    ...(resolution.source === 'tui' ? { maxSendBytes: OPENCODE_MAX_SEND_BYTES } : {}),
    ...liveness,
    capabilities: {
      ...(terminal ? phoneTerminalCapabilities(terminal.capabilities) : closed),
      // Rollout and JSONL rows land per record, not per token. OpenCode part
      // streaming is unverified, so its key is omitted (= unknown).
      ...(resolution.source === 'file' ? { streaming: false } : {}),
      launch: false,
      skills: skillsAgent(agent),
    },
    ...blockedField,
  };
}

/**
 * The desktop's terminal capabilities, minus what the phone has no route for:
 * Stop (`cancel`, desktop-only ESC) and image attachments (`images`). `queue`
 * passes through; it pairs with a send's `queued:true`.
 */
type TerminalCapabilities = TerminalChatBinding['capabilities'];
function phoneTerminalCapabilities(capabilities: TerminalCapabilities): Omit<TerminalCapabilities, 'images'> {
  const { images, ...rest } = capabilities;
  void images;
  return { ...rest, cancel: false };
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
    default: return 409;
  }
}

/**
 * §6.2 response table. `effect` is the field the phone acts on; `result` stays
 * the desktop's verbatim enum so `unconfirmed` keeps the desktop meaning.
 */
export function sendResponse(outcome: ChatSendOutcome, clientMessageId: string): WireResponse {
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
