import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/constants';

const electronAPI = {
  pty: {
    create: (options?: { shell?: string; cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke(IPC.PTY_CREATE, options),
    write: (id: string, data: string) =>
      ipcRenderer.invoke(IPC.PTY_WRITE, id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.PTY_RESIZE, id, cols, rows),
    dispose: (id: string) =>
      ipcRenderer.invoke(IPC.PTY_DISPOSE, id),
    list: () =>
      ipcRenderer.invoke(IPC.PTY_LIST) as Promise<{ id: string; shell: string }[]>,
    reconnect: (id: string) =>
      ipcRenderer.invoke(IPC.PTY_RECONNECT, id) as Promise<{ success: boolean; id?: string; shell?: string; error?: string }>,
    onData: (callback: (id: string, data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: string, data: string) => callback(id, data);
      ipcRenderer.on(IPC.PTY_DATA, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY_DATA, listener); };
    },
    onExit: (callback: (id: string, exitCode: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: string, exitCode: number) => callback(id, exitCode);
      ipcRenderer.on(IPC.PTY_EXIT, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY_EXIT, listener); };
    },
  },
  shell: {
    list: () => ipcRenderer.invoke(IPC.SHELL_LIST) as Promise<{ name: string; path: string; args?: string[] }[]>,
  },
  session: {
    save: (data: unknown) => ipcRenderer.invoke(IPC.SESSION_SAVE, data),
    load: () => ipcRenderer.invoke(IPC.SESSION_LOAD),
  },
  settings: {
    setToastEnabled: (enabled: boolean) => ipcRenderer.send(IPC.TOAST_ENABLED, enabled),
  },
  notification: {
    onNew: (callback: (ptyId: string, data: { type: string; title: string; body: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ptyId: string, data: { type: string; title: string; body: string }) =>
        callback(ptyId, data);
      ipcRenderer.on(IPC.NOTIFICATION, listener);
      return () => { ipcRenderer.removeListener(IPC.NOTIFICATION, listener); };
    },
    onCwdChanged: (callback: (ptyId: string, cwd: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ptyId: string, cwd: string) =>
        callback(ptyId, cwd);
      ipcRenderer.on(IPC.CWD_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.CWD_CHANGED, listener); };
    },
  },
  metadata: {
    request: (ptyId: string) =>
      ipcRenderer.invoke(IPC.METADATA_REQUEST, ptyId),
    onUpdate: (callback: (ptyId: string, data: { gitBranch?: string; cwd?: string; listeningPorts?: number[] }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ptyId: string, data: { gitBranch?: string; cwd?: string; listeningPorts?: number[] }) =>
        callback(ptyId, data);
      ipcRenderer.on(IPC.METADATA_UPDATE, listener);
      return () => { ipcRenderer.removeListener(IPC.METADATA_UPDATE, listener); };
    },
  },
  rpc: {
    onCommand: (
      callback: (requestId: string, method: string, params: Record<string, unknown>) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        requestId: string,
        method: string,
        params: Record<string, unknown>,
      ) => callback(requestId, method, params);
      ipcRenderer.on(IPC.RPC_COMMAND, listener);
      return () => { ipcRenderer.removeListener(IPC.RPC_COMMAND, listener); };
    },
    respond: (requestId: string, result: unknown) =>
      ipcRenderer.send(`${IPC.RPC_RESPONSE}:${requestId}`, result),
  },
  fs: {
    readDir: (dirPath: string) => ipcRenderer.invoke(IPC.FS_READ_DIR, dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke(IPC.FS_READ_FILE, filePath) as Promise<string | null>,
    watch: (dirPath: string) => ipcRenderer.invoke(IPC.FS_WATCH, dirPath),
    unwatch: (dirPath: string) => ipcRenderer.invoke(IPC.FS_UNWATCH, dirPath),
    onChanged: (callback: (dirPath: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, dirPath: string) => callback(dirPath);
      ipcRenderer.on(IPC.FS_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.FS_CHANGED, listener); };
    },
  },
  updater: {
    checkForUpdates: () =>
      ipcRenderer.invoke(IPC.UPDATE_CHECK) as Promise<{ status: string }>,
    installUpdate: () =>
      ipcRenderer.invoke(IPC.UPDATE_INSTALL),
    onUpdateAvailable: (callback: (data: { status: string; releaseName?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { status: string; releaseName?: string }) =>
        callback(data);
      ipcRenderer.on(IPC.UPDATE_AVAILABLE, listener);
      return () => { ipcRenderer.removeListener(IPC.UPDATE_AVAILABLE, listener); };
    },
    onUpdateNotAvailable: (callback: (data: { status: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { status: string }) =>
        callback(data);
      ipcRenderer.on(IPC.UPDATE_NOT_AVAILABLE, listener);
      return () => { ipcRenderer.removeListener(IPC.UPDATE_NOT_AVAILABLE, listener); };
    },
    onUpdateError: (callback: (data: { status: string; message: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { status: string; message: string }) =>
        callback(data);
      ipcRenderer.on(IPC.UPDATE_ERROR, listener);
      return () => { ipcRenderer.removeListener(IPC.UPDATE_ERROR, listener); };
    },
  },
};

// File drag-and-drop: capture in preload where File.path is accessible
const fileDropCallbacks: ((paths: string[]) => void)[] = [];

document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const filePath = webUtils.getPathForFile(files[i]);
      if (filePath) paths.push(filePath);
    }
    if (paths.length > 0) {
      fileDropCallbacks.forEach((cb) => cb(paths));
    }
  });
});

(electronAPI as Record<string, unknown>).onFileDrop = (callback: (paths: string[]) => void) => {
  fileDropCallbacks.push(callback);
  return () => {
    const idx = fileDropCallbacks.indexOf(callback);
    if (idx >= 0) fileDropCallbacks.splice(idx, 1);
  };
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

contextBridge.exposeInMainWorld('clipboardAPI', {
  writeText: (text: string) => ipcRenderer.invoke(IPC.CLIPBOARD_WRITE, text),
  readText: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ) as Promise<string>,
  readImage: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ_IMAGE) as Promise<string | null>,
  hasImage: () => ipcRenderer.invoke(IPC.CLIPBOARD_HAS_IMAGE) as Promise<boolean>,
});

export type ElectronAPI = typeof electronAPI;
