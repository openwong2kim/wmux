// A Hermes Agent pane's conversation as a terminal chat: read from Hermes' own
// session database (hermesState.ts), sent by typing into its prompt.
//
// It answers the bridge's terminal chat calls (the shape the OpenCode
// TerminalChatService has), so a Hermes pane resolves as the bridge's `tui`
// source: a full bounded page on every read, no byte cursors. The router at
// the bottom sends each pane to this service or to OpenCode's by the pane's
// live, process-verified agent.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptAppendData, TranscriptPage, TranscriptStatus } from '../../shared/transcript/turnEvents';
import type { AgentStatus } from '../../shared/types';
import { deliverScheduledPrompt } from '../sessionPromptDelivery';
import type { TerminalChatAbortOutcome, TerminalChatFailure, TerminalChatSendOutcome, TerminalChatService } from './TerminalChatService';
import { findHermesSession, hermesHome, hermesPromptState, readHermesHistory, withHermesDb, type HermesPromptState } from './hermesState';

interface NativeRead { status: TranscriptStatus; page: TranscriptPage }

/** Hermes' clock and the daemon's launch edge may disagree by this much. */
const LAUNCH_SKEW_MS = 5_000;

export interface HermesChatDeps {
  /** The pane's agent is a live, process-verified Hermes. */
  isHermes(id: string): boolean;
  pane(id: string): { cwd: string; env: Record<string, string>; incarnationId?: string } | undefined;
  /** When the pane's current agent started (epoch ms), when known. */
  launchAt(id: string): number | undefined;
  /** Another live Hermes pane runs in the same folder: which conversation is whose cannot be told. */
  sharesFolder(id: string): boolean;
  readScreen(id: string): Promise<readonly string[] | null>;
  /** The pane's program enabled bracketed paste (DECSET 2004). */
  bracketedPaste(id: string): boolean;
  /** Key input only (no focus or mouse reports): a revision and whether it is quiet. */
  keyInput(id: string): { revision: number; quiet: boolean } | undefined;
  /** A fresh check that the pane's Hermes process still runs. */
  processAlive(id: string): Promise<boolean>;
  /** Writes to the pane's PTY; false when the pane is gone. */
  write(id: string, data: string): boolean;
  emit(id: string, data: TranscriptAppendData, clients: readonly string[]): void;
  delay?: (ms: number) => Promise<void>;
  /** Tests: the database opener. */
  open?: (location: URL) => DatabaseSync;
}

interface Watch { clients: Set<string>; timer: ReturnType<typeof setInterval>; busy: boolean; seq: number; digest?: string; epoch?: string; ids?: Set<string> }

const AGENT_STATUS: Record<HermesPromptState, AgentStatus | undefined> = {
  'idle-empty': 'complete', 'idle-typed': 'complete', running: 'running', dialog: 'awaiting_input', unknown: undefined,
};

export class HermesChatService {
  private watches = new Map<string, Watch>();

  constructor(private readonly deps: HermesChatDeps) {}

  owns(id: string): boolean {
    return this.deps.isHermes(id);
  }

  async inspect(id: string): Promise<{ read: NativeRead } | { failure: TerminalChatFailure }> {
    const read = await this.read(id);
    return read ? { read } : { failure: 'no-record' };
  }

