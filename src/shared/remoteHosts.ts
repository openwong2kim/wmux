import type { PermissionMode } from './agentResume';
import type { SshHostBinding } from './sshPcContract';

/**
 * How often the per-host `/api/workspaces` liveness feed is refreshed (#1391).
 *
 * SHARED on purpose. Main owns the tick that drives the cadence
 * (IPC.REMOTE_POLL_TICK — a renderer timer is throttled in a background
 * window), while the renderer's per-host backoff is expressed in multiples of
 * one poll interval. Two copies of the number would silently decouple "how
 * often we ask" from "how long a dead host is skipped for".
 */
export const REMOTE_POLL_INTERVAL_MS = 10_000;

/** A registered remote wmux web server. The token NEVER crosses into this
 * shape's renderer-facing projection — see RemoteHostPublic. */
export interface RemoteHost {
  id: string;            // local uuid, minted at add time
  label: string;         // user-visible name ("office-mac"), defaults to hostname
  origin: string;        // e.g. "https://office-mac.tail1234.ts.net:9600" — no path, no trailing slash
  token: string;         // bearer token parsed from the pasted wmux web URL
  addedAt: number;       // epoch ms
  /** Snapshot of the remote /api/config allowInput flag, probed at add time
   * (Task 5) — drives the read-only banner up front. Refreshed on each
   * workspacesList call. */
  allowInput?: boolean;
  /** Present on hosts added with "Add PC over SSH": `origin` is then
   * `wmux-ssh://<id>` and every request goes through this binding's tunnel. */
  ssh?: SshHostBinding;
  /** SSH hosts: the daemon there is installed as a login service ("Start after reboot"). */
  startAfterReboot?: boolean;
}

/** One SSH host's tunnel, as the UI shows it. `kind` is an SshFailureKind. */
export type SshTunnelState =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'ready' }
  | { state: 'failed'; kind: string; message: string; retryAt?: number };

/** Tunnel refusals only the person can lift ("Check SSH connection…"). */
export function sshNeedsIdentityCheck(state: SshTunnelState | undefined): boolean {
  return state?.state === 'failed' && (state.kind === 'needs-confirmation' || state.kind === 'host-key-changed');
}

/** Any refusal the tunnel will not retry on its own: identity, login, a stopped web server. */
export function sshNeedsPerson(state: SshTunnelState | undefined): boolean {
  return sshNeedsIdentityCheck(state)
    || (state?.state === 'failed' && (state.kind === 'auth' || state.kind === 'host-key-unknown' || state.kind === 'web-stopped'));
}

/** Renderer-safe projection — structurally cannot leak the token. */
export type RemoteHostPublic = Omit<RemoteHost, 'token'>;

/** One workspace on a remote host (daemon-derived, live-pane-backed). */
export interface RemoteWorkspaceSummary {
  id: string;            // remote WMUX_WORKSPACE_ID (uuid)
  name: string;          // remote WMUX_WORKSPACE_NAME ('' possible for pre-name panes)
  panes: RemotePaneSummary[];
}

