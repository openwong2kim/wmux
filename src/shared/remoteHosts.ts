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
