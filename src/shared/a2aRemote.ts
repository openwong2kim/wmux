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
//     pane (a sibling may not be exposed). Starting a new agent is a separate,
//     owner-gated request (`shared/a2aSpawn.ts`), never a task.
//   - Every persisted record carries `v` so a downgrade or a future colleague
//     tier can tell formats apart.
//
// Pure module: no node:* imports (the renderer imports these types).

import type { CompletionEvidence, TaskState } from './types';
import type { A2aSpawnRequestV1, A2aSpawnResultV1, A2aSpawnTargetsV1 } from './a2aSpawn';
import type { A2aContinueLinkState, A2aContinueManifestV1, A2aContinueRequestV1, A2aContinueResultV1, A2aContinueStatusQueryV1 } from './a2aContinue';
import type { A2aBundleAskV1, A2aBundleLinkState, A2aBundleMadeV1 } from './a2aBundle';

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
  /** POST — the joiner declines a share offer. Path: /api/a2a/offers/:offerId/decline */
  offers: '/api/a2a/offers',
  offerDeclineSuffix: '/decline',
  /**
   * Image bytes of a message (`images.1`), by SHA-256: `PUT` — the joiner
   * uploads one before posting the envelope that names it; `GET` — the joiner
   * fetches one the server's stream named. Path: /api/a2a/blobs/:sha256
   */
  blobs: '/api/a2a/blobs',
  /**
   * One file of a conversation another PC continues (continue), by its
   * SHA-256 in the request's manifest: `PUT` — A uploads it to B when B is
   * the server; `HEAD` — whether B holds it already; `GET` — B, the joiner,
   * fetches it from A. Path: /api/a2a/continue/:continueId/:sha256
   */
  continue: '/api/a2a/continue',
  /**
   * A git bundle a PC made of the work an agent did there for this one
   * (bring-back), by its id: `GET` — the asking PC, the joiner, fetches it
   * from the PC that made it. Path: /api/a2a/bundle/:bundleId
   */
  bundle: '/api/a2a/bundle',
  /**
   * Tailnet discovery, answered only while this PC is discoverable and only
   * to a same-user tailnet node; otherwise every route answers exactly as an
   * unauthenticated request does. `GET` — the probe (A2aDiscoverProbe).
   * Below it: `POST /requests`, `POST /requests/:id/reveal`,
   * `GET /requests/:id` and `POST /requests/:id/withdraw`.
   */
  discover: '/api/a2a/discover',
} as const);

/**
 * Default port of the dedicated A2A listener. Clear of the web server (7681)
 * and LanLink (45651) defaults; the operator can change it in Settings.
 */
export const A2A_REMOTE_DEFAULT_PORT = 45660;

/**
 * Optional features a build understands, advertised by the joiner on every
 * `GET /api/a2a/stream` (comma-separated tokens). Additive: an older server
 * ignores the header, an older joiner sends none, and the protocol number
 * stays the same.
 */
export const A2A_FEATURES_HEADER = 'x-wmux-a2a-features';
/** The joiner shows and accepts share offers (`link.state: 'offer'`). */
export const A2A_FEATURE_LINK_OFFER = 'link-offer.1';
/**
 * The PC takes images on `task` / `reply` envelopes (`A2aRemoteEnvelope.images`)
 * and serves the blob routes. A sender whose peer lacks it sends the text with
 * an omitted-images note instead: an older receiver would drop the refs unseen.
 */
export const A2A_FEATURE_IMAGES = 'images.1';
/**
 * The PC takes remote spawn requests (`shared/a2aSpawn.ts`). A requester sends
 * one only to a PC that advertises it.
 */
export const A2A_FEATURE_SPAWN = 'spawn.1';
/**
 * The PC reads `agent-signed-out` in a spawn result. A PC that would start
 * an agent whose sign-in it knows to be gone sends that code only to a PC
 * that advertises it; any other gets `failed`, which it reads today (an
 * unknown code is dropped, and the request would wait until it expires).
 */
export const A2A_FEATURE_SPAWN_SIGNED_OUT = 'spawn-signed-out.1';
/**
 * The PC reads `originKeyHash` on the roots of spawn targets
 * (A2aSpawnTargetsV1). A PC adds it only for a PC that advertises this: an
 * older PC's reader refuses a targets message with any key it does not know.
 */
export const A2A_FEATURE_SPAWN_ROOT_HASH = 'spawn-root-hash.1';
/**
 * The PC takes a Claude conversation another PC continues here
 * (`shared/a2aContinue.ts`). A requester sends one only to a PC that
 * advertises it.
 */
export const A2A_FEATURE_CONTINUE = 'continue.1';
/**
 * The PC hands back, as a git bundle, the work an agent it started for
 * another PC did (`shared/a2aBundle.ts`). Not advertised yet.
 */
export const A2A_FEATURE_BUNDLE = 'bundle.1';
/**
 * The PC follows a task again after it ended `completed`, when its sender
 * writes to it: the receiver sets it `working` again, and the sender takes
 * that `working` for the follow-up it sent. Each side does so only with a
 * peer that advertises it.
 */
export const A2A_FEATURE_REOPEN = 'reopen.1';
/**
 * A server that takes a refusal on the stream ack. A joiner that refuses a
 * record the server streamed it sends the refusal with the ack of that record
 * (`A2aStreamAck.refused`), only to a server whose hello lists this, and the
 * server ends what the record was about as when its own POST is refused.
 */
export const A2A_FEATURE_STREAM_REFUSE = 'stream-refuse.1';
/**
 * Stream liveness both ways. A joiner with it acks its stream cursor every
 * `A2A_STREAM_PING_MS` while the stream is up (to a server whose hello lists
 * it); a server whose joiner advertised it ends that stream after
 * `A2A_STREAM_SILENCE_MS` with no request from the joiner. Without it a joiner
 * that vanished without closing its socket (sleep, Wi-Fi off) stayed
 * "connected" on the server until TCP gave up, which takes minutes.
 */
export const A2A_FEATURE_STREAM_PING = 'stream-ping.1';
/**
 * The PC takes a worker's status on a task it sent (`kind: 'status'`,
 * `A2aRemoteStatusV1`). A receiver sends one only to a PC that advertises it:
 * an older one would refuse the kind.
 */
export const A2A_FEATURE_STATUS = 'status.1';
/**
 * The PC takes a host's notice on a `reply` envelope (`A2aRemoteEnvelope.notice`):
 * one of its own messages was held on the other PC and has now been dropped
 * there, the task left open. A host sends one only to a PC that advertises it:
 * an older one would take it as a plain reply (and a headless one with
 * follow-ups on `ask` would end the task on it).
 */
