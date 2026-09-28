import { randomUUID } from 'node:crypto';
import { agentDisplayToSlug } from '../../shared/agentIdentity';
import { isBrainPty } from '../../shared/constants';
import type { AgentStatus } from '../../shared/types';
import type { ChatSkillCatalog } from '../../shared/transcript/chatSkills';
import type { TerminalLaunchAgent } from '../../shared/transcript/terminalChat';
import type { ChatInterruptResult, ChatSendResult, TranscriptPage, TranscriptStatus } from '../../shared/transcript/turnEvents';
import type { AgentLaunchOptions } from '../web/agentLaunch';
import { buildAgentLaunch } from '../web/agentLaunch';
import { screenBlocksChatSend } from '../transcript/chatScreenGate';
import { deliverChatPrompt, type ChatScreenRows } from '../transcript/deliverChatPrompt';
import { INTERRUPT_COOLDOWN_MS, interruptChatTurn, type ChatInterruptVerdict } from '../transcript/interruptChatTurn';
import { codexRuntimeEnv, terminalLaunchCommand } from '../transcript/terminalLaunch';
import type { TerminalChatFailure, TerminalChatService } from '../transcript/TerminalChatService';
import type { ChatSessionService } from './ChatSessionService';
import { ChatSendReceiptStore, type StoredChatOutcome } from './ChatSendReceiptStore';
import { ChatCancelReceiptStore } from './ChatCancelReceiptStore';
import {
  CHAT_LAUNCH_MAX_UNITS, CHAT_MESSAGE_RETENTION_MS, CHAT_SEND_MAX_UNITS, OPENCODE_MAX_SEND_BYTES, OPENCODE_REQUEST_MAX_BYTES,
  checkChatId, fileHistoryEpoch, openCodeSendBytes, tuiHistoryEpoch,
  type ChatBlocked, type ChatBridge, type ChatCancelOutcome, type ChatCancelRequest, type ChatCancelTag, type ChatEffect, type ChatLaunchOutcome, type ChatLaunchPreview, type ChatLaunchReason,
  type ChatLaunchRequest, type ChatLaunchTag, type ChatOwner, type ChatResolution, type ChatSendOutcome, type ChatSendRequest,
  type ChatSendTag, type ChatTurn, type DangerousLaunchTrace,
} from './chatBridge';

/** Synthetic TerminalChatService client key for the phone's OpenCode watch. */
export const WEB_BRIDGE_CLIENT = 'web:bridge';

/** The parts of a daemon pane the bridge reads. `ManagedSession` satisfies it. */
export interface ChatPane {
  meta: {
    id: string; state: string; pid: number; cwd: string; env: Record<string, string>;
    exec?: unknown; wslTarget?: unknown; spawnCwd?: string; incarnationId?: string;
  };
  bridge: {
    isEmptyShellPrompt(): boolean; getInputRevision(): number; noteInput(data: string): void;
    /** When a lone ESC last reached the pane, from any source (0 = never). */
    getLastEscAt(): number;
    /** The latest window title the program set, and when (`at` 0 = never). */
    getTitle(): { title: string; at: number };
  };
  promptLog: { readonly size: number; isCommandRunning(): boolean };
  ptyProcess: { write(data: string): void };
}

export interface ChatAgentState {
  agentName: string | null;
  agentVerified: boolean;
  agentStatus: AgentStatus;
  inputQuiet: boolean;
  inputRevision: number;
  incarnationId: string | null;
  /** The pane's running episode; absent when the pane has no PTY bridge. */
  turn?: ChatTurn;
}

export interface LaunchRelay { url: string; commit(): boolean; close(): Promise<void> }

export interface NativeChatBridgeDeps<P extends ChatPane> {
  pane(id: string): P | undefined;
  /** Canonical daemon agent state (cheap). */
  agentState(id: string): ChatAgentState;
  /** Chat-refined agent state (reads the transcript tail for Claude/Codex). */
  chatAgentState(id: string): ChatAgentState;
  projector: { status(id: string): TranscriptStatus; snapshot(id: string, opts?: { before: number }): TranscriptPage | null };
  terminalChat(): Pick<TerminalChatService, 'read' | 'send' | 'subscribe' | 'unsubscribe'> & Partial<Pick<TerminalChatService, 'inspect' | 'abort'>> | null;
  managed(): Pick<ChatSessionService, 'has' | 'status' | 'snapshot' | 'send' | 'conversationEpoch'> | null;
  /**
   * Null while the approval registry is not wired: treated as "may be pending".
   * `pendingFor` names the pane's pending record and its kind.
   */
  approvals(): { pendingFor(id: string): { id: string; kind: string; answerable?: boolean } | undefined } | null;
  readScreen(id: string): Promise<ChatScreenRows | null>;
  agentProcessAlive(id: string, slug: string): Promise<boolean>;
  /** Writes to the pane PTY and notes the input; false when the pane is gone. */
  write(id: string, data: string): boolean;
  /** Null when the store could not be loaded: the phone refuses, the desktop sends without dedup. */
  receipts: ChatSendReceiptStore | null;
  /** Null when the store could not be loaded: phone cancels are refused. */
  cancelReceipts: ChatCancelReceiptStore | null;
  idleShell(pid: number, env: NodeJS.ProcessEnv): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'unsupported-shell' | 'shell-has-children' }>;
  installedAgents(env: NodeJS.ProcessEnv): Promise<AgentLaunchOptions[]>;
  relays: {
    retire(id: string): Promise<void>;
    prepare(id: string, pane: P): Promise<LaunchRelay>;
    /** The "account server not there yet" failures that justify starting the runtime. */
    unavailable(error: unknown): boolean;
    selection(id: string, pane: P): { cwd?: string } | undefined;
  };
  startCodexRuntime(env: NodeJS.ProcessEnv): Promise<void>;
  loadSkills(agent: string, cwd: string, env: Record<string, string | undefined>): Promise<ChatSkillCatalog>;
  log(level: 'info' | 'warn', message: string): void;
  /** Host desktop notification for a pane. */
  notify(paneId: string, title: string, body: string): void;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Paste→Enter delay override (tests). */
  delay?: (ms: number) => Promise<void>;
}

/** How the desktop RPCs dispatch a pane (contract §2.1). */
export type ChatRoute =
  | { kind: 'native'; read: NonNullable<Awaited<ReturnType<TerminalChatService['read']>>> }
  | { kind: 'opencode'; failure?: TerminalChatFailure } | { kind: 'managed' } | { kind: 'file' };