export interface RemotePaneSummary {
  sessionId: string;     // remote daemon session id — the /api/stream?session= key
  shell?: string;        // basename label, same derivation as /api/sessions
  cwd?: string;
  /**
   * #1163 — live agent identity on the remote pane, when the host knows one
   * (its own AgentDetector / persisted lastDetectedAgent). Optional and
   * additive: older hosts omit both fields and consumers must degrade, not
   * guess (protocolVersion.ts additive-field rule).
   */
  agentName?: string;
  /** #1163 — host-side lifecycle snapshot for that agent. Same tolerance rule. */
  agentStatus?: RemoteAgentStatus;
  /**
   * #1342 — what the host knows about resuming this pane's agent conversation.
   * Additive-optional, like the agent fields above: an older host omits it and
   * the desktop simply offers no resume chip for that pane.
   */
  resume?: RemoteResumeInfo;
  /**
   * #1342 — OSC 133 shell state on the host (true = a foreground command owns
   * the PTY). Absent when the host's shell emits no markers. Feeds the chip's
   * "never type into a live agent" gate, exactly like the local map.
   */
  commandRunning?: boolean;
  /**
   * #1342 — host-side process truth for the pane's agent (true = observed
   * alive, false = observed and gone, absent = never attributed). Second tier
   * of the same gate.
   */
  agentProcessAlive?: boolean;
  /**
   * The host sidebar's name for the pane holding this session: its label, or
   * its "w1-1" coordinate. Additive-optional (absent from older hosts and
   * while the host desktop is not attached).
   */
  paneName?: string;
  /** The host tab's title, as the host sidebar's pane row reads it. Same rule. */
  surfaceTitle?: string;
  /** Epoch ms of the session's last output on the host, from its ISO stamp. Same rule. */
  lastActivityAt?: number;
  /**
   * #1754 — the inputs a mirror's `wantsAltEnterNewline` needs, the same ones
   * a local pane reads. All additive-optional: an older host omits them, and a
   * mirror without `hostPlatform` keeps the plain newline bytes.
   *
   * `hostPlatform` is the host's `process.platform`. `wsl` says the pane's
   * shell enters WSL. `agentSlug` is the host's canonical agent for the pane
   * (`codex`, `claude`, …), never a role label, and absent once it exits.
   */
  hostPlatform?: string;
  wsl?: boolean;
  agentSlug?: string;
}

/**
 * #1342 — the resume half of local/remote parity, as the host publishes it.
 *
 * Deliberately NOT a `ResumeBinding`: the binding's `transcriptPath` is a
 * host-local filesystem path and must never cross the API, and `cwd` is
 * replaced by the host's own verdict — the desktop cannot compare a path on
 * another machine, so the host answers "does the recorded cwd still match this
 * pane?" instead of shipping the path for the desktop to guess with.
 */
export interface RemoteResumeInfo {
  /** Agent launcher slug ('claude' / 'codex') — the resume grammar's key. */
  agent: string;
  /** The conversation id the resume command would carry. */
  sessionId: string;
  /** Host verdict: the recorded origin cwd still matches the pane's cwd, so an
   *  EXACT `--resume <id>` is safe. False → the cwd-relative fallback. */
  cwdMatches: boolean;
  /** Last-observed permission mode, when the host recorded one. */
  permissionMode?: PermissionMode;
}

/**
 * Shapes an agent slug and a conversation id may take.
 *
 * These are not cosmetic caps, they are the boundary that keeps the chip's
 * "nothing runs until the operator presses Enter" promise. Both values are
 * spliced into a command line that is TYPED into a terminal, so a value
 * carrying `\r` (or `\n`) would submit itself and whatever followed it the
 * instant the operator clicked — the one thing the chip must never do. The
 * character sets below cannot express a newline, a quote, a shell
 * metacharacter, or whitespace at all.
 *
 * The slug is additionally matched against a known launcher before anything
 * is built (resumeGrammarFor), so this only has to stop the id.
 */
const RESUME_AGENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const RESUME_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Trust-boundary parse for {@link RemoteResumeInfo}. Returns undefined for
 *  anything that is not a complete, usable resume offer — a half-formed one
 *  would render a chip that types a broken command. */
export function parseRemoteResumeInfo(value: unknown): RemoteResumeInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const agent = typeof raw.agent === 'string' ? raw.agent : '';
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  // Reject rather than sanitize: a truncated or stripped conversation id is
  // not the conversation, so an offer that does not arrive intact is no offer.
  if (!RESUME_AGENT_RE.test(agent) || !RESUME_SESSION_ID_RE.test(sessionId)) return undefined;
  return {
    agent,
    sessionId,
    cwdMatches: raw.cwdMatches === true,
    ...(isPermissionMode(raw.permissionMode) ? { permissionMode: raw.permissionMode } : {}),
  };
}

const PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'bypassPermissions',
  'acceptEdits',
  'plan',
  'auto',
  'default',
]);

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value);
}

