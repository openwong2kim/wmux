/**
 * An in-memory chat-v2 host that follows the contract in shared/chatv2/ipc.ts:
 * it stamps seq/at, folds with the shared fold, serves windowed snapshots and
 * pushes events with the fold result. Tests drive it directly; a dev instance
 * can drive the real view with it before the daemon host exists.
 */
import { applyHarnessEvents, blockChangeFrom } from '../../../../shared/chatv2/apply';
import type { HarnessEvent, StampedHarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import {
  chatV2Error,
  type ChatV2Binding,
  type ChatV2BridgeApi,
  type ChatV2EventsPush,
  type ChatV2Method,
  type ChatV2ParamsByMethod,
  type ChatV2ResultByMethod,
  type ChatV2ResyncPush,
} from '../../../../shared/chatv2/ipc';
import { newChatSession, sessionNeedsInput, type Session } from '../../../../shared/chatv2/session';

interface Record_ {
  binding: ChatV2Binding;
  session: Session;
  subscribed: boolean;
}

export interface MockHostOptions {
  now?: () => number;
  /** Most blocks a snapshot returns (the window starts at the last user block when it fits). */
  windowBlocks?: number;
}

export interface MockHost extends ChatV2BridgeApi {
  /** Stamp, fold and (when subscribed) push events for a pane. Returns the push. */
  emit(paneId: string, events: HarnessEvent[]): ChatV2EventsPush;
  /** Deliver a push as-is (for out-of-order / gap tests). */
  deliver(push: ChatV2EventsPush): void;
  resync(paneIds: string[]): void;
  /** Hold snapshot replies (taken when called) until the returned release is called. */
  holdSnapshot(): () => void;
  /** Start a new epoch for a pane (as a daemon restart would). */
  reload(paneId: string): void;
  calls: Array<{ method: ChatV2Method; params: unknown }>;
  record(paneId: string): Record_ | undefined;
  /** Whether create should find the pane busy. */
  busyPanes: Set<string>;
  /** Full values `bodies` serves, by `<blockId>:<field>`, paged by `bodyPageChars`. */
  fullBodies: Map<string, string>;
  bodyPageChars: number;
  /** What `bindingForPane` says a new chat would run in. */
  nextCwd?: string;
  /** Fail the next `bodies` call at or past this offset (once). */
  failBodiesAt?: number;
}

let epochCounter = 0;
function newEpoch(): string {
  epochCounter += 1;
  return epochCounter.toString(16).padStart(16, '0');
}

function statusOf(session: Session): ChatV2Binding['status'] {
  if (sessionNeedsInput(session)) return 'needs-input';
  return session.busy ? 'running' : 'idle';
}

export function createMockHost(options: MockHostOptions = {}): MockHost {
  const now = options.now ?? (() => Date.now());
  const windowBlocks = options.windowBlocks ?? 200;
  const records = new Map<string, Record_>();
  const eventListeners = new Set<(push: ChatV2EventsPush) => void>();
  const resyncListeners = new Set<(push: ChatV2ResyncPush) => void>();
  const calls: MockHost['calls'] = [];
  let snapshotHold: Promise<void> | null = null;
  let sessionCounter = 0;
  const subscribedPanes = new Set<string>();

  const publish = (push: ChatV2EventsPush) => {
    for (const listener of [...eventListeners]) listener(push);
  };

  const emit = (paneId: string, events: HarnessEvent[], forceBinding = false): ChatV2EventsPush => {
    const record = records.get(paneId);
    if (!record) throw new Error(`no record for ${paneId}`);
    const stamped: StampedHarnessEvent[] = events.map((event) => ({ seq: ++record.binding.seq, at: now(), event }));
    const prev = record.session;
    record.session = applyHarnessEvents(prev, stamped);
    const status = record.binding.status === 'handed-off' ? 'handed-off' : statusOf(record.session);
    const providerBound = stamped.find((s) => s.event.type === 'session.providerBound');
    const changed = forceBinding || status !== record.binding.status || !!providerBound;
    if (changed) {
      record.binding = {
        ...record.binding,
        status,
        ...(providerBound && providerBound.event.type === 'session.providerBound'
          ? { providerSessionId: providerBound.event.providerSessionId }
          : {}),
      };
    }
    const blocks = record.session.blocks;
    const push: ChatV2EventsPush = {
      paneId,
      chatSessionId: record.binding.chatSessionId,
      epoch: record.binding.epoch,
      events: stamped,
      blockCount: blocks.length,
      lastBlockId: blocks[blocks.length - 1]?.id ?? null,
      touchedFrom: blockChangeFrom(prev, record.session),
      ...(changed ? { binding: { ...record.binding } } : {}),
    };
    if (record.subscribed) publish(push);
    return push;
  };

  const windowStart = (session: Session): number => {
    const blocks = session.blocks;
    let start = Math.max(0, blocks.length - windowBlocks);
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].role === 'user') {
        if (blocks.length - i <= windowBlocks) start = Math.min(start, i);
        break;
      }
    }
    return start;
  };

  const find = (params: { paneId: string; chatSessionId?: string }) => {
    const record = records.get(params.paneId);
    if (!record || (params.chatSessionId && record.binding.chatSessionId !== params.chatSessionId)) return null;
    return record;
  };

  const notFound = () => chatV2Error('session-not-found', 'No chat in this pane.');

  const handlers: { [M in ChatV2Method]: (params: ChatV2ParamsByMethod[M]) => Promise<ChatV2ResultByMethod[M]> } = {
    async create(params) {
      if (records.has(params.paneId)) return chatV2Error('already-exists', 'This pane already has a chat.');
      if (host.busyPanes.has(params.paneId)) return chatV2Error('agent-running-in-pane', 'An agent is running in this pane.');
      sessionCounter += 1;
      const chatSessionId = `chat-${sessionCounter}`;
      const binding: ChatV2Binding = {
        paneId: params.paneId,
        chatSessionId,
        agent: params.agent,
        mode: params.mode,
        model: params.model ?? '',
        status: 'idle',
        epoch: newEpoch(),
        seq: 0,
        capabilities: { send: true, interrupt: true, approvals: true, questions: true, images: false, toTerminal: true },
      };
      const session = newChatSession({ id: chatSessionId, harness: params.agent, cwd: '/tmp/demo', model: params.model, runtimeMode: params.mode });
      const existing = records.get(params.paneId);
      records.set(params.paneId, { binding, session, subscribed: existing?.subscribed ?? subscribedPanes.has(params.paneId) });
      emit(params.paneId, [{ type: 'session.started' }]);
      return { ok: true, binding: { ...records.get(params.paneId)!.binding } };
    },
    async bindingForPane(params) {
      const binding = records.get(params.paneId)?.binding ?? null;
      return { ok: true, binding, ...(!binding && host.nextCwd ? { cwd: host.nextCwd } : {}) };
    },
    async subscribe(params) {
      subscribedPanes.add(params.paneId);
      const record = records.get(params.paneId);
      if (record) record.subscribed = true;
      return { ok: true, binding: record ? { ...record.binding } : null };
    },
    async unsubscribe(params) {
      subscribedPanes.delete(params.paneId);
      const record = records.get(params.paneId);
      if (record) record.subscribed = false;
      return { ok: true };
    },
    async snapshot(params) {
      const record = find(params);
      if (!record) return notFound();
      const { blocks, ...head } = record.session;
      const start = windowStart(record.session);
      const result = {
        ok: true as const,
        snapshot: { binding: { ...record.binding }, head, baseIndex: start, blocks: blocks.slice(start), blockCount: blocks.length },
      };
      // A held reply was taken at this seq; pushes emitted meanwhile are newer than it.
      if (snapshotHold) await snapshotHold;
      return result;
    },
    async history(params) {
      const record = find(params);
      if (!record) return notFound();
      if (params.epoch !== record.binding.epoch) return chatV2Error('stale-epoch', 'Reload the conversation.');
      const index = record.session.blocks.findIndex((b) => b.id === params.beforeBlockId);
      if (index < 0) return chatV2Error('stale-epoch', 'Reload the conversation.');
      const start = Math.max(0, index - windowBlocks);
      return {
        ok: true,
        page: { epoch: record.binding.epoch, seq: record.binding.seq, baseIndex: start, blocks: record.session.blocks.slice(start, index), reachedStart: start === 0 },
      };
    },
    async send(params) {
      const record = find(params);
      if (!record) return notFound();
      if (params.epoch !== record.binding.epoch) return chatV2Error('stale-epoch', 'Reload the conversation.');
      if (record.binding.status === 'handed-off') return chatV2Error('handed-off', 'This chat continues in Terminal.');
      if (record.session.busy) return chatV2Error('turn-running', 'A turn is running.');
      const push = emit(params.paneId, [{ type: 'user.message', text: params.text, clientMessageId: params.clientMessageId }]);
      return { ok: true, clientMessageId: params.clientMessageId, seq: push.events[0].seq };
    },
    async interrupt(params) {
      const record = find(params);
      if (!record) return notFound();
      if (!record.session.busy) return { ok: true, interrupted: false };
      emit(params.paneId, [{ type: 'turn.ended', outcome: 'interrupted' }]);
      return { ok: true, interrupted: true };
    },
    async answer(params) {
      const record = find(params);
      if (!record) return notFound();
      const question = record.session.pendingQuestion?.requestId === params.requestId;
      const approval = record.session.blocks.some((b) => b.approval?.requestId === params.requestId && !b.approval.decided);
      if (!question && !approval) return chatV2Error('approval-not-found', 'Nothing is waiting on that request.');
      emit(params.paneId, [question
        ? { type: 'question.resolved', requestId: params.requestId, decision: params.decision === 'allow' ? 'answered' : 'skipped' }
        : { type: 'approval.resolved', requestId: params.requestId, decision: params.decision }]);
      return { ok: true };
    },
    async bodies(params) {
      const record = find(params);
      if (!record) return notFound();
      const full = host.fullBodies.get(`${params.blockId}:${params.field}`);
      if (full === undefined) return chatV2Error('body-gone', 'The full output is no longer kept.');
      const offset = params.offset ?? 0;
      if (host.failBodiesAt !== undefined && offset >= host.failBodiesAt) {
        host.failBodiesAt = undefined;
        return chatV2Error('stale-epoch', 'Reload the conversation.');
      }
      const page = full.slice(offset, offset + host.bodyPageChars);
      const next = offset + page.length;
      return { ok: true, text: page, ...(next < full.length ? { nextOffset: next } : {}) };
    },
    async toTerminal(params) {
      const record = find(params);
      if (!record) return notFound();
      if (record.session.busy) return chatV2Error('handoff-refused', 'A turn is running.');
      record.binding = { ...record.binding, status: 'handed-off' };
      emit(params.paneId, [{ type: 'session.ended', code: 0 }], true);
      return { ok: true };
    },
    async close(params) {
      if (!find(params)) return notFound();
      records.delete(params.paneId);
      return { ok: true };
    },
  };

  const host: MockHost = {
    calls,
    busyPanes: new Set(),
    fullBodies: new Map(),
    bodyPageChars: 1024,
    async call(method, params) {
      calls.push({ method, params });
      return (handlers[method] as (p: typeof params) => Promise<ChatV2ResultByMethod[typeof method]>)(params);
    },
    async stageAttachment() {
      return { ok: false, reason: 'missing' };
    },
    onEvents(listener) {
      eventListeners.add(listener);
      return () => { eventListeners.delete(listener); };
    },
    onResync(listener) {
      resyncListeners.add(listener);
      return () => { resyncListeners.delete(listener); };
    },
    emit,
    deliver: publish,
    resync(paneIds) {
      for (const listener of [...resyncListeners]) listener({ paneIds });
    },
    holdSnapshot() {
      let release!: () => void;
      snapshotHold = new Promise<void>((resolve) => { release = resolve; });
      return () => { snapshotHold = null; release(); };
    },
    reload(paneId) {
      const record = records.get(paneId);
      if (record) record.binding = { ...record.binding, epoch: newEpoch() };
    },
    record: (paneId) => records.get(paneId),
  };
  return host;
}
