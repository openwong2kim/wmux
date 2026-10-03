/**
 * One pane's chat-v2 connection, without React: subscribe first, then load a
 * snapshot, buffering pushes in between; fold later pushes by the contract's
 * apply rule and re-snapshot whenever it says the copy is stale (epoch, seq
 * gap, a change below the window, a fold mismatch, a daemon reconnect).
 */
import type {
  ChatV2Agent,
  ChatV2Binding,
  ChatV2BridgeApi,
  ChatV2Error,
  ChatV2EventsPush,
  ChatV2ResultByMethod,
  ChatV2RunMode,
} from '../../../shared/chatv2/ipc';
import { applyPushToView, prependHistory, RESNAPSHOT, stateFromSnapshot, type ChatV2ViewState } from './viewState';

export type ChatV2Phase = 'loading' | 'empty' | 'ready' | 'unavailable';

export interface ChatV2ControllerState {
  phase: ChatV2Phase;
  view: ChatV2ViewState | null;
  /** The last failed action (or load), shown until the next action. */
  error: ChatV2Error | null;
  /** Older blocks exist before the window. */
  hasEarlier: boolean;
}

type Listener = (state: ChatV2ControllerState) => void;

/**
 * What each pane's chat-v2 host said, for view selection outside the view:
 * a binding, `null` (no record), or `false` (no chat-v2 host answered).
 */
export type KnownBinding = ChatV2Binding | null | false;
const knownBindings = new Map<string, KnownBinding>();
const bindingListeners = new Set<() => void>();

export function knownBinding(paneId: string): KnownBinding | undefined {
  return knownBindings.get(paneId);
}

export function setKnownBinding(paneId: string, binding: KnownBinding): void {
  if (knownBindings.has(paneId) && knownBindings.get(paneId) === binding) return;
  knownBindings.set(paneId, binding);
  for (const listener of [...bindingListeners]) listener();
}

export function forgetKnownBinding(paneId: string): void {
  if (knownBindings.delete(paneId)) for (const listener of [...bindingListeners]) listener();
}

export function onKnownBindings(listener: () => void): () => void {
  bindingListeners.add(listener);
  return () => { bindingListeners.delete(listener); };
}

let messageCounter = 0;
function clientMessageId(): string {
  messageCounter += 1;
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2);
  return `m${Date.now().toString(36)}${messageCounter.toString(36)}${random.slice(0, 12)}`;
}

export class ChatV2Controller {
  private state: ChatV2ControllerState = { phase: 'loading', view: null, error: null, hasEarlier: false };
  private listeners = new Set<Listener>();
  private buffer: ChatV2EventsPush[] = [];
  private loading = true;
  private generation = 0;
  private disposed = false;
  private offs: Array<() => void> = [];
  private snapshotGeneration = 0;
  private loadingEarlier = false;

  constructor(private readonly bridge: ChatV2BridgeApi, readonly paneId: string) {}

  get current(): ChatV2ControllerState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private set(patch: Partial<ChatV2ControllerState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    // A transient failure keeps whatever was known; only "no chat-v2 host" pins the projection.
    const { view, phase, error } = this.state;
    const known = view ? view.binding : phase === 'empty' ? null : phase === 'unavailable' && error?.code === 'not-implemented' ? false : undefined;
    if (known !== undefined) setKnownBinding(this.paneId, known);
    for (const listener of [...this.listeners]) listener(this.state);
  }

  /** Listen, then subscribe, then snapshot. */
  async start(): Promise<void> {
    this.offs.push(this.bridge.onEvents((push) => this.onPush(push)));
    this.offs.push(this.bridge.onResync((push) => { if (push.paneIds.includes(this.paneId)) void this.reload(); }));
    await this.reload();
  }

  /**
   * Subscribe (again), then snapshot. Used on start, Retry, resync and a
   * daemon reconnect: a lost subscription is only recovered by subscribing.
   */
  async reload(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.loading = true;
    let result: ChatV2ResultByMethod['subscribe'];
    try {
      result = await this.bridge.call('subscribe', { paneId: this.paneId });
    } catch {
      result = { ok: false, error: { code: 'unavailable', message: 'Chat is unavailable.' } };
    }
    if (this.disposed || generation !== this.generation) return;
    if (!result.ok) {
      this.loading = false;
      this.buffer = [];
      this.set({ phase: 'unavailable', error: result.error });
      return;
    }
    if (result.binding) await this.snapshot(result.binding.chatSessionId);
    else this.becomeEmpty();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.listeners.clear();
    void this.bridge.call('unsubscribe', { paneId: this.paneId }).catch(() => undefined);
  }

  private becomeEmpty(): void {
    this.loading = false;
    const buffered = this.buffer;
    this.buffer = [];
    this.set({ phase: 'empty', view: null, hasEarlier: false });
    // A binding appeared while subscribe was in flight.
    if (buffered.length) void this.snapshot(buffered[buffered.length - 1].chatSessionId);
  }

