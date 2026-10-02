import { randomUUID } from 'node:crypto';
import { agentDisplayToSlug } from '../../shared/agentIdentity';
import { isBrainPty } from '../../shared/constants';
import type { AgentStatus } from '../../shared/types';
import type { ChatSkillCatalog } from '../../shared/transcript/chatSkills';
import type { TerminalLaunchAgent } from '../../shared/transcript/terminalChat';
import type { ChatInterruptResult, ChatSendResult, TranscriptPage, TranscriptStatus } from '../../shared/transcript/turnEvents';
import type { AgentLaunchOptions } from '../web/agentLaunch';
import { buildAgentLaunch } from '../web/agentLaunch';
import { withChosenAccountEnv } from '../phone/paneAccountSpawn';
import { codexCdOperand, withCodexRemote } from '../web/recoverCodexPane';
import type { CodexNativeInterrupt, CodexTurnRef } from '../web/codexPaneRelays';
import { screenBlocksChatSend, screenShowsRunningTurn, screenShowsTurnEnding, titleShowsFinishedTurn } from '../transcript/chatScreenGate';
import { claudeComposerText, deliverChatPrompt, type ChatScreenRows } from '../transcript/deliverChatPrompt';
import { INTERRUPT_COOLDOWN_MS, interruptChatTurn, type ChatInterruptVerdict } from '../transcript/interruptChatTurn';
import { codexRuntimeEnv, terminalLaunchCommand } from '../transcript/terminalLaunch';
import type { TerminalChatFailure, TerminalChatService } from '../transcript/TerminalChatService';
import type { ChatSessionService } from './ChatSessionService';
import { ChatSendReceiptStore, type StoredChatOutcome } from './ChatSendReceiptStore';
import { ChatCancelReceiptStore } from './ChatCancelReceiptStore';
import { createChatCancelObserver, type CancelProbe, type ChatCancelEvent, type WatchedCancel } from './chatCancelObserver';
import { turnEndAfter, type TranscriptBoundary } from '../transcript/chatAgentStatus';
import type { StoredCancelProgress } from '../../shared/phoneChatCancelOutcome';
import { isActiveQueueState, type ChatQueueReason, type ChatQueueRecord, type ChatQueueState, type ChatQueueStore } from './ChatQueue';
import {
  CHAT_LAUNCH_MAX_UNITS, CHAT_MESSAGE_RETENTION_MS, CHAT_SEND_MAX_UNITS, OPENCODE_MAX_SEND_BYTES, OPENCODE_REQUEST_MAX_BYTES,
  checkChatId, fileHistoryEpoch, openCodeSendBytes, tuiHistoryEpoch,
  type ChatBlocked, type ChatBridge, type ChatCancelOutcome, type ChatCancelRequest, type ChatCancelTag, type ChatEffect, type ChatLaunchOutcome, type ChatLaunchPreview, type ChatLaunchReason,
  type ChatLaunchRequest, type ChatLaunchTag, type ChatOwner, type ChatResolution, type ChatSendOutcome, type ChatSendRequest,
  type ChatSendTag, type ChatTurn, type DangerousLaunchTrace,
  type ChatDeliveredMessage, type ChatDequeueResult, type ChatQueueEvent, type ChatQueueItemView, type ChatSendReceiptView,
} from './chatBridge';

/** Transcript stamps may trail the daemon's write time by this much and still count after it. */
const CANCEL_CLOCK_SKEW_MS = 2000;

/** Synthetic TerminalChatService client key for the phone's OpenCode watch. */
export const WEB_BRIDGE_CLIENT = 'web:bridge';
/** The queue's own OpenCode watch: the plugin's phase changes nudge the queue. */
export const QUEUE_WATCH_CLIENT = 'web:queue';