export interface NativeChatBridge extends ChatBridge {
  route(id: string): Promise<ChatRoute>;
  /** `daemon.transcript.status`, byte-identical to the pre-bridge answer. */
  status(id: string): Promise<TranscriptStatus>;
  /** `daemon.transcript.snapshot`. */
  snapshot(id: string, before?: number): Promise<TranscriptPage | null>;
  /** `daemon.transcript.send`: never refuses a desktop request id, mints one instead. */
  desktopSend(req: { id: string; agentSessionId: string; text: string; requestId: unknown; attachments?: readonly string[] }):
    Promise<{ result: ChatSendResult; effect?: ChatEffect; replayed: boolean; pending?: true; queued?: true }>;
  /**
   * `daemon.transcript.interrupt`: the desktop Stop, through the same lock,
   * once-per-turn latch and cooldown as the phone cancel. No receipt.
   */
  desktopInterrupt(id: string, agentSessionId: string): Promise<ChatInterruptResult>;
  /** A file-binding send is between its first check and its last write (Stop must wait). */
  sendInFlight(id: string): boolean;
  /**
   * The write-time approval fence for a chat write (send or Stop): any pending
   * record of any kind, or no registry at all. Kind-blind by design.
   */
  hasOpenApproval(id: string): boolean;
  /** `daemon.chat.skills`: the desktop keeps its live-cwd fallback. */
  desktopSkills(id: string, agent: unknown): Promise<ChatSkillCatalog>;
}

const UNAVAILABLE_SKILLS: ChatSkillCatalog = { skills: [], state: 'unavailable' };
const RELAY_URL = /^unix:\/\/\/[A-Za-z0-9_./-]+$/;
/** A send waits this long after any lone ESC, so a paste cannot extend it into an escape sequence. */
export const ESC_QUIET_MS = 300;
const slugOf = (state: ChatAgentState) => agentDisplayToSlug(state.agentName ?? '');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const liveState = (pane: ChatPane) => ['attached', 'detached'].includes(pane.meta.state);

/** Result for desktop callers when the outcome carries no verdict of its own. */
const DESKTOP_RESULT: Partial<Record<ChatSendTag, ChatSendResult>> = {
  'no-conversation': 'unavailable', 'managed-read-only': 'unavailable', 'message-history-full': 'unavailable',
  'chat-persist-failed': 'unavailable',
};

