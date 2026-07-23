// V3 preload — expose only the IPC channel for the renderer to send results to main (contextIsolation).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('v3bridge', {
  report: (payload) => ipcRenderer.send('v3-result', payload),
});
