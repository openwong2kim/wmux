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

// One watcher for the app's lifetime: handlers can be registered again (the
// handler swap), and the renderer only re-sends a request that changed, so a
// fresh watcher would sit unconfigured. Emits go to the current window.
let currentGetWindow: () => BrowserWindow | null = () => null;
let watcher: SiblingCollisionWatcher | null = null;

function getWatcher(): SiblingCollisionWatcher {
  watcher ??= new SiblingCollisionWatcher({
    emit: (snapshot) => {
      const win = currentGetWindow();
      if (win && !win.isDestroyed()) win.webContents.send(IPC.SIBLING_COLLISION_UPDATE, snapshot);
    },
  });
  return watcher;
}

export function registerSiblingCollisionHandlers(getWindow: () => BrowserWindow | null): () => void {
  currentGetWindow = getWindow;
  ipcMain.removeAllListeners(IPC.SIBLING_COLLISION_WATCH);
  ipcMain.on(IPC.SIBLING_COLLISION_WATCH, (e: Electron.IpcMainEvent, raw: unknown) => {
    const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<SiblingCollisionWatchRequest>;
    const cwds = Array.isArray(req.cwds) ? req.cwds.filter((c): c is string => typeof c === 'string').slice(0, MAX_CWDS) : [];
    const w = getWatcher();
    w.configure({ enabled: req.enabled === true, intervalMs: Number(req.intervalMs), cwds });
    // Answer every request with what is known now: a reloaded renderer sends
    // the same request again and would otherwise start from an empty store.
    if (!e.sender.isDestroyed()) e.sender.send(IPC.SIBLING_COLLISION_UPDATE, w.snapshot());
  });
  ipcMain.removeAllListeners(IPC.SIBLING_COLLISION_POKE);
  ipcMain.on(IPC.SIBLING_COLLISION_POKE, () => getWatcher().poke());
  return () => {
    ipcMain.removeAllListeners(IPC.SIBLING_COLLISION_WATCH);
    ipcMain.removeAllListeners(IPC.SIBLING_COLLISION_POKE);
  };
}
