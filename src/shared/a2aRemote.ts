// === Cross-host A2A (company-LAN PoC) — shared contract v1 ===
//
// Pane-to-pane A2A between wmux hosts on one LAN, carried over the daemon web
// server's native-TLS listener. Four contract layers:
//
//   1. Host pairing  — a one-shot invite string; the joiner pins the server's
//                      self-signed certificate by SHA-256 fingerprint and is
//                      issued a PEER credential (never a device credential).
//   2. Exposure      — per paired host, which workspaces/panes it may see.
//                      Default: nothing.
//   3. Link          — one local pane <-> one remote pane, bound to paneId,
//                      accepted by a human, with per-direction allow flags.
//   4. Delivery      — idempotent task/reply/state messages keyed by
//                      (linkId, messageId), a durable outbox per side, and a
//                      server-sent stream for the server -> joiner direction.
//
// Transport shape (one connection per pair, both directions): the joiner
// POSTs joiner->server messages and holds `GET /api/a2a/stream` open for
// server->joiner messages — the MCP Streamable-HTTP shape. Only the server
// side of a pair needs an inbound port and a certificate.
//
// Security invariants this file pins:
//   - A peer credential is a DIFFERENT credential type from a web device. It
//     never becomes a `WebPrincipal`; it authenticates `/api/a2a/*` and
//     nothing else, and `/api/a2a/*` accepts nothing else. Its wire form
//     contains no '.', so a device-credential parser fails closed on it.
//   - The sender's workspace/pane is NEVER read off the wire: the receiving
//     server derives it from its own link record for the authenticated peer.
//   - Remote-origin work is message-only (no worker spawn) and a remote task
//     whose target pane changed occupant is HELD, never re-routed to a sibling
//     pane (a sibling may not be exposed).
//   - Every persisted record carries `v` so a downgrade or a future colleague
//     tier can tell formats apart.
//
// Pure module: no node:* imports (the renderer imports these types).

import type { TaskState } from './types';

// ─── Versions ───────────────────────────────────────────────────────────────

/** Wire protocol version spoken on `/api/a2a/*`. Bumped on any breaking change. */
export const A2A_REMOTE_PROTOCOL = 1;
/** Version stamped on every persisted record defined here. */
export const A2A_REMOTE_RECORD_V = 1;

// ─── Routes ─────────────────────────────────────────────────────────────────

/** Every peer route lives under this prefix and nothing else does. */
export const A2A_ROUTE_PREFIX = '/api/a2a/';

export const A2A_ROUTES = Object.freeze({
  /**
   * POST — redeem a one-shot invite code for a peer credential (layer 1).
   * Body: A2aPairRequest. The ONLY peer route that takes no credential.
   */
  pair: '/api/a2a/pair',
  /**
   * POST — the joiner withdraws its own pairing: the server revokes the
   * calling peer and ends its links and exposure. Peer credential required.
   */
  unpair: '/api/a2a/unpair',
  /** GET  — the server's identity + protocol (lets a joiner re-verify after an address change). */
  hello: '/api/a2a/hello',
  /** GET  — what the server exposes to THIS peer (layer 2). */
  exposed: '/api/a2a/exposed',
  /** POST — propose a link (layer 3). Body: A2aLinkProposeRequest. */
  links: '/api/a2a/links',
  /** POST — revoke a link from the joiner side. Path: /api/a2a/links/:linkId/revoke */
  linkRevokeSuffix: '/revoke',
  /** POST — deliver one joiner->server message (layer 4). Body: A2aRemoteEnvelope. */
  messages: '/api/a2a/messages',
  /** GET  — SSE stream of server->joiner events, resumable by (epoch, seq). */
  stream: '/api/a2a/stream',
  /** POST — joiner acknowledges stream events up to a cursor. Body: A2aStreamAck. */
  ack: '/api/a2a/ack',
} as const);

/**
 * Default port of the dedicated A2A listener. Clear of the web server (7681)
 * and LanLink (45651) defaults; the operator can change it in Settings.
 */
export const A2A_REMOTE_DEFAULT_PORT = 45660;

/** True iff `pathname` is a peer route (prefix match on the canonical path). */
export function isA2aRoute(pathname: string): boolean {
  return pathname.startsWith(A2A_ROUTE_PREFIX);
}