export const A2A_FEATURE_HELD_NOTICE = 'held-notice.1';
/**
 * The PC takes an answer to the question its worker shows (`kind: 'answer'`,
 * `A2aRemoteAnswerV1`), and says how it went in the task's status
 * (`detail.answers`). An asker sends one only to a PC that advertises it: an
 * older one would refuse the kind.
 */
export const A2A_FEATURE_ANSWER = 'answer.1';
/**
 * The PC takes an allow or deny for a permission prompt on a task the other PC
 * sent (`kind: 'approval'`, `A2aRemoteApprovalV1`), and offers such prompts in
 * the task's status (`detail.approval`). Advertised to a PC only while this
 * PC's approvals setting is on for it (`wmux remote approvals`).
 */
export const A2A_FEATURE_APPROVAL = 'approval.1';
/**
 * What a PC whose approvals setting is on sees of a permission prompt
 * (`a2a-remote-approvals.json`): `tool-only` (tool name, prompt id and flags;
 * deny only) or `command` (also the bound call's command text; allow possible).
 */
export type A2aApprovalExposure = 'tool-only' | 'command';
export function isA2aApprovalExposure(v: unknown): v is A2aApprovalExposure {
  return v === 'tool-only' || v === 'command';
}
/**
 * This PC's approvals setting (`wmux remote approvals`): `get` →
 * `{ hosts: { [hostId]: exposure }, damaged }`; `set` `{ hostId, exposure: 'off' | A2aApprovalExposure }`
 * → `{ ok, hosts } | { ok: false, error }`.
 */
export const A2A_APPROVALS_RPC = Object.freeze({
  get: 'a2a.remote.approvals.get',
  set: 'a2a.remote.approvals.set',
} as const);
/** A host's notice about one message the receiver sent (`held-notice.1`). Nothing in it is shown as written. */
export interface A2aRemoteNoticeV1 {
  kind: 'held-expired';
  /** The receiver's own message that was dropped. */
  messageId: string;
  /** When the host dropped it. */
  sentAt: string;
  /** A paste of it was started there and never confirmed: it may have reached the pane. */
  unconfirmed?: true;
}
const NOTICE_KINDS: ReadonlySet<string> = new Set(['held-expired']);
/** Strict: a known kind, a message id, an ISO time; anything else is dropped. Null: not a notice. */
export function parseA2aRemoteNotice(raw: unknown): A2aRemoteNoticeV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  const messageId = r['messageId'];
  const sentAt = r['sentAt'];
  if (typeof kind !== 'string' || !NOTICE_KINDS.has(kind)) return null;
  if (typeof messageId !== 'string' || !A2A_REMOTE_MESSAGE_ID_RE.test(messageId)) return null;
  if (typeof sentAt !== 'string' || sentAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(sentAt) || Number.isNaN(Date.parse(sentAt))) return null;
  const unconfirmed = r['unconfirmed'];
  if (unconfirmed !== undefined && unconfirmed !== true) return null;
  return { kind: 'held-expired', messageId, sentAt: new Date(Date.parse(sentAt)).toISOString(), ...(unconfirmed ? { unconfirmed: true as const } : {}) };
}
/** Whether a menu's labels leave this PC in a worker's status, or only how many there are. */
export type A2aStatusLabels = 'send' | 'keep';
export function isA2aStatusLabels(v: unknown): v is A2aStatusLabels {
  return v === 'send' || v === 'keep';
}
/** This PC's own setting (`wmux remote status-labels`): `get` → `{ labels }`; `set` `{ labels }` → `{ ok, labels } | { ok: false, error }`. */
export const A2A_STATUS_LABELS_RPC = Object.freeze({
  get: 'a2a.remote.statusLabels.get',
  set: 'a2a.remote.statusLabels.set',
} as const);
/**
 * Whether this PC types another PC's answer into a headless worker's question
 * (`wmux remote answers`): `on`, `off`, or `default` (no setting: on where
 * follow-ups go straight to the agent, off where they wait for a person).
 */
export type A2aAnswersSetting = 'on' | 'off' | 'default';
export function isA2aAnswersSetting(v: unknown): v is A2aAnswersSetting {
  return v === 'on' || v === 'off' || v === 'default';
}
/**
 * Answers to a worker's question (`A2A_FEATURE_ANSWER`):
 *   - `ask`: the CLI's pipe method on the asking PC (local origin; main checks
 *     the caller is a pane and passes its workspace on);
 *   - `send`: the daemon's, `{ taskId, workspaceId, pickerId, option }` → `{ ok, taskId, messageId }`;
 *   - `get` / `set`: this PC's own setting, `{ answers, damaged, effective }` / `{ answers }`.
 */
export const A2A_ANSWER_RPC = Object.freeze({
  ask: 'a2a.remote.answer',
  send: 'a2a.remote.answer.send',
  get: 'a2a.remote.answers.get',
  set: 'a2a.remote.answers.set',
} as const);
export const A2A_STREAM_PING_MS = 15_000;
/** No sign of the other end for this long ends a stream, on either side. */
export const A2A_STREAM_SILENCE_MS = 40_000;
/** The joiner's first stream redial waits this long; each next one doubles it. */
export const A2A_REDIAL_BACKOFF_MIN_MS = 1_000;
const FEATURE_RE = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const FEATURES_MAX = 16;

/** Parse a features header value; malformed tokens are dropped. */
export function parseA2aFeatures(raw: unknown): string[] {
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof value !== 'string' || value.length > 1024) return [];
  const out: string[] = [];
  for (const token of value.split(',')) {
    const t = token.trim().toLowerCase();
    if (FEATURE_RE.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= FEATURES_MAX) break;
  }
  return out;
}

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

/** A one-shot pairing code: 8 symbols of the unambiguous A-Z2-9 alphabet (`pairing.ts`). */
export const INVITE_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export type InviteParseError = 'empty' | 'scheme' | 'host' | 'port' | 'code' | 'fingerprint' | 'alt';

/** Canonical dotted-quad IPv4 (no leading zeros). */
export function isCanonicalIpv4(v: string): boolean {
  return IPV4_RE.test(v) && v.split('.').map(Number).join('.') === v;
}

/**
 * 100.64.0.0/10: carrier-grade NAT, and the range Tailscale assigns tailnet
 * addresses from. The range alone does not make a tailnet address; the
 * listener also checks that it sits on a Tailscale adapter.
 */