  /** Null when the pane is not running Hermes. */
  async read(id: string): Promise<NativeRead | null> {
    if (!this.deps.isHermes(id)) return null;
    const unavailable = (reason: string): NativeRead =>
      ({ status: { available: false, reason, agentAlive: true }, page: page([], '', false) });
    const pane = this.deps.pane(id);
    const launchedAt = this.deps.launchAt(id);
    // Without the launch edge a session from an earlier Hermes in this folder
    // could be taken for this one's; two Hermes panes in one folder cannot be
    // told apart at all.
    if (!pane || launchedAt === undefined || this.deps.sharesFolder(id)) return unavailable('stale-session');
    const cwds = [...new Set([pane.cwd, realpath(pane.cwd)].filter((dir): dir is string => !!dir))];
    const db = path.join(hermesHome(pane.env), 'state.db');
    const found = withHermesDb(db, (conn) => {
      const session = findHermesSession(conn, cwds, launchedAt - LAUNCH_SKEW_MS);
      return session ? { session, history: readHermesHistory(conn, session.id) } : { session: null };
    }, this.deps.open);
    if (!found) return unavailable('unreadable');
    // Hermes writes the session row with its first message.
    if (!found.session || !('history' in found)) return unavailable('stale-session');
    const { session, history } = found;
    const prompt = hermesPromptState(await this.deps.readScreen(id).catch(() => null));
    const agentStatus = AGENT_STATUS[prompt] ?? (history.turnOpen ? 'running' : 'complete');
    // Typed only into the empty prompt Hermes waits at: a turn in progress
    // takes typed text as an interrupt, and a dialog takes it as its answer.
    const send = prompt === 'idle-empty' && this.deps.bracketedPaste(id);
    return {
      status: { available: true, reason: 'ok', agentSessionId: session.id, agentAlive: true, agentStatus,
        terminal: { kind: 'terminal', agent: 'hermes', nativeSessionId: session.id, historyTruncated: history.truncatedHead,
          capabilities: { history: true, send, permissions: false, cancel: false, fileUndo: false } } },
      page: page(history.events, history.rawEpoch, history.truncatedHead),
    };
  }

  /**
   * A bracketed paste into Hermes' empty prompt, then Enter: the same guarded
   * delivery scheduled prompts use (identity, quiet keys, one paste between
   * the two reads, a live process before Enter). `expectedRawEpoch` pins the
   * history the caller read.
   */
  async send(id: string, sessionId: string, text: string, _requestId: string,
    opts: { expectedRawEpoch?: string; authorized?: (stage?: 'first-write' | 'submit') => Promise<boolean> } = {}): Promise<TerminalChatSendOutcome> {
    const read = await this.read(id);
    if (!read?.status.available) return { result: 'unavailable' };
    if (read.status.agentSessionId !== sessionId) return { result: 'session_changed' };
    if (opts.expectedRawEpoch !== undefined && opts.expectedRawEpoch !== (read.page.cursor.historyEpoch ?? '')) return { result: 'session_changed' };
    if (!read.status.terminal?.capabilities.send) {
      return { result: read.status.agentStatus === 'awaiting_input' ? 'blocked' : read.status.agentStatus === 'running' ? 'busy' : 'unavailable' };
    }
    const incarnationId = this.deps.pane(id)?.incarnationId;
    if (!incarnationId) return { result: 'unavailable' };
    let pasted = false;
    let denied = false;
    const authorize = opts.authorized;
    const result = await deliverScheduledPrompt('hermes', incarnationId, text, {
      getAgentState: () => {
        const keys = this.deps.keyInput(id);
        const pane = this.deps.pane(id);
        // Readiness was proven from the screen above; identity and the key
        // fence are what this re-checks around each write.
        return keys && pane && this.deps.isHermes(id)
          ? { slug: 'hermes', incarnationId: pane.incarnationId ?? null, status: 'idle', inputQuiet: keys.quiet, inputRevision: keys.revision }
          : null;
      },
      isAgentProcessAlive: () => this.deps.processAlive(id),
      write: (data) => this.deps.write(id, data),
      // Enter always submits in Hermes' prompt; a pasted newline stays in it.
      submitKeys: '\r',
      onWrite: (stage) => { if (stage === 'paste') pasted = true; },
      ...(this.deps.delay ? { delay: this.deps.delay } : {}),
      ...(authorize ? { authorized: async (stage: 'first-write' | 'submit') => {
        let ok = false;
        try { ok = await authorize(stage); } catch { /* a failed check is a refusal */ }
        if (!ok) denied = true;
        return ok;
      } } : {}),
    });
    switch (result) {
      case 'sent': return { result: 'sent' };
      case 'busy': return { result: 'busy' };
      case 'session_changed': return { result: 'session_changed' };
      case 'unavailable': return { result: 'unavailable' };
      default:
        // After the paste nothing is provable: the text may sit in the prompt.
        // (`transport-lost` is the union's "may have landed"; no HTTP hop here.)
        if (pasted) return { result: 'unconfirmed', reason: 'transport-lost' };
        return denied ? { result: 'error', reason: 'unauthorized' } : { result: 'unavailable' };
    }
  }

