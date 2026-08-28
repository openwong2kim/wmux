import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { DaemonSessionManager, ManagedSession } from '../DaemonSessionManager';
// Types only — the registry implementation, its persistence and its
// headless-terminal dependency chain stay out of this module. The web server is
// a CONSUMER: it lists, it resolves, it republishes lifecycle events. It never
// constructs a request, and it never decides what bytes a decision means.
import type { ApprovalEvent, ApprovalRegistryApi, ApprovalRequest } from '../approvals/types';
// Type only — the projector's implementation (transcript parsing, watch state,
// fs watching) stays out of this module. The web server is a STATELESS consumer
// of its `delta()` for the phone turn view (#782); it must never `subscribe()`.
import type { TranscriptProjector } from '../transcript/TranscriptProjector';
// Type only — the projection from hook envelope to header state lives in the
// hooks layer (see agentLiveness.ts). This module only fans the result out.
import { isTerminalLiveness, type AgentLivenessBody } from '../hooks/agentLiveness';
import { ENV_KEYS, isBrainPty } from '../../shared/constants';
import { webHostIsLoopback, type PairRefusal, type WebTlsConfig } from '../../shared/web';
import type { RemotePaneSummary } from '../../shared/remoteHosts';
import { capSnapshot } from './snapshotWindow';
import {
  collectSessionDiff,
  createGitRunner,
  type GitRunner,
  type SessionDiffResult,
} from './sessionDiff';
import {
  daemonServerVersion,
  MIN_PHONE_PROTOCOL_VERSION,
  PHONE_PROTOCOL_VERSION,
} from './protocolVersion';
import { startSseHeartbeat } from './sseHeartbeat';
import { buildWebCsp } from './webCsp';

/**
 * Opaque cursor for `/api/sessions/:id/turns` (#782). Encodes head+tail offsets
 * plus the fileSize `delta()` shrink-checks for a replaced transcript, so the
 * phone holds an opaque string and never has to understand the byte model.
 * base64url keeps it URL-safe without percent-encoding the JSON braces.
 *
 * mtimeMs is deliberately NOT carried: it moves on every append, so no reset
 * check can use it (see `TranscriptProjector.delta`). An older cursor that
 * still holds the field decodes fine — the extra key is ignored.
 */
function encodeTurnCursor(c: { headOffset: number; tailOffset: number; fileSize: number }): string {
  return Buffer.from(
    JSON.stringify({ head: c.headOffset, tail: c.tailOffset, fileSize: c.fileSize }),
  ).toString('base64url');
}

function decodeTurnCursor(
  s: string | null,
): { head: number; tail: number; fileSize?: number } | null {
  if (!s) return null;
  try {
    const o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return null;
    const tail = Number(o.tail);
    const head = Number(o.head ?? o.tail);
    if (!Number.isFinite(tail) || !Number.isFinite(head)) return null;
    return {
      head,
      tail,
      fileSize: typeof o.fileSize === 'number' ? o.fileSize : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * wmux web — a read-only-by-default browser terminal served BY THE DAEMON.
 *
 * Why here and not a ttyd wrapper: the daemon already owns the PTY bytes, a
 * per-session ring buffer, and a NON-exclusive output fan-out
 * (`DaemonPTYBridge` is an EventEmitter). ttyd would spawn its own shell and
 * could never surface the existing fleet. We tee the bridge, which — unlike the
 * GUI's single-client `SessionPipe` — accepts as many listeners as we attach,
 * so a phone browser and the desktop GUI can watch the same pane at once.
 *
 * Transport is SSE (output) + POST (input), not raw WebSocket: no new
 * dependency (Node `http` only), native browser auto-reconnect, and a clean
 * one-way fit for the read-only default.
 *
 * Security posture:
 *   - Nothing listens until `daemon.web.start` is invoked (default unchanged).
 *   - TWO credential forms, both checked timing-safe on every `/api/*` call:
 *     the OPERATOR token (minted per start, carried across restarts by #596,
 *     used by the CLI/GUI and the advertised URLs) and a per-DEVICE credential
 *     (`<deviceId>.<secret>`, minted by pairing, individually revocable). The
 *     daemon master token never touches the network in either case.
 *   - Only the operator token may ride in `?token=`. A device secret is durable
 *     and never expires, so it is header-only on every route including SSE. A
 *     browser device opens a stream with `?ticket=` instead: a two-minute,
 *     device-bound capability from `POST /api/stream-ticket` (B3).
 *   - FREE-FORM input is impossible unless the server was started with
 *     `allowInput` (execute-impossible stays the default — the operator opts in
 *     explicitly). The ONE carve-out is `POST /api/approvals/:id`, which works
 *     on a read-only server; see that handler for why a scoped approval is a
 *     strictly narrower grant than `--allow-input`.
 *   - The pane LIFECYCLE routes (`POST /api/sessions`, `DELETE
 *     /api/sessions/:id`) are NOT a second carve-out: both require
 *     `--allow-input`. Spawning a shell IS arbitrary execution, and killing a
 *     pane is destructive; see handleSessionCreate for the full reasoning.
 *   - `GET /api/sessions/:id/diff` runs read-only git in the pane's own cwd.
 *     The cwd comes from the daemon's session record, never from the request,
 *     and no ref/pathspec argument is accepted — see sessionDiff.ts.
 *
 * Route table (everything under `/api/` is Bearer-gated unless noted):
 *   GET  /                     app shell (unauthenticated, no secrets)
 *   GET  /api/pair?code=       the ONLY unauthenticated API route; mints this
 *                              device's own credential (refused over plaintext
 *                              off-machine transports — see mintRefusal)
 *   GET  /api/config           allowInput + allowUpload flags, plus the phone
 *                              protocol handshake (see protocolVersion.ts)
 *   GET  /api/sessions         pane list
 *   POST /api/sessions         spawn a pane — 403 unless `--allow-input`
 *   DELETE /api/sessions/:id   close a pane — 403 unless `--allow-input`
 *   GET  /api/sessions/:id/diff  what this pane's repo has changed (read-only git)
 *   POST /api/stream-ticket    device → short-lived `?ticket=` capability
 *   GET  /api/stream?session=  SSE pane bytes (`?token=`/`?ticket=` — EventSource)
 *   GET  /api/events           attention + approval channel; SSE (`?token=`
 *                              allowed) or JSON backlog (Bearer only)
 *   POST /api/input?session=   free-form bytes — 403 unless `--allow-input`
 *   POST /api/upload           raw JPEG/PNG bytes → a path on disk — 403
 *                              unless `--allow-upload` (its own grant)
 *   GET  /api/approvals        pending + recently resolved approval requests
 *   POST /api/approvals/:id    resolve one — ALLOWED on a read-only server
 */

export interface WebTerminalStartOptions {
  port: number;
  host: string;
  allowInput: boolean;
  /**
   * Whether `POST /api/upload` accepts photos (`--allow-upload`).
   *
   * REQUIRED, not optional, and deliberately not folded into `allowInput`:
   * writing a file into the operator's home directory is a heavier grant than
   * typing into a pane they are watching, so every caller has to state which
   * one it means rather than inheriting a default.
   */
  allowUpload: boolean;
  /**
   * Whether `GET /api/sessions/:id/turns` serves the transcript turn view
   * (`--allow-transcript`). Its own flag, NOT folded into `allowInput`: the
   * transcript carries far wider reading than a mirror (thinking blocks, full
   * tool inputs, file contents the agent read — the whole session), and the
   * device credential never expires, so a leak is a category change, not an
   * increment. Absent → false (a pre-flag daemon reads as off, the same way a
   * missing `allowUpload` does). (#782)
   */
  allowTranscript?: boolean;
  /**
   * Terminate HTTPS in the daemon with operator-supplied PEM files.
   *
   * Paths are absolute because the CLI and daemon do not necessarily share a
   * working directory. File contents are read only while constructing the
   * listener and never appear in status or durable state.
   */
  tls?: WebTlsConfig;
  /**
   * Extra hostnames to accept in the `Host` header, beyond loopback and the
   * bound addresses. Needed when a reverse proxy in front of the loopback bind
   * forwards the browser's Host verbatim — `tailscale serve` forwards the
   * MagicDNS name, which the default allowlist would 403.
   */
  allowedHosts?: string[];
  /**
   * Whether the caller put a `tailscale serve` front in place before starting.
   *
   * Recorded and reported, never acted on: registering and tearing down the
   * serve belongs to whoever owns the machine's tailscale state (the CLI, or
   * the desktop main process), not to a daemon that may be restarted by an
   * updater with nobody watching.
   */
  tailscale?: boolean;
  /**
   * Reuse this bearer token instead of minting a fresh one (#596).
   *
   * Set ONLY by the daemon's own restore/start path, from the 0600
   * `web-state.json` it wrote itself — never from `daemon.web.start` RPC
   * params, so no pipe client can choose the token a browser will be handed.
   * Absent (the default, and every unit test) → a fresh `randomUUID`.
   */
  token?: string;
}

export interface WebTerminalInfo {
  running: boolean;
  port?: number;
  host?: string;
  allowInput?: boolean;
  /** Whether `POST /api/upload` is armed. Its own opt-in, see start options. */
  allowUpload?: boolean;
  /** Whether `GET /api/sessions/:id/turns` is armed. Its own opt-in (#782). */
  allowTranscript?: boolean;
  /** True when this listener terminates HTTPS inside the daemon. */
  tls?: boolean;
  token?: string;
  /** Reachable URLs with the token embedded (`http[s]://<host>:<port>/?token=…`). */
  urls?: string[];
  /** Live SSE client count. */
  clients?: number;
  /** Short single-use pairing code — typed on the phone instead of the token. */
  pairCode?: string;
  /** Epoch ms when the current pairing code expires. */
  pairExpiresAt?: number;
  /**
   * Whether per-device credentials are armed, i.e. whether a device store was
   * wired in.
   *
   * False means pairing still works but hands out the SHARED token exactly as
   * 3.34.0 shipped it — not a downgrade from that release, but not the upgrade
   * either, and critically there is nothing to revoke one device at a time. An
   * operator who believes revocation is available when it is not would keep a
   * lost phone's access alive while thinking they had cut it, so this is
   * surfaced rather than left to a daemon log nobody reads.
   */
  deviceCredentials?: boolean;
  /**
   * Why pairing cannot succeed right now, or absent when it can. Set together
   * with WITHHOLDING `pairCode` — see status().
   *
   * The type is imported rather than restated: this interface is already a
   * hand-kept mirror of the one in shared/web.ts, and a fourth copy of the
   * refusal shape is a fourth thing to forget.
   */
  pairRefusal?: PairRefusal;
  /** Which transport this server was started on. Reported, never acted on. */
  tailscale?: boolean;
  /**
   * The TLS fronts the operator named with `--allow-host`, if any.
   *
   * Surfaced so `--status` and the GUI can name the address that actually works
   * from a phone. `wmux web --tailscale` binds loopback on purpose, so without
   * this the only thing status could report for the supported phone setup was a
   * loopback URL — correct about the bind, useless to the operator.
   */
  allowedHosts?: string[];
}

/**
 * The answer to "does this `<deviceId>.<secret>` belong to a live device?".
 *
 * The two failure reasons are NOT interchangeable and must not be collapsed:
 * `revoked` is the operator's own decision and the phone should say so ("this
 * device was removed — ask for a new pairing code"), while `unknown` is a
 * credential this daemon has never seen (a wiped roster, a different machine,
 * a typo). #599 shipped a 401 screen that could only guess; this is what lets
 * it stop guessing.
 */
export type DeviceAuthResult =
  /**
   * `allowInput` is REQUIRED, not optional. A resolver that forgets it would
   * otherwise silently resolve to `undefined` and read as read-only at the
   * gate — every paired device muted by an omission tsc could have caught.
   * The daemon injects the real store here, which is where the two shapes are
   * checked against each other.
   */
  | { ok: true; deviceId: string; name?: string; allowInput: boolean }
  | { ok: false; reason: 'unknown' | 'revoked' };

/**
 * Per-device credentials as far as the HTTP surface is concerned (M3).
 *
 * STRUCTURAL ON PURPOSE. The implementation (`DeviceStore`) owns the KDF and
 * its parameters, the per-device salt, the roster file, the derived-key cache
 * and the audit log — none of which this module may know about, for the same
 * reason it does not know how the approval registry picks keystrokes. What the
 * web server needs is exactly two verbs: turn a presented credential into an
 * identity, and mint one for a device the operator just named.
 *
 * `resolve` MUST NOT throw: an unreadable roster is an auth failure, never a
 * 500 on a route that would otherwise have answered. It may be async because a
 * password KDF has to be — a synchronous scrypt on the request path would stall
 * the daemon's whole event loop once per call.
 *
 * NO EXPIRY. A device credential lives until it is revoked; there is no TTL and
 * no refresh (contract §7). Revocation is the whole mechanism, which is why it
 * has to be immediate — see `disconnectDevice`.
 */
export interface WebDeviceResolver {
  resolve(deviceId: string, secret: string): Promise<DeviceAuthResult> | DeviceAuthResult;
  mint(params: { name?: string; allowInput?: boolean }): Promise<{ deviceId: string; deviceSecret: string }>;
  /**
   * Record a successful auth. Optional because it is bookkeeping, not
   * authorization: a store that does not track `lastSeenAt` is still a valid
   * resolver, and a roster row with a stale timestamp is a cosmetic loss.
   * Called on every authenticated device request — the store decides how often
   * that is worth writing down.
   */
  touch?(deviceId: string): void;
  /**
   * Record where to push to this device and the key to seal for it. Optional
   * for the same reason `touch` is: a server without push is still a working
   * server, and the route answers 503 rather than pretending.
   */
  registerPush?(
    deviceId: string,
    input: { apnsToken: string; publicKey: string; apnsEnvironment?: unknown },
  ): { ok: boolean; reason?: string };
}

/**
 * WHO is making this request. Tagged onto every SSE client so a revoke can find
 * that device's live streams and end them, instead of leaving a torn-down
 * device watching panes until it happens to reconnect.
 */
export type WebPrincipal =
  | { kind: 'operator' }
  /**
   * A paired device. `allowInput` is ITS grant, not the server's — the server
   * flag remains the ceiling and is applied on top by `mayInput`.
   */
  | { kind: 'device'; deviceId: string; name?: string; allowInput: boolean };

/** Authenticated identity, or why the credential was refused. */
type AuthOutcome = { ok: true; principal: WebPrincipal } | { ok: false; reason: 'unknown' | 'revoked' };

/**
 * What `daemon.web.pairStart` answers. A discriminated union rather than
 * `{ok, code?, error?}` so a caller cannot read `code` off a refusal — but
 * still structurally assignable to that looser shape if the RPC layer declares
 * one. `error` is operator-facing copy: it says what to do, not just "no".
 */
export type WebPairStartResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; error: string };

/**
 * Pane lifecycle as far as the HTTP surface is concerned.
 *
 * STRUCTURAL, like `WebDeviceResolver`, and for a sharper reason than usual.
 * Spawning a PTY means an id policy, a shell resolution, an environment
 * filter, the process monitor, the supervisor, a state flush and a snapshot
 * trigger — the exact body of the `daemon.createSession` RPC. This module must
 * not own a second copy of that (a second copy is how the web-created pane
 * ends up unmonitored and unpersisted), so the daemon hands its OWN handler in
 * and the route calls it.
 *
 * NOT the MCP `pane_split` path. That RPC is registered in the Electron main
 * process (`src/main/pipe/handlers/pane.rpc.ts`) and forwarded to the renderer,
 * which owns the pane TREE; the daemon cannot reach it and must not learn how
 * — `daemonExecuteWall.test.ts` bans importing `src/main/pipe` outright. What
 * both paths converge on is `daemon.createSession`, and that is what this is.
 * The consequence is stated where the daemon implements it: a pane created
 * here is a real, monitored, persisted daemon session that the desktop GUI has
 * no layout node for.
 */
export interface WebSessionLifecycle {
  /** Spawn a pane. Resolves to the new session's id. */
  create(params: { workspaceId?: string; cwd?: string }): Promise<{ id: string }>;
  /** Close a pane and dispose its PTY. Called only for an id already resolved. */
  destroy(id: string): Promise<void>;
}

interface WebTerminalServerDeps {
  sessionManager: DaemonSessionManager;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Per-device credential store (M3). Optional, like `approvals`: a daemon that
   * could not build one still serves every route on the operator token, and
   * `/api/pair` degrades to the pre-M3 shared-token response with a warning
   * rather than leaving the operator unable to pair anything at all.
   */
  devices?: WebDeviceResolver;
  /**
   * The daemon's approval registry. Optional: a daemon that has not wired one
   * (or a unit test that does not care) still serves every other route, and the
   * approval routes answer 503 rather than pretending the surface exists.
   */
  approvals?: ApprovalRegistryApi;
  /**
   * Directory holding the built frontend assets (terminal.html, manifest,
   * sw.js, icons). Resolved by the caller relative to the daemon bundle so it
   * works in both dev (`dist/daemon-web`) and packaged
   * (`resources/daemon-web`) layouts.
   */
  assetsDir: string;
  /**
   * Pane spawn/close. Optional like `approvals`: a daemon that did not wire it
   * (or a unit test that does not care) still serves every other route, and the
   * two lifecycle routes answer 503 rather than pretending.
   */
  lifecycle?: WebSessionLifecycle;
  /**
   * How `GET /api/sessions/:id/diff` reaches git. Seam, defaulted to the real
   * `execFile` runner — injected only so the route's status-code mapping can be
   * tested without a repository on the test machine's disk.
   */
  git?: GitRunner;
  /**
   * Where `POST /api/upload` writes photos. Optional like `approvals`: a daemon
   * that did not wire one still serves every other route, and the upload route
   * answers 503 rather than guessing at a directory to create.
   *
   * Production passes `~/.wmux/uploads/phone`, which sits under the directory
   * the Playwright sandbox already allowlists — so an uploaded photo is usable
   * by `browser_file_upload` without a second policy.
   */
  uploadsDir?: string;
  /**
   * Overrides for the upload bounds. Test seam only — production takes the
   * module constants, and there is no operator surface for these. Filling a
   * quota honestly is the only way to test the refusal, and 200 MB of temp
   * files per test run is not a test.
   */
  uploadLimits?: { maxFiles?: number; maxDirBytes?: number; maxConcurrent?: number };
  /**
   * Clock seam. The attention log's TTL eviction and the upload sweep read it;
   * injected so the unit tests can age entries deterministically instead of
   * sleeping half an hour. Defaults to the wall clock.
   */
  now?: () => number;
  /**
   * The daemon's transcript projector — the phone turn-view contract (#782).
   * Optional like `approvals`: a daemon/test that has not wired one still serves
   * every other route, and `/api/sessions/:id/turns` answers 503 rather than
   * pretending the surface exists. The phone path is STATELESS (`delta()` +
   * nudge only) and must NEVER call `subscribe()` — a late subscriber's
   * force-reset would scramble every desktop Chat View row sharing the session.
   * A GETTER, not a direct ref: the daemon builds the projector lazily (after
   * the first resume binding), so the server captures it at construction and
   * resolves the live instance per request.
   */
  projector?: () => TranscriptProjector | null;
  /**
   * #783 — the gated-tools list from daemon config, so `/api/config` can expose
   * it and the phone can explain "why is this call waiting?". A getter (not a
   * static ref) because the list is editable at runtime via `wmux gate --add`.
   * Optional: a server that did not wire it serves every other route, and
   * `/api/config` reports an empty list.
   */
  gateConfig?: () => { gatedTools: string[] };
  /**
   * #783 — runtime escape hatch. `POST /api/gate/off` / `/api/gate/on` call
   * this to disarm or re-arm the permission gate. Turning it off also defers
   * whatever is already blocked, so the agent that is waiting right now moves
   * immediately instead of sitting out its deadline (review: Codex). Optional:
   * a server that did not wire it answers 503, and `WMUX_GATE=0` still works.
   */
  setGateEnabled?: (enabled: boolean) => void;
  /**
   * Whether the runtime escape hatch above is currently ARMED. The daemon owns
   * the flag; without a way to read it back, `/api/config` could report which
   * tools are gated but not whether the gate itself was on, so a client's toggle
   * had to guess its own initial state and only learned the truth from the
   * response to its first write. Optional, and absent means the field is omitted
   * from `/api/config` rather than defaulted — "this daemon does not say" is not
   * the same answer as "off".
   */
  gateEnabled?: () => boolean;
}

/** Cap a single input POST body so a hostile client cannot exhaust memory. */
const MAX_INPUT_BYTES = 64 * 1024;
/**
 * Cap a single photo upload. A phone transcodes to JPEG at 2048px on its long
 * edge before sending, which lands an order of magnitude under this; the cap is
 * here for the client that does not, not for the one that does.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/**
 * How long an uploaded photo survives.
 *
 * The path handed back is a CONSUMABLE, not a library: the phone puts it in a
 * composer draft the operator sends within seconds. A day is generous for that
 * and short enough that a directory nobody looks at does not become an archive
 * of everything ever photographed at a terminal.
 */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Ceiling on what the uploads directory may hold, in files and in bytes.
 *
 * The per-request cap bounds ONE upload; nothing bounded the sum, so a client
 * in a loop could fill the operator's disk a legal 10 MB at a time — the TTL
 * only collects what is already a day old, which is no help inside the hour it
 * takes. A hundred photos is far past what the intended use produces (take a
 * picture, send it, forget it) and 200 MB is a bounded, recoverable amount of
 * disk to lose to a misbehaving client.
 */
const MAX_UPLOAD_FILES = 100;
const MAX_UPLOAD_DIR_BYTES = 200 * 1024 * 1024;
/**
 * How many upload bodies may be buffering at once, server-wide.
 *
 * Each in-flight upload holds its whole body in memory up to MAX_UPLOAD_BYTES,
 * so the disk quota above does nothing for RAM: an authenticated client opening
 * requests in parallel costs 10 MB of heap apiece before a single byte is
 * written or refused. Four is comfortably more than one human sending photos
 * from one phone, and caps the exposure at 40 MB.
 */
const MAX_CONCURRENT_UPLOADS = 4;
/** Pairing code lifetime — long enough to walk to the phone, short enough to matter. */
const PAIR_TTL_MS = 10 * 60 * 1000;
/** Wrong-code attempts before the pairing code is burned. */
const PAIR_MAX_ATTEMPTS = 5;
/**
 * Minimum gap between automatic pairing-code regenerations. Without a cooldown,
 * an attacker who can burn codes could force a regeneration loop; with one, a
 * burned code costs the legitimate operator a short wait instead of a restart.
 */
const PAIR_REGEN_COOLDOWN_MS = 30_000;
/** Pairing alphabet: A-Z2-9 minus the visually ambiguous 0/O/1/I. */
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LEN = 8;
/**
 * How many attention events the replay window holds. A phone that dropped
 * connection for a coffee break must get everything it missed; a phone that was
 * off overnight gets the most recent window and a `reset` marker rather than an
 * unbounded backlog the daemon paid RAM for all night.
 */
const ATTENTION_CAP = 100;
/** Attention entries older than this are dropped even if the cap allows them. */
const ATTENTION_TTL_MS = 30 * 60 * 1000;
/**
 * #782 — coalescing window for the non-recording transcript nudge. A single
 * turn raises several hook signals in quick succession (activity then stop),
 * and the phone refetches on every nudge, so one-per-second is the floor that
 * keeps a write burst from fanning into one fetch per write.
 */
const TRANSCRIPT_NUDGE_COALESCE_MS = 1000;
/**
 * Coalescing window for the non-recording liveness event. Same 1Hz floor as the
 * nudge and for the same reason: a tool-heavy turn raises one PreToolUse per
 * call, and the header only has to be RIGHT, not instantaneous. Unlike the
 * nudge this window keeps the LATEST state rather than the first — a header is
 * a state, not a "something changed" ping, so collapsing a burst to its head
 * would leave the phone showing the tool that started the burst. Terminal
 * states skip the window entirely (`isTerminalLiveness`).
 */
const AGENT_LIVENESS_COALESCE_MS = 1000;
/** A decision body is two fields; anything larger is not one of ours. */
const MAX_JSON_BODY_BYTES = 8 * 1024;
/**
 * Ceiling on ONE expanded code block / tool body served to a phone. The desktop
 * reads these over a local pipe; a phone may be on cellular, and a `cat` of a
 * large file is one legitimate transcript entry. Over the cap the response is a
 * head plus `truncated`, never a silent cut.
 *
 * Must stay UNDER the projector's own line-read ceiling (`LINE_READ_BYTES`,
 * 512 KB in readTail.ts) or the branch is unreachable: a body can never exceed
 * the line it was parsed out of, so a cap at or above that limit is a promise
 * the route cannot keep. It was 1 MB and was exactly that dead branch
 * (2-MODEL review).
 */
const MAX_BLOCK_BODY_BYTES = 256 * 1024;
/**
 * Who the registry records as having answered, for anything resolved over HTTP.
 *
 * This used to be the constant `'web'`, on the reasoning that "the web token is
 * one shared secret held by whoever paired a device, so claiming a user
 * identity here would be a fabrication". That was true when every phone
 * presented the operator's token — and M3 made it false. A device now
 * authenticates as ITSELF, with a credential only it holds and that the
 * operator can revoke on its own, so the id is a fact we have rather than a
 * claim we would be inventing.
 *
 * Keeping the constant meant the one action in this whole surface that writes
 * bytes into somebody's terminal was also the one place the authenticated
 * identity was thrown away: `approvals.json`, the daemon log line, and the 409
 * body all said `web` no matter which phone pressed the key. The roster could
 * not answer "who approved that?" afterwards.
 *
 * The device NAME rides along with the id because the roster is not a permanent
 * record — a revoked device's tombstone is eventually pruned, and the audit
 * trail has to keep making sense after that.
 */
function describePrincipal(principal: WebPrincipal): string {
  if (principal.kind === 'operator') return 'operator';
  return principal.name
    ? `device ${principal.name} (${principal.deviceId})`
    : `device ${principal.deviceId}`;
}
/**
 * Separator inside a device credential (`<deviceId>.<secret>`). A dot because
 * the operator token is a `randomUUID` and contains none, so the two forms are
 * distinguishable without ever having to guess which one was presented.
 */
const DEVICE_CREDENTIAL_SEP = '.';
/**
 * Stream-ticket lifetime (B3).
 *
 * Long enough to open a stream and to survive the browser's own retry, short
 * enough that a ticket recovered from a proxy log or a Referer is worthless by
 * the time anyone reads it. Deliberately NOT the credential's lifetime: the
 * credential never expires, the ticket almost immediately does.
 */
const STREAM_TICKET_TTL_MS = 120_000;
/** 256 bits of CSPRNG — the reason a plain Map lookup is safe (see resolveStreamTicket). */
const STREAM_TICKET_BYTES = 32;
/**
 * Outstanding tickets held across all devices. Expired entries are pruned
 * first; the cap only bounds memory if an authenticated device asks for
 * tickets in a loop, which no client of ours does.
 */
const MAX_STREAM_TICKETS = 512;

/**
 * How many pane diffs may be collected at once, across the whole daemon.
 *
 * A diff is a `rev-parse`, a config listing, three collection commands, a
 * closing `status` and up to `UNTRACKED_DIFF_LIMIT` more `--no-index` runs —
 * two dozen `git` processes in the worst case, each allowed five seconds and
 * half a megabyte of buffer, with the untracked pass held to
 * `UNTRACKED_TOTAL_BUDGET_MS` overall so the worst case is bounded in TIME as
 * well as in count. The route needs no `--allow-input`, so a phone that
 * retries on every reconnect — or a client that simply polls — is a fork bomb
 * with a Bearer token. Two is chosen to be obviously enough for the intended
 * use (one human, looking at one approval) and obviously not a load: a third
 * concurrent collection is refused with 429 rather than queued, because a
 * queued diff arrives after the human has already decided.
 */
const MAX_CONCURRENT_DIFFS = 2;
/** Live collections, daemon-wide. Module-level: the bound is on `git`, not on a server object. */
let activeDiffs = 0;
/**
 * Collections in flight, keyed by session id, so N requests for the SAME pane
 * cost ONE git run and all get the same answer. This is the common case by far:
 * a phone reconnecting mid-request re-issues it, and the diff is a pure read,
 * so sharing the result is not a cache — the second caller is waiting on the
 * very run it would otherwise have started.
 */
const inFlightDiffs = new Map<string, Promise<SessionDiffResult>>();

/**
 * Widest geometry `POST /api/sessions/:id/resize` will forward to a PTY.
 *
 * The session manager floors cols and rows (a zsh SIGBUS guard) but caps
 * neither — it never needed to, because its only caller was a renderer
 * measuring its own pane. A number off the network is different: a PTY is
 * asked to allocate for the geometry it is given, so an unbounded `rows` is a
 * memory-allocation request written as two integers. 1000 is far above any real
 * display and far below anything that costs the daemon.
 */
const MAX_REQUESTED_GEOMETRY = 1000;

/**
 * Narrowest geometry this ROUTE will forward — deliberately far above the
 * session manager's own floor (10 cols, 2 rows).
 *
 * That floor is a crash guard: below ~7 columns an interactive zsh dies inside
 * `zle.so`. It is not a claim that 10 columns is a usable terminal. A pane
 * driven to 10 columns hard-wraps everything it prints, and those bytes are in
 * the ring buffer for good — scrollback does not re-flow, so "the next desk
 * attach fixes it" is true of future output and false of the transcript.
 *
 * A phone in the narrowest orientation still asks for far more than this, so
 * the bound costs no real client anything.
 */
const MIN_REQUESTED_COLS = 40;
const MIN_REQUESTED_ROWS = 8;

/**
 * Least time between two accepted resizes of ONE session.
 *
 * Sized to be invisible to a real client — the phone debounces its own layout
 * passes at 250 ms — and to put a ceiling on what a hostile one can do.
 */
const MIN_RESIZE_INTERVAL_MS = 250;

/** Sessions tracked for rate limiting before the map is swept against the roster. */
const RESIZE_TRACKING_CAP = 256;

/**
 * Trailing debounce before an SSE stream answers an applied resize with fresh
 * geometry. Deliberately LONGER than MIN_RESIZE_INTERVAL_MS: with a shorter
 * window every resize the rate limiter lets through is already spaced far
 * enough apart to defeat the debounce, so a device alternating two geometries
 * would fan one message per accepted resize out to every viewer. Above the
 * limiter's own floor, a storm collapses into one message.
 */
const RESIZE_META_DEBOUNCE_MS = 400;

/**
 * Did the caller mention this field at all — as opposed to sending a value the
 * route will go on to reject?
 *
 * The presence question needs its own helper because `in` is the only way to
 * ask it and `in` THROWS on a primitive. `readJsonBody` hands through whatever
 * `JSON.parse` returned, and `123` is valid JSON: a body of exactly `123`
 * reaches a handler as a number, `(body ?? {})` leaves it a number because it
 * is neither null nor undefined, and `'x' in 123` is a `TypeError` raised
 * inside the `req.on('end')` callback — where nothing catches it. That is a
 * one-line request from any paired device that takes the daemon down, so the
 * guard belongs here rather than at each call site that might forget it.
 *
 * Arrays are excluded too: `'0' in ['production']` is true, and an array is
 * never the object shape any of these routes documents.
 */
function statesField(body: unknown, field: string): boolean {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && field in body;
}

/** One side of a requested PTY geometry. */
function isGeometryValue(value: unknown, min: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= MAX_REQUESTED_GEOMETRY
  );
}

