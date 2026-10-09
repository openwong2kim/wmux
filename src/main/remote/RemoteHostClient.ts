// Main-process HTTP/SSE bridge to a remote wmux daemon's web server.
//
// Talks to the same routes the browser frontend uses (WebTerminalServer.ts:
// `handleStream`/`handleInput`), but from the main process instead of a
// browser tab — so it can set an `Authorization` header directly rather than
// relying on EventSource's query-string token, and it drives the pane state
// for Task 5's IPC handler instead of a DOM terminal.
//
// Observe + input + exactly ONE destructive verb (#1129): `closeSession`
// (`DELETE /api/sessions/:id`), the teardown twin of `createWorkspace`. This
// class mints sessions on the remote host, so it is also what must end them —
// closing a remote-terminal tab would otherwise leave the shell (and the
// workspace row the daemon derives from it) running forever. Nothing else
// here deletes anything on the remote; `detach`/`detachAll` are LOCAL stream
// teardown and leave the remote session untouched, on purpose.
//
// `resizeSession` (#1322) is neither observe, input, nor destructive — it
// changes two numbers on a struct via the same `POST /api/sessions/:id/resize`
// route the phone already uses (#766). Reused, not reinvented: the route's
// ownership rule already grants a resize to whoever asks when no desk viewer
// on the remote host is looking at the pane, which is normally true of every
// session this client mints (see the method's own doc comment).

import * as crypto from 'crypto';
import type {
  RemoteErrorReason,
  RemoteHost,
  RemotePaneSummary,
  RemoteWorkspaceSummary,
  RemoteWorkspacesResponse,
} from '../../shared/remoteHosts';
import { isRemoteAgentStatus, parseRemoteResumeInfo } from '../../shared/remoteHosts';
import { isCredentialSafeOriginString } from '../../shared/remotePairInput';
import {
  REMOTE_LIMITS,
  boundedRemoteString,
  clampRemoteDimension,
  clampRemoteGeometry,
  remoteId,
} from '../../shared/remoteLimits';
import { readBoundedJson } from './readBoundedJson';

export interface RemoteMetaEvent {
  attachId: string;
  cols: number;
  rows: number;
  snapshotB64: string;
  truncated?: boolean;
  omittedBytes?: number;
}

/**
 * A geometry-only update: the remote pane was resized while we were attached.
 * Separate from {@link RemoteMetaEvent} because it carries NO snapshot — the
 * receiver resizes its grid and keeps everything already on screen, where a
 * meta event means "reset and repaint".
 */
export interface RemoteResizeEvent {
  attachId: string;
  cols: number;
  rows: number;
}

export interface RemoteDataEvent {
  attachId: string;
  dataB64: string;
}

export interface RemoteExitEvent {
  attachId: string;
}

export interface RemoteErrorEvent {
  attachId: string;
  message: string;
  /** Set when the stream ended because the host rejected the credential —
   *  the renderer offers "pair again" instead of a generic disconnect. */
  reason?: RemoteErrorReason;
}

/**
 * The host answered 401 with one of its own credential errors: it no longer
 * accepts this computer's credential — an unknown or revoked device
 * (`{ error: 'unauthorized', reason }`) or a grant that expired mid-request
 * (`{ error: 'authorization-expired' }`). A 401 WITHOUT that body came from
 * something in front of the host (a proxy, a captive portal) and stays an
 * ordinary, retryable error. The host's 403s are feature gates
 * (`--allow-input`, transcript access, host allowlist) and are never this:
 * "this host is read-only" must not read as "pair again".
 */
export class RemoteAuthRejectedError extends Error {
  readonly reason = 'auth-rejected' as const;
  constructor(operation: string) {
    super(`${operation} failed: the host no longer accepts this computer's credential`);
    this.name = 'RemoteAuthRejectedError';
  }
}

export function isRemoteAuthRejected(err: unknown): err is RemoteAuthRejectedError {
  return err instanceof RemoteAuthRejectedError;
}

/**
 * The host was registered over plain http to ANOTHER machine (before pairing
 * required HTTPS). Its bearer token would cross the network in the clear, so
 * no request carrying it is sent — fail closed, before any I/O. Never
 * auto-upgraded to https: that is a different origin, and the credential was
 * issued for this one. The way back is to pair again over HTTPS.
 */