  async abort(): Promise<TerminalChatAbortOutcome> {
    return { result: 'unavailable' };
  }

  subscribe(client: string, id: string): void {
    const prior = this.watches.get(id);
    if (prior) { if (prior.clients.size < 32) prior.clients.add(client); return; }
    if (this.watches.size >= 128) return;
    const watch: Watch = { clients: new Set([client]), busy: false, seq: 0,
      timer: setInterval(() => { void this.tick(id, watch); }, 1000) };
    watch.timer.unref();
    this.watches.set(id, watch);
    void this.tick(id, watch);
  }

  unsubscribe(client: string, id: string): void {
    const watch = this.watches.get(id);
    if (!watch) return;
    watch.clients.delete(client);
    if (!watch.clients.size) { clearInterval(watch.timer); this.watches.delete(id); }
  }

  dropClient(client: string): void { for (const id of [...this.watches.keys()]) this.unsubscribe(client, id); }
  dropPty(id: string): void { const watch = this.watches.get(id); if (watch) clearInterval(watch.timer); this.watches.delete(id); }
  dispose(): void { for (const id of [...this.watches.keys()]) this.dropPty(id); }

  /** Emit the pane's page whenever it, or its status, changed since the last one. */
  private async tick(id: string, watch: Watch): Promise<void> {
    if (watch.busy || this.watches.get(id) !== watch) return;
    watch.busy = true;
    try {
      const read = await this.read(id) ?? { status: { available: false, reason: 'unavailable', agentAlive: false }, page: page([], '', false) };
      if (this.watches.get(id) !== watch) return;
      const digest = createHash('sha256').update(JSON.stringify([read.status, read.page])).digest('hex');
      if (digest === watch.digest) return;
      watch.digest = digest;
      const ids = new Set(read.page.events.map((e) => e.id));
      const reset = read.status.available && (watch.epoch !== read.page.cursor.historyEpoch || !!watch.ids && [...watch.ids].some((e) => !ids.has(e)));
      if (read.status.available) { watch.epoch = read.page.cursor.historyEpoch; watch.ids = ids; }
      this.deps.emit(id, { status: read.status, seq: ++watch.seq, events: read.page.events, cursor: read.page.cursor, ...(reset ? { reset: true } : {}) }, [...watch.clients]);
    } finally { watch.busy = false; }
  }
}

function page(events: TranscriptPage['events'], epoch: string, truncatedHead: boolean): TranscriptPage {
  return { events, cursor: { historyEpoch: epoch, headOffset: 0, tailOffset: events.length, fileSize: events.length, mtimeMs: 0 }, hasMore: false, truncatedHead };
}

function realpath(dir: string): string | undefined {
  try { return fs.realpathSync(dir); } catch { return undefined; }
}

type TerminalChat = Pick<TerminalChatService, 'read' | 'inspect' | 'send' | 'abort' | 'subscribe' | 'unsubscribe'>;

/** The bridge's terminal chat: a Hermes pane to `hermes`, every other pane to OpenCode's service. */
export function routeTerminalChat(openCode: () => TerminalChatService | null, hermes: HermesChatService): TerminalChat {
  return {
    read: async (id) => hermes.owns(id) ? hermes.read(id) : await openCode()?.read(id) ?? null,
    inspect: async (id) => hermes.owns(id) ? hermes.inspect(id) : await openCode()?.inspect(id) ?? { failure: 'no-record' },
    send: async (id, sessionId, text, requestId, opts) => hermes.owns(id)
      ? hermes.send(id, sessionId, text, requestId, opts)
      : await openCode()?.send(id, sessionId, text, requestId, opts) ?? { result: 'unavailable' },
    abort: async (id, sessionId, opts) => hermes.owns(id) ? hermes.abort() : await openCode()?.abort(id, sessionId, opts) ?? { result: 'unavailable' },
    subscribe: (client, id) => { if (hermes.owns(id)) hermes.subscribe(client, id); else openCode()?.subscribe(client, id); },
    unsubscribe: (client, id) => { hermes.unsubscribe(client, id); openCode()?.unsubscribe(client, id); },
  };
}