  private async snapshot(chatSessionId: string): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    const result = await this.bridge.call('snapshot', { paneId: this.paneId, chatSessionId });
    if (this.disposed || generation !== this.generation) return;
    if (!result.ok) {
      if (result.error.code === 'session-not-found') { this.becomeEmpty(); return; }
      this.loading = false;
      this.buffer = [];
      this.set({ phase: 'unavailable', error: result.error });
      return;
    }
    this.snapshotGeneration += 1;
    let view = stateFromSnapshot(result.snapshot);
    const buffered = this.buffer;
    this.buffer = [];
    for (const push of buffered) {
      if (push.chatSessionId !== view.binding.chatSessionId) continue;
      const next = applyPushToView(view, push);
      if (next === RESNAPSHOT) { void this.snapshot(view.binding.chatSessionId); return; }
      view = next;
    }
    this.loading = false;
    this.set({ phase: 'ready', view, hasEarlier: view.baseIndex > 0 });
  }

  private onPush(push: ChatV2EventsPush): void {
    if (this.disposed || push.paneId !== this.paneId) return;
    if (this.loading) { this.buffer.push(push); return; }
    const view = this.state.view;
    if (!view) { void this.snapshot(push.chatSessionId); return; }
    const next = applyPushToView(view, push);
    if (next === RESNAPSHOT) { void this.snapshot(push.chatSessionId); return; }
    if (next !== view) this.set({ view: next });
  }

  private fail(error: ChatV2Error): false {
    this.set({ error });
    if (error.code === 'stale-epoch' || error.code === 'session-not-found') void this.reload();
    return false;
  }

  clearError(): void {
    if (this.state.error) this.set({ error: null });
  }

  async create(input: { agent: ChatV2Agent; mode: ChatV2RunMode; model: string }): Promise<boolean> {
    this.set({ error: null });
    const result = await this.bridge.call('create', { paneId: this.paneId, agent: input.agent, mode: input.mode, ...(input.model ? { model: input.model } : {}) });
    if (this.disposed) return false;
    if (!result.ok) return this.fail(result.error);
    if (!this.state.view) await this.snapshot(result.binding.chatSessionId);
    return true;
  }

  async send(text: string, attachments: string[] = []): Promise<boolean> {
    const view = this.state.view;
    if (!view) return false;
    this.set({ error: null });
    const result = await this.bridge.call('send', {
      paneId: this.paneId,
      chatSessionId: view.binding.chatSessionId,
      epoch: view.epoch,
      clientMessageId: clientMessageId(),
      text,
      ...(attachments.length ? { attachments } : {}),
    });
    if (this.disposed) return false;
    return result.ok ? true : this.fail(result.error);
  }

  async interrupt(): Promise<boolean> {
    const view = this.state.view;
    if (!view) return false;
    const result = await this.bridge.call('interrupt', { paneId: this.paneId, chatSessionId: view.binding.chatSessionId });
    if (this.disposed) return false;
    return result.ok ? result.interrupted : this.fail(result.error);
  }

  async answer(requestId: string, decision: 'allow' | 'deny', answers?: Array<{ keys: string[]; other?: string }>): Promise<boolean> {
    const view = this.state.view;
    if (!view) return false;
    this.set({ error: null });
    const result = await this.bridge.call('answer', {
      paneId: this.paneId,
      chatSessionId: view.binding.chatSessionId,
      requestId,
      decision,
      ...(answers ? { answers } : {}),
    });
    if (this.disposed) return false;
    return result.ok ? true : this.fail(result.error);
  }

  async toTerminal(): Promise<boolean> {
    const view = this.state.view;
    if (!view) return false;
    this.set({ error: null });
    const result = await this.bridge.call('toTerminal', { paneId: this.paneId, chatSessionId: view.binding.chatSessionId });
    if (this.disposed) return false;
    return result.ok ? true : this.fail(result.error);
  }

  /**
   * Prepend the page before the window. One request at a time; a page taken
   * at another seq or across a re-snapshot is dropped and asked for again.
   */
  async loadEarlier(): Promise<void> {
    if (this.loadingEarlier) return;
    this.loadingEarlier = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const view = this.state.view;
        const first = view?.session.blocks[0];
        if (!view || !first) return;
        const generation = this.snapshotGeneration;
        const result = await this.bridge.call('history', {
          paneId: this.paneId,
          chatSessionId: view.binding.chatSessionId,
          epoch: view.epoch,
          beforeBlockId: first.id,
        });
        if (this.disposed || generation !== this.snapshotGeneration) return;
        if (!result.ok) { this.fail(result.error); return; }
        const current = this.state.view;
        if (!current || result.page.seq !== current.lastSeq || current.session.blocks[0]?.id !== first.id) continue;
        const next = prependHistory(current, result.page);
        if (!next) { void this.reload(); return; }
        this.set({ view: next, hasEarlier: !result.page.reachedStart });
        return;
      }
    } finally {
      this.loadingEarlier = false;
    }
  }

  /** Drop the record (a handed-off tombstone, say); the pane then offers New chat. */
  async close(): Promise<boolean> {
    const view = this.state.view;
    if (!view) return false;
    this.set({ error: null });
    const result = await this.bridge.call('close', { paneId: this.paneId, chatSessionId: view.binding.chatSessionId });
    if (this.disposed) return false;
    if (!result.ok) return this.fail(result.error);
    await this.reload();
    return true;
  }

  async body(blockId: string, field: 'text' | 'detail' | 'output'): Promise<string | null> {
    const view = this.state.view;
    if (!view) return null;
    const result = await this.bridge.call('bodies', { paneId: this.paneId, chatSessionId: view.binding.chatSessionId, epoch: view.epoch, blockId, field });
    return result.ok ? result.text : null;
  }
}
