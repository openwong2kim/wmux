import type { ElectronAPI } from '../preload/index';
import type { TokenEvent } from '../main/pty/TokenTracker';

declare global {
  interface Window {
    electronAPI: ElectronAPI & {
      onFileDrop: (callback: (paths: string[]) => void) => () => void;
      token?: {
        onUpdate: (callback: (ptyId: string, event: TokenEvent) => void) => () => void;
      };
      fs?: {
        readDir: (dirPath: string) => Promise<{ name: string; path: string; isDirectory: boolean; isSymlink: boolean }[]>;
        readFile: (filePath: string) => Promise<string | null>;
        writeFile: (filePath: string, content: string) => Promise<boolean>;
        watch: (dirPath: string) => Promise<boolean>;
        unwatch: (dirPath: string) => Promise<void>;
        onChanged: (callback: (dirPath: string) => void) => () => void;
      };
      mcp?: {
        check: () => Promise<{
          wmux: { registered: boolean; path: string | null };
          wmuxA2a: { registered: boolean; path: string | null };
          configPath: string;
          configExists: boolean;
          configModified: string | null;
        }>;
        reregister: () => Promise<{
          wmux: { registered: boolean; path: string | null };
          wmuxA2a: { registered: boolean; path: string | null };
          configPath: string;
          configExists: boolean;
          configModified: string | null;
        }>;
        unregister: () => Promise<{
          wmux: { registered: boolean; path: string | null };
          wmuxA2a: { registered: boolean; path: string | null };
          configPath: string;
          configExists: boolean;
          configModified: string | null;
        }>;
      };
    };
    clipboardAPI: {
      writeText: (text: string) => Promise<void>;
      readText: () => Promise<string>;
      readImage: () => Promise<string | null>;
      hasImage: () => Promise<boolean>;
    };
  }
}