export function isTailnetIpv4(v: string): boolean {
  if (!IPV4_RE.test(v)) return false;
  const [a, b] = v.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
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

// ─── Tailnet discovery ──────────────────────────────────────────────────────
//
// A PC made discoverable answers the routes under `A2A_ROUTES.discover` for
// 5 minutes, to its own user's tailnet nodes only. A requester commits to its
// nonce Nr, learns the server's nonce Ns, then reveals Nr; both PCs derive the
// same 6-digit code from the two nonces and both certificate fingerprints, and
// the server's human allows. Allow hands the requester a one-shot pairing
// code, redeemed on `POST /api/a2a/pair` like an invite's.

/** Header carrying a discovery request's token on its `:id` routes. */
export const A2A_DISCOVER_TOKEN_HEADER = 'x-wmux-discover-token';
/** Cap on the self-reported name in a discovery request. */
export const A2A_DISCOVER_NAME_MAX = 64;
/** Cap on a discovery route's request body. */
export const A2A_DISCOVER_BODY_MAX = 2048;

/** `GET /api/a2a/discover`: exactly these four keys. */
export interface A2aDiscoverProbe {
  discover: 1;
  protocol: number;
  /** The server's machine name. */
  name: string;
  /** The server's wmux version. */
  version: string;
}

/** `POST /api/a2a/discover/requests` body. */
export interface A2aDiscoverRequestBody {
  protocol: number;
  /** The requester's own HostId. */
  hostId: HostId;
  /** The requester's display name, at most `A2A_DISCOVER_NAME_MAX` characters. */
  name: string;
  /** The requester's own certificate fingerprint (Fr), bound into the code. */
  fingerprint256: CertFingerprint256;
  /** base64url SHA-256 of the commit label and the requester's nonce Nr. */
  commit: string;
}

/** `201` answer to `POST /api/a2a/discover/requests`. */
export interface A2aDiscoverRequestCreated {
  /** UUID. */
  requestId: string;
  /** 32 random bytes, base64url: the `A2A_DISCOVER_TOKEN_HEADER` of every later call. */
  token: string;
  /** The server's nonce Ns, 32 random bytes, base64url. */
  nonce: string;
  /** Epoch ms by which the reveal must arrive. */
  expiresAt: number;
}

/** `reason` on a refused discovery request (`403`, or `429` for busy and rate-limited). */
export type A2aDiscoverRefusal =
  /** Tailscale could not identify the requester as a node that may pair. */
  | 'unidentified'
  /** The requester belongs to another Tailscale user. */
  | 'other-user'
  /** This PC's human denied a request from that address in this window. */
  | 'denied'
  /** The request came from this PC itself. */
  | 'self'
  /** Another request is on the card; retry after `retryAfterMs`. */
  | 'busy'
  /** Too many requests from that address; retry after `retryAfterMs` (or not in this window). */
  | 'rate-limited'
  /** The revealed nonce does not match the commit; the request is over. */
  | 'commit-mismatch';

/** `POST /api/a2a/discover/requests/:id/reveal` body. */
export interface A2aDiscoverRevealBody {
  /** The requester's nonce Nr, base64url. */
  nonce: string;
}

/** `200` answer to the reveal: the card is up until `expiresAt`. */
export interface A2aDiscoverRevealResponse {
  expiresAt: number;
}

/** A request's state as the requester polls it. */
export type A2aDiscoverRequestState = 'waiting' | 'allowed' | 'denied' | 'expired' | 'closed';

/** `GET /api/a2a/discover/requests/:id` answer. */
export interface A2aDiscoverPoll {
  state: A2aDiscoverRequestState;
  /** Epoch ms the current state runs out (the card, or the pairing code once allowed). */
  expiresAt: number;
  /** Only when `allowed`: the one-shot pairing code to redeem on `/api/a2a/pair`. */
  code?: string;
  /** For `closed`: the requester withdrew, or the pairing failed on the server. */
  reason?: 'withdrawn' | 'failed';
}

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
  /**
   * A link a remote spawn made. No images go on it either way. With
   * `proposer: 'remote'` this PC started the agent: what goes out on it is
   * redacted and later tasks may wait for a card. With `proposer: 'local'`
   * this PC asked for it. Local bookkeeping, never sent; an older build drops it.
   */
  spawned?: true;
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
   * The receiver's share offer this proposal answers. The receiver accepts at
   * once when the proposal fits the offer (its end, a subset of its
   * directions, still open). An older receiver ignores the field and takes it
   * as an ordinary proposal for its human.
   */
  offerId?: string;
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
  /** 'active' only for a proposal that answered an open offer. */
  state: 'proposed-in' | 'active';
  /** The link's version on the receiver (present with 'active'). */
  version?: number;
  /**
   * With 'proposed-in': the receiver took the offer but could not finish the
   * link yet; the same proposal sent again finishes it. An older receiver
   * never sets it (its human accepts).
   */
  offerClaimed?: boolean;
}