export class RemoteInsecureTransportError extends Error {
  readonly reason = 'insecure-transport' as const;
  constructor(operation: string) {
    super(`${operation} refused: this host needs HTTPS — re-pair over HTTPS`);
    this.name = 'RemoteInsecureTransportError';
  }
}

export function isRemoteInsecureTransport(err: unknown): err is RemoteInsecureTransportError {
  return err instanceof RemoteInsecureTransportError;
}

/** The `error` values the host's web server puts on a credential 401. */
const HOST_CREDENTIAL_ERRORS: ReadonlySet<string> = new Set(['unauthorized', 'authorization-expired']);

type ErrorBody = { error?: unknown; detail?: unknown } | null;

/** Reads a failed response's JSON body once; null when it is not JSON. */
async function readErrorBody(res: Response): Promise<ErrorBody> {
  try {
    const body = await readBoundedJson(res, REMOTE_LIMITS.smallBodyBytes);
    return typeof body === 'object' && body !== null ? (body as ErrorBody) : null;
  } catch {
    return null;
  }
}

function isCredentialRejection(status: number, body: ErrorBody): boolean {
  return status === 401 && typeof body?.error === 'string' && HOST_CREDENTIAL_ERRORS.has(body.error);
}

/** The host's own wording for a failure, else `fallback`. */
function errorMessage(body: ErrorBody, fallback: string): string {
  if (typeof body?.detail === 'string' && body.detail) return body.detail.slice(0, 256);
  if (typeof body?.error === 'string' && body.error) return body.error.slice(0, 256);
  return fallback;
}

export interface RemotePaneEvents {
  onMeta(cb: (e: RemoteMetaEvent) => void): void;
  onResize(cb: (e: RemoteResizeEvent) => void): void;
  onData(cb: (e: RemoteDataEvent) => void): void;
  onExit(cb: (e: RemoteExitEvent) => void): void;
  onError(cb: (e: RemoteErrorEvent) => void): void;
}

// Reconnect backoff: 1s -> 2s -> 5s, capped, with +/-30% jitter so that a
// tailnet blip affecting several mirrors at once does not have them all
// hammer the remote host in lockstep.
const BACKOFF_STEPS_MS = [1000, 2000, 5000];
const JITTER_RATIO = 0.3;

// After this many consecutive failed reconnect attempts, stop retrying and
// emit onError instead — otherwise a dead remote gets hammered forever
// (every ~5s, the max backoff step) while the renderer sits on a silent
// blank mirror with no signal the stream is gone for good.
const MAX_RECONNECT_ATTEMPTS = 5;

// Write coalescing window: two POSTs in flight at once can land out of order
// and scramble keystrokes, and per-character POSTs at desktop typing rates
// are wasteful, so writes that arrive while one is in flight are queued and
// merged into a single follow-up POST.
const WRITE_COALESCE_MS = 5;

// Bounded-reads timeout for the request/response calls (listWorkspaces,
// write) — these are one-shot fetches, unlike the long-lived SSE stream,
// so a hung remote must not leave the caller awaiting forever.
const REQUEST_TIMEOUT_MS = 10_000;

interface Attachment {
  attachId: string;
  sessionId: string;
  controller: AbortController;
  // Buffered meta JSON, held until the paired `snapshot` frame arrives so a
  // single onMeta callback carries cols/rows/snapshotB64/truncated together
  // (matching the RemotePaneEvents contract — there is no separate onSnapshot).
  //
  // Only the ATTACH frame is a pair. A mid-stream geometry update arrives on
  // its own and is dispatched as a resize instead — holding it here for a
  // partner that never comes is how a resize used to reach the mirror as
  // nothing at all.
  pendingMeta: { cols: number; rows: number; truncated?: boolean; omittedBytes?: number } | null;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  detached: boolean;
  /** Bumped by `refresh`: a stream opened under an older generation is
   *  superseded, so its late frames and its end must not act on the attach. */
  generation: number;
  /** onError already told this mirror the host rejected the credential. */
  authRejectedReported?: boolean;
  /** An SSE response is open and being read right now (not reconnecting). */
  streamOpen?: boolean;
}