/**
 * The agent statuses a host may report over /api/workspaces. Deliberately the
 * same vocabulary as the local AgentStatus — a remote row renders through the
 * same dot grammar — but held as its own closed set so an unknown status from
 * a NEWER host (talking to an older desktop) is DROPPED by the normalizer
 * rather than smuggled into the local union.
 */
export type RemoteAgentStatus =
  | 'running'
  | 'idle'
  | 'complete'
  | 'waiting'
  | 'awaiting_input'
  | 'error';

export const REMOTE_AGENT_STATUSES: ReadonlySet<string> = new Set<RemoteAgentStatus>([
  'running',
  'idle',
  'complete',
  'waiting',
  'awaiting_input',
  'error',
]);

/** Trust-boundary check: keep only statuses this desktop understands. */
export function isRemoteAgentStatus(value: unknown): value is RemoteAgentStatus {
  return typeof value === 'string' && REMOTE_AGENT_STATUSES.has(value);
}

/** The roster's synthetic identity for a remote session — never a local ptyId
 *  (remote-terminal surfaces have `ptyId: ''` by contract), so map keys, A2A
 *  addresses, and PTY-keyed lookups can never collide with it. */
export function remoteAgentKey(hostId: string, sessionId: string): string {
  return `remote:${hostId}:${sessionId}`;
}

/** GET /api/workspaces response body. */
export interface RemoteWorkspacesResponse {
  workspaces: RemoteWorkspaceSummary[];
}

/** A persisted "this remote workspace was attached" record.
 *
 * Deliberately carries NO pane list: panes are a live property of the remote
 * daemon, so a restored attachment always re-fetches them (a stale pane list
 * on disk would mirror sessions that died while the app was closed). Carries
 * no credential either — the token lives only in RemoteHost. */
export interface RemoteAttachmentDescriptor {
  key: string;           // `${hostId}:${workspaceId}` — same key the renderer slice uses
  hostId: string;
  hostLabel: string;     // label snapshot, so a sidebar row can render before the host list loads
  workspaceId: string;
  name: string;          // remote workspace name snapshot ('' possible)
  /**
   * #1086 — local-side aliases. The remote host owns the truth (name, panes);
   * these are what THIS desktop calls the row: a rename that never touches the
   * host, and a color tag in the same grammar as local workspaces. Optional:
   * older persisted files predate them.
   */
  label?: string;
  color?: string;        // WorkspaceColorId — validated renderer-side by normalizeWorkspaceColor
}

/** The ONE place the descriptor key is spelled out. Both the renderer (which
 *  mints it on attach) and main (which refuses a descriptor whose key does not
 *  derive from its own hostId/workspaceId) go through here, so the two can
 *  never drift into main accepting a key nothing could have produced. */
export function remoteAttachmentKey(hostId: string, workspaceId: string): string {
  return `${hostId}:${workspaceId}`;
}

/** Inverse of remoteAttachmentKey. Returns null for anything that is not a
 *  `<hostId>:<workspaceId>` pair with both halves non-empty. hostId is a local
 *  uuid, so the FIRST colon is the separator. */
export function parseRemoteAttachmentKey(
  key: string,
): { hostId: string; workspaceId: string } | null {
  const sep = key.indexOf(':');
  if (sep <= 0 || sep === key.length - 1) return null;
  return { hostId: key.slice(0, sep), workspaceId: key.slice(sep + 1) };
}

/** `remote:hosts:add`'s error when the host did not answer at all (the renderer adds the Tailscale reason to it). */
export const HOST_UNREACHABLE_ERROR = 'could not reach that host';

/** Machine-readable reason for a REMOTE_HOSTS_PAIR failure — i18n happens
 *  renderer-side (AttachRemoteModal maps each reason to a translated
 *  string), so main never returns a human-facing message here. */
export type PairFailureReason =
  | 'invalid-origin'
  | 'already-registered'
  | 'expired'
  | 'too-many-attempts'
  | 'invalid-code'
  | 'insecure-transport'
  | 'unreachable'
  | 'incompatible'
  | 'pairing-failed';

