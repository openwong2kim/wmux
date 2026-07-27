// ─── Chat View — main ↔ daemon relay (plan PR-4) ─────────────────────────────
//
// The renderer never talks to the daemon pipe. It invokes these Electron IPC
// channels; main forwards each one to the daemon's token-only
// `daemon.transcript.*` methods and pushes `transcript.appended` deltas back
// down as IPC.CHAT_APPEND. That is the DECK_SEND / DECK_STREAM shape, and it is
// deliberate (plan D2/D3): the pipe router is the EXTERNAL-agent surface, so a
// `chat.*` method there would add gen-api-reference drift surface and hand one
// pane's whole conversation to any authenticated MCP client.
//
// `sessionId` on the daemon side IS the renderer's `ptyId` — the same identity
// the rest of this codebase relies on (daemon session id === pty id), so no
// translation table is needed in either direction.
//
// LOCAL (non-daemon) MODE: there is no projector, so every read answers
// `{ available:false, reason:'local-mode' }` and the subscribe/unsubscribe pair
// resolves without effect. A missing daemon must disable the Chat toggle, never
// throw at the renderer.

import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type {
  TranscriptAppendData,
  TranscriptPage,
  TranscriptStatus,
} from '../../../shared/transcript/turnEvents';
import type { ApprovalGateData } from '../../../shared/rpc';

/** The answer every read gives when main owns the PTYs itself. */
const LOCAL_MODE_STATUS: TranscriptStatus = { available: false, reason: 'local-mode' };

export interface ChatHandlerDeps {
  /**
   * Re-read on every call rather than captured: `registerAllHandlers` re-runs on
   * each daemon connect/disconnect swap, but the window outlives both.
   */
  getWindow: () => BrowserWindow | null;
  /**
   * Null in local mode. A getter (not a value) for the same reason as above —
   * the client instance is replaced on a respawn.
   */
  getDaemonClient: () => DaemonClient | null;
}

