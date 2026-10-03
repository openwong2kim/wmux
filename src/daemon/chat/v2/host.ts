import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { applyHarnessEvent, blockChangeFrom } from '../../../shared/chatv2/apply';
import type { HarnessEvent, StampedHarnessEvent } from '../../../shared/chatv2/harnessEvents';
import {
  CHATV2_ATTACHMENT_DIR,
  CHATV2_MODEL,
  CHATV2_PROVIDER_SESSION_ID,
  chatV2Error,
  type ChatV2Binding,
  type ChatV2Capabilities,
  type ChatV2Error,
  type ChatV2EventsPush,
  type ChatV2Method,
  type ChatV2ParamsByMethod,
  type ChatV2ResultByMethod,
  type ChatV2Status,
} from '../../../shared/chatv2/ipc';
import {
  CHATV2_BODY_STORE_MAX_BYTES,
  CHATV2_DISPOSE_TIMEOUT_MS,
  CHATV2_PAGE_BUDGET_BYTES,
  CHATV2_PERSIST_DEBOUNCE_MS,
  CHATV2_ANSWER_ARM_MS,
  CHATV2_SEND_LEDGER_MAX,
  truncateUtf8,
  utf8Bytes,
} from '../../../shared/chatv2/limits';
import { agentExecEnv } from '../../../shared/execEnv';
import { newChatSession, sessionNeedsInput, type Attachment, type Block, type Session } from '../../../shared/chatv2/session';
import { CHAT_IMAGE_EXTENSIONS, CHAT_IMAGE_MAX_BYTES } from '../../../shared/transcript/chatAttachments';
import type { DecisionForm, NativeDecisionOutcome, NativeDecisionRef, NativeDecisionReply } from '../../approvals/types';
import { ClaudeDriver } from './claude/claudeDriver';
import { CLAUDE_SETTING_SOURCES, CLAUDE_SETTING_SOURCES_PATTERN } from './claude/claudeProtocol';
import { buildDriverEnv, DriverEnvError } from './env';
import { boundEvent, EventBatcher } from './eventBatcher';
import { claimChatV2Pane, releaseChatV2Pane } from './paneClaims';
import { handOffToTerminal, handedOffRefusal } from './handoff';
import { classifyShell } from '../../shell-integration';
import { ChatV2Store } from './store';
import {
  CHATV2_DAEMON_EVENT,
  type ChatV2Driver,
  type ChatV2DriverDecision,
  type ChatV2DriverFactory,
  type ChatV2Host,
  type ChatV2HostDeps,
  type ChatV2StoredRecord,
} from './types';

/**
 * Dev and test knob, read from the daemon's own environment: the
 * `--setting-sources` a Claude driver starts with. Production leaves it unset
 * (`user,project,local`). An isolated check sets `project` so the user's own
 * allow rules do not answer the permission prompts it exercises.
 */
export const CHATV2_SETTING_SOURCES_ENV = 'WMUX_CHATV2_SETTING_SOURCES';

/**
 * Where a new driver runs: the pane's current directory (shell integration /
 * OSC 7) when it names an existing directory, else the directory the pane was
 * spawned in. The pane is idle when a chat starts (the single-writer check),
 * so the current value is the shell's own last report; the chat shows the
 * directory before and after it starts. An owner decision for chat v2;
 * `spawnCwd` stays the root for the diff route. Synchronous: `create`
 * reserves the pane before its first await.
 */
export function driverCwd(meta: { cwd?: string; spawnCwd?: string }): string | undefined {
  const live = meta.cwd;
  if (live && path.isAbsolute(live)) {
    try {
      if (fs.statSync(live).isDirectory()) return live;
    } catch { /* gone: fall back */ }
  }
  return meta.spawnCwd || undefined;
}

/** The built-in drivers. */
export function defaultChatV2Drivers(env: NodeJS.ProcessEnv = process.env): ChatV2DriverFactory {
  const requested = env[CHATV2_SETTING_SOURCES_ENV];
  const settingSources = requested && CLAUDE_SETTING_SOURCES_PATTERN.test(requested) ? requested : CLAUDE_SETTING_SOURCES;
  return (agent) => (agent === 'claude' ? new ClaudeDriver({ settingSources }) : null);
}

type Result<M extends ChatV2Method> = ChatV2ResultByMethod[M];

/** One decision the host holds for the driver, by its request id. */
interface HeldDecision {
  kind: 'permission' | 'questions';
  native: NativeDecisionRef;
  /** The registry record, or null when none was made (failed closed). */
  registryId: string | null;
  /** Denied at once: no registry, or no record. */
  failClosed: boolean;
  /**
   * The record landed on the `none` channel (native phone decisions are
   * off): a view-only card for the phone, answered from the desktop only,
   * straight to the driver.
   */
  desktopOnly: boolean;
  /** When the host recorded it; a desktop-only answer arms CHATV2_ANSWER_ARM_MS later. */
  notedAt: number;
  /** A desktop-only answer is on its way to the driver. */
  answering: boolean;
  /** Settles once the registry call (and a fail-closed deny) is done. */
  recorded: Promise<void>;
}

type InboxItem =
  | { kind: 'event'; driver: ChatV2Driver; event: HarnessEvent }
  | { kind: 'decision'; driver: ChatV2Driver; decision: ChatV2DriverDecision }
  | { kind: 'gone'; requestId: string }
  | { kind: 'exited'; driver: ChatV2Driver }
  | { kind: 'stamp'; event: HarnessEvent };

interface Live {
  record: ChatV2StoredRecord;
  /** Uncapped fold for `bodies`, rebased onto the capped fold at every turn end. */
  shadow: Session;
  epoch: string;
  driver: ChatV2Driver | null;
  /** A start in flight. */
  starting: boolean;
  /** The last start failed. */
  failed: boolean;
  /** The driver is being stopped on purpose (close, dispose): its exit is not an error. */
  stopping: boolean;
  error?: ChatV2Error;
  /** A send between its checks and the driver write. */
  sending: boolean;
  closed: boolean;
  decisions: Map<string, HeldDecision>;
  inbox: InboxItem[];
  draining: boolean;
  /** Resolves when the inbox is empty again. */
  drained: Promise<void>;
  /** The driver's end is queued in the inbox: report `stopped` before it is folded. */
  exitPending: boolean;
  /** A stop did not see the process exit: it may still run, so nothing restarts until it does. */
  unreaped: boolean;
  /** Bumped by every start and by close: a start that outlived its generation stops its driver. */
  generation: number;
  /** Saves run one at a time, in order. */
  saveChain: Promise<void>;
  /** A save that is queued but not yet running; a later persist joins it. */
  savePending: Promise<boolean> | null;
  batcher: EventBatcher;
  /** The capped session when the current batch began. */
  batchBase: Session;
  persistTimer: ReturnType<typeof setTimeout> | null;
  lastBindingKey: string;
}

