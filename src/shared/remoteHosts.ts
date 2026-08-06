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
}

/** GET /api/workspaces response body. */
export interface RemoteWorkspacesResponse {
  workspaces: RemoteWorkspaceSummary[];
}

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
