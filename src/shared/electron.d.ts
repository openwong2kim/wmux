import type { ElectronAPI, McpRegisterTargetResult, McpTargetStatusPayload } from '../preload/preload';
import type { QuickLaunchAPI } from '../preload/quickLaunchPreload';
import type {
  AgySensorInstallResult,
  AgySensorStatus,
  QuotaReadRequest,
  QuotaReadResult,
} from './tokenUsage/quotaTypes';
import type {
  ProviderInventory,
  SurfaceApplyResult,
  SurfaceChangeRequest,
  SurfaceInventoryRequest,
  SurfacePreview,
  SurfaceProviderId,
} from './tokenUsage/surfaceTypes';
import type {
  ApplyProfileOptions,
  ProfileApplyAggregateResult,
  ProfilePreviewResult,
  SaveProfileRequest,
  SaveProfileResult,
  SurfaceProfile,
} from './tokenUsage/profileTypes';
import type { SurfaceReconcileResult } from '../main/surfaces/reconcile/types';
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
import type { FirewallActionResult, FirewallListener, InboundStatusView, NetworkSettingsUri } from './netFirewall';
import type { ListenProblemReport } from './netListen';
import type { A2aSpawnAskResult, A2aSpawnOutgoingList, A2aSpawnPolicySetResult, A2aSpawnPolicyV1, A2aSpawnRequestSummary, A2aSpawnUiAsk } from './a2aSpawn';
import type { RemoteSendResult, RemoteSendSource, RemoteWriteResult } from './remoteUpload';
import type {
  A2aDiscoverCloseResult,
  A2aDiscoverConnectParams,
  A2aDiscoverConnectResult,
  A2aDiscoverDecideParams,
  A2aDiscoverDecideResult,
  A2aDiscoverOpenParams,
  A2aDiscoverOpenResult,
  A2aDiscoverOutgoingCancelResult,
  A2aDiscoverOutgoingConfirmResult,
  A2aDiscoverOutgoingStatus,
  A2aDiscoverScanResult,
  A2aDiscoverStatus,
  A2aRemoteExposureGetResult,
  A2aRemoteExposureSetResult,
  A2aRemoteHeldListResult,
  A2aRemoteHeldRejectResult,
  A2aRemoteHeldRetryResult,
  A2aRemoteHostStatus,
  A2aRemoteHostsStatusResult,
  A2aRemoteHostsExposedResult,
  A2aRemoteLinkEvent,
  A2aRemoteOfferAcceptParams,
  A2aRemoteOfferCreateResult,
  A2aRemoteOfferShareParams,
  A2aRemoteOfferEvent,
  A2aRemoteOfferResult,
  A2aRemoteOffersListResult,
  A2aRemoteLinkProposeParams,
  A2aRemoteLinkResult,
  A2aRemoteLinksListResult,
  A2aRemotePaneSnapshot,
  A2aRemoteHostsListResult,
  A2aRemoteHostsRemoveResult,
  A2aRemoteJoinResult,
  A2aRemotePairBeginResult,
  A2aRemotePairStatus,
  A2aRemotePeersListResult,
  A2aRemoteStatus,
} from './rpc';
import type {
  PairFlow,
  WebDeviceListError,
  WebDeviceRevokeResult,
  WebDeviceSetInputResult,
  WebDeviceSummary,
  WebStartArgs,
  WebGrantArgs,
  WebTerminalInfo,
  WebDiagnosis,
  WebTailscaleChecklist,
  WebTailscaleOpenResult,
  WebTailscaleOpenTarget,
} from './web';
import type { BrowserHelpOutcome, BrowserHelpRequestInfo } from './browserHelp';
import type { PairFailureReason, RemoteAttachmentDescriptor, RemoteErrorReason, RemoteHostPublic, RemoteHostStatus, RemoteWorkspaceSummary, SshAddProgress, SshAddResult, SshConfirmResult, SshServiceResult, SshTunnelState } from './remoteHosts';
import type {
  FirstBotRequest,
  FirstBotResult,
  FirstRunCheckResult,
  FirstRunFolderCheck,
  RegisterMcpResult,
  SampleTaskStartPayload,
} from './firstRun';
import type { AgentId, AgentSetupStatus } from './agentSetup';
import type { AgentSetupPlan, SetAgentPathResult } from './agentInstall';

