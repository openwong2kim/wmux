import path from 'node:path';

export interface CodexTuiSelection {
  threadId: string;
  cwd: string;
  generation: number;
  transcriptPath?: string;
}
/**
 * What a caller learned about a pane's foreground selection.
 *
 * `live: false` is NOT "nothing is selected" — it is "no live relay answered for
 * this owner". The two must stay distinguishable: only a live relay reporting no
 * selection is evidence that a durable recovery hint is stale. Losing the
 * transport says nothing about which thread the pane was on.
 */
export type CodexRelayObservation =
  | { live: true; selection?: CodexTuiSelection }
  | { live: false };

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One instance per owned TUI connection. Never accepts persisted hook bindings.
 * The relay supplies decoded messages from the corresponding direction; this
 * class retains only request identity and the selected thread's identity/cwd.
 */
export class CodexTuiSelectionTracker {
  private generation = 0;
  private retired = false;
  private selected?: CodexTuiSelection;
  private pending?: {id:string | number; generation:number; deadline:number; threadId?:string};
  constructor(private readonly now:()=>number = Date.now, private readonly responseTimeoutMs = 15000) {}

  /** A request whose reply never arrived must not pin the tracker forever: past
   * its deadline `fromServer` would discard the reply anyway, so the pending is
   * already dead. Dropping it here only restores availability — the selection
   * this request cleared stays cleared. */
  private dropExpiredPending():void {
    if (this.pending && this.now() > this.pending.deadline) this.pending = undefined;
  }

  current(): CodexTuiSelection | undefined {
    this.dropExpiredPending();
    if (this.retired || this.pending) return undefined;
    return this.selected ? {...this.selected} : undefined;
  }

  fromTui(value:unknown):void {
    if (this.retired) return;
    this.dropExpiredPending();
    const message = record(value);
    if (!message || typeof message.method !== 'string') return;
    const params = record(message.params);
    const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined;
    // Codex TUI creates ephemeral system threads for automatic title generation.
    // Their correlated replies are not foreground selection changes.
    if (message.method === 'thread/start' && params?.ephemeral === true && params.threadSource === 'system') {
      if (this.pending?.id === message.id) this.close();
      return;
    }
    if (['thread/start','thread/resume'].includes(message.method)) {
      const id = message.id;
      if ((typeof id !== 'string' && typeof id !== 'number') ||
          typeof id === 'string' && id.length > 128 || typeof id === 'number' && !Number.isSafeInteger(id) ||
          this.pending?.id === id) { this.close(); return; }
      this.selected = undefined;
      this.pending = {id,generation:++this.generation,deadline:this.now()+this.responseTimeoutMs,threadId};
    } else if (message.method === 'thread/fork') {
      // Fork selection semantics have not been established for all TUI paths.
      this.invalidate();
    } else if (['thread/unsubscribe','thread/archive','thread/delete'].includes(message.method)) {
      if (threadId === this.selected?.threadId || this.pending &&
          (!this.pending.threadId || threadId === this.pending.threadId)) this.invalidate();
    }
  }

  fromServer(value:unknown):void {
    if (this.retired) return;
    const message = record(value);
    if (!message) return;
    if (typeof message.method === 'string') {
      // Notifications and server requests cannot impersonate a correlated reply.
      if (['thread/closed','thread/archived','thread/deleted'].includes(message.method)) {
        const threadId = record(message.params)?.threadId;
        if (threadId === this.selected?.threadId) this.invalidate();
      }
      return;
    }
    const pending = this.pending;
    if (!pending || message.id !== pending.id) return;
    this.pending = undefined;
    if (this.now() > pending.deadline || 'error' in message) return;
    const thread = record(record(message.result)?.thread);
    if (!thread || typeof thread.id !== 'string' || !uuid.test(thread.id) ||
        typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd) || thread.cwd.includes('\0')) return;
    // Resume-by-history/path can resolve a different ID. Use the server's exact
    // resulting identity, not the request's requested ID or session-tree ID.
    this.selected = {threadId:thread.id,cwd:thread.cwd,generation:pending.generation,
      ...(typeof thread.path === 'string' && path.isAbsolute(thread.path) && !thread.path.includes('\0') ? {transcriptPath:thread.path} : {})};
  }

  close():void { this.retired = true; this.invalidate(); }
  private invalidate():void { this.selected = undefined; this.pending = undefined; this.generation++; }
}
