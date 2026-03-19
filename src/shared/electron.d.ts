import type { ElectronAPI } from '../preload/index';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    clipboardAPI: {
      writeText: (text: string) => Promise<void>;
      readText: () => Promise<string>;
    };
  }
}
