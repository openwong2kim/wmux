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

import { ipcMain, type BrowserWindow } from 'electron';
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
        _e: Electron.IpcMainInvokeEvent,
        ptyId: unknown,
      ): Promise<{ ok: boolean; status: TranscriptStatus }> => {
        const daemon = getDaemonClient();
        const id = readPtyId(ptyId);
        if (!daemon || !id) return { ok: false, status: LOCAL_MODE_STATUS };
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
      async (_e: Electron.IpcMainInvokeEvent, ptyId: unknown): Promise<{ ok: boolean }> => {
        const daemon = getDaemonClient();
        const id = readPtyId(ptyId);
        if (!daemon || !id) return { ok: false };
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
    daemonClient?.off('session:transcript', onTranscript);
    daemonClient?.off('session:approvalGate', onApprovalGate);
    ipcMain.removeHandler(IPC.CHAT_STATUS);
    ipcMain.removeHandler(IPC.CHAT_SNAPSHOT);
    ipcMain.removeHandler(IPC.CHAT_SUBSCRIBE);
    ipcMain.removeHandler(IPC.CHAT_UNSUBSCRIBE);
    ipcMain.removeHandler(IPC.CHAT_CODE_BLOCK);
  };
}