interface SseClient {
  res: http.ServerResponse;
  sessionId: string;
  detach: () => void;
  /** Whose stream this is, so a revoke can end exactly that device's. */
  principal: WebPrincipal;
}

/**
 * A short-lived capability to OPEN a stream, and nothing else (B3).
 *
 * It exists because `EventSource` cannot set headers, and a device credential
 * is durable — putting one in a query string would write a permanent secret
 * into history, proxy logs and Referer headers. A ticket is the narrow thing a
 * URL can safely carry: it grants opening a stream, it expires in two minutes,
 * it is bound to one device, and revoking that device destroys it.
 */
interface StreamTicket {
  deviceId: string;
  name?: string;
  expiresAt: number;
}

/** A live `/api/events` subscriber (fleet-wide attention only, no pane bytes). */
interface EventClient {
  res: http.ServerResponse;
  detach: () => void;
  principal: WebPrincipal;
}

/**
 * What a recorded event IS, and the SSE event name it goes out under.
 *
 * `approval` joins the two attention kinds rather than opening a channel of its
 * own: it is the same question ("this pane needs a human") reaching the same
 * clients, and it must inherit the id/replay machinery — an approval raised
 * while the phone was in a tunnel is exactly the event that must survive the
 * reconnect.
 */
type EventKind = 'critical' | 'notify' | 'approval';

/**
 * How much of a human this event is asking for.
 *
 *   act   someone is BLOCKED on a person — an approval was raised, a critical
 *         signal fired. Nothing proceeds until a human acts.
 *   info  FYI — a notification, or the lifecycle echo of an approval that is
 *         already over (resolved, expired, superseded). Worth showing, not
 *         worth waking anyone for.
 *
 * The vocabulary is deliberately two semantic words and NOT a platform's
 * notification taxonomy. 'timeSensitive'/'passive' are Apple's names for
 * Apple's interruption levels; putting them on the wire would make the daemon
 * the place where one client OS's policy is encoded, and the next client
 * (Android channels, a desktop toast, a terminal bell) would either inherit a
 * vocabulary that does not fit it or force a second field. `act`/`info` states
 * the FACT — is a person being waited on — and leaves the mapping to whoever
 * is doing the notifying.
 *
 * Additive: a client that does not know the field loses nothing, and the kind
 * it already switches on still carries the same meaning it always did.
 */
type EventTier = 'act' | 'info';

/**
 * One recorded attention event. `payload` is the flattened wire object
 * (`{sessionId, ...event}`) exactly as it goes out live, so a replay and a live
 * delivery are byte-identical apart from framing.
 */
interface AttentionEntry {
  id: number;
  at: number;
  kind: EventKind;
  /**
   * Server-authoritative urgency. Held beside the payload rather than inside
   * it for the same reason `id` and `epoch` are stamped last: the payload of a
   * `critical`/`notify` event is pane-supplied, and a pane must not be able to
   * declare its own event non-urgent by putting a `tier` key in it.
   */
  tier: EventTier;
  payload: Record<string, unknown>;
}

/**
 * The one place tier is decided. `phase` is only consulted for approvals — the
 * create is the ask, everything after it is the echo of an ask that is done.
 *
 * `critical` is NOT uniformly `act`. The kind names the channel, not the
 * severity: `CRITICAL_PATTERNS` carries two risk levels and the daemon puts
 * both on it, so `DELETE FROM` and `kubectl delete` (`review`) arrive beside
 * `rm -rf` and `terraform destroy` (`critical`). Waking a phone for the first
 * pair at the same urgency as the second is how a person learns to ignore the
 * channel — and it would contradict `hasCriticalRisk`, which already answers
 * "is this the dangerous class?" with review-level excluded.
 *
 * Only the exact literal `'review'` softens the tier. An absent, unknown or
 * malformed `riskLevel` stays `act`: the failure that matters is a destructive
 * action delivered quietly, not an FYI delivered loudly. Note that this field
 * is derived by the daemon from its own pattern table — a pane supplies the
 * LINE, never the classification.
 */
function tierFor(kind: EventKind, payload: Record<string, unknown>): EventTier {
  if (kind === 'notify') return 'info';
  if (kind === 'critical') return payload['riskLevel'] === 'review' ? 'info' : 'act';
  return payload['phase'] === 'create' ? 'act' : 'info';
}

/** A resume position: which server generation, and how far into it. */
interface AttentionCursor {
  epoch: string;
  id: number;
}

export class WebTerminalServer {
  private server: http.Server | https.Server | null = null;
  private token = '';
  private opts: WebTerminalStartOptions | null = null;
  private readonly clients = new Set<SseClient>();
  /** Live `/api/events` subscribers — fleet attention, no pane stream attached. */
  private readonly eventClients = new Set<EventClient>();
  /**
   * #782 — devices that opened a pane's turn view, keyed by pane. The
   * non-recording transcript nudge is delivered ONLY to these, so a busy pane's
   * 1Hz nudges never fill another device's SSE channel. `operator` is a watcher
   * too (a browser on the operator token can read turns). Values are watcher
   * keys, not principal objects, so the set stays cheap to consult per nudge.
   */
  private readonly transcriptWatchers = new Map<string, Set<string>>();
  /** Per-pane coalescing timers for the non-recording transcript nudge. */
  private readonly transcriptNudgeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-pane coalescing timers for the non-recording liveness event. */
  private readonly livenessTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Latest liveness state per pane, held for the open coalescing window. */
  private readonly pendingLiveness = new Map<string, AgentLivenessBody>();

  /**
   * Attention replay state.
   *
   * The epoch is minted ONCE per instance, in the constructor: a new daemon
   * process gets a new epoch, which is exactly the boundary at which a client's
   * stored cursor stops meaning anything (ids restart at 1). The OS boot id is
   * deliberately NOT used — two daemon restarts inside one boot would share it
   * and a client would silently replay against the wrong id space.
   *
   * The log survives `stop()`/`start()`: restarting the WEB server is not an
   * event-loss boundary, the daemon kept running and kept recording.
   */
  private readonly attentionEpoch = crypto.randomUUID();
  private attentionSeq = 0;
  private attentionLog: AttentionEntry[] = [];

  // Pairing state (single active code per running server).
  private pairCode = '';
  private pairExpiresAt = 0;
  private pairAttempts = 0;
  /**
   * Hostnames this server answers to. A local HTTP server that accepts any
   * `Host` can be reached by a malicious page that rebinds its own domain to
   * this address (DNS rebinding); the token still gates `/api/*`, but the
   * unauthenticated `/api/pair` route would be reachable and its code burnable.
   */
  private allowedHosts = new Set<string>();
  /** When the current pairing code was minted (throttles regeneration). */
  private pairRegeneratedAt = 0;
  /**
   * The name the operator gave the device they are pairing RIGHT NOW (§3:
   * naming happens before the code is minted, because a roster of UUIDs cannot
   * be operated). Survives an automatic code regeneration — a burned code does
   * not change who the operator was trying to pair — and is cleared the moment
   * a code is successfully redeemed, so the next device cannot inherit it.
   */
  private pendingDeviceName: string | undefined;
  /**
   * Input grant for the device the CURRENT code will register.
   *
   * Taken at the same moment as the name and for the same reason: this is the
   * only point where a human is present to say what the device is FOR. The
   * phone types a code and nothing else, so if the answer is not captured here
   * there is no later moment to capture it in.
   *
   * When nobody states a grant, this falls back to the SERVER's `--allow-input`
   * (see `defaultPendingGrant`). That is not a weaker default, it is the only
   * one that keeps headless hosts working: `wmux web --allow-input` on a box
   * with no GUI mints its pairing code from `start()`, with no operator present
   * to tick anything, and the roster UI that could grant input afterwards does
   * not exist there. Defaulting those to read-only would make every device
   * paired from a terminal permanently mute with no way to fix it — a
   * regression against the behaviour this whole feature is narrowing.
   *
   * A caller that DOES state a grant always wins, which is how the GUI's
   * unticked checkbox still means read-only on an input-enabled server.
   */
  private pendingDeviceAllowInput = false;

  /**
   * The grant a pairing code carries when nobody said. Typing `--allow-input`
   * IS the operator's decision on a host where there is nowhere else to make
   * one; this reads it rather than inventing a stricter answer they cannot act
   * on.
   */
  private defaultPendingGrant(): boolean {
    return this.opts?.allowInput === true;
  }
  /**
   * Outstanding stream tickets, keyed by the ticket itself (B3).
   *
   * In memory only and cleared on stop(): a ticket is a capability to open a
   * stream against THIS running server, so there is nothing to carry across a
   * restart — the client asks for another one, which costs it one request.
   */
  private readonly streamTickets = new Map<string, StreamTicket>();

  // Bound so on()/off() reference the SAME listener across start()/stop().
  private readonly onSessionCritical = (payload: { sessionId: string; event?: unknown }): void =>
    this.broadcastEvent('critical', payload);
  private readonly onSessionNotification = (payload: { sessionId: string; event?: unknown }): void =>
    this.broadcastEvent('notify', payload);
  private readonly onApprovalEvent = (e: ApprovalEvent): void => this.publishApproval(e);
  /**
   * The registry hands back an unsubscribe closure rather than taking off() —
   * so unlike the sessionManager listeners this one is held, not re-derived.
   * Non-null exactly while the server is running.
   */
  private approvalUnsub: (() => void) | null = null;

  // Static assets, loaded once on start and cached in memory (all small).
  private terminalHtml: Buffer | null = null;
  /** Full CSP for the HTML page, with per-build inline-script hashes. */
  private manifest: Buffer | null = null;
  private serviceWorker: Buffer | null = null;
  private icon: Buffer | null = null;
  /**
   * The CSP for the assets currently loaded. Initialized to the asset-less
   * policy (`script-src 'none'`) so a request that somehow arrives before
   * `loadAssets()` is served the locked-down header, never a permissive one.
   */
  private csp: string = buildWebCsp(null);

  /** Lazily-built git runner for `/api/sessions/:id/diff` (see that handler). */
  private git: GitRunner | null = null;

  /**
   * When each session was last resized through `/api/sessions/:id/resize`.
   *
   * Per server rather than module-level, unlike the diff concurrency counter:
   * that one bounds `git` (a machine-wide resource), this one bounds SIGWINCH
   * to sessions this server can see, and a test that starts two servers must
   * not have one inherit the other's history.
   */
  private lastResizeAt = new Map<string, number>();

  /**
   * Upload bodies currently buffering in memory. Bounded by
   * `MAX_CONCURRENT_UPLOADS` — see that constant for why the disk quota does
   * not cover this.
   */
  private inFlightUploads = 0;