// ─── Identity ───────────────────────────────────────────────────────────────

/**
 * A host's stable identity. Random UUID minted once per wmux data directory and
 * NEVER derived from the certificate, so rotating the certificate re-pins the
 * fingerprint without invalidating links (eng review: hostId vs hostFp).
 */
export type HostId = string;

/**
 * SHA-256 certificate fingerprint in Node's `X509Certificate.fingerprint256`
 * form: 32 upper-case hex byte pairs joined by ':'.
 */
export type CertFingerprint256 = string;

const FP256_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;

/** Canonicalize a fingerprint (accepts lower case and bare hex); null if malformed. */
export function normalizeFingerprint256(raw: unknown): CertFingerprint256 | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.trim().replace(/:/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  const fp = hex.match(/.{2}/g)!.join(':');
  return FP256_RE.test(fp) ? fp : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isHostId(v: unknown): v is HostId {
  return typeof v === 'string' && UUID_RE.test(v);
}

// ─── Peer credential ────────────────────────────────────────────────────────

/**
 * Bearer form: `wmuxpeer~<peerId>~<secret>`. `peerId` is a UUID, `secret` is
 * base64url — neither contains '.', the web DEVICE credential separator, so a
 * peer credential presented to the device path parses as nothing (fail closed).
 */
export const PEER_CREDENTIAL_PREFIX = 'wmuxpeer';
export const PEER_CREDENTIAL_SEP = '~';

const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;

export interface PeerCredential {
  peerId: string;
  secret: string;
}

export function formatPeerCredential(c: PeerCredential): string {
  return [PEER_CREDENTIAL_PREFIX, c.peerId, c.secret].join(PEER_CREDENTIAL_SEP);
}

/** Parse a Bearer value; null unless it is exactly a well-formed peer credential. */
export function parsePeerCredential(bearer: unknown): PeerCredential | null {
  if (typeof bearer !== 'string') return null;
  const parts = bearer.split(PEER_CREDENTIAL_SEP);
  if (parts.length !== 3 || parts[0] !== PEER_CREDENTIAL_PREFIX) return null;
  const [, peerId, secret] = parts;
  if (!UUID_RE.test(peerId) || !SECRET_RE.test(secret)) return null;
  return { peerId, secret };
}

/** True iff the Bearer value CLAIMS to be a peer credential (well-formed or not). */
export function looksLikePeerCredential(bearer: unknown): boolean {
  return typeof bearer === 'string' && bearer.startsWith(PEER_CREDENTIAL_PREFIX + PEER_CREDENTIAL_SEP);
}

// ─── Invite (layer 1) ───────────────────────────────────────────────────────

/**
 * Paste-only invite string (there is NO `wmux-a2a:` protocol handler):
 *
 *   wmux-a2a://<host>:<port>/<CODE>#sha256=<fingerprint256>[&alt=<ipv4>,<ipv4>]
 *
 * `host` is the server's machine name first (company DNS), an IPv4 otherwise.
 * `alt` (optional, at most `INVITE_ALT_MAX` canonical IPv4s) lists more
 * addresses to try in order when `host` does not resolve or answer.
 * `CODE` is the server's one-shot pairing code (same alphabet and slot as the
 * existing pair flows). The fingerprint is what the joiner pins BEFORE sending
 * any credential-bearing byte.
 */
export const INVITE_SCHEME = 'wmux-a2a:';

export interface A2aInvite {
  host: string;
  port: number;
  code: string;
  fingerprint256: CertFingerprint256;
  /** Fallback IPv4s, tried after `host` in order. Absent when there are none. */
  alt?: string[];
}

export const INVITE_ALT_MAX = 4;

const INVITE_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export type InviteParseError = 'empty' | 'scheme' | 'host' | 'port' | 'code' | 'fingerprint' | 'alt';

/** Canonical dotted-quad IPv4 (no leading zeros). */
export function isCanonicalIpv4(v: string): boolean {
  return IPV4_RE.test(v) && v.split('.').map(Number).join('.') === v;
}

export function formatInvite(i: A2aInvite): string {
  const alt = i.alt && i.alt.length > 0 ? `&alt=${i.alt.join(',')}` : '';
  return `wmux-a2a://${i.host}:${i.port}/${i.code}#sha256=${i.fingerprint256}${alt}`;
}

export function parseInvite(raw: unknown): { ok: true; invite: A2aInvite } | { ok: false; error: InviteParseError } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'empty' };
  // Structure only: field boundaries, so each field below reports its OWN
  // error. The optional `&alt=` extension is captured; anything else after
  // the fingerprint must start with '&' (reserved for fragment extensions)
  // and is not interpreted here.
  const m = /^wmux-a2a:\/\/([^/:#?\s]*):([^/#?\s]*)\/([^/#?\s]*)#sha256=([^&\s]*)(?:&alt=([^&\s]*))?(?:&\S*)?$/.exec(raw.trim());
  if (!m) return { ok: false, error: raw.trim().startsWith(INVITE_SCHEME) ? 'host' : 'scheme' };
  const [, host, portStr, code, fpRaw, altRaw] = m;
  if (!HOSTNAME_RE.test(host) && !IPV4_RE.test(host)) return { ok: false, error: 'host' };
  // Digits only: `Number` would also accept '0x1f', '1e3' and ' 80'.
  const port = /^\d{1,5}$/.test(portStr) ? Number(portStr) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'port' };
  if (!INVITE_CODE_RE.test(code)) return { ok: false, error: 'code' };
  const fingerprint256 = normalizeFingerprint256(fpRaw);
  if (!fingerprint256) return { ok: false, error: 'fingerprint' };
  if (altRaw === undefined) return { ok: true, invite: { host, port, code, fingerprint256 } };
  const alt = altRaw.split(',');
  if (alt.length > INVITE_ALT_MAX || !alt.every(isCanonicalIpv4)) return { ok: false, error: 'alt' };
  return { ok: true, invite: { host, port, code, fingerprint256, alt } };
}