export function createChatBridge<P extends ChatPane>(deps: NativeChatBridgeDeps<P>): NativeChatBridge {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const launching = new Set<string>();
  const sending = new Set<string>();
  const lastEscAt = (id: string): number => deps.pane(id)?.bridge.getLastEscAt() ?? 0;

  const route = async (id: string): Promise<ChatRoute> => {
    const service = deps.terminalChat();
    const inspected = service?.inspect ? await service.inspect(id) : { read: await service?.read(id) ?? null };
    const read = 'read' in inspected ? inspected.read : null;
    if (read) return { kind: 'native', read };
    const live = deps.agentState(id);
    if (slugOf(live) === 'opencode') return { kind: 'opencode', ...('failure' in inspected ? { failure: inspected.failure } : {}) };
    if (!live.agentName && !deps.projector.status(id).available && deps.managed()?.has(id)) return { kind: 'managed' };
    return { kind: 'file' };
  };

  /** The projector status with the daemon's own `send` overlay (never the projector's). */
  const fileStatus = (id: string): TranscriptStatus => {
    const status = deps.projector.status(id);
    const live = deps.chatAgentState(id);
    const slug = slugOf(live);
    const agentAlive = !!slug && slug === status.terminal?.agent && live.agentVerified;
    return { ...status, agentStatus: live.agentStatus, agentAlive,
      ...(status.terminal ? { terminal: { ...status.terminal, capabilities: { ...status.terminal.capabilities,
        send: agentAlive && ['claude', 'codex'].includes(slug!),
        cancel: agentAlive && ['claude', 'codex'].includes(slug!),
        images: agentAlive && slug === 'claude',
        queue: agentAlive && slug === 'claude',
      } } } : {}) };
  };

  // installedAgentLaunchOptions caches its two `--help` probes for 5 minutes,
  // but reads the Codex model cache on every call; the preview runs on every
  // phone read of an idle pane, so the names are held briefly here too.
  const installedCache = new Map<string, { until: number; agents: Promise<TerminalLaunchAgent[]> }>();
  const installed = (pane: P | undefined): Promise<TerminalLaunchAgent[]> => {
    const env = { ...process.env, ...pane?.meta.env };
    const key = env.CODEX_HOME ?? '';
    const cached = installedCache.get(key);
    if (cached && cached.until > now()) return cached.agents;
    const agents = deps.installedAgents(env).then(
      options => options.map(option => option.agent).filter((agent): agent is TerminalLaunchAgent => agent === 'claude' || agent === 'codex'),
      () => [] as TerminalLaunchAgent[]);
    if (installedCache.size >= 16) installedCache.clear();
    installedCache.set(key, { until: now() + 5000, agents });
    return agents;
  };

  const unsupportedPlatform = (pane: ChatPane) => platform === 'win32' || !!pane.meta.wslTarget;

  /** Launch readiness in the launch's own order, without enumerating processes. */
  const notReady = (id: string, pane: P | undefined, revision?: number): ChatLaunchReason | undefined => {
    if (!pane || deps.pane(id) !== pane || !liveState(pane) || pane.meta.exec || pane.promptLog.size === 0) return 'not-integrated';
    const approvals = deps.approvals();
    if (!approvals || approvals.pendingFor(id)) return 'approval-pending';
    if (pane.promptLog.isCommandRunning()) return 'shell-busy';
    if (!pane.bridge.isEmptyShellPrompt() || revision !== undefined && pane.bridge.getInputRevision() !== revision) return 'shell-not-empty';
    return undefined;
  };

  const preview = async (id: string, agentRunning: boolean): Promise<ChatLaunchPreview> => {
    const pane = deps.pane(id);
    const reason: ChatLaunchReason = agentRunning ? 'agent-running'
      : launching.has(id) ? 'launch-pending'
        : pane && unsupportedPlatform(pane) ? 'unsupported-shell'
          : notReady(id, pane) ?? 'ok';
    return { ready: reason === 'ok', reason, agents: await installed(pane), maxPromptUnits: CHAT_LAUNCH_MAX_UNITS };
  };

  const resolve = async (id: string): Promise<ChatResolution> => {
    const found = await route(id);
    if (found.kind === 'native') {
      const { status, page } = found.read;
      if (!status.available) return { source: 'none', status, launch: await preview(id, true) };
      const rawEpoch = page.cursor.historyEpoch ?? '';
      const { turn } = found.read;
      return { source: 'tui', status, page, epoch: tuiHistoryEpoch(rawEpoch), rawEpoch, ...(turn ? { turn } : {}) };
    }
    if (found.kind === 'opencode') {
      const cause = found.failure === 'no-record' ? 'opencode-plugin-missing' as const
        : found.failure === 'transport-refused' ? 'opencode-plugin-unreachable' as const : undefined;
      return { source: 'none', status: { available: false, reason: 'unavailable' }, launch: await preview(id, true), ...(cause ? { cause } : {}) };
    }
    if (found.kind === 'managed') {
      const managed = deps.managed();
      const status = managed?.status(id);
      const epoch = managed?.conversationEpoch(id);
      if (status && epoch) return { source: 'managed', status, epoch };
    }
    const status = fileStatus(id);
    if (status.available) {
      // The web layer derives the same value when this is absent; keep them one formula.
      const agent = status.terminal?.agent;
      const nativeId = status.agentSessionId ?? status.terminal?.nativeSessionId;
      const epoch = agent && nativeId && status.transcriptBasename
        ? fileHistoryEpoch(agent, nativeId, status.transcriptBasename) : undefined;
      return { source: 'file', status, ...(epoch ? { epoch } : {}) };
    }
    return { source: 'none', status, launch: await preview(id, !!deps.agentState(id).agentName) };
  };

  const hasConversation = async (id: string): Promise<boolean> => {
    const found = await resolve(id);
    return found.source !== 'none' || found.status.available || !!found.status.agentSessionId ||
      found.launch.reason === 'agent-running' || !!deps.managed()?.has(id);
  };

  /**
   * The write-time fence: true for ANY pending record, whatever its kind, and
   * when the registry is not wired. Checked right before each chat write.
   * Deliberately kind-blind — a `terminal_prompt` is the agent's own dialog on
   * screen, and a paste + Enter into it would answer it.
   */
  const hasOpenApproval = (id: string): boolean => {
    const approvals = deps.approvals();
    return !approvals || !!approvals.pendingFor(id);
  };

  /**
   * What the phone is TOLD blocked it. Only this maps kind: a `terminal_prompt`
   * is answered in the pane, so it reads as `terminal`, like any other dialog
   * on screen; the other kinds are answered through the approval.
   */
  const blockedBy = (id: string): 'approval' | 'terminal' => {
    const approvals = deps.approvals();
    if (!approvals) return 'approval';
    const pending = approvals.pendingFor(id);
    return pending && pending.kind !== 'terminal_prompt' ? 'approval' : 'terminal';
  };

  const blocked = async (id: string, resolution: ChatResolution): Promise<ChatBlocked | undefined> => {
    const pane = deps.pane(id);
    // Producer-side gate: the orchestrator brain's pane never shows chat state.
    if (isBrainPty({ id, env: pane?.meta.env })) return undefined;
    const pending = deps.approvals()?.pendingFor(id);
    // A terminal_prompt reads as the terminal; the web layer lifts it to an
    // approval only for a capable caller and an answerable record.
    if (pending) {
      return pending.kind === 'terminal_prompt'
        ? { by: 'terminal', terminalPrompt: { approvalId: pending.id, answerable: pending.answerable === true } }
        : { by: 'approval', approvalId: pending.id };
    }
    if (resolution.source === 'managed') return undefined;
    if (resolution.status.agentStatus === 'awaiting_input' || deps.agentState(id).agentStatus === 'awaiting_input') return { by: 'terminal' };
    // The same screen gate the send runs, so a dialog that stays open shows on
    // every read rather than only after a refused send. Never stored.
    if (resolution.source === 'file' && resolution.status.terminal?.capabilities.send) {
      let rows: readonly string[] | null = null;
      try { rows = await deps.readScreen(id); } catch { /* unreadable = blocked */ }
      if (screenBlocksChatSend(rows)) return { by: 'terminal' };
    }
    return undefined;
  };

  // ---------------------------------------------------------------------------
  // Send

  const refuse = (clientMessageId: string, error: ChatSendTag, extra: Partial<ChatSendOutcome> = {}): ChatSendOutcome =>
    ({ clientMessageId, replayed: false, effect: 'none', error, ...extra });

  const replay = (clientMessageId: string, entry: { state: 'pending' | 'final'; outcome?: StoredChatOutcome }): ChatSendOutcome => {
    if (entry.state === 'pending' || !entry.outcome) return { clientMessageId, replayed: true, pending: true };
    // A stored `queued:false` (valid on load) reads as absent.
    const { queued, ...outcome } = entry.outcome;
    return { clientMessageId, replayed: true, ...outcome, ...(queued === true ? { queued: true as const } : {}) };
  };

  const identityOf = (resolution: ChatResolution) => {
    const epoch = resolution.source === 'none' ? undefined : resolution.epoch;
    return { ...(resolution.status.agentSessionId ? { agentSessionId: resolution.status.agentSessionId } : {}),
      ...(epoch ? { historyEpoch: epoch } : {}) };
  };

  /** Carries the pane's current identity so the client can re-read before the user decides. */
  const sessionChanged = async (id: string, fresh?: ChatResolution): Promise<StoredChatOutcome> => {
    const current = fresh ?? await resolve(id).catch(() => undefined);
    return { result: 'session_changed', effect: 'none', error: 'session-changed', ...(current ? identityOf(current) : {}) };
  };

  /** File binding (Claude/Codex): guarded bracketed paste, then Enter. */
  const dispatchFile = async (req: ChatSendRequest): Promise<StoredChatOutcome> => {
    const { id } = req;
    if (!deps.approvals()) return { result: 'unavailable', effect: 'none', error: 'chat-unavailable' };
    if (sending.has(id)) return { result: 'busy', effect: 'none', error: 'chat-busy' };
    sending.add(id);
    let pasted = false;
    let queued = false;
    let denied: 'paste' | 'submit' | undefined;
    const authorize = req.authorized;
    try {
      // `\x1b` then `\x1b[200~` can read as one escape sequence: let a recent
      // lone ESC (any source) land on its own first.
      const sinceEsc = lastEscAt(id) > 0 ? now() - lastEscAt(id) : Infinity;
      if (sinceEsc < ESC_QUIET_MS) await (deps.delay ?? sleep)(ESC_QUIET_MS - sinceEsc);
      const result = await deliverChatPrompt(req.agentSessionId, req.text, {
        getTranscriptSessionId: () => deps.projector.status(id).agentSessionId,
        hasOpenApproval: () => hasOpenApproval(id),
        readScreen: () => deps.readScreen(id),
        getAgentState: () => {
          const current = deps.chatAgentState(id);
          const slug = slugOf(current);
          return slug && current.agentVerified ? { slug, incarnationId: current.incarnationId, status: current.agentStatus,
            inputQuiet: current.inputQuiet, inputRevision: current.inputRevision } : null;
        },
        isAgentProcessAlive: async () => {
          const slug = slugOf(deps.chatAgentState(id));
          try { return !!slug && await deps.agentProcessAlive(id, slug); } catch { return false; }
        },
        write: (data) => deps.write(id, data),
        ...(deps.delay ? { delay: deps.delay } : {}),
        ...(authorize ? { authorized: async (stage: 'first-write' | 'submit') => {
          let ok = false;
          try { ok = await authorize(stage); } catch { /* a failed check is a refusal */ }
          if (!ok) denied = pasted ? 'submit' : 'paste';
          return ok;
        } } : {}),
        // Any write, including the first leading image paste, may leave input in the composer.
        onWrite: (stage, running) => { if (stage === 'paste') pasted = true; else queued = !!running; },
      }, req.attachments ?? []);
      if (denied) return { result: 'error', effect: denied === 'submit' ? 'uncertain' : 'none', error: 'authorization-expired' };
      switch (result) {
        case 'sent': return { result, effect: 'submitted', ...(queued ? { queued: true as const } : {}) };
        case 'busy': return { result, effect: 'none', error: 'chat-busy' };
        case 'blocked': return { result, effect: 'none', error: 'chat-blocked', blockedBy: blockedBy(id) };
        case 'session_changed': return sessionChanged(id);
        case 'unconfirmed': return { result, effect: 'none', error: 'input-not-provably-empty' };
        case 'unavailable':
          // The write wrapper refuses before anything reaches the PTY.
          return { result, effect: 'none', error: 'chat-unavailable' };
        default:
          return pasted ? { result: 'error', effect: 'uncertain', error: 'send-interrupted' }
            : { result: 'error', effect: 'none', error: 'invalid-chat-request' };
      }
    } catch {
      return pasted ? { result: 'error', effect: 'uncertain', error: 'send-interrupted' } : { result: 'unavailable', effect: 'none', error: 'chat-unavailable' };
    } finally { sending.delete(id); }
  };

  /** OpenCode TUI binding: the plugin inside the running TUI dispatches. */
  const dispatchTui = async (req: ChatSendRequest, resolution: Extract<ChatResolution, { source: 'tui' }>): Promise<StoredChatOutcome> => {
    const service = deps.terminalChat();
    if (!service) return { result: 'unavailable', effect: 'none', error: 'chat-unavailable' };
    const sent = await service.send(req.id, req.agentSessionId, req.text, req.clientMessageId, {
      // Only the read whose hash the phone matched may reach the plugin (N15).
      ...(req.historyEpoch !== undefined ? { expectedRawEpoch: resolution.rawEpoch } : {}),
      ...(req.authorized ? { authorized: req.authorized } : {}),
    });
    switch (sent.result) {
      case 'sent': return { result: 'sent', effect: 'submitted' };
      case 'busy': return { result: 'busy', effect: 'none', error: 'chat-busy' };
      case 'blocked': return { result: 'blocked', effect: 'none', error: 'chat-blocked', blockedBy: blockedBy(req.id) };
      case 'session_changed': return sessionChanged(req.id);
      case 'unavailable':
        return sent.reason === 'receipts-full' ? { result: 'unavailable', effect: 'none', error: 'opencode-receipts-full' }
          : { result: 'unavailable', effect: 'none', error: 'chat-unavailable' };
      case 'unconfirmed': return { result: 'unconfirmed', effect: 'uncertain', error: 'delivery-unconfirmed' };
      default:
        if (sent.reason === 'unauthorized') return { result: 'error', effect: 'none', error: 'authorization-expired' };
        if (sent.reason === 'too-large') return { result: 'error', effect: 'none', error: 'text-too-long', limit: 'bytes', maxSendBytes: OPENCODE_MAX_SEND_BYTES };
        return { result: 'error', effect: 'none', error: 'invalid-chat-request' };
    }
  };

  const sendWith = async (req: ChatSendRequest, dedup: boolean, managedRequestId = req.clientMessageId): Promise<ChatSendOutcome> => {
    const { clientMessageId, owner } = req;
    const idCheck = checkChatId(clientMessageId, now(), CHAT_MESSAGE_RETENTION_MS);
    if (idCheck === 'invalid') return refuse(clientMessageId, 'invalid-chat-request', { result: 'error', detail: 'clientMessageId' });
    // Before any receipt lookup, so an id stays refused after its receipt is pruned.
    if (idCheck === 'expired') return refuse(clientMessageId, 'message-id-expired');
    let store = dedup ? deps.receipts : null;
    if (dedup && !store && owner !== 'desktop') return refuse(clientMessageId, 'chat-persist-failed');
    const fingerprint = ChatSendReceiptStore.fingerprint(req.id, req.agentSessionId, req.historyEpoch, req.text, req.attachments);
    const early = (entry: ReturnType<ChatSendReceiptStore['lookup']>) =>
      !entry ? undefined : entry.fingerprint !== fingerprint ? refuse(clientMessageId, 'message-id-conflict') : replay(clientMessageId, entry);
    // Deliberately ahead of binding resolution (a refinement of contract §6.2's
    // order): a re-post after the agent exited must still replay `sent`, not
    // answer no-conversation for a message that was delivered.
    const replayed = early(store?.lookup(owner, clientMessageId));
    if (replayed) return replayed;
    if (typeof req.text !== 'string' || !req.text.trim()) return refuse(clientMessageId, 'invalid-chat-request', { result: 'error', detail: 'text' });
    if (req.text.length > CHAT_SEND_MAX_UNITS) return refuse(clientMessageId, 'text-too-long', { result: 'error', limit: 'units' });
    if (!req.agentSessionId) return refuse(clientMessageId, 'invalid-chat-request', { result: 'error', detail: 'agentSessionId' });

    const resolution = await resolve(req.id);
    if (resolution.source === 'none') return refuse(clientMessageId, 'no-conversation');
    // Image paths are pasted into a file-bound agent's composer only; the
    // OpenCode plugin and managed sessions have no attachment input.
    if (req.attachments?.length && resolution.source !== 'file') {
      return refuse(clientMessageId, 'chat-unavailable', { result: 'unavailable' });
    }
    if (resolution.source === 'managed') {
      if (req.managedReadOnly) return refuse(clientMessageId, 'managed-read-only');
      // Desktop managed chat keeps its own durable receipts keyed by requestId.
      const result = await deps.managed()?.send(req.id, req.agentSessionId, req.text, managedRequestId) ?? 'unavailable';
      return { clientMessageId, replayed: false, result, effect: result === 'sent' ? 'submitted' : 'none' };
    }
    if (resolution.status.agentSessionId !== req.agentSessionId ||
        req.historyEpoch !== undefined && req.historyEpoch !== resolution.epoch) {
      return { clientMessageId, replayed: false, ...await sessionChanged(req.id, resolution) };
    }
    if (resolution.source === 'file' && !resolution.status.terminal?.capabilities.send) {
      return refuse(clientMessageId, 'chat-unavailable', { result: 'unavailable' });
    }
    if (resolution.source === 'tui' &&
        openCodeSendBytes(req.agentSessionId, resolution.rawEpoch, req.text, clientMessageId) > OPENCODE_REQUEST_MAX_BYTES) {
      return refuse(clientMessageId, 'text-too-long', { result: 'error', limit: 'bytes', maxSendBytes: OPENCODE_MAX_SEND_BYTES });
    }

    if (store) {
      // Synchronous with the lookup: a concurrent same-id send that passed the
      // early check above sees `pending` here and never dispatches twice.
      const inserted = store.insertPending(owner, clientMessageId, {
        paneId: req.id, fingerprint, agentSessionId: req.agentSessionId,
        ...(req.historyEpoch !== undefined ? { historyEpoch: req.historyEpoch } : {}),
      });
      if (inserted === 'exists') return early(store.lookup(owner, clientMessageId)) ?? refuse(clientMessageId, 'message-id-conflict');
      if (inserted === 'full' || inserted === 'persist-failed') {
        // The desktop sends without dedup, as when the store failed to load.
        if (owner !== 'desktop') return refuse(clientMessageId, inserted === 'full' ? 'message-history-full' : 'chat-persist-failed');
        deps.log('warn', `[chat] send receipt for ${req.id} not stored (${inserted}); desktop send without dedup`);
        store = null;
      }
    }
    let outcome: StoredChatOutcome;
    try {
      outcome = resolution.source === 'tui' ? await dispatchTui(req, resolution) : await dispatchFile(req);
    } catch {
      outcome = { result: 'unconfirmed', effect: 'uncertain', error: 'delivery-unconfirmed' };
    }
    if (store && !store.complete(owner, clientMessageId, outcome)) deps.log('warn', `[chat] send receipt for ${req.id} not persisted`);
    return { clientMessageId, replayed: false, ...outcome };
  };

  // ---------------------------------------------------------------------------
  // Cancel (chat Stop)

  /**
   * The ESC itself, shared by the phone route and the desktop RPC. Takes the
   * pane's send lock for the whole check → read → write, so a Stop can never
   * land between a send's paste and its Enter, and two Stops cannot both pass
   * the once-per-turn check.
   */
  const interruptLocked = async (id: string, agentSessionId: string,
    opts: { turnId?: string; authorized?: () => Promise<boolean>; beforeWrite?: (turn: { id: string; startedAt: number }) => boolean } = {},
  ): Promise<ChatInterruptVerdict | 'busy'> => {
    if (sending.has(id)) return 'busy';
    sending.add(id);
    try {
      return await interruptChatTurn(agentSessionId, {
        getTranscriptSessionId: () => deps.projector.status(id).agentSessionId,
        hasOpenApproval: () => hasOpenApproval(id),
        readScreen: () => deps.readScreen(id),
        getAgentState: () => {
          const current = deps.chatAgentState(id);
          const slug = slugOf(current);
          return slug && current.agentVerified ? { slug, status: current.agentStatus, ...(current.turn ? { turn: current.turn } : {}) } : null;
        },
        write: (data) => {
          try { return deps.write(id, data); } catch (error) {
            // The ESC may have reached the PTY: latch it anyway, so no other
            // Stop in this turn (or within the cooldown) presses a second one.
            try { deps.pane(id)?.bridge.noteInput(data); } catch { /* best effort */ }
            throw error;
          }
        },
        lastEscAt: () => lastEscAt(id),
        readTitle: () => deps.pane(id)?.bridge.getTitle() ?? null,
        now,
        ...(opts.turnId !== undefined ? { expectedTurnId: opts.turnId } : {}),
        ...(opts.authorized ? { authorized: opts.authorized } : {}),
        ...(opts.beforeWrite ? { beforeWrite: opts.beforeWrite } : {}),
      });
    } finally { sending.delete(id); }
  };

  /** `prompt-active`: who answers the dialog in the way, and its record when there is one. */
  const promptActive = (id: string): Pick<ChatCancelOutcome, 'by' | 'approvalId'> => {
    const pending = deps.approvals()?.pendingFor(id);
    return pending ? { by: pending.kind === 'terminal_prompt' ? 'terminal' : 'approval', approvalId: pending.id } : { by: 'terminal' };
  };

  /**
   * OpenCode: the plugin inside the TUI aborts the selected session, and
   * repeats the session, generation, turn and phase checks beside it. No ESC,
   * so no latch or cooldown; a second abort of an ended turn is `not_running`.
   * Like the ESC path, a refusal stores no receipt.
   */
  const cancelTui = async (req: ChatCancelRequest, resolution: Extract<ChatResolution, { source: 'tui' }>,
    store: ChatCancelReceiptStore, fingerprint: string,
    refuse: (error: ChatCancelTag, extra?: Partial<ChatCancelOutcome>) => ChatCancelOutcome, early: () => ChatCancelOutcome | undefined,
  ): Promise<ChatCancelOutcome> => {
    const { owner, id, clientCancelId } = req;
    const service = deps.terminalChat();
    // A plugin that does not advertise abort cannot stop a turn.
    if (!resolution.status.terminal?.capabilities.cancel || !service?.abort) return refuse('cancel-unsupported');
    if (resolution.status.agentSessionId !== req.agentSessionId ||
        req.historyEpoch !== undefined && req.historyEpoch !== resolution.epoch) {
      return refuse('session-changed', identityOf(resolution));
    }
    const notRunning = (turn = resolution.turn) => refuse('turn-not-running', turn ? { turn: { ...turn } } : {});
    if (req.turnId !== undefined && req.turnId !== resolution.turn?.id) return notRunning();
    if (sending.has(id)) return refuse('chat-busy');
    const inserted = store.insertPending(owner, clientCancelId, { paneId: id, fingerprint });
    if (inserted === 'exists') return early() ?? refuse('cancel-id-conflict');
    if (inserted !== 'inserted') return refuse(inserted === 'full' ? 'message-history-full' : 'chat-persist-failed');
    sending.add(id);
    let aborted: Awaited<ReturnType<NonNullable<typeof service.abort>>>;
    try {
      aborted = await service.abort(id, req.agentSessionId, {
        // Only the read whose hash the phone matched may reach the plugin (N15).
        ...(req.historyEpoch !== undefined ? { expectedRawEpoch: resolution.rawEpoch } : {}),
        ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
        ...(req.authorized ? { authorized: req.authorized } : {}),
      });
    } catch (error) {
      aborted = { result: 'unconfirmed' };
      deps.log('warn', `[chat] cancel for ${id} threw: ${error instanceof Error ? error.message : String(error)}`);
    } finally { sending.delete(id); }
    if (aborted.result === 'sent' || aborted.result === 'unconfirmed') {
      const turnId = aborted.turn?.id ?? req.turnId ?? resolution.turn?.id;
      const outcome = { effect: aborted.result === 'sent' ? 'interrupt-requested' as const : 'uncertain' as const, ...(turnId ? { turnId } : {}) };
      if (!store.complete(owner, clientCancelId, outcome)) deps.log('warn', `[chat] cancel receipt for ${id} not persisted`);
      return { clientCancelId, replayed: false, ...outcome, ...(aborted.result === 'unconfirmed' ? { error: 'cancel-failed' as const } : {}) };
    }
    store.discard(owner, clientCancelId);
    switch (aborted.result) {
      case 'not_running': return notRunning(aborted.turn ?? resolution.turn);
      case 'prompt_active': return refuse('prompt-active', promptActive(id));
      case 'session_changed': return refuse('session-changed', identityOf(await resolve(id)));
      case 'error': return aborted.reason === 'unauthorized' ? refuse('authorization-expired') : refuse('chat-unavailable');
      default: return refuse('chat-unavailable');
    }
  };

  const cancel = async (req: ChatCancelRequest): Promise<ChatCancelOutcome> => {
    const { owner, id, clientCancelId } = req;
    const refuse = (error: ChatCancelTag, extra: Partial<ChatCancelOutcome> = {}): ChatCancelOutcome =>
      ({ clientCancelId, replayed: false, effect: 'none', error, ...extra });
    const idCheck = checkChatId(clientCancelId, now(), CHAT_MESSAGE_RETENTION_MS);
    if (idCheck === 'invalid') return refuse('invalid-chat-request', { detail: 'clientCancelId' });
    if (idCheck === 'expired') return refuse('message-id-expired');
    const store = deps.cancelReceipts;
    if (!store) return refuse('chat-persist-failed');
    const fingerprint = ChatCancelReceiptStore.fingerprint(id, req.agentSessionId, req.historyEpoch, req.turnId);
    const early = (): ChatCancelOutcome | undefined => {
      const entry = store.lookup(owner, clientCancelId);
      if (!entry) return undefined;
      if (entry.fingerprint !== fingerprint) return refuse('cancel-id-conflict');
      // Pending: the first request is between its receipt and its ESC.
      if (entry.state === 'pending' || !entry.outcome) return refuse('chat-busy');
      return { clientCancelId, replayed: true, effect: entry.outcome.effect, ...(entry.outcome.turnId ? { turnId: entry.outcome.turnId } : {}),
        ...(entry.outcome.effect === 'uncertain' ? { error: 'cancel-failed' as const } : {}) };
    };
    const replayed = early();
    if (replayed) return replayed;
    if (!req.agentSessionId) return refuse('invalid-chat-request', { detail: 'agentSessionId' });

    const resolution = await resolve(id);
    if (resolution.source === 'tui') return cancelTui(req, resolution, store, fingerprint, refuse, early);
    const agent = resolution.source === 'file' ? resolution.status.terminal?.agent : undefined;
    if (agent !== 'claude' && agent !== 'codex') return refuse('cancel-unsupported');
    if (resolution.status.agentSessionId !== req.agentSessionId ||
        req.historyEpoch !== undefined && req.historyEpoch !== (resolution.source === 'file' ? resolution.epoch : undefined)) {
      return refuse('session-changed', identityOf(resolution));
    }
    const turnNow = () => deps.chatAgentState(id).turn;
    const notRunning = () => { const turn = turnNow(); return refuse('turn-not-running', turn ? { turn: { ...turn } } : {}); };
    // The agent exited: whatever turn there was is over.
    if (!resolution.status.terminal?.capabilities.cancel) return notRunning();
    if (sending.has(id)) return refuse('chat-busy');

    // The receipt is written only once the ESC is decided: synchronously, as
    // the last step before the write, under the pane lock. A refusal leaves
    // nothing on disk; a crash after it reads as uncertain. The receipt names
    // the turn the ESC was aimed at, captured before the write.
    let inserted: ReturnType<ChatCancelReceiptStore['insertPending']> | undefined;
    let aimed: string | undefined;
    const beforeWrite = (target: { id: string }): boolean => {
      aimed = target.id;
      inserted = store.insertPending(owner, clientCancelId, { paneId: id, fingerprint });
      return inserted === 'inserted';
    };
    let verdict: ChatInterruptVerdict | 'busy';
    try {
      verdict = await interruptLocked(id, req.agentSessionId, { ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
        ...(req.authorized ? { authorized: req.authorized } : {}), beforeWrite });
    } catch (error) {
      // Nothing that throws out of here runs after the write (the write's own
      // failure is the `error` verdict), so the id is freed for a retry. Only
      // this request, under the pane lock, can have left this id pending.
      store.discard(owner, clientCancelId);
      deps.log('warn', `[chat] cancel for ${id} threw: ${error instanceof Error ? error.message : String(error)}`);
      return refuse('cancel-failed');
    }
    if (verdict === 'write_refused') {
      if (inserted === 'exists') return early() ?? refuse('cancel-id-conflict');
      return refuse(inserted === 'full' ? 'message-history-full' : 'chat-persist-failed');
    }
    if (inserted === 'inserted' && (verdict === 'sent' || verdict === 'error')) {
      // `error` = the write threw: the ESC may have reached the pane.
      const outcome = { effect: verdict === 'sent' ? 'interrupt-requested' as const : 'uncertain' as const, ...(aimed ? { turnId: aimed } : {}) };
      if (!store.complete(owner, clientCancelId, outcome)) deps.log('warn', `[chat] cancel receipt for ${id} not persisted`);
      return { clientCancelId, replayed: false, ...outcome, ...(verdict === 'error' ? { error: 'cancel-failed' as const } : {}) };
    }
    // `unavailable` after the receipt: the pane was gone, nothing was written.
    if (inserted === 'inserted') store.discard(owner, clientCancelId);
    const turn = turnNow();
    switch (verdict) {
      case 'busy': return refuse('chat-busy');
      case 'session_changed': return refuse('session-changed', identityOf(await resolve(id)));
      case 'blocked': return refuse('prompt-active', promptActive(id));
      case 'already_interrupted': return refuse('turn-already-interrupted', turn ? { turnId: turn.id } : {});
      case 'cooldown':
        return refuse('cancel-cooldown', { retryAfterMs: Math.max(1, INTERRUPT_COOLDOWN_MS - (now() - lastEscAt(id))) });
      case 'unauthorized': return refuse('authorization-expired');
      case 'unavailable':
      case 'error': return refuse('chat-unavailable');
      default:
        // not_running, turn_mismatch: the turn the caller meant is not running.
        deps.log('info', `[chat] cancel for ${id} refused: ${verdict}`);
        return notRunning();
    }
  };

  /**
   * The desktop's enum: its Stop shows notices for `not_running` and `blocked`
   * (a prompt to answer) and treats the rest as failed. A cooldown means a
   * Stop is already under way, so it reads as `not_running`, never `blocked`.
   */
  const DESKTOP_INTERRUPT: Record<ChatInterruptVerdict | 'busy', ChatInterruptResult> = {
    sent: 'sent', not_running: 'not_running', blocked: 'blocked', session_changed: 'session_changed',
    unavailable: 'unavailable', error: 'error', turn_mismatch: 'not_running', already_interrupted: 'not_running',
    cooldown: 'not_running', unauthorized: 'unavailable', write_refused: 'unavailable', busy: 'blocked',
  };

  const DESKTOP_ABORT: Partial<Record<string, ChatInterruptResult>> = {
    sent: 'sent', not_running: 'not_running', prompt_active: 'blocked', session_changed: 'session_changed', unconfirmed: 'error',
  };

  const desktopInterrupt = async (id: string, agentSessionId: string): Promise<ChatInterruptResult> => {
    if (!id) return 'unavailable';
    const found = await route(id);
    if (found.kind === 'native') {
      // OpenCode stops through its plugin's abort, only when the plugin offers it.
      const service = deps.terminalChat();
      if (!found.read.status.terminal?.capabilities.cancel || !service?.abort) return 'unavailable';
      // Another Stop is under way (as a cooldown reads).
      if (sending.has(id)) return 'not_running';
      sending.add(id);
      try { return DESKTOP_ABORT[(await service.abort(id, agentSessionId)).result] ?? 'unavailable'; } catch { return 'error'; } finally { sending.delete(id); }
    }
    // No registry = "may be pending".
    if (!deps.approvals()) return 'unavailable';
    return DESKTOP_INTERRUPT[await interruptLocked(id, agentSessionId)];
  };

  // ---------------------------------------------------------------------------
  // Launch

  const launch = async (req: ChatLaunchRequest): Promise<ChatLaunchOutcome> => {
    const fail = (error: ChatLaunchTag, reason?: ChatLaunchReason, effect: ChatEffect = 'none'): ChatLaunchOutcome =>
      ({ ok: false, error, effect, ...(reason ? { reason } : {}) });
    const { id, agent } = req;
    if (agent !== 'claude' && agent !== 'codex') return fail('invalid-chat-request');
    let command: string;
    try { command = terminalLaunchCommand(agent, req.prompt, req.mode); } catch { return fail('invalid-chat-request'); }
    if (launching.has(id)) return fail('launch-pending');
    launching.add(id);
    let relay: LaunchRelay | undefined;
    let typing = false;
    let launched = false;
    try {
      const pane = deps.pane(id);
      if (req.refuseConversation && await hasConversation(id)) return fail('conversation-exists');
      if (pane && unsupportedPlatform(pane)) return fail('launch-unsupported', 'unsupported-shell');
      const revision = pane?.bridge.getInputRevision();
      const first = notReady(id, pane, revision);
      if (first || !pane) return fail('launch-not-ready', first ?? 'not-integrated');
      const env = { ...process.env, ...pane.meta.env };
      const idle = async (): Promise<ChatLaunchOutcome | undefined> => {
        const shell = await deps.idleShell(pane.meta.pid, pane.meta.env);
        // A vanished shell pid means the pane is being torn down: busy, not unsupported.
        if (!shell.ok) return shell.reason === 'missing' ? fail('launch-not-ready', 'shell-busy') : fail('launch-unsupported', shell.reason);
        const again = notReady(id, pane, revision);
        return again ? fail('launch-not-ready', again) : undefined;
      };
      const firstIdle = await idle();
      if (firstIdle) return firstIdle;
      try { buildAgentLaunch({ agent }, await deps.installedAgents(env)); } catch { return fail('agent-not-installed'); }
      if (agent === 'codex') {
        // Hook session_id can name an invocation rather than the conversation.
        // Observe the existing native TUI transport for authoritative thread IDs.
        await deps.relays.retire(id);
        try { relay = await deps.relays.prepare(id, pane); }
        catch (error) {
          if (!deps.relays.unavailable(error)) throw error;
          const moved = notReady(id, pane, revision);
          if (moved) return fail('launch-not-ready', moved);
          try { await deps.startCodexRuntime(codexRuntimeEnv(env)); relay = await deps.relays.prepare(id, pane); }
          catch { return fail('agent-runtime-unavailable'); }
        }
        if (!RELAY_URL.test(relay.url)) return fail('launch-unconfirmed');
        command = command.replace(/^codex /, `codex --remote ${relay.url} `);
      }
      const secondIdle = await idle();
      if (secondIdle) return secondIdle;
      if (req.authorized) {
        let ok = false;
        try { ok = await req.authorized('first-write'); } catch { /* a failed check is a refusal */ }
        if (!ok) return fail('authorization-expired');
      }
      // The authorization await yielded; the synchronous proof is the last thing before typing.
      const last = notReady(id, pane, revision);
      if (last) return fail('launch-not-ready', last);
      // A refused commit happens before any write, so nothing was typed.
      if (relay && !relay.commit()) return fail('launch-unconfirmed');
      // Fixed launcher only; no caller-provided shell text or flags.
      // noteInput consumes the empty-prompt evidence before another launch can run.
      const input = command + '\r';
      typing = true;
      pane.bridge.noteInput(input);
      pane.ptyProcess.write(input);
      launched = true;
      return { ok: true, effect: 'submitted' };
    } catch {
      // Everything before `typing` wrote nothing; a throw while typing may have.
      return fail('launch-unconfirmed', undefined, typing ? 'uncertain' : 'none');
    } finally {
      if (!launched) await relay?.close().catch(() => undefined);
      launching.delete(id);
    }
  };

  // ---------------------------------------------------------------------------
  // Skills

  const skillsWith = async (id: string, agent: unknown, fallback: 'spawnCwd' | 'cwd'): Promise<ChatSkillCatalog> => {
    const pane = deps.pane(id);
    if (!pane || pane.meta.wslTarget || !liveState(pane)) return UNAVAILABLE_SKILLS;
    const liveAgent = slugOf(deps.agentState(id));
    if (liveAgent && liveAgent !== agent) return UNAVAILABLE_SKILLS;
    if (agent !== 'claude' && agent !== 'codex') return UNAVAILABLE_SKILLS;
    const selection = agent === 'codex' ? deps.relays.selection(id, pane) : undefined;
    const cwd = selection?.cwd ?? pane.meta[fallback];
    if (!cwd) return UNAVAILABLE_SKILLS;
    const capture = () => JSON.stringify([pane.meta[fallback], pane.meta.pid, pane.meta.incarnationId, pane.meta.state,
      pane.meta.env?.CODEX_HOME, pane.meta.env?.CLAUDE_CONFIG_DIR, agent === 'codex' ? deps.relays.selection(id, pane) : undefined]);
    const scope = capture();
    const result = await deps.loadSkills(agent, cwd, { ...process.env, ...pane.meta.env });
    return deps.pane(id) === pane && capture() === scope && slugOf(deps.agentState(id)) === liveAgent ? result : UNAVAILABLE_SKILLS;
  };

  // ---------------------------------------------------------------------------

  return {
    route,
    resolve,
    managedSnapshot: (id) => deps.managed()?.snapshot(id) ?? null,
    turn: (id) => deps.chatAgentState(id).turn,
    blocked,
    send: (req) => sendWith(req, true),
    cancel,
    receipt: (owner: ChatOwner, id: string, clientMessageId: string) =>
      deps.receipts?.view(owner, id, clientMessageId) ?? { clientMessageId, state: 'unknown' },
    launch,
    skills: (id, agent) => skillsWith(id, agent, 'spawnCwd'),
    watch: (id) => deps.terminalChat()?.subscribe(WEB_BRIDGE_CLIENT, id),
    unwatch: (id) => deps.terminalChat()?.unsubscribe(WEB_BRIDGE_CLIENT, id),
    traceDangerousLaunch: (trace: DangerousLaunchTrace) => {
      const { at, owner, paneId, agent, mode, clientLaunchId, outcome } = trace;
      deps.log('info', `[chat] dangerous-launch ${JSON.stringify({ at, owner, paneId, agent, mode, clientLaunchId, outcome })}`);
      if (mode === 'default' || outcome !== 'submitted' && outcome !== 'launch-unconfirmed') return;
      const who = owner === 'operator' ? 'The operator token' : 'A phone';
      const what = agent === 'codex' ? 'Codex with approvals and sandbox off' : 'Claude with permission prompts off';
      deps.notify(paneId, 'Agent started from the phone',
        `${who} ${outcome === 'submitted' ? 'started' : 'may have started'} ${what} in pane ${paneId}.`);
    },
    status: async (id) => {
      const found = await route(id);
      if (found.kind === 'native') return found.read.status;
      if (found.kind === 'opencode') return { available: false, reason: 'unavailable' };
      const managed = found.kind === 'managed' ? deps.managed()?.status(id) : undefined;
      return managed ?? fileStatus(id);
    },
    snapshot: async (id, before) => {
      const found = await route(id);
      if (found.kind === 'native') return before === undefined ? found.read.page : { ...found.read.page, events: [], hasMore: false };
      if (found.kind === 'opencode') return null;
      if (found.kind === 'managed') return deps.managed()?.snapshot(id, before) ?? null;
      return deps.projector.snapshot(id, before === undefined ? undefined : { before });
    },
    desktopSend: async ({ id, agentSessionId, text, requestId, attachments }) => {
      // Older renderers send a bare UUID (or nothing): mint an id and keep
      // today's no-dedup behavior instead of refusing across a rolling upgrade.
      const wellFormed = typeof requestId === 'string' && checkChatId(requestId, now(), CHAT_MESSAGE_RETENTION_MS) !== 'invalid';
      const clientMessageId = wellFormed ? requestId as string : `${now()}-${randomUUID()}`;
      const outcome = await sendWith({ owner: 'desktop', id, agentSessionId, text, clientMessageId,
        ...(attachments?.length ? { attachments } : {}) }, wellFormed,
        typeof requestId === 'string' ? requestId : '');
      const result: ChatSendResult = outcome.pending ? 'unconfirmed'
        : outcome.result ?? (outcome.error && DESKTOP_RESULT[outcome.error]) ?? 'error';
      return { result, replayed: outcome.replayed, ...(outcome.effect ? { effect: outcome.effect } : {}),
        ...(outcome.pending ? { pending: true as const } : {}), ...(outcome.queued ? { queued: true as const } : {}) };
    },
    desktopInterrupt,
    sendInFlight: (id) => sending.has(id),
    hasOpenApproval,
    desktopSkills: (id, agent) => skillsWith(id, agent, 'cwd'),
  };
}
