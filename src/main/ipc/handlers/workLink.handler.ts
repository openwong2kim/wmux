// Work links — renderer read access (workLink:list / workLink:get) and the
// workLink:changed push. Renderer-only and read-only: writes come from main-side
// owners (A2A send paths, fanout, Moa) straight through the store, never over IPC.
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { isWorkLinkId, parseWorkLinkFilter, type WorkLink } from '../../../shared/workLink';
import { wrapHandler } from '../wrapHandler';
import { getWorkLinkStore, type WorkLinkStore } from '../../workLink/workLinkStore';

export function registerWorkLinkHandlers(
  getWindow: () => BrowserWindow | null,
  store: WorkLinkStore = getWorkLinkStore(),
): () => void {
  ipcMain.removeHandler(IPC.WORK_LINK_LIST);
  ipcMain.handle(
    IPC.WORK_LINK_LIST,
    wrapHandler(IPC.WORK_LINK_LIST, (_e: Electron.IpcMainInvokeEvent, filter: unknown): WorkLink[] =>
      store.list(parseWorkLinkFilter(filter)),
    ),
  );

  ipcMain.removeHandler(IPC.WORK_LINK_GET);
  ipcMain.handle(
    IPC.WORK_LINK_GET,
    wrapHandler(IPC.WORK_LINK_GET, (_e: Electron.IpcMainInvokeEvent, id: unknown): WorkLink | null =>
      isWorkLinkId(id) ? store.get(id) : null,
    ),
  );

  const off = store.onChange((ids) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.WORK_LINK_CHANGED, ids);
  });

  return () => {
    off();
    ipcMain.removeHandler(IPC.WORK_LINK_LIST);
    ipcMain.removeHandler(IPC.WORK_LINK_GET);
  };
}