/** `POST /api/a2a/pair` body. The joiner reports its own identity. */
export interface A2aPairRequest {
  code: string;
  /** The joiner's own HostId. */
  hostId: HostId;
  /** The joiner's display name. */
  name: string;
  protocol: number;
}

/**
 * `POST /api/a2a/pair` success. Carries a PEER credential and nothing else —
 * never an operator token or a device credential.
 */
export interface A2aPairResponse {
  /** `formatPeerCredential` form. */
  credential: string;
  /** The server's HostId. */
  hostId: HostId;
  name: string;
  protocol: number;
}

/**
 * Why a pairing was refused (`reason` on a non-200 `/api/a2a/pair` answer),
 * so the joiner can tell the user what to do next.
 */
export type A2aPairRefusal =
  /** No invite is open, or it ran out of time or attempts. */
  | 'expired'
  /** The code does not match the open invite. */
  | 'invalid-code'
  /** The joiner presented this server's own hostId. */
  | 'self'
  /** Too many failed pairings from this address; wait and retry (HTTP 429). */
  | 'rate-limited';

// ─── Persisted records ──────────────────────────────────────────────────────

/** Server side: a joiner this host issued a peer credential to. Own file, NOT DeviceStore. */
export interface A2aPeerRecordV1 {
  v: 1;
  peerId: string;
  /** The joiner's own HostId, reported at pairing; display + link binding only. */
  hostId: HostId;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/**
 * Joiner side: a server host this machine paired with. The credential secret
 * is stored next to it under the same owner-only protection as other wmux
 * secrets — never in this record's display projection.
 */
export interface A2aRemoteHostRecordV1 {
  v: 1;
  hostId: HostId;
  name: string;
  /** Addresses to try in order: machine name first, then the last known IPv4s. */
  addresses: string[];
  port: number;
  fingerprint256: CertFingerprint256;
  peerId: string;
  createdAt: string;
  lastSeenAt?: string;
}

/** Layer 2: what this host exposes to one paired host. Absent = nothing. */
export interface A2aExposureV1 {
  v: 1;
  hostId: HostId;
  /** Workspace ids visible to that host. A pane is visible iff its workspace is AND it is listed (or panes is absent). */
  workspaceIds: string[];
  /** Optional per-workspace pane allow-list; absent key = every pane of that workspace. */
  paneIds?: Record<string, string[]>;
  /** This host's Moa (brain end) is visible to that host. Absent = false. */
  brain?: boolean;
  updatedAt: string;
}

/**
 * What a link end is. `pane`: one workspace pane (`paneId` required).
 * `brain`: the host's Moa — the HQ workspace's orchestrator brain, which is
 * not a pane of any tree, so it has NO `paneId` (the field is absent, never
 * empty); `workspaceId` is the HQ workspace's id.
 *
 * Remote pairs (`isAllowedEndpointPair`): pane<->pane and brain<->brain only.
 * brain<->pane is refused in v1: Moa may not hand work straight to another
 * workspace's agent (locally that needs the owner's hand-off card), and no
 * policy exists yet for a remote agent writing to Moa.
 */
export type A2aEndpointKind = 'pane' | 'brain';

export const A2A_ENDPOINT_KINDS: readonly A2aEndpointKind[] = Object.freeze(['pane', 'brain']);

/** One link end as stored and as sent. */
export interface A2aEndpoint {
  kind: A2aEndpointKind;
  workspaceId: string;
  /** Present iff `kind` is 'pane'. */
  paneId?: string;
}

/** `kind` is known and `paneId` matches it: required (non-empty) for a pane, absent for a brain. */
export function isConsistentEndpoint(e: { kind?: unknown; paneId?: unknown }): boolean {
  if (e.kind === 'pane') return typeof e.paneId === 'string' && e.paneId.length > 0;
  if (e.kind === 'brain') return e.paneId === undefined;
  return false;
}

/** May these two kinds be linked across hosts? Only like with like (see A2aEndpointKind). */
export function isAllowedEndpointPair(a: A2aEndpointKind, b: A2aEndpointKind): boolean {
  return (a === 'pane' && b === 'pane') || (a === 'brain' && b === 'brain');
}

/** Display name of a host's Moa in aliases. */
export const A2A_BRAIN_ALIAS = 'Moa';

/**
 * A remote end's alias: `<PC>/<workspace>/<pane>` for a pane, `<PC>/Moa` for
 * a brain. Names fall back to ids.
 */
export function a2aEndpointAlias(
  pcName: string,
  end: { kind: A2aEndpointKind; workspaceId: string; paneId?: string; workspaceName?: string; label?: string },
): string {
  if (end.kind === 'brain') return `${pcName}/${A2A_BRAIN_ALIAS}`;
  return [pcName, end.workspaceName ?? end.workspaceId, end.label ?? end.paneId ?? ''].join('/');
}

export type A2aLinkState =
  /** Proposed by this side, awaiting the other side's human. */
  | 'proposed-out'
  /** Proposed by the other side, awaiting OUR human. */
  | 'proposed-in'
  | 'active'
  /** Either side revoked. Terminal. */
  | 'revoked'
  /** A bound pane/workspace disappeared or moved. Terminal; re-match to resume. */
  | 'broken';

/**
 * Layer 3: one pane <-> one pane. Each host stores the link from ITS OWN
 * perspective (`local` / `remote`), so neither side has to agree on an A/B
 * ordering. The link binds paneId (stable across app restarts); each task
 * re-checks the pane's occupant by ptyId at delivery time.
 */
export interface A2aLinkRecordV1 {
  v: 1;
  linkId: string;
  /** Bumped on every accepted change; a message naming an older version is refused. */
  version: number;
  state: A2aLinkState;
  /** This host's end. A brain end has no `paneId` (isConsistentEndpoint). */
  local: { kind: A2aEndpointKind; workspaceId: string; paneId?: string };
  remote: {
    hostId: HostId;
    kind: A2aEndpointKind;
    workspaceId: string;
    paneId?: string;
    label?: string;
    /** Display only, for the `<PC>/<workspace>/<pane>` alias. */
    workspaceName?: string;
    /** Display only: the pane's normalized `host/owner/repo` key, never a raw remote URL. */
    gitRemote?: string;
  };
  allow: {
    /** This side may start new tasks toward the remote pane. */
    outbound: boolean;
    /** The remote pane may start new tasks toward this side. Replies to our own tasks are always allowed. */
    inbound: boolean;
  };
  createdAt: string;
  updatedAt: string;
  /** Why the link ended, for 'revoked' / 'broken'. */
  endedReason?: 'revoked-local' | 'revoked-remote' | 'pane-closed' | 'pane-moved' | 'workspace-gone' | 'exposure-revoked';
  /**
   * Which side proposed it: 'remote' means this host is the SERVER of the
   * pair for this link (it received the proposal and its human accepts);
   * 'local' means this host is the joiner. Exposure applies to 'remote' links.
   */
  proposer: 'local' | 'remote';
}

// ─── Layer 2/3 wire ─────────────────────────────────────────────────────────

export interface A2aHelloResponse {
  protocol: number;
  hostId: HostId;
  name: string;
}

/**
 * One exposed end, enough for a human to pick the RIGHT one. A `brain` entry
 * is the host's Moa: `workspaceId` is its HQ workspace, there is no `paneId`,
 * and only the name fields apply.
 */
export interface A2aExposedPane {
  kind: A2aEndpointKind;
  workspaceId: string;
  workspaceName: string;
  /** Present iff `kind` is 'pane'. */
  paneId?: string;
  label?: string;
  /** e.g. 'claude' | 'codex' | 'shell' — display only. */
  agent?: string;
  cwd?: string;
  gitRemote?: string;
  gitBranch?: string;
}

export interface A2aExposedResponse {
  panes: A2aExposedPane[];
}

export interface A2aLinkProposeRequest {
  /** Minted by the proposer; the receiver refuses a duplicate id. */
  linkId: string;
  /**
   * Proposer's pane (the receiver stores it as `remote`). The names and the
   * repo key are display-only, sanitized and bounded by the receiver.
   */
  from: { kind: A2aEndpointKind; workspaceId: string; paneId?: string; label?: string; workspaceName?: string; gitRemote?: string };
  /**
   * Receiver's end (must be exposed to the proposer; a brain end must be the
   * receiver's current HQ). The two kinds must pass isAllowedEndpointPair.
   */
  to: { kind: A2aEndpointKind; workspaceId: string; paneId?: string };
  /** Directions from the PROPOSER's point of view. */
  allow: { outbound: boolean; inbound: boolean };
}

export interface A2aLinkProposeResponse {
  linkId: string;
  state: 'proposed-in';
}

/** `GET /api/a2a/links/:linkId` — the link from the SERVER's perspective. */
export interface A2aLinkStatusResponse {
  linkId: string;
  state: A2aLinkState;
  version: number;
  endedReason?: A2aLinkRecordV1['endedReason'];
}

/**
 * `/api/a2a/links/:linkId` — the per-link path. GET answers the link's state as
 * the SERVER sees it (A2aLinkStatusResponse): the joiner polls it ("refresh")
 * until the server's stream carries the accept notice. `+ linkRevokeSuffix`
 * is the joiner's revoke.
 */
export function a2aLinkPath(linkId: string): string {
  return `${A2A_ROUTES.links}/${encodeURIComponent(linkId)}`;
}

// ─── Layer 4 wire ───────────────────────────────────────────────────────────

export type A2aRemoteMessageKind =
  /** Start a new task on the receiver's linked pane. Needs the direction allowed. */
  | 'task'
  /** A reply into an existing task (either side). */
  | 'reply'
  /** A task state transition. */
  | 'state'
  /** Link lifecycle notice (accept / revoke / broken) — no task. */
  | 'link'
  /** The receiver's acknowledgement of a task it got: handed over, or read. Never a state change. */
  | 'receipt';

export const A2A_REMOTE_MESSAGE_KINDS: readonly A2aRemoteMessageKind[] = Object.freeze(['task', 'reply', 'state', 'link', 'receipt']);

/** How far the receiver got with a task: handed to its agent (or Moa), or read by it. */
export type A2aRemoteReceipt = 'delivered' | 'read';

export function isA2aRemoteMessageKind(v: unknown): v is A2aRemoteMessageKind {
  return typeof v === 'string' && (A2A_REMOTE_MESSAGE_KINDS as readonly string[]).includes(v);
}

/** Text body cap per message (bytes, UTF-8). */
export const A2A_REMOTE_BODY_MAX = 32 * 1024;

/**
 * One message in either direction. The idempotency key is (linkId, messageId):
 * the same key with a byte-identical payload is a duplicate (answered as one);
 * the same key with a different payload is REFUSED (`conflict`).
 *
 * Deliberately absent: any `from` workspace/pane. The receiver derives the
 * sender from its link record.
 */
export interface A2aRemoteEnvelope {
  protocol: number;
  linkId: string;
  linkVersion: number;
  /** Sender-minted, unique per link. */
  messageId: string;
  kind: A2aRemoteMessageKind;
  /** For 'reply' / 'state': the task this belongs to (the deterministic remote task id). */
  taskId?: string;
  /** For 'task' / 'reply'. */
  text?: string;
  /** For 'state'. */
  state?: TaskState;
  /** For 'link'. */
  link?: { state: 'active' | 'revoked' | 'broken'; version: number; reason?: A2aLinkRecordV1['endedReason'] };
  /** For 'receipt' (with `taskId`). */
  receipt?: A2aRemoteReceipt;
  sentAt: string;
}

export type A2aRemoteErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'unknown-link'
  | 'link-not-active'
  | 'stale-link-version'
  | 'direction-not-allowed'
  | 'unknown-task'
  | 'conflict'
  | 'too-large'
  | 'bad-request'
  | 'protocol'
  | 'unavailable';

export type A2aRemoteDeliverResponse =
  | { ok: true; taskId?: string; duplicate: boolean }
  | { ok: false; error: A2aRemoteErrorCode; message?: string };

/**
 * Stream cursor. `epoch` belongs to the server's durable OUTBOX store (not the
 * daemon process), so a daemon restart resumes rather than replays from zero.
 */
export interface A2aStreamCursor {
  epoch: string;
  seq: number;
}

/** One SSE `data:` payload on `/api/a2a/stream`. */
export interface A2aStreamEvent {
  cursor: A2aStreamCursor;
  envelope: A2aRemoteEnvelope;
}

export interface A2aStreamAck {
  cursor: A2aStreamCursor;
}

// ─── Outbox (both sides) ────────────────────────────────────────────────────

export type A2aOutboxState =
  | 'pending'
  /** Written to the socket but no answer — never blindly re-run; resend is idempotent by key. */
  | 'outcome-unknown'
  | 'acked'
  /** Refused by the peer with a terminal error code. */
  | 'refused';

export interface A2aOutboxRecordV1 {
  v: 1;
  epoch: string;
  seq: number;
  hostId: HostId;
  envelope: A2aRemoteEnvelope;
  state: A2aOutboxState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: A2aRemoteErrorCode;
}

// ─── Ledger marker ──────────────────────────────────────────────────────────

/**
 * Stored under `Task.metadata.remote` for a task that crossed hosts. Its
 * presence is what (a) forbids worker spawn, (b) turns an occupant change into
 * a HOLD instead of a sibling-pane downgrade, and (c) lets main re-pull
 * undelivered remote tasks after a reconnect.
 */
export interface A2aRemoteTaskMarkerV1 {
  v: 1;
  linkId: string;
  hostId: HostId;
  messageId: string;
  direction: 'inbound' | 'outbound';
  /** Inbound only: false until main confirms the gated delivery. */
  delivered?: boolean;
  /**
   * Why delivery is held. `brain-unavailable`: the work is for this PC's Moa,
   * which cannot take it right now (Moa off, no HQ, or not started); it is
   * delivered as soon as Moa can.
   */
  held?:
    | 'occupant-changed'
    | 'pane-missing'
    | 'link-not-active'
    | 'brain-delivery-pending'
    | 'brain-unavailable'
    /** A paste was attempted but never confirmed (main restarted mid-delivery): a person decides. */
    | 'delivery-unconfirmed'
    /** The pane kept having no agent to deliver to. */
    | 'no-agent';
  /**
   * This side's link endpoint kind when the task was stored. `brain` = the
   * task is this PC's Moa's, delivered as a wake, never to a pane. Absent on a
   * task stored before it was recorded (treated as a pane task).
   */
  kind?: A2aEndpointKind;
}

/**
 * A message id the peer chose. It ends up in task ids, ledger keys and the
 * text that wakes Moa, so only a plain token is accepted.
 */
export const A2A_REMOTE_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const A2A_REMOTE_TASK_ID_PREFIX = 'rt-';

/**
 * The deterministic task id is `rt-` + the first 32 hex chars of
 * SHA-256(linkId + '\0' + messageId). Computed daemon-side (node:crypto);
 * this predicate only recognizes the shape.
 */
export function isRemoteTaskId(v: unknown): v is string {
  return typeof v === 'string' && /^rt-[0-9a-f]{32}$/.test(v);
}
