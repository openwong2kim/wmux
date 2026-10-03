// Preload for the quick-launch composer window. It exposes only the
// composer's own calls: the window runs sandboxed and gets none of the main
// window's API (no PTYs, files or settings). Main also refuses these channels
// from any other sender.
import { contextBridge, ipcRenderer } from 'electron';
import { QUICK_LAUNCH_IPC } from '../shared/quickLaunchIpc';
import type { QuickLaunchContext, QuickLaunchRequest, QuickLaunchResult } from '../shared/quickLaunch';

const quickLaunchAPI = {
  context: () => ipcRenderer.invoke(QUICK_LAUNCH_IPC.CONTEXT) as Promise<QuickLaunchContext | null>,
  submit: (req: QuickLaunchRequest) => ipcRenderer.invoke(QUICK_LAUNCH_IPC.SUBMIT, req) as Promise<QuickLaunchResult>,
  dismiss: () => ipcRenderer.invoke(QUICK_LAUNCH_IPC.DISMISS) as Promise<void>,
  fit: (height: number) => ipcRenderer.invoke(QUICK_LAUNCH_IPC.FIT, height) as Promise<void>,
  onShown: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(QUICK_LAUNCH_IPC.SHOWN, listener);
    return () => {
      ipcRenderer.removeListener(QUICK_LAUNCH_IPC.SHOWN, listener);
    };
  },
};

contextBridge.exposeInMainWorld('quickLaunchAPI', quickLaunchAPI);

export type QuickLaunchAPI = typeof quickLaunchAPI;