/** `409 offer-closed` answer: why the offer can no longer be taken. */
export interface A2aOfferClosedResponse {
  ok: false;
  error: 'offer-closed';
  reason: A2aOfferEndReason;
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
  | 'receipt'
  /** What the receiver's worker is doing on a task (`A2aRemoteStatusV1`). Never a reply, never a state change. */
  | 'status'
  /** The sender's answer to the question the receiver's worker shows (`A2aRemoteAnswerV1`). Never a reply, never a state change. */
  | 'answer'
  /** The sender's allow or deny for a permission prompt the receiver offered (`A2aRemoteApprovalV1`). Never a reply, never a state change. */
  | 'approval';

export const A2A_REMOTE_MESSAGE_KINDS: readonly A2aRemoteMessageKind[] = Object.freeze(['task', 'reply', 'state', 'link', 'receipt', 'status', 'answer', 'approval']);

/** How far the receiver got with a task: handed to its agent (or Moa), or read by it. */
export type A2aRemoteReceipt = 'delivered' | 'read';

/**
 * What the worker on the receiving PC is doing on a task:
 *   - `working`: in a turn (also while it waits on background work it started);
 *   - `waiting-input`: its turn ended and the task waits for more;
 *   - `question`: a question on its screen nobody there answers (`detail.question` says which);
 *   - `usage-limit`: held at its provider's usage limit (`detail.resetsAt` once known);
 *   - `gone`: the agent is no longer running.
 */
export type A2aRemoteStatusKind = 'working' | 'waiting-input' | 'question' | 'usage-limit' | 'gone';
export const A2A_REMOTE_STATUS_KINDS: readonly A2aRemoteStatusKind[] = Object.freeze(['working', 'waiting-input', 'question', 'usage-limit', 'gone']);
/** Which question: as daemon/approvals/screenQuestion.ts reads the screen. */
export type A2aRemoteQuestionKind = 'permission' | 'plan' | 'menu' | 'dialog' | 'trust';
const QUESTION_KINDS: readonly string[] = ['permission', 'plan', 'menu', 'dialog', 'trust'];

/** Caps of a status's detail. Over them, options are cut (labels) or left off (count). */
export const A2A_REMOTE_STATUS_LIMITS = Object.freeze({
  OPTIONS_MAX: 9,
  OPTION_CHARS_MAX: 80,
});
/** A provider is a slug (`claude`), never free text. */
const STATUS_PROVIDER_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** A menu id is the agent's tool call id (`toolu_…`): an id, never free text. */
const STATUS_MENU_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A picker id: 16 hex characters of a sha256. */
export const A2A_REMOTE_PICKER_ID_RE = /^[0-9a-f]{16}$/;
/** Answer outcomes a status carries. */
export const ANSWER_OUTCOMES_MAX = 4;

/** The sender's answer to the one-question picker its worker shows: the option's number, 1-based. */
export interface A2aRemoteAnswerV1 {
  pickerId: string;
  option: number;
}

/** Strict: a picker id and an option 1..OPTIONS_MAX; null when it is not one. */
export function parseA2aRemoteAnswer(raw: unknown): A2aRemoteAnswerV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const { pickerId, option } = r;
  if (typeof pickerId !== 'string' || !A2A_REMOTE_PICKER_ID_RE.test(pickerId)) return null;
  if (typeof option !== 'number' || !Number.isInteger(option) || option < 1 || option > A2A_REMOTE_STATUS_LIMITS.OPTIONS_MAX) return null;
  return { pickerId, option };
}

/** Why an answer was not given. Each has fixed words (`A2A_REMOTE_ANSWER_REASON_TEXT`). */
export type A2aRemoteAnswerReason =
  | 'answers-off'
  | 'answers-damaged'
  | 'not-open'
  | 'no-agent'
  | 'not-headless'
  | 'no-picker'
  | 'picker-changed'
  | 'not-single-select'
  | 'option-out-of-range'
  | 'unreadable'
  | 'lock-busy'
  | 'typed-meanwhile'
  | 'unconfirmed';

/** What the asker should know, and what it can do next, for each reason. */
export const A2A_REMOTE_ANSWER_REASON_TEXT: Readonly<Record<A2aRemoteAnswerReason, string>> = Object.freeze({
  'answers-off': 'answers are off on that PC (wmux remote answers); ask a person there',
  'answers-damaged': 'answers are off on that PC because its answers setting file is damaged; a person there can set it again with wmux remote answers',
  'not-open': 'the task is no longer open there',
  'no-agent': 'the agent for this task is not running there',
  'not-headless': 'that PC answers only for an agent it started without a desktop (headless) for this PC; ask a person there',
  'no-picker': 'no question picker is on the agent\'s screen there now',
  'picker-changed': 'the question on the screen there is not the one answered; read the task\'s status again for its picker id',
  'not-single-select': 'the question there is not one single-choice question (several questions, several choices, or a layout this version does not answer); ask a person there',
  'option-out-of-range': 'that option number is not one of the question\'s choices',
  'unreadable': 'the screen there could not be read',
  'lock-busy': 'something else was typing into that pane; try again',
  'typed-meanwhile': 'the screen there changed while the answer was being typed; nothing was typed',
  'unconfirmed': 'the key was typed there but the screen did not confirm the answer; read the task\'s status before trying again',
});
const ANSWER_REASONS: ReadonlySet<string> = new Set(Object.keys(A2A_REMOTE_ANSWER_REASON_TEXT));

/** How one answer went on the worker's PC: the answer's message id, and the reason when it was not given. */
export interface A2aRemoteAnswerOutcome {
  messageId: string;
  outcome: 'answered' | 'not-answered';
  reason?: A2aRemoteAnswerReason;
}

function parseAnswerOutcome(raw: unknown): A2aRemoteAnswerOutcome | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.messageId !== 'string' || !A2A_REMOTE_MESSAGE_ID_RE.test(r.messageId)) return null;
  if (r.outcome === 'answered') return { messageId: r.messageId, outcome: 'answered' };
  if (r.outcome !== 'not-answered' || typeof r.reason !== 'string' || !ANSWER_REASONS.has(r.reason)) return null;
  return { messageId: r.messageId, outcome: 'not-answered', reason: r.reason as A2aRemoteAnswerReason };
}

/** A prompt id: 16 hex characters of a sha256 (the receiving PC's own record and dialog hash). */
export const A2A_REMOTE_PROMPT_ID_RE = /^[0-9a-f]{16}$/;
/** A tool name in a prompt offer: an identifier, never free text. */
const APPROVAL_TOOL_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
/** Bytes of a prompt's command text an offer carries at most (after redaction). */
export const A2A_REMOTE_APPROVAL_COMMAND_MAX = 2048;
export type A2aRemoteApprovalDecision = 'allow' | 'deny';

/** The sender's decision on one permission prompt the receiver offered (`detail.approval.promptId`). */
export interface A2aRemoteApprovalV1 {
  promptId: string;
  decision: A2aRemoteApprovalDecision;
}

/** Strict: a prompt id and `allow` or `deny`, nothing else; null when it is not one. */
export function parseA2aRemoteApproval(raw: unknown): A2aRemoteApprovalV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'promptId' && k !== 'decision')) return null;
  if (typeof r.promptId !== 'string' || !A2A_REMOTE_PROMPT_ID_RE.test(r.promptId)) return null;
  if (r.decision !== 'allow' && r.decision !== 'deny') return null;
  return { promptId: r.promptId, decision: r.decision };
}

/** A permission prompt offered to the PC that sent the task (`A2A_FEATURE_APPROVAL`). */
export interface A2aRemoteApprovalOffer {
  promptId: string;
  /** The tool the prompt is for (`Bash`, `ExitPlanMode`, …). */
  tool: string;
  /** The bound call's command (secrets redacted, at most A2A_REMOTE_APPROVAL_COMMAND_MAX bytes); only at exposure `command`. */
  command?: string;
  /** Redaction changed the command: allow is not offered. */
  redacted: boolean;
  /** The command was cut at the cap: allow is not offered. */
  cut: boolean;
  /** When the agent denies the prompt by itself (ISO), when it draws that countdown. */
  autoDenyAt?: string;
  /** What the receiving PC takes for it: `['allow', 'deny']` or `['deny']`. */
  allowed: A2aRemoteApprovalDecision[];
}

