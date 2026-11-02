// To hand out — the renderer's side (src/shared/handOut.ts): the list and the
// handOut:changed push, plus an add, a removal and a pick, which only the main
// window makes. Registered once, beside the Git page's hand-off, because a
// pick needs the fan-out service and the operator RPC lane.
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import {
  isHandOutId,
  parseHandOutAdd,
  type HandOutAddResult,
  type HandOutEntry,
  type HandOutPickResult,
} from '../../../shared/handOut';
import { wrapHandler } from '../wrapHandler';
import { isMainWindowSender } from '../mainWindowSender';
import { resolveAccessiblePath } from './fs.handler';
import { getWorkLinkStore } from '../../workLink/workLinkStore';
import { getHandOutStore } from '../../handOut/handOutStore';
import { pickHandOut, type HandOutPickDeps } from '../../handOut/handOutPick';
import type { HandoffDeps } from '../../git/handoff';

export function registerHandOutHandlers(opts: {
  getWindow: () => BrowserWindow | null;
  /** The operator-lane RPC (a2a.task.send, a2a.task.cancel). */
  invoke: HandoffDeps['invoke'];
  startFanOut: HandoffDeps['startFanOut'];
}): () => void {
  const store = getHandOutStore();
  const links = getWorkLinkStore();
  const deps: HandOutPickDeps = {
    invoke: opts.invoke,
    links: { list: (f) => links.list(f), upsert: (i) => links.upsert(i), setState: (id, st, why) => links.setState(id, st, why) },
    startFanOut: opts.startFanOut,
    store,
    // The folder came from an add (a person or an agent): confine it before
    // it reaches git or the fan-out, as the Git page's worktree start does.
    confinePath: resolveAccessiblePath,
  };
  const fromMainWindow = (e: Electron.IpcMainInvokeEvent): boolean => isMainWindowSender(e, opts.getWindow());
  const channels = [IPC.HAND_OUT_LIST, IPC.HAND_OUT_ADD, IPC.HAND_OUT_REMOVE, IPC.HAND_OUT_PICK];
  for (const c of channels) ipcMain.removeHandler(c);

  ipcMain.handle(
    IPC.HAND_OUT_LIST,
    wrapHandler(IPC.HAND_OUT_LIST, (e: Electron.IpcMainInvokeEvent): HandOutEntry[] => (fromMainWindow(e) ? store.list() : [])),
  );

  ipcMain.handle(
    IPC.HAND_OUT_ADD,
    wrapHandler(IPC.HAND_OUT_ADD, (e: Electron.IpcMainInvokeEvent, raw: unknown): HandOutAddResult => {
      if (!fromMainWindow(e)) return { ok: false, code: 'invalid', message: 'only the wmux window adds to To hand out' };
      const req = parseHandOutAdd(raw);
      if (!req) return { ok: false, code: 'invalid', message: 'an item needs a one-line title and an absolute folder; agent is an agent slug such as claude' };
      return store.add(req, { kind: 'owner' });
    }),
  );

  ipcMain.handle(
    IPC.HAND_OUT_REMOVE,
    wrapHandler(IPC.HAND_OUT_REMOVE, (e: Electron.IpcMainInvokeEvent, id: unknown): { ok: boolean } => ({
      ok: fromMainWindow(e) && isHandOutId(id) && store.remove(id),
    })),
  );

  ipcMain.handle(
    IPC.HAND_OUT_PICK,
    wrapHandler(IPC.HAND_OUT_PICK, async (e: Electron.IpcMainInvokeEvent, raw: unknown): Promise<HandOutPickResult> => {
      if (!fromMainWindow(e)) return { ok: false, code: 'refused', message: 'only the wmux window hands items out' };
      return pickHandOut(deps, raw);
    }),
  );

  const off = store.onChange(() => {
    const win = opts.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.HAND_OUT_CHANGED);
  });

  return () => {
    off();
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