/** Machine-readable reason attached to a failed remote call. `auth-rejected`
 *  means the host answered 401: it no longer accepts this computer's
 *  credential (its `wmux web` was restarted or stopped, which revokes paired
 *  devices, or this device was revoked). Retrying cannot help — the only way
 *  back is to pair again. A 403 is never this: the host's 403s are feature
 *  gates (`--allow-input`, transcript access), not a rejected credential.
 *  `unknown-workspace-id`: the host refused a new pane in a workspace it has
 *  no live pane in, which is what a pairing without the workspace grant gets
 *  for every new pane this desktop starts. */
export type RemoteErrorReason = 'auth-rejected' | 'insecure-transport' | 'unknown-workspace-id';

/**
 * A paired host as the Remote hub shows it (status = dot + text):
 *
 *   - `connected`    reachable, and this app holds live streams to it
 *   - `reachable`    answered with this computer's credential
 *   - `unreachable`  did not answer (off, asleep, network) — never a reason
 *                    to re-pair, which would throw away a working credential
 *   - `needs-repair` answered 401: it no longer accepts this computer
 *   - `insecure`     registered over plain http to another machine: not
 *                    probed, because the token would cross in the clear
 */
export type RemoteHostStatus = 'connected' | 'reachable' | 'unreachable' | 'needs-repair' | 'insecure';

/** Parse a pasted `wmux web` URL into origin + token. Returns null when the
 * string is not an http(s) URL or carries no token= query param. */
export function parseWebUrl(raw: string): { origin: string; token: string } | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const token = u.searchParams.get('token') ?? '';
  if (!token) return null;
  return { origin: u.origin, token };
}

// ─── Add PC over SSH ────────────────────────────────────────────────────────

/** IPC channels of the "Add PC over SSH" flow (renderer ↔ main only). */
export const REMOTE_SSH_IPC = {
  /** Concrete Host aliases from ~/.ssh/config. */
  CANDIDATES: 'remote:ssh:candidates',
  /** Install + pair + register one host; progress arrives on PROGRESS. */
  ADD: 'remote:ssh:add',
  PROGRESS: 'remote:ssh:progress',
  /** Tunnel state per SSH host id. */
  STATES: 'remote:ssh:states',
  /** Show, then accept, a changed host key or resolved hostname. */
  CONFIRM: 'remote:ssh:confirm',
  /** Mint a fresh code over ssh and replace a refused credential in place. */
  REPAIR: 'remote:ssh:repair',
  /** Cancel an ADD in flight by its request id. */
  CANCEL: 'remote:ssh:cancel',
  /** Turn "Start after reboot" on or off for an SSH host. */
  SERVICE: 'remote:ssh:service',
} as const;

export type SshAddPhase = 'connect' | 'probe' | 'install' | 'start' | 'pair' | 'register';

export interface SshAddProgress {
  requestId: string;
  phase: SshAddPhase;
}

/**
 * Why adding over SSH failed. `kind` is an ssh failure (auth, host-key-unknown,
 * …), a bootstrap refusal (desktop-installed, musl, …) or a pairing failure.
 * `message` is detail for the dialog, never a credential.
 */
export interface SshAddFailure {
  ok: false;
  kind: string;
  message: string;
}

export type SshAddResult =
  | { ok: true; host: RemoteHostPublic; upgradePending: boolean; viewOnly?: boolean; service?: SshServiceResult }
  | SshAddFailure;

/**
 * "Start after reboot" on an SSH host (`wmux daemon install-service` /
 * `uninstall-service` there). `lingerCommand` is set when the service is on
 * but systemd stops it at logout and skips it at boot until someone with sudo
 * runs that command on the host. `unsupported` carries the host's own hint
 * (no systemd user manager, macOS) for running it under another supervisor.
 */
export type SshServiceResult =
  | { ok: true; on: true; lingerCommand?: string }
  | { ok: true; on: false }
  | SshAddFailure;

export type SshConfirmResult =
  | { ok: true; applied: boolean; resolvedHost: string; hostKeyFingerprint: string }
  | SshAddFailure;