/** Why an approval was not carried out. Each has fixed words (`A2A_REMOTE_APPROVAL_REASON_TEXT`). */
export type A2aRemoteApprovalReason =
  | 'approvals-off'
  | 'not-open'
  | 'link-not-active'
  | 'not-offered'
  | 'turn-unproven'
  | 'chain-broken'
  | 'unbound'
  | 'unsupported-tool'
  | 'deny-only'
  | 'lock-busy'
  | 'refused'
  | 'id-reused'
  | 'unavailable';

export const A2A_REMOTE_APPROVAL_REASON_TEXT: Readonly<Record<A2aRemoteApprovalReason, string>> = Object.freeze({
  'approvals-off': 'approvals for this PC are off there (wmux remote approvals); ask a person there',
  'not-open': 'the task is no longer open there',
  'link-not-active': 'the link to that pane is not active',
  'not-offered': 'that prompt is not one that PC offered, or it is gone; read the task\'s status again',
  'turn-unproven': 'that PC could not prove the prompt belongs to this task\'s turn; ask a person there',
  'chain-broken': 'the pane there took other input since this task was submitted; approvals for this task are answered there now',
  'unbound': 'the prompt there could not be tied to the agent\'s call; ask a person there',
  'unsupported-tool': 'that PC does not answer prompts for this tool from another PC',
  'deny-only': 'that PC takes only deny for this prompt',
  'lock-busy': 'something else was typing into that pane; try again',
  'refused': 'the prompt on the screen there changed or could not be proven; nothing was typed',
  'id-reused': 'that message id was already used for another decision',
  'unavailable': 'that PC could not record the decision; nothing was typed',
});
const APPROVAL_REASONS: ReadonlySet<string> = new Set(Object.keys(A2A_REMOTE_APPROVAL_REASON_TEXT));

/**
 * How one approval went on the worker's PC: `done` (the key was typed),
 * `not-done` (nothing was typed, `reason` says why) or `uncertain` (the
 * receiving PC stopped while it ran; it is never run again).
 */
export interface A2aRemoteApprovalOutcome {
  messageId: string;
  outcome: 'done' | 'not-done' | 'uncertain';
  reason?: A2aRemoteApprovalReason;
}

function parseApprovalOutcome(raw: unknown): A2aRemoteApprovalOutcome | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.messageId !== 'string' || !A2A_REMOTE_MESSAGE_ID_RE.test(r.messageId)) return null;
  if (r.outcome === 'done' || r.outcome === 'uncertain') return { messageId: r.messageId, outcome: r.outcome };
  if (r.outcome !== 'not-done' || typeof r.reason !== 'string' || !APPROVAL_REASONS.has(r.reason)) return null;
  return { messageId: r.messageId, outcome: 'not-done', reason: r.reason as A2aRemoteApprovalReason };
}

/** A command as one block of text from another PC: invisible format characters gone, other controls but newline and tab dropped. */
function approvalCommandText(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  return text.replace(/\p{Cf}/gu, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Cut to at most `max` UTF-8 bytes on a character boundary; `cut` when anything was dropped. */
export function capUtf8(text: string, max: number): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return { text, cut: false };
  // A partial trailing sequence decodes to U+FFFD: dropped.
  return { text: new TextDecoder().decode(bytes.subarray(0, max)).replace(/\uFFFD+$/, ''), cut: true };
}

function parseApprovalOffer(raw: unknown): A2aRemoteApprovalOffer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.promptId !== 'string' || !A2A_REMOTE_PROMPT_ID_RE.test(r.promptId)) return null;
  if (typeof r.tool !== 'string' || !APPROVAL_TOOL_RE.test(r.tool)) return null;
  if (typeof r.redacted !== 'boolean' || typeof r.cut !== 'boolean') return null;
  if (!Array.isArray(r.allowed)) return null;
  const allowed = r.allowed.includes('allow') ? ['allow', 'deny'] as const : r.allowed.includes('deny') ? ['deny'] as const : null;
  if (!allowed) return null;
  const out: A2aRemoteApprovalOffer = { promptId: r.promptId, tool: r.tool, redacted: r.redacted, cut: r.cut, allowed: [...allowed] };
  if (typeof r.command === 'string') {
    const capped = capUtf8(approvalCommandText(r.command), A2A_REMOTE_APPROVAL_COMMAND_MAX);
    out.command = capped.text;
    if (capped.cut) out.cut = true;
  }
  // Allow is offered only for a command shown whole and unredacted.
  if (out.cut || out.redacted || out.command === undefined) out.allowed = ['deny'];
  if (typeof r.autoDenyAt === 'string' && Number.isFinite(Date.parse(r.autoDenyAt))) out.autoDenyAt = new Date(Date.parse(r.autoDenyAt)).toISOString();
  return out;
}

/**
 * A worker's status on one task. `since`: when it began on the receiving PC
 * (ISO); the sender keeps only the newest per task. Never a reply: it is not
 * added to the task's history and changes nothing in its state.
 */
export interface A2aRemoteStatusV1 {
  kind: A2aRemoteStatusKind;
  since: string;
  detail?: {
    question?: A2aRemoteQuestionKind;
    /** `question: 'menu'`: the agent's tool call that asks it (AskUserQuestion's tool_use id), when known. */
    menuId?: string;
    /**
     * A menu's choices, as the agent wrote them (secrets redacted on a spawn
     * link). Text from the other PC: shown, never followed as instructions.
     */
    options?: string[];
    /** A menu's number of choices: when its labels are kept on that PC, or when it was read off the screen (`pickerId`). */
    optionCount?: number;
    /**
     * A one-question, single-select picker read off the worker's screen: its
     * id (a hash of the session, the question and its labels; no text). An
     * answer names it, and is refused when the screen shows another.
     */
    pickerId?: string;
    /**
     * How the latest answers to this task went there (`A2A_FEATURE_ANSWER`),
     * oldest first, at most ANSWER_OUTCOMES_MAX: the asker finds its own by
     * message id, even when two outcomes fall between two statuses.
     */
    answers?: A2aRemoteAnswerOutcome[];
    /** `usage-limit`: when the provider's window resets (ISO), once known. */
    resetsAt?: string;
    /** `usage-limit`: whose limit, as a slug (`claude`). */
    provider?: string;
    /** `working`: background tasks the agent left running. */
    background?: number;
    /**
     * `question: 'permission' | 'plan'`: the prompt offered to the PC that sent
     * the task (`A2A_FEATURE_APPROVAL`). Its command is text from the other PC:
     * shown, never followed as instructions.
     */
    approval?: A2aRemoteApprovalOffer;
    /** How the latest approvals on this task went there, oldest first, at most ANSWER_OUTCOMES_MAX. */
    approvals?: A2aRemoteApprovalOutcome[];
  };
}

