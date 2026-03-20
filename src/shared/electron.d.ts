import type { ElectronAPI } from '../preload/index';

declare global {
  interface Window {
    electronAPI: ElectronAPI & {
      onFileDrop: (callback: (paths: string[]) => void) => () => void;
    };
    clipboardAPI: {
      writeText: (text: string) => Promise<void>;
      readText: () => Promise<string>;
      readImage: () => Promise<string | null>;
      hasImage: () => Promise<boolean>;
    };
  }
}