const PERMISSION_ACTIONS: DecisionForm['actions'] = [
  { id: 'approve', label: 'Allow once' },
  { id: 'deny', label: 'Reject' },
];
const QUESTION_ACTIONS: DecisionForm['actions'] = [
  { id: 'submit', label: 'Submit' },
  { id: 'deny', label: 'Dismiss' },
];

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * One `bodies` page, in UTF-8 bytes. JSON can grow a byte to six (`\u00XX`), so
 * a page stays well under the pipe's 1 MiB frame limit whatever the text is.
 */
const BODY_PAGE_BYTES = 128 * 1024;

function newEpoch(): string {
  return randomBytes(8).toString('hex');
}

function sendDigest(text: string, attachments: readonly string[]): string {
  return createHash('sha256').update([text, ...attachments].join('\u0000')).digest('hex');
}

/** The id of the user block that opened the last turn, or undefined. */
function openTurnId(session: Session): string | undefined {
  for (let i = session.blocks.length - 1; i >= 0; i--) if (session.blocks[i].role === 'user') return session.blocks[i].id;
  return undefined;
}

/** Start index of the longest tail of `blocks` within `budget` bytes (at least one block). */
function tailStart(blocks: readonly Block[], budget: number): number {
  let bytes = 0;
  let start = blocks.length;
  while (start > 0) {
    const size = utf8Bytes(JSON.stringify(blocks[start - 1]));
    if (start < blocks.length && bytes + size > budget) break;
    bytes += size;
    start -= 1;
  }
  return start;
}

/** The value a capped block field had before the cap. */
function fieldOf(block: Block | undefined, field: 'text' | 'detail' | 'output'): string | undefined {
  if (!block) return undefined;
  if (field === 'text') return block.text;
  if (field === 'detail') return block.tool?.detail;
  return block.tool?.preview?.output;
}

/**
 * The chat-v2 host: records keyed by the anchor pane, the authoritative fold,
 * batching and pushes, persistence, and the bridge between a driver's
 * decisions and the ApprovalRegistry. See src/shared/chatv2/ipc.ts.
 */
export function createChatV2Host(deps: ChatV2HostDeps): ChatV2Host {
  return new Host(deps);
}