declare global {
  interface Window {
    /** Only in the quick-launch composer window (quickLaunchPreload.ts). */
    quickLaunchAPI: QuickLaunchAPI;
    electronAPI: ElectronAPI & {
      /** `registerDrop` names this OS drop to main by a one-use token (sends to another PC's pane). */
      onFileDrop: (callback: (paths: string[], registerDrop: () => Promise<string | null>) => void) => () => void;
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
        registerTarget: (targetId: string) => Promise<McpRegisterTargetResult>;
      };
      tokenUsage?: {
        readQuota: (request?: QuotaReadRequest) => Promise<QuotaReadResult>;
        agySensorStatus: () => Promise<AgySensorStatus>;
        installAgySensor: () => Promise<AgySensorInstallResult>;
        readInventory: (request: SurfaceInventoryRequest) => Promise<ProviderInventory>;
        previewChanges: (request: SurfaceChangeRequest) => Promise<SurfacePreview>;
        applyChanges: (request: SurfaceChangeRequest) => Promise<SurfaceApplyResult>;
        listProfiles: () => Promise<SurfaceProfile[]>;
        saveProfile: (
          nameOrRequest: string | SaveProfileRequest,
          providers?: SurfaceProviderId[],
        ) => Promise<SaveProfileResult>;
        deleteProfile: (id: string) => Promise<boolean>;
        previewProfile: (id: string) => Promise<ProfilePreviewResult>;
        applyProfile: (id: string, options?: ApplyProfileOptions) => Promise<ProfileApplyAggregateResult>;
        reconcileSurface: (provider: SurfaceProviderId) => Promise<SurfaceReconcileResult>;
      };
      firstRun?: {
        check: () => Promise<FirstRunCheckResult>;
        complete: () => Promise<void>;
        dismiss: () => Promise<void>;
        reopen: () => Promise<FirstRunCheckResult>;
        registerMcp: () => Promise<RegisterMcpResult>;
        agentStatus: () => Promise<AgentSetupStatus[]>;
        agentPlan: (agent: AgentId, paneShell?: string) => Promise<AgentSetupPlan>;
        setAgentPath: (agent: AgentId, input: string | null) => Promise<SetAgentPathResult>;
        startSampleTask: (payload: SampleTaskStartPayload) => Promise<void>;
        checkFolder: (folder: string) => Promise<FirstRunFolderCheck>;
        firstBot: (req: FirstBotRequest) => Promise<FirstBotResult>;
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
      /** True once per portable data dir: this macOS copy uses separate data. */
      claimPortableDataNotice?: () => Promise<boolean>;
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
          /** browser-action prompts only: "Always on this pane". */
          opts?: { remember?: boolean },
        ) => Promise<{ ok: boolean; error?: string }>;
        onClosed: (
          callback: (payload: { promptId: string }) => void,
        ) => () => void;
      };
      /**
       * browser_request_help — the agent hands one browser step (login,
       * CAPTCHA, OTP, payment confirmation) to the operator. `onOpen` pushes the
       * request, `resolve` carries the operator's Done / Cancel, and `onClosed`
       * clears the row whatever settled it — the human, the page condition, or
       * main's deadline. Optional because an older preload bundle has no such
       * member; every caller treats its absence as "no help UI".
       */
      browserHelp?: {
        onOpen: (callback: (info: BrowserHelpRequestInfo) => void) => () => void;
        resolve: (
          requestId: string,
          outcome: BrowserHelpOutcome,
        ) => Promise<{ ok: boolean; error?: string }>;
        onClosed: (callback: (payload: { requestId: string }) => void) => () => void;
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
        /** The listener state may have changed; re-read status. Returns an unsubscribe fn. */
        onStatusChanged: (callback: () => void) => () => void;
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
       * Firewall and port problems of the listeners other PCs reach. `status`
       * runs the daemon's read-only probe (seconds, so only on a deliberate
       * event); `fix` / `remove` each show one OS consent prompt.
       */
      netFirewall?: {
        /** `fresh`: a probe that starts now, never one already running. */
        status: (listener: FirewallListener, fresh?: boolean) => Promise<InboundStatusView>;
        listenProblem: (listener: FirewallListener) => Promise<ListenProblemReport | null>;
        fix: (listener: FirewallListener) => Promise<FirewallActionResult>;
        remove: (listener: FirewallListener) => Promise<FirewallActionResult>;
        /** `page` (Windows, with 'network'): one of NETWORK_SETTINGS_URIS; main refuses any other. */
        open: (which: 'firewall' | 'network', page?: NetworkSettingsUri) => Promise<{ ok: boolean }>;
      };
      /** Cross-host A2A control plane (Settings → LAN). Daemon mode only. */
      a2aRemote?: {
        status: () => Promise<A2aRemoteStatus>;
        configure: (patch: { enabled?: boolean; port?: number }) => Promise<A2aRemoteStatus>;
        /** Open a one-shot invite (10 minutes, 5 attempts). Fails while the listener is down. */
        pairBegin: () => Promise<A2aRemotePairBeginResult>;
        pairCancel: () => Promise<{ ok: true }>;
        pairStatus: () => Promise<A2aRemotePairStatus>;
        /** Pair with another PC from its pasted invite. Never rejects for a pairing failure. */
        join: (invite: string) => Promise<A2aRemoteJoinResult>;
        /** PCs this PC joined. */
        hostsList: () => Promise<A2aRemoteHostsListResult>;
        /** Removes here and tells that PC (best effort); `remoteRevoked` says whether it confirmed. */
        hostsRemove: (hostId: string) => Promise<A2aRemoteHostsRemoveResult>;
        /** PCs that joined this PC. */
        peersList: () => Promise<A2aRemotePeersListResult>;
        peersRevoke: (peerId: string) => Promise<{ ok: boolean }>;
        /**
         * Make this PC discoverable to its own user's tailnet for 5 minutes.
         * `turnOn`: A2A is off and pressing the button turns it on; without
         * it an off A2A is refused (`a2a-off`).
         */
        discoverOpen: (params?: A2aDiscoverOpenParams) => Promise<A2aDiscoverOpenResult>;
        /** Stop being discoverable. */
        discoverClose: () => Promise<A2aDiscoverCloseResult>;
        /** The window and the request on its card; nothing is pushed, so poll it while a window is open. */
        discoverStatus: () => Promise<A2aDiscoverStatus>;
        /** Allow or Deny the request on the card. */
        discoverDecide: (params: A2aDiscoverDecideParams) => Promise<A2aDiscoverDecideResult>;
        /** Find the discoverable PCs on the tailnet (probes each online device of this user). */
        discoverScan: () => Promise<A2aDiscoverScanResult>;
        /** Ask a PC of the last scan, by its `ip` only; resolves with the code both screens show. */
        discoverConnect: (params: A2aDiscoverConnectParams) => Promise<A2aDiscoverConnectResult>;
        /** This PC's one outgoing request; poll it while one is live. */
        discoverOutgoingStatus: () => Promise<A2aDiscoverOutgoingStatus>;
        /** Withdraw the outgoing request. */
        discoverOutgoingCancel: () => Promise<A2aDiscoverOutgoingCancelResult>;
        /** The other PC allowed and this PC's person checked the codes match: pair now. */
        discoverOutgoingConfirm: () => Promise<A2aDiscoverOutgoingConfirmResult>;
        /** This window's whole pane tree; main diffs it and publishes the exposed part. */
        snapshot: (snapshot: A2aRemotePaneSnapshot) => Promise<{ ok: boolean }>;
        exposureGet: (hostId: string) => Promise<A2aRemoteExposureGetResult>;
        /**
         * Always an explicit pane list per workspace; a workspace without one
         * exposes no pane. `brain`: this PC's Moa is visible to that PC.
         */
        /** `expected`: the list this save was computed from; a different saved list answers `conflict`. */
        exposureSet: (hostId: string, workspaceIds: string[], paneIds: Record<string, string[]>, brain: boolean, expected?: A2aRemoteExposureGetResult['exposure']) => Promise<A2aRemoteExposureSetResult>;
        /** This PC's policy for other PCs starting new agents here. */
        spawnPolicyGet: () => Promise<{ policy: A2aSpawnPolicyV1 }>;
        /** Saves the whole policy; the daemon checks each folder and bumps `version`. A refusal carries the reason. */
        spawnPolicySet: (policy: A2aSpawnPolicyV1) => Promise<A2aSpawnPolicySetResult>;
        /** Requests other PCs sent, newest first, without their prompt. */
        spawnRequestsList: () => Promise<{ requests: A2aSpawnRequestSummary[] }>;
        /** Ask another PC to start an agent; replies go to `end`, a pane here. Never rejects for a refusal. */
        spawnAsk: (ask: A2aSpawnUiAsk) => Promise<A2aSpawnAskResult>;
        /** The requests this PC sent (no prompt text) and what each PC lets it ask for. */
        spawnOutgoing: () => Promise<A2aSpawnOutgoingList>;
        /** The panes a PC this PC joined shows to it. */
        hostsExposed: (hostId: string) => Promise<A2aRemoteHostsExposedResult>;
        linksList: () => Promise<A2aRemoteLinksListResult>;
        linksPropose: (params: A2aRemoteLinkProposeParams) => Promise<A2aRemoteLinkResult>;
        linksAccept: (linkId: string) => Promise<A2aRemoteLinkResult>;
        linksReject: (linkId: string) => Promise<A2aRemoteLinkResult>;
        linksRevoke: (linkId: string) => Promise<A2aRemoteLinkResult>;
        /** Re-read a link's state from the PC it was proposed to. */
        linksRefresh: (linkId: string) => Promise<A2aRemoteLinkResult>;
        /** Share offers: this PC's own and the ones other PCs sent it. */
        offersList: () => Promise<A2aRemoteOffersListResult>;
        /** Accept a pane another PC shared, linking it with one of this PC's panes. */
        offersAccept: (params: A2aRemoteOfferAcceptParams) => Promise<A2aRemoteOfferResult>;
        /** Decline a pane another PC shared; that PC is told. */
        offersDecline: (offerId: string) => Promise<A2aRemoteOfferResult>;
        /** Share one of this PC's panes with a PC that joined this one. */
        offersCreate: (params: A2aRemoteOfferShareParams) => Promise<A2aRemoteOfferCreateResult>;
        /** Take back a share the other PC has not accepted yet. */
        offersWithdraw: (offerId: string) => Promise<A2aRemoteOfferResult>;
        /** Daemon link and share offer nudges. Returns unsubscribe. */
        onLinkEvent: (callback: (event: A2aRemoteLinkEvent | A2aRemoteOfferEvent) => void) => () => void;
        /** Connection state of every paired PC. */
        hostsStatus: () => Promise<A2aRemoteHostsStatusResult>;
        /** A paired PC's connection changed. Returns unsubscribe. */
        onHostStatus: (callback: (status: A2aRemoteHostStatus) => void) => () => void;
        /** Remote work held for a person (pane gone, another agent in it). */
        heldList: () => Promise<A2aRemoteHeldListResult>;
        /** Deliver a held task to its pane as the pane is now. */
        heldRetry: (taskId: string) => Promise<A2aRemoteHeldRetryResult>;
        /** Reject a held task; the other PC is told. */
        heldReject: (taskId: string) => Promise<A2aRemoteHeldRejectResult>;
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
        /**
         * Change transcript / upload access on the RUNNING server in place.
         * Resolves the current status untouched when the server is stopped.
         */
        setGrants: (args: WebGrantArgs) => Promise<WebTerminalInfo>;
        /** Stop the server. Resolves the post-stop state (`running:false`). */
        stop: () => Promise<WebTerminalInfo>;
        /**
         * Read-only readiness check (tailscale status + serve status + server
         * status). Never starts, stops or configures anything. Optional: an
         * older preload without it keeps the popover on the plain hub.
         */
        diagnose?: () => Promise<WebDiagnosis>;
        /**
         * The Remote page's Tailscale checklist: one read-only
         * `tailscale status --json`, capped at a few seconds. `peer` (a
         * MagicDNS name, host name or tailnet address) is the device the last
         * check looks for; without it any other online device passes.
         */
        tailscaleCheck?: (peer?: string) => Promise<WebTailscaleChecklist>;
        /** Open Tailscale's download page, or bring the Tailscale app forward. Only ever from a click. */
        tailscaleOpen?: (target: WebTailscaleOpenTarget) => Promise<WebTailscaleOpenResult>;
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
        pairStart: (name: string, allowInput?: boolean, flow?: PairFlow) => Promise<WebTerminalInfo>;
        /** End the pairing in progress, whichever card started it. */
        pairCancel?: () => Promise<WebTerminalInfo>;
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
         *  translates it. With `replaceHostId` the new credential replaces
         *  that host's rejected one in place (same id, so its attachments
         *  survive) instead of registering a new host. */
        hostsPair: (origin: string, code: string, label?: string, replaceHostId?: string) => Promise<
          | { ok: true; host: RemoteHostPublic }
          | { ok: false; reason: PairFailureReason; attemptsLeft?: number }
        >;
        hostsRemove: (id: string) => Promise<boolean>;
        /** Status per paired host for the Remote hub (hostId → status).
         *  Probes are cached 60 s unless `force`; never rejects, and a host
         *  that did not answer is `unreachable`, never `needs-repair`. */
        hostsStatus?: (force?: boolean) => Promise<Record<string, RemoteHostStatus>>;
        workspacesList: (hostId: string) => Promise<
          | { ok: true; workspaces: RemoteWorkspaceSummary[] }
          | { ok: false; error: string; reason?: RemoteErrorReason }
        >;
        /** Bootstraps the FIRST pane of a NEW workspace on `hostId` (#1001).
         *  The caller mints `workspaceId` — the daemon has no registry of its
         *  own, so this is the one place a fresh id gets minted at all.
         *  Resolves `{ ok: false }` (never rejects) on any failure — an
         *  unreachable host, a rejected token, or the remote's own daemon
         *  refusing the create. */
        workspaceCreate: (hostId: string, workspaceId: string, cwd?: string, name?: string) => Promise<
          { ok: true; sessionId: string } | { ok: false; error: string; reason?: RemoteErrorReason }
        >;
        /** Destroy a session on `hostId` — the teardown twin of
         *  `workspaceCreate` (#1129). Detaches every live stream on that
         *  session first, then `DELETE /api/sessions/:id`. Resolves
         *  `{ ok: true }` when the session is gone (a 404 counts: already
         *  gone is the requested outcome), `{ ok: false }` with the daemon's
         *  own wording otherwise — notably on a host running without
         *  `--allow-input`, which refuses a close. Never rejects. */
        sessionClose: (hostId: string, sessionId: string) => Promise<
          { ok: true } | { ok: false; error: string; reason?: RemoteErrorReason }
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
          { ok: true; attachId: string } | { ok: false; error: string; reason?: RemoteErrorReason }
        >;
        paneDetach: (attachId: string) => Promise<void>;
        paneWrite: (attachId: string, data: string) => void;
        /** Upload an OS drop's files or the clipboard image to the host and
         *  answer the host's paths, quoted, for `paneWriteChecked`. All or nothing. */
        paneSendFiles: (attachId: string, source: RemoteSendSource, opts: { wsl: boolean }) => Promise<RemoteSendResult>;
        /** Write to the pane and await the host's answer; refused once detached. */
        paneWriteChecked: (attachId: string, data: string) => Promise<RemoteWriteResult>;
        /** #1322 — ask the remote daemon to resize the PTY behind `attachId`
         *  via the same `POST /api/sessions/:id/resize` route the phone uses
         *  (#766). `{ ok: true }` only means the route accepted the request;
         *  the applied geometry (which can differ, floored) arrives through
         *  `onPaneResize` like any other resize on the remote. `{ ok: false }`
         *  covers both an expected refusal (`409 desk-owns-size` — a desk
         *  viewer on the remote host owns the size right now) and a transport
         *  failure; the caller's remedy is the same either way: try again
         *  next time the box changes. Never rejects. */
        paneResize: (attachId: string, cols: number, rows: number) => Promise<
          { ok: true; cols: number; rows: number } | { ok: false; reason: string }
        >;
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
         *  failures — the stream is dead until a fresh attach. With
         *  `reason: 'auth-rejected'` it fires at once instead: the host
         *  answered 401, so no retry was attempted and only re-pairing helps. */
        onPaneError: (
          callback: (e: { attachId: string; message: string; reason?: RemoteErrorReason }) => void,
        ) => () => void;
        /**
         * #1391 — ask MAIN to drive the `/api/workspaces` liveness cadence.
         *
         * RESOLVES to the unsubscribe; REJECTS when the subscribe did not land
         * (no handler registered). Optional on top of that, because a renderer
         * running against an older preload bundle has no such member at all.
         * Both failures mean the same thing to the caller: drive the poll from
         * its own (throttled) interval rather than stop polling altogether.
         */
        pollSubscribe?: () => Promise<() => void>;
        /** Fires once per main-side poll round. No payload: it means only
         *  "poll now" — every bit of polling policy stays in the renderer. */
        onPollTick?: (callback: () => void) => () => void;
        /** Add PC over SSH. Optional: absent on a preload that predates it. */
        sshCandidates?: () => Promise<string[]>;
        sshAdd?: (alias: string, requestId: string, label?: string, startAfterReboot?: boolean) => Promise<SshAddResult>;
        sshService?: (hostId: string, on: boolean) => Promise<SshServiceResult>;
        sshStates?: () => Promise<Record<string, SshTunnelState>>;
        sshConfirm?: (hostId: string, accept?: { resolvedHost: string; hostKeyFingerprint: string }) => Promise<SshConfirmResult>;
        sshRepair?: (hostId: string) => Promise<SshAddResult>;
        sshCancel?: (requestId: string) => Promise<boolean>;
        onSshProgress?: (callback: (e: SshAddProgress) => void) => () => void;
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
       *
       * `keepIfRefused` is read by the browser app only: `false` fails a write
       * the browser refused at once instead of retrying it on the next gesture.
       */
      writeText: (text: string, options?: { keepIfRefused?: boolean }) => Promise<void>;
      readText: () => Promise<string>;
      readImage: (ptyId?: string) => Promise<string | null>;
      hasImage: () => Promise<boolean>;
      /** `ssh` when the pane's foreground is a remote session, else null. Desktop only. */
      paneRemoteShell?: (ptyId: string) => Promise<string | null>;
      /** Write text main takes back off after `ttlMs` or on quit, if still there. */
      writeEphemeral?: (text: string, ttlMs: number) => Promise<void>;
      /** Clear the ephemeral text now unless it is `stillValid` (`''` = nothing is). */
      keepEphemeral?: (stillValid: string) => Promise<void>;
    };
  }
}
