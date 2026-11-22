// Sibling worktree collision watch — renderer → main IPC.
//
// Renderer-only surface (ipcMain, not the pipe RpcRouter), like the worktree
// handlers. The renderer sends the folders of its live panes and the setting;
// main answers with a snapshot event whenever what collides changes. The
// watcher only runs read-only git (see main/git/siblingCollision.ts).
import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import { SiblingCollisionWatcher } from '../../git/siblingCollision';
import type { SiblingCollisionWatchRequest } from '../../../shared/siblingCollision';

const MAX_CWDS = 200;

export function registerSiblingCollisionHandlers(getWindow: () => BrowserWindow | null): () => void {
  const watcher = new SiblingCollisionWatcher({
    emit: (snapshot) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(IPC.SIBLING_COLLISION_UPDATE, snapshot);
    },
  });
  ipcMain.removeAllListeners(IPC.SIBLING_COLLISION_WATCH);
  ipcMain.on(IPC.SIBLING_COLLISION_WATCH, (_e: Electron.IpcMainEvent, raw: unknown) => {
    const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<SiblingCollisionWatchRequest>;
    const cwds = Array.isArray(req.cwds) ? req.cwds.filter((c): c is string => typeof c === 'string').slice(0, MAX_CWDS) : [];
    watcher.configure({ enabled: req.enabled === true, intervalMs: Number(req.intervalMs), cwds });
  });
  ipcMain.removeAllListeners(IPC.SIBLING_COLLISION_POKE);
  ipcMain.on(IPC.SIBLING_COLLISION_POKE, () => watcher.poke());
  return () => {
    watcher.dispose();
    ipcMain.removeAllListeners(IPC.SIBLING_COLLISION_WATCH);
    ipcMain.removeAllListeners(IPC.SIBLING_COLLISION_POKE);
  };
}