  constructor(private readonly deps: WebTerminalServerDeps) {}

  get isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * #783 — whether a permission gate raised right now could actually be
   * ANSWERED. `POST /api/approvals/:id` refuses an `awaiting_permission` record
   * without `--allow-input` (approving a tool runs it), so a read-only server —
   * which is the default — raises a card nobody can resolve, and the agent
   * waits out the full gate deadline for nothing. The daemon checks this before
   * arming, so the two conditions can never drift apart. Deliberately NOT
   * `status()`: that mints pairing codes as a side effect and would run on
   * every tool call.
   */
  get canResolveGates(): boolean {
    return this.server !== null && this.opts?.allowInput === true;
  }

  /** Daemon-internal live state for safe option-only reconfiguration. */
  get currentStartState(): {
    tls: WebTlsConfig | undefined;
    tailscale: boolean;
    host: string;
    token: string;
  } | undefined {
    if (!this.server || !this.opts) return undefined;
    return {
      tls: this.opts.tls ? { ...this.opts.tls } : undefined,
      tailscale: this.opts.tailscale === true,
      host: this.opts.host,
      token: this.token,
    };
  }

  /**
   * Start (or restart) the web server. A running server is stopped first so a
   * second `wmux web --allow-input` cleanly re-applies options.
   *
   * The web token is minted fresh unless the caller supplies one to reuse
   * (`options.token`, #596) — see the field doc for why that seam is
   * daemon-internal only. The pairing code always rotates: it is single-use
   * and short-lived by design, so carrying one across a restart would only
   * hand the phone an already-burned code.
   */
  async start(options: WebTerminalStartOptions): Promise<WebTerminalInfo> {
    // Build the transport before taking an existing listener down. Invalid,
    // unreadable or mismatched PEM files are configuration errors, not a
    // reason to interrupt a server that is already working.
    const server = createTransportServer(options, (req, res) => {
      // Never let a handler error escape into the daemon event loop.
      try {
        this.handle(req, res);
      } catch (err) {
        this.failRequest(res, err);
      }
    });

    if (this.server) {
      await this.stop();
    }
    this.loadAssets();
    this.token = options.token || crypto.randomUUID();
    this.opts = options;
    this.pendingDeviceName = undefined;
    // AFTER `this.opts` is set — the default reads the flag from it.
    this.pendingDeviceAllowInput = this.defaultPendingGrant();
    this.generatePairCode();

    // A malformed request or a client that drops mid-handshake must not crash
    // the daemon. Log and move on.
    server.on('clientError', (_err, socket) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        if (server.listening) server.close();
        this.opts = null;
        this.token = '';
        this.pairCode = '';
        this.pairExpiresAt = 0;
        this.pairAttempts = 0;
        this.pendingDeviceName = undefined;
        this.pendingDeviceAllowInput = false;
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(options.port, options.host);
      } catch (err) {
        onError(err as NodeJS.ErrnoException);
      }
    });

    // Bind failures are returned to the caller by the temporary listener
    // above. Log only errors from an established server here, so one failed
    // start does not produce two indistinguishable daemon log entries.
    server.on('error', (err) => {
      this.deps.log('error', `[web] server error: ${errMsg(err)}`);
    });

    this.server = server;

    // Tee fleet-wide attention signals into EVERY connected SSE client — a
    // viewer watching pane A must still hear that pane B needs an answer.
    // Attached only AFTER the listen succeeded (a failed bind must not leak
    // listeners stop() would never remove) and removed in stop() so restarts
    // rotate cleanly.
    this.deps.sessionManager.on('session:critical', this.onSessionCritical);
    this.deps.sessionManager.on('session:notification', this.onSessionNotification);
    // Approval lifecycle rides the same channel; same attach point, same
    // restart hygiene (unsubscribed in stop(), so a restart never doubles up).
    this.approvalUnsub = this.deps.approvals?.onEvent(this.onApprovalEvent) ?? null;

    // Record the ACTUAL bound port so status()/urls report it even when the
    // caller requested port 0 (ephemeral — used by the unit tests for a
    // hermetic bind that never collides).
    const addr = server.address();
    if (addr && typeof addr === 'object') this.opts.port = addr.port;

    // Host allowlist: loopback names always (the PWA's own origin), plus every
    // concrete address we actually serve on, so a phone hitting the LAN /
    // tailnet IP is accepted while a rebound attacker domain is not.
    this.allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    if (options.host === '0.0.0.0' || options.host === '::') {
      for (const ip of collectIpv4()) this.allowedHosts.add(ip);
    }
    this.allowedHosts.add(options.host);
    // An IPv6 bind arrives in the Host header bracketed (`[fd00::5]:7681`),
    // which is the form the guard normalizes to — allow both spellings.
    if (options.host.includes(':') && !options.host.startsWith('[')) {
      this.allowedHosts.add(`[${options.host}]`.toLowerCase());
    }
    // Operator-supplied extra hostnames (e.g. the machine's MagicDNS name when
    // `tailscale serve` fronts the loopback bind and forwards Host verbatim).
    for (const extra of options.allowedHosts ?? []) {
      const name = extra.trim().toLowerCase();
      if (name) this.allowedHosts.add(name);
    }

    // Boot-time sweep. There is no timer, so this and the pre-write sweep are
    // the only two moments expired photos go away — and a daemon restart is
    // exactly when a directory left behind by yesterday's session gets seen.
    if (this.deps.uploadsDir) pruneUploads(this.deps.uploadsDir, this.now());

    this.deps.log(
      'info',
      `[web] ${options.tls ? 'HTTPS' : 'HTTP'} listening on ${this.opts.host}:${this.opts.port} (input ${options.allowInput ? 'ENABLED' : 'read-only'}, uploads ${options.allowUpload ? 'ENABLED' : 'off'})`,
    );
    return this.status();
  }

  /** Stop the server, end every SSE stream, and drop all bridge listeners. */
  async stop(): Promise<{ stopped: boolean }> {
    if (!this.server) return { stopped: false };

    this.deps.sessionManager.off('session:critical', this.onSessionCritical);
    this.deps.sessionManager.off('session:notification', this.onSessionNotification);
    this.approvalUnsub?.();
    this.approvalUnsub = null;
    this.pairCode = '';
    this.pairExpiresAt = 0;
    this.pairAttempts = 0;
    this.pendingDeviceName = undefined;
    this.pendingDeviceAllowInput = false;
    // Capabilities against a server that is going away. Nothing to preserve.
    this.streamTickets.clear();

    for (const client of this.clients) {
      try {
        client.detach();
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();

    // The attention log and epoch deliberately survive: a client that reconnects
    // after a web-server restart still has a valid cursor into the same daemon.
    for (const client of this.eventClients) {
      try {
        client.detach();
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.eventClients.clear();
    // #782 — clear pending non-recording nudge timers and the watcher set; the
    // SSE clients they would reach are gone, and a fresh start() re-arms nothing
    // stale (a device re-opens its panes and re-registers as it reads them).
    for (const timer of this.transcriptNudgeTimers.values()) clearTimeout(timer);
    this.transcriptNudgeTimers.clear();
    for (const timer of this.livenessTimers.values()) clearTimeout(timer);
    this.livenessTimers.clear();
    this.pendingLiveness.clear();
    this.transcriptWatchers.clear();

    const server = this.server;
    this.server = null;
    this.opts = null;
    this.token = '';

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // close() only fires once every keep-alive socket (SSE streams) drains;
      // force them shut. closeAllConnections is Node 18.2+; guard for older types.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    this.deps.log('info', '[web] stopped');
    return { stopped: true };
  }

  /**
   * Mint a fresh pairing code on operator request.
   *
   * The lazy regeneration in `handlePair` is deliberately rate-limited because
   * it is reachable by whoever can hit the port. This path is different: it is
   * an authenticated control-plane call from the GUI, i.e. the operator asking
   * in person, so it mints immediately. Without it, a consumed or expired code
   * left no way to pair a second device short of restarting the server.
   */
  refreshPairCode(): WebTerminalInfo {
    if (!this.server) return { running: false };
    this.generatePairCode();
    return this.status();
  }

  /**
   * `daemon.web.pairStart {name}` — name the device, THEN mint its code (§3).
   *
   * Separate from `refreshPairCode` rather than a parameter on it because the
   * two answer different questions. `refreshPairCode` is "the code went stale,
   * give me another for whatever I was already doing"; this is "I am about to
   * pair THIS device", which is the only moment a human is present to say what
   * to call it, and the only moment the transport is worth refusing over.
   *
   * The transport check is deliberately made here as well as at redemption:
   * failing at redemption alone means the operator reads a code off the GUI,
   * walks to the phone, types it, and only then learns the server would never
   * have minted anything.
   */
  startPairing(params: { name?: string; allowInput?: boolean } = {}): WebPairStartResult {
    if (!this.server) return { ok: false, error: 'the web server is not running — start it first' };
    const refusal = this.mintRefusal();
    if (refusal) return { ok: false, error: refusal };
    const label = typeof params.name === 'string' ? params.name.trim() : '';
    this.generatePairCode();
    this.pendingDeviceName = label || undefined;
    // `??`, not `===`: an omitted grant inherits the server's, an explicit
    // `false` stays false. Collapsing those two would either mute the GUI's
    // unticked box or mute every headless pairing.
    this.pendingDeviceAllowInput = params.allowInput ?? this.defaultPendingGrant();
    return { ok: true, code: this.pairCode, expiresAt: this.pairExpiresAt };
  }

  /**
   * End every live SSE stream held by one device, right now.
   *
   * This is the teardown half of revocation (§5), and it is a METHOD rather
   * than a listener on the store so the ordering is visible at the call site:
   * `daemon.web.deviceRevoke` persists first, checks the write succeeded, and
   * only then calls this. A device the operator believes is gone must not be
   * watching panes until its next reconnect, and a stream that outlives the
   * roster entry is exactly that.
   *
   * Returns how many connections were closed, so the RPC can report it. The
   * operator's own streams and every other device's are untouched.
   */
  disconnectDevice(deviceId: string): number {
    if (!deviceId) return 0;
    const isTarget = (p: WebPrincipal): boolean => p.kind === 'device' && p.deviceId === deviceId;
    // Outstanding tickets die with the device (B3). Closing the streams alone
    // would leave a revoked phone holding a capability that reopens one for up
    // to the ticket TTL — a revocation with a two-minute hole in it.
    for (const [ticket, held] of [...this.streamTickets]) {
      if (held.deviceId === deviceId) this.streamTickets.delete(ticket);
    }
    let closed = 0;
    for (const client of [...this.clients]) {
      if (!isTarget(client.principal)) continue;
      this.clients.delete(client);
      closed += 1;
      try {
        client.detach();
        client.res.end();
      } catch {
        /* socket already gone — the end state we wanted either way */
      }
    }
    for (const client of [...this.eventClients]) {
      if (!isTarget(client.principal)) continue;
      this.eventClients.delete(client);
      closed += 1;
      try {
        client.detach();
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    if (closed > 0) {
      this.deps.log('info', `[web] revoked device ${deviceId}: closed ${closed} live stream(s)`);
    }
    return closed;
  }

  /**
   * `POST /api/stream-ticket` — trade a device credential (header, as always)
   * for a short-lived capability that MAY ride a query string.
   *
   * Devices only. The operator token already opens a stream with `?token=`, and
   * handing the operator a second way in would grow this into a parallel auth
   * system for no gain — the ticket exists solely because `EventSource` cannot
   * set headers, and the native app (URLSession sets headers on a streaming
   * request freely) will never need one either.
   */
  private issueStreamTicket(principal: WebPrincipal): { ticket: string; expiresAt: number } | null {
    if (principal.kind !== 'device') return null;
    this.pruneStreamTickets();
    const ticket = crypto.randomBytes(STREAM_TICKET_BYTES).toString('base64url');
    const expiresAt = Date.now() + STREAM_TICKET_TTL_MS;
    this.streamTickets.set(ticket, {
      deviceId: principal.deviceId,
      ...(principal.name ? { name: principal.name } : {}),
      expiresAt,
    });
    return { ticket, expiresAt };
  }

  /**
   * Turn a presented ticket back into the device that asked for it, or `null`.
   *
   * A plain Map lookup, deliberately: the ticket is 256 bits of CSPRNG with a
   * two-minute life, so the only thing a timing difference could reveal is
   * whether a key the caller already chose exists — and finding one by guessing
   * is 2^256 work inside a 120-second window. There is no stored secret to
   * compare against here, which is the whole difference between a capability
   * and a credential.
   *
   * NOT single-use. `EventSource` retries the SAME url on its own, so burning
   * the ticket on first use would turn every ordinary reconnect into a
   * permanent failure with no way for the page to notice or recover.
   */
  private resolveStreamTicket(raw: string | null): WebPrincipal | null {
    if (!raw) return null;
    const held = this.streamTickets.get(raw);
    if (!held) return null;
    if (Date.now() > held.expiresAt) {
      this.streamTickets.delete(raw);
      return null;
    }
    // `allowInput: false`, ALWAYS — a stream ticket is a read capability, not a
    // credential. It is handed out for the two SSE routes because EventSource
    // cannot set headers, it lives two minutes, and it is not re-checked against
    // the roster while it does. Baking a grant into it would mean an input
    // permission that survives the operator taking it away, on the one object
    // here that is deliberately not revalidated. Nothing behind a ticket writes
    // today; this keeps that true if a future route forgets.
    return {
      kind: 'device',
      deviceId: held.deviceId,
      ...(held.name ? { name: held.name } : {}),
      allowInput: false,
    };
  }

  /** Drop expired tickets, then the oldest if the cap is still exceeded. */
  private pruneStreamTickets(): void {
    const now = Date.now();
    for (const [ticket, held] of [...this.streamTickets]) {
      if (now > held.expiresAt) this.streamTickets.delete(ticket);
    }
    if (this.streamTickets.size < MAX_STREAM_TICKETS) return;
    const byAge = [...this.streamTickets].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const excess = this.streamTickets.size - MAX_STREAM_TICKETS + 1;
    for (let i = 0; i < excess && i < byAge.length; i++) this.streamTickets.delete(byAge[i][0]);
  }

  /**
   * Why a durable device secret must not be minted over this transport, or
   * `null` when it may be.
   *
   * The shared operator token was survivable in cleartext partly because it
   * died on restart; #599 made it durable and M3 makes the per-device one
   * durable too, so `--expose` without a TLS front now means handing a
   * long-lived secret to anything on the LAN. Loopback is fine (nothing
   * off-machine reaches it). A host the operator listed with `--allow-host` is
   * fine because `tailscale serve` fronts a loopback bind. A native TLS
   * listener is also fine because the listener type — unlike a Host header —
   * is server-controlled evidence that the handover was encrypted.
   *
   * The redeeming request's `Host` is deliberately irrelevant here: the caller
   * writes it. Only the server's bind can prove whether bytes stayed local.
   *
   * NOTE this refuses minting for a browser sitting at `127.0.0.1` on an
   * exposed server too. That is not an oversight: on a `0.0.0.0` bind the Host
   * header is caller-chosen and proves nothing about where the bytes came from,
   * so the bind is the only honest thing to judge. The operator token path is
   * untouched — this gate only guards NEW durable device credentials.
   */
  private mintRefusal(): string | null {
    // Unlike a Host header, the listener type is server-controlled evidence:
    // this connection reached an HTTPS socket before HTTP routing began.
    if (this.opts?.tls) return null;
    const bind = this.opts?.host ?? '';
    // The BIND is the only honest judge, and for a while this also accepted a
    // request whose `Host` matched `--allow-host`. That was wrong: `Host` is
    // written by the caller. On a wildcard bind anyone who could reach the port
    // — and had the pair code — could send `Host: <the tailnet name>` straight
    // to the plaintext LAN address, skip the TLS front entirely, and collect a
    // credential that never expires. A header cannot be evidence that a
    // connection was encrypted.
    //
    // Nothing legitimate is lost by dropping it. `wmux web --tailscale` binds
    // 127.0.0.1 and lets `tailscale serve` front it (see
    // decideTailscaleBinding), so the normal tailnet flow takes the loopback
    // exit above and never reaches here. What now refuses is specifically
    // `--expose` + `--allow-host`, where the port really is answering in
    // plaintext on every interface — the case the CLI already warns about.
    // `--allow-host` keeps its other job: the Host allowlist that blocks DNS
    // rebinding.
    if (webHostIsLoopback(bind)) return null;
    return (
      `refusing to mint a device credential: this server is bound to ${bind || 'a non-loopback address'} ` +
      'over plain HTTP, and a device secret never expires. Three ways forward: (1) add ' +
      '`--tls-cert <certificate>` and `--tls-key <private-key>` so wmux terminates HTTPS; ' +
      '(2) run `wmux web --tailscale` on its own, which binds loopback and lets ' +
      '`tailscale serve` terminate HTTPS for your tailnet; or (3) pair over loopback BEFORE exposing, which ' +
      'keeps the handover off the wire — though a plaintext bind still carries the credential ' +
      'on every later request, so (1) or (2) is what actually protects it.'
    );
  }

  status(): WebTerminalInfo {
    if (!this.server || !this.opts) return { running: false };
    // Ask BEFORE minting. `activePairCode` regenerates lazily, so on a server
    // that cannot mint a credential it would hand the operator a fresh code
    // every poll — each one guaranteed to answer 403 when a phone redeems it.
    // Reading the code off a screen onto a phone and only then learning it was
    // never going to work is the bug this closes.
    const refusal = this.pairRefusal();
    if (refusal) {
      return {
        running: true,
        port: this.opts.port,
        host: this.opts.host,
        allowInput: this.opts.allowInput,
        allowUpload: this.opts.allowUpload,
        allowTranscript: this.opts?.allowTranscript === true,
        tls: this.opts.tls !== undefined,
        token: this.token,
        urls: this.buildUrls(),
        clients: this.clients.size,
        deviceCredentials: !!this.deps.devices,
        allowedHosts: this.advertisedHosts(),
        tailscale: this.opts.tailscale === true,
        pairRefusal: refusal,
      };
    }
    const pair = this.activePairCode();
    return {
      running: true,
      port: this.opts.port,
      host: this.opts.host,
      allowInput: this.opts.allowInput,
      allowUpload: this.opts.allowUpload,
      allowTranscript: this.opts.allowTranscript === true,
      tls: this.opts.tls !== undefined,
      token: this.token,
      urls: this.buildUrls(),
      clients: this.clients.size,
      pairCode: pair.code,
      pairExpiresAt: pair.expiresAt,
      deviceCredentials: !!this.deps.devices,
      allowedHosts: this.advertisedHosts(),
      tailscale: this.opts.tailscale === true,
      // Only meaningful alongside a live code: `activePairCode` can regenerate
      // lazily, and a regenerated code has no name behind it even if the one it
      // replaced did.
      ...(pair.code && this.pendingDeviceName
        ? {
            pendingDeviceName: this.pendingDeviceName,
            pendingDeviceAllowInput: this.pendingDeviceAllowInput,
          }
        : {}),
    };
  }

  /**
   * The status-surface form of `mintRefusal`: a reason the UI can switch on,
   * plus the operator prose for logs and tooltips.
   *
   * Deliberately derived from `mintRefusal` rather than re-deriving the
   * predicate. Two copies of "can this server mint a credential?" would drift,
   * and the copy that drifts is the one that decides what the operator is
   * shown, not the one that decides what the wire allows.
   */
  private pairRefusal(): PairRefusal | undefined {
    const detail = this.mintRefusal();
    return detail ? { reason: 'insecure-transport', detail } : undefined;
  }

  /**
   * The pairing code as far as the OPERATOR surfaces (status/CLI/GUI) are
   * concerned. A code past its TTL must never be advertised — the phone would
   * only be told "expired" — so an expired code is dropped here and, when the
   * regeneration cooldown allows, replaced with a fresh one on the spot.
   */
  private activePairCode(): { code?: string; expiresAt?: number } {
    if (this.pairCode && Date.now() <= this.pairExpiresAt) {
      return { code: this.pairCode, expiresAt: this.pairExpiresAt };
    }
    this.pairCode = '';
    if (Date.now() - this.pairRegeneratedAt >= PAIR_REGEN_COOLDOWN_MS) {
      this.generatePairCode();
      return { code: this.pairCode, expiresAt: this.pairExpiresAt };
    }
    return {};
  }

  // --- request routing ---------------------------------------------------

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    // Reject anything addressed to a host we do not serve (DNS-rebinding guard).
    // Checked before routing so it also covers the unauthenticated /api/pair.
    const hostHeader = req.headers.host ?? '';
    // Strip the port; keep IPv6 literals ("[::1]:7681") intact.
    const hostname = hostHeader.startsWith('[')
      ? hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase()
      : hostHeader.split(':')[0].toLowerCase();
    if (!this.allowedHosts.has(hostname)) {
      return this.json(res, 403, { error: 'host not allowed' });
    }

    // Static, unauthenticated app shell (no secrets live in these). `/pair`
    // is the same SPA shell — the frontend renders the pairing screen for it.
    if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/pair')) {
      // The whole app is inlined into this one file and it is rebuilt on every
      // release, so a stale copy is not a slightly-old page — it is the old
      // client talking to a new daemon. With no Cache-Control and no validator
      // a browser is free to heuristically cache it, which during dogfooding
      // meant a phone kept running a build that had already been fixed, with
      // nothing on either side to say so. `no-store` because there is nothing
      // worth revalidating: the payload is either current or wrong.
      return this.serveStatic(res, this.terminalHtml, 'text/html; charset=utf-8', {
        'Cache-Control': 'no-store',
        ...(this.csp ? { 'Content-Security-Policy': this.csp } : {}),
      });
    }
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      // Same reasoning as the shell: a cached manifest pins an installed app's
      // name, icons and start_url to whatever it first saw.
      return this.serveStatic(res, this.manifest, 'application/manifest+json; charset=utf-8', {
        'Cache-Control': 'no-cache',
      });
    }
    if (req.method === 'GET' && p === '/sw.js') {
      // A service worker may only control the scope it is served from; keep it
      // at the root and mark it non-cacheable so updates land immediately.
      return this.serveStatic(res, this.serviceWorker, 'text/javascript; charset=utf-8', {
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
    }
    if (req.method === 'GET' && (p === '/icon-192.png' || p === '/icon-512.png' || p === '/favicon.ico')) {
      return this.serveStatic(res, this.icon, 'image/png');
    }

    // Pairing exchange is the ONLY unauthenticated /api route: it trades a
    // short single-use code for the real token, so it cannot itself require the
    // token. Placed before the /api/* auth gate.
    if (req.method === 'GET' && p === '/api/pair') {
      // Cross-site loads (an `<img src="http://127.0.0.1:7681/api/pair?…">` on
      // any web page) pass the Host guard because they target the loopback
      // literal directly — and this is the one unauthenticated route, so five
      // such loads would burn the pairing code. Browsers stamp those requests
      // `Sec-Fetch-Site: cross-site`; refuse them before touching the attempt
      // budget. Same-origin fetches from the pairing page, direct navigation
      // ('none'), and non-browser clients (header absent) are unaffected.
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        return this.json(res, 403, { error: 'cross-site request refused' });
      }
      this.handlePair(res, url).catch((err: unknown) => this.failRequest(res, err));
      return;
    }

    if (p.startsWith('/api/')) {
      // Verifying a device credential means running a KDF, which is async by
      // construction, so the whole /api/* branch sits behind one await. The
      // route table itself is unchanged — see handleApi.
      this.handleApi(req, res, url, p).catch((err: unknown) => this.failRequest(res, err));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  /**
   * Everything under `/api/*`: authenticate, then route.
   *
   * Both credential forms are accepted here (operator token, device
   * credential), and the ROUTES do not care which — a paired phone can list
   * panes, watch a stream and answer an approval exactly as the operator can.
   * What differs is only what a revoke can take away, which is why the
   * principal is carried into the two SSE handlers and nowhere else.
   */
  private async handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    p: string,
  ): Promise<void> {
    // `/api/events` answers in two shapes on one route: an EventSource (which
    // cannot set headers, so it gets the same `?token=` exception as
    // `/api/stream`) and a plain JSON backlog fetch (Bearer only, like every
    // other endpoint). The Accept header decides which, and therefore also
    // which auth rule applies.
    const wantsEventStream =
      req.method === 'GET' &&
      p === '/api/events' &&
      String(req.headers.accept ?? '').includes('text/event-stream');
    const isStream = (req.method === 'GET' && p === '/api/stream') || wantsEventStream;
    const auth = await this.authenticate(req, url, isStream);
    if (!auth.ok) {
      // The reason is the point: #599's 401 screen had to guess between "the
      // server restarted" and "you were thrown out", and guessed wrong either
      // way. `revoked` is the operator's decision and deserves its own copy.
      //
      // IT IS COPY, NOT A CLAIM. `revoked` comes from a deviceId lookup alone —
      // the store answers it WITHOUT verifying the secret, deliberately, so a
      // revoked phone reconnecting in a loop cannot force a KDF derivation per
      // retry. So this field says "a credential naming this device was
      // presented", not "the holder proved they are that device". Never let
      // anything but wording key on it.
      return this.json(res, 401, { error: 'unauthorized', reason: auth.reason });
    }
    const principal = auth.principal;
    if (req.method === 'GET' && p === '/api/config') {
      // The handshake rides HERE rather than on a route of its own: this is
      // already the first call a client makes after pairing, so a dedicated
      // /api/version would be a second round trip that only pre-handshake
      // daemons could fail — exactly the daemons it exists to detect. A client
      // talking to one of those gets a body with no version keys at all, which
      // reads as "protocol 0", the same way a missing `allowUpload` reads as
      // false.
      return this.json(res, 200, {
        // THIS CALLER's effective grant, not the server flag. A phone paired
        // read-only asks the same question a phone paired with input does, and
        // answering with the server-wide value would hand it a keyboard the
        // write routes then refuse — a read-only device showing a live composer
        // that 403s on every keystroke.
        allowInput: this.mayInput(principal),
        allowUpload: this.opts?.allowUpload === true,
        allowTranscript: this.opts?.allowTranscript === true,
        // #783 — the gated-tools list so the phone can say "this Bash call is
        // waiting because Bash is in the gate list". Absent gateConfig → empty
        // array (a daemon that predates the gate or did not wire it).
        gatedTools: this.deps.gateConfig?.().gatedTools ?? [],
        // #783 — whether the gate is armed right now, so a client's toggle opens
        // showing the truth instead of a default it has to correct on first
        // write. Omitted (not defaulted) when the daemon did not wire the getter:
        // a client reading a missing key as "off" would be wrong on every daemon
        // that predates this, and the gate defaults to ON.
        //
        // EFFECTIVE, not the runtime flag alone. The daemon arms the gate only
        // when `gateRuntimeOff` is clear AND this server can actually resolve a
        // gate — a read-only server (the default) raises cards nobody can
        // answer, so it lets every tool through. Reporting the flag by itself
        // would tell a phone the gate is on while nothing is being held.
        ...(this.deps.gateEnabled
          ? { gateEnabled: this.deps.gateEnabled() && this.canResolveGates }
          : {}),
        protocolVersion: PHONE_PROTOCOL_VERSION,
        minProtocolVersion: MIN_PHONE_PROTOCOL_VERSION,
        serverVersion: daemonServerVersion(),
      });
    }
    if (req.method === 'GET' && p === '/api/sessions') {
      return this.json(res, 200, { sessions: this.listSessions() });
    }
    if (req.method === 'GET' && p === '/api/workspaces') {
      return this.handleWorkspacesList(res);
    }
    if (req.method === 'POST' && p === '/api/sessions') {
      return this.handleSessionCreate(req, res, principal);
    }
    if (p.startsWith('/api/sessions/')) {
      const rest = p.slice('/api/sessions/'.length);
      if (req.method === 'GET' && rest.endsWith('/diff')) {
        return this.handleSessionDiff(res, rest.slice(0, -'/diff'.length));
      }
      if (req.method === 'GET' && rest.endsWith('/turns/block')) {
        return this.handleSessionTurnBlock(req, res, rest.slice(0, -'/turns/block'.length));
      }
      if (req.method === 'GET' && rest.endsWith('/turns')) {
        return this.handleSessionTurns(req, res, rest.slice(0, -'/turns'.length), principal);
      }
      if (req.method === 'POST' && rest.endsWith('/resize')) {
        return this.handleSessionResize(req, res, rest.slice(0, -'/resize'.length));
      }
      if (req.method === 'DELETE') {
        return this.handleSessionDelete(res, rest, principal);
      }
    }
    if (req.method === 'GET' && p === '/api/stream') {
      return this.handleStream(req, res, url, principal);
    }
    if (req.method === 'GET' && p === '/api/events') {
      return wantsEventStream
        ? this.handleEventStream(req, res, url, principal)
        : this.handleEventBacklog(res, url);
    }
    if (req.method === 'POST' && p === '/api/stream-ticket') {
      const issued = this.issueStreamTicket(principal);
      if (!issued) {
        return this.json(res, 403, {
          error: 'tickets-are-for-devices',
          detail:
            'stream tickets exist so a paired device can open an EventSource, which cannot set headers. ' +
            'The operator token opens a stream with ?token= directly.',
        });
      }
      return this.json(res, 200, issued);
    }
    if (req.method === 'POST' && p === '/api/push-registration') {
      return this.handlePushRegistration(req, res, principal);
    }
    if (req.method === 'POST' && p === '/api/input') {
      return this.handleInput(req, res, url, principal);
    }
    if (req.method === 'POST' && p === '/api/upload') {
      return this.handleUpload(req, res);
    }
    if (req.method === 'GET' && p === '/api/approvals') {
      return this.handleApprovalsList(res);
    }
    if (req.method === 'POST' && p.startsWith('/api/approvals/')) {
      return this.handleApprovalResolve(req, res, p.slice('/api/approvals/'.length), principal);
    }
    // #783 — runtime escape hatch: stop holding tool calls for a remote answer,
    // from the next call on. This WIDENS what proceeds without remote review
    // (high-risk tools stop waiting for the phone), so it takes the same grant
    // as typing — a view-only device must not be able to disarm the gate
    // (review: Claude). `/api/gate/on` re-arms it, so the hatch is symmetric
    // and a phone that turned it off can put it back.
    if (req.method === 'POST' && (p === '/api/gate/off' || p === '/api/gate/on')) {
      if (!this.mayInput(principal)) {
        return this.refuseInput(
          res,
          principal,
          'disarming the permission gate lets tools run without remote review — it needs the same grant as typing',
        );
      }
      if (!this.deps.setGateEnabled) return this.json(res, 503, { error: 'gate control unavailable' });
      const enable = p === '/api/gate/on';
      this.deps.setGateEnabled(enable);
      // The gate is DAEMON-wide, so a phone that disarms it changes what every
      // other paired device is looking at. Without this push the other devices
      // keep showing the old toggle until something else makes them re-read
      // `/api/config`, which for a screen nobody navigated away from is never.
      this.broadcastGateState(enable);
      return this.json(res, 200, {
        ok: true,
        gateEnabled: enable,
        detail: enable
          ? 'gate on — gated tools wait for a remote answer again'
          : 'gate off — the next tool call proceeds without prompting',
      });
    }
    return this.json(res, 404, { error: 'not found' });
  }

  /** Last-resort 500 for a handler that threw or rejected. */
  private failRequest(res: http.ServerResponse, err: unknown): void {
    this.deps.log('warn', `[web] request handler threw: ${errMsg(err)}`);
    try {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    } catch {
      /* socket already gone */
    }
  }

  private listSessions(): Array<{
    id: string;
    cwd: string;
    cols: number;
    rows: number;
    state: string;
    agent: string | null;
    lastActivity: string;
    workspace?: string;
    /** Short program name (`pwsh`, `bash`) — what to call a pane with no agent. */
    shell?: string;
  }> {
    return this.deps.sessionManager.listLiveSessions()
      // The orchestrator brain's own TUI is not a worker pane: it must not show
      // up in the phone's pane list (nor be attachable/approvable from there),
      // exactly as the fleet pane listing already excludes it. Same shared
      // predicate — env marker first, id prefix as the fallback.
      .filter((s) => !isBrainPty({ id: s.id, env: s.env }))
      .map((s) => ({
        id: s.id,
        cwd: s.cwd,
        cols: s.cols,
        rows: s.rows,
        state: s.state,
        agent: s.agent?.displayName ?? s.lastDetectedAgent ?? null,
        lastActivity: s.lastActivity,
        ...workspaceLabelOf(s.env),
        ...shellLabelOf(s.cmd),
      }));
  }

  /**
   * `GET /api/workspaces` — live workspaces, derived from session env.
   *
   * Same provenance as `rejectWorkspaceId` (main force-stamps
   * `WMUX_WORKSPACE_ID` at spawn; the daemon persists the resolved env), so a
   * workspace exists here iff at least one live pane runs in it. The uuid id
   * IS surfaced — unlike the label-only `/api/sessions` field — because
   * attach needs an address, and this route sits behind the same bearer auth
   * that already exposes full scrollback.
   */
  private handleWorkspacesList(res: http.ServerResponse): void {
    const byId = new Map<string, { id: string; name: string; panes: RemotePaneSummary[] }>();
    for (const s of this.deps.sessionManager.listLiveSessions()) {
      // Same exclusion as /api/sessions: the orchestrator brain pane must be
      // neither listed nor allowed to synthesize a phantom workspace row.
      if (isBrainPty({ id: s.id, env: s.env })) continue;
      const id = s.env?.[ENV_KEYS.WORKSPACE_ID];
      if (typeof id !== 'string' || !id) continue; // no workspace id → unaddressable, omitted
      const entry = byId.get(id) ?? { id, name: '', panes: [] };
      if (!entry.name) {
        const n = s.env?.[ENV_KEYS.WORKSPACE_NAME];
        if (typeof n === 'string' && n.trim()) entry.name = n.trim();
      }
      entry.panes.push({ sessionId: s.id, ...shellLabelOf(s.cmd), ...(s.cwd ? { cwd: s.cwd } : {}) });
      byId.set(id, entry);
    }
    const workspaces = [...byId.values()]
      .map((w) => ({ ...w, panes: w.panes.sort((a, b) => a.sessionId.localeCompare(b.sessionId)) }))
      // Named workspaces sort first, alphabetically; unnamed ones sort last.
      // An explicit boolean tiebreak (not a '￿' sentinel) because ICU
      // collation may treat noncharacters as ignorable, which would invert
      // the unnamed-last intent depending on locale.
      .sort((a, b) => {
        const aUnnamed = a.name === '';
        const bUnnamed = b.name === '';
        if (aUnnamed !== bUnnamed) return aUnnamed ? 1 : -1;
        return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      });
    return this.json(res, 200, { workspaces });
  }

  // --- pane diff (read-only git) -------------------------------------------

  /**
   * `GET /api/sessions/:id/diff` — what has this pane's repository changed?
   *
   * The route exists for the approval screen. Answering "may I edit this file?"
   * from a phone means deciding with a screen tail and nothing else; the pane's
   * working tree already holds the real answer, so this reads it.
   *
   * READ-ONLY, and available on a read-only server — it is strictly narrower
   * than `/api/approvals/:id` (which writes keystrokes): it runs four fixed
   * read-only git commands and returns text. It is NOT gated on `--allow-input`
   * for that reason, and the same Bearer gate as every other route still
   * applies, so this is not a new reader.
   *
   * The cwd is looked up from the daemon's own session record. Nothing in the
   * request names a directory, a ref, or a pathspec — see sessionDiff.ts for
   * why the argv is a constant.
   *
   * IT IS `meta.spawnCwd`, NOT `meta.cwd`. `meta.cwd` is live: the daemon
   * rewrites it whenever the pane's process emits an OSC 7 sequence
   * (DaemonSessionManager's `cwd` bridge handler), and ANY process running in
   * that pane can emit one — it is three bytes of terminal output, not a
   * privileged operation. Diffing `meta.cwd` would therefore let a hostile
   * process inside a pane aim this route at any directory on the machine and
   * read the resulting patch back over the web API. `spawnCwd` is written once
   * at spawn from the daemon's own record and never updated, so the directory
   * being read is the one an operator actually chose.
   *
   * `not-a-git-repo` is a 409, not a 500: a pane running in `~` is completely
   * normal and the phone should say "no repository here", not "something broke".
   */
  private async handleSessionDiff(res: http.ServerResponse, rawId: string): Promise<void> {
    const id = decodePathSegment(rawId);
    if (id === null) return this.json(res, 404, { error: 'session not found' });
    const managed = this.deps.sessionManager.getSession(id);
    if (!managed) return this.json(res, 404, { error: 'session not found' });

    // Absent only for a session record written before spawnCwd existed. Every
    // live session goes through DaemonSessionManager.createSession, which sets
    // it, so this is a belt-and-braces refusal rather than a reachable path —
    // and refusing is the right way round: falling back to `meta.cwd` would
    // reopen the hole above for exactly the sessions we cannot vouch for.
    const cwd = managed.meta.spawnCwd;
    if (!cwd) return this.json(res, 409, { error: 'not-a-git-repo' });

    // Built once and cached: the default runner closes over nothing per-call,
    // and constructing one per request would be noise in a hot approval screen.
    this.git ??= this.deps.git ?? createGitRunner();
    const git = this.git;

    let work = inFlightDiffs.get(id);
    if (!work) {
      if (activeDiffs >= MAX_CONCURRENT_DIFFS) {
        return this.json(res, 429, { error: 'busy' });
      }
      activeDiffs += 1;
      work = collectSessionDiff(cwd, git).finally(() => {
        activeDiffs -= 1;
        inFlightDiffs.delete(id);
      });
      inFlightDiffs.set(id, work);
    }

    let result: SessionDiffResult;
    try {
      result = await work;
    } catch (err) {
      // collectSessionDiff returns failures as data, so this is a bug rather
      // than a git problem — but an unhandled rejection here would take the
      // daemon down, and every coalesced waiter must be answered.
      this.deps.log('warn', `[web] diff threw for ${id}: ${errMsg(err)}`);
      return this.json(res, 500, { error: 'git-failed' });
    }
    if (!result.ok) {
      if (result.reason === 'not-a-git-repo') {
        return this.json(res, 409, { error: 'not-a-git-repo' });
      }
      // Detail-free on the wire: git's stderr can name paths, remotes and
      // config keys, and the client's only useful action ("it broke, retry")
      // does not depend on which. The operator gets the text in the log.
      this.deps.log('warn', `[web] diff failed for ${id}: ${result.detail ?? ''}`);
      return this.json(res, 500, { error: 'git-failed' });
    }
    // `no-store`, like the app shell: a 200 GET with no validator is
    // heuristically cacheable, and this is the one payload an approval decision
    // is made against. A phone — or an intermediary — replaying yesterday's
    // patch under today's prompt is the exact failure this route exists to
    // prevent.
    return this.json(res, 200, result.diff, { 'Cache-Control': 'no-store' });
  }

  // --- pane geometry -------------------------------------------------------

  /**
   * `POST /api/sessions/:id/resize` — body `{cols, rows}`, answer
   * `{cols, rows, owner}`.
   *
   * WHY THE ROUTE EXISTS. A desk pane is commonly 151×47. A phone rendering
   * that faithfully has two choices, and both are bad: shrink the font until 151
   * columns fit (unreadable) or letterbox (a third of the screen wasted, and the
   * agent's output still wrapped for a screen nobody is looking at). The daemon
   * is the only thing that can fix it, because the wrapping happens in the PTY,
   * before any client sees a byte.
   *
   * WHO OWNS THE SIZE, when a desk and a phone watch the same PTY. The desk
   * does, whenever it is attached. There is exactly one PTY behind both views
   * and one geometry it can have, so this is a choice between breaking the
   * phone's layout and breaking the layout of a window somebody is looking at
   * on a 27" display — and the desk client re-derives its geometry from its own
   * pane bounds on every layout pass, so "let the last writer win" is not a
   * policy but a fight: the phone resizes, the desk's next frame resizes back,
   * and the PTY thrashes between two geometries while both views redraw.
   *
   * So (#766, visibility-based ownership): `attached` AND VISIBLE — a desk
   * renderer has this pane wired and is actually showing it (workspace + tab
   * active, window not hidden; `ManagedSession.viewerVisible`, reported by the
   * renderer) → `409 desk-owns-size`, carrying the current geometry so the
   * caller can render to it without a second request. `detached`, or attached
   * but not visible (background workspace, inactive tab, minimized window) →
   * the phone's numbers are applied: nobody is looking at the layout the
   * phone would break, so the fight the paragraph above describes cannot
   * start — the hidden renderer's fit is silent (zero-size container guard)
   * until the pane is revealed again. A pane the desk attaches or reveals
   * re-fits itself and resizes unconditionally, so ownership returns without
   * anything here having to take it back.
   *
   * NOT GATED ON `--allow-input`, on the same reasoning as
   * `GET /api/sessions/:id/diff` and `POST /api/approvals/:id`: this delivers a
   * SIGWINCH and changes two numbers on a struct. No byte reaches the child's
   * stdin, nothing is executed, and a caller who could resize but not type has
   * gained nothing it could not already do by reading the pane. The Bearer gate
   * still applies, so this is not a new reader either. The worst a hostile
   * paired device achieves is an awkward geometry on a pane nobody is attached
   * to, which the next desk attach corrects.
   */
  /**
   * `GET /api/sessions/:id/turns` — the phone turn-view contract (#782).
   * STATELESS: reads `delta()`/`snapshot()`, NEVER `subscribe()`. A phone that
   * opened the pane cannot scramble the desktop Chat View sharing the session.
   *
   * Gating mirrors the other grants: `--allow-transcript` off → 403 tagged
   * `transcript-disabled:`, the same machine-readable prefix convention
   * `/api/upload` set with `uploads-disabled:` — the prose after the colon may
   * be reworded, the tag may not, so a client matches on the tag. (A pre-flag
   * daemon returns no `allowTranscript` field at all, which the phone reads as
   * false → mirror fallback, without ever seeing this 403.)
   * A projector the daemon did not wire → 503. `no-binding` and friends are a
   * 200 body, never a 500 — the phone must distinguish "off" from "broken". */
  private handleSessionTurns(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string,
    principal: WebPrincipal,
  ): void {
    // Transcript pages can contain thinking blocks, full tool inputs, and file
    // contents. Keep every response on this route out of client/intermediary
    // caches so revoking transcript access does not leave a replayable copy.
    res.setHeader('Cache-Control', 'no-store');
    if (this.opts?.allowTranscript !== true) {
      this.json(res, 403, {
        error: 'transcript-disabled: server started without --allow-transcript',
        detail: 'restart with: wmux web --allow-transcript <your other flags>',
      });
      return;
    }
    // Unknown pane → 404, the same contract as the other `/api/sessions/:id/*`
    // routes: a phone that fetched a pane id the daemon no longer owns learns the
    // pane is gone, not that its conversation is unavailable. A brain pty answers
    // the same way — see readableSession.
    if (!this.readableSession(sessionId)) {
      this.json(res, 404, { error: 'session not found' });
      return;
    }
    const projector = this.deps.projector?.() ?? null;
    if (!projector) {
      this.json(res, 503, { error: 'transcript projector unavailable' });
      return;
    }
    // #782 — past the gates, this device is reading the pane's turn view, so
    // the non-recording nudge knows to reach it. Idempotent and never undone: a
    // device that closes its SSE simply is not in `eventClients` next time, and
    // a dangling watcher is a cheap no-op rather than a leak.
    this.noteTranscriptWatcher(sessionId, principal);

    const url = new URL(req.url ?? '/', 'http://localhost');
    const dir = (url.searchParams.get('dir') ?? 'forward') === 'back' ? 'back' : 'forward';
    const decoded = decodeTurnCursor(url.searchParams.get('cursor'));

    const status = projector.status(sessionId);
    if (!status.available) {
      this.json(res, 200, { available: false, reason: status.reason });
      return;
    }

    if (dir === 'back' || !decoded) {
      // First read (no cursor) or backward paging: a snapshot. The phone pages
      // BACK from a cursor's head; forward deltas ride the tail.
      const before = decoded && dir === 'back' ? decoded.head : undefined;
      const page = projector.snapshot(sessionId, before !== undefined ? { before } : undefined);
      if (!page) {
        this.json(res, 200, { available: false, reason: 'unreadable' });
        return;
      }
      this.json(res, 200, {
        available: true,
        events: page.events,
        cursor: encodeTurnCursor(page.cursor),
        hasMore: page.hasMore,
        ...(page.truncatedHead ? { truncatedHead: true } : {}),
      });
      return;
    }

    const result = projector.delta(sessionId, decoded.tail, {
      cursorFileSize: decoded.fileSize,
    });
    if (!result) {
      this.json(res, 200, { available: false, reason: 'unreadable' });
      return;
    }
    this.json(res, 200, {
      available: true,
      events: result.events,
      cursor: encodeTurnCursor(result.cursor),
      reset: result.reset,
      ...(result.budgetDropped ? { budgetDropped: true } : {}),
    });
  }

  /**
   * The pane a phone is allowed to READ, or null.
   *
   * `getSession` alone is not that question. The orchestrator brain's own TUI is
   * a live daemon session, and `listSessions` already excludes it from the phone
   * — it is not a worker pane, and it must not be attachable or approvable from
   * a phone. The transcript routes checked existence only, so a device that
   * learned a brain id (the prefix is guessable, and an approval or notify event
   * can carry one) could read the orchestrator's whole conversation. Same 404 as
   * a missing pane on purpose: "not yours to read" and "gone" are one answer
   * here, and a distinct error would confirm the id.
   */
  private readableSession(sessionId: string): ReturnType<DaemonSessionManager['getSession']> {
    const managed = this.deps.sessionManager.getSession(sessionId);
    if (!managed) return undefined;
    return isBrainPty({ id: sessionId, env: managed.meta.env }) ? undefined : managed;
  }

  /**
   * `GET /api/sessions/:id/turns/block?srcOffset=&n=&eventId=` — the body behind
   * a code-block or tool-body chip, the phone's half of what the desktop does
   * over `daemon.transcript.codeBlock`.
   *
   * Bodies never ride the turn page itself (A3): the page carries a chip with
   * `{n, lines, lang, srcOffset}` and the body is fetched here, on expand, as a
   * single bounded line read. Without this route the phone could render the chip
   * and nothing else — there was no way to open one.
   *
   * Same gate, same tag, same 404/503 split as `/turns`: this serves transcript
   * content, so `--allow-transcript` governs it and nothing else may.
   */
  private handleSessionTurnBlock(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string,
  ): void {
    res.setHeader('Cache-Control', 'no-store');
    if (this.opts?.allowTranscript !== true) {
      this.json(res, 403, {
        error: 'transcript-disabled: server started without --allow-transcript',
        detail: 'restart with: wmux web --allow-transcript <your other flags>',
      });
      return;
    }
    if (!this.readableSession(sessionId)) {
      this.json(res, 404, { error: 'session not found' });
      return;
    }
    const projector = this.deps.projector?.() ?? null;
    if (!projector) {
      this.json(res, 503, { error: 'transcript projector unavailable' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    // Read the raw params first. `Number()` maps BOTH a missing param (null) and
    // an empty one ('') to 0, so `?n=1` and `?srcOffset=&n=1` would each read as
    // "offset 0" and quietly answer with a block from the first line of the
    // transcript instead of refusing (review: CodeRabbit).
    const num = (raw: string | null): number =>
      raw === null || raw.trim() === '' ? NaN : Number(raw);
    const srcOffset = num(url.searchParams.get('srcOffset'));
    const n = num(url.searchParams.get('n'));
    if (!Number.isFinite(srcOffset) || srcOffset < 0 || !Number.isFinite(n) || n < 1) {
      this.json(res, 400, {
        error: 'bad-block-ref',
        detail: 'srcOffset must be a non-negative integer and n a positive one',
      });
      return;
    }
    // The event id is what stops a rotated file from answering with a DIFFERENT
    // conversation's code at the same offset. Optional on the wire because a
    // producer may not have attributed one, and the projector then falls back to
    // matching `n` alone — exactly the desktop RPC's contract.
    const eventId = url.searchParams.get('eventId') ?? undefined;

    const found = projector.codeBlock(sessionId, {
      srcOffset: Math.floor(srcOffset),
      n: Math.floor(n),
      ...(eventId ? { eventId } : {}),
    });
    // A ref that no longer resolves is a 404 rather than an empty 200: the chip
    // is stale (file rotated, offset mid-line, block gone), and a phone that got
    // `{body: ''}` would render an empty expansion as if the block were empty.
    if (!found) {
      this.json(res, 404, { error: 'block not found' });
      return;
    }
    // The desktop reads this over a local pipe; the phone may be on a hotel
    // network, and one transcript line can legitimately hold megabytes of tool
    // output. Cut at the cap and SAY so, rather than shipping the whole thing or
    // pretending the block ends here — `truncated` is what stops a user copying
    // a shortened body out with nothing saying it was shortened.
    const bytes = Buffer.byteLength(found.body, 'utf8');
    if (bytes > MAX_BLOCK_BODY_BYTES) {
      // StringDecoder rather than `.toString()`: a byte cut lands mid-sequence
      // as often as not, and toString would hand the phone a U+FFFD at the seam.
      // The decoder holds the incomplete tail back instead, and never calling
      // `end()` is what discards it.
      const head = new StringDecoder('utf8').write(
        Buffer.from(found.body, 'utf8').subarray(0, MAX_BLOCK_BODY_BYTES),
      );
      this.json(res, 200, { body: head, bytes, truncated: true });
      return;
    }
    this.json(res, 200, { body: found.body, bytes });
  }

  private handleSessionResize(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawId: string,
  ): void {
    const id = decodePathSegment(rawId);
    if (id === null) return this.json(res, 404, { error: 'session not found' });
    const managed = this.deps.sessionManager.getSession(id);
    if (!managed) return this.json(res, 404, { error: 'session not found' });

    this.readJsonBody(req, res, (body) => {
      const b = (body ?? {}) as { cols?: unknown; rows?: unknown };
      if (
        !isGeometryValue(b.cols, MIN_REQUESTED_COLS) ||
        !isGeometryValue(b.rows, MIN_REQUESTED_ROWS)
      ) {
        return this.json(res, 400, {
          error: 'bad-geometry',
          detail:
            `cols must be an integer in ${MIN_REQUESTED_COLS}..${MAX_REQUESTED_GEOMETRY}, ` +
            `rows in ${MIN_REQUESTED_ROWS}..${MAX_REQUESTED_GEOMETRY}`,
        });
      }

      // Re-read rather than trusting the lookup above: the body arrives over
      // however many TCP segments it takes, and a pane can die or be attached
      // by the desk in between.
      const current = this.deps.sessionManager.getSession(id);
      if (!current) return this.json(res, 404, { error: 'session not found' });
      if (current.meta.state === 'attached' && current.viewerVisible) {
        return this.json(res, 409, {
          error: 'desk-owns-size',
          cols: current.meta.cols,
          rows: current.meta.rows,
          owner: 'desk',
        });
      }
      // A session recovered from a reboot and not yet resized is MUTED, and
      // `resizeSession` treats its first resize as the signal to unmute and
      // start capturing. That is the desk's handshake, not ours: capture
      // started here would begin at the phone's geometry, and the pre-resize
      // output the mute exists to hold back would land in the ring buffer
      // interleaved with output painted for a different width — permanently,
      // because scrollback is not re-flowable. The route's claim that it only
      // changes two numbers is only true once that handshake has happened.
      if (current.deferred) {
        return this.json(res, 409, {
          error: 'resize-failed',
          detail: 'the pane is still recovering and has not been attached yet',
        });
      }

      // Frequency bound, per session. Without it a paired device can alternate
      // two geometries as fast as it can post: every accepted resize delivers a
      // SIGWINCH, makes a full-screen TUI reallocate and repaint, AND stamps
      // `bridge.noteResize()`. That last one is the one that bites — the
      // redraw guard it arms suppresses AgentDetector's emission dedup reset,
      // so a device that keeps the guard permanently armed can stop new
      // `awaiting_input` prompts from ever being detected. A rate limit here is
      // not only about CPU; it is what keeps approvals from going silent.
      const now = this.now();
      const last = this.lastResizeAt.get(id);
      if (last !== undefined && now - last < MIN_RESIZE_INTERVAL_MS) {
        return this.json(res, 429, {
          error: 'resize-too-often',
          cols: current.meta.cols,
          rows: current.meta.rows,
          retryAfterMs: MIN_RESIZE_INTERVAL_MS - (now - last),
        });
      }
      this.lastResizeAt.set(id, now);
      // The map is keyed by a session id that outlives nothing else here, so it
      // is swept against the live roster rather than left to grow with every
      // pane the daemon has ever had.
      if (this.lastResizeAt.size > RESIZE_TRACKING_CAP) this.sweepResizeTracking();

      try {
        this.deps.sessionManager.resizeSession(id, b.cols, b.rows);
      } catch (err) {
        // `dead` and `suspended` both throw here. Neither is a bug on the
        // caller's side — the pane list it decided from is a poll old. The
        // daemon's own wording goes to the LOG, never onto the wire: it names
        // session ids and can carry an errno or a path, and the caller's only
        // useful action ("not this pane, not now") does not depend on which.
        this.deps.log('warn', `[web] resize failed for ${id}: ${errMsg(err)}`);
        return this.json(res, 409, {
          error: 'resize-failed',
          detail: 'the pane is not in a state that can be resized',
        });
      }

      // The APPLIED geometry, read back from the daemon's own record: the
      // manager floors cols and rows, so what was asked for and what the PTY
      // now is are not always the same number, and a client that rendered to
      // its request would wrap at the wrong width.
      const after = this.deps.sessionManager.getSession(id);
      if (!after) {
        // The pane died between the resize and this read. Answering 200 with
        // the REQUESTED geometry would be the one thing the paragraph above
        // forbids — reporting a width no PTY ever had.
        return this.json(res, 409, {
          error: 'resize-failed',
          detail: 'the pane is not in a state that can be resized',
        });
      }
      return this.json(res, 200, {
        cols: after.meta.cols,
        rows: after.meta.rows,
        owner: 'caller',
      });
    });
  }

  // --- pane lifecycle (opt-in) ---------------------------------------------

  /**
   * `POST /api/sessions` — spawn a pane from the phone. Body: `{workspaceId?,
   * cwd?}`.
   *
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ GATED ON `--allow-input`. THIS IS NOT AN APPROVAL-STYLE CARVE-OUT.    │
   * └───────────────────────────────────────────────────────────────────────┘
   * `POST /api/approvals/:id` is allowed on a read-only server because the
   * caller supplies a `approve`/`deny` verb and the registry picks the bytes
   * for a request the DAEMON already raised — the caller cannot invent the
   * action. Creating a shell is the opposite: an interactive shell is the
   * definition of arbitrary execution, and a caller who can spawn one and then
   * type into it has everything `--allow-input` grants, obtained by a route
   * that claimed not to need it. Anything else here would make
   * `--allow-input` a label rather than a boundary.
   *
   * `DELETE` is gated for the adjacent reason: killing somebody's pane
   * destroys unsaved work, and "read-only" must not include "can end your
   * running build".
   *
   * Both credential forms may call it. A paired phone authenticates as itself
   * and is individually revocable; the operator token is not more trusted here,
   * only differently revocable, so gating on the credential FORM rather than on
   * the server's input policy would be a boundary that is not one.
   */
  private handleSessionCreate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    principal: WebPrincipal,
  ): void {
    if (!this.mayInput(principal)) {
      return this.refuseInput(
        res,
        principal,
        'creating a shell is arbitrary execution — it requires the same grant as typing',
      );
    }
    const lifecycle = this.deps.lifecycle;
    if (!lifecycle) return this.json(res, 503, { error: 'lifecycle unavailable' });

    this.readJsonBody(req, res, (body) => {
      const b = (body ?? {}) as { workspaceId?: unknown; cwd?: unknown };
      const workspaceId = typeof b.workspaceId === 'string' ? b.workspaceId.trim() : '';
      const cwd = typeof b.cwd === 'string' ? b.cwd.trim() : '';
      if (workspaceId) {
        const bad = this.rejectWorkspaceId(workspaceId, principal);
        if (bad) return this.json(res, 400, bad);
      }
      lifecycle
        .create({ ...(workspaceId ? { workspaceId } : {}), ...(cwd ? { cwd } : {}) })
        .then(({ id }) => {
          // One serializer: the new pane is described by the SAME projection
          // `GET /api/sessions` uses, so a client can append the response to
          // its list without a second shape to keep in step. A create that
          // somehow left nothing live is reported rather than faked.
          const row = this.listSessions().find((s) => s.id === id);
          if (!row) return this.json(res, 500, { error: 'created session is not live' });
          return this.json(res, 201, row);
        })
        .catch((err: unknown) => {
          // The daemon refuses a create for reasons that are the operator's
          // situation, not a bug: the session cap, memory pressure, a shutdown
          // in flight. 409 says "not now" and carries the daemon's own wording,
          // which already tells the human what to do about it.
          this.deps.log('warn', `[web] session create failed: ${errMsg(err)}`);
          return this.json(res, 409, { error: 'create-failed', detail: errMsg(err) });
        });
    });
  }

  /**
   * Is this `workspaceId` one we are willing to stamp into a child's
   * environment? Returns the 400 body when it is not, `null` when it is.
   *
   * The id does not stay in the request. It is written into the new pane's
   * `WMUX_WORKSPACE_ID`, persisted into `sessions.json`, and read back by the
   * app as this pane's identity — so an unchecked string is workspace
   * impersonation (claim a workspace you were never granted and the pane is
   * filed under it) plus a persistence bug (a newline or a NUL in an env value
   * and a state file that renders as something else entirely).
   *
   * TWO CHECKS, and the second is the interesting one:
   *
   *   1. SHAPE. The same `^[A-Za-z0-9_-]{1,64}$` the daemon already enforces on
   *      a session id. Control characters, spaces and 4 KB of text are out.
   *
   *   2. EXISTENCE, evidenced by a live pane. The daemon has no workspace
   *      registry — the renderer owns that list and the daemon deliberately
   *      cannot ask it (see `sessionLifecycle` in daemon/index.ts). The only
   *      evidence available here is that some live session is ALREADY running
   *      under that id, which means the desktop minted it. So that is the rule.
   *
   * THE TRADE-OFF, stated plainly, because this replaced a deliberate decision
   * that went the other way: a genuine workspace whose every pane happens to be
   * closed cannot be named until one is open again, and the phone gets a 400
   * for an id that really exists. The previous behaviour — spawn anyway, on the
   * grounds that the daemon should not adjudicate a list it does not own — is
   * the friendlier of the two and the wrong one: "I cannot verify this" must
   * not resolve to "so I will accept it" for a value that becomes an identity.
   * The workspace-less spawn (omit the field) is always available and is what a
   * client should fall back to.
   *
   * THE ONE EXCEPTION (#1001): `principal.kind === 'operator'` skips EXISTENCE
   * only — shape is still enforced for everyone. This is an identity operation,
   * not an execution one: minting a workspace id decides how a pane is filed
   * and scoped, not what it can run, so it sits outside the "credential form
   * must not gate capability" argument `handleSessionCreate` makes just above —
   * that argument is about `mayInput`, which a device already has. The operator
   * is the thing that owns the workspace registry (the renderer mints and files
   * these ids today), so it is the thing allowed to extend it; a paired device
   * still cannot claim an id nothing is running under. Stated limitation so
   * this is not mistaken for a hard boundary: it is an audit-and-revocability
   * one — a shell on the daemon's own host can already read the operator
   * token, and a phone-only headless bootstrap still needs that operator
   * credential once, elsewhere, to get here at all.
   */
  private rejectWorkspaceId(
    workspaceId: string,
    principal: WebPrincipal,
  ): { error: string; detail: string } | null {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) {
      return {
        error: 'invalid-workspace-id',
        detail: 'workspaceId must match ^[A-Za-z0-9_-]{1,64}$',
      };
    }
    if (principal.kind === 'operator') return null;
    const known = this.deps.sessionManager
      .listLiveSessions()
      .some((s) => s.env?.[ENV_KEYS.WORKSPACE_ID] === workspaceId);
    if (!known) {
      return {
        error: 'unknown-workspace-id',
        detail:
          'no live pane is running in that workspace — the daemon can only verify a ' +
          'workspace id it can see on a running session. Omit workspaceId to spawn ' +
          'outside a workspace.',
      };
    }
    return null;
  }

  /** `DELETE /api/sessions/:id` — close a pane. See handleSessionCreate for the gate. */
  private handleSessionDelete(res: http.ServerResponse, rawId: string, principal: WebPrincipal): void {
    if (!this.mayInput(principal)) {
      return this.refuseInput(
        res,
        principal,
        'closing a pane destroys running work — it requires the same grant as typing',
      );
    }
    const lifecycle = this.deps.lifecycle;
    if (!lifecycle) return this.json(res, 503, { error: 'lifecycle unavailable' });

    const id = decodePathSegment(rawId);
    if (id === null) return this.json(res, 404, { error: 'session not found' });
    if (!this.deps.sessionManager.getSession(id)) {
      return this.json(res, 404, { error: 'session not found' });
    }
    lifecycle
      .destroy(id)
      .then(() => {
        // Drop any phone turn-view watcher + pending nudge for this pane so a
        // closed session does not linger for the daemon's life (3-MODEL review).
        this.transcriptWatchers.delete(id);
        const timer = this.transcriptNudgeTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.transcriptNudgeTimers.delete(id);
        }
        const liveness = this.livenessTimers.get(id);
        if (liveness) {
          clearTimeout(liveness);
          this.livenessTimers.delete(id);
        }
        this.pendingLiveness.delete(id);
        res.writeHead(204, this.securityHeaders());
        res.end();
      })
      .catch((err: unknown) => {
        this.deps.log('warn', `[web] session delete failed: ${errMsg(err)}`);
        return this.json(res, 500, { error: 'destroy-failed', detail: errMsg(err) });
      });
  }

  // --- SSE output stream --------------------------------------------------

  private handleStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    principal: WebPrincipal,
  ): void {
    const sessionId = url.searchParams.get('session') ?? '';
    const managed = this.deps.sessionManager.getSession(sessionId);
    if (!managed) {
      return this.json(res, 404, { error: 'session not found' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...this.securityHeaders(),
    });

    // The headers are already out, so there is no status code left to send on
    // failure — but `readAll()` + `Buffer.concat` on a ring of up to 64 MB can
    // throw (allocation), and an exception escaping a request handler reaches
    // `uncaughtException` and takes the whole daemon with it. One client's
    // initial paint is not worth the fleet.
    try {
      this.writeSnapshotFrame(res, managed);
    } catch (err) {
      this.deps.log('warn', `[web] initial snapshot failed for ${sessionId}: ${errMsg(err)}`);
      try {
        res.end();
      } catch {
        /* socket already gone — the end state we wanted either way */
      }
      return;
    }

    // Live tee off the bridge. This is a SECOND, independent listener — it does
    // not disturb the GUI's SessionPipe. maxListeners is relaxed because each
    // web viewer adds one and we always remove on disconnect.
    const bridge = managed.bridge;
    bridge.setMaxListeners(0);
    const onData = (data: Buffer): void => {
      try {
        writeSse(res, 'data', data.toString('base64'));
      } catch {
        /* client stream broken — the 'close' handler cleans up */
      }
    };
    const onExit = (): void => {
      try {
        writeSse(res, 'exit', '1');
      } catch {
        /* ignore */
      }
    };
    // An applied resize invalidates the client's grid: every absolute-positioned
    // frame that follows was computed for the new size. The answer is the new
    // GEOMETRY and nothing else.
    //
    // Not a fresh snapshot: re-sending the window would be ~341 KB of base64
    // per viewer per resize plus a full ring copy each, and every client does
    // `reset()` before replaying it — so a viewer scrolled up reading would be
    // wiped and yanked to the bottom every time someone dragged a divider on
    // the machine that owns the pane. A TUI repaints itself on SIGWINCH and a
    // shell at a prompt behaves exactly as a local terminal does, so the bytes
    // that follow are enough on their own.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        const current = this.deps.sessionManager.getSession(sessionId);
        if (!current) return;
        try {
          writeSse(res, 'meta', JSON.stringify(this.streamMeta(current, { resize: true })));
        } catch {
          /* client stream broken — the 'close' handler cleans up */
        }
      }, RESIZE_META_DEBOUNCE_MS);
    };

    bridge.on('data', onData);
    bridge.on('exit', onExit);
    bridge.on('resize', onResize);

    const stopHeartbeat = startSseHeartbeat(res);

    const detach = (): void => {
      stopHeartbeat();
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      bridge.removeListener('data', onData);
      bridge.removeListener('exit', onExit);
      bridge.removeListener('resize', onResize);
    };
    const client: SseClient = { res, sessionId, detach, principal };
    this.clients.add(client);

    req.on('close', () => {
      detach();
      this.clients.delete(client);
    });
  }

  /**
   * The `meta` event body. `resize: true` marks the geometry-only form a client
   * gets mid-stream: there is no snapshot behind it, so a client that pairs the
   * two must dispatch this one on its own rather than hold it for a partner
   * that will never arrive.
   */
  private streamMeta(
    managed: ManagedSession,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { cols: managed.meta.cols, rows: managed.meta.rows, ...extra };
  }

  /**
   * The `meta` + `snapshot` pair that paints a stream on attach. Always both
   * events, in that order — every client resets its terminal on the pair.
   *
   * The snapshot payload is the capped window PREFIXED by a synthetic
   * mode preamble (see util/outputModeTracker.ts). The prefix rides the
   * existing `snapshot` event rather than a new event name, so a cached
   * frontend that predates it replays it as ordinary bytes — which is exactly
   * what it is. `omittedBytes` still counts only the ring bytes dropped from
   * the front; the preamble was never in the ring.
   */
  private writeSnapshotFrame(res: http.ServerResponse, managed: ManagedSession): void {
    // Capped to a window — the ring is 8 MB by default and up to 64 MB, and
    // base64 inflates it by a third, which a phone reconnecting at every tunnel
    // would pull each time. The truncation rides `meta` rather than a new event
    // name, so a cached frontend that predates it is unaffected.
    const snapshot = capSnapshot(managed.ringBuffer.readAll());
    const meta = this.streamMeta(managed, {
      truncated: snapshot.truncated,
      omittedBytes: snapshot.omittedBytes,
    });
    // Absolute stream offset of the window's FIRST byte. The tracker needs it
    // to decide whether the alt-screen entry is something the window already
    // carries — re-asserting one that is still in there paints the scrollback
    // ahead of it into the alternate buffer and loses it (see
    // util/outputModeTracker.ts). Derived from the ring's own monotonic
    // counter, which is stable across wraps and counts a recovered session's
    // pre-filled scrollback, so both sides speak the same coordinates.
    const windowStart = managed.ringBuffer.totalBytesWritten - snapshot.bytes.length;
    const preamble = managed.bridge.outputModes?.preamble(windowStart) ?? '';
    const payload = preamble
      ? Buffer.concat([Buffer.from(preamble, 'utf8'), snapshot.bytes])
      : snapshot.bytes;
    writeSse(res, 'meta', JSON.stringify(meta));
    writeSse(res, 'snapshot', payload.toString('base64'));
  }

  // --- input (opt-in) -----------------------------------------------------

  private handleInput(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    principal: WebPrincipal,
  ): void {
    if (!this.mayInput(principal)) {
      return this.refuseInput(res, principal, 'typing runs commands on this machine');
    }
    const sessionId = url.searchParams.get('session') ?? '';
    const managed = this.deps.sessionManager.getSession(sessionId);
    if (!managed) {
      return this.json(res, 404, { error: 'session not found' });
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) {
        aborted = true;
        this.json(res, 413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        managed.ptyProcess.write(body);
        // A phone can paste drafts containing newlines; bridge.noteInput keeps
        // bracketed-paste bodies inert and only re-arms on a submitted CR/LF.
        managed.bridge.noteInput?.(body);
      } catch (err) {
        return this.json(res, 500, { error: `write failed: ${errMsg(err)}` });
      }
      res.writeHead(204);
      res.end();
    });
    req.on('error', () => {
      aborted = true;
    });
  }

  // --- photo upload (opt-in) ----------------------------------------------

  /**
   * `POST /api/upload` — raw JPEG/PNG bytes in, an absolute path out.
   *
   * A phone can take a photo and a desktop cannot, but `POST /api/input` writes
   * to a PTY and an image cannot ride that. So the bytes land on disk here and
   * the CLIENT puts the returned path in a composer draft — this route never
   * types anything at anyone. Sending it stays the operator's deliberate act
   * through the existing input route.
   *
   * Modelled on handleInput down to the accumulate-and-cap shape. The three
   * things it does differently are all refusals: the grant is its own flag, the
   * format is decided by the BYTES rather than by a Content-Type the client
   * chose, and the filename is ours — a client-supplied name is a traversal
   * primitive and buys nothing, since nobody reads these by name.
   *
   * No multipart. The daemon has no parser and is not getting one for a body
   * that is a single blob.
   */
  private handleUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.opts?.allowUpload !== true) {
      return this.json(res, 403, {
        error: 'uploads-disabled: server started without --allow-upload',
      });
    }
    const dir = this.deps.uploadsDir;
    if (!dir) {
      return this.json(res, 503, { error: 'uploads-unavailable' });
    }
    const limits = this.deps.uploadLimits ?? {};
    const maxConcurrent = limits.maxConcurrent ?? MAX_CONCURRENT_UPLOADS;
    // Checked BEFORE a byte is read: the whole point is not to hold this body
    // in memory, so refusing after buffering it would cost exactly what the
    // bound exists to avoid.
    if (this.inFlightUploads >= maxConcurrent) {
      return this.json(res, 429, { error: 'too-many-uploads: try again in a moment' });
    }
    this.inFlightUploads += 1;
    // Every exit from here on has to give the slot back exactly once —
    // success, refusal, socket dropped mid-body. `close` always fires, so it is
    // the backstop; the explicit calls just return the slot sooner.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inFlightUploads -= 1;
    };
    req.on('close', release);

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        aborted = true;
        this.json(res, 413, { error: 'payload too large' });
        req.destroy();
        release();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks);
      const ext = sniffImageExt(body);
      if (!ext) {
        release();
        return this.json(res, 415, {
          error: 'unsupported-format: only JPEG and PNG are accepted',
        });
      }
      const now = this.now();
      // Before the write, not on a timer: a sweeper firing while the operator
      // is reading a path would be a race we invented for ourselves, and an
      // upload is the only moment this directory is known to be in use.
      pruneUploads(dir, now);
      // Measured AFTER the sweep, so a directory full of expired photos does
      // not refuse an upload the sweep was about to make room for.
      const held = measureUploads(dir);
      if (
        held.files + 1 > (limits.maxFiles ?? MAX_UPLOAD_FILES) ||
        held.bytes + body.length > (limits.maxDirBytes ?? MAX_UPLOAD_DIR_BYTES)
      ) {
        release();
        // 507, not 403: the permission is there and the request is well formed,
        // the server simply has no room. "try again later" is honest — the TTL
        // will free space on its own.
        return this.json(res, 507, { error: 'uploads-full: quota exceeded, try again later' });
      }
      const name = `photo-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${crypto
        .randomBytes(4)
        .toString('hex')}.${ext}`;
      const full = path.join(dir, name);
      try {
        fs.mkdirSync(dir, { recursive: true });
        // `wx` refuses to overwrite. With 32 bits of randomness in the name a
        // collision means something is wrong, and answering 500 is better than
        // silently replacing a photo somebody is about to send.
        fs.writeFileSync(full, body, { mode: 0o600, flag: 'wx' });
      } catch (err) {
        release();
        return this.json(res, 500, { error: `write failed: ${errMsg(err)}` });
      }
      release();
      return this.json(res, 201, { path: full, expiresAt: now + UPLOAD_TTL_MS });
    });
    req.on('error', () => {
      aborted = true;
      release();
    });
  }

  // --- approvals (M2) -----------------------------------------------------

  /**
   * `POST /api/push-registration` — where to reach this device, and the key to
   * seal for it.
   *
   * DEVICE ONLY. The operator token names no device, so there is nothing to
   * register it against; answering 403 is more useful than inventing one.
   *
   * Neither field is a secret — an APNs routing handle and the public half of a
   * pair whose private half never leaves the phone's Keychain — which is what
   * lets this be stored in the roster without turning it into a file worth
   * stealing. See DevicePushRegistration.
   */
  private handlePushRegistration(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    principal: WebPrincipal,
  ): void {
    if (principal.kind !== 'device') {
      return this.json(res, 403, {
        error: 'push-is-for-devices',
        detail: 'register with the credential of the device that will receive the notifications',
      });
    }
    const devices = this.deps.devices;
    if (!devices?.registerPush) {
      return this.json(res, 503, { error: 'push-unavailable' });
    }
    this.readJsonBody(req, res, (body) => {
      const b = (body ?? {}) as {
        apnsToken?: unknown;
        publicKey?: unknown;
        apnsEnvironment?: unknown;
      };
      const apnsToken = typeof b.apnsToken === 'string' ? b.apnsToken : '';
      const publicKey = typeof b.publicKey === 'string' ? b.publicKey : '';
      // PRESENCE, not type. The store owns the allowlist so there is one place
      // that decides what a stage may be — but only a field that is genuinely
      // ABSENT may reach it as absent. Coercing a present-but-wrong value
      // (`null`, a number, an object) to `undefined` here would answer 200 and,
      // because a registration replaces the record wholesale, delete a stage
      // the daemon already knew — routing that device's push to the host that
      // rejects it, in response to a request the contract promises to refuse.
      // Handed over RAW, never coerced. `String(['production'])` is
      // `'production'` — a one-element array would sail through a stringifying
      // guard and be stored as a stage the client never sent. The store
      // strict-compares against the two literals, so anything else (an array, a
      // number, `null`, an object) fails there and comes back 400.
      const hasStage = statesField(body, 'apnsEnvironment');
      let result: { ok: boolean; reason?: string };
      try {
        result = devices.registerPush!(principal.deviceId, {
          apnsToken,
          publicKey,
          ...(hasStage ? { apnsEnvironment: b.apnsEnvironment } : {}),
        });
      } catch (err) {
        this.deps.log('warn', `[web] push registration threw: ${errMsg(err)}`);
        return this.json(res, 500, { error: 'push-registration-failed' });
      }
      if (result.ok) return this.json(res, 200, { ok: true });
      // `bad-token` / `bad-key` are the caller's fault; the rest are ours or the
      // operator's, and a device that was revoked mid-flight should hear that
      // rather than a generic 400.
      const status =
        result.reason === 'bad-token' ||
        result.reason === 'bad-key' ||
        result.reason === 'bad-apns-environment'
          ? 400
          : 409;
      return this.json(res, status, { error: result.reason ?? 'push-registration-failed' });
    });
  }

  /**
   * `GET /api/approvals` — what a client needs the moment it connects: the
   * requests still waiting on a human, plus the recently settled tail.
   *
   * The settled tail is not decoration. Two people can be looking at the same
   * pending approval on two devices; the loser of that race gets a 409, and
   * without the settled record there is nothing to render but an error code.
   */
  private handleApprovalsList(res: http.ServerResponse): void {
    const approvals = this.deps.approvals;
    if (!approvals) return this.json(res, 503, { error: 'approvals unavailable' });
    let listed: { pending: ApprovalRequest[]; recentlyResolved: ApprovalRequest[] };
    try {
      listed = approvals.list();
    } catch (err) {
      this.deps.log('warn', `[web] approvals list failed: ${errMsg(err)}`);
      return this.json(res, 500, { error: 'approvals unavailable' });
    }
    // Both halves keep the registry's own names and order (recentlyResolved is
    // newest-first and already bounded there), so the two shapes agree today.
    // They are NOT one serializer: this goes through `approvalWire`, a
    // field-by-field allowlist, while `daemon.approvals.list` returns the
    // registry's records unfiltered. That is fine while the pipe stays
    // daemon-internal, but it means adding a field to ApprovalRequest puts it
    // on the pipe and not here — deliberately, since the allowlist exists so
    // registry internals cannot reach the network by default.
    return this.json(res, 200, {
      pending: listed.pending.map(approvalWire),
      recentlyResolved: listed.recentlyResolved.map(approvalWire),
    });
  }

  /**
   * `POST /api/approvals/:id` — answer one request.
   *
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ THIS ROUTE WORKS ON A READ-ONLY SERVER. THAT IS DELIBERATE.           │
   * └───────────────────────────────────────────────────────────────────────┘
   * Every other write path (`POST /api/input`) is 403 without `--allow-input`,
   * and that stays true — this carve-out widens NOTHING else. The reason it is
   * safe, and the reason the whole milestone exists:
   *
   *   - `--allow-input` grants ARBITRARY bytes to ANY pane at ANY time. This
   *     grants ONE answer to ONE request the DAEMON already decided to raise,
   *     from a hook-sourced `agent.awaiting_input` — the operator cannot invent
   *     a request, only respond to one.
   *   - The bytes are not the caller's. The caller sends `approve`/`deny`; the
   *     registry picks the keystrokes from its own per-agent map and re-reads
   *     the pane to confirm the prompt is still on screen before writing. A
   *     request that has expired, been superseded, or lost its prompt refuses.
   *   - Requiring `--allow-input` here would mean the answer to "my agent is
   *     blocked and I am not at my desk" is "you should have granted a fully
   *     writable terminal to the network in advance", which is a worse posture
   *     than the narrow grant it is trying to avoid.
   *
   * Still gated by the Bearer token like everything else, and the token is not
   * ambient authority (no cookie), so a hostile page cannot forge this POST.
   */
  private handleApprovalResolve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawId: string,
    principal: WebPrincipal,
  ): void {
    const approvals = this.deps.approvals;
    if (!approvals) return this.json(res, 503, { error: 'approvals unavailable' });

    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      // Malformed percent-escape — no such request, by definition.
      return this.json(res, 404, { error: 'not-found' });
    }
    if (!id || id.includes('/')) return this.json(res, 404, { error: 'not-found' });

    // A screen-backed prompt is answerable on a read-only server: the daemon
    // already put that question on the pane, and the caller can only pick one
    // of ITS options. A permission gate is a different grant — approving it
    // runs the tool (arbitrary Bash, a write, a subagent), which is exactly
    // what --allow-input governs. Gate it accordingly (review: Claude).
    const record = approvals.list().pending.find((r) => r.id === id);
    if (record?.kind === 'awaiting_permission' && !this.mayInput(principal)) {
      return this.refuseInput(
        res,
        principal,
        'approving a tool permission runs the tool — it needs the same grant as typing',
      );
    }

    this.readJsonBody(req, res, (body) => {
      const decision = (body as { decision?: unknown } | null)?.decision;
      if (decision !== 'approve' && decision !== 'deny') {
        return this.json(res, 400, { error: "decision must be 'approve' or 'deny'" });
      }
      // choiceKey is presence-sensitive. A malformed, empty, or deny-side
      // key must never be dropped into the legacy "approve first option" path.
      const parsedBody = body as Record<string, unknown> | null;
      const hasChoiceKey = parsedBody !== null
        && typeof parsedBody === 'object'
        && !Array.isArray(parsedBody)
        && Object.prototype.hasOwnProperty.call(parsedBody, 'choiceKey');
      const rawChoiceKey = hasChoiceKey ? parsedBody?.['choiceKey'] : undefined;
      if (hasChoiceKey && (
        decision !== 'approve'
        || typeof rawChoiceKey !== 'string'
        || !/^\d{1,2}$/.test(rawChoiceKey)
      )) {
        return this.json(res, 400, { error: 'invalid-choice-key' });
      }
      const choiceKey = hasChoiceKey ? rawChoiceKey as string : undefined;
      approvals
        .resolve({
          id,
          decision,
          resolvedBy: describePrincipal(principal),
          ...(choiceKey !== undefined ? { choiceKey } : {}),
        })
        .then((result) => {
          if (result.ok) {
            // 200 with `durable:false` rather than an error: the keystroke IS in
            // the terminal, so the answer landed and the caller must not retry.
            // What did not land is the record of it — after a restart the
            // history will not show this decision or who made it. The client
            // says so instead of the daemon knowing it privately.
            return this.json(res, 200, { state: result.request.state, durable: result.durable });
          }
          switch (result.reason) {
            // Someone else got there first — hand back WHO, so the loser's UI
            // can say so instead of showing a bare conflict.
            case 'already-resolved':
              return this.json(res, 409, { error: 'already-resolved', resolvedBy: result.resolvedBy });
            // Gone: the request outlived its usefulness (timed out, replaced by
            // a newer prompt, or the prompt left the screen). 410, not 404 —
            // it existed, and the client should stop showing it. The registry
            // reports 'expired' for a supersede too, so the precise state rides
            // along when it knows it: "someone re-prompted" and "it timed out"
            // are the same status but not the same sentence to a human.
            case 'expired':
            case 'prompt-gone':
              return this.json(res, 410, {
                error: result.reason,
                ...(result.request ? { state: result.request.state } : {}),
              });
            // The daemon has no keystroke map for this agent, so it refuses to
            // guess bytes. Not the caller's fault: 501, not 4xx.
            case 'unsupported-agent':
              return this.json(res, 501, { error: 'unsupported-agent' });
            // The choiceKey does not belong to this request or the option is not
            // visible on screen. The request is still pending — the caller can
            // retry with a valid key or use the default approve/deny.
            case 'invalid-choice-key':
              return this.json(res, 422, { error: 'invalid-choice-key' });
            case 'not-found':
              return this.json(res, 404, { error: 'not-found' });
            default: {
              // A reason this surface does not know how to map. Never silently
              // report success — say the server does not understand its own
              // registry and log it.
              const reason = String(result.reason);
              this.deps.log('warn', `[web] approval resolve returned unknown reason: ${reason}`);
              return this.json(res, 500, { error: reason });
            }
          }
        })
        .catch((err: unknown) => {
          this.deps.log('warn', `[web] approval resolve threw: ${errMsg(err)}`);
          try {
            this.json(res, 500, { error: `resolve failed: ${errMsg(err)}` });
          } catch {
            /* socket already gone */
          }
        });
    });
  }

  /**
   * Read a small JSON body. On a body that is too large or not JSON, this
   * answers the request itself and never calls back — so a caller can treat the
   * callback as "a parsed body arrived". An empty body parses as `null`, which
   * the caller rejects as a missing decision.
   */
  private readJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    onBody: (body: unknown) => void,
  ): void {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        aborted = true;
        this.json(res, 413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return onBody(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw, (key, value) => {
          // Prototype pollution guard (mirrors config.ts / webStateStore).
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
          return value;
        });
      } catch {
        return this.json(res, 400, { error: 'invalid JSON body' });
      }
      onBody(parsed);
    });
    req.on('error', () => {
      aborted = true;
    });
  }

  /**
   * Republish a registry lifecycle transition onto the attention channel.
   *
   * The CONTENT fields — `screenTail`, `question`, `options` — are deliberately
   * NOT on the wire here: a tail is a screenful of pane output, and this payload
   * is fanned out to every client AND kept in the replay window for the whole
   * TTL. Clients fetch `/api/approvals` on connect and on any `approval` event
   * for the full record: the event is the nudge, the route is the truth.
   *
   * CONSEQUENCE A UI MUST RESPECT: never render an approve/deny control from an
   * `approval` event alone. `approve` is encoded as "press the first option",
   * which is a safe word for a consent-shaped prompt and a dangerous one for
   * "which file should I delete?" — so the buttons belong to the route's record,
   * which carries the question, or to nothing at all.
   */
  private publishApproval(e: ApprovalEvent): void {
    if (!e || typeof e !== 'object' || !e.request) return;
    const r = e.request;
    this.publish('approval', {
      sessionId: r.sessionId,
      // NOT `id`: the envelope's own `id` is the replay cursor, and identity
      // fields are stamped last precisely so a payload cannot shadow them.
      approvalId: r.id,
      phase: e.type,
      state: r.state,
      agent: r.agent,
      // The record's own `kind` ('awaiting_input') is NOT copied: the backlog
      // route stamps the ENVELOPE kind onto that name, so carrying both would
      // mean `kind` said different things on the two shapes of the same event.
      createdAt: r.createdAt,
      // Carried on the nudge as well as the record: a client that wants to
      // raise the alert style for a destructive prompt should not have to wait
      // for the /api/approvals round trip to know it should.
      ...(r.risk ? { risk: r.risk } : {}),
      ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
      ...(r.decision ? { decision: r.decision } : {}),
      ...(r.resolvedBy ? { resolvedBy: r.resolvedBy } : {}),
      ...(typeof r.resolvedAt === 'number' ? { resolvedAt: r.resolvedAt } : {}),
      // #783 — gate-card fields so the phone can render what tool and what input.
      ...(r.kind === 'awaiting_permission' ? { kind: r.kind } : {}),
      ...(r.toolName ? { toolName: r.toolName } : {}),
      ...(r.toolInputSummary ? { toolInputSummary: r.toolInputSummary } : {}),
    });
  }

  // --- fleet-wide event tee -----------------------------------------------

  /**
   * Record an attention event, then fan it out to EVERY connected client —
   * pane streams (whatever session they watch) and `/api/events` subscribers
   * alike. The wire payload flattens the event so the frontend sees
   * `{id, epoch, sessionId, ...event}`.
   *
   * Recording happens FIRST and unconditionally. That is the whole point of
   * #598: an approval raised while nobody was connected used to evaporate,
   * because a fan-out over an empty client set is a no-op. Now it lands in the
   * log and the next connect replays it.
   */
  private broadcastEvent(kind: 'critical' | 'notify', payload: { sessionId: string; event?: unknown }): void {
    if (!payload || typeof payload !== 'object') return;
    const event = payload.event && typeof payload.event === 'object' ? (payload.event as Record<string, unknown>) : {};
    const entry = this.publish(kind, { sessionId: payload.sessionId, ...event });

    // BACK-COMPAT (remove after one release): attention still rides the pane
    // streams so a cached PWA frontend that predates `/api/events` keeps
    // working. The extra `id`/`epoch` fields are ignored by old clients; new
    // ones dedup on them, so the double delivery is harmless.
    //
    // Approvals deliberately do NOT get this second copy: no frontend older
    // than the approval channel can act on one, so it would be pure noise on
    // every pane stream.
    const body = this.attentionWireBody(entry);
    for (const client of this.clients) {
      try {
        writeSse(client.res, kind, body);
      } catch {
        /* client stream broken — its own 'close' handler cleans up */
      }
    }
  }

  /**
   * Record one event in the replay window and fan it out to `/api/events`.
   *
   * Every kind shares ONE id space and ONE log: a client's cursor is a single
   * number, so an approval and a notification cannot be interleaved in a way
   * that makes a resume ambiguous.
   */
  private publish(kind: EventKind, payload: Record<string, unknown>): AttentionEntry {
    const entry: AttentionEntry = {
      id: ++this.attentionSeq,
      at: this.now(),
      kind,
      tier: tierFor(kind, payload),
      payload,
    };
    this.attentionLog.push(entry);
    this.evictAttention();

    const body = this.attentionWireBody(entry);
    for (const client of this.eventClients) {
      try {
        writeSse(client.res, kind, body, this.sseId(entry.id));
      } catch {
        /* client stream broken — its own 'close' handler cleans up */
      }
    }
    return entry;
  }

  /**
   * #782 — push a transcript nudge to the device(s) watching this pane, WITHOUT
   * recording it. Recording the nudge would land it in `attentionLog`, where a
   * busy pane's ~1Hz nudges would evict a pending approval; the phone then
   * replays the trimmed log on reconnect, re-derives the badge, and finds no
   * pending event — the badge clears while a human is still being waited on
   * (CRITICAL 3). Same `/api/events` SSE connection, auth and replay; this just
   * bypasses the log and `attentionSeq`, so a nudge is a live signal only and
   * never part of the replayed backlog.
   *
   * Coalesced per pane (`TRANSCRIPT_NUDGE_COALESCE_MS`): a turn fires several
   * hook signals in quick succession and the phone refetches on each nudge, so
   * collapsing the burst into one fetch is pure win. Delivered ONLY to devices
   * that opened this pane's turn view — a device that never queried the pane
   * never asked to hear about it. The nudge carries no payload on purpose: the
   * phone calls `delta()` and lets the cursor checks (fileSize/boundary)
   * decide whether to append or re-snapshot, instead of the server guessing.
   */
  emitTranscriptNudge(sessionId: string): void {
    if (this.eventClients.size === 0) return;
    // 1s coalescing per pane. The FIRST nudge of a burst arms the timer; later
    // ones in the same window are dropped on purpose (a refetch is already
    // pending, and the cursor checks on that refetch subsume later writes).
    if (this.transcriptNudgeTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.transcriptNudgeTimers.delete(sessionId);
      this.deliverTranscriptNudge(sessionId);
    }, TRANSCRIPT_NUDGE_COALESCE_MS);
    timer.unref?.();
    this.transcriptNudgeTimers.set(sessionId, timer);
  }

  private deliverTranscriptNudge(sessionId: string): void {
    const watchers = this.transcriptWatchers.get(sessionId);
    if (!watchers || watchers.size === 0) return;
    const body = JSON.stringify({ sessionId });
    for (const client of this.eventClients) {
      if (!watchers.has(this.watcherKey(client.principal))) continue;
      try {
        writeSse(client.res, 'transcript.nudge', body);
      } catch {
        /* client stream broken — its own 'close' handler cleans up */
      }
    }
  }

  /**
   * Push one liveness state to the device(s) watching this pane, WITHOUT
   * recording it — the same three rules the transcript nudge established, for
   * the same reasons:
   *
   *   - NON-RECORDING. A busy pane raises one of these per tool call; through
   *     `attentionLog` they would evict a pending approval from the replay
   *     window, and a phone reconnecting would re-derive its badge from a log
   *     that no longer holds the approval it is waiting on (#782 CRITICAL 3).
   *     Liveness is a live signal by nature: a header state from before the
   *     reconnect is worthless, so there is nothing to replay anyway.
   *   - COALESCED per pane, keeping the newest state (see the constant).
   *   - WATCHERS ONLY. A device that never opened this pane's turn view has no
   *     header to feed, and its SSE channel should not carry another pane's
   *     per-tool-call traffic.
   *
   * Terminal states (`isTerminalLiveness`) flush immediately and cancel any
   * open window, so "waiting for you" never queues behind a stale tool name.
   */
  emitAgentLiveness(body: AgentLivenessBody): void {
    if (this.eventClients.size === 0) return;
    const { sessionId } = body;
    if (isTerminalLiveness(body.state)) {
      const timer = this.livenessTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.livenessTimers.delete(sessionId);
      }
      this.pendingLiveness.delete(sessionId);
      this.deliverLiveness(body);
      return;
    }
    // Busy states: keep the newest and let the open window deliver it. Assigning
    // before the timer check is what makes this last-write-wins rather than
    // first-write-wins.
    this.pendingLiveness.set(sessionId, body);
    if (this.livenessTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.livenessTimers.delete(sessionId);
      const pending = this.pendingLiveness.get(sessionId);
      if (!pending) return;
      this.pendingLiveness.delete(sessionId);
      this.deliverLiveness(pending);
    }, AGENT_LIVENESS_COALESCE_MS);
    timer.unref?.();
    this.livenessTimers.set(sessionId, timer);
  }

  /**
   * Tell every connected device the gate was armed or disarmed.
   *
   * NOT recorded, for the opposite reason to the liveness event: this is rare
   * (a human presses it) but it is also pure STATE, and the authoritative copy
   * is one `/api/config` call away. A replayed transition would be a second
   * source of truth that can disagree with that call after a reconnect, so the
   * push is live-only and a reconnecting client re-reads config as it already
   * does on every start.
   *
   * Unlike liveness this reaches every client, not just watchers: the gate is
   * daemon-wide, not per-pane.
   */
  private broadcastGateState(gateEnabled: boolean): void {
    const body = JSON.stringify({ gateEnabled });
    for (const client of this.eventClients) {
      try {
        writeSse(client.res, 'gate.state', body);
      } catch {
        /* client stream broken — its own 'close' handler cleans up */
      }
    }
  }

  private deliverLiveness(body: AgentLivenessBody): void {
    const watchers = this.transcriptWatchers.get(body.sessionId);
    if (!watchers || watchers.size === 0) return;
    const wire = JSON.stringify(body);
    for (const client of this.eventClients) {
      if (!watchers.has(this.watcherKey(client.principal))) continue;
      try {
        writeSse(client.res, 'agent.liveness', wire);
      } catch {
        /* client stream broken — its own 'close' handler cleans up */
      }
    }
  }

  /** Stable key for a principal in `transcriptWatchers`. */
  private watcherKey(principal: WebPrincipal): string {
    return principal.kind === 'operator' ? 'operator' : principal.deviceId;
  }

  /**
   * Record that this principal opened the pane's turn view, so the non-recording
   * nudge reaches it. Called from `handleSessionTurns` on every successful read;
   * idempotent, and intentionally never undone — a device that stops reading the
   * pane simply has no SSE open, and a dangling entry is a cheap no-op on the
   * next nudge (the `eventClients` loop finds no matching client).
   */
  private noteTranscriptWatcher(sessionId: string, principal: WebPrincipal): void {
    const key = this.watcherKey(principal);
    let set = this.transcriptWatchers.get(sessionId);
    if (!set) {
      set = new Set();
      this.transcriptWatchers.set(sessionId, set);
    }
    set.add(key);
  }

  /** Drop entries past the cap (oldest first) and anything past the TTL. */
  private evictAttention(): void {
    if (this.attentionLog.length > ATTENTION_CAP) {
      this.attentionLog.splice(0, this.attentionLog.length - ATTENTION_CAP);
    }
    const cutoff = this.now() - ATTENTION_TTL_MS;
    // Entries are appended in time order, so the expired ones are a prefix.
    let drop = 0;
    while (drop < this.attentionLog.length && this.attentionLog[drop].at < cutoff) drop += 1;
    if (drop > 0) this.attentionLog.splice(0, drop);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Drop rate-limit entries for sessions that no longer exist.
   *
   * Called only when the map outgrows its cap, so the common case costs
   * nothing. Forgetting a live session's entry would be harmless anyway — it
   * grants one extra resize — which is why this can be lazy rather than wired
   * into session teardown.
   */
  private sweepResizeTracking(): void {
    const live = new Set(this.deps.sessionManager.listLiveSessions().map((s) => s.id));
    for (const id of this.lastResizeAt.keys()) {
      if (!live.has(id)) this.lastResizeAt.delete(id);
    }
  }

  /** The exact JSON one attention event carries on the wire, live or replayed. */
  private attentionWireBody(entry: AttentionEntry): string {
    // Identity fields — and `tier`, which is the server's judgement, not the
    // pane's — go LAST so pane-supplied payload data can never shadow them.
    return JSON.stringify({ ...entry.payload, tier: entry.tier, id: entry.id, epoch: this.attentionEpoch });
  }

  /** SSE `id:` value — epoch-qualified so a stale cursor is detectable. */
  private sseId(id: number): string {
    return `${this.attentionEpoch}:${id}`;
  }

  /** Highest id ever issued (NOT the log's head — the log evicts, ids do not). */
  private headId(): number {
    return this.attentionSeq;
  }

  /**
   * Parse an `epoch:id` cursor. A UUID contains no colon, but split on the LAST
   * one anyway so a future epoch format cannot silently mis-parse.
   */
  private parseCursor(raw: string | undefined | null): AttentionCursor | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    const cut = value.lastIndexOf(':');
    if (cut <= 0) return null;
    const epoch = value.slice(0, cut);
    const id = Number(value.slice(cut + 1));
    if (!epoch || !Number.isFinite(id) || id < 0) return null;
    return { epoch, id: Math.floor(id) };
  }

  /**
   * Everything a cursor has not seen yet. A cursor from another epoch (or none
   * at all) cannot be positioned in this id space, so the caller is told to
   * resync and handed the whole current window.
   *
   * A MATCHING epoch is not on its own enough, and that was the gap. The log
   * evicts — 100 entries, 30 minutes — while ids never rewind, so a cursor can
   * be perfectly valid and still sit below everything still held. Answering
   * `reset:false` there hands back the retained tail and lets the client treat
   * it as contiguous with what it last saw: the events in between are gone, the
   * client is never told, and on a phone that reconnects after a long sleep
   * that silently swallows the attention events this whole channel exists to
   * deliver. `reset` is the only signal that continuity broke, so it has to
   * fire whenever it did — not only when the epoch changed.
   */
  private replayFrom(cursor: AttentionCursor | null): { reset: boolean; entries: AttentionEntry[] } {
    this.evictAttention();
    if (!cursor || cursor.epoch !== this.attentionEpoch) {
      return { reset: true, entries: this.attentionLog.slice() };
    }
    const oldest = this.attentionLog.length > 0 ? this.attentionLog[0].id : null;
    // With entries held, continuity survives only if the cursor's NEXT id is one
    // we still have. With none held, it survives only if nothing was issued
    // after the cursor — an empty log is "quiet", not "lost", until it isn't.
    const gap = oldest === null ? cursor.id < this.headId() : cursor.id < oldest - 1;
    // A cursor above every id we ever issued cannot be positioned either; it did
    // not come from us in this epoch.
    if (gap || cursor.id > this.headId()) {
      return { reset: true, entries: this.attentionLog.slice() };
    }
    return { reset: false, entries: this.attentionLog.filter((e) => e.id > cursor.id) };
  }

  /**
   * `GET /api/events` (SSE) — the durable attention channel.
   *
   * Unlike the pane streams this one is opened ONCE per page and never
   * torn down on a pane switch, which is what makes replay meaningful: the
   * browser resends `Last-Event-ID` on every automatic reconnect, so a phone
   * that lost signal picks up exactly where it stopped.
   */
  private handleEventStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    principal: WebPrincipal,
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...this.securityHeaders(),
    });

    // EventSource's own resume header wins; `?since=` covers a page RELOAD,
    // where the browser starts a fresh EventSource with no memory of the id.
    const lastEventId = req.headers['last-event-id'];
    const cursor =
      this.parseCursor(typeof lastEventId === 'string' ? lastEventId : null) ??
      this.parseCursor(url.searchParams.get('since'));

    const { reset, entries } = this.replayFrom(cursor);
    if (reset) {
      // Say so BEFORE the backlog: the client renders a summary for a resync
      // instead of a burst of banners for events it may already have acted on.
      writeSse(res, 'reset', JSON.stringify({ epoch: this.attentionEpoch, headId: this.headId() }));
    }
    for (const entry of entries) {
      try {
        writeSse(res, entry.kind, this.attentionWireBody(entry), this.sseId(entry.id));
      } catch {
        /* client vanished mid-replay — its own 'close' handler cleans up */
        return;
      }
    }

    const detach = startSseHeartbeat(res);
    const client: EventClient = { res, detach, principal };
    this.eventClients.add(client);

    req.on('close', () => {
      detach();
      this.eventClients.delete(client);
    });
  }

  /**
   * `GET /api/events` (JSON) — the same window as a plain fetch, for a client
   * that wants the backlog up front (or has no EventSource at all, e.g. the
   * native app). Bearer-only: a non-SSE route never accepts `?token=`.
   */
  private handleEventBacklog(res: http.ServerResponse, url: URL): void {
    const cursor = this.parseCursor(url.searchParams.get('since'));
    const { reset, entries } = this.replayFrom(cursor);
    return this.json(res, 200, {
      epoch: this.attentionEpoch,
      headId: this.headId(),
      reset,
      // Identity fields go LAST so pane-supplied payload data can never shadow them.
      events: entries.map((e) => ({ ...e.payload, tier: e.tier, id: e.id, kind: e.kind, at: e.at })),
    });
  }

  // --- pairing ------------------------------------------------------------

  /** Mint a fresh single-use pairing code with a bounded lifetime + attempts. */
  private generatePairCode(): void {
    const bytes = crypto.randomBytes(PAIR_CODE_LEN);
    let code = '';
    for (let i = 0; i < PAIR_CODE_LEN; i++) {
      code += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
    }
    this.pairCode = code;
    this.pairExpiresAt = Date.now() + PAIR_TTL_MS;
    this.pairAttempts = PAIR_MAX_ATTEMPTS;
    // Deliberately does NOT clear `pendingDeviceName`. A replacement minted
    // after a burned attempt budget is still the same operator pairing the same
    // device, so the name has to survive it — see the test that burns five
    // attempts and expects the mint to carry the original name. The name is
    // consumed on REDEMPTION instead (burnPairCode), which is the moment it
    // actually became a device.
    this.pairRegeneratedAt = Date.now();
  }

  /**
   * Exchange a pairing code for THIS DEVICE'S OWN credential. Correct code →
   * `{deviceId, deviceSecret, token}` and the code is immediately invalidated
   * (single use). Wrong/expired → 403; a wrong code decrements the attempt
   * budget and burns the code when it hits zero.
   *
   * Before M3 this handed back the server-wide bearer token, which meant every
   * paired device shared one secret and losing a phone meant rotating everyone.
   * The wire keeps a `token` field carrying the composed `deviceId.secret`
   * because that is the string the client presents as its Bearer — one value to
   * store, and the pairing screen keeps working unchanged — but it is now a
   * per-device credential, not the operator's.
   */
  private async handlePair(res: http.ServerResponse, url: URL): Promise<void> {
    const supplied = (url.searchParams.get('code') ?? '').trim().toUpperCase();

    if (!this.pairCode || Date.now() > this.pairExpiresAt) {
      // A burned or expired code used to be gone until the next `start()`,
      // which turned "5 wrong guesses" into a permanent pairing outage. Mint a
      // fresh one instead — rate-limited so this cannot be spun as an oracle —
      // and let the operator read it from `daemon.web.status` / the GUI popover.
      this.pairCode = '';
      if (Date.now() - this.pairRegeneratedAt >= PAIR_REGEN_COOLDOWN_MS) {
        this.generatePairCode();
      }
      return this.json(res, 403, { error: 'expired' });
    }
    if (this.pairAttempts <= 0) {
      this.pairCode = '';
      if (Date.now() - this.pairRegeneratedAt >= PAIR_REGEN_COOLDOWN_MS) {
        this.generatePairCode();
      }
      return this.json(res, 403, { error: 'too many attempts' });
    }

    if (!timingSafeEquals(supplied, this.pairCode)) {
      this.pairAttempts -= 1;
      if (this.pairAttempts <= 0) this.pairCode = '';
      return this.json(res, 403, {
        error: 'invalid code',
        attemptsLeft: Math.max(0, this.pairAttempts),
      });
    }

    // The code is right. Now the transport: a device credential is durable and
    // never expires, so it must not be handed over in the clear to something
    // off-machine. Checked HERE and not only at pairStart because the operator
    // may have restarted the server with `--expose` since the code was minted.
    // The code is NOT burned — the operator should be able to fix the transport
    // and use the code they already read out, and a refusal reveals nothing.
    const refusal = this.mintRefusal();
    if (refusal) return this.json(res, 403, { error: 'insecure-transport', detail: refusal });

    const devices = this.deps.devices;
    if (!devices) {
      // No identity core wired (a daemon that failed to build one). Falling
      // back to the shared token keeps pairing possible instead of bricking it,
      // but it is a real downgrade — per-device revocation does not exist on
      // this server — so say so out loud rather than degrading silently.
      this.deps.log('warn', '[web] pairing without a device store — issuing the shared operator token');
      this.burnPairCode();
      return this.json(res, 200, { token: this.token });
    }

    let minted: { deviceId: string; deviceSecret: string };
    try {
      minted = await devices.mint({
        name: this.pendingDeviceName,
        allowInput: this.pendingDeviceAllowInput,
      });
    } catch (err) {
      // The roster could not be persisted. Do NOT burn the code and do NOT
      // fall back to the shared token: a credential the daemon cannot
      // remember is one the operator can never revoke.
      this.deps.log('error', `[web] device mint failed: ${errMsg(err)}`);
      return this.json(res, 500, { error: 'pairing failed' });
    }

    // Success: hand the credential over exactly once, then burn the code.
    this.burnPairCode();
    return this.json(res, 200, {
      deviceId: minted.deviceId,
      deviceSecret: minted.deviceSecret,
      token: `${minted.deviceId}${DEVICE_CREDENTIAL_SEP}${minted.deviceSecret}`,
    });
  }

  /** Consume the active pairing code (single use) and its pending name. */
  private burnPairCode(): void {
    this.pairCode = '';
    this.pairExpiresAt = 0;
    this.pairAttempts = 0;
    this.pendingDeviceName = undefined;
    // Back to the server's default rather than to `false`: a redeemed code
    // must not leave the NEXT device on this host worse off than the first.
    this.pendingDeviceAllowInput = this.defaultPendingGrant();
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Authenticate an `/api/*` request. Two credential forms, one gate:
   *
   *   `Bearer <token>`             the OPERATOR (CLI, GUI, `--status` URLs)
   *   `Bearer <deviceId>.<secret>` a paired DEVICE
   *
   * The operator token is tried first and always timing-safe, so a device
   * credential that happens to contain a dot cannot be probed against it.
   * Device lookup is BY ID — the store compares one hash, never a linear scan
   * over the roster (§2).
   *
   * `allowQuery` is true ONLY for the two SSE routes, which must accept
   * `?token=` because EventSource cannot set headers. That exception is for the
   * OPERATOR TOKEN ALONE: a device secret is durable and never expires, and a
   * query string is the one place a credential is guaranteed to be written down
   * (history, proxy logs, Referer). So a device credential presented in the
   * query authenticates nothing, on any route.
   */
  private async authenticate(req: http.IncomingMessage, url: URL, allowQuery: boolean): Promise<AuthOutcome> {
    if (!this.token) return { ok: false, reason: 'unknown' };
    const header = req.headers['authorization'];
    const fromHeader =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const fromQuery = allowQuery ? url.searchParams.get('token') : null;

    if (timingSafeEquals(fromHeader ?? fromQuery ?? '', this.token)) {
      return { ok: true, principal: { kind: 'operator' } };
    }

    const devices = this.deps.devices;
    // Header only — see above. `null` here is "no Bearer header at all".
    const cut = fromHeader ? fromHeader.indexOf(DEVICE_CREDENTIAL_SEP) : -1;
    if (!devices || cut <= 0) {
      // No usable header credential. On the SSE routes a device may instead
      // present a stream TICKET (B3) — the narrow, expiring capability that
      // exists precisely because EventSource cannot send a header. Checked last
      // so it can never shadow a real credential, and never on a non-SSE route.
      const viaTicket = allowQuery ? this.resolveStreamTicket(url.searchParams.get('ticket')) : null;
      if (viaTicket && viaTicket.kind === 'device') {
        this.touchDevice(viaTicket.deviceId);
        return { ok: true, principal: viaTicket };
      }
      return { ok: false, reason: 'unknown' };
    }
    const deviceId = fromHeader!.slice(0, cut);
    const secret = fromHeader!.slice(cut + 1);
    // A credential with NOTHING after the separator is malformed, and refusing
    // it here is parsing, not comparison: this branch reads only the bytes the
    // caller sent, never anything stored, so it cannot leak a stored secret's
    // length or content. The constant-time property §2 asks for lives one layer
    // down, where the store derives a fixed-length key from an input of ANY
    // length and reaches the same `timingSafeEqual` every time. Passing a
    // secret-less credential through instead would buy nothing and would hand
    // an unauthenticated caller a free KDF derivation per request.
    if (!secret) return { ok: false, reason: 'unknown' };

    let result: DeviceAuthResult;
    try {
      result = await devices.resolve(deviceId, secret);
    } catch (err) {
      // A store that cannot answer is not an authorization. Fail closed, and
      // never turn an auth failure into a 500 on the route behind it.
      this.deps.log('warn', `[web] device auth failed: ${errMsg(err)}`);
      return { ok: false, reason: 'unknown' };
    }
    if (!result.ok) return { ok: false, reason: result.reason };
    this.touchDevice(result.deviceId);
    return {
      ok: true,
      principal: {
        kind: 'device',
        deviceId: result.deviceId,
        ...(result.name ? { name: result.name } : {}),
        allowInput: result.allowInput,
      },
    };
  }

  /**
   * May this caller type, spawn or close a pane, toggle the permission gate, or
   * approve a tool permission?
   *
   * These five are ONE grant and always have been — the codebase argues each of
   * them back to "it requires the same grant as typing". This is where that
   * grant is decided, so a new write route gets the whole rule by asking rather
   * than by remembering to repeat it.
   *
   * TWO gates, and the order is the security property:
   *
   *  1. `--allow-input` is the CEILING. A server started without it grants
   *     nothing to anyone, exactly as before per-device grants existed, so
   *     "I started it read-only" remains a complete answer and the CLI banner
   *     keeps meaning what it says.
   *  2. Within that, a device brings its own grant. The operator token does
   *     not: it IS the operator, and a credential the operator is holding at
   *     their own desk is not something the roster is entitled to narrow.
   */
  private mayInput(principal: WebPrincipal): boolean {
    if (this.opts?.allowInput !== true) return false;
    return principal.kind === 'operator' || principal.allowInput;
  }

  /** The 403 for a caller the grant above refused, worded for whichever gate said no. */
  private refuseInput(res: http.ServerResponse, principal: WebPrincipal, detail: string): void {
    const serverReadOnly = this.opts?.allowInput !== true;
    return this.json(res, 403, {
      error: serverReadOnly
        ? 'read-only: server started without --allow-input'
        : 'read-only: this device was paired without permission to type',
      detail: serverReadOnly
        ? detail
        : `${detail}. Grant it from "Paired devices" on the machine running wmux web.`,
    });
  }

  /** Report a device's activity to the roster. Bookkeeping — never fatal. */
  private touchDevice(deviceId: string): void {
    try {
      this.deps.devices?.touch?.(deviceId);
    } catch (err) {
      this.deps.log('warn', `[web] device touch failed: ${errMsg(err)}`);
    }
  }

  /**
   * Baseline headers every response carries — the hardening a local HTTP server
   * owes the browser (the same controls Docker / VS Code / Electron apply):
   *   - frame protection, so a page on evil.com cannot iframe this authenticated
   *     terminal and redress clicks into a pane (worse with `--allow-input`);
   *   - `nosniff`, so nothing is re-interpreted as an executable type;
   *   - `no-referrer`, which also keeps the SSE URL's `?token=` (the one route
   *     that must carry it) out of any outbound Referer;
   *   - the full CSP, which used to be `frame-ancestors 'none'` alone. That was
   *     defensible only while the credential an XSS could steal expired at the
   *     next restart; M3 made credentials durable, so `script-src` pinned to the
   *     inlined bundle's hashes is now part of what makes them safe to hand out.
   *     See webCsp.ts for how the hashes are derived and why `style-src` is the
   *     one directive that is not hash-pinned.
   */
  private securityHeaders(): Record<string, string> {
    return {
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Baseline only. The full policy — script hashes and all — rides the HTML
      // response, which is the only thing that executes; #612 made that call
      // and it is the right one, because the alternative puts ~250 bytes of
      // hashes on every JSON reply, and a phone typing pays that per keystroke.
      'Content-Security-Policy': "frame-ancestors 'none'",
    };
  }

  private serveStatic(
    res: http.ServerResponse,
    body: Buffer | null,
    contentType: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    if (!body) {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...this.securityHeaders(),
      });
      res.end('wmux web assets not built — run `npm run build:daemon-web`.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      ...this.securityHeaders(),
      ...extraHeaders,
    });
    res.end(body);
  }

  private json(
    res: http.ServerResponse,
    status: number,
    obj: unknown,
    extraHeaders?: Record<string, string>,
  ): void {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...this.securityHeaders(),
      ...extraHeaders,
    });
    res.end(body);
  }

  private buildUrls(): string[] {
    if (!this.opts) return [];
    const { host, port } = this.opts;
    const token = this.token;
    const scheme = this.opts.tls ? 'https' : 'http';
    const suffix = `:${port}/?token=${token}`;
    // A named reachable host comes FIRST, because it is the address that
    // actually works from a phone. For `--tailscale` this names the HTTPS front;
    // for native TLS it can name the certificate's DNS host instead of an IP
    // address that fails hostname verification.
    //
    // No port: a front is named because it terminates TLS on 443. An operator
    // who fronted on another port writes it into `--allow-host` themselves and
    // it rides through verbatim.
    const named = this.advertisedHosts().map((h) =>
      this.opts?.tls
        ? `https://${urlAuthority(h)}:${port}/?token=${token}`
        : `https://${h}/?token=${token}`,
    );
    // When bound to all interfaces, enumerate concrete reachable addresses so
    // the operator can pick their tailnet IP; otherwise report the bind host.
    if (host === '0.0.0.0' || host === '::') {
      const addrs = collectIpv4();
      const urls = addrs.map((a) => `${scheme}://${a}${suffix}`);
      urls.push(`${scheme}://127.0.0.1${suffix}`);
      return [...named, ...urls];
    }
    return [...named, `${scheme}://${urlAuthority(host)}${suffix}`];
  }

  /**
   * Names the operator supplied with `--allow-host`, normalized the same way
   * the Host gate normalizes them so the two cannot disagree.
   *
   * Only the operator-supplied extras — never the loopback names and local IPs
   * the server adds for the rebinding check. With a proxy these are separately
   * fronted HTTPS addresses; with native TLS they are certificate DNS names.
   */
  private advertisedHosts(): string[] {
    return (this.opts?.allowedHosts ?? [])
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }

  private loadAssets(): void {
    const dir = this.deps.assetsDir;
    this.terminalHtml = readIfExists(path.join(dir, 'terminal.html'));
    this.manifest = readIfExists(path.join(dir, 'manifest.webmanifest'));
    this.serviceWorker = readIfExists(path.join(dir, 'sw.js'));
    this.icon = readIfExists(path.join(dir, 'icon-512.png'));
    // Derived from the page we just loaded, once per start rather than per
    // request: hashing 583 KB on the way out of every response would be a real
    // cost for a header that cannot change while the process runs.
    //
    // This supersedes #612's buildHtmlCsp, which computed the same policy but
    // hashed the file's raw bytes. The HTML parser rewrites CRLF to LF before
    // the tokenizer runs, so a page built from a Windows checkout — where the
    // frontend sources carry CRLF — produced hashes matching nothing the
    // browser would compute, and every inline block was refused: a blank
    // terminal. Verified in a real browser both ways; buildWebCsp normalizes
    // first.
    this.csp = buildWebCsp(this.terminalHtml ? this.terminalHtml.toString('utf8') : null);
    if (!this.terminalHtml) {
      this.deps.log('warn', `[web] terminal.html missing under ${dir} — run \`npm run build:daemon-web\``);
    }
  }
}