interface WriteQueueState {
  pending: string[];
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  // Resolvers for every write() call folded into the currently-queued (not
  // yet sent) batch — all resolve/reject together once that batch's POST
  // settles, preserving submission order without per-character requests.
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

function jitteredDelay(baseMs: number): number {
  const jitter = baseMs * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(baseMs + jitter));
}

function backoffForAttempt(attempt: number): number {
  const step = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
  return jitteredDelay(step);
}

/** `/api/workspaces` is a trust boundary: the body is produced by ANOTHER
 *  machine, possibly running an older or misbehaving build, and nothing but a
 *  TypeScript cast stood between it and callers that do `.find()` / `.map()`
 *  on it. A single malformed body used to throw far downstream and take a
 *  whole refresh round — every other host in it — with it.
 *
 *  So: normalise here, once, where every caller benefits. Anything that does
 *  not match the declared shape is DROPPED rather than passed on; a workspace
 *  with no usable id, or a pane with no sessionId, cannot be addressed anyway.
 *
 *  Bounded the same way (REMOTE_LIMITS): ids over the id length are dropped,
 *  free text is cut to its limit, rows past the workspace and pane counts are
 *  not read, and a repeated workspace or session id keeps its first row only,
 *  so every key the renderer derives from this reply is unique. */
export function normalizeWorkspaces(body: unknown): RemoteWorkspaceSummary[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(list)) return [];

  const workspaces: RemoteWorkspaceSummary[] = [];
  const seenWorkspaces = new Set<string>();
  const seenSessions = new Set<string>();
  for (const rawWs of list) {
    if (workspaces.length >= REMOTE_LIMITS.workspaces) break;
    if (typeof rawWs !== 'object' || rawWs === null) continue;
    const ws = rawWs as Record<string, unknown>;
    const wsId = remoteId(ws.id);
    if (!wsId || seenWorkspaces.has(wsId)) continue;
    seenWorkspaces.add(wsId);

    const panes: RemotePaneSummary[] = [];
    if (Array.isArray(ws.panes)) {
      for (const rawPane of ws.panes) {
        if (seenSessions.size >= REMOTE_LIMITS.panes) break;
        if (typeof rawPane !== 'object' || rawPane === null) continue;
        const pane = rawPane as Record<string, unknown>;
        const sessionId = remoteId(pane.sessionId);
        if (!sessionId || seenSessions.has(sessionId)) continue;
        seenSessions.add(sessionId);
        const shell = boundedRemoteString(pane.shell, REMOTE_LIMITS.shell);
        const cwd = boundedRemoteString(pane.cwd, REMOTE_LIMITS.cwd);
        panes.push({
          sessionId,
          ...(shell !== undefined ? { shell } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          // #1163 — agent metadata is additive-optional (older hosts omit
          // both fields). The status is additionally whitelist-checked so a
          // NEWER host's unknown status degrades to "name only" instead of
          // smuggling a foreign value into the local AgentStatus union.
          ...(typeof pane.agentName === 'string' && pane.agentName
            ? {
                // Capped: the value is another machine's output flowing into
                // row text, title/aria labels, and per-tick string compares.
                agentName: pane.agentName.slice(0, REMOTE_LIMITS.agentName),
                ...(isRemoteAgentStatus(pane.agentStatus) ? { agentStatus: pane.agentStatus } : {}),
              }
            : {}),
          // #1342 — the resume block and its two gate signals, under the same
          // additive-optional rule as the agent fields: an older host omits
          // all three and the desktop simply shows no resume chip. A partial
          // or malformed block is DROPPED by the parser rather than half-read
          // — a chip built from half an offer types a broken command.
          ...(() => {
            const resume = parseRemoteResumeInfo(pane.resume);
            return resume ? { resume } : {};
          })(),
          ...(typeof pane.commandRunning === 'boolean' ? { commandRunning: pane.commandRunning } : {}),
          ...(typeof pane.agentProcessAlive === 'boolean'
            ? { agentProcessAlive: pane.agentProcessAlive }
            : {}),
        });
      }
    }
    workspaces.push({ id: wsId, name: boundedRemoteString(ws.name, REMOTE_LIMITS.workspaceName) ?? '', panes });
  }
  return workspaces;
}

type MetaFrame = { cols: number; rows: number; truncated?: boolean; omittedBytes?: number; resize?: boolean };

/** A `meta` frame's fields, typed and bounded: geometry clamped into
 *  1..geometryMax, the optional flags kept only when well-formed. Null when
 *  the frame carries no usable geometry. */
