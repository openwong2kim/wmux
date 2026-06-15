import type { ElectronAPI } from '../preload/preload';
import type {
  FirstRunCheckResult,
  RegisterMcpResult,
  SampleTaskStartPayload,
} from './firstRun';

declare global {
  interface Window {
    electronAPI: ElectronAPI & {
      onFileDrop: (callback: (paths: string[]) => void) => () => void;
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
      firstRun?: {
        check: () => Promise<FirstRunCheckResult>;
        complete: () => Promise<void>;
        dismiss: () => Promise<void>;
        reopen: () => Promise<FirstRunCheckResult>;
        registerMcp: () => Promise<RegisterMcpResult>;
        startSampleTask: (payload: SampleTaskStartPayload) => Promise<void>;
        onSampleTaskReady: (callback: () => void) => () => void;
        onSampleTaskTimeout: (callback: () => void) => () => void;
      };
      /**
       * Phase 2.2 — MCP plugin permission approval. Main fires `onOpen`
       * with the prompt payload; renderer resolves via `resolve(promptId,
       * approved)`. See `PermissionApprovalDialog` for the UX.
       */
      permissionPrompt?: {
        onOpen: (
          callback: (info: {
            promptId: string;
            clientName: string;
            declaredCapabilities: string[];
            rationale?: string;
          }) => void,
        ) => () => void;
        resolve: (
          promptId: string,
          approved: boolean,
        ) => Promise<{ ok: boolean; error?: string }>;
        onClosed: (
          callback: (payload: { promptId: string }) => void,
        ) => () => void;
      };
    };
    clipboardAPI: {
      /**
       * Write `text` to the system clipboard.
       *
       * IMPORTANT: REJECTS with a coded Error on failure. Possible codes:
       *   - `CLIPBOARD_TOO_LARGE` — payload exceeds the configured size cap
       *   - `CLIPBOARD_INVALID_TYPE` — non-string argument
       *   - `CLIPBOARD_WRITE_FAILED` — OS clipboard lock / write error
       *
       * Callers MUST await and try/catch so the user can be notified and
       * the source selection preserved for retry.
       */
      writeText: (text: string) => Promise<void>;
      readText: () => Promise<string>;
      readImage: () => Promise<string | null>;
      hasImage: () => Promise<boolean>;
    };
  }
}
