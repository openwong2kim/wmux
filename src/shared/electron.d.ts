import type { ElectronAPI, McpTargetStatusPayload } from '../preload/preload';
import type {
  RemoteInboxItem,
  LanLinkStatus,
  LanLinkConfigurePatch,
  LanLinkPairBeginResult,
  LanLinkPairingStatus,
  LanLinkPairJoinArgs,
  LanLinkJoinResult,
  LanLinkSendArgs,
  LanLinkPeersListResult,
} from './lanlink';
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
        check: () => Promise<{ targets: McpTargetStatusPayload[] }>;
        reregister: () => Promise<{ targets: McpTargetStatusPayload[] }>;
        unregister: () => Promise<{ targets: McpTargetStatusPayload[] }>;
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
      /**
       * LanLink PR-2 — subscribe to materialized read-only REMOTE inbox items
       * (origin:'remote', off-machine peer messages). Dedicated channel
       * (mirrors permissionPrompt) so a remote message is structurally
       * incapable of reaching the RPC_COMMAND → submitToPty paste path.
       * Returns an unsubscribe fn.
       */
      lanlink?: {
        onRemote: (callback: (item: RemoteInboxItem) => void) => () => void;
        /** Renderer → main replay request; fire on mount after onRemote is set. */
        requestResync: () => void;
        /** PR-3 control plane — read enable/NIC state + live NICs. */
        status: () => Promise<LanLinkStatus>;
        /** PR-3 control plane — apply a partial enable/NIC update; echoes new status. */
        configure: (patch: LanLinkConfigurePatch) => Promise<LanLinkStatus>;
        /** PR-5 pairing — mint a PIN + arm the ≤2min pairing window. */
        pairBegin: () => Promise<LanLinkPairBeginResult>;
        /** PR-5 pairing — read-only poll for the Settings countdown. */
        pairStatus: () => Promise<LanLinkPairingStatus>;
        /** PR-5 pairing — disarm the pairing window. */
        pairCancel: () => Promise<{ ok: true }>;
        /** PR-5 pairing — outbound join to a remote peer (all fields required). */
        pairJoin: (args: LanLinkPairJoinArgs) => Promise<LanLinkJoinResult>;
        /** PR-5 — outbound text message to a paired peer. */
        send: (args: LanLinkSendArgs) => Promise<{ ok: true }>;
        /** PR-5 — list paired peers (secrets stripped; `peers` wrapper). */
        peersList: () => Promise<LanLinkPeersListResult>;
        /** PR-5 — revoke a peer (live destroy of its AEAD connection). */
        peersRemove: (peerUuid: string) => Promise<{ ok: true }>;
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
