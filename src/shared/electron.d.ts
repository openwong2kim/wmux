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
  WebDeviceListError,
  WebDeviceRevokeResult,
  WebDeviceSetInputResult,
  WebDeviceSummary,
  WebStartArgs,
  WebTerminalInfo,
} from './web';
import type { PairFailureReason, RemoteAttachmentDescriptor, RemoteHostPublic, RemoteWorkspaceSummary } from './remoteHosts';
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
       * #898 — fired once at startup when a Claude Code plugin install is
       * still running a bridge that forces a permission prompt. wmux refreshes
       * its own copy of the bridge but never the plugin's, so the renderer
       * surfaces the command that does. Read-only report; no resolve half.
       */
      onStalePluginGate?: (
        callback: (
          found: Array<{
            pluginKey: string;
            version: string;
            installPath: string;
            updateCommand: string;
          }>,
        ) => void,
      ) => () => void;
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
        pairStart: (name: string, allowInput?: boolean) => Promise<WebTerminalInfo>;
        /**
         * The paired-device roster.
         *
         * Answers from the device STORE, not from a running server, so it is
         * readable while `wmux web` is stopped — which is exactly when an
         * operator who has just stopped sharing wants to check what still
         * holds a credential. Carries no secret material.
         */
        deviceList: () => Promise<{ devices: WebDeviceSummary[]; error?: WebDeviceListError }>;
        /**
         * Revoke one device permanently and cut its live streams.
         *
         * Irreversible: revocation is never cleared, and a device returns only
         * by pairing again. `ok:false` with `persist-failed` means the streams
         * were cut but the roster write did NOT land, so the credential comes
         * back on the next daemon boot.
         */
        deviceRevoke: (deviceId: string) => Promise<WebDeviceRevokeResult>;
        /**
         * Grant or withdraw one device's permission to type.
         *
         * Narrows within `--allow-input`, never past it: a server started
         * read-only grants nothing to anyone regardless of what this says.
         * Withdrawing takes effect on the device's next request and drops its
         * live streams so the phone re-handshakes into its smaller grant.
         */
        deviceSetInput: (deviceId: string, allowInput: boolean) => Promise<WebDeviceSetInputResult>;
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
        /** Bootstraps the FIRST pane of a NEW workspace on `hostId` (#1001).
         *  The caller mints `workspaceId` — the daemon has no registry of its
         *  own, so this is the one place a fresh id gets minted at all.
         *  Resolves `{ ok: false }` (never rejects) on any failure — an
         *  unreachable host, a rejected token, or the remote's own daemon
         *  refusing the create. */
        workspaceCreate: (hostId: string, workspaceId: string, cwd?: string) => Promise<
          { ok: true; sessionId: string } | { ok: false; error: string }
        >;
        /** Destroy a session on `hostId` — the teardown twin of
         *  `workspaceCreate` (#1129). Detaches every live stream on that
         *  session first, then `DELETE /api/sessions/:id`. Resolves
         *  `{ ok: true }` when the session is gone (a 404 counts: already
         *  gone is the requested outcome), `{ ok: false }` with the daemon's
         *  own wording otherwise — notably on a host running without
         *  `--allow-input`, which refuses a close. Never rejects. */
        sessionClose: (hostId: string, sessionId: string) => Promise<
          { ok: true } | { ok: false; error: string }
        >;
        /** Persisted attach descriptors — read on renderer boot to restore
         *  the attachments a reload/restart wiped out of the memory-only
         *  slice. Panes are never part of a descriptor: they are re-fetched
         *  from the host with workspacesList at restore time. */
        attachmentsList: () => Promise<RemoteAttachmentDescriptor[]>;
        /** Resolves false when the descriptor could not be recorded (unknown
         *  host, or a disk write failure) — never rejects, because the attach
         *  it describes has already happened. */
        attachmentsAdd: (descriptor: RemoteAttachmentDescriptor) => Promise<boolean>;
        attachmentsRemove: (key: string) => Promise<boolean>;
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
        /** Geometry-only: the remote pane was resized while attached. Re-grid
         *  and keep what is on screen — unlike onPaneMeta, nothing is reset. */
        onPaneResize: (
          callback: (e: { attachId: string; cols: number; rows: number }) => void,
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