function parseMetaFrame(raw: unknown): MetaFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const cols = clampRemoteDimension(r.cols);
  const rows = clampRemoteDimension(r.rows);
  if (cols === null || rows === null) return null;
  return {
    cols,
    rows,
    ...(typeof r.truncated === 'boolean' ? { truncated: r.truncated } : {}),
    ...(typeof r.omittedBytes === 'number' && Number.isSafeInteger(r.omittedBytes) && r.omittedBytes >= 0
      ? { omittedBytes: r.omittedBytes }
      : {}),
    ...(r.resize === true ? { resize: true } : {}),
  };
}

export class RemoteHostClient implements RemotePaneEvents {
  private readonly host: RemoteHost;
  private readonly fetchImpl: typeof fetch;

  private readonly attachments = new Map<string, Attachment>();
  private readonly writeQueues = new Map<string, WriteQueueState>();

  private metaCbs: Array<(e: RemoteMetaEvent) => void> = [];
  private resizeCbs: Array<(e: RemoteResizeEvent) => void> = [];
  private dataCbs: Array<(e: RemoteDataEvent) => void> = [];
  private exitCbs: Array<(e: RemoteExitEvent) => void> = [];
  private errorCbs: Array<(e: RemoteErrorEvent) => void> = [];
  /** Set once the host refuses this credential; see `rejected`. */
  private authRejected = false;

  /** Credentials may not be sent to this origin (see RemoteInsecureTransportError). */
  private readonly insecure: boolean;

  constructor(host: RemoteHost, fetchImpl: typeof fetch = fetch) {
    this.host = host;
    this.fetchImpl = fetchImpl;
    this.insecure = !isCredentialSafeOriginString(host.origin);
  }

  /** Whether every token-carrying call to this host is refused. */
  isInsecure(): boolean {
    return this.insecure;
  }

  /** Throws before any I/O when the token may not be sent to this host. */
  private assertSecure(operation: string): void {
    if (this.insecure) throw new RemoteInsecureTransportError(operation);
  }

  onMeta(cb: (e: RemoteMetaEvent) => void): void {
    this.metaCbs.push(cb);
  }

  onResize(cb: (e: RemoteResizeEvent) => void): void {
    this.resizeCbs.push(cb);
  }

  onData(cb: (e: RemoteDataEvent) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (e: RemoteExitEvent) => void): void {
    this.exitCbs.push(cb);
  }

  onError(cb: (e: RemoteErrorEvent) => void): void {
    this.errorCbs.push(cb);
  }

