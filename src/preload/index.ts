import { contextBridge, ipcRenderer } from 'electron';
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
      ipcRenderer.invoke(IPC.PTY_LIST) as Promise<{ id: string }[]>,
    reconnect: (id: string) =>
      ipcRenderer.invoke(IPC.PTY_RECONNECT, id),
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
  scrollback: {
    dump: (surfaceId: string, content: string) =>
      ipcRenderer.invoke(IPC.SCROLLBACK_DUMP, surfaceId, content),
    load: (surfaceId: string) =>
      ipcRenderer.invoke(IPC.SCROLLBACK_LOAD, surfaceId) as Promise<string | null>,
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

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Expose clipboard via IPC for reliable copy/paste in terminal
const clipboardAPI = {
  writeText: (text: string) => ipcRenderer.invoke(IPC.CLIPBOARD_WRITE, text),
  readText: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ) as Promise<string>,
};
contextBridge.exposeInMainWorld('clipboardAPI', clipboardAPI);

export type ElectronAPI = typeof electronAPI;
export type ClipboardAPI = typeof clipboardAPI;