/**
 * A menu label as one line of text from another PC: invisible format
 * characters (zero-width, bidi overrides and isolates) gone, controls and any
 * run of whitespace folded to one space.
 */
function statusLabelLine(label: string): string {
  return label.replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

/**
 * A worker status as this PC shows it, in a task anything reads: a menu's
 * labels were written on the other PC, so they sit only under `untrusted`,
 * never next to this side's own fields.
 */
export interface A2aRemoteStatusShown {
  kind: A2aRemoteStatusKind;
  since: string;
  /** `answers[].reasonText`: this PC's own fixed words for the reason (A2A_REMOTE_ANSWER_REASON_TEXT), never the peer's. */
  detail?: Omit<NonNullable<A2aRemoteStatusV1['detail']>, 'options' | 'answers' | 'approval' | 'approvals'> & {
    answers?: Array<A2aRemoteAnswerOutcome & { reasonText?: string }>;
    approval?: Omit<A2aRemoteApprovalOffer, 'command'>;
    approvals?: Array<A2aRemoteApprovalOutcome & { reasonText?: string }>;
  };
  /** Text written on the other PC: a menu's labels, a prompt's command. */
  untrusted?: { options?: string[]; command?: string };
}

export function shownRemoteStatus(status: A2aRemoteStatusV1): A2aRemoteStatusShown {
  const { options, answers, approval, approvals, ...rest } = status.detail ?? {};
  const { command, ...offer } = approval ?? { command: undefined };
  const detail: NonNullable<A2aRemoteStatusShown['detail']> = {
    ...rest,
    ...(answers ? { answers: answers.map((a) => ({ ...a, ...(a.reason ? { reasonText: A2A_REMOTE_ANSWER_REASON_TEXT[a.reason] } : {}) })) } : {}),
    ...(approval ? { approval: offer as Omit<A2aRemoteApprovalOffer, 'command'> } : {}),
    ...(approvals ? { approvals: approvals.map((a) => ({ ...a, ...(a.reason ? { reasonText: A2A_REMOTE_APPROVAL_REASON_TEXT[a.reason] } : {}) })) } : {}),
  };
  const untrusted = {
    ...(options && options.length > 0 ? { options } : {}),
    ...(command !== undefined ? { command } : {}),
  };
  return {
    kind: status.kind,
    since: status.since,
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
    ...(Object.keys(untrusted).length > 0 ? { untrusted } : {}),
  };
}

/** A status from the wire, checked and capped; null when it is not one. */
export function parseA2aRemoteStatus(raw: unknown): A2aRemoteStatusV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !(A2A_REMOTE_STATUS_KINDS as readonly string[]).includes(r.kind)) return null;
  if (typeof r.since !== 'string' || !Number.isFinite(Date.parse(r.since))) return null;
  const out: A2aRemoteStatusV1 = { kind: r.kind as A2aRemoteStatusKind, since: new Date(Date.parse(r.since)).toISOString() };
  const d = r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail) ? r.detail as Record<string, unknown> : null;
  if (!d) return out;
  const detail: NonNullable<A2aRemoteStatusV1['detail']> = {};
  if (typeof d.question === 'string' && QUESTION_KINDS.includes(d.question)) detail.question = d.question as A2aRemoteQuestionKind;
  if (typeof d.menuId === 'string' && STATUS_MENU_ID_RE.test(d.menuId)) detail.menuId = d.menuId;
  if (Array.isArray(d.options)) {
    const options = d.options.filter((o): o is string => typeof o === 'string')
      .map(statusLabelLine)
      .filter((o) => o.length > 0)
      .slice(0, A2A_REMOTE_STATUS_LIMITS.OPTIONS_MAX)
      .map((o) => o.slice(0, A2A_REMOTE_STATUS_LIMITS.OPTION_CHARS_MAX));
    if (options.length > 0) detail.options = options;
  }
  if (typeof d.optionCount === 'number' && Number.isInteger(d.optionCount) && d.optionCount > 0) {
    detail.optionCount = Math.min(d.optionCount, A2A_REMOTE_STATUS_LIMITS.OPTIONS_MAX);
  }
  if (typeof d.resetsAt === 'string' && Number.isFinite(Date.parse(d.resetsAt))) detail.resetsAt = new Date(Date.parse(d.resetsAt)).toISOString();
  if (typeof d.provider === 'string' && STATUS_PROVIDER_RE.test(d.provider)) detail.provider = d.provider;
  if (typeof d.background === 'number' && Number.isInteger(d.background) && d.background > 0) detail.background = Math.min(d.background, 999);
  if (typeof d.pickerId === 'string' && A2A_REMOTE_PICKER_ID_RE.test(d.pickerId)) detail.pickerId = d.pickerId;
  if (Array.isArray(d.answers)) {
    const answers = d.answers.slice(-ANSWER_OUTCOMES_MAX).map(parseAnswerOutcome).filter((a): a is A2aRemoteAnswerOutcome => a !== null);
    if (answers.length > 0) detail.answers = answers;
  }
  const approval = parseApprovalOffer(d.approval);
  if (approval && (detail.question === 'permission' || detail.question === 'plan')) detail.approval = approval;
  if (Array.isArray(d.approvals)) {
    const approvals = d.approvals.slice(-ANSWER_OUTCOMES_MAX).map(parseApprovalOutcome).filter((a): a is A2aRemoteApprovalOutcome => a !== null);
    if (approvals.length > 0) detail.approvals = approvals;
  }
  if (Object.keys(detail).length > 0) out.detail = detail;
  return out;
}

export function isA2aRemoteMessageKind(v: unknown): v is A2aRemoteMessageKind {
  return typeof v === 'string' && (A2A_REMOTE_MESSAGE_KINDS as readonly string[]).includes(v);
}

/** Text body cap per message (bytes, UTF-8). */
export const A2A_REMOTE_BODY_MAX = 32 * 1024;

