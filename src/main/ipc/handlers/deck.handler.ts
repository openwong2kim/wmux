// ─── Command Deck — Commander brain IPC handler (Phase 2, P2c) ───────────────
//
// The thin Electron shell that wires a real ClaudeSdkAdapter + a webContents
// event sink into the (transport-agnostic) CommanderSessionManager. Registered
// with ipcMain.handle — a RENDERER-ONLY surface, unreachable from the daemon
// pipe / a same-user MCP client (the identical process-boundary trust basis
// channelLocal.handler + fanout.handler rely on).
//
// The manager (and its brain subprocess) is created LAZILY on the first
// deck:send: the SDK only spawns when the human actually commands the fleet, so
// idle wmux sessions pay nothing. The renderer supplies the one-shot fleet
// snapshot (`fleetContext`) with that first send — main has no store, the
// renderer owns the live pane/channel projection.

import { ipcMain, app, type BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { BrainAdapter, BrainEvent } from '../../deck/BrainAdapter';
import { ClaudeSdkAdapter, buildCommanderSystemPrompt } from '../../deck/ClaudeSdkAdapter';
import {
  CommanderSessionManager,
  type CommanderSendResult,
  type CommanderStatusSnapshot,
} from '../../deck/CommanderSessionManager';

type GetWindow = () => BrowserWindow | null;

export interface RegisterDeckHandlerOptions {
  /** Adapter factory — injected in tests so no SDK subprocess spawns. Defaults
   *  to a fresh ClaudeSdkAdapter (subscription Claude, wmux MCP auto-mounted). */
  createAdapter?: () => BrainAdapter;
}

/** Fleet-context token budget (~2KB). A larger snapshot is truncated so the
 *  one-shot injection can't blow the turn's context. */
const FLEET_CONTEXT_MAX_CHARS = 2048;

export function registerDeckHandler(
  getWindow: GetWindow,
  opts: RegisterDeckHandlerOptions = {},
): () => void {
  const createAdapter = opts.createAdapter ?? (() => new ClaudeSdkAdapter());

  // Single Commander session for the whole app (Phase 2 = single commander).
  let manager: CommanderSessionManager | null = null;

  const emit = (event: BrainEvent): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.DECK_STREAM, event);
  };

  const ensureManager = (fleetContext?: string): CommanderSessionManager => {
    if (!manager) {
      manager = new CommanderSessionManager({
        adapter: createAdapter(),
        sink: emit,
        startOptions: {
          systemPrompt: buildCommanderSystemPrompt(),
          ...(fleetContext ? { fleetContext } : {}),
        },
      });
    }
    return manager;
  };

  ipcMain.removeHandler(IPC.DECK_SEND);
  ipcMain.handle(
    IPC.DECK_SEND,
    wrapHandler(IPC.DECK_SEND, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<CommanderSendResult> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const text = typeof req.text === 'string' ? req.text : '';
      if (!text.trim()) return { ok: false, code: 'empty' };
      let fleetContext = typeof req.fleetContext === 'string' ? req.fleetContext : undefined;
      if (fleetContext && fleetContext.length > FLEET_CONTEXT_MAX_CHARS) {
        fleetContext = fleetContext.slice(0, FLEET_CONTEXT_MAX_CHARS) + '\n…(truncated)';
      }
      const mgr = ensureManager(fleetContext);
      // Awaits the full turn (events stream over DECK_STREAM meanwhile); the
      // resolved value is only the accept/reject verdict.
      return mgr.send(text);
    }),
  );

  ipcMain.removeHandler(IPC.DECK_INTERRUPT);
  ipcMain.handle(
    IPC.DECK_INTERRUPT,
    wrapHandler(IPC.DECK_INTERRUPT, async (): Promise<{ ok: true }> => {
      manager?.interrupt();
      return { ok: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_STATUS);
  ipcMain.handle(
    IPC.DECK_STATUS,
    wrapHandler(IPC.DECK_STATUS, async (): Promise<CommanderStatusSnapshot> => {
      return manager?.getStatus() ?? { status: 'idle', sessionId: null };
    }),
  );

  // Guarantee the brain subprocess is torn down on quit even if the caller
  // forgets to invoke the returned cleanup.
  const disposeOnQuit = (): void => manager?.dispose();
  app.once('before-quit', disposeOnQuit);

  return () => {
    app.removeListener('before-quit', disposeOnQuit);
    manager?.dispose();
    manager = null;
    ipcMain.removeHandler(IPC.DECK_SEND);
    ipcMain.removeHandler(IPC.DECK_INTERRUPT);
    ipcMain.removeHandler(IPC.DECK_STATUS);
  };
}