function readPtyId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function registerChatHandlers(deps: ChatHandlerDeps): () => void {
  const { getWindow, getDaemonClient } = deps;

  // ─── Subscription ownership ────────────────────────────────────────────────
  //
  // The daemon subscription is held by MAIN's long-lived control socket, so the
  // daemon's own per-client teardown (socket close) never fires for a renderer
  // that went away — main is still connected. Two consequences the daemon
  // cannot fix for us:
  //
  //   1. A renderer destroyed (reload, crash, window close, navigation) before
  //      its React effect could call CHAT_UNSUBSCRIBE leaks the subscription:
  //      the daemon keeps an fs watch armed and keeps pushing appends for a pane
  //      nobody is viewing, for the life of the daemon.
  //   2. Two consumers subscribing the SAME pane share one daemon subscription,
  //      so the first unsubscribe would kill the other's stream.
  //
  // Both are the same bookkeeping: which webContents hold each ptyId. The daemon
  // is told to unsubscribe only when that set empties.
  const subscribers = new Map<string, Set<number>>();
  /** webContents we attached teardown listeners to, so dispose can detach. */
  const watched = new Map<number, { wc: WebContents; detach: () => void }>();

  /** Tell the daemon to drop a pane. Fire-and-forget: teardown is best-effort. */
  const forwardUnsubscribe = (ptyId: string): void => {
    const daemon = getDaemonClient();
    if (!daemon) return;
    void Promise.resolve(daemon.rpc('daemon.transcript.unsubscribe', { id: ptyId }))
      .catch(() => { /* daemon down: it dropped main's subscriptions anyway */ });
  };

  /** Drop every pane one renderer held, forwarding only the ones that hit zero. */
  const releaseAll = (wcId: number): void => {
    for (const [ptyId, holders] of subscribers) {
      if (!holders.delete(wcId)) continue;
      if (holders.size === 0) {
        subscribers.delete(ptyId);
        forwardUnsubscribe(ptyId);
      }
    }
    watched.get(wcId)?.detach();
    watched.delete(wcId);
  };

  /**
   * Attach teardown once per renderer. `destroyed` covers a closed window,
   * `render-process-gone` a crash, and a main-frame cross-document navigation
   * covers a reload — in every case the React effect that would have
   * unsubscribed is already gone.
   */
  const watch = (wc: WebContents, wcId: number): void => {
    if (watched.has(wcId) || typeof wc?.on !== 'function') return;
    const onGone = (): void => releaseAll(wcId);
    const onNavigate = (
      _event: unknown,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame && !isInPlace) releaseAll(wcId);
    };
    wc.on('destroyed', onGone);
    wc.on('render-process-gone', onGone);
    wc.on('did-start-navigation', onNavigate as never);
    watched.set(wcId, {
      wc,
      detach: () => {
        if (wc.isDestroyed?.()) return;
        wc.off?.('destroyed', onGone);
        wc.off?.('render-process-gone', onGone);
        wc.off?.('did-start-navigation', onNavigate as never);
      },
    });
  };

  /** The invoking renderer's id. -1 stands in when there is no sender (tests). */
  const senderId = (e: Electron.IpcMainInvokeEvent): number => {
    const wc = e?.sender as WebContents | undefined;
    return typeof wc?.id === 'number' ? wc.id : -1;
  };

  // Every ipcMain.handle is preceded by removeHandler: registerAllHandlers runs
  // again on a daemon reconnect, and a second bare handle() for the same channel
  // THROWS ("Attempted to register a second handler for …"), which aborts the
  // connect bootstrap before it re-wires the rest of the daemon→main tees. See
  // registerHandlers.rpcInvoke.test.ts for the regression this class of bug cost.
  ipcMain.removeHandler(IPC.CHAT_STATUS);
  ipcMain.handle(
    IPC.CHAT_STATUS,
    wrapHandler(
      IPC.CHAT_STATUS,
      async (_e: Electron.IpcMainInvokeEvent, ptyId: unknown): Promise<TranscriptStatus> => {
        const daemon = getDaemonClient();
        const id = readPtyId(ptyId);
        if (!daemon || !id) return LOCAL_MODE_STATUS;
        return (await daemon.rpc('daemon.transcript.status', { id })) as TranscriptStatus;
      },
    ),
  );

  ipcMain.removeHandler(IPC.CHAT_SNAPSHOT);
  ipcMain.handle(
    IPC.CHAT_SNAPSHOT,
    wrapHandler(
      IPC.CHAT_SNAPSHOT,
      async (
        _e: Electron.IpcMainInvokeEvent,
        ptyId: unknown,
        before?: unknown,
      ): Promise<TranscriptPage | null> => {
        const daemon = getDaemonClient();
        const id = readPtyId(ptyId);
        if (!daemon || !id) return null;
        const params: Record<string, unknown> = { id };
        // Only forward a real backward-paging offset — an undefined `before`
        // must mean "the tail", not "offset 0" (which is the head of the file).
        if (typeof before === 'number' && Number.isFinite(before)) params['before'] = before;
        return (await daemon.rpc('daemon.transcript.snapshot', params)) as TranscriptPage | null;
      },
    ),
  );

  ipcMain.removeHandler(IPC.CHAT_SUBSCRIBE);
  ipcMain.handle(
    IPC.CHAT_SUBSCRIBE,
    wrapHandler(
      IPC.CHAT_SUBSCRIBE,
      async (
        e: Electron.IpcMainInvokeEvent,
        ptyId: unknown,
      ): Promise<{ ok: boolean; status: TranscriptStatus }> => {
        const daemon = getDaemonClient();
        const id = readPtyId(ptyId);
        if (!daemon || !id) return { ok: false, status: LOCAL_MODE_STATUS };
        const wcId = senderId(e);
        const wc = e?.sender as WebContents | undefined;
        if (wc) watch(wc, wcId);
        const holders = subscribers.get(id) ?? new Set<number>();
        holders.add(wcId);
        subscribers.set(id, holders);
        // Forwarded on every call, not just the first: the daemon keys its
        // subscription by main's client id (so this is idempotent) and answers
        // with the current status, which each consumer needs.
        return (await daemon.rpc('daemon.transcript.subscribe', { id })) as {
          ok: boolean;
          status: TranscriptStatus;
        };
      },
    ),
  );

  ipcMain.removeHandler(IPC.CHAT_UNSUBSCRIBE);
  ipcMain.handle(
    IPC.CHAT_UNSUBSCRIBE,
    wrapHandler(
      IPC.CHAT_UNSUBSCRIBE,
      async (e: Electron.IpcMainInvokeEvent, ptyId: unknown): Promise<{ ok: boolean }> => {
        const daemon = getDaemonClient();
        const id = readPtyId(ptyId);
        if (!daemon || !id) return { ok: false };
        const holders = subscribers.get(id);
        if (holders) {
          holders.delete(senderId(e));
          // Another consumer is still watching this pane — dropping the daemon
          // subscription here would kill its stream too.
          if (holders.size > 0) return { ok: true };
          subscribers.delete(id);
        }
        return (await daemon.rpc('daemon.transcript.unsubscribe', { id })) as { ok: boolean };
      },
    ),
  );

  ipcMain.removeHandler(IPC.CHAT_CODE_BLOCK);
  ipcMain.handle(
    IPC.CHAT_CODE_BLOCK,
    wrapHandler(
      IPC.CHAT_CODE_BLOCK,
      async (
        _e: Electron.IpcMainInvokeEvent,
        args: unknown,
      ): Promise<{ body: string } | null> => {
        const daemon = getDaemonClient();
        const req = (args ?? {}) as {
          ptyId?: unknown;
          srcOffset?: unknown;
          n?: unknown;
          eventId?: unknown;
        };
        const id = readPtyId(req.ptyId);
        if (!daemon || !id) return null;
        if (typeof req.srcOffset !== 'number' || typeof req.n !== 'number') return null;
        return (await daemon.rpc('daemon.transcript.codeBlock', {
          id,
          srcOffset: req.srcOffset,
          n: req.n,
          ...(typeof req.eventId === 'string' ? { eventId: req.eventId } : {}),
        })) as { body: string } | null;
      },
    ),
  );

  // G2 seed. `daemon.approvals.list` is the registry's own authoritative view;
  // main narrows it to the ptyIds with a PENDING request, which is all the gate
  // needs (the question text rides METADATA_UPDATE). Local mode has no registry,
  // so the honest answer is "nothing open".
  ipcMain.removeHandler(IPC.CHAT_OPEN_GATES);
  ipcMain.handle(
    IPC.CHAT_OPEN_GATES,
    wrapHandler(IPC.CHAT_OPEN_GATES, async (): Promise<string[]> => {
      const daemon = getDaemonClient();
      if (!daemon) return [];
      const res = (await daemon.rpc('daemon.approvals.list', {})) as {
        pending?: { sessionId?: unknown }[];
      } | null;
      const pending = Array.isArray(res?.pending) ? res.pending : [];
      const ids = new Set<string>();
      for (const req of pending) {
        if (typeof req?.sessionId === 'string' && req.sessionId) ids.add(req.sessionId);
      }
      return [...ids];
    }),
  );

  // Push leg. The daemon already unicasts appends to subscribed sockets only, so
  // there is no per-pane filtering to redo here: whatever arrives is something
  // this renderer asked for. The ptyId rides as its own argument (not folded
  // into the payload) so the preload listener can route without unwrapping.
  const daemonClient = getDaemonClient();
  const onTranscript = (payload: { sessionId: string; data: TranscriptAppendData }): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.CHAT_APPEND, payload.sessionId, payload.data);
  };
  daemonClient?.on('session:transcript', onTranscript);

  // Composer gate leg (PR-6). Same relay, different payload: the daemon's
  // ApprovalRegistry says a pane's request opened or closed, and the renderer
  // turns that into the hard composer lock. Nothing here interprets the event —
  // main must not add a heuristic on top of a hook-authoritative signal.
  const onApprovalGate = (payload: { sessionId: string; data: ApprovalGateData }): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.CHAT_GATE, payload.sessionId, payload.data);
  };
  daemonClient?.on('session:approvalGate', onApprovalGate);

  return () => {
    // The handlers are about to be replaced (daemon reconnect swap). Detach the
    // renderer listeners so they cannot fire into a dead closure; the daemon
    // subscriptions themselves belong to the socket being swapped out.
    for (const [, entry] of watched) entry.detach();
    watched.clear();
    subscribers.clear();
    daemonClient?.off('session:transcript', onTranscript);
    daemonClient?.off('session:approvalGate', onApprovalGate);
    ipcMain.removeHandler(IPC.CHAT_STATUS);
    ipcMain.removeHandler(IPC.CHAT_SNAPSHOT);
    ipcMain.removeHandler(IPC.CHAT_SUBSCRIBE);
    ipcMain.removeHandler(IPC.CHAT_UNSUBSCRIBE);
    ipcMain.removeHandler(IPC.CHAT_CODE_BLOCK);
    ipcMain.removeHandler(IPC.CHAT_OPEN_GATES);
  };
}