// === module helpers =========================================================


/**
 * One SSE frame. `id` is optional and emitted only on the attention stream —
 * the browser echoes the last one back as `Last-Event-ID` when it reconnects,
 * which is the entire replay mechanism. Pane streams stay id-less: their resume
 * story is the ring-buffer snapshot, not an id cursor.
 */
function writeSse(res: http.ServerResponse, event: string, data: string, id?: string): void {
  res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${data}\n\n`);
}

/**
 * Which workspace a pane belongs to, for the browser's session labels.
 *
 * `DaemonSession` has no workspace field — workspaces are a renderer/main
 * concept — but main stamps the identity into every pane's child env at spawn
 * (resolveSpawnEnv) and the daemon persists that env verbatim, so the answer is
 * already here. We read EXACTLY the two identity keys: the session env is the
 * pane's full resolved environment (credentials, account config dirs) and must
 * never reach a browser wholesale.
 *
 * ONLY the name is surfaced. The workspace id is deliberately NOT a fallback:
 * it is a UUID (`ws-192b59b5-…`), which tells a human nothing and is strictly
 * worse than the cwd label the frontend already falls back to.
 *
 * HONEST LIMITATION: the name is a spawn-time snapshot of the env, so panes
 * created before WMUX_WORKSPACE_NAME existed have none (the frontend shows the
 * cwd, exactly as before), and a workspace renamed after a pane spawned keeps
 * showing the old name here. We never invent a label.
 */
/**
 * A short, human name for the program a pane is running, taken from the
 * recorded command. Without it, a pane with no detected agent had nothing to be
 * called but its own cwd, which the row already prints underneath — so every
 * such row read as the same string twice and panes were indistinguishable.
 * Only the basename is surfaced: the full command line can carry arguments, and
 * arguments can carry secrets.
 */
function shellLabelOf(cmd: string | undefined): { shell?: string } {
  if (typeof cmd !== 'string' || !cmd.trim()) return {};
  // Windows program paths contain spaces as a matter of course
  // (C:\Program Files\...\pwsh.exe) and are NOT quoted when they carry no
  // arguments, so neither splitting on whitespace nor trusting quotes is enough
  // on its own: the real shells this sees arrive bare. Take the quoted span
  // when there is one, else everything up to an executable-extension boundary,
  // else the first whitespace-delimited token (the POSIX case, which has no
  // extension to anchor on).
  const trimmed = cmd.trim();
  const quoted = /^"([^"]+)"/.exec(trimmed);
  const exe = /^(.*?\.(?:exe|cmd|bat|com))(?:\s|$)/i.exec(trimmed);
  const first = quoted ? quoted[1] : exe ? exe[1] : trimmed.split(/\s+/)[0];
  const base = first.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.(exe|cmd|bat|com)$/i, '');
  return name ? { shell: name } : {};
}

/**
 * One path segment as an id, or null if it cannot be one.
 *
 * Same discipline as the approval-id decode: a malformed percent-escape is not
 * an error to report, it is an id that by definition names nothing, and a
 * segment containing `/` was never a single segment. Returning null lets both
 * callers answer their own 404 rather than sharing a thrown error.
 */
function decodePathSegment(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!id || id.includes('/')) return null;
  return id;
}

function workspaceLabelOf(env: Record<string, string> | undefined): { workspace?: string } {
  const value = env?.[ENV_KEYS.WORKSPACE_NAME];
  const workspace = typeof value === 'string' ? value.trim() : '';
  return workspace ? { workspace } : {};
}

/**
 * The projection of an approval record that reaches a browser.
 *
 * Field-by-field on purpose, exactly like `workspaceLabelOf`: the registry is
 * daemon-internal and free to grow fields (resolved keystrokes, pane env, the
 * hook envelope it was built from), and none of those should reach the network
 * because someone added them upstream. What is here is what a human needs to
 * decide: which pane, which agent, what was asked, what was on screen, and how
 * it ended.
 *
 * `question` / `options` are AGENT-AUTHORED TEXT (extracted from the
 * AskUserQuestion tool_input), the same trust class as `screenTail`: safe to
 * transport, never safe to render unescaped, and `options` is not a closed set
 * anything security-relevant may key on — the keystroke map, not this list,
 * decides what a decision sends.
 */
function approvalWire(r: ApprovalRequest): Record<string, unknown> {
  return {
    id: r.id,
    sessionId: r.sessionId,
    agent: r.agent,
    kind: r.kind,
    state: r.state,
    createdAt: r.createdAt,
    ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
    // Presence-checked, not truthiness-checked: an empty question or an empty
    // options list is a fact the registry recorded, not a missing field.
    ...(typeof r.question === 'string' ? { question: r.question } : {}),
    ...(Array.isArray(r.options) ? { options: r.options } : {}),
    // Structured choices with key+label for per-option resolve. Additive
    // alongside options — old clients ignore it, new clients use it for
    // choiceKey resolution.
    ...(Array.isArray(r.choices) && r.choices.length > 0 ? { choices: r.choices } : {}),
    // A hint for UI step-up (see ApprovalRequest.risk). Never a permission:
    // every request on this list is answerable through POST regardless.
    ...(r.risk ? { risk: r.risk } : {}),
    ...(r.screenTail ? { screenTail: r.screenTail } : {}),
    ...(r.decision ? { decision: r.decision } : {}),
    ...(r.resolvedBy ? { resolvedBy: r.resolvedBy } : {}),
    ...(typeof r.resolvedAt === 'number' ? { resolvedAt: r.resolvedAt } : {}),
    // Which specific choice was selected, when resolved via choiceKey.
    ...(r.selectedChoiceKey ? { selectedChoiceKey: r.selectedChoiceKey } : {}),
    // #783 — what the gate is asking about. The SSE nudge carries these, but a
    // client that starts (or reconnects) with a gate already pending builds its
    // card from THIS list: without them the operator is asked to approve a
    // shell command with nothing on screen saying which one.
    ...(r.toolName ? { toolName: r.toolName } : {}),
    ...(r.toolInputSummary ? { toolInputSummary: r.toolInputSummary } : {}),
  };
}

/**
 * Construct the HTTP(S) listener and validate native TLS before a live server
 * is stopped. The returned server has not listened yet, so no request can race
 * the caller installing its new options.
 */
function createTransportServer(
  options: WebTerminalStartOptions,
  listener: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): http.Server | https.Server {
  if (!options.tls) return http.createServer(listener);
  if (options.tailscale) {
    throw new Error('native TLS cannot be combined with the Tailscale transport');
  }

  const cert = readTlsPem('certificate', options.tls.certPath);
  const key = readTlsPem('private key', options.tls.keyPath);
  try {
    // createServer builds its secure context immediately. A malformed cert,
    // key, or mismatched pair therefore fails here, before start() stops an
    // existing listener.
    return https.createServer({ cert, key }, listener);
  } catch (error) {
    throw new Error(`TLS certificate/key could not be loaded: ${errMsg(error)}`);
  }
}

function readTlsPem(kind: 'certificate' | 'private key', filePath: string): Buffer {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`TLS ${kind} path must be absolute`);
  }
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'READ_FAILED';
    // Do not echo an absolute local path into RPC logs or bug reports. The
    // flag name already tells the operator which file needs attention.
    throw new Error(`TLS ${kind} file could not be read (${code})`);
  }
}

/**
 * Compare two secrets without leaking WHERE they differ. The length check is a
 * timingSafeEqual precondition (it throws on a mismatch), so credential length
 * remains observable — as it was before M3, and as it is for every bearer
 * scheme that does not pad.
 */
function timingSafeEquals(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readIfExists(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What this blob actually is, by its leading bytes — or null for anything that
 * is not one of the two formats we accept.
 *
 * The Content-Type header is deliberately not consulted. It is a claim by the
 * client about a file the client did not necessarily produce, and the one thing
 * that must not be client-controlled here is the extension we write to disk.
 */
function sniffImageExt(body: Buffer): 'jpg' | 'png' | null {
  if (body.length < PNG_SIGNATURE.length) return null;
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'jpg';
  if (body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
  return null;
}

/**
 * Exactly the names `handleUpload` generates, every segment anchored:
 * `photo-` + an ISO 8601 instant with `:` and `.` rewritten to `-` + `-` +
 * eight lowercase hex + `.jpg` or `.png`.
 *
 * This is a DELETION predicate, so it is written to be over-strict rather than
 * convenient. `~/.wmux/uploads` is also where an operator stages files for
 * `browser_file_upload`, and a looser pattern (`photo-*.jpg`) would happily
 * unlink `photo-vacation.jpg` a day after they put it there. Nothing this route
 * did not write is ever removed.
 */
const UPLOAD_NAME_RE = /^photo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.(jpg|png)$/;

/**
 * Delete uploads older than the TTL. Modelled on `pruneOldLogs`, including the
 * swallow-everything posture: a sweep is housekeeping, and a failure to tidy up
 * must never turn into a failed upload.
 */
function pruneUploads(dir: string, now: number): void {
  try {
    const cutoff = now - UPLOAD_TTL_MS;
    for (const file of fs.readdirSync(dir)) {
      if (!UPLOAD_NAME_RE.test(file)) continue;
      const full = path.join(dir, file);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* skip file on stat/unlink failure */
      }
    }
  } catch {
    /* dir missing — nothing to sweep */
  }
}

/**
 * What this route is currently holding, for the quota check. Counts the SAME
 * names the sweep would delete and nothing else — an operator's own staged
 * files are not ours to delete, so they are not ours to charge for either.
 *
 * An unreadable directory reads as empty. The write is about to fail on its own
 * if the directory is genuinely broken, and that error is the useful one.
 */
function measureUploads(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!UPLOAD_NAME_RE.test(file)) continue;
      try {
        bytes += fs.statSync(path.join(dir, file)).size;
        files += 1;
      } catch {
        /* vanished between readdir and stat — not holding anything */
      }
    }
  } catch {
    /* dir missing — nothing held */
  }
  return { files, bytes };
}

/**
 * A host as it may appear in a URL authority: IPv6 literals must be bracketed
 * (`http://::1:7681` is rejected by browsers and `new URL()` alike).
 */
function urlAuthority(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Non-internal IPv4 addresses, tailnet-first. Tailscale hands out CGNAT-range
 * addresses (100.64.0.0/10), which are the ones a phone actually reaches, so
 * surface them ahead of ordinary LAN addresses.
 */
function collectIpv4(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        out.push(info.address);
      }
    }
  }
  const isTailnet = (ip: string): boolean => {
    const m = ip.match(/^100\.(\d+)\./);
    if (!m) return false;
    const second = Number(m[1]);
    return second >= 64 && second <= 127;
  };
  return out.sort((a, b) => Number(isTailnet(b)) - Number(isTailnet(a)));
}