/**
 * Caps a 'state' envelope's `message` and `evidence` are sent within (bytes,
 * UTF-8), so the envelope, with its summary `text`, stays under the request
 * body limit. A larger message is cut; evidence items that do not fit are
 * left off from the end.
 */
export const A2A_REMOTE_STATE_MESSAGE_MAX = 16 * 1024;
export const A2A_REMOTE_STATE_EVIDENCE_MAX = 32 * 1024;
/**
 * The whole 'state' envelope as JSON (bytes, UTF-8), escapes included: a
 * margin under the receiver's request body limit (2 × A2A_REMOTE_BODY_MAX +
 * 4 KiB). An envelope over it sheds its message, then evidence items, and
 * at worst goes as the plain state with its summary.
 */
export const A2A_REMOTE_STATE_ENVELOPE_MAX = 2 * A2A_REMOTE_BODY_MAX;

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
  /**
   * For 'reply', from the task's sender, only to a peer that advertises
   * `reopen.1`: asks the receiver to follow the task again if it ended
   * `completed` there. A request: the receiver decides, and ignores it
   * anywhere else.
   */
  reopen?: true;
  /** For 'task' / 'reply'. */
  text?: string;
  /** For 'state'. */
  state?: TaskState;
  /**
   * For 'state': the receiver's status message and completion evidence. Both
   * are optional and additive: an older peer ignores them and keeps `text` as
   * the evidence summary. The receiver re-checks them like local evidence.
   */
  message?: string;
  evidence?: CompletionEvidence;
  /**
   * For 'link'. `offer` / `offer-withdrawn` carry a share offer instead of a
   * link notice: `linkId` is then the offerId, both versions are 0, and the
   * payload is in `offer`. An older receiver refuses them as an unknown link.
   */
  link?: {
    state: 'active' | 'revoked' | 'broken' | 'offer' | 'offer-withdrawn' | 'spawn' | 'spawn-result' | 'spawn-targets' | A2aContinueLinkState | A2aBundleLinkState;
    version: number;
    reason?: A2aLinkRecordV1['endedReason'];
  };
  /** For a 'link' envelope whose state is `offer` / `offer-withdrawn`. */
  offer?: A2aOfferPayload;
  /**
   * Remote spawn (`shared/a2aSpawn.ts`), each on a 'link' envelope of the same
   * state name. `linkId` is the spawnId (or `SPAWN_TARGETS_LINK_ID`); these
   * never touch a link record. An older receiver refuses them as an unknown link.
   */
  spawn?: A2aSpawnRequestV1;
  spawnResult?: A2aSpawnResultV1;
  spawnTargets?: A2aSpawnTargetsV1;
  /**
   * Continuing a conversation on another PC (`shared/a2aContinue.ts`), each on
   * a 'link' envelope of the state `continue`, `continue-manifest`,
   * `continue-result` or `continue-status`. `linkId` is the continueId; these
   * never touch a link record. An older receiver refuses them as an unknown link.
   */
  continue?: A2aContinueRequestV1;
  continueManifest?: A2aContinueManifestV1;
  continueResult?: A2aContinueResultV1;
  continueStatus?: A2aContinueStatusQueryV1;
  /**
   * Bringing back an agent's work as a git bundle (`shared/a2aBundle.ts`), on
   * a 'link' envelope of the state `bundle-ask` or `bundle-made`. `linkId` is
   * the ask's id; these never touch a link record. Sent only to a peer that
   * advertises `A2A_FEATURE_BUNDLE`.
   */
  bundleAsk?: A2aBundleAskV1;
  bundleMade?: A2aBundleMadeV1;
  /** For 'receipt' (with `taskId`). */
  receipt?: A2aRemoteReceipt;
  /** For 'status' (with `taskId`), only to a peer that advertises `A2A_FEATURE_STATUS`. */
  status?: A2aRemoteStatusV1;
  /** For 'answer' (with `taskId`, from the task's sender), only to a peer that advertises `A2A_FEATURE_ANSWER`. */
  answer?: A2aRemoteAnswerV1;
  /** For 'approval' (with `taskId`, from the task's sender), only to a peer that advertises `A2A_FEATURE_APPROVAL`. */
  approval?: A2aRemoteApprovalV1;
  /**
   * For 'reply', only to a peer that advertises `A2A_FEATURE_HELD_NOTICE`: this
   * reply is the host's notice, not a message from its agent. The receiver
   * shows its own fixed text, never `text`.
   */
  notice?: A2aRemoteNoticeV1;
  /**
   * For 'task' / 'reply', only to a peer that advertises `A2A_FEATURE_IMAGES`:
   * the images the message carries. The bytes travel on `A2A_ROUTES.blobs`,
   * never in the envelope (see `A2aRemoteImageRef`).
   */
  images?: A2aRemoteImageRef[];
  sentAt: string;
}

// ─── Images on messages (`images.1`) ────────────────────────────────────────

/** The image formats a message may carry, decided by the bytes, never by a name. */
export type A2aRemoteImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export const A2A_REMOTE_IMAGE_MEDIA_TYPES: readonly A2aRemoteImageMediaType[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

/**
 * One image of a message. `sha256` names the bytes and binds them to the
 * envelope: the receiver checks the hash, the exact size and the sniffed type
 * of what it fetched. No name and no path ever cross the wire; the receiver
 * picks its own.
 */
export interface A2aRemoteImageRef {
  /** 64 lowercase hex. */
  sha256: string;
  mediaType: A2aRemoteImageMediaType;
  bytes: number;
}

export const A2A_REMOTE_IMAGE_LIMITS = Object.freeze({
  /** Bytes of one image. */
  IMAGE_MAX_BYTES: 5 * 1024 * 1024,
  /** Images on one message. */
  PER_MESSAGE: 4,
  /** Bytes of all images on one message. */
  MESSAGE_MAX_BYTES: 10 * 1024 * 1024,
  /** Longest edge, px, read from the header (nothing is decoded). */
  MAX_EDGE: 16_384,
  /** Pixels (width x height), read from the header. */
  MAX_PIXELS: 40_000_000,
});

export const A2A_SHA256_RE = /^[0-9a-f]{64}$/;

export function isA2aRemoteImageMediaType(v: unknown): v is A2aRemoteImageMediaType {
  return typeof v === 'string' && (A2A_REMOTE_IMAGE_MEDIA_TYPES as readonly string[]).includes(v);
}

/**
 * The `images` of an envelope: undefined when absent, null when malformed or
 * over a limit (count, one image, the total, a repeated hash). Unknown fields
 * of a ref are dropped.
 */
export function parseA2aRemoteImageRefs(raw: unknown): A2aRemoteImageRef[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > A2A_REMOTE_IMAGE_LIMITS.PER_MESSAGE) return null;
  const out: A2aRemoteImageRef[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const r of raw) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return null;
    const { sha256, mediaType, bytes } = r as Record<string, unknown>;
    if (typeof sha256 !== 'string' || !A2A_SHA256_RE.test(sha256) || seen.has(sha256)) return null;
    if (!isA2aRemoteImageMediaType(mediaType)) return null;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES) return null;
    total += bytes;
    if (total > A2A_REMOTE_IMAGE_LIMITS.MESSAGE_MAX_BYTES) return null;
    seen.add(sha256);
    out.push({ sha256, mediaType, bytes });
  }
  return out;
}