class Host implements ChatV2Host {
  private readonly store: ChatV2Store;
  private readonly drivers: ChatV2DriverFactory;
  private readonly byPane = new Map<string, Live>();
  private readonly subscribers = new Map<string, Set<string>>();
  private readonly pushListeners = new Set<(push: ChatV2EventsPush) => void>();
  private started: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly deps: ChatV2HostDeps) {
    this.store = new ChatV2Store(path.join(deps.wmuxDir, 'chat-sessions', 'v2'));
    this.drivers = deps.drivers ?? defaultChatV2Drivers();
  }

  // --- lifecycle ----------------------------------------------------------

  start(): Promise<void> {
    this.started ??= this.load();
    return this.started;
  }

  private async load(): Promise<void> {
    const records = this.store.load((message) => this.deps.log('warn', message));
    const newest = new Map<string, ChatV2StoredRecord>();
    for (const record of records) {
      const other = newest.get(record.paneId);
      if (!other || other.savedAt < record.savedAt) newest.set(record.paneId, record);
    }
    for (const record of newest.values()) {
      await this.sweepOrphan(record);
      const live = this.newLive(record);
      this.byPane.set(record.paneId, live);
      claimChatV2Pane(record.paneId);
      // The process that held the open turn is gone: close it, which settles
      // its approval cards and question in the transcript.
      if (record.session.busy || sessionNeedsInput(record.session)) {
        this.stamp(live, { type: 'session.ended', code: null });
      }
      void this.persistNow(live);
    }
  }

  /** Kill a driver left by a previous daemon only when pid, start time and argv marker all match. */
  private async sweepOrphan(record: ChatV2StoredRecord): Promise<void> {
    const process = record.process;
    if (!process) return;
    delete record.process;
    let identity: { startTime: string; commandLine: string } | null = null;
    try {
      identity = await this.deps.processIdentity(process.pid);
    } catch {
      identity = null;
    }
    if (!identity || !process.startTime || identity.startTime !== process.startTime || !process.marker
      || !identity.commandLine.includes(process.marker)) {
      return;
    }
    this.deps.log('info', `[chatv2] stopping driver ${process.pid} left by a previous daemon (${record.chatSessionId})`);
    try {
      await this.deps.killTree(process.pid);
    } catch (error) {
      this.deps.log('warn', `[chatv2] could not stop driver ${process.pid}: ${String(error)}`);
    }
    // Its decisions died with it; a registry that already exists drops their cards.
    const registry = this.deps.approvals();
    if (registry) {
      const ids = record.session.blocks.flatMap((b) => (b.approval && !b.approval.decided ? [b.approval.requestId] : []));
      if (record.session.pendingQuestion) ids.push(record.session.pendingQuestion.requestId);
      if (ids.length) await registry.expireNativeRequests(record.paneId, 'claude', ids).catch(() => 0);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const lives = [...this.byPane.values()];
    const stops = Promise.all(lives.map(async (live) => {
      live.generation += 1;
      if (!(await this.stopDriver(live))) this.deps.log('warn', `[chatv2] the driver of ${live.record.paneId} did not exit`);
      live.batcher.flush();
      await this.persistNow(live);
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      stops,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, CHATV2_DISPOSE_TIMEOUT_MS); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    for (const live of lives) {
      if (live.persistTimer) clearTimeout(live.persistTimer);
      live.batcher.dispose();
    }
  }

  // --- reads --------------------------------------------------------------

  bindingForPane(paneId: string): ChatV2Binding | null {
    const live = this.byPane.get(paneId);
    return live ? this.binding(live) : null;
  }

  sessionForPane(paneId: string): Readonly<Session> | null {
    return this.byPane.get(paneId)?.record.session ?? null;
  }

  statusForPane(paneId: string): ChatV2Status | null {
    const live = this.byPane.get(paneId);
    return live ? this.status(live) : null;
  }

  onPush(listener: (push: ChatV2EventsPush) => void): () => void {
    this.pushListeners.add(listener);
    return () => { this.pushListeners.delete(listener); };
  }

  clientGone(clientId: string): void {
    for (const [paneId, clients] of this.subscribers) {
      clients.delete(clientId);
      if (!clients.size) this.subscribers.delete(paneId);
    }
  }

  private status(live: Live): ChatV2Status {
    if (live.record.state === 'handed-off') return 'handed-off';
    if (live.starting) return 'starting';
    if (live.unreaped) return 'failed';
    if (!live.driver || live.exitPending) return live.failed ? 'failed' : 'stopped';
    if (sessionNeedsInput(live.record.session)) return 'needs-input';
    return live.record.session.busy ? 'running' : 'idle';
  }

  private capabilities(live: Live): ChatV2Capabilities {
    const active = live.record.state === 'active';
    return { send: active, interrupt: active, approvals: active, questions: active, images: active, toTerminal: active };
  }

  private binding(live: Live): ChatV2Binding {
    const { record } = live;
    return {
      paneId: record.paneId,
      chatSessionId: record.chatSessionId,
      agent: record.agent,
      mode: record.mode,
      model: record.model,
      status: this.status(live),
      providerSessionId: record.providerSessionId,
      epoch: live.epoch,
      seq: record.seq,
      capabilities: this.capabilities(live),
      ...(live.error ? { error: { ...live.error } } : {}),
    };
  }

  private bindingKey(binding: ChatV2Binding): string {
    return JSON.stringify({ ...binding, seq: 0 });
  }

  // --- RPC ----------------------------------------------------------------

  async call<M extends ChatV2Method>(method: M, params: ChatV2ParamsByMethod[M], clientId: string): Promise<Result<M>> {
    await this.start();
    if (this.disposed) return chatV2Error('unavailable', 'Chat is shutting down.') as Result<M>;
    const run = this.handlers[method] as (p: ChatV2ParamsByMethod[M], c: string) => Promise<Result<M>>;
    return run(params, clientId);
  }

  private readonly handlers: { [M in ChatV2Method]: (params: ChatV2ParamsByMethod[M], clientId: string) => Promise<Result<M>> } = {
    create: (p) => this.create(p),
    bindingForPane: async (p) => ({ ok: true, binding: this.bindingForPane(p.paneId) }),
    snapshot: async (p) => this.snapshot(p),
    history: async (p) => this.history(p),
    subscribe: async (p, clientId) => {
      let clients = this.subscribers.get(p.paneId);
      if (!clients) this.subscribers.set(p.paneId, (clients = new Set()));
      clients.add(clientId);
      return { ok: true, binding: this.bindingForPane(p.paneId) };
    },
    unsubscribe: async (p, clientId) => {
      const clients = this.subscribers.get(p.paneId);
      clients?.delete(clientId);
      if (clients && !clients.size) this.subscribers.delete(p.paneId);
      return { ok: true };
    },
    send: (p) => this.send(p),
    interrupt: (p) => this.interrupt(p),
    answer: (p) => this.answer(p),
    bodies: async (p) => this.bodies(p),
    toTerminal: (p) => this.toTerminal(p),
    close: (p) => this.close(p),
  };

  private liveFor(paneId: string, chatSessionId: string): Live | null {
    const live = this.byPane.get(paneId);
    return live && live.record.chatSessionId === chatSessionId && !live.closed ? live : null;
  }

  private async create(p: ChatV2ParamsByMethod['create']): Promise<Result<'create'>> {
    const pane = this.deps.sessionManager.getSession(p.paneId);
    if (!pane) return chatV2Error('pane-not-found', 'That pane is gone.');
    if (this.byPane.has(p.paneId)) return chatV2Error('already-exists', 'This pane already has a chat.');
    const cwd = driverCwd(pane.meta);
    if (!cwd) return chatV2Error('pane-not-found', 'The pane has no known working directory.');
    // The RPC layer validated it; the argv rule is checked again where it is used.
    if (p.model !== undefined && !CHATV2_MODEL.test(p.model)) return chatV2Error('invalid-params', 'Invalid model.');
    const chatSessionId = randomUUID();
    const providerSessionId = randomUUID();
    const model = p.model ?? '';
    const record: ChatV2StoredRecord = {
      version: 1,
      paneId: p.paneId,
      chatSessionId,
      agent: p.agent,
      mode: p.mode,
      model,
      state: 'active',
      providerSessionId,
      seq: 0,
      session: newChatSession({ id: chatSessionId, harness: p.agent, cwd, model, runtimeMode: p.mode }),
      bodies: {},
      sends: [],
      savedAt: this.deps.now(),
    };
    const live = this.newLive(record);
    // Reserved before the first await, so a second create for the pane is refused.
    this.byPane.set(p.paneId, live);
    const started = await this.startDriver(live);
    const saved = started.ok && await this.persistNow(live);
    if (!started.ok || !saved) {
      if (started.ok) await this.stopDriver(live);
      live.closed = true;
      live.batcher.dispose();
      if (this.byPane.get(p.paneId) === live) this.byPane.delete(p.paneId);
      return started.ok ? chatV2Error('driver-failed', 'The chat could not be saved.') : started;
    }
    claimChatV2Pane(p.paneId);
    return { ok: true, binding: this.binding(live) };
  }

  private snapshot(p: ChatV2ParamsByMethod['snapshot']): Result<'snapshot'> {
    const live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    const { blocks, ...head } = live.record.session;
    const start = tailStart(blocks, CHATV2_PAGE_BUDGET_BYTES);
    return {
      ok: true,
      snapshot: {
        binding: this.binding(live),
        head,
        baseIndex: start,
        blocks: blocks.slice(start),
        blockCount: blocks.length,
      },
    };
  }

  private history(p: ChatV2ParamsByMethod['history']): Result<'history'> {
    const live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    const blocks = live.record.session.blocks;
    const index = blocks.findIndex((b) => b.id === p.beforeBlockId);
    if (p.epoch !== live.epoch || index < 0) return chatV2Error('stale-epoch', 'The transcript changed; load it again.');
    const before = blocks.slice(0, index);
    const start = tailStart(before, CHATV2_PAGE_BUDGET_BYTES);
    return {
      ok: true,
      page: { epoch: live.epoch, seq: live.record.seq, baseIndex: start, blocks: before.slice(start), reachedStart: start === 0 },
    };
  }

  private bodies(p: ChatV2ParamsByMethod['bodies']): Result<'bodies'> {
    const live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    if (p.epoch !== live.epoch) return chatV2Error('stale-epoch', 'The transcript changed; load it again.');
    const capped = live.record.session.blocks.find((b) => b.id === p.blockId);
    if (!capped) return chatV2Error('body-gone', 'That text is no longer kept.');
    let full: string | undefined;
    if (!capped.overflow?.[p.field]) {
      full = fieldOf(capped, p.field);
    } else {
      // The shadow holds the full value until the turn that wrote it settles;
      // after that (a rebased, capped block) the harvested store does.
      const shadow = live.shadow.blocks.find((b) => b.id === p.blockId);
      full = (shadow && !shadow.overflow?.[p.field] ? fieldOf(shadow, p.field) : undefined)
        ?? live.record.bodies[`${p.blockId}:${p.field}`];
    }
    if (full === undefined) return chatV2Error('body-gone', 'That text is no longer kept.');
    const offset = Math.min(p.offset ?? 0, full.length);
    const rest = full.slice(offset);
    // Never empty while text remains (a code point is at most 4 bytes), so a reader always moves forward.
    const page = truncateUtf8(rest, BODY_PAGE_BYTES);
    const next = offset + page.length;
    return { ok: true, text: page, ...(next < full.length ? { nextOffset: next } : {}) };
  }

  private checkAttachments(paths: readonly string[]): Attachment[] | null {
    const dir = path.resolve(this.deps.wmuxDir, CHATV2_ATTACHMENT_DIR);
    const out: Attachment[] = [];
    for (const file of paths) {
      const resolved = path.resolve(file);
      const ext = path.extname(resolved).toLowerCase();
      if (resolved !== file || path.dirname(resolved) !== dir || !CHAT_IMAGE_EXTENSIONS.includes(ext)) return null;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(resolved);
      } catch {
        return null;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CHAT_IMAGE_MAX_BYTES) return null;
      out.push({
        id: randomUUID(),
        name: path.basename(resolved),
        mimeType: IMAGE_MIME[ext] ?? 'application/octet-stream',
        kind: 'image',
        size: stat.size,
        path: resolved,
      });
    }
    return out;
  }

  private async send(p: ChatV2ParamsByMethod['send']): Promise<Result<'send'>> {
    let live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    // Driver output still queued (a decision being recorded, an exit) is
    // folded first, so a new turn never lands before the end of the last one.
    await live.drained;
    live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    if (p.epoch !== live.epoch) return chatV2Error('stale-epoch', 'The transcript changed; load it again.');
    const attachmentPaths = p.attachments ?? [];
    const digest = sendDigest(p.text, attachmentPaths);
    const earlier = live.record.sends.find((s) => s.clientMessageId === p.clientMessageId);
    if (earlier) {
      return earlier.digest === digest
        ? { ok: true, clientMessageId: p.clientMessageId, seq: earlier.seq, duplicate: true }
        : chatV2Error('client-message-conflict', 'This message id was already used for another message.');
    }
    const handedOff = handedOffRefusal(live.record);
    if (handedOff) return handedOff;
    if (sessionNeedsInput(live.record.session)) return chatV2Error('needs-input', 'Answer the pending request first.');
    if (live.record.session.busy || live.sending || live.starting) return chatV2Error('turn-running', 'The agent is still working.');
    if (live.unreaped) return chatV2Error('driver-failed', 'The last agent process has not exited yet.');
    const attachments = this.checkAttachments(attachmentPaths);
    if (!attachments) return chatV2Error('attachment-refused', 'An attachment could not be used.');
    live.sending = true;
    try {
      if (!live.driver) {
        const started = await this.startDriver(live);
        if (!started.ok) return started;
      }
      const driver = live.driver;
      if (!driver || live.closed) return chatV2Error('driver-failed', 'The agent stopped.');
      this.stamp(live, {
        type: 'user.message',
        text: p.text,
        ...(attachments.length ? { attachments } : {}),
        clientMessageId: p.clientMessageId,
      });
      const seq = live.record.seq;
      const entry = { clientMessageId: p.clientMessageId, digest, seq };
      live.record.sends.push(entry);
      if (live.record.sends.length > CHATV2_SEND_LEDGER_MAX) live.record.sends.splice(0, live.record.sends.length - CHATV2_SEND_LEDGER_MAX);
      // The turn reaches the agent only once it is on disk: a ledger that was
      // never saved could not answer a retry after a restart.
      const current = live;
      const failTurn = (message: string): void => {
        current.record.sends = current.record.sends.filter((s) => s !== entry);
        this.stamp(current, { type: 'session.error', message });
        this.stamp(current, { type: 'turn.ended', outcome: 'failed' });
      };
      if (!(await this.persistNow(live))) {
        failTurn('The message could not be saved, so it was not sent.');
        return chatV2Error('driver-failed', 'The message could not be saved.');
      }
      try {
        await driver.send({ text: p.text, attachments: attachments.map((a) => ({ path: a.path, mimeType: a.mimeType })) });
      } catch (error) {
        // Off the ledger: a retry with the same id is a new attempt, not a duplicate.
        failTurn(`The message could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
        return chatV2Error('driver-failed', 'The message could not be delivered to the agent.');
      }
      return { ok: true, clientMessageId: p.clientMessageId, seq };
    } finally {
      live.sending = false;
    }
  }

  private async interrupt(p: ChatV2ParamsByMethod['interrupt']): Promise<Result<'interrupt'>> {
    const live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    // The caller's guards, checked in the same synchronous step as the write.
    if (p.epoch !== undefined && p.epoch !== live.epoch) return chatV2Error('stale-epoch', 'The transcript changed; load it again.');
    if (!live.driver || !live.record.session.busy) return { ok: true, interrupted: false };
    if (p.turnId !== undefined && openTurnId(live.record.session) !== p.turnId) return { ok: true, interrupted: false };
    try {
      return { ok: true, interrupted: await live.driver.interrupt() };
    } catch {
      return chatV2Error('driver-failed', 'The agent did not take the stop request.');
    }
  }

  private async answer(p: ChatV2ParamsByMethod['answer']): Promise<Result<'answer'>> {
    const live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    // An answer racing the registry call waits for it, then re-reads: a close
    // or an exit meanwhile drops the decision.
    await live.decisions.get(p.requestId)?.recorded;
    const held = live.decisions.get(p.requestId);
    if (held?.desktopOnly) return this.answerDesktopOnly(live, p, held);
    const registry = this.deps.approvals();
    if (!held || held.failClosed || !held.registryId || !registry) {
      return chatV2Error('approval-not-found', 'That request is no longer waiting.');
    }
    const result = await registry.answerNativeFromDesktop({
      sessionId: live.record.paneId,
      native: held.native,
      decision: p.decision === 'allow' ? 'approve' : 'deny',
      ...(p.answers ? { answers: p.answers } : {}),
    });
    if (result.ok) return { ok: true };
    if (result.reason === 'not-found') return chatV2Error('approval-not-found', 'That request is no longer waiting.');
    return chatV2Error('approval-refused', result.reason);
  }

  /**
   * The desktop's answer to a card on the `none` channel: no phone can answer
   * it, so it goes straight to the driver, under the same arming delay and
   * one answer at a time; the registry's view-only card is then dropped.
   */
  private async answerDesktopOnly(live: Live, p: ChatV2ParamsByMethod['answer'], held: HeldDecision): Promise<Result<'answer'>> {
    if (this.deps.now() - held.notedAt < CHATV2_ANSWER_ARM_MS) return chatV2Error('approval-refused', 'answer-too-soon');
    if (held.answering) return chatV2Error('approval-refused', 'already-answered');
    const driver = live.driver;
    if (!driver) return chatV2Error('approval-not-found', 'That request is no longer waiting.');
    held.answering = true;
    try {
      const reply: NativeDecisionReply = {
        decision: p.decision === 'allow' ? 'approve' : 'deny',
        formKind: held.kind,
        ...(p.answers && held.kind === 'questions' ? { answers: p.answers } : {}),
      };
      const outcome = await this.settleAnswer(live, held, driver, reply);
      if (outcome === 'ok') {
        void this.deps.approvals()?.expireNative(live.record.paneId, held.native, 'answered-locally');
        return { ok: true };
      }
      return outcome === 'not-found'
        ? chatV2Error('approval-not-found', 'That request is no longer waiting.')
        : chatV2Error('approval-refused', 'answer-uncertain');
    } finally {
      held.answering = false;
    }
  }

  /**
   * Hand the conversation to the anchor shell's TUI (handoff.ts). Refused
   * while a turn runs or waits on the user: stop it first. On success the
   * record is the `handed-off` tombstone; a refusal after the driver stopped
   * leaves it `stopped`, and the next send restarts it.
   */
  private async toTerminal(p: ChatV2ParamsByMethod['toTerminal']): Promise<Result<'toTerminal'>> {
    let live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    await live.drained;
    live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    const handedOff = handedOffRefusal(live.record);
    if (handedOff) return handedOff;
    const { session } = live.record;
    if (session.busy || sessionNeedsInput(session) || live.sending || live.starting) {
      return chatV2Error('handoff-refused', 'The agent is still working. Stop the turn first.');
    }
    const current = live;
    current.generation += 1;
    const driver = current.driver;
    const result = await handOffToTerminal({
      paneFree: this.deps.paneFree,
      writeToPane: this.deps.writeToPane,
      processIdentity: this.deps.processIdentity,
      ...(this.deps.processProbe ? { probe: this.deps.processProbe } : {}),
      promptRevision: (paneId) => this.promptRevision(paneId),
      shellKind: (paneId) => this.shellKind(paneId),
      persist: async (record) => {
        const previous = current.record;
        current.record = record;
        if (!(await this.persistNow(current))) {
          current.record = previous;
          throw new Error('save failed');
        }
      },
    }, {
      record: current.record,
      driver: driver ? {
        pid: driver.pid,
        stop: async () => {
          if (!(await this.stopDriver(current))) throw new Error('the driver did not stop');
        },
      } : null,
    });
    if (result.record) current.record = result.record;
    if (!result.ok) return { ok: false, error: result.error };
    // A visible boundary, and the push that carries the `handed-off` binding.
    this.stamp(current, { type: 'status', text: 'Continued in the terminal.' });
    void this.persistNow(current);
    return { ok: true };
  }

  /**
   * The anchor shell's input revision while it sits at an empty prompt (shell
   * integration seen, no command running), or null. cmd.exe has no prompt
   * integration, so it never reads as empty.
   */
  private promptRevision(paneId: string): number | null {
    const pane = this.deps.sessionManager.getSession(paneId);
    if (!pane || pane.promptLog.size === 0 || pane.promptLog.isCommandRunning()) return null;
    return pane.bridge.isEmptyShellPrompt() ? pane.bridge.getInputRevision() : null;
  }

  /**
   * The resume command's grammar for the pane's shell: PowerShell, or a POSIX
   * shell (zsh, bash, and any other non-Windows shell). Null for cmd.exe and
   * other Windows shells, and for WSL panes, whose `claude` and paths live in
   * the distro.
   */
  private shellKind(paneId: string): 'posix' | 'pwsh' | null {
    const pane = this.deps.sessionManager.getSession(paneId);
    if (!pane || pane.meta.wslTarget) return null;
    const shell = classifyShell(pane.meta.cmd ?? '');
    if (shell === 'pwsh') return 'pwsh';
    if (shell === 'bash' || shell === 'zsh') return 'posix';
    return process.platform === 'win32' ? null : 'posix';
  }

  private async close(p: ChatV2ParamsByMethod['close']): Promise<Result<'close'>> {
    const live = this.liveFor(p.paneId, p.chatSessionId);
    if (!live) return chatV2Error('session-not-found', 'No chat for this pane.');
    live.closed = true;
    live.generation += 1;
    if (!(await this.stopDriver(live))) {
      // Still running: keep the record (and the process identity the next
      // daemon start sweeps by) rather than forget a live agent.
      live.closed = false;
      return chatV2Error('driver-failed', 'The agent did not stop. Try again.');
    }
    await this.expireDecisions(live, 'session-start');
    live.batcher.flush();
    if (live.persistTimer) clearTimeout(live.persistTimer);
    live.batcher.dispose();
    await live.saveChain;
    this.byPane.delete(p.paneId);
    releaseChatV2Pane(p.paneId);
    try {
      this.store.remove(live.record.chatSessionId);
    } catch (error) {
      this.deps.log('warn', `[chatv2] could not remove record ${live.record.chatSessionId}: ${String(error)}`);
    }
    return { ok: true };
  }

  // --- native answers (desktop and phone both land here) -----------------

  async answerNative(native: NativeDecisionRef, reply: NativeDecisionReply, paneId: string): Promise<NativeDecisionOutcome> {
    const live = this.byPane.get(paneId);
    if (!live || live.closed || native.adapter !== 'claude') return 'not-found';
    if (native.threadId !== live.record.chatSessionId || native.relayId !== live.epoch) return 'not-found';
    const held = live.decisions.get(native.requestId);
    const driver = live.driver;
    if (!held || held.failClosed || held.desktopOnly || !driver) return 'not-found';
    return this.settleAnswer(live, held, driver, reply);
  }

  /** Hand one reply to the driver; on `ok` / `not-found` the card settles in the transcript. */
  private async settleAnswer(live: Live, held: HeldDecision, driver: ChatV2Driver, reply: NativeDecisionReply): Promise<NativeDecisionOutcome> {
    const requestId = held.native.requestId;
    const outcome = await driver.answer(requestId, reply);
    if (outcome === 'ok' || outcome === 'not-found') {
      live.decisions.delete(requestId);
      const answered = reply.decision === 'approve'
        && (reply.answers ?? []).some((a) => a.keys.length > 0 || !!a.other?.trim());
      const event: HarnessEvent = held.kind === 'permission'
        ? { type: 'approval.resolved', requestId, decision: outcome === 'ok' ? (reply.decision === 'approve' ? 'allow' : 'deny') : 'cancelled' }
        : { type: 'question.resolved', requestId, decision: outcome === 'ok' ? (answered ? 'answered' : 'skipped') : 'cancelled' };
      this.enqueue(live, { kind: 'stamp', event });
    }
    return outcome;
  }

  // --- drivers ------------------------------------------------------------

  private newLive(record: ChatV2StoredRecord): Live {
    const live: Live = {
      record,
      shadow: record.session,
      epoch: newEpoch(),
      driver: null,
      starting: false,
      failed: false,
      stopping: false,
      sending: false,
      closed: false,
      decisions: new Map(),
      inbox: [],
      draining: false,
      drained: Promise.resolve(),
      exitPending: false,
      unreaped: false,
      generation: 0,
      saveChain: Promise.resolve(),
      savePending: null,
      batcher: new EventBatcher((events) => this.deliver(live, events)),
      batchBase: record.session,
      persistTimer: null,
      lastBindingKey: '',
    };
    live.lastBindingKey = this.bindingKey(this.binding(live));
    return live;
  }

  /** Spawn the record's driver after re-checking the pane. A conversation with a turn resumes. */
  private async startDriver(live: Live): Promise<{ ok: true } | { ok: false; error: ChatV2Error }> {
    const { record } = live;
    const pane = this.deps.sessionManager.getSession(record.paneId);
    if (!pane) return chatV2Error('pane-not-found', 'That pane is gone.');
    const handedOff = handedOffRefusal(record);
    if (handedOff) return handedOff;
    if (live.unreaped) return chatV2Error('driver-failed', 'The last agent process has not exited yet.');
    const generation = ++live.generation;
    // A close or dispose that came in while this start was waiting wins.
    const superseded = (): boolean => live.closed || this.disposed || live.generation !== generation;
    live.starting = true;
    try {
      if (!(await this.deps.paneFree(record.paneId))) {
        return chatV2Error('agent-running-in-pane', 'Something is running in this pane. Finish it first.');
      }
      if (superseded()) return chatV2Error('session-not-found', 'The chat was closed.');
      const resume = record.session.blocks.some((b) => b.role === 'user');
      const fail = (message: string): { ok: false; error: ChatV2Error } => {
        this.deps.log('warn', `[chatv2] ${record.agent} driver failed to start on ${record.paneId}: ${message}`);
        live.failed = true;
        live.error = { code: 'driver-unavailable', message: message || 'The agent could not start.' };
        live.starting = false;
        if (record.seq > 0) this.stamp(live, { type: 'session.error', message: live.error.message });
        return { ok: false, error: { ...live.error } };
      };
      let env: Record<string, string>;
      try {
        env = buildDriverEnv(record.paneId, pane.meta.env, process.env);
        // The pane env has the PATH the app was launched with (launchd's, from
        // Finder or the Dock); the agent needs the login shell's.
        env.PATH = (await agentExecEnv(env)).PATH ?? env.PATH;
      } catch (error) {
        return fail(error instanceof DriverEnvError ? error.message : String(error));
      }
      if (superseded()) return chatV2Error('session-not-found', 'The chat was closed.');
      const driver = this.drivers(record.agent);
      if (!driver) return chatV2Error('driver-unavailable', `${record.agent} cannot run in chat.`);
      live.driver = driver;
      try {
        await driver.start({
          cwd: record.session.cwd,
          env,
          mode: record.mode,
          model: record.model,
          providerSession: { id: record.providerSessionId, mode: resume ? 'resume' : 'new' },
        }, {
          event: (event) => this.enqueue(live, { kind: 'event', driver, event }),
          decision: (decision) => this.enqueue(live, { kind: 'decision', driver, decision }),
          decisionGone: (requestId) => this.enqueue(live, { kind: 'gone', requestId }),
          exited: () => this.enqueue(live, { kind: 'exited', driver }),
        });
      } catch (error) {
        if (live.driver === driver) live.driver = null;
        return fail(error instanceof Error ? error.message : String(error));
      }
      if (live.driver !== driver) {
        // Stopped (close, dispose) or exited while starting: make sure nothing is left running.
        await driver.stop().catch(() => undefined);
        return chatV2Error('driver-failed', 'The agent exited during startup.');
      }
      const pid = driver.pid;
      if (pid !== undefined) {
        const identity = await this.deps.processIdentity(pid).catch(() => null);
        // Without a start time the sweep could never prove it is the same process.
        if (identity?.startTime) record.process = { pid, startTime: identity.startTime, marker: record.providerSessionId };
      }
      if (superseded()) {
        live.stopping = true;
        await this.stopDriver(live);
        return chatV2Error('session-not-found', 'The chat was closed.');
      }
      live.failed = false;
      live.error = undefined;
      return { ok: true };
    } finally {
      live.starting = false;
      if (!live.closed && !this.disposed) void this.persistNow(live);
    }
  }

  /** Stop the driver and wait until it is reaped. False: it did not exit, and it is kept. */
  private async stopDriver(live: Live): Promise<boolean> {
    const driver = live.driver;
    if (!driver) return !live.unreaped;
    live.stopping = true;
    try {
      await driver.stop();
    } catch (error) {
      this.deps.log('warn', `[chatv2] stopping the driver of ${live.record.paneId} failed: ${String(error)}`);
      // Kept, with its process identity, until its exit is seen.
      if (live.driver === driver) live.unreaped = true;
      return false;
    }
    if (live.driver === driver) this.onDriverGone(live, driver, null);
    return true;
  }

  /** The driver's process is gone (exit or stop). */
  private onDriverGone(live: Live, driver: ChatV2Driver, code: number | null | undefined): void {
    if (live.driver !== driver) return;
    live.driver = null;
    live.exitPending = false;
    live.unreaped = false;
    delete live.record.process;
    if (!live.stopping) {
      live.error = { code: 'driver-failed', message: code === null || code === undefined ? 'The agent stopped.' : `The agent exited (code ${code}).` };
    }
    live.stopping = false;
    void this.expireDecisions(live, 'pane-gone');
  }

  // --- intake: driver output in order, decisions recorded before their events

  private enqueue(live: Live, item: InboxItem): void {
    if (live.closed && item.kind !== 'exited') return;
    if ((item.kind === 'exited' || (item.kind === 'event' && item.event.type === 'session.ended')) && item.driver === live.driver) {
      live.exitPending = true;
    }
    live.inbox.push(item);
    if (!live.draining) live.drained = this.drain(live);
  }

  private async drain(live: Live): Promise<void> {
    live.draining = true;
    try {
      for (let item = live.inbox.shift(); item; item = live.inbox.shift()) {
        try {
          if (item.kind === 'decision') await this.recordDecision(live, item.driver, item.decision);
          else this.take(live, item);
        } catch (error) {
          this.deps.log('error', `[chatv2] ${live.record.paneId}: ${String(error)}`);
        }
      }
    } finally {
      live.draining = false;
    }
  }

  private take(live: Live, item: Exclude<InboxItem, { kind: 'decision' }>): void {
    switch (item.kind) {
      case 'stamp':
        this.stamp(live, item.event);
        return;
      case 'gone': {
        const held = live.decisions.get(item.requestId);
        if (!held) return;
        live.decisions.delete(item.requestId);
        if (held.registryId) void this.deps.approvals()?.expireNative(live.record.paneId, held.native, 'answered-locally');
        this.stamp(live, held.kind === 'permission'
          ? { type: 'approval.resolved', requestId: item.requestId, decision: 'cancelled' }
          : { type: 'question.resolved', requestId: item.requestId, decision: 'cancelled' });
        return;
      }
      case 'exited':
        this.onDriverGone(live, item.driver, null);
        void this.persistNow(live);
        return;
      case 'event': {
        if (live.closed) return;
        const { event } = item;
        // The binding pushed with these already says `idle` / `stopped`.
        if (event.type === 'session.ended') this.onDriverGone(live, item.driver, event.code);
        // Claude can move the conversation to a new id; resume follows it. The
        // sweep keeps matching the id the process was started with (`marker`).
        if (event.type === 'session.providerBound' && item.driver === live.driver
          && event.providerSessionId !== live.record.providerSessionId) {
          if (CHATV2_PROVIDER_SESSION_ID.test(event.providerSessionId)) {
            live.record.providerSessionId = event.providerSessionId;
            void this.persistNow(live);
          } else {
            this.deps.log('warn', `[chatv2] ignored an unexpected session id on ${live.record.paneId}`);
          }
        }
        if (event.type === 'session.started' && item.driver === live.driver) {
          live.starting = false;
          live.failed = false;
          live.error = undefined;
        }
        const asked = event.type === 'approval.requested' || event.type === 'question.asked';
        const held = asked ? live.decisions.get(event.requestId) : undefined;
        // A card denied at once goes out in one push with its cancel, so no
        // client ever shows it as waiting.
        this.stamp(live, event, !!held?.failClosed);
        if (asked) {
          if (held?.failClosed) {
            live.decisions.delete(event.requestId);
            this.stamp(live, event.type === 'approval.requested'
              ? { type: 'approval.resolved', requestId: event.requestId, decision: 'cancelled' }
              : { type: 'question.resolved', requestId: event.requestId, decision: 'cancelled' });
          }
        }
        if (event.type === 'turn.ended') void this.expireDecisions(live, 'turn-ended');
      }
    }
  }

  /**
   * Record one driver decision in the ApprovalRegistry before its transcript
   * event is stamped. Fails closed: no registry, no record, or a record on the
   * `none` channel is denied at once and settles as `cancelled`.
   */
  private async recordDecision(live: Live, driver: ChatV2Driver, decision: ChatV2DriverDecision): Promise<void> {
    const { record } = live;
    const native: NativeDecisionRef = { adapter: 'claude', requestId: decision.requestId, threadId: record.chatSessionId, relayId: live.epoch };
    let recorded!: () => void;
    const held: HeldDecision = {
      kind: decision.kind,
      native,
      registryId: null,
      failClosed: false,
      desktopOnly: false,
      notedAt: this.deps.now(),
      answering: false,
      recorded: new Promise<void>((resolve) => { recorded = resolve; }),
    };
    live.decisions.set(decision.requestId, held);
    try {
      await this.noteDecision(live, driver, decision, held);
    } finally {
      recorded();
    }
  }

  private async noteDecision(live: Live, driver: ChatV2Driver, decision: ChatV2DriverDecision, held: HeldDecision): Promise<void> {
    const { record } = live;
    const { native } = held;
    const registry = this.deps.approvals();
    let id: string | null = null;
    if (registry && !live.closed) {
      const workspaceId = this.deps.sessionManager.getSession(record.paneId)?.meta.env.WMUX_WORKSPACE_ID;
      try {
        id = await registry.noteNativeDecision({
          sessionId: record.paneId,
          agent: 'claude',
          ...(workspaceId ? { workspaceId } : {}),
          native,
          ...(decision.kind === 'permission'
            ? {
                form: { v: 1, kind: 'permission', actions: PERMISSION_ACTIONS },
                question: decision.question,
                toolName: decision.toolName,
                summary: decision.summary,
              }
            : { form: { v: 1, kind: 'questions', questions: decision.questions, actions: QUESTION_ACTIONS } }),
        });
      } catch (error) {
        this.deps.log('warn', `[chatv2] recording a decision on ${record.paneId} failed: ${String(error)}`);
        id = null;
      }
    }
    const channel = id && registry ? registry.nativeDecisionChannel(id) : null;
    held.registryId = id;
    held.notedAt = this.deps.now();
    if (id && channel === 'none') {
      // Native phone decisions are off: the phone shows the card, the desktop answers it.
      held.desktopOnly = true;
    } else if (!id || channel !== 'native-rpc') {
      held.failClosed = true;
      if (id && registry) void registry.expireNative(record.paneId, native, 'answered-locally').catch(() => undefined);
      this.deps.log('info', `[chatv2] denied ${decision.kind} ${decision.requestId} on ${record.paneId}: no answer channel`);
      // In the background: the inbox moves on (the card and its cancel) while the reply is written.
      void driver.answer(decision.requestId, { decision: 'deny', formKind: decision.kind }).catch(() => 'unavailable');
    }
    void this.persistNow(live);
  }

  private async expireDecisions(live: Live, reason: 'turn-ended' | 'pane-gone' | 'session-start'): Promise<void> {
    if (!live.decisions.size) return;
    const held = [...live.decisions.values()];
    live.decisions.clear();
    const registry = this.deps.approvals();
    if (!registry) return;
    for (const decision of held) {
      if (decision.registryId) await registry.expireNative(live.record.paneId, decision.native, reason).catch(() => undefined);
    }
  }

  // --- stamping, fold, pushes, persistence -------------------------------

  /** Stamp, fold (capped and uncapped) and queue one driver or host event. */
  private stamp(live: Live, event: HarnessEvent, hold = false): void {
    const { record } = live;
    for (const piece of boundEvent(event)) {
      const full = piece === event || event.type === 'message.delta' || event.type === 'reasoning.delta' ? piece : event;
      const at = this.deps.now();
      const bytes = utf8Bytes(JSON.stringify(piece)) + 32;
      live.batcher.admit(bytes);
      if (live.batcher.empty) live.batchBase = record.session;
      record.seq += 1;
      const stamped: StampedHarnessEvent = { seq: record.seq, at, event: piece };
      live.shadow = applyHarnessEvent(live.shadow, { seq: record.seq, at, event: full }, { uncapped: true });
      record.session = applyHarnessEvent(record.session, stamped);
      live.batcher.push(stamped, bytes, hold);
    }
    switch (event.type) {
      case 'turn.ended':
      case 'session.ended':
        // Harvest now, while the shadow still holds the full values; the
        // write itself is queued.
        this.harvestBodies(live);
        void this.persistNow(live);
        live.shadow = record.session;
        return;
      case 'approval.requested':
      case 'approval.resolved':
      case 'question.asked':
      case 'question.resolved':
        void this.persistNow(live);
        return;
      default:
        this.schedulePersist(live);
    }
  }

  private deliver(live: Live, events: StampedHarnessEvent[]): void {
    const { record } = live;
    const binding = this.binding(live);
    const key = this.bindingKey(binding);
    const changed = key !== live.lastBindingKey;
    live.lastBindingKey = key;
    const blocks = record.session.blocks;
    const push: ChatV2EventsPush = {
      paneId: record.paneId,
      chatSessionId: record.chatSessionId,
      epoch: live.epoch,
      events,
      blockCount: blocks.length,
      lastBlockId: blocks.length ? blocks[blocks.length - 1].id : null,
      touchedFrom: blockChangeFrom(live.batchBase, record.session),
      ...(changed ? { binding } : {}),
    };
    live.batchBase = record.session;
    for (const clientId of [...(this.subscribers.get(record.paneId) ?? [])]) {
      // Backpressure: a socket that cannot take a push is gone or too far
      // behind. Drop every subscription it holds and close it, so main
      // reconnects and re-subscribes instead of waiting on a silent socket.
      if (!this.deps.sendTo(clientId, { type: CHATV2_DAEMON_EVENT, sessionId: record.paneId, data: push })) {
        this.clientGone(clientId);
        this.deps.dropClient?.(clientId);
      }
    }
    for (const listener of this.pushListeners) {
      try {
        listener(push);
      } catch (error) {
        this.deps.log('warn', `[chatv2] push listener failed: ${String(error)}`);
      }
    }
  }

  private schedulePersist(live: Live): void {
    if (live.persistTimer || live.closed) return;
    live.persistTimer = setTimeout(() => {
      live.persistTimer = null;
      void this.persistNow(live);
    }, CHATV2_PERSIST_DEBOUNCE_MS);
    live.persistTimer.unref?.();
  }

  /**
   * Queue a save of the record. Saves run one at a time; a persist while one
   * is queued joins it (it writes the latest state). Resolves false when the
   * write failed.
   */
  private persistNow(live: Live): Promise<boolean> {
    if (live.persistTimer) {
      clearTimeout(live.persistTimer);
      live.persistTimer = null;
    }
    if (live.closed) return Promise.resolve(true);
    if (live.savePending) return live.savePending;
    const run = live.saveChain.then(async () => {
      live.savePending = null;
      if (live.closed) return true;
      this.harvestBodies(live);
      live.record.savedAt = this.deps.now();
      try {
        await this.store.save(live.record);
        return true;
      } catch (error) {
        this.deps.log('error', `[chatv2] could not save ${live.record.chatSessionId}: ${String(error)}`);
        return false;
      }
    });
    live.savePending = run;
    live.saveChain = run.then(() => undefined);
    return run;
  }

  /**
   * Copy the full value of every capped field from the shadow into `bodies`,
   * oldest dropped past the cap. A shadow block that is itself capped (rebased
   * at a turn end) holds no more than the inline text, so the value already
   * harvested for it is kept.
   */
  private harvestBodies(live: Live): void {
    const { record } = live;
    const overflowing = record.session.blocks.filter((b) => b.overflow);
    if (!overflowing.length) return;
    const shadow = new Map(live.shadow.blocks.map((b) => [b.id, b] as const));
    for (const block of overflowing) {
      const full = shadow.get(block.id);
      for (const field of ['text', 'detail', 'output'] as const) {
        if (!block.overflow?.[field] || !full || full.overflow?.[field]) continue;
        const value = fieldOf(full, field);
        if (value !== undefined) record.bodies[`${block.id}:${field}`] = value;
      }
    }
    let total = 0;
    for (const value of Object.values(record.bodies)) total += Buffer.byteLength(value);
    for (const key of Object.keys(record.bodies)) {
      if (total <= CHATV2_BODY_STORE_MAX_BYTES) break;
      total -= Buffer.byteLength(record.bodies[key]);
      delete record.bodies[key];
    }
  }
}