  /**
   * Bootstrap the first pane of a NEW workspace on this host (#1001). Mints
   * no id itself — the caller (the renderer, which owns the workspace
   * registry today) supplies `workspaceId`, and this is the operator-Bearer
   * request `WebTerminalServer.rejectWorkspaceId` lets mint an unknown id
   * for: `RemoteHost.token` is always the operator credential (parsed from
   * the pasted wmux-web URL or the pair exchange — see remoteHosts.ts), never
   * a paired device's, so every call through this client already qualifies.
   *
   * Returns the new pane's `sessionId` on success — the caller attaches to
   * it the same way `REMOTE_PANE_ATTACH` attaches to any other remote pane.
   */
  async createWorkspace(workspaceId: string, cwd?: string): Promise<{ sessionId: string }> {
    this.assertSecure('createWorkspace');
    const res = await this.fetchImpl(`${this.host.origin}/api/sessions`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, ...(cwd ? { cwd } : {}) }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await readErrorBody(res);
      if (isCredentialRejection(res.status, body)) throw this.rejected('createWorkspace');
      throw new Error(errorMessage(body, `createWorkspace failed: HTTP ${res.status}`));
    }
    let body: unknown;
    try {
      body = await readBoundedJson(res, REMOTE_LIMITS.smallBodyBytes);
    } catch {
      throw new Error('createWorkspace failed: response body was not JSON');
    }
    const sessionId = remoteId((body as { id?: unknown } | null)?.id);
    if (!sessionId) {
      throw new Error('createWorkspace failed: response carried no session id');
    }
    return { sessionId };
  }

  /**
   * Destroy one session on this host — `DELETE /api/sessions/:id` (#1129).
   *
   * The teardown half of {@link createWorkspace}: the desktop mints a session
   * (and with it the workspace row the daemon derives from that session's
   * `WMUX_WORKSPACE_ID` — the daemon keeps no registry of its own), so the
   * desktop is the only thing that can end it. Detaching closes the SSE
   * stream and nothing else; the shell keeps running on the host forever.
   *
   * A 404 resolves rather than throws: the session already being gone is the
   * outcome the caller asked for, and a close racing the shell's own exit is
   * the normal case, not an error. Every other non-2xx throws with the
   * daemon's own wording — notably 403 on a host running without
   * `--allow-input`, where closing a pane is refused for the same reason
   * typing is.
   */
  async closeSession(sessionId: string): Promise<void> {
    this.assertSecure('closeSession');
    const res = await this.fetchImpl(
      `${this.host.origin}/api/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'DELETE',
        headers: this.authHeaders(),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (res.ok || res.status === 404) return;
    const body = await readErrorBody(res);
    if (isCredentialRejection(res.status, body)) throw this.rejected('closeSession');
    throw new Error(errorMessage(body, `closeSession failed: HTTP ${res.status}`));
  }

  /**
   * `POST /api/sessions/:id/resize` (#766, reused for #1322) — asks the
   * remote daemon to change the PTY's geometry, exactly the way a paired
   * phone already does. Nothing here is phone-specific: `handleSessionResize`
   * grants the request whenever the underlying session is `detached` or
   * `attached` without a visible desk viewer, which is what a session this
   * client itself minted via {@link createWorkspace} normally is — nothing on
   * the remote host ever calls `daemon.attachSession` for it, so it never
   * becomes `attached` in the first place. See `WebTerminalServer.ts:1966-2007`
   * for the ownership rule this method is on the receiving end of.
   *
   * Returns the APPLIED geometry on success (the manager floors cols/rows, so
   * this can differ from what was asked for) or `{ ok: false }` when a desk
   * viewer on the remote host owns the size right now (`409 desk-owns-size`) —
   * that is an expected, non-exceptional outcome, not a transport failure, so
   * it resolves rather than throws. A resize request racing the pane's own
   * teardown (404) is folded into the same `{ ok: false }` shape: by the time
   * the answer arrives there is nothing left to have asked for.
   */
  async resizeSession(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<{ ok: true; cols: number; rows: number } | { ok: false; reason: string }> {
    if (this.insecure) return { ok: false, reason: 'insecure-transport' };
    const requested = clampRemoteGeometry(cols, rows);
    if (!requested) return { ok: false, reason: 'cols and rows must be finite numbers' };
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.host.origin}/api/sessions/${encodeURIComponent(sessionId)}/resize`,
        {
          method: 'POST',
          headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(requested),
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    let body: unknown;
    try {
      body = await readBoundedJson(res, REMOTE_LIMITS.smallBodyBytes);
    } catch {
      body = null;
    }
    if (isCredentialRejection(res.status, body as ErrorBody)) {
      this.rejected('resizeSession');
      return { ok: false, reason: 'auth-rejected' };
    }
    if (!res.ok) {
      const parsed = body as { error?: string; detail?: string } | null;
      const reason = parsed?.error ?? parsed?.detail;
      return { ok: false, reason: typeof reason === 'string' && reason ? reason.slice(0, 256) : `HTTP ${res.status}` };
    }
    const parsed = body as { cols?: unknown; rows?: unknown } | null;
    const applied = clampRemoteGeometry(parsed?.cols, parsed?.rows);
    if (!applied) {
      return { ok: false, reason: 'resizeSession: response carried no geometry' };
    }
    return { ok: true, ...applied };
  }

  async listWorkspaces(): Promise<RemoteWorkspacesResponse> {
    this.assertSecure('listWorkspaces');
    const res = await this.fetchImpl(`${this.host.origin}/api/workspaces`, {
      headers: this.authHeaders(),
      // Bearer-credentialed request: never silently follow a redirect —
      // a redirected credentialed request is wrong here regardless of
      // whether undici happens to strip Authorization cross-origin.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // The host's own wording when it gives one, like the other calls here.
      const body = await readErrorBody(res);
      if (isCredentialRejection(res.status, body)) throw this.rejected('listWorkspaces');
      throw new Error(errorMessage(body, `listWorkspaces failed: HTTP ${res.status}`));
    }
    let body: unknown;
    try {
      body = await readBoundedJson(res, REMOTE_LIMITS.workspacesBodyBytes);
    } catch {
      throw new Error('listWorkspaces failed: response body was not JSON');
    }
    return { workspaces: normalizeWorkspaces(body) };
  }

  attach(sessionId: string): string {
    const attachId = crypto.randomUUID();
    const attachment: Attachment = {
      attachId,
      sessionId,
      controller: new AbortController(),
      pendingMeta: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      detached: false,
      generation: 0,
    };
    this.attachments.set(attachId, attachment);
    this.openStream(attachment);
    return attachId;
  }

  detach(attachId: string): void {
    const attachment = this.attachments.get(attachId);
    if (!attachment) return;
    attachment.detached = true;
    if (attachment.reconnectTimer) {
      clearTimeout(attachment.reconnectTimer);
      attachment.reconnectTimer = null;
    }
    attachment.controller.abort();
    this.attachments.delete(attachId);
  }

  /**
   * Re-open the attach's stream so the host sends a fresh meta + snapshot.
   *
   * For a second viewer that joins an existing attach in the same renderer
   * (the attach is shared per host + session): the first viewer already
   * consumed the attach's meta, so without a fresh one the newcomer never
   * learns the grid or sees what is on screen. Every viewer of the attach
   * repaints from the new snapshot, which is the price of sharing one stream.
   */
  refresh(attachId: string): void {
    const attachment = this.attachments.get(attachId);
    if (!attachment || attachment.detached) return;
    if (attachment.reconnectTimer) {
      clearTimeout(attachment.reconnectTimer);
      attachment.reconnectTimer = null;
    }
    attachment.generation += 1;
    attachment.controller.abort();
    attachment.controller = new AbortController();
    attachment.reconnectAttempt = 0;
    this.openStream(attachment);
  }

  /** Streams that are open and being read right now — what makes the hub
   *  say "connected". An attachment waiting to reconnect does not count. */
  liveAttachmentCount(): number {
    let n = 0;
    for (const attachment of this.attachments.values()) {
      if (!attachment.detached && attachment.streamOpen === true) n += 1;
    }
    return n;
  }

  /** Whether the host has refused this credential (the latch `rejected` sets). */
  isAuthRejected(): boolean {
    return this.authRejected;
  }

  detachAll(): void {
    for (const id of [...this.attachments.keys()]) {
      this.detach(id);
    }
  }

  write(attachId: string, utf8: string): Promise<void> {
    // The host has refused this credential: nothing typed can reach it until
    // the host is paired again (which builds a fresh client).
    if (this.authRejected) return Promise.reject(new RemoteAuthRejectedError('write'));
    if (this.insecure) return Promise.reject(new RemoteInsecureTransportError('write'));
    const attachment = this.attachments.get(attachId);
    const sessionId = attachment ? attachment.sessionId : attachId;
    let queue = this.writeQueues.get(sessionId);
    if (!queue) {
      queue = { pending: [], coalesceTimer: null, inFlight: false, waiters: [] };
      this.writeQueues.set(sessionId, queue);
    }
    queue.pending.push(utf8);
    return new Promise<void>((resolve, reject) => {
      queue!.waiters.push({ resolve, reject });
      this.scheduleWriteFlush(sessionId, queue!);
    });
  }

  private scheduleWriteFlush(sessionId: string, queue: WriteQueueState): void {
    if (queue.inFlight) return; // a flush will be scheduled when the in-flight POST settles
    if (queue.coalesceTimer) return; // already scheduled
    queue.coalesceTimer = setTimeout(() => {
      queue.coalesceTimer = null;
      void this.flushWrite(sessionId, queue);
    }, WRITE_COALESCE_MS);
  }

  private async flushWrite(sessionId: string, queue: WriteQueueState): Promise<void> {
    if (queue.pending.length === 0) return;
    const body = queue.pending.join('');
    const waiters = queue.waiters;
    queue.pending = [];
    queue.waiters = [];
    queue.inFlight = true;
    try {
      const res = await this.fetchImpl(`${this.host.origin}/api/input?session=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: this.authHeaders(),
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await readErrorBody(res);
        if (isCredentialRejection(res.status, body)) {
          const err = this.rejected('write');
          // Drop what queued up behind this POST too: none of it can land.
          const queued = queue.waiters;
          queue.pending = [];
          queue.waiters = [];
          for (const w of [...waiters, ...queued]) w.reject(err);
          return;
        }
        const err = new Error(typeof body?.error === 'string' && body.error ? body.error : `write failed: HTTP ${res.status}`);
        for (const w of waiters) w.reject(err);
        return;
      }
      for (const w of waiters) w.resolve();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const w of waiters) w.reject(e);
    } finally {
      queue.inFlight = false;
      // More writes may have accumulated while this POST was in flight.
      if (queue.pending.length > 0 && !this.authRejected) {
        this.scheduleWriteFlush(sessionId, queue);
      }
    }
  }

  /**
   * Latch the host's refusal of this credential and tell every attached
   * mirror once. Returns the error for the caller to throw or report. A
   * re-pair replaces the whole client, which is what clears the latch.
   */
  private rejected(operation: string): RemoteAuthRejectedError {
    const err = new RemoteAuthRejectedError(operation);
    this.authRejected = true;
    for (const attachment of this.attachments.values()) this.reportAuthRejected(attachment, err);
    return err;
  }

  private reportAuthRejected(attachment: Attachment, err: RemoteAuthRejectedError): void {
    if (attachment.authRejectedReported || attachment.detached) return;
    attachment.authRejectedReported = true;
    for (const cb of this.errorCbs) {
      cb({ attachId: attachment.attachId, message: err.message, reason: err.reason });
    }
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.host.token}` };
  }

  private openStream(attachment: Attachment): void {
    attachment.pendingMeta = null;
    void this.runStream(attachment);
  }

  private async runStream(attachment: Attachment): Promise<void> {
    const generation = attachment.generation;
    const superseded = (): boolean => attachment.detached || attachment.generation !== generation;
    if (this.insecure) {
      // No stream, no reconnect loop: report it once and leave the attachment
      // idle until it is detached or the host is paired again over HTTPS.
      // Deferred a tick so a caller that subscribes right after attach()
      // still hears it.
      await Promise.resolve();
      if (superseded()) return;
      const err = new RemoteInsecureTransportError('stream');
      for (const cb of this.errorCbs) cb({ attachId: attachment.attachId, message: err.message, reason: err.reason });
      return;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.host.origin}/api/stream?session=${encodeURIComponent(attachment.sessionId)}`,
        // No timeout here — the SSE stream is long-lived by design. Still
        // refuse a redirect on this Bearer-credentialed request, same as
        // listWorkspaces/write.
        { headers: this.authHeaders(), redirect: 'error', signal: attachment.controller.signal },
      );
    } catch (err) {
      if (superseded()) return;
      this.scheduleReconnect(attachment, err);
      return;
    }
    if (superseded()) return;
    if (res.status === 401) {
      const body = await readErrorBody(res);
      if (superseded()) return;
      if (isCredentialRejection(res.status, body)) {
        // The host has said no to this credential. Retrying cannot change
        // that answer, so no backoff loop: report it once, now, and leave the
        // attachment idle until it is detached or the host is paired again.
        this.rejected('stream');
        this.reportAuthRejected(attachment, new RemoteAuthRejectedError('stream'));
        return;
      }
      this.scheduleReconnect(attachment, new Error('stream failed: HTTP 401'));
      return;
    }
    if (!res.ok || !res.body) {
      this.scheduleReconnect(attachment, new Error(`stream failed: HTTP ${res.status}`));
      return;
    }

    attachment.streamOpen = true;
    try {
      await this.pumpStream(attachment, res.body, superseded);
      attachment.streamOpen = false;
      if (superseded()) return;
      // The stream ended without an explicit abort — treat as a drop and
      // reconnect the same as a network error.
      this.scheduleReconnect(attachment, new Error('stream closed'));
    } catch (err) {
      attachment.streamOpen = false;
      if (superseded()) return;
      this.scheduleReconnect(attachment, err);
    }
  }

  private async pumpStream(
    attachment: Attachment,
    body: ReadableStream<Uint8Array>,
    superseded: () => boolean,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || superseded()) return;
        buffer += decoder.decode(value, { stream: true });
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          // Reset the backoff schedule only once an event frame has actually
          // been dispatched — resetting it right after headers, or on any
          // chunk, would let a server that accepts the request and then never
          // completes a frame retry forever, since the counter never gets a
          // chance to climb past MAX_RECONNECT_ATTEMPTS.
          if (this.handleFrame(attachment, rawFrame)) attachment.reconnectAttempt = 0;
          if (superseded()) return;
        }
        if (buffer.length > REMOTE_LIMITS.streamBufferBytes) {
          // A frame larger than any the host sends is not one to keep
          // buffering: drop this stream and let the bounded retry decide.
          await reader.cancel().catch(() => { /* already closed */ });
          throw new Error('stream frame exceeds the size limit');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Returns whether the frame was an event (not a comment or heartbeat). */
  private handleFrame(attachment: Attachment, rawFrame: string): boolean {
    const lines = rawFrame.split('\n');
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue; // comment frame (heartbeat) — ignore
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }
    if (event === null) return false; // pure comment frame, nothing to dispatch
    const data = dataLines.join('\n');
    this.dispatchFrame(attachment, event, data);
    return true;
  }

  private dispatchFrame(attachment: Attachment, event: string, data: string): void {

    switch (event) {
      case 'meta': {
        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch {
          return; // malformed frame — drop rather than crash the pump
        }
        const parsed = parseMetaFrame(raw);
        if (!parsed) return; // no usable geometry — drop the frame
        // Geometry-only: the daemon marks the mid-stream form, which has no
        // snapshot behind it. Dispatch it straight through so the mirror
        // resizes its grid WITHOUT resetting and losing its scrollback.
        if (parsed.resize) {
          this.dispatchResize(attachment, parsed);
          return;
        }
        // Belt and braces for a peer that sends a bare meta without the marker:
        // a held meta that a second meta overtakes was never going to get its
        // snapshot either, so let it out as geometry rather than dropping it.
        this.flushPendingMetaAsResize(attachment);
        attachment.pendingMeta = parsed;
        return;
      }
      case 'snapshot': {
        const meta = attachment.pendingMeta;
        if (!meta) return; // snapshot without a preceding meta — nothing to combine with
        attachment.pendingMeta = null;
        const evt: RemoteMetaEvent = {
          attachId: attachment.attachId,
          cols: meta.cols,
          rows: meta.rows,
          snapshotB64: data,
          ...(meta.truncated !== undefined ? { truncated: meta.truncated } : {}),
          ...(meta.omittedBytes !== undefined ? { omittedBytes: meta.omittedBytes } : {}),
        };
        for (const cb of this.metaCbs) cb(evt);
        return;
      }
      case 'data': {
        this.flushPendingMetaAsResize(attachment);
        for (const cb of this.dataCbs) cb({ attachId: attachment.attachId, dataB64: data });
        return;
      }
      case 'exit': {
        this.flushPendingMetaAsResize(attachment);
        for (const cb of this.exitCbs) cb({ attachId: attachment.attachId });
        return;
      }
      default:
        // Unknown/fan-out event (e.g. `attention`) — never treat as pane bytes.
        return;
    }
  }

  /** A held meta that turned out to have no snapshot behind it is geometry. */
  private flushPendingMetaAsResize(attachment: Attachment): void {
    const held = attachment.pendingMeta;
    if (!held) return;
    attachment.pendingMeta = null;
    this.dispatchResize(attachment, held);
  }

  private dispatchResize(attachment: Attachment, geometry: { cols: number; rows: number }): void {
    const evt: RemoteResizeEvent = {
      attachId: attachment.attachId,
      cols: geometry.cols,
      rows: geometry.rows,
    };
    for (const cb of this.resizeCbs) cb(evt);
  }

  private scheduleReconnect(attachment: Attachment, err: unknown): void {
    if (attachment.detached) return;
    if (attachment.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      const message = err instanceof Error ? err.message : String(err ?? 'stream error');
      for (const cb of this.errorCbs) cb({ attachId: attachment.attachId, message });
      return;
    }
    const delay = backoffForAttempt(attachment.reconnectAttempt);
    attachment.reconnectAttempt += 1;
    attachment.reconnectTimer = setTimeout(() => {
      attachment.reconnectTimer = null;
      if (attachment.detached) return;
      this.openStream(attachment);
    }, delay);
  }
}