/** The parts of a daemon pane the bridge reads. `ManagedSession` satisfies it. */
export interface ChatPane {
  meta: {
    id: string; state: string; pid: number; cwd: string; env: Record<string, string>;
    exec?: unknown; wslTarget?: unknown; spawnCwd?: string; incarnationId?: string;
    /** Set only for a pane created with a chosen account (contract v-next item 4). */
    paneAccount?: { vendor: 'claude' | 'codex' };
  };
  bridge: {
    isEmptyShellPrompt(): boolean; getInputRevision(): number; noteInput(data: string): void;
    /** When a lone ESC last reached the pane, from any source (0 = never). */
    getLastEscAt(): number;
    /** A native interrupt reached the running turn without a key: latch it like a lone ESC. */
    noteInterrupt?(): void;
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
  /** Every cancel progress change (the web server fans it out as SSE `chat.cancel`). */
  onCancelEvent?: (event: ChatCancelEvent) => void;
  /** Cancel observation overrides (tests). */
  cancelObserveMs?: number;
  cancelPollMs?: number;
  /** The daemon-held phone queue. Absent or null: a `chat-queue` send takes today's path. */
  queue?: ChatQueueStore | null;
  /** Every queue transition (the web server fans it out as SSE `chat.queue`). */
  onQueueEvent?: (event: ChatQueueEvent) => void;
  /** Queue overrides (tests). */
  queueTtlMs?: number;
  queueTickMs?: number;
  idleShell(pid: number, env: NodeJS.ProcessEnv): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'unsupported-shell' | 'shell-has-children' }>;
  installedAgents(env: NodeJS.ProcessEnv): Promise<AgentLaunchOptions[]>;
  relays: {
    retire(id: string): Promise<void>;
    prepare(id: string, pane: P): Promise<LaunchRelay>;
    /** The "account server not there yet" failures that justify starting the runtime. */
    unavailable(error: unknown): boolean;
    selection(id: string, pane: P): { cwd?: string } | undefined;
    /** The pane's running Codex turn, from its own relay stream. Absent: no native cancel. */
    activeTurn?(id: string, pane: P | undefined): CodexTurnRef | undefined;
    /**
     * Codex `turn/interrupt` for exactly `turn`, bounded; `interrupted` only on
     * the pane's own `turn/completed`. `answered`: the server acknowledged it.
     */
    interrupt?(id: string, pane: P | undefined, turn: CodexTurnRef, opts?: { answered?: () => void }): Promise<CodexNativeInterrupt>;
    /** `turn` is still the running turn of the pane's foreground thread on the same relay. */
    stillRunning?(id: string, pane: P | undefined, turn: CodexTurnRef): boolean;
    /** How that turn ended, as the same relay's stream reported it. */
    turnEnded?(id: string, ref: CodexTurnRef): string | undefined;
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

type QueueMethods = 'queueEnabled' | 'queue' | 'dequeue' | 'dropQueue' | 'delivered';

/** How the desktop RPCs dispatch a pane (contract §2.1). */
export type ChatRoute =
  | { kind: 'native'; read: NonNullable<Awaited<ReturnType<TerminalChatService['read']>>> }
  | { kind: 'opencode'; failure?: TerminalChatFailure } | { kind: 'managed' } | { kind: 'file' };

export interface NativeChatBridge extends Omit<ChatBridge, QueueMethods>, Required<Pick<ChatBridge, QueueMethods>> {
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
  /** Something that can end a turn happened on the pane: try its queue now (resolves when that pass ends). */
  kickQueue(id: string): Promise<void>;
  /** The same, debounced, for the daemon's event bursts (transcript nudges, hook events). */
  nudgeQueue(id: string): void;
  /** The pane is gone: its queued items are canceled{pane-closed}. */
  paneClosed(id: string): void;
}

const UNAVAILABLE_SKILLS: ChatSkillCatalog = { skills: [], state: 'unavailable' };
const RELAY_URL = /^unix:\/\/\/[A-Za-z0-9_./-]+$/;
/** A send waits this long after any lone ESC, so a paste cannot extend it into an escape sequence. */
export const ESC_QUIET_MS = 300;
/** `cancel-cooldown` retry hint while OpenCode admits a just-sent prompt. */
export const OPENCODE_FENCE_RETRY_MS = 500;
/** A queued message not delivered within this long fails (`expired`, or the hold that kept it). */
export const CHAT_QUEUE_TTL_MS = 10 * 60_000;
/** The queue's low-rate backup poll while any pane holds an active item (events drive it otherwise). */
const CHAT_QUEUE_TICK_MS = 5_000;
/** Transcript nudges and hook events arrive in bursts: one queue pass per burst. */
const QUEUE_NUDGE_DEBOUNCE_MS = 250;
/** Consecutive failures to persist `delivering` before the item fails instead of retrying. */
const QUEUE_PERSIST_ATTEMPTS = 3;
/**
 * After a delivery the next item waits for a NEW turn to end. If the turn id
 * never moves (a prompt that started no turn), this long of idle lets it go.
 */
const QUEUE_TURN_GATE_STALE_MS = 30_000;
const QUEUE_PREVIEW_CHARS = 80;
/** Ctrl-U: Claude deletes back to the start of the visual row (Ctrl-Y restores it). Never Ctrl-C. */
const CLEAR_ROW_KEY = '\x15';
/** Between two clearing keys: long enough for Claude to repaint before the re-read. */
const CLEAR_STEP_MS = 150;
/** Clearing keys per cancel at most (a row, or the empty line a row leaves, each). */
const CLEAR_MAX_KEYS = 32;
const squash = (text: string) => text.replace(/\s+/g, '');
const DELIVERED_KEEP = 32;
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

  /**
   * What one look at a cancelled pane proves about the turn the ESC was aimed
   * at. The pane is matched by id and incarnation, not object identity (a
   * reattach may replace the object). The running check comes first, so
   * `ended` is never reported while `/turns` still shows the turn running.
   */
  const probeCancel = async (cancel: WatchedCancel & {
    incarnationId?: string; agentSessionId: string; slug: string; boundary: TranscriptBoundary;
    /** The Codex turn a native interrupt was aimed at (never on the wire). */
    codexTurn?: CodexTurnRef;
    /** The text the daemon sent for the aimed turn, when exactly one send started it (memory only). */
    sentText?: string;
    /** The restored-prompt check, once run: a settle retry must not repeat it. */
    promptCheck?: Pick<StoredCancelProgress, 'promptRestored' | 'inputCleared'>;
  }): Promise<CancelProbe> => {
    const id = cancel.paneId;
    const where = (): 'live' | 'gone' | 'transient' => {
      const pane = deps.pane(id);
      if (!pane || pane.meta.incarnationId !== cancel.incarnationId || pane.meta.state === 'dead') return 'gone';
      return ['attached', 'detached'].includes(pane.meta.state) ? 'live' : 'transient';
    };
    // An unreadable binding is a transient read, not another conversation.
    const sessionChanged = (): boolean => {
      const current = deps.projector.status(id).agentSessionId;
      return current !== undefined && current !== cancel.agentSessionId;
    };
    const aimedRunning = (): boolean => {
      const turn = deps.chatAgentState(id).turn;
      return turn?.id === cancel.turnId && turn.state === 'running';
    };
    const state = where();
    if (state !== 'live') return { kind: state };
    if (sessionChanged()) return { kind: 'session-changed' };
    if (aimedRunning()) return { kind: 'running' };
    // The pane's own Codex stream reported the aimed turn interrupted.
    if (cancel.codexTurn && deps.relays.turnEnded?.(id, cancel.codexTurn) === 'interrupted') {
      return { kind: 'ended', endedAs: 'interrupted', evidence: 'native' };
    }
    const end = turnEndAfter(deps.projector.snapshot(id)?.events, cancel.boundary);
    if (end?.kind === 'ended') return { kind: 'ended', endedAs: end.status === 'idle' ? 'interrupted' : 'completed', evidence: 'transcript' };
    if (end) return { kind: 'unprovable' };
    // The turn stopped running without a transcript record: the screen may
    // still prove it (an idle title set after the write, Claude's Stop-hook row).
    const rows = await deps.readScreen(id);
    // The read awaited: the pane, its conversation and the turn are re-checked.
    const after = where();
    if (after !== 'live') return { kind: after };
    if (sessionChanged()) return { kind: 'session-changed' };
    if (aimedRunning()) return { kind: 'running' };
    let title: { title: string; at: number } | null = null;
    try { title = deps.pane(id)?.bridge.getTitle() ?? null; } catch { /* no title = no title evidence */ }
    if (titleShowsFinishedTurn(title, cancel.slug, cancel.requestedAt) || screenShowsTurnEnding(rows, cancel.slug)) {
      return { kind: 'ended', endedAs: 'unspecified', evidence: 'screen' };
    }
    return { kind: 'idle' };
  };
  type ObservedCancel = Parameters<typeof probeCancel>[0];

  /**
   * Claude puts a prompt interrupted before any output back into its input
   * box, and every later send is refused until it is empty. Once the aimed
   * turn ended, the box is cleared only when it is PROVEN to hold exactly the
   * text the daemon sent for that turn; anything else is left untouched. Each
   * key is followed by a re-read: the rest must still be a prefix of that text.
   * Runs under the pane's send lock, so no send or Stop interleaves.
   */
  const clearRestoredPrompt = async (cancel: ObservedCancel): Promise<NonNullable<ObservedCancel['promptCheck']>> => {
    const id = cancel.paneId;
    const want = cancel.sentText === undefined ? '' : squash(cancel.sentText);
    if (cancel.slug !== 'claude' || !want || sending.has(id)) return {};
    sending.add(id);
    let keys = 0;
    try {
      const owned = (): boolean => {
        const pane = deps.pane(id);
        return !!pane && pane.meta.incarnationId === cancel.incarnationId && liveState(pane) &&
          deps.projector.status(id).agentSessionId === cancel.agentSessionId &&
          deps.chatAgentState(id).turn?.state !== 'running' && !hasOpenApproval(id);
      };
      // What the composer holds, or null when the pane is no longer ours to type into.
      const look = async (): Promise<string | null> => {
        let rows: ChatScreenRows | null = null;
        try { rows = await deps.readScreen(id); } catch { /* unreadable = no evidence */ }
        if (!owned() || screenShowsRunningTurn(rows, 'claude')) return null;
        return claudeComposerText(rows);
      };
      const shown = await look();
      if (shown === null) return {};
      if (squash(shown) !== want) return { promptRestored: false };
      // A key right after a lone ESC would read as Alt+key.
      const sinceEsc = lastEscAt(id) > 0 ? now() - lastEscAt(id) : Infinity;
      if (sinceEsc < ESC_QUIET_MS) await (deps.delay ?? sleep)(ESC_QUIET_MS - sinceEsc);
      // A key may only join an empty line (no visible change); two in a row means the keys do nothing.
      let before = want;
      let stalled = 0;
      while (keys < CLEAR_MAX_KEYS && stalled < 2) {
        if (!owned()) break;
        keys++;
        if (!deps.write(id, CLEAR_ROW_KEY)) break;
        await (deps.delay ?? sleep)(CLEAR_STEP_MS);
        const left = await look();
        if (left === null) break;
        if (left === '') return { promptRestored: true, inputCleared: true };
        const rest = squash(left);
        if (!want.startsWith(rest)) break;
        stalled = rest === before ? stalled + 1 : 0;
        before = rest;
      }
      return { promptRestored: true, inputCleared: false };
    } catch (error) {
      deps.log('warn', `[chat] clearing the restored prompt in ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return keys > 0 ? { promptRestored: true, inputCleared: false } : {};
    } finally { sending.delete(id); }
  };

  const cancelObserver = deps.cancelReceipts ? createChatCancelObserver<ObservedCancel>({
    store: deps.cancelReceipts,
    probe: async (cancel) => {
      const seen = await probeCancel(cancel);
      if (seen.kind !== 'ended' || cancel.sentText === undefined) return seen;
      cancel.promptCheck ??= await clearRestoredPrompt(cancel);
      return { ...seen, ...cancel.promptCheck };
    },
    emit: (event) => deps.onCancelEvent?.(event),
    log: (message) => deps.log('warn', message),
    now,
    ...(deps.cancelObserveMs !== undefined ? { windowMs: deps.cancelObserveMs } : {}),
    ...(deps.cancelPollMs !== undefined ? { pollMs: deps.cancelPollMs } : {}),
  }) : null;

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
  const dispatchFile = async (req: ChatSendRequest, opts: { idleOnly?: boolean } = {}): Promise<StoredChatOutcome> => {
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
        ...(opts.idleOnly ? { idleOnly: true } : {}),
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
    // A message the daemon queue holds (or held) is never dispatched again,
    // and its replay is the queue's state, which the receipt lags.
    const held = queueStore?.get(owner, clientMessageId);
    if (held) return heldReplay(held, req.id, fingerprint, store?.lookup(owner, clientMessageId));
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
    // The daemon queue: a running turn, or anything already waiting on the
    // pane (any owner), holds the message for delivery after the turn ends.
    if (req.queue && queueStore && owner !== 'desktop' && (resolution.source === 'file' || resolution.source === 'tui') &&
        (turnRunning(req.id, resolution) || queueStore.hasActive(req.id))) {
      // Synchronous with the insert: a concurrent same-id send that also
      // passed the checks above (both awaited resolve) finds this one here.
      const raced = early(store?.lookup(owner, clientMessageId));
      if (raced) return raced;
      return enqueue(req, resolution.source, fingerprint);
    }
    // Same for a same-id send that went to the queue while this one resolved.
    const queuedMeanwhile = queueStore?.get(owner, clientMessageId);
    if (queuedMeanwhile) return heldReplay(queuedMeanwhile, req.id, fingerprint, store?.lookup(owner, clientMessageId));

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
    if (outcome.result === 'sent' && !outcome.error && owner !== 'desktop') noteDelivered(req.id, owner, clientMessageId, req.text);
    return { clientMessageId, replayed: false, ...outcome };
  };

  // ---------------------------------------------------------------------------
  // Daemon-held queue (phone, `chat-queue`)

  /** Memory half of a queue record: the text never reaches the disk. */
  interface QueueMemo {
    fingerprint: string;
    preview: string;
    /** Dropped once the record is final. */
    text?: string;
    agentSessionId: string;
    historyEpoch?: string;
    source: 'file' | 'tui';
    incarnation?: string;
    authorized?: (stage?: 'first-write' | 'submit') => Promise<boolean>;
    /** Why the last attempt held it, if a dialog did: the failure reason at the TTL. */
    hold?: 'blocked' | 'prompt-active';
    /** Since when it has waited at the head while the agent was not working (the TTL clock). */
    idleSince?: number;
    persistFailures?: number;
    retryAt?: number;
  }
  const queueStore = deps.queue ?? null;
  const queueTtl = deps.queueTtlMs ?? CHAT_QUEUE_TTL_MS;
  const queueMemo = new Map<string, QueueMemo>();
  const memoKey = (owner: ChatOwner, clientMessageId: string) => `${owner}\n${clientMessageId.toLowerCase()}`;
  // The memory half goes when the store prunes the record.
  if (queueStore) queueStore.onDrop = (record) => { queueMemo.delete(memoKey(record.owner, record.clientMessageId)); };
  const nudgeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const draining = new Map<string, Promise<void>>();
  const rerun = new Set<string>();
  const lastDelivered = new Map<string, { turnId?: string; at: number; sawRunning: boolean }>();
  const deliveredLog = new Map<string, Array<ChatDeliveredMessage & { owner: ChatOwner }>>();
  let queueTick: ReturnType<typeof setInterval> | undefined;

  const noteDelivered = (id: string, owner: ChatOwner, clientMessageId: string, text: string) => {
    const list = deliveredLog.get(id) ?? [];
    list.push({ owner, clientMessageId, text, at: now() });
    deliveredLog.set(id, list.slice(-DELIVERED_KEEP));
  };

  /** The text of the one daemon send that started the aimed turn; none when zero or several fit. */
  const sentTextFor = (id: string, turnStartedAt: number, requestedAt: number): string | undefined => {
    const fits = (deliveredLog.get(id) ?? []).filter((entry) =>
      entry.at >= turnStartedAt - CANCEL_CLOCK_SKEW_MS && entry.at <= requestedAt);
    return fits.length === 1 ? fits[0].text : undefined;
  };

  const queueOutcome = (record: Readonly<ChatQueueRecord>, replayed: boolean): ChatSendOutcome =>
    ({ clientMessageId: record.clientMessageId, replayed, queueState: record.state, ...(record.reason ? { queueReason: record.reason } : {}) });

  /**
   * A re-post of an id the queue knows. The body must match: by the memory
   * fingerprint, else the send receipt's, else (after a restart, with
   * neither) at least the pane; anything else is a conflict, never another
   * pane's replay.
   */
  const heldReplay = (record: Readonly<ChatQueueRecord>, paneId: string, fingerprint: string,
    receipt: { fingerprint: string } | undefined): ChatSendOutcome => {
    const memo = queueMemo.get(memoKey(record.owner, record.clientMessageId));
    const same = memo ? memo.fingerprint === fingerprint : receipt ? receipt.fingerprint === fingerprint : record.paneId === paneId;
    return same && record.paneId === paneId ? queueOutcome(record, true) : refuse(record.clientMessageId, 'message-id-conflict');
  };

  /** A file-bound agent is visibly working (not merely blocked on a dialog): the cheap pre-check. */
  const agentWorking = (state: ChatAgentState): boolean =>
    state.agentStatus === 'running' || state.turn?.state === 'running' && state.agentStatus !== 'awaiting_input';

  const emitQueue = (record: Readonly<ChatQueueRecord>) => {
    try {
      deps.onQueueEvent?.({ sessionId: record.paneId, owner: record.owner, clientMessageId: record.clientMessageId,
        state: record.state, ...(record.reason ? { reason: record.reason } : {}), at: record.at });
    } catch (error) {
      deps.log('warn', `[chat] queue event failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Running for the queue's purpose: a dialog inside the turn counts. */
  const turnRunning = (id: string, resolution: ChatResolution, read?: ChatAgentState): boolean => {
    if (resolution.source === 'tui') return resolution.status.agentStatus !== 'complete';
    const state = read ?? deps.chatAgentState(id);
    return state.turn?.state === 'running' || state.agentStatus === 'running' || state.agentStatus === 'awaiting_input';
  };

  /** `silent`: an item held back to `queued` after `delivering` never shows that flip on SSE. */
  const settle = (record: Readonly<ChatQueueRecord>, state: ChatQueueState, reason?: ChatQueueReason, silent = false) => {
    const next = queueStore?.transition(record.owner, record.clientMessageId, state, reason);
    if (!next) return;
    if (state !== 'queued' && state !== 'delivering') {
      const memo = queueMemo.get(memoKey(record.owner, record.clientMessageId));
      if (memo) { delete memo.text; delete memo.authorized; }
    }
    if (!silent) emitQueue(next);
    syncQueueWatch(record.paneId);
  };

  /**
   * While an OpenCode item waits, the queue holds its own plugin watch: its
   * 1 s poll reports the phase flipping back to `complete`, which nudges the
   * queue (index.ts) instead of leaving it to the backup poll.
   */
  const queueWatched = new Set<string>();
  function syncQueueWatch(id: string): void {
    const want = !!queueStore?.list(id).some((record) => isActiveQueueState(record.state) &&
      queueMemo.get(memoKey(record.owner, record.clientMessageId))?.source === 'tui');
    if (want === queueWatched.has(id)) return;
    try {
      if (want) { queueWatched.add(id); deps.terminalChat()?.subscribe(QUEUE_WATCH_CLIENT, id); }
      else { queueWatched.delete(id); deps.terminalChat()?.unsubscribe(QUEUE_WATCH_CLIENT, id); }
    } catch (error) {
      deps.log('warn', `[chat] queue watch for ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The episode the last delivery opened has been seen running. */
  const markRunning = (id: string, turnId: string | undefined, tui: boolean) => {
    const last = lastDelivered.get(id);
    if (last && (tui || turnId === last.turnId)) last.sawRunning = true;
  };

  const startQueueTick = () => {
    if (queueTick || !queueStore) return;
    queueTick = setInterval(() => {
      const panes = queueStore.activePanes();
      if (!panes.length) { clearInterval(queueTick); queueTick = undefined; return; }
      for (const id of panes) void kickQueue(id);
    }, deps.queueTickMs ?? CHAT_QUEUE_TICK_MS);
    queueTick.unref?.();
  };

  const enqueue = (req: ChatSendRequest, source: 'file' | 'tui', fingerprint: string): ChatSendOutcome => {
    const { owner, id, clientMessageId } = req;
    const inserted = queueStore!.insert(owner, id, clientMessageId);
    if (inserted === 'exists') return heldReplay(queueStore!.get(owner, clientMessageId)!, id, fingerprint, undefined);
    if (inserted === 'full') return refuse(clientMessageId, 'queue-full');
    if (inserted === 'persist-failed') return refuse(clientMessageId, 'chat-persist-failed');
    queueMemo.set(memoKey(owner, clientMessageId), {
      fingerprint, preview: Array.from(req.text).slice(0, QUEUE_PREVIEW_CHARS).join(''), text: req.text,
      agentSessionId: req.agentSessionId, ...(req.historyEpoch !== undefined ? { historyEpoch: req.historyEpoch } : {}),
      source, incarnation: deps.pane(id)?.meta.incarnationId, authorized: req.queue!.authorized,
    });
    const record = queueStore!.get(owner, clientMessageId)!;
    emitQueue(record);
    syncQueueWatch(id);
    startQueueTick();
    void kickQueue(id);
    return queueOutcome(record, false);
  };

  const cancelQueued = (match: (record: Readonly<ChatQueueRecord>) => boolean, reason: ChatQueueReason) => {
    if (!queueStore) return;
    for (const id of queueStore.activePanes()) {
      for (const record of queueStore.list(id)) {
        if (record.state === 'queued' && match(record)) settle(record, 'canceled', reason);
      }
    }
  };

  /** Where one delivery attempt leaves the item: final, or held for the next idle. */
  const queueVerdict = (outcome: StoredChatOutcome): { state: ChatQueueState; reason?: ChatQueueReason } | { hold: QueueMemo['hold'] | null } => {
    if (outcome.result === 'sent' && !outcome.error) return { state: 'delivered' };
    // It may have been typed (a paste without its Enter, a plugin answer
    // lost): never a state that invites the phone to send it again.
    if (outcome.effect === 'uncertain') return { state: 'uncertain', reason: 'delivery-unconfirmed' };
    switch (outcome.error) {
      case 'chat-busy': return { hold: null };
      case 'chat-blocked': return { hold: outcome.blockedBy === 'approval' ? 'prompt-active' : 'blocked' };
      case 'chat-unavailable':
      case 'opencode-receipts-full':
        if (outcome.effect === 'none') return { hold: null };
        break;
      case 'session-changed': return { state: 'canceled', reason: 'session-changed' };
      case 'input-not-provably-empty': return { state: 'failed', reason: 'draft-present' };
      case 'authorization-expired': return { state: 'canceled', reason: 'authorization-revoked' };
    }
    return { state: 'failed', reason: 'delivery-unconfirmed' };
  };

  const stillHead = (id: string, record: Readonly<ChatQueueRecord>) => {
    const head = queueStore?.head(id);
    return !!head && head.owner === record.owner && head.clientMessageId === record.clientMessageId;
  };

  /**
   * One pass over a pane's queue: deliver the head when the turn is over,
   * one item per ended turn, through the same guarded dispatch as a direct
   * send. Holds (running, busy, a dialog) leave the item queued for the next
   * pass; nothing is retried after a write.
   */
  const drainQueue = async (id: string): Promise<void> => {
    if (!queueStore) return;
    for (;;) {
      const head = queueStore.head(id);
      if (!head) return;
      const memo = queueMemo.get(memoKey(head.owner, head.clientMessageId));
      if (!memo?.text || !memo.authorized) { settle(head, 'canceled', 'daemon-restart'); continue; }
      const text = memo.text;
      const pane = deps.pane(id);
      if (!pane) { cancelQueued((record) => record.paneId === id, 'pane-closed'); return; }
      if (memo.retryAt !== undefined && now() < memo.retryAt) return;
      if (sending.has(id)) return;
      // The lifetime counts only while the item waits on an agent that is not
      // working (idle, or blocked on a dialog): a long turn never expires it.
      const expired = () => {
        memo.idleSince ??= now();
        if (now() - memo.idleSince <= queueTtl) return false;
        settle(head, 'failed', memo.hold ?? 'expired');
        return true;
      };
      // Cheap check first for a file binding: while the agent works, no
      // roster read and no resolve; the turn-end event kicks again. OpenCode's
      // only reliable signal is the plugin's own phase, read below (the
      // queue's watch nudges when it changes).
      if (memo.source === 'file') {
        const cheap = deps.chatAgentState(id);
        if (agentWorking(cheap)) { markRunning(id, cheap.turn?.id, false); delete memo.idleSince; return; }
        if (expired()) continue;
      }
      const authorize = memo.authorized;
      const incarnation = memo.incarnation;
      const authorized = async (stage: 'first-write' | 'submit') => {
        if (deps.pane(id)?.meta.incarnationId !== incarnation) return false;
        try { return await authorize(stage); } catch { return false; }
      };
      if (pane.meta.incarnationId !== memo.incarnation || !await authorized('first-write')) {
        if (stillHead(id, head)) settle(head, 'canceled', 'authorization-revoked');
        continue;
      }
      const resolution = await resolve(id);
      if (!stillHead(id, head)) continue;
      if (memo.source === 'tui') {
        if (resolution.source === 'tui' && resolution.status.agentStatus === 'running') {
          markRunning(id, undefined, true);
          delete memo.idleSince;
          return;
        }
        if (expired()) continue;
      }
      // The agent may be between two readable states: wait (the TTL bounds it).
      if (resolution.source === 'none') return;
      if (resolution.source !== memo.source || resolution.status.agentSessionId !== memo.agentSessionId ||
          memo.historyEpoch !== undefined && memo.historyEpoch !== resolution.epoch) {
        settle(head, 'canceled', 'session-changed');
        continue;
      }
      if (sending.has(id)) return;
      if (hasOpenApproval(id) || resolution.source === 'tui' && resolution.status.agentStatus === 'awaiting_input') {
        memo.hold = resolution.source === 'tui' || blockedBy(id) === 'approval' ? 'prompt-active' : 'blocked';
        return;
      }
      const live = resolution.source === 'file' ? deps.chatAgentState(id) : undefined;
      if (resolution.source === 'file' && !resolution.status.terminal?.capabilities.send) return;
      const running = turnRunning(id, resolution, live);
      // One item per ended turn. The delivering Enter opens the next episode
      // at once (new id) while the status may still read idle, and the
      // OpenCode plugin can still read `complete`: the turn a delivery started
      // must be SEEN running before its end counts, so a stale `complete`
      // never delivers two in a row. A turn that never shows as running (a
      // prompt that started none) releases after a while.
      const last = lastDelivered.get(id);
      if (last && (resolution.source === 'tui' || live?.turn?.id === last.turnId)) {
        if (running) last.sawRunning = true;
        if (!last.sawRunning && now() - last.at < QUEUE_TURN_GATE_STALE_MS) return;
      }
      if (running) return;
      if (!stillHead(id, head)) continue;
      // Synchronous from the head check: DELETE now answers delivery-in-progress.
      const delivering = queueStore.transition(head.owner, head.clientMessageId, 'delivering', undefined, { strict: true });
      if (!delivering) {
        memo.persistFailures = (memo.persistFailures ?? 0) + 1;
        deps.log('warn', `[chat] queue item for ${id} not persisted (${memo.persistFailures}/${QUEUE_PERSIST_ATTEMPTS})`);
        if (memo.persistFailures >= QUEUE_PERSIST_ATTEMPTS) { settle(head, 'failed', 'delivery-unconfirmed'); continue; }
        memo.retryAt = now() + 1_000 * 2 ** memo.persistFailures;
        return;
      }
      delete memo.persistFailures;
      delete memo.retryAt;
      // Announced only once the first write is authorized, the last step before
      // it: a hold found earlier returns the item to `queued` without the phone
      // ever seeing it flip.
      let announced = false;
      const announce = () => {
        if (announced) return;
        announced = true;
        emitQueue(queueStore.get(head.owner, head.clientMessageId) ?? delivering);
      };
      const receipts = deps.receipts;
      const inserted = receipts?.insertPending(head.owner, head.clientMessageId, {
        paneId: id, fingerprint: memo.fingerprint, agentSessionId: memo.agentSessionId,
        ...(memo.historyEpoch !== undefined ? { historyEpoch: memo.historyEpoch } : {}),
      });
      if (inserted === 'exists') { settle(head, 'failed', 'delivery-unconfirmed'); continue; }
      const req: ChatSendRequest = { owner: head.owner, id, agentSessionId: memo.agentSessionId,
        ...(memo.historyEpoch !== undefined ? { historyEpoch: memo.historyEpoch } : {}),
        text, clientMessageId: head.clientMessageId, authorized: async (stage) => {
          const ok = await authorized(stage ?? 'first-write');
          if (ok) announce();
          return ok;
        } };
      let outcome: StoredChatOutcome;
      try {
        outcome = resolution.source === 'tui' ? await dispatchTui(req, resolution) : await dispatchFile(req, { idleOnly: true });
      } catch {
        outcome = { result: 'unconfirmed', effect: 'uncertain', error: 'delivery-unconfirmed' };
      }
      const verdict = queueVerdict(outcome);
      if ('hold' in verdict) {
        if (inserted === 'inserted') receipts?.discard(head.owner, head.clientMessageId);
        if (verdict.hold) memo.hold = verdict.hold;
        settle(head, 'queued', undefined, true);
        return;
      }
      if (inserted === 'inserted' && !receipts?.complete(head.owner, head.clientMessageId, outcome)) {
        deps.log('warn', `[chat] send receipt for queued ${id} not persisted`);
      }
      if (verdict.state === 'delivered') {
        // The episode this delivery opened (the Enter bumps it synchronously).
        const opened = resolution.source === 'file' ? deps.chatAgentState(id).turn : undefined;
        lastDelivered.set(id, { turnId: opened?.id, at: now(), sawRunning: opened?.state === 'running' });
        noteDelivered(id, head.owner, head.clientMessageId, text);
        settle(head, verdict.state, verdict.reason);
        // At most one delivery per pass: the next waits for this one's turn.
        return;
      }
      settle(head, verdict.state, verdict.reason);
    }
  };

  function nudgeQueue(id: string): void {
    if (!queueStore?.hasActive(id) || nudgeTimers.has(id)) return;
    const timer = setTimeout(() => { nudgeTimers.delete(id); void kickQueue(id); }, QUEUE_NUDGE_DEBOUNCE_MS);
    timer.unref?.();
    nudgeTimers.set(id, timer);
  }

  /** One pass per pane at a time; a kick during a pass runs one more after it (the pass may have read stale state). */
  function kickQueue(id: string): Promise<void> {
    const running = draining.get(id);
    if (running) { rerun.add(id); return running; }
    if (!queueStore?.hasActive(id)) return Promise.resolve();
    const pass = (async () => {
      try { do { rerun.delete(id); await drainQueue(id); } while (rerun.has(id)); }
      catch (error) { deps.log('warn', `[chat] queue pass for ${id} failed: ${error instanceof Error ? error.message : String(error)}`); }
      // In the same tick as the last `rerun` check, so no kick falls between the two.
      finally { draining.delete(id); rerun.delete(id); }
    })();
    draining.set(id, pass);
    return pass;
  }

  const queueView = (owner: ChatOwner, id: string): ChatQueueItemView[] => {
    if (!queueStore) return [];
    return queueStore.list(id).filter((record) => record.owner === owner).map((record) => {
      const memo = queueMemo.get(memoKey(owner, record.clientMessageId));
      return { clientMessageId: record.clientMessageId, state: record.state, ...(record.reason ? { reason: record.reason } : {}),
        queuedAt: record.queuedAt, at: record.at, ...(memo ? { preview: memo.preview } : {}) };
    });
  };

  const dequeue = (owner: ChatOwner, id: string, clientMessageId: string): ChatDequeueResult => {
    const record = queueStore?.get(owner, clientMessageId);
    if (!record || record.paneId !== id) return { ok: false, error: 'queue-item-not-found' };
    const final = { state: record.state, ...(record.reason ? { reason: record.reason } : {}) };
    switch (record.state) {
      case 'queued': settle(record, 'canceled', 'user'); return { ok: true };
      case 'canceled': return { ok: true };
      case 'delivered': return { ok: false, error: 'already-delivered', ...final };
      case 'delivering': return { ok: false, error: 'delivery-in-progress', ...final };
      default: return { ok: false, error: 'queue-item-final', ...final };
    }
  };

  /** The send receipt, with the queue's record laid over it for a queued message. */
  const receiptView = (owner: ChatOwner, id: string, clientMessageId: string): ChatSendReceiptView => {
    const view: ChatSendReceiptView = deps.receipts?.view(owner, id, clientMessageId) ?? { clientMessageId, state: 'unknown' };
    const record = queueStore?.get(owner, clientMessageId);
    if (!record || record.paneId !== id) return view;
    const queue = { state: record.state, ...(record.reason ? { reason: record.reason } : {}) };
    if (view.state !== 'unknown') return { ...view, queue };
    const state = record.state === 'queued' || record.state === 'delivering' ? 'queued' as const
      : record.state === 'delivered' ? 'submitted' as const : record.state === 'uncertain' ? 'uncertain' as const : 'refused' as const;
    return { clientMessageId, state, at: record.queuedAt, queue };
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
    opts: { turnId?: string; authorized?: () => Promise<boolean>; beforeWrite?: (turn: { id: string; startedAt: number }) => boolean;
      native?: () => Promise<'interrupted' | 'not-written' | 'uncertain'>; nativeStillAimed?: () => boolean;
      fallbackRefused?: (verdict: ChatInterruptVerdict) => void; escWriting?: () => void } = {},
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
          opts.escWriting?.();
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
        ...(opts.native ? { native: opts.native, noteInterrupt: () => { try { deps.pane(id)?.bridge.noteInterrupt?.(); } catch { /* best effort */ } } } : {}),
        ...(opts.nativeStillAimed ? { nativeStillAimed: opts.nativeStillAimed } : {}),
        ...(opts.fallbackRefused ? { fallbackRefused: opts.fallbackRefused } : {}),
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
    // The receipt is written as the last step before the abort request
    // leaves: after the owner, descriptor and write-time authorization
    // checks, inside the final authorization callback (no await follows it).
    let inserted: ReturnType<ChatCancelReceiptStore['insertPending']> | undefined;
    const authorized = async (): Promise<boolean> => {
      if (req.authorized && !await req.authorized()) return false;
      inserted = store.insertPending(owner, clientCancelId, { paneId: id, fingerprint });
      return inserted === 'inserted';
    };
    sending.add(id);
    let aborted: Awaited<ReturnType<NonNullable<typeof service.abort>>>;
    try {
      aborted = await service.abort(id, req.agentSessionId, {
        // The resolution's own read: no second round trip under the lock.
        read: { status: resolution.status, page: resolution.page },
        // Only the read whose hash the phone matched may reach the plugin (N15).
        ...(req.historyEpoch !== undefined ? { expectedRawEpoch: resolution.rawEpoch } : {}),
        ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
        authorized,
      });
    } catch (error) {
      // Every path below settles an inserted receipt, so none is left pending
      // (a daemon crash in between reads as uncertain after the restart).
      aborted = { result: 'unconfirmed' };
      deps.log('warn', `[chat] cancel for ${id} threw: ${error instanceof Error ? error.message : String(error)}`);
    } finally { sending.delete(id); }
    if (inserted !== undefined && inserted !== 'inserted') {
      if (inserted === 'exists') return early() ?? refuse('cancel-id-conflict');
      return refuse(inserted === 'full' ? 'message-history-full' : 'chat-persist-failed');
    }
    if (aborted.result === 'sent' || aborted.result === 'unconfirmed') {
      const turnId = aborted.turn?.id ?? req.turnId ?? resolution.turn?.id;
      const outcome = { effect: aborted.result === 'sent' ? 'interrupt-requested' as const : 'uncertain' as const, ...(turnId ? { turnId } : {}) };
      // Nothing observes an OpenCode abort yet (its `native` evidence is not
      // served): its outcome is `unknown` from the start, never a `requested`
      // that no one would ever settle.
      const progress: StoredCancelProgress = aborted.result === 'sent'
        ? { state: 'unknown', at: now() } : { state: 'unknown', reason: 'write-uncertain', at: now() };
      if (inserted === 'inserted' && !store.complete(owner, clientCancelId, outcome, progress)) deps.log('warn', `[chat] cancel receipt for ${id} not persisted`);
      if (inserted === 'inserted') cancelObserver?.announce({ owner, paneId: id, clientCancelId, ...(turnId ? { turnId } : {}) }, progress);
      const view = aborted.result === 'sent' ? store.progress(owner, clientCancelId) : undefined;
      return { clientCancelId, replayed: false, ...outcome, ...(aborted.result === 'unconfirmed' ? { error: 'cancel-failed' as const } : {}),
        ...(view ? { cancel: view } : {}) };
    }
    if (inserted === 'inserted') store.discard(owner, clientCancelId);
    switch (aborted.result) {
      case 'not_running': return notRunning(aborted.turn ?? resolution.turn);
      case 'prompt_active': return refuse('prompt-active', promptActive(id));
      // The admission fence: the turn is about to run; try again shortly.
      case 'pending': return refuse('cancel-cooldown', { retryAfterMs: OPENCODE_FENCE_RETRY_MS });
      case 'session_changed': {
        const fresh = await resolve(id);
        const identity = identityOf(fresh);
        // The same identity again: a plugin-side generation the phone cannot
        // see changed. Re-reading would not help, so this is not session-changed.
        if (identity.agentSessionId === req.agentSessionId && (req.historyEpoch === undefined || identity.historyEpoch === req.historyEpoch)) {
          return refuse('chat-unavailable');
        }
        return refuse('session-changed', identity);
      }
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
      // A replay carries the progress as it is now: the receipt is authoritative.
      const progress = store.progress(owner, clientCancelId);
      return { clientCancelId, replayed: true, effect: entry.outcome.effect, ...(entry.outcome.turnId ? { turnId: entry.outcome.turnId } : {}),
        ...(entry.outcome.effect === 'uncertain' ? { error: 'cancel-failed' as const } : {}), ...(progress ? { cancel: progress } : {}) };
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
    let aimedStartedAt = 0;
    let aimedPane: P | undefined;
    let lastEventId: string | undefined;
    let writeAt: number | undefined;
    // Set once the receipt reads `requested` (and was announced) before the
    // lock is released: a native request the server acknowledged.
    let requestedEarly = false;
    let escRefused: ChatCancelTag | undefined;
    // Codex relay panes: the agent's own `turn/interrupt` first, then the ESC
    // gates again unless the pane's own stream proved the turn interrupted.
    // The Codex turn is pinned here, at entry: the request and the fallback
    // ESC are both for this turn and no later one.
    const interruptNative = deps.relays.interrupt;
    const codexTurn = agent === 'codex' && interruptNative ? deps.relays.activeTurn?.(id, deps.pane(id)) : undefined;
    const markRequested = () => {
      if (requestedEarly || inserted !== 'inserted' || writeAt === undefined) return;
      requestedEarly = true;
      const progress: StoredCancelProgress = { state: 'requested', at: writeAt };
      if (!store.complete(owner, clientCancelId, { effect: 'interrupt-requested', ...(aimed ? { turnId: aimed } : {}) }, progress)) {
        deps.log('warn', `[chat] cancel receipt for ${id} not persisted`);
      }
      cancelObserver?.announce({ owner, paneId: id, clientCancelId, ...(aimed ? { turnId: aimed } : {}) }, progress);
    };
    // `native` evidence only when the proof came from the native path alone: no
    // ESC was written for this cancel, and the server acknowledged the request
    // or the stream proved it during the wait. After a fallback ESC, the ESC
    // path's own evidence rules decide.
    let nativeOutcome: 'interrupted' | 'not-written' | 'uncertain' | undefined;
    let escWritten = false;
    const native = codexTurn && interruptNative
      ? async (): Promise<'interrupted' | 'not-written' | 'uncertain'> =>
        (nativeOutcome = (await interruptNative(id, deps.pane(id), codexTurn, { answered: markRequested })).outcome)
      : undefined;
    const nativeStillAimed = codexTurn ? () => deps.relays.stillRunning?.(id, deps.pane(id), codexTurn) ?? false : undefined;
    const fallbackRefused = (verdict: ChatInterruptVerdict) => {
      escRefused = ESC_REFUSED[verdict] ?? 'chat-unavailable';
      deps.log('info', `[chat] cancel for ${id}: native interrupt sent, fallback ESC refused (${verdict})`);
    };
    const beforeWrite = (target: { id: string; startedAt: number }): boolean => {
      aimed = target.id;
      aimedStartedAt = target.startedAt;
      aimedPane = deps.pane(id);
      // The first write happens right after this; a native wait may delay the ESC.
      writeAt = now();
      // Where the transcript stands right before the ESC: only records after
      // this can be the aimed turn's end (an earlier turn merged into the same
      // episode has its end before it). Unreadable: timestamps alone decide.
      try { const events = deps.projector.snapshot(id)?.events; lastEventId = events?.[events.length - 1]?.id; } catch { lastEventId = undefined; }
      inserted = store.insertPending(owner, clientCancelId, { paneId: id, fingerprint });
      return inserted === 'inserted';
    };
    let verdict: ChatInterruptVerdict | 'busy';
    try {
      verdict = await interruptLocked(id, req.agentSessionId, { ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
        ...(req.authorized ? { authorized: req.authorized } : {}), beforeWrite,
        ...(native && nativeStillAimed ? { native, nativeStillAimed, fallbackRefused, escWriting: () => { escWritten = true; } } : {}) });
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
    // A fallback ESC that threw after an acknowledged native request: the
    // interrupt certainly landed, so it stays a `requested` cancel.
    if (requestedEarly && verdict === 'error') verdict = 'sent';
    if (inserted === 'inserted' && (verdict === 'sent' || verdict === 'error')) {
      // `error` = the write threw: the ESC may have reached the pane.
      const outcome = { effect: verdict === 'sent' ? 'interrupt-requested' as const : 'uncertain' as const, ...(aimed ? { turnId: aimed } : {}) };
      const requestedAt = writeAt ?? now();
      const progress: StoredCancelProgress = verdict === 'sent'
        ? { state: 'requested', at: requestedAt } : { state: 'unknown', reason: 'write-uncertain', at: requestedAt };
      const watched = { owner, paneId: id, clientCancelId, ...(aimed ? { turnId: aimed } : {}) };
      // Already stored and announced when the server acknowledged the native request.
      if (!requestedEarly) {
        if (!store.complete(owner, clientCancelId, outcome, progress)) deps.log('warn', `[chat] cancel receipt for ${id} not persisted`);
        cancelObserver?.announce(watched, progress);
      }
      if (verdict === 'sent' && aimed && aimedPane) {
        const sentText = sentTextFor(id, aimedStartedAt, requestedAt);
        cancelObserver?.watch({ ...watched, turnId: aimed, turnStartedAt: aimedStartedAt, requestedAt,
          incarnationId: aimedPane.meta.incarnationId, agentSessionId: req.agentSessionId, slug: agent,
          boundary: { ...(lastEventId !== undefined ? { lastEventId } : {}), since: requestedAt - CANCEL_CLOCK_SKEW_MS },
          ...(agent === 'claude' && sentText !== undefined ? { sentText } : {}),
          ...(codexTurn && !escWritten && (nativeOutcome === 'interrupted' || requestedEarly) ? { codexTurn } : {}) } satisfies ObservedCancel);
      } else if (verdict === 'sent') {
        // The pane was already gone at the write: nothing can be observed.
        cancelObserver?.settle(watched, { state: 'unknown', reason: 'pane-closed', at: now() });
      }
      const view = verdict === 'sent' ? store.progress(owner, clientCancelId) : undefined;
      return { clientCancelId, replayed: false, ...outcome, ...(verdict === 'error' ? { error: 'cancel-failed' as const } : {}),
        ...(view ? { cancel: view } : {}), ...(escRefused ? { escRefused } : {}) };
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

  /** A refused fallback ESC after a native request that may have landed, as the cancel's own refusal tags. */
  const ESC_REFUSED: Partial<Record<ChatInterruptVerdict, ChatCancelTag>> = {
    unauthorized: 'authorization-expired', blocked: 'prompt-active', session_changed: 'session-changed',
    not_running: 'turn-not-running', turn_mismatch: 'turn-not-running', already_interrupted: 'turn-already-interrupted',
    cooldown: 'cancel-cooldown', unavailable: 'chat-unavailable',
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
    sent: 'sent', not_running: 'not_running', pending: 'not_running', prompt_active: 'blocked', session_changed: 'session_changed', unconfirmed: 'error',
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
      try { return DESKTOP_ABORT[(await service.abort(id, agentSessionId, { read: found.read })).result] ?? 'unavailable'; }
      catch { return 'error'; } finally { sending.delete(id); }
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
        // Typed into an idle zsh/bash/sh prompt (idleShell refuses anything else), so the
        // shell's own "$PWD" is the directory Codex should start in; a tracked cwd can only lag it.
        command = withCodexRemote(command, relay.url, codexCdOperand());
      }
      // A pane created with a chosen account launches that vendor's agent on it,
      // whatever the shell's rc files exported (see withChosenAccountEnv).
      command = withChosenAccountEnv(command, pane.meta, agent);
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
    receipt: receiptView,
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
    cancelOutcomeEnabled: () => !!deps.cancelReceipts,
    cancelOutcome: (owner, id, clientCancelId) => {
      const store = deps.cancelReceipts;
      if (!store) return null;
      // Pane-bound: a receipt for another pane reads as none.
      if (store.lookup(owner, clientCancelId)?.paneId !== id) return undefined;
      return store.progress(owner, clientCancelId);
    },
    queueEnabled: () => !!queueStore,
    queue: queueView,
    dequeue,
    dropQueue: (match, reason) => cancelQueued((record) => match(record.owner), reason),
    delivered: (owner, id) => (deliveredLog.get(id) ?? []).filter((entry) => entry.owner === owner)
      .map(({ clientMessageId, text, at }) => ({ clientMessageId, text, at })),
    kickQueue,
    nudgeQueue,
    paneClosed: (id) => {
      if (queueWatched.delete(id)) {
        try { deps.terminalChat()?.unsubscribe(QUEUE_WATCH_CLIENT, id); } catch { /* the watch dies with the pane */ }
      }
      lastDelivered.delete(id);
      clearTimeout(nudgeTimers.get(id)); nudgeTimers.delete(id);
      deliveredLog.delete(id);
      cancelQueued((record) => record.paneId === id, 'pane-closed');
    },
  };
}
