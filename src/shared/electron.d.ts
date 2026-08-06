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
import type { WebStartArgs, WebTerminalInfo } from './web';
import type { PairFailureReason, RemoteHostPublic, RemoteWorkspaceSummary } from './remoteHosts';
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
      /**
       * wmux web — titlebar toggle for the daemon-hosted browser/PWA terminal
       * server. Every call resolves a WebTerminalInfo and NEVER rejects: a
       * daemon-unreachable state is reported as `{ running:false, error }`, so
       * callers read `.error` rather than try/catch.
       */
      web?: {
        /**
         * Read the current server state (running/port/host/viewers/pair code).
         *
         * `verifyFront` additionally asks tailscale whether the HTTPS front is
         * still configured. Pass it on DELIBERATE moments only — the popover
         * opening, the tailnet toggle going on — never on the 10s poll, which
         * would spawn a tailscale process six times a minute. The answer is
         * cached and applied to every later reply, so the polls still show a
         * front that was found missing.
         */
        status: (args?: { verifyFront?: boolean }) => Promise<WebTerminalInfo>;
        /** Start the server. `allowInput`/`expose` default false (read-only + loopback). */
        start: (args: WebStartArgs) => Promise<WebTerminalInfo>;
        /** Stop the server. Resolves the post-stop state (`running:false`). */
        stop: () => Promise<WebTerminalInfo>;
        /**
         * Mint a fresh pairing code. Needed because a code is single-use and
         * expires, which would otherwise leave no way to pair another device
         * short of restarting the server.
         */
        pairRefresh: () => Promise<WebTerminalInfo>;
        /**
         * Name a device, then mint the code that will register it.
         *
         * The name is taken on the DESKTOP, before the code is shown, because
         * that is the only moment a human is present to say what to call it.
         * The daemon refuses a blank name here: a roster of "Unnamed device"
         * rows cannot be operated — "which of these three do I revoke?" has no
         * answer six months later.
         */
        pairStart: (name: string) => Promise<WebTerminalInfo>;
      };
      /**
       * Remote workspace attach — registered remote wmux web hosts + the
       * per-pane attach/detach/write/push bridge to them (main-owned
       * RemoteHostClient, one per host). `paneWrite` is fire-and-forget,
       * like `pty.write`; the `onPane*` subscriptions return an unsubscribe
       * fn, like every other push channel here.
       */
      remote?: {
        hostsList: () => Promise<RemoteHostPublic[]>;
        /** Probes the remote's `/api/config` before persisting — a pre-attach
         *  remote (no route, unparseable body) is refused, never stored. */
        hostsAdd: (rawUrl: string, label?: string) => Promise<
          { ok: true; host: RemoteHostPublic } | { ok: false; error: string }
        >;
        /** Exchanges an 8-char pairing code (read from the remote's
         *  titlebar Web popover) for a device-scoped token via the
         *  unauthenticated `GET /api/pair` route, then registers the host —
         *  the credential-in-clipboard-free alternative to hostsAdd's
         *  paste-URL flow. `reason` is machine-readable; the caller
         *  translates it. */
        hostsPair: (origin: string, code: string, label?: string) => Promise<
          | { ok: true; host: RemoteHostPublic }
          | { ok: false; reason: PairFailureReason; attemptsLeft?: number }
        >;
        hostsRemove: (id: string) => Promise<boolean>;
        workspacesList: (hostId: string) => Promise<
          { ok: true; workspaces: RemoteWorkspaceSummary[] } | { ok: false; error: string }
        >;
        /** Idempotent per (host, session) for this renderer — a repeat call
         *  (e.g. React StrictMode's double-effect) returns the SAME attachId
         *  rather than opening a second SSE stream on the remote. */
        paneAttach: (hostId: string, sessionId: string) => Promise<
          { ok: true; attachId: string } | { ok: false; error: string }
        >;
        paneDetach: (attachId: string) => Promise<void>;
        paneWrite: (attachId: string, data: string) => void;
        onPaneMeta: (
          callback: (e: { attachId: string; cols: number; rows: number; snapshotB64: string; truncated?: boolean; omittedBytes?: number }) => void,
        ) => () => void;
        onPaneData: (callback: (e: { attachId: string; dataB64: string }) => void) => () => void;
        onPaneExit: (callback: (e: { attachId: string }) => void) => () => void;
        /** Fires once reconnection gives up after too many consecutive
         *  failures — the stream is dead until a fresh attach. */
        onPaneError: (callback: (e: { attachId: string; message: string }) => void) => () => void;
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