/** The `data` of the stream's `event: hello`. `features`: what the SERVER takes (absent from older builds). */
export interface A2aStreamHello {
  epoch: string;
  features?: string[];
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
  | 'unavailable'
  /** The share offer a proposal answers is no longer open. */
  | 'offer-closed'
  /**
   * An envelope names an image the receiver does not hold yet (its upload
   * was lost): not terminal, the joiner uploads it again and resends.
   */
  | 'attachment-missing'
  /**
   * Recorded by the SENDER, never answered by a peer: the images of a
   * message could not be uploaded within the attempt and time budget.
   */
  | 'attachment-failed'
  /** An `approval` from a PC whose approvals setting is off on the receiver (no file, damaged, or not on for it). */
  | 'approvals-off';

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
  /**
   * `stream-refuse.1`: the joiner refused the record at `seq` (at most one per
   * ack, `seq` ≤ `cursor.seq`, a terminal code). The server takes it only for
   * a record still owed to that joiner, before the ack.
   */
  refused?: { seq: number; code: A2aRemoteErrorCode };
}

/** The server's answer to an ack. `refused`: what it did with the refusal on it, when there was one. */
export interface A2aStreamAckAnswer {
  ok: true;
  acked: number;
  refused?: 'applied' | 'ignored';
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

// ─── Share offers ───────────────────────────────────────────────────────────

/**
 * A share offer: the server's human shared one of its panes with one paired
 * PC. It is that human's consent that the PC may link the pane, within the
 * directions offered, once, before `expiresAt`. The other PC's human then
 * picks its own pane and accepts, which sends an ordinary proposal naming the
 * offer (`A2aLinkProposeRequest.offerId`); the sharer accepts it at once.
 */
export const A2A_OFFER_TTL_MS = 60 * 60 * 1000;

export type A2aOfferState =
  | 'open'
  /** Sharer only: a matching proposal is being turned into a link. */
  | 'claimed'
  | 'accepted'
  | 'declined'
  | 'withdrawn'
  | 'expired';

export type A2aOfferEndReason =
  | 'declined'
  | 'withdrawn'
  | 'expired'
  | 'pane-closed'
  | 'pane-moved'
  | 'workspace-gone'
  | 'exposure-revoked'
  | 'peer-removed'
  | 'receiver-unsupported'
  /** The offer already made its one link. */
  | 'used';

export const A2A_OFFER_END_REASONS: readonly A2aOfferEndReason[] = Object.freeze([
  'declined', 'withdrawn', 'expired', 'pane-closed', 'pane-moved', 'workspace-gone', 'exposure-revoked', 'peer-removed', 'receiver-unsupported', 'used',
]);

/** `A2aRemoteEnvelope.offer`: an open offer, or why it was withdrawn. */
export type A2aOfferPayload =
  | {
      /** The sharer's pane, display fields included (sanitized by the receiver). */
      end: A2aExposedPane;
      /** Directions from the SHARER's point of view. */
      allow: { outbound: boolean; inbound: boolean };
      /** Lifetime from receipt (relative, so clocks need not agree). */
      ttlMs: number;
    }
  | { reason: A2aOfferEndReason };

/** One share offer, from this host's perspective (`offers.json`). */
export interface A2aLinkOfferRecordV1 {
  v: 1;
  offerId: string;
  /** 'out': this PC shared one of its panes; 'in': another PC shared one with this PC. */
  side: 'out' | 'in';
  /** The other PC. */
  hostId: HostId;
  /** The sharer's pane: ours for 'out', theirs (as that PC reports it) for 'in'. */
  end: A2aExposedPane;
  /** Directions from THIS host's point of view. */
  allow: { outbound: boolean; inbound: boolean };
  state: A2aOfferState;
  endedReason?: A2aOfferEndReason;
  /** The link this offer made ('claimed' / 'accepted'). */
  linkId?: string;
  /** Receiver only: our proposal for this offer, sent but not settled. */
  pendingLinkId?: string;
  /** Sharer only: the share added this pane (and maybe its workspace) to that PC's exposure. */
  addedExposure?: boolean;
  addedWorkspace?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Sharer: authoritative. Receiver: receipt time + ttlMs, for display. */
  expiresAt: string;
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
   * Why delivery is held. Earlier versions also wrote `brain-unavailable` and
   * `brain-delivery-pending` (work for this PC's Moa, removed since); they
   * are read as `link-not-active` (readHeldReason).
   */
  held?:
    | 'occupant-changed'
    | 'pane-missing'
    | 'link-not-active'
    /** A paste was attempted but never confirmed (main restarted mid-delivery): a person decides. */
    | 'delivery-unconfirmed'
    /** The pane kept having no agent to deliver to. */
    | 'no-agent'
    /** A follow-up on a link a remote spawn made, waiting for its approval card (`followUps: 'ask'`). */
    | 'awaiting-approval';
  /**
   * This side's link endpoint kind when the task was stored. `brain` = the
   * task is this PC's Moa's, delivered as a wake, never to a pane. Absent on a
   * task stored before it was recorded (treated as a pane task).
   */
  kind?: A2aEndpointKind;
  /**
   * Outbound company or fan-out task: the peer's state messageId of the
   * `completed` held here as a report (the task is input-required) until this
   * host marks it done. Cleared by the peer's next state that is not a report.
   */
  reported?: string;
  /**
   * Outbound: the first task of an agent `fanout_start` asked another PC to
   * start, set here when the task was made (never from anything the peer
   * sends). The peer's `completed` is held as a report, as on a company task.
   */
  fanout?: true;
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
