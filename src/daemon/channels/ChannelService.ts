// ─── ChannelService ────────────────────────────────────────────────────
// Daemon-side channel state owner. The ONLY writer to ChannelState — every
// mutation funnels through this service so the per-channel mutex, idempotency
// LRU, and `saveImmediate` PERSIST_FAILED surfacing stay in one place.
//
// The service holds:
//   - `state: ChannelState` — in-memory mirror, loaded from the writer at
//     construction and re-saved on every mutation. The writer is the
//     persistence model; this service is the in-memory authoritative copy
//     for the lifetime of the daemon.
//   - `mutexes: Map<channelId, Promise<void>>` — per-channel promise chain.
//     Each mutation for a given channelId waits for the previous one to
//     finish. Channels don't contend with each other (different keys).
//   - `idempotency: Map<channelId, Map<clientMsgId, {seq, lastUsedAt}>>` —
//     LRU cache of recent clientMsgIds, capped at CHANNEL_IDEMPOTENCY_CAP
//     per channel. Lookups in the post path are O(1) amortized; eviction
//     is O(n) only on overflow.
//
// Plan reference: U3 (a2a-channels service layer).

import { randomUUID } from 'node:crypto';
import {
  canonicalizeChannelName,
  CHANNEL_BODY_MAX,
  CHANNEL_DATA_MAX,
  CHANNEL_MENTIONS_MAX,
  CHANNEL_IDEMPOTENCY_CAP,
  CHANNEL_MAX_COUNT,
  CHANNEL_MAX_MEMBERS,
  CHANNEL_MESSAGES_MAX,
  CHANNEL_TOPIC_MAX,
  isValidChannelName,
  type Channel,
  type ChannelDroppedMention,
  type ChannelMember,
  type ChannelMention,
  type ChannelMessage,
  type ChannelRecipientStatus,
  type ChannelState,
  type ChannelStatus,
  type ChannelVisibility,
  HUMAN_WORKSPACE_ID,
  HUMAN_MEMBER_ID,
  OPERATOR_JOIN_SYSTEM_TEXT,
  type OperatorChannelSummary,
} from '../../shared/channels';
import { HUMAN_SELF_PRINCIPAL_ID } from '../../shared/principals';
import { CHANNELS_EPOCH, EMPTY_CHANNEL_STATE } from '../../shared/channels';
import { makeEnvelope, type AuthContext } from '../../shared/eventlog';
import { ChannelStateWriter, reapEmptyChannels } from './ChannelStateWriter';
import { applyChannelEvent, type ChannelEventPayload } from './channelEvents';
import type { AppendOnlyLog } from '../eventlog/AppendOnlyLog';
import type { SnapshotStore } from '../eventlog/SnapshotStore';
import { CHANNEL_PROJECTION_REF } from '../eventlog/SnapshotStore';

/**
 * Event payload emitted by the service after a successful post. The
 * `workspaceId` field is the SENDER's workspace (base scoping per the
 * wmux protocol convention; the recipient list is in `recipients`).
 * The wiring layer (U4) projects this to the main-process EventBus
 * after workspace-scope resolution.
 */
export interface ChannelMessageEvent {
  type: 'channel.message';
  channelId: string;
  seq: number;
  sender: { workspaceId: string; memberId: string; memberName: string };
  recipients: ChannelRecipientStatus[];
  message: ChannelMessage;
  /** Sender's workspaceId. */
  workspaceId: string;
}

/**
 * A2A channels catalog/membership lifecycle event (A1). Unlike
 * ChannelMessageEvent (a posted message), this signals that a channel's CATALOG
 * row or MEMBERSHIP changed (create/archive/join/leave/kick/invite) so other
 * renderers re-sync their mirror instead of going silently stale. It is a
 * SIGNAL — the receiver re-hydrates the channel by id; no row is embedded, so
 * the daemon stays authoritative and a removed member that re-fetches finds the
 * channel gone and drops it. The wiring layer projects this to the EventBus
 * `channel.catalog` (DaemonNotificationRouter), scoped per-recipient by
 * events.poll exactly like channel.message.
 */
export interface ChannelCatalogEvent {
  type: 'channel.catalog';
  channelId: string;
  /** The workspace that performed the mutation (becomes the base workspaceId). */
  actorWorkspaceId: string;
  /** Every workspace that must re-sync: the post-change member set PLUS any
   *  workspace removed by this change (so a kicked/left member also drops the
   *  channel from its mirror). */
  recipientWorkspaceIds: string[];
  /** What changed — advisory only; the receiver re-hydrates regardless.
   *  'cursor' = a member's read cursor advanced (agent ack): roster "N
   *  behind" badges hydrate from the same catalog fetch (Codex re-review). */
  reason: 'created' | 'archived' | 'membership' | 'cursor';
}

/** Shape of the `emit` callback injected by the daemon. Carries either a posted
 *  message (channel.message) or a catalog/membership lifecycle signal
 *  (channel.catalog). */
export type ChannelServiceEmit = (event: ChannelMessageEvent | ChannelCatalogEvent) => void;

/** Typed error codes surfaced from the service to the caller. */
export type ChannelErrorCode =
  | 'INVALID_NAME'
  | 'CHANNEL_NOT_FOUND'
  | 'CHANNEL_ARCHIVED'
  | 'NOT_A_MEMBER'
  | 'DUPLICATE_MEMBER'
  | 'PERSIST_FAILED'
  /** Caller is not permitted to perform this action (server-pin sender,
   *  archive authz). The server uses the verified workspaceId (resolved
   *  by the transport layer — MCP `requireWorkspaceId`, the renderer's
   *  bridge, etc.) as the authoritative caller identity. A mismatch with
   *  the client-supplied `sender.workspaceId` (post path) or a non-creator
   *  / non-CEO caller (archive path) yields this code. */
  | 'NOT_AUTHORIZED'
  /** Post body over `CHANNEL_BODY_MAX` / topic over `CHANNEL_TOPIC_MAX`.
   *  Enforced pre-persist so the writer never sees oversize content. */
  | 'CHANNEL_BODY_TOO_LARGE'
  /** Post `data` payload over `CHANNEL_DATA_MAX` (JSON-serialized length).
   *  Same pre-persist enforcement as the body cap. */
  | 'CHANNEL_DATA_TOO_LARGE'
  /** Per-company channel count over `CHANNEL_MAX_COUNT` or per-channel
   *  member count over `CHANNEL_MAX_MEMBERS`. Enforced in `create`. */
  | 'CHANNEL_LIMIT_REACHED'
  /** A single post requested more than `CHANNEL_MENTIONS_MAX` @mentions.
   *  Bounds the O(mentions x members) validation done under the channel lock
   *  and the size of the `droppedMentions` feedback echoed back to the sender. */
  | 'CHANNEL_MENTIONS_TOO_MANY';

export interface ChannelError {
  code: ChannelErrorCode;
  message: string;
}

/**
 * Event-log backend (envelope-design §5, PR3 — optional additive).
 *
 * When set, the commit point flips from saveOrFail (full-state synchronous write)
 * to log.append(envelope) (D1 phased flip): the log is canonical, channels.json is
 * a watermark-stamped debounced dual-write cache (§6.4), and snapshot/channel.json
 * is a boot-acceleration snapshot (§5). Boot seeds via the snapshot fallback chain
 * + `lamport > snapshotLamport` tail replay.
 *
 * When unset (legacy/tests), the existing saveOrFail commit path remains as a
 * 1-bit invariant — the premise of §10 T-parity (existing channel tests pass
 * unchanged).
 */
export interface ChannelServiceEventLog {
  /** Open (open() complete) append-only log. Owned by the daemon boot gate. */
  log: AppendOnlyLog;
  /** `events/snapshot/` store (boot seed + debounced snapshots). */
  snapshots: SnapshotStore;
  /** manifest.genesisRef — floor of the fallback chain (§6.2). */
  genesisRef: string;
  /** manifest.reseedRefs — intermediate stages of the fallback chain (§6.4c). */
  reseedRefs: string[];
  /** origin.machineId(§8). */
  machineId: string;
  /** Empty-channel reaper TTL (hours). Default CHANNEL_EMPTY_TTL_HOURS_DEFAULT. */
  emptyChannelTtlHours?: number;
}

export interface ChannelServiceDeps {
  /** The persistence layer. `saveImmediate` returns false on write failure
   *  (U1) and the post path surfaces that as `PERSIST_FAILED`. The full
   *  `ChannelStateWriter` is required because we read `load()` at
   *  construction to seed in-memory state. */
  writer: ChannelStateWriter;
  /** Event-log backend (§5). When absent, the legacy commit path (tests, old wiring) is unchanged. */
  eventLog?: ChannelServiceEventLog;
  /** Company this daemon's channels belong to. Channels are company-bounded
   *  by design (see plan KTD10). */
  companyId: string;
  /** Company CEO's workspaceId. Used as the override for the archive
   *  authz gate (KTD-F): the CEO may archive any channel regardless of
   *  who created it. When `undefined`, only the creator can archive.
   *  Daemon-side this stays `undefined` until the company-mode config
   *  key lands (the renderer owns `Company.ceoWorkspaceId` today). */
  ceoWorkspaceId?: string;
  /** Event sink. Called once per successful post. */
  emit: ChannelServiceEmit;
  /** Time source. Defaults to `Date.now`. Override in tests for stable seq. */
  now?: () => number;
  /**
   * 1b (server-owned roster identity) — resolve a principal stable coordinate
   * to its registry display name. Injected (rather than taking the whole
   * PrincipalService) so channel tests need no registry fixture and the
   * coupling surface stays one function. Optional: when absent, memberName
   * derivation falls back to the memberId (legacy construction sites, tests).
   */
  resolvePrincipalDisplay?: (principalId: string) => string | undefined;
  /**
   * 1b/1d bridge (review F1/F2) — resolve the caller's CURRENT pty to its
   * pane principal. join() uses it when the joiner supplies no principalId
   * (the CLI path): the pane's registry identity supplies the pretty
   * display, lets a spawn-stamped default (memberId === senderPtyId)
   * converge onto the pane's canonical auto-name seat, and dedups a second
   * seat for a pane that is already a member via another entry path.
   */
  resolvePrincipalByPtyId?: (ptyId: string) => { id: string; display?: string; memberId?: string } | undefined;
}

/** Sender identity carried in post/join payloads. */
export interface SenderRef {
  workspaceId: string;
  memberId: string;
  /**
   * 1b: OPTIONAL since the daemon now derives the authoritative name from
   * the roster row (principal display, else memberId). A client-supplied
   * value is used only as the message-snapshot fallback when no roster row
   * matches (see post()'s unmatchedMemberId path).
   */
  memberName?: string;
  /** R2 — the principal stable coordinate to record on the member row (optional, additive). */
  principalId?: string;
}

export interface CreateChannelParams {
  name: string;
  visibility: ChannelVisibility;
  topic?: string;
  createdBy: SenderRef;
  /** D5 — server-resolved caller workspace (resolved by the transport layer
   *  from a verified `senderPtyId`). The channel's `createdBy` AND the creator
   *  member's `workspaceId` are pinned to THIS, not the caller-supplied
   *  `createdBy.workspaceId` — a forger must not be able to attribute a channel
   *  to a victim, since `createdBy` feeds the archive authz gate (KTD-F).
   *  Required and consistent with the other mutating params (Join/Leave/Post/
   *  Archive); the daemon create handler fails closed without it. */
  verifiedWorkspaceId: string;
  /** Initial members to auto-add alongside the creator (U6 member cap).
   *  The creator is always added regardless of this field. When omitted,
   *  the channel starts with only the creator (the historical default). */
  members?: SenderRef[];
}

export interface ArchiveChannelParams {
  channelId: string;
  archivedBy: string;
  /** Server-verified workspaceId (resolved by the transport layer).
   *  The archive authz gate (KTD-F) requires the caller to be the
   *  channel's creator OR the company CEO; both are checked against
   *  this field, not against `archivedBy` (which the client supplies
   *  and could lie about). */
  verifiedWorkspaceId: string;
}

export interface JoinChannelParams {
  channelId: string;
  member: SenderRef;
  /** When false, the new member's `historyFromSeq` is set to the
   *  channel's current `nextSeq` (so they don't see older history). */
  includeHistory?: boolean;
  /** D5 — server-resolved caller workspace. The joining member's workspaceId
   *  is pinned to THIS, not the caller-supplied `member.workspaceId`, so a
   *  forger cannot join a channel as a victim workspace. */
  verifiedWorkspaceId: string;
  /**
   * 1b/1d bridge — the caller's verified ptyId, already present on the raw
   * pipe params (the CLI/MCP transports send it for workspace resolution;
   * post persists it). join() uses it to resolve the joiner's PANE PRINCIPAL
   * when no explicit principalId is supplied, so a CLI self-join gets the
   * registry display instead of an opaque ptyId and the same pane cannot be
   * seated twice via different entry paths (review F1/F2). Routing/display
   * only — never an authz input (#113).
   */
  senderPtyId?: string;
}

/**
 * operator-join (design §2.1) — parameters for an operator (human) joining a
 * private channel created by agents on their own. **Exactly two fields** (type-level
 * enforcement, Codex #2): the seat row is built from constants only in the body;
 * member/includeHistory etc. sent by the caller are never read — the core guard
 * against P5-style injection (bypassing create's members[]). Extra fields on the raw
 * params object do not exist on this type, so the body cannot access them (separate
 * body from join() — no shared helper that consumes caller fields).
 */
export interface OperatorJoinParams {
  channelId: string;
  /** Server-verified workspaceId. The seat is hardcoded so this is not an authz input —
   *  existence check only for the "no anonymous mutation" posture (kick convention).
   *  Residual direct-call semantics are in design §2.1.2. */
  verifiedWorkspaceId: string;
}

/**
 * operator-list (design §2.2) — private-channel discovery affordance. Single
 * parameter verifiedWorkspaceId (existence check only). Returns metadata for all
 * channels.
 */
export interface OperatorListParams {
  verifiedWorkspaceId: string;
}

export interface LeaveChannelParams {
  channelId: string;
  workspaceId: string;
  memberId: string;
  /** D5 — server-resolved caller workspace. A caller may only remove its OWN
   *  membership: `workspaceId` must equal this, else NOT_AUTHORIZED. */
  verifiedWorkspaceId: string;
}

export interface KickChannelParams {
  channelId: string;
  /** The workspace being EJECTED. Unlike leave() — which self-pins so a caller
   *  can only remove ITSELF — kick() removes a DIFFERENT, caller-supplied member.
   *  This is the one membership removal that is not self-pinned. */
  targetWorkspaceId: string;
  /** The specific member row to eject. A workspace may hold several member rows
   *  (one per agent), so kick removes the exact (targetWorkspaceId, targetMemberId)
   *  row — mirrors leave()'s precise (workspace, member) match. */
  targetMemberId: string;
  /** Server-resolved workspace of the HUMAN performing the kick, recorded for
   *  attribution. NOTE: kick has NO ChannelService-level authz gate beyond
   *  channel/member existence — the daemon cannot tell a renderer call from a
   *  pipe call, so it does not try. The "humans only" policy is enforced one
   *  layer up by TRANSPORT: kick rides ONLY the renderer-only
   *  `channels:mutate-local` IPC (pipe-unreachable) and is deliberately NOT
   *  registered on the `a2a.channel.*` pipe router, so no MCP/agent caller can
   *  reach this method (mirrors the `a2a.channel.ack` precedent). Reaching the
   *  daemon control pipe directly is the documented same-user residual (F1),
   *  identical to every other channel mutation. */
  verifiedWorkspaceId: string;
}

export interface PurgeMembershipParams {
  /** The workspace to clean up — a deleted workspace or the owner of a closed pane. */
  workspaceId: string;
  /** When set, removes only that (workspaceId, memberId) row across all channels
   *  (pane close). When absent, removes every row of the workspace (workspace deletion). */
  memberId?: string;
  /** When set, matches rows by principal stable coordinate instead of memberId —
   *  the default for the pane-close path. memberId (auto name) may drift on agent
   *  swap/reorder, but principalId is immutable for the pane's lifetime, so it
   *  sweeps exactly that pane's rows. */
  principalId?: string;
  /** The workspace of the human/GUI that performed the cleanup — for attribution.
   *  As with kick, there is no ChannelService-level authz gate: the "humans-only"
   *  boundary is enforced by the TRANSPORT (renderer-only `channels:mutate-local`,
   *  not registered on the pipe router). */
  verifiedWorkspaceId: string;
}

export interface InviteChannelParams {
  channelId: string;
  /** The workspace/agent being ADDED. Unlike join(), the invitee is NOT the
   *  caller — invite() adds a DIFFERENT workspace, gated by the inviter being
   *  a current member (P1b authz decision A: any member may invite). The
   *  invitee's workspaceId is the caller-supplied target (the one membership
   *  mutation that is not self-pinned); same-machine identity is forgeable
   *  (#113, accepted ceiling) so this sets the intended model, not a hard gate. */
  invitedMember: SenderRef;
  /** When false, the invitee's `historyFromSeq` is set to the channel's current
   *  `nextSeq` (no older history). Default (undefined) = full history (0), so an
   *  invited teammate can catch up — mirrors join()'s history rule. */
  includeHistory?: boolean;
  /** D5 — server-resolved INVITER workspace. The authz gate requires THIS to be
   *  a current member; it is never the invitee. */
  verifiedWorkspaceId: string;
}

export interface PostMessageParams {
  channelId: string;
  sender: SenderRef;
  text: string;
  /** Server-verified workspaceId (resolved by the transport layer —
   *  MCP `requireWorkspaceId` for first-party tools, the renderer
   *  bridge for the in-app composer). The post path pins the sender's
   *  authoritative workspace from THIS field, not from
   *  `sender.workspaceId` (which the client supplies and could lie
   *  about). A mismatch yields `NOT_AUTHORIZED`. */
  verifiedWorkspaceId: string;
  /** Idempotency key. Two posts with the same `clientMsgId` on the same
   *  channel return the original message; the second is a no-op. */
  clientMsgId?: string;
  /** Optional structured data (R10). */
  data?: unknown;
  /** @-mentions from the composer/agent. Validated server-side: each entry is
   *  kept only if its `workspaceId` is a CURRENT channel member (the same
   *  membership set that gates posting), then deduped by workspace. Non-member
   *  mentions are dropped — you cannot ping a workspace that isn't in the room.
   *  This validated set is what Phase 2 inbox routing trusts. */
  mentions?: ChannelMention[];
  /** R1 — the caller's verified pane (daemon session id), attached by the MCP
   *  transport and resolved to a live session by the stamp layer. Persisted
   *  verbatim onto the message as `senderPtyId` so the receiving renderer can
   *  tell a self-loop from a same-ws sibling mention. Opaque pass-through here:
   *  the daemon owns the workspace/membership gate, not the live pane tree. */
  senderPtyId?: string;
}

/** Discriminated success/failure envelope returned by every public method.
 *  Each method has its own `T` describing its success payload (e.g.
 *  `CreateChannelResult` for `create`). The `ok: false` branch always
 *  carries a typed `ChannelError` so callers can branch on `error.code`
 *  without parsing `error.message` strings. */
export type Result<T> =
  | ({ ok: true } & T)
  | { ok: false; error: ChannelError };

/** Result for methods that only return success/failure without a payload.
 *  Uses `void` (not `Record<string, never>`) so the success literal
 *  `{ ok: true }` satisfies the type — `Record<string, never>` would
 *  require every property to be `never`, including `ok`. */
export type EmptyResult = Result<void>;

/** Idempotency cache entry. `lastUsedAt` drives LRU eviction on overflow. */
interface IdempotencyEntry {
  seq: number;
  lastUsedAt: number;
  /** droppedMentions computed on the ORIGINAL post, so a retry with the same
   *  clientMsgId gets the same sender feedback instead of a silent drop on the
   *  replay (in-memory only — not persisted across a daemon restart). */
  droppedMentions?: ChannelDroppedMention[];
  /** 1c — same replay contract as droppedMentions (Codex #2): the retry that
   *  lost the FIRST response is exactly when the identity-drift warning
   *  matters most, so the replay must re-emit it too. Like droppedMentions,
   *  IN-MEMORY ONLY: `state.idempotency` persists just the seq, so a replay
   *  after a daemon restart returns the message without this warning. */
  unmatchedMemberId?: string;
}

export class ChannelService {
  private readonly writer: ChannelStateWriter;
  private readonly eventLog?: ChannelServiceEventLog;
  private state: ChannelState;
  private readonly mutexes = new Map<string, Promise<void>>();
  private readonly idempotency = new Map<string, Map<string, IdempotencyEntry>>();
  private readonly companyId: string;
  private readonly ceoWorkspaceId: string | undefined;
  private readonly emit: ChannelServiceEmit;
  private readonly now: () => number;
  private readonly resolvePrincipalDisplay?: (principalId: string) => string | undefined;
  private readonly resolvePrincipalByPtyId?: (
    ptyId: string,
  ) => { id: string; display?: string; memberId?: string } | undefined;

  /**
   * 1b — derive the server-owned display name for a member row. Principal
   * registry display when the coordinate resolves, else the memberId itself.
   * Best-effort: a resolver throw degrades to the memberId (display must
   * never fail a membership mutation), but it is LOGGED — a silently failing
   * registry would quietly downgrade every new row's display (GLM review).
   */
  private deriveMemberName(memberId: string, principalId?: string): string {
    if (principalId && this.resolvePrincipalDisplay) {
      try {
        const display = this.resolvePrincipalDisplay(principalId);
        if (typeof display === 'string' && display.length > 0) return display;
      } catch (err) {
        console.error('[ChannelService] principal display lookup failed:', err);
      }
    }
    return memberId;
  }
  /**
   * Monotonic counter advanced once per persisted `clientMsgId` entry
   * during hydration (U7). It seeds `lastUsedAt` so the first post on
   * a saturated channel evicts the entry hydrated first — a
   * deterministic FIFO of persisted entries — rather than a random
   * one (which `Date.now()` would do when many entries share the same
   * millisecond). After hydration is done, the counter is unused;
   * live posts stamp `lastUsedAt` from `this.now()` as before.
   */
  private hydrationSeq = 0;

  constructor(deps: ChannelServiceDeps) {
    this.writer = deps.writer;
    this.eventLog = deps.eventLog;
    if (deps.eventLog) {
      // Log-mode boot (§5): seed via snapshot fallback chain (latest→.bak→reseed→genesis)
      // and tail-replay only channel records with `lamport > snapshotLamport`. channels.json
      // is no longer a seed source (watermark check and dual-write target only — §6.4).
      this.state = this.seedFromEventLog(deps.eventLog);
    } else {
      // Seed from the writer. The writer's `load()` runs the empty-channel
      // reaper and prototype-pollution guards before we get the data, so
      // the service can trust the shape.
      this.state = this.writer.load();
    }
    this.companyId = deps.companyId;
    this.ceoWorkspaceId = deps.ceoWorkspaceId;
    this.emit = deps.emit;
    this.now = deps.now ?? (() => Date.now());
    this.resolvePrincipalDisplay = deps.resolvePrincipalDisplay;
    this.resolvePrincipalByPtyId = deps.resolvePrincipalByPtyId;
    // Channels v2 cursor backfill — member rows persisted before the
    // `lastReadSeq` field existed get the channel HEAD ("start reading from
    // now"), NOT 0: a 0 default would flag the entire history unread on
    // upgrade and trigger a re-nudge storm (design doc, spec-review issue 4).
    // Deterministic on every construction, so a crash before the next persist
    // simply re-derives the same values.
    for (const channel of this.state.channels) {
      const head = channel.nextSeq - 1;
      for (const member of this.state.members[channel.id] ?? []) {
        if (typeof member.lastReadSeq !== 'number' || !Number.isFinite(member.lastReadSeq)) {
          member.lastReadSeq = head;
        }
      }
    }
    // P5 (unified human identity) — merge every per-workspace human row into
    // THE single virtual-workspace row. Pre-P5, joining/creating stamped the
    // then-active workspace, scattering the one human across `(ws-X,
    // 'local-ui')` rows and binding the channel view to the active workspace.
    // Deterministic on every construction (same crash-safety contract as the
    // lastReadSeq backfill above — and it runs AFTER it, so every cursor is a
    // number): a pre-P5 state re-merges identically, a post-P5 state is a
    // no-op, and the merged shape persists on the next regular save.
    for (const channel of this.state.channels) {
      const rows = this.state.members[channel.id] ?? [];
      const humanRows = rows.filter((m) => m.memberId === HUMAN_MEMBER_ID);
      if (humanRows.length === 0) continue;
      if (humanRows.length === 1 && humanRows[0].workspaceId === HUMAN_WORKSPACE_ID) continue;
      this.state.members[channel.id] = [
        {
          workspaceId: HUMAN_WORKSPACE_ID,
          memberId: HUMAN_MEMBER_ID,
          // Earliest seat wins: the human has been "in" since their first join.
          joinedAt: Math.min(...humanRows.map((m) => m.joinedAt)),
          // Widest visibility + furthest cursor: the human is ONE principal, so
          // if any seat read up to seq N the human has seen the content up to N
          // (ship review: Claude adversarial confirmed this semantic). Codex
          // flagged a narrow edge — a seat with a narrow history floor but a
          // high (e.g. backfilled-to-head) cursor could mark a low seq read that
          // only a WIDER-history seat could see but didn't. It is benign here:
          // the ws-human cursor feeds only the now-excluded wake sweep (never a
          // renderer badge — the renderer computes unread from live events), and
          // opening the channel re-acks to head regardless.
          historyFromSeq: Math.min(...humanRows.map((m) => m.historyFromSeq)),
          lastReadSeq: Math.max(...humanRows.map((m) => m.lastReadSeq ?? 0)),
          principalId: HUMAN_SELF_PRINCIPAL_ID,
        },
        ...rows.filter((m) => m.memberId !== HUMAN_MEMBER_ID),
      ];
    }
    // Hydrate the idempotency LRU from persisted state (R9). Without
    // this, a daemon restart loses every `clientMsgId → seq` mapping
    // and a retry after restart silently allocates a fresh seq — the
    // exact failure mode the U2 maintainer directive warned against.
    // The persisted shape is `Record<channelId, Record<clientMsgId,
    // number>>` (a plain object for JSON portability); the in-memory
    // shape is `Map<channelId, Map<clientMsgId, {seq, lastUsedAt}>>`
    // (an LRU map for O(1) lookup + O(n) eviction only on overflow).
    for (const [channelId, clientMap] of Object.entries(this.state.idempotency)) {
      const inner = new Map<string, IdempotencyEntry>();
      for (const [key, seq] of Object.entries(clientMap)) {
        // A11 (codex+GLM): only hydrate composite-format keys (JSON
        // [workspaceId, clientMsgId]). A pre-upgrade `channels.json` stored bare
        // `clientMsgId` keys that can't be migrated (no sender was recorded); the
        // post path now looks up the composite key and would miss them anyway, so
        // skip them rather than seed dead LRU slots. Worst case is one duplicate
        // on a cross-restart retry of a single pre-upgrade post.
        if (!key.startsWith('[')) continue;
        inner.set(key, { seq, lastUsedAt: ++this.hydrationSeq });
      }
      this.idempotency.set(channelId, inner);
    }
  }

  // ── Read-only ─────────────────────────────────────────────────────

  /**
   * List channels visible to the verified caller (U6 membership +
   * visibility gate). Returns every public channel + every private
   * channel the caller is a member of. Active AND archived rows are
   * returned — the renderer decides how to render archived channels
   * (collapsed group, badge, etc.).
   *
   * The membership gate runs per-channel: a public channel is always
   * visible; a private channel is visible iff the caller's
   * `verifiedWorkspaceId` appears in its member list.
   */
  list(verifiedWorkspaceId: string): Channel[] {
    return this.state.channels
      .filter((channel) => this.isObservableBy(channel, verifiedWorkspaceId))
      .map((channel) => this.withObservedFlag(channel, verifiedWorkspaceId));
  }

  /**
   * Return a channel by id, gated on visibility for the verified
   * caller. A private channel that does not include the caller is
   * indistinguishable from a missing channel from the caller's POV
   * (returns null — same as a non-existent id). The renderer
   * collapses null into "channel not found" UI without leaking the
   * existence of a private room the caller cannot see.
   */
  get(channelId: string, verifiedWorkspaceId: string): Channel | null {
    const channel = this.state.channels.find((c) => c.id === channelId);
    if (!channel) return null;
    // W1: read gate — members/public, plus the local human operator observing
    // read-only. A private channel remains indistinguishable from a missing one
    // for every OTHER non-member caller. The observed stamp matches list() (GLM
    // P3): a renderer path that fills its mirror from get() must see the same
    // caller-relative flag, or the read-only banner would silently vanish.
    if (!this.isObservableBy(channel, verifiedWorkspaceId)) return null;
    return this.withObservedFlag(channel, verifiedWorkspaceId);
  }

  /**
   * operator-list (design §2.2) — discovery affordance. Private channels are hidden
   * from non-members in list(), so the GUI needs a way to show "rooms you can enter".
   * Returns **metadata only** for all channels (public+private, active+archived) —
   * no message previews or member details (to read content you must operatorJoin,
   * which leaves a system message §2.1.1). verifiedWorkspaceId is for existence
   * check only, not filtering: return all channels (keep name — a nameless list
   * invites blind joins and is worse §2.2); empty list when absent (no anonymous).
   * Accidental exposure is gated by GUI intent (collapsed default operator section §3).
   * In residual direct-call paths, this method becoming a "full private channel
   * name·memberCount enumeration oracle" is explicitly accepted as disk-equivalent
   * in §2.2.
   *
   * Sort determinism: createdAt ascending, id lexicographic tiebreak (stable).
   */
  operatorList(params: OperatorListParams): OperatorChannelSummary[] {
    // Existence check (no anonymous). Handler already filters absence, but defense
    // in depth returns empty here too — no enumeration without an identity stamp even
    // for residual direct callers (not a defense boundary vs disk, but API stays no
    // stronger than disk).
    if (!params.verifiedWorkspaceId) return [];
    return this.state.channels
      .map((c) => ({
        id: c.id,
        name: c.name,
        visibility: c.visibility,
        status: c.status,
        memberCount: (this.state.members[c.id] ?? []).length,
        createdAt: c.createdAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /**
   * Return the members of a channel, gated on the caller being a
   * member (or the channel being public). Private channels do not
   * expose their member list to non-members — the empty-array
   * return is intentional; the renderer treats it as "no access."
   */
  getMembers(channelId: string, verifiedWorkspaceId: string): ChannelMember[] {
    const channel = this.state.channels.find((c) => c.id === channelId);
    if (!channel) return [];
    // W1: read gate — the local human operator sees the roster of an observed
    // private channel (read-only; it is not itself in that roster).
    if (!this.isObservableBy(channel, verifiedWorkspaceId)) return [];
    return this.state.members[channelId] ?? [];
  }

  /**
   * Return messages for a channel, gated on visibility + membership
   * AND floored at the viewer's `historyFromSeq` for non-public
   * channels. The seq-floor mirrors `isMessageVisibleToViewer` in
   * `src/renderer/components/Channels/ChannelView.tsx` — a member
   * who joined late (`historyFromSeq = nextSeq at join time`) cannot
   * see earlier messages via this endpoint. Public channels have
   * no floor (any verified caller sees the full history from `sinceSeq`).
   *
   * The seq-floor is `Math.max(sinceSeq ?? 0, viewer.historyFromSeq)`
   * so a caller can still page with `sinceSeq` on top of the floor.
   *
   * `limit` (optional) caps the result to the most recent `limit` messages
   * AFTER the seq-floor is applied (tail slice). It exists to protect an
   * agent caller's context window: an MCP `channel_read` defaults it to a
   * small N, while the renderer omits it (undefined = no cap = full history,
   * the pre-existing behaviour — do NOT default it here or the human
   * ChannelView would silently truncate).
   */
  getMessages(
    channelId: string,
    sinceSeq: number | undefined,
    verifiedWorkspaceId: string,
    limit?: number,
  ): ChannelMessage[] {
    const channel = this.state.channels.find((c) => c.id === channelId);
    if (!channel) return [];
    // W1: read gate — members/public, plus the local human operator observing.
    if (!this.isObservableBy(channel, verifiedWorkspaceId)) return [];
    const all = this.state.messages[channelId] ?? [];
    // Floor at the viewer's historyFromSeq for non-public channels.
    // Public channels have no per-member history cap.
    let floor = sinceSeq ?? 0;
    if (channel.visibility !== 'public') {
      const viewer = (this.state.members[channelId] ?? []).find(
        (m) => m.workspaceId === verifiedWorkspaceId,
      );
      if (!viewer) {
        // W1 (operator observation): the local human operator observes a private
        // agent channel read-only WITHOUT a member row, so there is no per-member
        // historyFromSeq floor to apply — return the FULL history (audit-
        // equivalent, matching operator-join's historyFromSeq=0). Any OTHER
        // non-member is unreachable here (isObservableBy gated the read above to
        // members + ws-human only); the guard keeps a future visibility-rule
        // change fail-closed for non-humans.
        if (verifiedWorkspaceId !== HUMAN_WORKSPACE_ID) return [];
      } else {
        floor = Math.max(floor, viewer.historyFromSeq);
      }
    }
    const filtered = all.filter((m) => m.seq >= floor);
    if (limit !== undefined && limit >= 0) {
      // Two paging modes (Codex re-review P1):
      //  - sinceSeq given → the caller is CONSUMING forward from a cursor:
      //    return the OLDEST `limit` rows at/after it. Tail-slicing here made
      //    the unread→read→ack loop lossy past `limit` unread — the page
      //    showed the newest rows, acking its head seq then jumped the cursor
      //    over everything between the cursor and the page (silent loss).
      //    Oldest-first pages are contiguous, so "ack the highest seq you
      //    read, repeat until drained" is always safe.
      //  - no sinceSeq → display semantics: the most recent `limit` rows.
      // The renderer never passes `limit` (it floors sinceSeq instead —
      // loadChannelHistory), so the split touches only the CLI/MCP consume
      // path. `Math.max(0, …)` keeps limit=0 → [] and limit>length → full
      // list correct (a bare `.slice(-0)` would return the whole array).
      if (sinceSeq !== undefined) {
        return filtered.slice(0, limit);
      }
      return filtered.slice(Math.max(0, filtered.length - limit));
    }
    return filtered;
  }

  /** Per-channel visibility rule. A channel is visible to the caller
   *  when it is public OR the caller is in its member list. This is the
   *  MEMBERSHIP gate — it backs every WRITE path (join's #288 gate, the
   *  post membership check) and stays strict so observation can never
   *  unlock speaking or a roster seat. */
  private isVisibleTo(channel: Channel, verifiedWorkspaceId: string): boolean {
    if (channel.visibility === 'public') return true;
    const members = this.state.members[channel.id] ?? [];
    return members.some((m) => m.workspaceId === verifiedWorkspaceId);
  }

  /**
   * W1 (operator observation) — READ visibility for the local human operator.
   * A channel is observable when it is visible (member or public) OR the caller
   * is the reserved human workspace: the local human observes agent channels
   * read-only. Intentionally WIDER than isVisibleTo and used ONLY by the read
   * paths (list/get/getMembers/getMessages) — write/membership gates keep using
   * isVisibleTo, so observation grants no post and no roster seat (participation
   * still requires an explicit operator-join, which leaves a durable system
   * message). Security: a wire (pipe/MCP) caller cannot present the ws-human
   * identity — the pipe router rejects the reserved workspace as a caller/
   * target ref AND, since W1, rejects a bare self-claimed ws-human READ scope
   * unless the request came through trusted in-process dispatch
   * (ctx.firstParty — the renderer bridge / plugin host; see the gate in
   * a2a.channel.rpc.ts forward()). That router gate is what makes this
   * assertion true: without it, an unresolved-senderPtyId wire read passed the
   * caller-supplied verifiedWorkspaceId through verbatim. So only a real local
   * human (the app itself) reaches this branch; an agent can never obtain it.
   * The only NEW exposure is a private agent channel's message CONTENT to the
   * local human operator — consistent with the operator model (a human owns
   * every local workspace) and with operatorList, which already exposes
   * private channel metadata.
   */
  private isObservableBy(channel: Channel, verifiedWorkspaceId: string): boolean {
    if (this.isVisibleTo(channel, verifiedWorkspaceId)) return true;
    return verifiedWorkspaceId === HUMAN_WORKSPACE_ID;
  }

  /**
   * W1 (operator observation) — stamp `observed: true` on a private channel the
   * caller can observe but is NOT a member of (only the reserved human
   * workspace ever reaches this — every other caller is filtered out upstream
   * by isObservableBy). Caller-relative + additive, stamped on a SHALLOW COPY
   * so the live `state.channels` row is never mutated (and the flag never
   * persists). Shared by list() AND get() so any renderer path that fills its
   * mirror sees a consistent flag — the renderer classifies observed rows into
   * the normal dock list with a read-only badge and hides the composer.
   */
  private withObservedFlag(channel: Channel, verifiedWorkspaceId: string): Channel {
    if (channel.visibility !== 'public' && !this.isVisibleTo(channel, verifiedWorkspaceId)) {
      return { ...channel, observed: true };
    }
    return channel;
  }

  // ── Mutating (per-channel mutex) ──────────────────────────────────

  /**
   * Create a new channel. Canonicalizes the name, rejects duplicates
   * within the same company, and auto-adds the creator as a member
   * with `historyFromSeq: 0` (KTD10). Returns the authoritative
   * `Channel` row on success; `INVALID_NAME` if the name fails
   * validation; `PERSIST_FAILED` if the writer's `saveImmediate` returns
   * `false`. The critical section is keyed on a sentinel (`__create__`)
   * so two concurrent creates serialise on each other.
   */
  async create(params: CreateChannelParams): Promise<Result<{ channel: Channel }>> {
    return this.withChannelLock('__create__', async () => {
      const name = canonicalizeChannelName(params.name);
      if (!isValidChannelName(name)) {
        return { ok: false, error: { code: 'INVALID_NAME', message: `Invalid channel name: ${params.name}` } };
      }
      // Topic length cap (U6). Measured on the trimmed form so a caller
      // cannot pad with whitespace to bypass the cap.
      if (params.topic !== undefined && params.topic.length > CHANNEL_TOPIC_MAX) {
        return {
          ok: false,
          error: {
            code: 'CHANNEL_BODY_TOO_LARGE',
            message: `Topic exceeds ${CHANNEL_TOPIC_MAX} characters`,
          },
        };
      }
      // Per-company channel cap. Catches a runaway client before the
      // in-memory state grows unbounded.
      if (this.state.channels.filter((c) => c.companyId === this.companyId).length >= CHANNEL_MAX_COUNT) {
        return {
          ok: false,
          error: {
            code: 'CHANNEL_LIMIT_REACHED',
            message: `Company channel limit reached (${CHANNEL_MAX_COUNT})`,
          },
        };
      }
      // Per-channel member cap (creator + initial members). Counts the
      // creator explicitly so the cap cannot be silently exceeded when
      // `members` is omitted (the creator is always added regardless).
      const initialMemberCount = 1 + (params.members?.length ?? 0);
      if (initialMemberCount > CHANNEL_MAX_MEMBERS) {
        return {
          ok: false,
          error: {
            code: 'CHANNEL_LIMIT_REACHED',
            message: `Channel member limit reached (${CHANNEL_MAX_MEMBERS})`,
          },
        };
      }
      // Reject duplicate names within the same company.
      if (this.state.channels.some((c) => c.companyId === this.companyId && c.name === name)) {
        return { ok: false, error: { code: 'INVALID_NAME', message: `Channel name already exists: ${name}` } };
      }
      // P5: the reserved human workspace is never seeded as an initial member
      // from create(). Symmetric with invite()'s guard — enforced daemon-side so
      // a direct-socket caller (under the #113 ceiling) cannot bypass the
      // main-router members[] guard and plant a phantom human row (ship review).
      // Validated BEFORE the channel is pushed into state so a rejection leaves
      // NO orphaned in-memory channel (adversarial review: the in-loop guard
      // early-returned after the push, leaking a phantom row until restart).
      if ((params.members ?? []).some((m) => m.workspaceId === HUMAN_WORKSPACE_ID)) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: 'The reserved human workspace cannot be seeded as a channel member',
          },
        };
      }
      const now = this.now();
      const channel: Channel = {
        id: `ch-${randomUUID()}`,
        companyId: this.companyId,
        name,
        visibility: params.visibility,
        status: 'active',
        createdAt: now,
        // D5: pin the creator to the server-resolved verifiedWorkspaceId, NOT
        // the caller-supplied createdBy.workspaceId — a forger must not be able
        // to attribute a channel to a victim, since createdBy feeds the archive
        // authz gate below (L459).
        createdBy: params.verifiedWorkspaceId,
        nextSeq: 1,
        ...(params.topic !== undefined ? { topic: params.topic } : {}),
      };
      // Auto-add the creator as a member (plan KTD10). Optional
      // initial members (U6) are appended after the creator; duplicates
      // against the creator are silently dropped so a caller cannot
      // double-stamp the creator and skew the count.
      // P5: stamp the human principal when the creator is the human seat, so
      // a GUI-created channel's human row matches the migrated shape.
      const creatorPrincipalId =
        params.verifiedWorkspaceId === HUMAN_WORKSPACE_ID &&
        params.createdBy.memberId === HUMAN_MEMBER_ID
          ? HUMAN_SELF_PRINCIPAL_ID
          : undefined;
      const initialMembers: ChannelMember[] = [
        {
          // D5: the creator's membership is keyed to the server-resolved
          // verifiedWorkspaceId (same pin as createdBy above).
          workspaceId: params.verifiedWorkspaceId,
          memberId: params.createdBy.memberId,
          joinedAt: now,
          historyFromSeq: 0,
          // v2 cursor seeded at head (nextSeq-1 = 0 on a fresh channel):
          // a brand-new channel starts with zero unread.
          lastReadSeq: 0,
          ...(creatorPrincipalId ? { principalId: creatorPrincipalId } : {}),
          // 1b: server-owned display name (principal display, else memberId) —
          // never the caller-supplied free-text memberName.
          memberName: this.deriveMemberName(params.createdBy.memberId, creatorPrincipalId),
        },
      ];
      for (const member of params.members ?? []) {
        if (
          initialMembers.some(
            (m) => m.workspaceId === member.workspaceId && m.memberId === member.memberId,
          )
        ) {
          continue;
        }
        initialMembers.push({
          workspaceId: member.workspaceId,
          memberId: member.memberId,
          joinedAt: now,
          historyFromSeq: 0,
          lastReadSeq: 0,
          // R2: principal stable coordinate (additive).
          ...(member.principalId ? { principalId: member.principalId } : {}),
          // 1b: server-owned display name.
          memberName: this.deriveMemberName(member.memberId, member.principalId),
        });
      }
      if (this.eventLog) {
        // G1 append-then-apply: apply only after barrier success. Failure = no apply (no rollback).
        if (
          !(await this.commitAndApply(
            { kind: 'create', channel, members: initialMembers },
            {
              verifiedWorkspaceId: params.verifiedWorkspaceId,
              principalId: creatorPrincipalId ?? params.createdBy.principalId ?? params.createdBy.memberId,
            },
          ))
        ) {
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel create' } };
        }
      } else {
        // Legacy mode (1-bit invariant): apply → synchronous save → rollback on failure.
        this.state.channels.push(channel);
        this.state.members[channel.id] = initialMembers;
        this.state.messages[channel.id] = [];
        this.state.idempotency[channel.id] = {};
        if (!this.saveOrFail()) {
          // Roll back to keep the in-memory state in sync with disk.
          this.state.channels.pop();
          delete this.state.members[channel.id];
          delete this.state.messages[channel.id];
          delete this.state.idempotency[channel.id];
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel create' } };
        }
      }
      // A1: catalog changed (created) — fan out to the initial member set so
      // their sidebars show the new channel without a manual refresh.
      this.emitCatalog(
        channel.id,
        params.verifiedWorkspaceId,
        // A1 (codex+GLM P2): a public channel is discoverable by EVERY workspace
        // (list() shows it to all), so broadcast its creation with the '*'
        // sentinel; a private channel notifies only its initial members.
        channel.visibility === 'public' ? ['*'] : initialMembers.map((m) => m.workspaceId),
        'created',
      );
      return { ok: true, channel };
    });
  }

  /**
   * Archive a channel. Sets `status: 'archived'` and `archivedAt`.
   * Members retain history access (KTD-G). Subsequent `post` calls
   * return `CHANNEL_ARCHIVED`. `CHANNEL_NOT_FOUND` if the id is unknown;
   * `NOT_AUTHORIZED` if the verified caller is not a member (or the company
   * CEO); `PERSIST_FAILED` if the writer cannot save.
   *
   * Authz mirrors kick(): a member (or the CEO) may archive. There is no
   * privileged "creator" — `createdBy` is metadata (audit trail) only, never an
   * authz input. Like kick, archive is HUMANS-ONLY at the TRANSPORT layer
   * (renderer-only `channels:mutate-local`; deliberately absent from the
   * `a2a.channel.*` pipe router), so no agent/MCP caller can reach it — a
   * same-machine agent identity is forgeable (#113), so an agent-reachable
   * archive would let any member-workspace agent tear a channel down for everyone.
   */
  async archive(params: ArchiveChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      // Authz: caller must be a current member OR the company CEO (mirrors
      // kick()). `verifiedWorkspaceId` is server-resolved; the client-supplied
      // `archivedBy` is recorded as metadata only, never trusted for the gate.
      const isCeo = this.ceoWorkspaceId !== undefined && this.ceoWorkspaceId === params.verifiedWorkspaceId;
      const isMember = (this.state.members[channel.id] ?? []).some(
        (m) => m.workspaceId === params.verifiedWorkspaceId,
      );
      if (!isMember && !isCeo) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: 'Only a member or the company CEO may archive this channel',
          },
        };
      }
      const now = this.now();
      if (this.eventLog) {
        // G1 append-then-apply: apply only after barrier success. Failure = no apply (no rollback).
        if (
          !(await this.commitAndApply(
            { kind: 'archive', channelId: channel.id, archivedAt: now, archivedBy: params.archivedBy },
            { verifiedWorkspaceId: params.verifiedWorkspaceId, principalId: params.archivedBy },
          ))
        ) {
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel archive' } };
        }
      } else {
        // Legacy mode (1-bit invariant): apply → synchronous save → rollback on failure.
        channel.status = 'archived';
        channel.archivedAt = now;
        channel.archivedBy = params.archivedBy;
        if (!this.saveOrFail()) {
          // Roll back.
          channel.status = 'active';
          delete channel.archivedAt;
          delete channel.archivedBy;
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel archive' } };
        }
      }
      // A1: catalog changed (archived) — fan out to current members so other
      // renderers flip to read-only instead of offering a post that will fail.
      this.emitCatalog(
        channel.id,
        params.verifiedWorkspaceId,
        (this.state.members[channel.id] ?? []).map((m) => m.workspaceId),
        'archived',
      );
      return { ok: true };
    });
  }

  /**
   * Add a member to a channel. `DUPLICATE_MEMBER` if already present.
   * `includeHistory: false` (default) sets the new member's
   * `historyFromSeq` to the channel's current `nextSeq` so they don't
   * see older history; `includeHistory: true` sets it to `0` (full
   * history). Members of an `emptySince`-tagged channel clear that
   * tag on join so the empty-channel reaper stops counting it.
   */
  async join(params: JoinChannelParams): Promise<Result<{
    /** 1b/1d bridge — the member id the seat was ACTUALLY created under.
     *  May differ from the requested id when a spawn-stamped default
     *  (memberId === senderPtyId) converged onto the pane's canonical
     *  auto-name seat. Callers report THIS, not what they sent. */
    memberId?: string;
  }>> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      // #288 — fail-closed visibility gate. You may JOIN a channel only if you
      // may SEE it (the same `isVisibleTo` invariant the read paths use):
      // public ⇒ always; private ⇒ the caller's verified workspace must already
      // be a member (seeded at create time). Without this, any same-machine
      // pipe/MCP caller that knows a private channel's id could self-join it and
      // unlock its full history + LIVE fan-out (the joiner lands in every future
      // post's recipientSnapshot + receives the channel.message event) and appear
      // in the roster — reads are membership-scoped, so join was the escalation.
      //
      // We return CHANNEL_NOT_FOUND with the SAME message as a missing channel
      // (NOT a distinct NOT_AUTHORIZED) so a non-member cannot distinguish a
      // private channel they're locked out of from a non-existent id — symmetric
      // with get()/getMembers()/getMessages(), which hide private existence from
      // non-members. An existing member of a private channel passes this gate
      // (they're visible) and falls through to the precise DUPLICATE_MEMBER below.
      if (!this.isVisibleTo(channel, params.verifiedWorkspaceId)) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      // A10: reject join on a read-only (archived) channel — mirrors invite()'s
      // and kick()'s archived gate. Without this, join was the one membership
      // mutation that ignored lifecycle, letting a caller be added to a frozen
      // channel and slip past the read-only contract.
      if (channel.status === 'archived') {
        return { ok: false, error: { code: 'CHANNEL_ARCHIVED', message: 'Cannot join an archived channel' } };
      }
      const members = this.state.members[channel.id] ?? [];
      // 1b/1d bridge (review F1/F2): when the joiner supplies no explicit
      // principalId (the CLI path), resolve the pane principal from the
      // caller's verified pty. Three things fall out of one lookup:
      //  - the pretty registry display for the row's memberName (F1);
      //  - a spawn-stamped DEFAULT member id (memberId === senderPtyId, the
      //    1d stamp — not an explicit human choice) converges onto the
      //    pane's canonical auto-name seat, so GUI-add and CLI-join land on
      //    the SAME row instead of forking;
      //  - a principal-keyed duplicate check, so a pane already seated via
      //    another entry path cannot get a second row (F2).
      let joinMemberId = params.member.memberId;
      let panePrincipal: { id: string; display?: string; memberId?: string } | undefined;
      if (
        !params.member.principalId &&
        params.senderPtyId &&
        this.resolvePrincipalByPtyId &&
        // The human seat never resolves through a pane pty — a direct-socket
        // caller forging senderPtyId alongside the human member must not get
        // a pane display stamped onto the human row (delta review 1-low).
        params.verifiedWorkspaceId !== HUMAN_WORKSPACE_ID
      ) {
        try {
          panePrincipal = this.resolvePrincipalByPtyId(params.senderPtyId);
        } catch (err) {
          console.error('[ChannelService] principal-by-pty lookup failed:', err);
        }
        if (
          panePrincipal?.memberId &&
          joinMemberId === params.senderPtyId // the 1d default, not an explicit --member
        ) {
          joinMemberId = panePrincipal.memberId;
        }
      }
      // Reject duplicate membership (keyed on the server-resolved workspace).
      if (members.some((m) => m.workspaceId === params.verifiedWorkspaceId && m.memberId === joinMemberId)) {
        return {
          ok: false,
          error: {
            code: 'DUPLICATE_MEMBER',
            // When the id CONVERGED (caller sent the spawn default, the pane's
            // canonical seat already exists) the caller doesn't know the seat
            // id it collided with — name it.
            message:
              joinMemberId !== params.member.memberId
                ? `Already a member as "${joinMemberId}" (same pane)`
                : 'Already a member',
          },
        };
      }
      // F2 — principal-keyed dedup: the same PANE must not hold two seats in
      // one workspace just because it entered once via the GUI (auto-name
      // memberId) and once via the CLI (ptyId memberId).
      if (panePrincipal) {
        const samePane = members.find(
          (m) => m.workspaceId === params.verifiedWorkspaceId && m.principalId === panePrincipal?.id,
        );
        if (samePane) {
          return {
            ok: false,
            error: {
              code: 'DUPLICATE_MEMBER',
              message: `Already a member as "${samePane.memberId}" (same pane)`,
            },
          };
        }
      }
      // F2b (delta review 1 - reproduced double-seat): a seat created under
      // the RAW spawn default BEFORE the registry resolved this pane carries
      // memberId === ptyId and NO principalId, so neither dedup above can
      // see it once a later join converges to the auto-name. The caller's
      // verified pty IS that seat's id — collide on it explicitly.
      //
      // Residual (documented): the REVERSE order — converged seat exists,
      // registry entry lost (restart backfill), new join under the raw
      // default — is uncorrelatable without a registry hit; the lifecycle
      // reconcile (plan 4a) is the eventual sweeper for such rows.
      if (params.senderPtyId && joinMemberId !== params.senderPtyId) {
        const rawSeat = members.find(
          (m) => m.workspaceId === params.verifiedWorkspaceId && m.memberId === params.senderPtyId,
        );
        if (rawSeat) {
          return {
            ok: false,
            error: {
              code: 'DUPLICATE_MEMBER',
              message: `Already a member as "${rawSeat.memberId}" (same pane, pre-registry seat)`,
            },
          };
        }
      }
      const now = this.now();
      const historyFromSeq = params.includeHistory === false ? channel.nextSeq : 0;
      // R2: principal stable coordinate (additive, for display/routing). P5:
      // a fresh human seat (ws-human, local-ui) is stamped with the human
      // principal daemon-side so it matches the migrated row's shape — the
      // renderer join/create paths send no principalId (ship review:
      // data-migration shape drift), so normalize here where every transport
      // converges.
      const joinPrincipalId =
        params.verifiedWorkspaceId === HUMAN_WORKSPACE_ID &&
        params.member.memberId === HUMAN_MEMBER_ID
          ? HUMAN_SELF_PRINCIPAL_ID
          : (params.member.principalId ?? panePrincipal?.id);
      // 1b: server-owned display name — explicit-principal registry display,
      // else the pty-resolved pane principal's display, else the memberId.
      const joinMemberName =
        panePrincipal?.display && !params.member.principalId
          ? panePrincipal.display
          : this.deriveMemberName(joinMemberId, joinPrincipalId);
      const joinedRow: ChannelMember = {
        // D5: pin the joining member to the server-resolved workspace, NOT the
        // caller-supplied member.workspaceId — a forger must not join as a victim.
        workspaceId: params.verifiedWorkspaceId,
        memberId: joinMemberId,
        joinedAt: now,
        historyFromSeq,
        // v2 cursor: "start reading from now" — a joiner may SEE history
        // (historyFromSeq) but does not owe an ack for the backlog; unread
        // starts at 0 so the wake worker never nudge-storms a fresh member.
        lastReadSeq: channel.nextSeq - 1,
        ...(joinPrincipalId ? { principalId: joinPrincipalId } : {}),
        memberName: joinMemberName,
      };
      if (this.eventLog) {
        // G1 append-then-apply: apply only after barrier success (push + emptySince
        // clear are applier duties). Failure = no apply (no rollback).
        if (
          !(await this.commitAndApply(
            { kind: 'join', channelId: channel.id, member: joinedRow },
            {
              verifiedWorkspaceId: params.verifiedWorkspaceId,
              principalId: joinPrincipalId ?? joinMemberId,
            },
          ))
        ) {
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel join' } };
        }
      } else {
        // Legacy mode (1-bit invariant): apply → synchronous save → rollback on failure.
        // Snapshot emptySince so we can restore it on a saveOrFail
        // rollback (R10). Without the snapshot, a failed persist would
        // leave the channel with NO emptySince even though it should
        // still be tagged for the reaper — the channel could end up
        // living forever despite zero members. The symmetric
        // snapshot/restore pattern lives in `leave()` below.
        const previousEmptySince = channel.emptySince;
        // If the channel was empty (emptySince set), clear the empty marker —
        // the channel is alive again.
        if (channel.emptySince !== undefined) {
          delete channel.emptySince;
        }
        members.push(joinedRow);
        this.state.members[channel.id] = members;
        if (!this.saveOrFail()) {
          // Roll back the push AND restore the prior emptySince tag.
          members.pop();
          channel.emptySince = previousEmptySince;
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel join' } };
        }
      }
      // A1: membership changed (join) — fan out to the post-join member set
      // (includes the new member) so every roster + sidebar re-syncs.
      this.emitCatalog(
        channel.id,
        params.verifiedWorkspaceId,
        (this.state.members[channel.id] ?? []).map((m) => m.workspaceId),
        'membership',
      );
      return { ok: true, memberId: joinMemberId };
    });
  }

  /**
   * operator-join (design §2.1) — trusted path for an operator (human) to join a
   * private channel created by agents **on their own**. Consciously bypasses the #288
   * visibility gate (existence → archived → duplicate gates match join()), but **the
   * seat row is built from constants only and never reads caller params** — separate
   * body from join() (no shared helper consuming caller fields, P5-style injection
   * guard, Codex #2).
   *
   * Error codes (§2.1): missing id → CHANNEL_NOT_FOUND (no need to hide existence
   * from owner — unlike join()'s private masking, only actual absence uses this code),
   * archived → CHANNEL_ARCHIVED, already member → DUPLICATE_MEMBER (GUI treats as
   * no-op; not silent-success — semantics match join()).
   *
   * On success, **durably append** one server-issued system message to channel history
   * (§2.1.1 required): seat push and message append are bundled in one commit
   * (operator-join envelope) for atomicity — on persist failure both are unapplied
   * (log mode) or both rolled back (legacy mode). This trail is (a) durable audit
   * surviving leave and (b) the only device for a human to spot forged entry (§2.1.2)
   * in the GUI via #113 residual.
   *
   * authz: verifiedWorkspaceId is not authz input because the seat is hardcoded —
   * existence check only (kick convention). humans-only is enforced by transport
   * (pipe not registered §2.3). Re-entry: re-operatorJoin after leave is a "new seat"
   * like ordinary join (unread reset) — no state carry-over (§2.1, GLM ①).
   */
  async operatorJoin(params: OperatorJoinParams): Promise<Result<{ memberId: string }>> {
    // "no anonymous mutation" — reject missing verifiedWorkspaceId (symmetric deep
    // defense with handler). Seat is hardcoded so not authz input, but calls without
    // a stamp are rejected (kick/archive convention). Handler rejects the same
    // (daemon/index.ts).
    if (!params.verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      // archived gate — same as join()/invite()/kick(). Do not seat on archived
      // channels (§2.1: join rejects with CHANNEL_ARCHIVED).
      if (channel.status === 'archived') {
        return { ok: false, error: { code: 'CHANNEL_ARCHIVED', message: 'Cannot join an archived channel' } };
      }
      const members = this.state.members[channel.id] ?? [];
      // duplicate gate — human seat uses (HUMAN_WORKSPACE_ID, HUMAN_MEMBER_ID)
      // constants; judged by this single row regardless of caller input.
      if (members.some((m) => m.workspaceId === HUMAN_WORKSPACE_ID && m.memberId === HUMAN_MEMBER_ID)) {
        return { ok: false, error: { code: 'DUPLICATE_MEMBER', message: 'Already a member' } };
      }
      const now = this.now();
      // seq consumed by the system message — capture nextSeq before append for seat
      // lastReadSeq (§2.1: lastReadSeq = nextSeq-1). Message consumes this seq and
      // operator is author so unread exempts self-authored messages → operator
      // unread = 0 (§2.1 "unread = 0").
      const seq = channel.nextSeq;
      // Seat row — **constants only** (design §2.1). Does not read caller params.
      // Shape matches P5 merged human row (no memberName — renderer substitutes
      // localized "Me"): workspaceId / memberId / joinedAt / historyFromSeq(full
      // history=0) /
      // lastReadSeq(nextSeq-1) / principalId.
      const seatRow: ChannelMember = {
        workspaceId: HUMAN_WORKSPACE_ID,
        memberId: HUMAN_MEMBER_ID,
        joinedAt: now,
        historyFromSeq: 0,
        lastReadSeq: channel.nextSeq - 1,
        principalId: HUMAN_SELF_PRINCIPAL_ID,
      };
      // Server-issued system message (§2.1.1). Identified by systemKind; text is fallback.
      // Actual nudge suppression is unreadFor()'s systemKind exemption — audit marker
      // creates no one's unread so wake worker does not nudge on this row.
      // deliveryStatus='delivered' marks "not delivery" only; does not affect unread/
      // wake decisions.
      const systemMessage: ChannelMessage = {
        channelId: channel.id,
        seq,
        workspaceId: HUMAN_WORKSPACE_ID,
        memberId: HUMAN_MEMBER_ID,
        memberName: this.deriveMemberName(HUMAN_MEMBER_ID, HUMAN_SELF_PRINCIPAL_ID),
        text: OPERATOR_JOIN_SYSTEM_TEXT,
        postedAt: now,
        deliveryStatus: 'delivered',
        systemKind: 'operator-join',
      };
      if (this.eventLog) {
        // Log mode: atomically commit seat+message in one operator-join envelope. Both
        // apply only after fsync barrier success — failure = no apply (partial state
        // structurally impossible, no rollback block). This is log-mode "atomic rollback
        // on persist failure".
        if (
          !(await this.commitAndApply(
            { kind: 'operator-join', channelId: channel.id, member: seatRow, message: systemMessage },
            { verifiedWorkspaceId: params.verifiedWorkspaceId, principalId: HUMAN_SELF_PRINCIPAL_ID },
          ))
        ) {
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist operator join' } };
        }
      } else {
        // Legacy mode: apply seat push + seq consumption + message append, then sync save.
        // On failure, atomic rollback of all three (§2.1.1): pop message → un-bump nextSeq
        // → pop seat → restore emptySince. Same pattern as join()/post() legacy rollback.
        const previousEmptySince = channel.emptySince;
        if (channel.emptySince !== undefined) delete channel.emptySince;
        members.push(seatRow);
        this.state.members[channel.id] = members;
        channel.nextSeq++;
        (this.state.messages[channel.id] ??= []).push(systemMessage);
        if (!this.saveOrFail()) {
          const msgs = this.state.messages[channel.id];
          if (msgs) msgs.pop();
          channel.nextSeq--;
          members.pop();
          channel.emptySince = previousEmptySince;
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist operator join' } };
        }
      }
      // Membership-change fanout — re-sync roster/sidebar for post-join member set
      // (includes human) (same signal as join()). Best-effort; §2.1.1 system message
      // leaves durable trail separately (but channel history tail-evicts at
      // CHANNEL_MESSAGES_MAX so trail retention is bounded — not an infinite audit log).
      this.emitCatalog(
        channel.id,
        HUMAN_WORKSPACE_ID,
        (this.state.members[channel.id] ?? []).map((m) => m.workspaceId),
        'membership',
      );
      // System message live fanout (best-effort) — show immediately in open ChannelView.
      // Failures ignored like post() (durability already guaranteed by durable append
      // above). System marker so recipients is empty.
      try {
        this.emit({
          type: 'channel.message',
          channelId: channel.id,
          seq,
          sender: {
            workspaceId: HUMAN_WORKSPACE_ID,
            memberId: HUMAN_MEMBER_ID,
            memberName: systemMessage.memberName,
          },
          recipients: [],
          message: systemMessage,
          workspaceId: HUMAN_WORKSPACE_ID,
        });
      } catch (err) {
        console.error('[ChannelService] operatorJoin system-message emit failed:', err);
      }
      return { ok: true, memberId: HUMAN_MEMBER_ID };
    });
  }

  /**
   * Remove a member from a channel. `NOT_A_MEMBER` if absent. The
   * last member leaving sets `emptySince` so the empty-channel reaper
   * prunes the row after the TTL; a subsequent `join` clears
   * `emptySince` (the `create` path is unaffected — a freshly created
   * channel never has `emptySince`).
   */
  async leave(params: LeaveChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      const members = this.state.members[channel.id] ?? [];
      const idx = members.findIndex(
        // D5: a caller may only remove its OWN membership (the server-resolved
        // workspace), not an arbitrary caller-supplied workspaceId.
        (m) => m.workspaceId === params.verifiedWorkspaceId && m.memberId === params.memberId,
      );
      if (idx < 0) {
        return { ok: false, error: { code: 'NOT_A_MEMBER', message: 'Not a member' } };
      }
      // Snapshot the removed member (legacy rollback re-insert + emit recipient calc).
      const removed = members[idx];
      if (this.eventLog) {
        // G1 append-then-apply: **pre-decide** emptySince (removal is applier duty —
        // stamp value recorded as effect when last member leaves). Failure = no apply
        // (no rollback).
        const emptySince =
          members.length === 1 && channel.emptySince === undefined ? this.now() : undefined;
        if (
          !(await this.commitAndApply(
            {
              kind: 'leave',
              channelId: channel.id,
              workspaceId: params.verifiedWorkspaceId,
              memberId: params.memberId,
              ...(emptySince !== undefined ? { emptySince } : {}),
            },
            { verifiedWorkspaceId: params.verifiedWorkspaceId, principalId: params.memberId },
          ))
        ) {
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel leave' } };
        }
      } else {
        // Legacy mode (1-bit invariant): apply → synchronous save → rollback on failure.
        members.splice(idx, 1);
        // If the channel is now empty, stamp `emptySince` (plan KTD8).
        if (members.length === 0 && channel.emptySince === undefined) {
          channel.emptySince = this.now();
        }
        this.state.members[channel.id] = members;
        if (!this.saveOrFail()) {
          // Roll back: re-insert at the original index.
          members.splice(idx, 0, removed);
          // Clear the emptySince stamp we just set.
          if (members.length === 1) delete channel.emptySince;
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel leave' } };
        }
      }
      // A1: membership changed (leave) — fan out to the remaining members AND
      // the workspace that just left (so its own mirror drops the channel).
      this.emitCatalog(
        channel.id,
        params.verifiedWorkspaceId,
        [
          ...(this.state.members[channel.id] ?? []).map((m) => m.workspaceId),
          removed.workspaceId,
        ],
        'membership',
      );
      return { ok: true };
    });
  }

  /**
   * Eject ANOTHER member from a channel (humans-only — see KickChannelParams).
   * The mirror of leave(): leave() self-pins so a caller can only remove ITSELF;
   * kick() removes the caller-supplied (targetWorkspaceId, targetMemberId) row.
   *
   * Authz is NOT gated in this method — the daemon cannot distinguish a renderer
   * call from a pipe call, so the "humans only" boundary lives in the TRANSPORT
   * layer (renderer-only `channels:mutate-local` IPC + deliberately absent from
   * the `a2a.channel.*` pipe router, mirroring `a2a.channel.ack`). Within the
   * daemon we only enforce existence: `CHANNEL_NOT_FOUND` for an unknown id,
   * `NOT_A_MEMBER` when the target row is absent, `PERSIST_FAILED` on a writer
   * failure (rolled back). The last member removed stamps `emptySince` so the
   * empty-channel reaper prunes the row after the TTL — identical to leave().
   */
  async kick(params: KickChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      // Reject membership mutation on a read-only (archived) channel — mirrors
      // invite()'s archived gate. kick is the eject-mirror of invite (managing
      // OTHERS' membership), so it must honor the same read-only contract: a
      // roster click that races a concurrent archive, or stale renderer state,
      // must not slip a removal past the lifecycle (review-team: codex P2). The
      // UI's `canKick` gate is local-only and therefore not authoritative.
      if (channel.status === 'archived') {
        return { ok: false, error: { code: 'CHANNEL_ARCHIVED', message: 'Cannot kick from an archived channel' } };
      }
      const members = this.state.members[channel.id] ?? [];
      // B5: the actor must be a current member OR the company CEO (mirrors
      // archive()'s CEO override — GLM flagged kick had no override, so a
      // non-member CEO moderating a channel would be wrongly blocked). A
      // non-member non-CEO must not eject members. The humans-only TRANSPORT
      // boundary already blocks agents from reaching kick; this closes the "any
      // member-less caller can kick" hole within that boundary (audit SE-B5c:
      // kick had zero actor gate).
      const kickIsCeo =
        this.ceoWorkspaceId !== undefined && this.ceoWorkspaceId === params.verifiedWorkspaceId;
      if (!kickIsCeo && !members.some((m) => m.workspaceId === params.verifiedWorkspaceId)) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: 'Only a member or the company CEO may kick from this channel',
          },
        };
      }
      const idx = members.findIndex(
        // Target match (NOT self-pinned, unlike leave) — eject the exact
        // (targetWorkspaceId, targetMemberId) row the human picked in the roster.
        (m) => m.workspaceId === params.targetWorkspaceId && m.memberId === params.targetMemberId,
      );
      if (idx < 0) {
        return { ok: false, error: { code: 'NOT_A_MEMBER', message: 'Target is not a member' } };
      }
      // Snapshot the removed member (legacy rollback re-insert + emit recipient calc, mirrors leave).
      const removed = members[idx];
      if (this.eventLog) {
        // G1 append-then-apply (same shape as leave): failure = no apply (no rollback).
        const emptySince =
          members.length === 1 && channel.emptySince === undefined ? this.now() : undefined;
        if (
          !(await this.commitAndApply(
            {
              kind: 'kick',
              channelId: channel.id,
              targetWorkspaceId: params.targetWorkspaceId,
              targetMemberId: params.targetMemberId,
              ...(emptySince !== undefined ? { emptySince } : {}),
            },
            { verifiedWorkspaceId: params.verifiedWorkspaceId },
          ))
        ) {
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel kick' } };
        }
      } else {
        // Legacy mode (1-bit invariant): apply → synchronous save → rollback on failure.
        members.splice(idx, 1);
        // If the channel is now empty, stamp `emptySince` (plan KTD8) — same as leave.
        if (members.length === 0 && channel.emptySince === undefined) {
          channel.emptySince = this.now();
        }
        this.state.members[channel.id] = members;
        if (!this.saveOrFail()) {
          // Roll back: re-insert at the original index, clear the emptySince we set.
          members.splice(idx, 0, removed);
          if (members.length === 1) delete channel.emptySince;
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel kick' } };
        }
      }
      // A1: membership changed (kick) — fan out to the remaining members AND the
      // ejected workspace (so the kicked member's mirror drops the channel).
      this.emitCatalog(
        channel.id,
        params.verifiedWorkspaceId,
        [
          ...(this.state.members[channel.id] ?? []).map((m) => m.workspaceId),
          removed.workspaceId,
        ],
        'membership',
      );
      return { ok: true };
    });
  }

  /**
   * R2 — system cleanup that sweeps dead member rows out of every channel when
   * a workspace/pane is deleted. Unlike leave()'s self-pinned removal, the
   * target is a deleted coordinate so self-pin is impossible, and unlike
   * kick() it iterates across all channels rather than one. A direct fix for
   * the "dead workspace member lingers" problem (channel review doc §2 G1).
   *
   * Applies the same per-channel rules as leave(): remove rows → if it was the
   * last member, stamp `emptySince` (makes it a reaper target) → on failure,
   * roll back per channel → on success, emit catalog('membership') to the
   * survivors + the removed workspace. Archived channels are cleaned too — the
   * archive gate blocks "manipulating the roster of the living", not the
   * lingering of dead coordinates.
   */
  async purgeMembership(params: PurgeMembershipParams): Promise<Result<{ removed: number }>> {
    let removedTotal = 0;
    // Iterate over a snapshot of channel ids — each channel's mutex is taken
    // individually (the lock scope is per-channel so there is no global
    // atomicity, but the cleanup is idempotent, so it converges on a re-call
    // after a partial failure).
    const channelIds = this.state.channels.map((c) => c.id);
    for (const channelId of channelIds) {
      const result = await this.withChannelLock(
        channelId,
        async (): Promise<{ ok: true } | { ok: false; error: ChannelError }> => {
        const channel = this.state.channels.find((c) => c.id === channelId);
        if (!channel) return { ok: true }; // vanished mid-iteration (e.g. reaper) — skip
        const members = this.state.members[channel.id] ?? [];
        const matches = (m: ChannelMember): boolean =>
          m.workspaceId === params.workspaceId &&
          (params.principalId !== undefined
            ? m.principalId === params.principalId
            : params.memberId === undefined || m.memberId === params.memberId);
        if (!members.some(matches)) return { ok: true };

        const survivors = members.filter((m) => !matches(m));
        const removed = members.filter(matches);
        if (this.eventLog) {
          // G1 append-then-apply: failure = no apply (no rollback). Applier purge matcher
          // mirrors matches above (principalId first → memberId → whole ws).
          const emptySince =
            survivors.length === 0 && channel.emptySince === undefined ? this.now() : undefined;
          if (
            !(await this.commitAndApply(
              {
                kind: 'purge',
                channelId: channel.id,
                workspaceId: params.workspaceId,
                ...(params.memberId !== undefined ? { memberId: params.memberId } : {}),
                ...(params.principalId !== undefined ? { principalId: params.principalId } : {}),
                ...(emptySince !== undefined ? { emptySince } : {}),
              },
              { verifiedWorkspaceId: params.verifiedWorkspaceId },
            ))
          ) {
            return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist membership purge' } };
          }
        } else {
          // Legacy mode (1-bit invariant): apply → synchronous save → rollback on failure.
          const previousEmptySince = channel.emptySince;
          this.state.members[channel.id] = survivors;
          if (survivors.length === 0 && channel.emptySince === undefined) {
            channel.emptySince = this.now();
          }
          if (!this.saveOrFail()) {
            // Per-channel rollback — same symmetric recovery as leave().
            this.state.members[channel.id] = members;
            channel.emptySince = previousEmptySince;
            return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist membership purge' } };
          }
        }
        removedTotal += removed.length;
        this.emitCatalog(
          channel.id,
          params.verifiedWorkspaceId,
          [...survivors.map((m) => m.workspaceId), params.workspaceId],
          'membership',
        );
        return { ok: true };
        },
      );
      if (!result.ok) return result;
    }
    return { ok: true, removed: removedTotal };
  }

  /**
   * Invite (add) ANOTHER workspace to a channel (P1b). Unlike join() — which
   * self-pins the joiner so a caller can only add ITSELF — invite() adds the
   * caller-supplied `invitedMember` workspace, gated by the INVITER being a
   * current member (decision A: any member may invite). This is the legitimate
   * path into a PRIVATE channel (you cannot self-join one).
   *
   * Gate order mirrors join()/archive():
   *   - `CHANNEL_NOT_FOUND` if the id is unknown OR the inviter cannot SEE a
   *     private channel (symmetric existence-hiding with get/join/getMessages).
   *   - `NOT_AUTHORIZED` if the verified inviter is not a current member.
   *   - `CHANNEL_ARCHIVED` if the channel is read-only.
   *   - `DUPLICATE_MEMBER` if the invitee (workspace, memberId) is already in.
   *   - `PERSIST_FAILED` on a writer failure (rolled back).
   *
   * Authz is "soft governance": same-machine identity is forgeable (#113,
   * accepted ceiling), so this encodes the intended model rather than a hard
   * cross-user boundary. The grant is real, though — it adds a workspace to a
   * private channel's member list, unlocking its history + live fan-out.
   */
  async invite(params: InviteChannelParams): Promise<EmptyResult> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      // Hide private existence from non-members (same as join()/read paths).
      if (!this.isVisibleTo(channel, params.verifiedWorkspaceId)) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      const members = this.state.members[channel.id] ?? [];
      // P1b authz (A): the verified INVITER must be a current member. Checked
      // against the server-resolved workspace, never a client-supplied field.
      if (!members.some((m) => m.workspaceId === params.verifiedWorkspaceId)) {
        return {
          ok: false,
          error: { code: 'NOT_AUTHORIZED', message: 'Only a member may invite others to this channel' },
        };
      }
      if (channel.status === 'archived') {
        return { ok: false, error: { code: 'CHANNEL_ARCHIVED', message: 'Cannot invite to an archived channel' } };
      }
      const invitee = params.invitedMember;
      // P5: the reserved human workspace is never an invite TARGET. The human
      // joins channels themselves via the GUI (self-join as ws-human); an invite
      // into ws-human could only seed a phantom (ws-human, <non-local-ui>) row —
      // the load-time merge folds only memberId 'local-ui', and every renderer
      // membership check is workspaceId-keyed, so such a row force-injects a
      // channel into the human's always-on view (ship review: 5-model consensus).
      // Enforced HERE (not just the main-pipe router) so a direct daemon-pipe
      // caller under the #113 same-user ceiling cannot bypass it either.
      if (invitee.workspaceId === HUMAN_WORKSPACE_ID) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: 'The reserved human workspace cannot be invited; the human joins via the GUI',
          },
        };
      }
      if (members.some((m) => m.workspaceId === invitee.workspaceId && m.memberId === invitee.memberId)) {
        return { ok: false, error: { code: 'DUPLICATE_MEMBER', message: 'Already a member' } };
      }
      const now = this.now();
      const historyFromSeq = params.includeHistory === false ? channel.nextSeq : 0;
      const invitedRow: ChannelMember = {
        // The invitee is the caller-supplied TARGET (NOT verifiedWorkspaceId) —
        // see the method doc + InviteChannelParams. Gated by inviter-is-member.
        workspaceId: invitee.workspaceId,
        memberId: invitee.memberId,
        joinedAt: now,
        historyFromSeq,
        // v2 cursor — seed like join() (Codex review P1): the invitee may SEE
        // history but owes unread only from the invite onward. Without this
        // the row had NO cursor and unreadFor's missing-cursor fallback pinned
        // it to the LIVE head on every query — messages posted after the
        // invite looked pre-consumed, the wake worker never fired for invited
        // members, and the load-time backfill cemented the loss on restart.
        lastReadSeq: channel.nextSeq - 1,
        // R2: principal stable coordinate (additive).
        ...(invitee.principalId ? { principalId: invitee.principalId } : {}),
        // 1b: server-owned display name (principal display, else memberId).
        memberName: this.deriveMemberName(invitee.memberId, invitee.principalId),
      };
      if (this.eventLog) {
        // G1 append-then-apply (same shape as join): failure = no apply (no rollback).
        if (
          !(await this.commitAndApply(
            { kind: 'invite', channelId: channel.id, member: invitedRow },
            { verifiedWorkspaceId: params.verifiedWorkspaceId },
          ))
        ) {
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel invite' } };
        }
      } else {
        // Legacy mode (1-bit invariant): apply → synchronous save → rollback on failure.
        const previousEmptySince = channel.emptySince;
        if (channel.emptySince !== undefined) {
          delete channel.emptySince;
        }
        members.push(invitedRow);
        this.state.members[channel.id] = members;
        if (!this.saveOrFail()) {
          members.pop();
          channel.emptySince = previousEmptySince;
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist channel invite' } };
        }
      }
      // A1: membership changed (invite) — fan out to the post-invite member set
      // (includes the invitee) so the invited workspace's mirror picks up the
      // channel and the existing members' rosters re-sync.
      this.emitCatalog(
        channel.id,
        params.verifiedWorkspaceId,
        (this.state.members[channel.id] ?? []).map((m) => m.workspaceId),
        'membership',
      );
      return { ok: true };
    });
  }

  /**
   * Post a message to a channel. Validates membership, freezes the
   * recipient snapshot at critical-section entry (KTD3 — a concurrent
   * `join` that lands later will not retroactively target this post),
   * allocates the next `seq`, and persists. Idempotency: a repeat
   * post with the same `clientMsgId` returns the original message
   * with `idempotent: true` (no new seq, no second emit). Errors:
   * `CHANNEL_NOT_FOUND`, `CHANNEL_ARCHIVED`, `NOT_A_MEMBER`,
   * `NOT_AUTHORIZED`, `PERSIST_FAILED`. The `channel.message` event
   * fires AFTER a successful persist — the message is durable on disk
   * by the time consumers see it.
   *
   * Sender pinning (R5/R6): the server uses `verifiedWorkspaceId` (the
   * transport-resolved caller identity — MCP `requireWorkspaceId`, the
   * renderer bridge) as the authoritative caller. A client-supplied
   * `sender.workspaceId` that disagrees with `verifiedWorkspaceId` is
   * rejected with `NOT_AUTHORIZED` before any state mutation. This
   * stops a malicious or buggy caller from posting AS a different
   * workspace — the persisted row's `workspaceId` is always the
   * verified one, so downstream fan-out (recipient snapshot, event
   * `senderWorkspaceId`) cannot be spoofed by the client.
   */
  async post(params: PostMessageParams): Promise<Result<{
    message: ChannelMessage;
    idempotent?: boolean;
    /** @mentions whose target workspace is NOT a member of the channel. They
     *  were dropped (you cannot ping a workspace that isn't in the room).
     *  Returned so the SENDER gets explicit feedback instead of a silent drop —
     *  the dominant failure mode found in A2A dogfooding was silent mis-route.
     *  Present only on a fresh (non-idempotent) post with ≥1 dropped mention. */
    droppedMentions?: ChannelDroppedMention[];
    /** 1c — the caller's memberId matched NO roster row of its (verified)
     *  workspace AND the workspace holds MULTIPLE rows, so the daemon could
     *  not map it to a single seat. The post succeeded under the client
     *  memberId verbatim; this echoes it back so the sender learns its
     *  identity is drifting from the roster (a single-row workspace is
     *  silently mapped instead — see the sender-row resolution below). */
    unmatchedMemberId?: string;
  }>> {
    return this.withChannelLock(params.channelId, async () => {
      // Sender-pin gate (R5). Must run BEFORE any state read or
      // mutation — a forged sender must not even consume an idempotency
      // cache lookup, since that would let the attacker probe seq
      // values for channels they cannot post in.
      if (params.sender.workspaceId !== params.verifiedWorkspaceId) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: 'sender.workspaceId does not match the verified caller identity',
          },
        };
      }
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      if (!channel) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${params.channelId}` } };
      }
      if (channel.status === 'archived') {
        return { ok: false, error: { code: 'CHANNEL_ARCHIVED', message: 'Channel is archived' } };
      }
      // Idempotency check — under the per-channel mutex, so concurrent posts
      // on the same channel see consistent state.
      if (params.clientMsgId) {
        const channelIdMap = this.idempotency.get(channel.id) ?? new Map();
        // A11: sender-scoped key so a predictable clientMsgId can't collide
        // across senders (pre-seed suppression / wrong-sender replay).
        const idemKey = idempotencyKey(params.sender.workspaceId, params.clientMsgId);
        const existing = channelIdMap.get(idemKey);
        if (existing) {
          // Refresh LRU timestamp on hit.
          existing.lastUsedAt = this.now();
          // Find the original message by seq.
          const original = (this.state.messages[channel.id] ?? []).find(
            (m) => m.seq === existing.seq,
          );
          if (original) {
            // Replay the original drop feedback too (review P1) — otherwise a
            // retry after a missed first response (the moment feedback matters
            // most) would silently lose the dropped-mention report.
            return {
              ok: true,
              message: original,
              idempotent: true,
              ...(existing.droppedMentions && existing.droppedMentions.length > 0
                ? { droppedMentions: [...existing.droppedMentions] }
                : {}),
              // 1c (Codex #2): replay the identity-drift warning too — a retry
              // after a lost first response must not silently swallow it.
              ...(existing.unmatchedMemberId !== undefined
                ? { unmatchedMemberId: existing.unmatchedMemberId }
                : {}),
            };
          }
          // Cache points at a seq that no longer exists (e.g. message was
          // pruned by empty-channel reaper). Fall through to a fresh post.
        }
      }
      // Membership check — keyed on the SUBSCRIPTION unit (workspaceId), NOT
      // (workspaceId, memberId). `memberId` is a client-supplied label (the MCP
      // `member_id` param — "lead", "backend") that is NOT server-verified and may
      // differ between channel_create and channel_post for the same agent. That
      // create/post memberId mismatch was the NOT_A_MEMBER bug: the creator is
      // auto-added as (ws, createdBy.memberId), then a post as (ws, otherMemberId)
      // failed the composite match even though the SAME verified workspace was
      // posting. The subscription (workspaceId) is the real, server-pinned
      // membership unit (join/create pin it to verifiedWorkspaceId); memberId only
      // narrows display + mention targeting, never authorization. The sender-pin
      // gate above already proved sender.workspaceId === verifiedWorkspaceId, so a
      // workspace match here means a verified member is posting — gating on the
      // forgeable memberId on top of that added no security, only the bug.
      const members = this.state.members[channel.id] ?? [];
      // Membership gate + 1c resolution share one pass over the (tiny,
      // capped) member list: the sender's workspace rows ARE the membership
      // evidence (GLM review — no separate some() sweep).
      const senderWsRows = members.filter((m) => m.workspaceId === params.sender.workspaceId);
      if (senderWsRows.length === 0) {
        return { ok: false, error: { code: 'NOT_A_MEMBER', message: 'Not a channel member' } };
      }
      // 1c — resolve the sender's ROSTER ROW before building the message, so
      // the persisted identity (memberId/memberName) is server-owned and the
      // self-cursor-ride below operates on the row that actually exists.
      // Ghost memberIds were the bug class here: an MCP/CLI caller posting as
      // (ws, 'agent') while the roster row is (ws, 'w26-1(claude)') matched no
      // row, so the ride never fired and the wake worker re-nudged the sender
      // about its OWN message. Resolution ladder:
      //   1. exact (workspaceId, memberId) row → use it verbatim;
      //   2. workspace holds exactly ONE row → map the post onto that seat
      //      (memberId + name follow the roster; the CLI does the same
      //      single-row resolution client-side already);
      //   3. multiple rows, none matching → keep the client memberId (cannot
      //      guess between seats) and echo `unmatchedMemberId` so the sender
      //      gets explicit feedback instead of a silent identity fork.
      let senderRow = senderWsRows.find((m) => m.memberId === params.sender.memberId);
      let unmatchedMemberId: string | undefined;
      if (!senderRow) {
        if (senderWsRows.length === 1) {
          senderRow = senderWsRows[0];
        } else {
          unmatchedMemberId = params.sender.memberId;
        }
      }
      const resolvedMemberId = senderRow ? senderRow.memberId : params.sender.memberId;
      // Body clamp (U6). Measure the post-canonicalized form (C0 strip +
      // trim) so padding whitespace and zero-width characters cannot
      // bypass the cap. Reject BEFORE allocating a seq so an oversize
      // post does not consume an idempotency slot.
      const sanitizedText = sanitizePostText(params.text);
      if (sanitizedText.length > CHANNEL_BODY_MAX) {
        return {
          ok: false,
          error: {
            code: 'CHANNEL_BODY_TOO_LARGE',
            message: `Post body exceeds ${CHANNEL_BODY_MAX} characters`,
          },
        };
      }
      // Data payload cap (U6). Measured as JSON-serialized length so a
      // moderate JSON blob (~4 KiB) fits while a giant payload is
      // caught without a deep object walk.
      if (params.data !== undefined) {
        let dataSize: number;
        try {
          dataSize = JSON.stringify(params.data).length;
        } catch {
          // Circular / non-serializable payload — surface as too-large
          // so the caller retries with a serializable shape. We do not
          // throw because the post envelope contract is `{ ok, error }`.
          return {
            ok: false,
            error: {
              code: 'CHANNEL_DATA_TOO_LARGE',
              message: 'Post `data` payload is not JSON-serializable',
            },
          };
        }
        if (dataSize > CHANNEL_DATA_MAX) {
          return {
            ok: false,
            error: {
              code: 'CHANNEL_DATA_TOO_LARGE',
              message: `Post \`data\` payload exceeds ${CHANNEL_DATA_MAX} bytes (JSON-serialized)`,
            },
          };
        }
      }
      // Mention count cap (review P2). Reject BEFORE allocating a seq so an
      // abusive post consumes no idempotency slot. Bounds both the
      // O(mentions x members) validation below (run under the channel lock) and
      // the droppedMentions array echoed back in the response.
      if ((params.mentions?.length ?? 0) > CHANNEL_MENTIONS_MAX) {
        return {
          ok: false,
          error: {
            code: 'CHANNEL_MENTIONS_TOO_MANY',
            message: `Post exceeds ${CHANNEL_MENTIONS_MAX} mentions`,
          },
        };
      }
      // 1b refresh (Codex #4): the roster name follows the principal
      // registry — an agent swap on the same pane updates the principal
      // display, so re-derive on post (which persists anyway). Refresh ONLY
      // on a POSITIVE registry hit: a transient registry miss must not
      // downgrade a good name to the memberId fallback.
      //
      // PLACEMENT IS LOAD-BEARING (delta review, Codex P1 + Claude ②,
      // reproduced): this mutation must sit AFTER every early-return
      // validation above (body clamp, data clamp, mention cap) so a
      // REJECTED post can never leave the in-memory row ahead of disk.
      // The only exits after this point are the persist-failure branch —
      // which rolls the name back — and success, which persists it.
      //
      // G1(append-then-apply): **decide only** here (refreshedName calculation).
      // Actual row mutation is per commit path — log mode applies after append success,
      // legacy mode unchanged below (snapshot+rollback).
      let refreshedName: string | undefined;
      if (senderRow?.principalId && this.resolvePrincipalDisplay) {
        try {
          const freshDisplay = this.resolvePrincipalDisplay(senderRow.principalId);
          if (
            typeof freshDisplay === 'string' &&
            freshDisplay.length > 0 &&
            freshDisplay !== senderRow.memberName
          ) {
            refreshedName = freshDisplay;
          }
        } catch (err) {
          console.error('[ChannelService] principal display refresh failed:', err);
        }
      }
      // 1b — the message's display-name snapshot comes from the roster row
      // (server-derived at create/join/invite, refreshed above), never the
      // caller's free text when a row is known. Legacy rows without
      // memberName fall back to the row's memberId; the unmatched path falls
      // back to whatever the client sent (then its memberId) so old callers
      // keep a sane display.
      const resolvedMemberName = senderRow
        ? (refreshedName ?? senderRow.memberName ?? senderRow.memberId)
        : (params.sender.memberName ?? params.sender.memberId);
      // Freeze the recipient snapshot at critical-section entry (plan KTD3).
      // We deliberately do NOT re-read members after this point; a concurrent
      // `join` that lands later will not retroactively change the snapshot
      // of this in-flight post.
      const snapshot: ChannelRecipientStatus[] = members.map((m) => ({
        memberId: m.memberId,
        workspaceId: m.workspaceId,
        status: 'pending' as const,
      }));
      // Validate @mentions against the FROZEN member set (the same snapshot the
      // recipients use): keep only mentions of CURRENT member workspaces, deduped
      // by (workspaceId, paneId). A mention of a non-member workspace is dropped —
      // you cannot ping a workspace that isn't in the room. Keying dedup on
      // (workspaceId, paneId) lets TWO agents in the SAME workspace (split panes)
      // both be mentioned in one post without the second collapsing into the
      // first; a ws-level mention (no paneId) still dedupes per workspace exactly
      // as before. `paneId`/`ptyId` are OPAQUE pass-through here: the daemon owns
      // the workspace (subscription) membership gate, but it does not know the
      // live pane tree — the RECEIVING renderer resolves paneId in its own leaves
      // and re-checks ptyId liveness (fail-closed) before pinning the a2a task.
      const mentionedKeys = new Set<string>();
      const mentions: ChannelMention[] = [];
      const droppedMentions: ChannelDroppedMention[] = [];
      const droppedWorkspaces = new Set<string>();
      // Build the member-workspace lookup ONCE so membership is O(1) per mention
      // (O(n + m) overall) instead of O(mentions x members) under the lock.
      const memberWorkspaces = new Set(members.map((m) => m.workspaceId));
      for (const mn of params.mentions ?? []) {
        if (!mn || typeof mn.workspaceId !== 'string') continue;
        if (!memberWorkspaces.has(mn.workspaceId)) {
          // Was a SILENT drop. Record it (deduped per workspace) so the post
          // result tells the SENDER the mention didn't land — you cannot ping a
          // workspace that isn't in the room. Silent mis-route was the dominant
          // failure mode in A2A dogfooding.
          if (!droppedWorkspaces.has(mn.workspaceId)) {
            droppedWorkspaces.add(mn.workspaceId);
            droppedMentions.push({
              workspaceId: mn.workspaceId,
              reason: 'not_a_member',
              ...(typeof mn.name === 'string' && mn.name.length > 0
                ? { name: mn.name.slice(0, 80) }
                : {}),
            });
          }
          continue;
        }
        const paneId = typeof mn.paneId === 'string' ? mn.paneId : '';
        // Collision-free dedup key: JSON-encode the (workspaceId, paneId) pair so
        // no separator-substring ambiguity can fold two distinct targets onto one
        // key and silently drop the later mention (review-team: codex+GLM).
        // KNOWN LIMITATION (pre-existing, delta review Codex #2): the key
        // ignores memberId, so two member-scoped mentions of the SAME
        // (workspace, no-pane) target dedup to the first even when they name
        // different seats. Revisit with the mention-semantics work (P6).
        const key = JSON.stringify([mn.workspaceId, paneId]);
        if (mentionedKeys.has(key)) continue;
        mentionedKeys.add(key);
        // 1c, recipient side (Codex #3): a mention memberId that matches no
        // roster row of its target workspace would be persisted verbatim —
        // and then unreadFor's member-scoped mention counting and the wake
        // ledger both ignore it (the mention "lands" but never behaves like
        // one). Same ladder as the sender: exact row wins, a single-row
        // workspace maps, multi-row stays verbatim (never guess a seat).
        let mnMemberId = typeof mn.memberId === 'string' ? mn.memberId : undefined;
        if (mnMemberId !== undefined) {
          const targetRows = members.filter((m) => m.workspaceId === mn.workspaceId);
          const exact = targetRows.some((m) => m.memberId === mnMemberId);
          if (!exact && targetRows.length === 1) {
            mnMemberId = targetRows[0].memberId;
          }
        }
        mentions.push({
          workspaceId: mn.workspaceId,
          name: typeof mn.name === 'string' && mn.name.length > 0 ? mn.name.slice(0, 80) : mn.workspaceId,
          ...(mnMemberId !== undefined ? { memberId: mnMemberId } : {}),
          ...(typeof mn.paneId === 'string' && mn.paneId.length > 0 ? { paneId: mn.paneId } : {}),
          ...(typeof mn.ptyId === 'string' && mn.ptyId.length > 0 ? { ptyId: mn.ptyId } : {}),
        });
      }
      // G1: seq is **pre-decided** (no increment). Log mode applier advances nextSeq
      // to seq+1 after append success; legacy mode ++ below — issuance rule (next value
      // = current nextSeq) is identical on both paths.
      const seq = channel.nextSeq;
      const now = this.now();
      const message: ChannelMessage = {
        channelId: channel.id,
        seq,
        workspaceId: params.sender.workspaceId,
        // 1b/1c — server-resolved identity (roster row), not caller verbatim.
        memberId: resolvedMemberId,
        memberName: resolvedMemberName,
        text: sanitizedText,
        postedAt: now,
        deliveryStatus: 'pending',
        recipientSnapshot: snapshot,
        ...(params.clientMsgId !== undefined ? { clientMsgId: params.clientMsgId } : {}),
        ...(params.data !== undefined ? { data: params.data } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(typeof params.senderPtyId === 'string' && params.senderPtyId.length > 0
          ? { senderPtyId: params.senderPtyId }
          : {}),
      };
      // Channels v2 (Codex review): a poster has, by definition, seen the
      // channel up to its own message. When the sender's row was fully
      // caught up before this post, ride the cursor over the new seq —
      // roster badges stay honest ("behind" never counts your own reply)
      // and `read --since` doesn't replay your own words. A sender with
      // OLDER unread keeps its cursor: the backlog is still owed
      // (unreadFor additionally exempts self-authored messages, so even
      // that sender is never re-nudged about itself).
      // 1c: `senderRow` is the RESOLVED row from above — a ghost memberId in
      // a single-row workspace now rides that row's cursor instead of
      // matching nothing and re-nudging itself.
      const senderRowRode = senderRow !== undefined && senderRow.lastReadSeq === seq - 1;
      if (this.eventLog) {
        // ── G1 append-then-apply (log mode): apply only **after** fsync barrier success ──
        // Projection is unmodified during the append await window, so synchronous reads
        // without the mutex cannot see uncommitted optimistic state — dirty read is
        // structurally impossible. Failure = no apply — no rollback block (legacy branch only).
        const applied = await this.commitAndApply(
          {
            kind: 'post',
            channelId: channel.id,
            message,
            // Cursor ride and name refresh are effects in this commit — for replay (§5).
            ...(senderRow && senderRowRode
              ? { cursorRide: { workspaceId: senderRow.workspaceId, memberId: senderRow.memberId } }
              : {}),
            ...(senderRow && refreshedName !== undefined
              ? {
                  nameRefresh: {
                    workspaceId: senderRow.workspaceId,
                    memberId: senderRow.memberId,
                    memberName: refreshedName,
                  },
                }
              : {}),
          },
          {
            verifiedWorkspaceId: params.verifiedWorkspaceId,
            principalId: senderRow?.principalId ?? resolvedMemberId,
          },
        );
        if (!applied) {
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist post' } };
        }
        // In-memory LRU (includes droppedMentions·unmatchedMemberId replay metadata) —
        // state.idempotency already updated by applier (FIFO cap). Minor ordering diff
        // vs live LRU eviction is within §4 cap semantics (same shape as boot hydration FIFO).
        if (params.clientMsgId) {
          const channelIdMap = this.idempotency.get(channel.id) ?? new Map();
          const idemKey = idempotencyKey(params.sender.workspaceId, params.clientMsgId);
          channelIdMap.set(idemKey, {
            seq,
            lastUsedAt: now,
            ...(droppedMentions.length > 0 ? { droppedMentions: [...droppedMentions] } : {}),
            ...(unmatchedMemberId !== undefined ? { unmatchedMemberId } : {}),
          });
          if (channelIdMap.size > CHANNEL_IDEMPOTENCY_CAP) {
            this.evictOldest(channelIdMap, channelIdMap.size - CHANNEL_IDEMPOTENCY_CAP);
          }
          this.idempotency.set(channel.id, channelIdMap);
        }
        // Align applier cap trim with in-memory LRU: prune entries pointing at trimmed seqs (A2).
        const msgsAfterApply = this.state.messages[channel.id] ?? [];
        if (msgsAfterApply.length > 0) {
          const minSeq = msgsAfterApply[0].seq;
          const idemMap = this.idempotency.get(channel.id);
          if (idemMap) {
            for (const [k, v] of idemMap) {
              if (v.seq < minSeq) idemMap.delete(k);
            }
          }
        }
      } else {
        // ── Legacy mode (1-bit invariant): apply → synchronous save → rollback on failure ──
        let senderRowPrevName: string | undefined;
        let senderRowNameRefreshed = false;
        if (senderRow && refreshedName !== undefined) {
          senderRowPrevName = senderRow.memberName;
          senderRow.memberName = refreshedName;
          senderRowNameRefreshed = true;
        }
        channel.nextSeq++;
        (this.state.messages[channel.id] ??= []).push(message);
        if (senderRow && senderRowRode) senderRow.lastReadSeq = seq;
        // Update idempotency cache.
        if (params.clientMsgId) {
          const channelIdMap = this.idempotency.get(channel.id) ?? new Map();
          const idemKey = idempotencyKey(params.sender.workspaceId, params.clientMsgId);
          channelIdMap.set(idemKey, {
            seq,
            lastUsedAt: now,
            // Store a COPY so a same-process caller mutating the returned array
            // can't poison the cached replay value.
            ...(droppedMentions.length > 0 ? { droppedMentions: [...droppedMentions] } : {}),
            ...(unmatchedMemberId !== undefined ? { unmatchedMemberId } : {}),
          });
          // LRU eviction down to CHANNEL_IDEMPOTENCY_CAP.
          if (channelIdMap.size > CHANNEL_IDEMPOTENCY_CAP) {
            this.evictOldest(channelIdMap, channelIdMap.size - CHANNEL_IDEMPOTENCY_CAP);
          }
          this.idempotency.set(channel.id, channelIdMap);
          // Also persist the seq map so a daemon restart preserves idempotency.
          this.state.idempotency[channel.id] = Object.fromEntries(
            Array.from(channelIdMap.entries()).map(([k, v]) => [k, v.seq]),
          );
        }
        if (!this.saveOrFail()) {
          // Roll back: un-bump nextSeq, pop the message, drop idempotency entry,
          // and un-ride the sender cursor.
          channel.nextSeq--;
          const msgs = this.state.messages[channel.id];
          if (msgs) msgs.pop();
          if (senderRow && senderRowRode) senderRow.lastReadSeq = seq - 1;
          // 1b refresh rollback: the in-memory row must match disk again.
          if (senderRow && senderRowNameRefreshed) {
            if (senderRowPrevName === undefined) delete senderRow.memberName;
            else senderRow.memberName = senderRowPrevName;
          }
          if (params.clientMsgId) {
            const channelIdMap = this.idempotency.get(channel.id);
            if (channelIdMap) {
              channelIdMap.delete(idempotencyKey(params.sender.workspaceId, params.clientMsgId));
              // Rebuild the persisted snapshot from the reverted map — `state.idempotency`
              // was already overwritten with the new key above, so without this the
              // NEXT successful save would flush an orphaned composite key for a
              // message that never existed (CodeRabbit).
              this.state.idempotency[channel.id] = Object.fromEntries(
                Array.from(channelIdMap.entries()).map(([k, v]) => [k, v.seq]),
              );
            }
          }
          return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist post' } };
        }
      }
      // The cursor ride above advanced a PERSISTED member cursor — badge
      // honesty needs the same catalog signal an explicit ack emits (Codex
      // round-4): the channel.message event raises the head in open rosters
      // while the cached member row's lastReadSeq stays stale, so a
      // caught-up poster would show "1 behind" its own message until an
      // unrelated catalog event lands. Emitted BEFORE channel.message so
      // that event stays the LAST emit of a post (consumers are order-
      // agnostic; tests pin the message event's tail position).
      if (senderRowRode) {
        this.emitCatalog(
          channel.id,
          params.sender.workspaceId,
          members.map((m) => m.workspaceId),
          'cursor',
        );
      }
      // Emit AFTER successful persist — the post is durable on disk by the
      // time consumers see it. A failed emit does not block the post
      // (the plan's contract is: persist-first, then notify).
      try {
        this.emit({
          type: 'channel.message',
          channelId: channel.id,
          seq,
          sender: {
            workspaceId: params.sender.workspaceId,
            // 1b/1c — the event mirrors the PERSISTED message identity (the
            // server-resolved roster row), not the caller verbatim.
            memberId: resolvedMemberId,
            memberName: resolvedMemberName,
          },
          recipients: snapshot,
          message,
          workspaceId: params.sender.workspaceId,
        });
      } catch (err) {
        // Best-effort: a throwing emit must not roll back a successful
        // post. The next tryDeliver cycle (U3.5 wiring) re-fans-out from
        // the persisted recipientSnapshot.
        console.error('[ChannelService] emit failed:', err);
      }
      // A2: tail-evict the per-channel history above CHANNEL_MESSAGES_MAX. Done
      // AFTER the successful persist above (pre-persist would lose evicted rows on
      // a rollback), then flushed immediately (below) so a restart before the next
      // post can't rehydrate the oversized history above the cap (CodeRabbit).
      // Bounds the unbounded-growth DoS the audit found: saveImmediate
      // re-serializes the WHOLE state per post, so an uncapped history makes every
      // post O(total history). The idempotency map's pointer to an evicted seq is
      // already handled — the post path falls through to a fresh post (see above).
      //
      // G1: legacy only — log-mode trim is deterministic part of post applier
      // (channelEvents.ts, same cap rules as replay) and in-memory LRU prune already
      // ran in the commit branch above.
      if (!this.eventLog) {
        const msgs2 = this.state.messages[channel.id];
        if (msgs2 && msgs2.length > CHANNEL_MESSAGES_MAX) {
          const trimmed = msgs2.slice(msgs2.length - CHANNEL_MESSAGES_MAX);
          this.state.messages[channel.id] = trimmed;
          // A2 (GLM P3): drop idempotency entries pointing at now-evicted seqs so
          // dead pointers don't occupy LRU slots forever (the post path already
          // falls through to a fresh post when an entry's seq is gone). Keep the
          // in-memory map and the persisted shape in sync.
          const minSeq = trimmed.length > 0 ? trimmed[0].seq : 0;
          const idemMap = this.idempotency.get(channel.id);
          if (idemMap) {
            let pruned = false;
            for (const [k, v] of idemMap) {
              if (v.seq < minSeq) {
                idemMap.delete(k);
                pruned = true;
              }
            }
            if (pruned) {
              this.state.idempotency[channel.id] = Object.fromEntries(
                Array.from(idemMap.entries()).map(([k, v]) => [k, v.seq]),
              );
            }
          }
          // Persist the trim now so the durable cap stays bounded even if the daemon
          // restarts before the next post. Best-effort: on failure the in-memory copy
          // is still trimmed and the next post's saveOrFail re-flushes (CodeRabbit).
          void this.saveOrFail();
        }
      }
      return {
        ok: true,
        message,
        ...(droppedMentions.length > 0 ? { droppedMentions } : {}),
        // 1c — explicit feedback when the caller's memberId matched no roster
        // row in a multi-row workspace (see the sender-row resolution above).
        ...(unmatchedMemberId !== undefined ? { unmatchedMemberId } : {}),
      };
    });
  }

  /**
   * Receipt acknowledgement (A1 — make deliveryStatus real). A member confirms
   * it has RECEIVED messages up to `uptoSeq` (the renderer calls this when it
   * loads a channel; read === received). For each such message, the caller's
   * entry in the frozen `recipientSnapshot` flips `pending → delivered`, and the
   * message's own `deliveryStatus` flips to `delivered` once ANY recipient has
   * (matching `DeliveryResult.ok` = "at least one delivered"). Before this,
   * `deliveryStatus` was vestigially stuck at `pending` (the ChannelDelivery
   * transport seam was never wired) so success/failure was indistinguishable.
   * Persists only when something actually changed (a repeat ack is a no-op).
   */
  async ack(params: {
    channelId: string;
    verifiedWorkspaceId: string;
    uptoSeq: number;
    /**
     * Channels v2: narrow the cursor advance to ONE member row (agent
     * CLI/MCP path). Absent = READ RECEIPT ONLY — recipientSnapshot flips
     * for the workspace (legacy delivery bookkeeping, the renderer's
     * open-channel ack) but NO cursor moves: a human glancing at a channel
     * must never mark an agent's inbox consumed (Codex re-review P1).
     */
    memberId?: string;
  }): Promise<Result<{ acked: number; lastReadSeq?: number }>> {
    return this.withChannelLock(params.channelId, async () => {
      const channel = this.state.channels.find((c) => c.id === params.channelId);
      // Symmetric existence-hiding with get/getMessages: a non-member of a
      // private channel sees CHANNEL_NOT_FOUND, never its existence.
      if (!channel || !this.isVisibleTo(channel, params.verifiedWorkspaceId)) {
        return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: 'No such channel' } };
      }
      const msgs = this.state.messages[params.channelId] ?? [];
      // Collect-then-apply so a persist failure can ROLL BACK (mirrors post): we
      // snapshot each flip's prior values, apply, persist, and on failure restore
      // — otherwise memory would be left flipped while we return PERSIST_FAILED,
      // and a retry would be a no-op (entry already delivered) = permanent split
      // (GLM review P1).
      const flips: Array<{
        entry: ChannelRecipientStatus;
        prevEntryStatus: ChannelRecipientStatus['status'];
        prevLastAttemptAt: number | undefined;
        msg: ChannelMessage;
        prevMsgStatus: ChannelMessage['deliveryStatus'];
      }> = [];
      for (const m of msgs) {
        if (m.seq > params.uptoSeq) continue;
        // A workspace may have MULTIPLE member rows in one channel (several
        // agents from the same workspace each join with a distinct memberId), so
        // the frozen recipientSnapshot can carry more than one entry for this
        // workspaceId. The ack is workspace-scoped (the renderer never identifies
        // a memberId), so flip EVERY pending row for this workspace — a `find()`
        // would leave the siblings permanently 'pending', and a repeat ack would
        // keep re-finding the first, already-delivered row (Codex review).
        for (const entry of m.recipientSnapshot ?? []) {
          if (entry.workspaceId === params.verifiedWorkspaceId && entry.status === 'pending') {
            flips.push({
              entry,
              prevEntryStatus: entry.status,
              prevLastAttemptAt: entry.lastAttemptAt,
              msg: m,
              prevMsgStatus: m.deliveryStatus,
            });
          }
        }
      }
      // Channels v2 — advance the durable per-member read cursor alongside the
      // legacy recipientSnapshot flips. Advance-only, clamped to the channel
      // head: an ack can never mark the future read nor move backwards.
      //
      // Cursor advance is MEMBER-SCOPED ONLY (Codex re-review P1): the
      // renderer's open-channel ack carries no memberId — it is a human READ
      // RECEIPT (deliveryStatus), never an agent's consumption claim.
      // Advancing every workspace row on it let a human's glance clear an
      // agent's cursor: unread hit zero, the wake worker went silent, and the
      // agent's work was silently dropped. No memberId ⇒ receipts only.
      const cursorTarget = Math.min(params.uptoSeq, channel.nextSeq - 1);
      const cursorFlips: Array<{ row: ChannelMember; prev: number | undefined }> = [];
      if (params.memberId !== undefined) {
        const wsRows = (this.state.members[params.channelId] ?? []).filter(
          (m) => m.workspaceId === params.verifiedWorkspaceId,
        );
        // A narrowed ack that matches NO row is a caller bug (stale
        // $WMUX_MEMBER_ID, typo) — fail loudly instead of returning a
        // success that consumed nothing while the wake worker keeps
        // re-nudging (Codex re-review).
        if (!wsRows.some((m) => m.memberId === params.memberId)) {
          return {
            ok: false,
            error: {
              code: 'NOT_A_MEMBER',
              message: `No member row "${params.memberId}" for this workspace in the channel`,
            },
          };
        }
        for (const row of wsRows) {
          if (row.memberId !== params.memberId) continue;
          const current = typeof row.lastReadSeq === 'number' ? row.lastReadSeq : -1;
          if (cursorTarget > current) {
            cursorFlips.push({ row, prev: row.lastReadSeq });
          }
        }
      }
      const now = this.now();
      if (flips.length > 0 || cursorFlips.length > 0) {
        if (this.eventLog) {
          // G1 append-then-apply: collect finished read-only above; applier applies after
          // barrier success — applier re-collect (pending-only flips·advance-only cursor)
          // is deterministically identical to collect above under mutex. Failure = no apply
          // (no rollback).
          if (
            !(await this.commitAndApply(
              {
                kind: 'ack',
                channelId: params.channelId,
                workspaceId: params.verifiedWorkspaceId,
                ...(params.memberId !== undefined ? { memberId: params.memberId } : {}),
                uptoSeq: params.uptoSeq,
                ackedAt: now,
              },
              {
                verifiedWorkspaceId: params.verifiedWorkspaceId,
                ...(params.memberId !== undefined ? { principalId: params.memberId } : {}),
              },
            ))
          ) {
            return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist ack' } };
          }
        } else {
          // Legacy mode (1-bit invariant): apply → synchronous save → rollback on failure.
          for (const f of flips) {
            f.entry.status = 'delivered';
            f.entry.lastAttemptAt = now;
            // ≥1 recipient delivered ⇒ message delivered (DeliveryResult.ok semantics
            // — "at least one", NOT "all": a still-pending peer does not block it, and
            // per-recipient detail remains in recipientSnapshot for callers who need it).
            if (f.msg.deliveryStatus !== 'delivered') f.msg.deliveryStatus = 'delivered';
          }
          for (const f of cursorFlips) {
            f.row.lastReadSeq = cursorTarget;
          }
          if (!this.saveOrFail()) {
            // Roll back the in-memory flips so memory ↔ disk stay consistent.
            for (const f of flips) {
              f.entry.status = f.prevEntryStatus;
              f.entry.lastAttemptAt = f.prevLastAttemptAt;
              f.msg.deliveryStatus = f.prevMsgStatus;
            }
            for (const f of cursorFlips) {
              f.row.lastReadSeq = f.prev;
            }
            return { ok: false, error: { code: 'PERSIST_FAILED', message: 'Failed to persist ack' } };
          }
        }
      }
      // A cursor advance changes the roster's "N behind" badges, which
      // hydrate from the catalog — without a signal an agent's ack leaves
      // every open roster stale until some unrelated membership event lands
      // (Codex re-review). Reason 'cursor' is advisory; receivers re-hydrate
      // regardless. Receipt-only acks (no cursor movement) stay silent — the
      // renderer fires one on every channel open.
      if (cursorFlips.length > 0) {
        this.emitCatalog(
          params.channelId,
          params.verifiedWorkspaceId,
          (this.state.members[params.channelId] ?? []).map((m) => m.workspaceId),
          'cursor',
        );
      }
      // Echo the row's ACTUAL post-ack cursor, not the clamped request
      // target: a stale/backward ack (row already past uptoSeq) performs no
      // flip and must not report a rewind it never did — cursors are
      // advance-only and clients trust this echo (Codex round-3). Only
      // meaningful for a member-scoped ack (receipt-only moves no cursor).
      let echoedCursor: number | undefined;
      if (params.memberId !== undefined) {
        const row = (this.state.members[params.channelId] ?? []).find(
          (m) => m.workspaceId === params.verifiedWorkspaceId && m.memberId === params.memberId,
        );
        echoedCursor = row && typeof row.lastReadSeq === 'number' ? row.lastReadSeq : cursorTarget;
      }
      return {
        ok: true,
        acked: flips.length,
        ...(echoedCursor !== undefined ? { lastReadSeq: echoedCursor } : {}),
      };
    });
  }

  /**
   * Channels v2 — per-member unread summary for the verified caller.
   * `unread` counts retained messages this member may see (seq ≥
   * historyFromSeq) beyond its cursor; `mentionUnread` narrows that to
   * messages that @-mention the caller (workspace-level mention, or a
   * memberId-targeted mention matching this row). `trimmedBeforeCursor`
   * reports messages that retention removed BEFORE the member consumed
   * them — silent loss is the one thing this subsystem must never do, so
   * the gap is surfaced, not swallowed (design doc, spec-review issue 5).
   * Today nothing trims the log, so it is 0; the field exists so the cap
   * work lights it up instead of adding a new wire shape.
   */
  /**
   * Distinct workspaces that hold ≥1 member row in any non-archived channel.
   * The wake worker sweeps these — it must not invent recipients, only serve
   * the membership the daemon already persists.
   */
  memberWorkspaces(): string[] {
    const out = new Set<string>();
    for (const channel of this.state.channels) {
      if (channel.status === 'archived') continue;
      for (const m of this.state.members[channel.id] ?? []) {
        // P5: never sweep the virtual human workspace. It owns no PTY session,
        // so pickTarget always misses — but including it made the wake worker
        // walk every channel's every message each 15s tick for an unread cursor
        // that can never be nudged or exhausted (ship review: Claude adversarial
        // F5 CPU drift + data-migration). The human is reached by the GUI badge.
        if (m.workspaceId === HUMAN_WORKSPACE_ID) continue;
        out.add(m.workspaceId);
      }
    }
    return Array.from(out);
  }

  /**
   * Daemon-INTERNAL enumeration of every channel's `(id, topic, status,
   * createdByWorkspaceId)`, membership-unscoped (J0 §3 mission reconcile).
   * Unlike `list()` — which is caller-scoped by membership/visibility —
   * reconcile must see channels the caller is NOT a member of (an orphan
   * mission channel whose only member is a now-gone creator, or a closed-task
   * channel to re-archive). `createdByWorkspaceId` gives the reconcile path an
   * archive identity that passes the member gate (the creator is always seeded
   * as a member) — without it every orphan archive fails NOT_AUTHORIZED and
   * the orphan survives forever (3-model review R1'). Returns a shallow copy
   * so callers cannot mutate service state. NOT a wire surface: only the
   * daemon-internal WorkTaskService reconcile path calls it.
   */
  listAllForReconcile(): Array<{
    id: string;
    topic?: string;
    status: ChannelStatus;
    createdByWorkspaceId?: string;
  }> {
    return this.state.channels.map((c) => ({
      id: c.id,
      ...(c.topic !== undefined ? { topic: c.topic } : {}),
      status: c.status,
      // Persisted `createdBy` is the creator's workspaceId string (server-pinned
      // at create — see the D5 note on CreateChannelParams).
      ...(typeof c.createdBy === 'string' && c.createdBy.length > 0
        ? { createdByWorkspaceId: c.createdBy }
        : {}),
    }));
  }

  unreadFor(
    verifiedWorkspaceId: string,
    memberId?: string,
  ): Array<{
    channelId: string;
    name: string;
    memberId: string;
    principalId?: string;
    lastReadSeq: number;
    headSeq: number;
    unread: number;
    mentionUnread: number;
    trimmedBeforeCursor: number;
  }> {
    const out: Array<{
      channelId: string;
      name: string;
      memberId: string;
      principalId?: string;
      lastReadSeq: number;
      headSeq: number;
      unread: number;
      mentionUnread: number;
      trimmedBeforeCursor: number;
    }> = [];
    for (const channel of this.state.channels) {
      if (channel.status === 'archived') continue;
      const rows = (this.state.members[channel.id] ?? []).filter(
        (m) => m.workspaceId === verifiedWorkspaceId && (memberId === undefined || m.memberId === memberId),
      );
      if (rows.length === 0) continue;
      const msgs = this.state.messages[channel.id] ?? [];
      const headSeq = channel.nextSeq - 1;
      for (const row of rows) {
        const cursor = typeof row.lastReadSeq === 'number' ? row.lastReadSeq : headSeq;
        const visibleFloor = row.historyFromSeq;
        let unread = 0;
        let mentionUnread = 0;
        for (const m of msgs) {
          if (m.seq <= cursor || m.seq < visibleFloor) continue;
          // Self-authored messages are never owed (Codex review): a reply
          // must not turn into the replier's own unread — the wake worker
          // would nudge the pane about the message it just sent. Keyed on
          // the full row identity (workspaceId AND memberId) so a same-ws
          // SIBLING agent still owes it (same-ws A2A stays a conversation).
          if (m.workspaceId === row.workspaceId && m.memberId === row.memberId) continue;
          // System rows (systemKind) are audit markers, not deliverable work:
          // this exemption is what actually keeps the wake worker away from
          // them — without it every agent member owes one plain unread for an
          // "Operator joined" marker and gets a PTY nudge (three-model review
          // consensus). deliveryStatus/recipientSnapshot play no role here.
          if (m.systemKind) continue;
          unread += 1;
          const mentioned = (m.mentions ?? []).some(
            (men) =>
              men.workspaceId === verifiedWorkspaceId &&
              (men.memberId === undefined || men.memberId === row.memberId),
          );
          if (mentioned) mentionUnread += 1;
        }
        // Retained-log gap: messages between the cursor and the first retained
        // seq were trimmed before this member read them.
        const firstRetainedSeq = msgs.length > 0 ? msgs[0].seq : headSeq + 1;
        const firstUnconsumed = Math.max(cursor + 1, visibleFloor);
        const trimmedBeforeCursor = Math.max(0, firstRetainedSeq - firstUnconsumed);
        out.push({
          channelId: channel.id,
          name: channel.name,
          memberId: row.memberId,
          // R2: the wake worker's direct principal-targeting key (only when present on the row).
          ...(row.principalId ? { principalId: row.principalId } : {}),
          lastReadSeq: cursor,
          headSeq,
          unread,
          mentionUnread,
          trimmedBeforeCursor,
        });
      }
    }
    return out;
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Per-channel promise chain. Each call appends a new tail to the chain
   * for `channelId`; the caller awaits the previous tail, runs its body,
   * then releases its own slot. The map entry is deleted if our tail is
   * still the current head of the chain (i.e. no later caller overwrote
   * it), so an idle channel doesn't leak a resolved-promise entry forever.
   *
   * Channels don't contend — different keys run in parallel. Two posts on
   * the SAME channel are serialized; two posts on DIFFERENT channels race.
   */
  private async withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(channelId) ?? Promise.resolve();
    let release!: () => void;
    const ourTail = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const newTail = prev.then(() => ourTail);
    this.mutexes.set(channelId, newTail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // Only delete if our entry is still the current tail. A later caller
      // (in a later tick) will have replaced it; they'll clean up their own.
      if (this.mutexes.get(channelId) === newTail) {
        this.mutexes.delete(channelId);
      }
    }
  }

  /** Evict the `count` oldest entries from a clientMsgId→entry map. */
  private evictOldest(map: Map<string, IdempotencyEntry>, count: number): void {
    const entries = Array.from(map.entries()).sort(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
    );
    for (let i = 0; i < count && i < entries.length; i++) {
      map.delete(entries[i][0]);
    }
  }

  /**
   * Emit a channel.catalog lifecycle signal (A1) after a successful catalog or
   * membership mutation. Best-effort — a throwing emit must not roll back the
   * mutation (mirrors post()'s emit contract). The recipient set is deduped.
   */
  private emitCatalog(
    channelId: string,
    actorWorkspaceId: string,
    recipientWorkspaceIds: string[],
    reason: ChannelCatalogEvent['reason'],
  ): void {
    try {
      const recipients = [...recipientWorkspaceIds];
      // W1 (operator observation) — root fix for the catalog fan-out gap. A
      // private channel's catalog/membership changes (create/archive/membership/
      // cursor) must reach the local human operator's dock LIVE, but the human
      // observes read-only WITHOUT a member row, so it is never in the caller-
      // supplied recipient set. Add ws-human for every private channel so a newly
      // created (or mutated) private agent channel appears live in the human dock
      // instead of only on the next manual refresh. NEVER '*': a broadcast leaks
      // the private channel's EXISTENCE to every agent poller (events.rpc passes
      // '*' to all). A public channel is already discoverable by everyone (and
      // fans out via '*'), so it needs nothing here.
      const channel = this.state.channels.find((c) => c.id === channelId);
      if (channel && channel.visibility !== 'public' && !recipients.includes('*')) {
        recipients.push(HUMAN_WORKSPACE_ID);
      }
      this.emit({
        type: 'channel.catalog',
        channelId,
        actorWorkspaceId,
        recipientWorkspaceIds: [...new Set(recipients)],
        reason,
      });
    } catch (err) {
      console.error('[ChannelService] catalog emit failed:', err);
    }
  }

  /** Save the current state via the writer. Returns true on success. */
  private saveOrFail(): boolean {
    return this.writer.saveImmediate(this.state);
  }

  // ── Event-log commit path (envelope-design §5, PR3) ────────────────────

  /**
   * Commit primitive (log mode only — called via commitAndApply only) —
   * `log.append(envelope)` resolves under the fsync barrier (boolean contract D16).
   * 1 commit = 1 envelope (§2.6 no partial-promotion argument ②). Legacy-mode
   * commits are handled by each site's else branch (saveOrFail).
   */
  private async commit(
    payload: ChannelEventPayload,
    auth: { verifiedWorkspaceId: string; principalId?: string },
  ): Promise<boolean> {
    if (!this.eventLog) return this.saveOrFail();
    const draft = makeEnvelope({
      domain: 'channel',
      payload,
      origin: {
        machineId: this.eventLog.machineId,
        daemonEpoch: CHANNELS_EPOCH, // D8: order-agnostic provenance stamp
      },
      // §7 stamping (PR5 complete): stamp server-resolved verifiedWorkspaceId held at
      // service boundary (authz anchor for all mutations, downstream of server pin at
      // a2a.channel.rpc.ts:180-183) and server-decided principal coordinates
      // (display/routing only, not authz — forged sender copy stripped upstream at
      // a2a.channel.rpc.ts:108-120).
      authContext: this.authContextFor(auth),
    });
    const ok = await this.eventLog.log.append(draft);
    if (ok) this.scheduleCacheWrites();
    return ok;
  }

  /**
   * G1 — commit-then-apply (append-then-apply, log mode only). Applies payload to
   * projection **only after** fsync barrier success (applier = same function as replay —
   * live/replay convergence is structurally guaranteed).
   *
   * This order structurally removes dirty reads: old saveOrFail was synchronous with no
   * yield in the mutation critical section, but append introduces await — deferring
   * apply past the barrier means synchronous reads without the mutex (list(),
   * getMessages(), etc.) during that await window always see committed state only.
   * Failure = no apply so no rollback block either (remains in legacy-mode branches
   * only — see each site's else branch).
   */
  private async commitAndApply(
    payload: ChannelEventPayload,
    auth: { verifiedWorkspaceId: string; principalId?: string },
  ): Promise<boolean> {
    if (!(await this.commit(payload, auth))) return false;
    applyChannelEvent(this.state, payload);
    return true;
  }

  /** §7 — Q1 commit path is effectively trusted (untrusted callers fail-closed upstream). */
  private authContextFor(auth: {
    verifiedWorkspaceId: string;
    principalId?: string;
  }): AuthContext {
    return {
      principalId: auth.principalId ?? auth.verifiedWorkspaceId,
      verifiedWorkspaceId: auth.verifiedWorkspaceId,
      trustTier: 'trusted',
    };
  }

  /**
   * Post-commit cache maintenance (§5·§6.4): channels.json dual-write (debounced,
   * watermark stamped by writer at write time) and snapshot/channel.json (debounced,
   * boot acceleration). Both pass live references — serialization happens at write time
   * so latest state is captured. Window where snapshot marker may lag content is
   * absorbed by replay applier idempotence (channelEvents.ts header invariant (b)).
   */
  private scheduleCacheWrites(): void {
    if (!this.eventLog) return;
    this.writer.saveDebounced(this.state);
    this.eventLog.snapshots.saveDebounced(
      CHANNEL_PROJECTION_REF,
      this.state,
      this.eventLog.log.lamportHwm,
    );
  }

  /** Log-mode boot seed (§5): load fallback chain → tail replay → reaper. */
  private seedFromEventLog(eventLog: ChannelServiceEventLog): ChannelState {
    const loaded = eventLog.snapshots.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF,
      genesisRef: eventLog.genesisRef,
      reseedRefs: eventLog.reseedRefs,
      // ChannelStateWriter.isChannelState was promoted public in PR3 (PR2 injection contract).
      validateProjection: (d): boolean => ChannelStateWriter.isChannelState(d),
    });
    let state: ChannelState;
    let floor: number;
    if (loaded) {
      // Strip watermark fields from seed projection (§6.4c — dual-write-only meta).
      const { eventLogWatermark: _wm, ...clean } = loaded.projection as ChannelState & {
        eventLogWatermark?: unknown;
      };
      state = clean as ChannelState;
      floor = loaded.snapshotLamport;
    } else {
      // Snapshot chain total loss (through genesis) — §5 disaster fallback: empty state + full replay.
      console.error(
        '[ChannelService] snapshot fallback chain total loss — attempting full log replay from empty state',
      );
      state = { ...EMPTY_CHANNEL_STATE, channels: [], members: {}, messages: {}, idempotency: {} };
      floor = 0;
    }
    // tail replay (§5): deterministically re-apply channel records after snapshot (lamport > floor).
    // Applier is idempotent (at-least-once §2.6 + snapshot marker lag absorption — channelEvents.ts).
    for (const rec of eventLog.log.readAllRecords()) {
      if (rec.domain !== 'channel') continue; // pass through non-domain records (§1)
      if (rec.lamport <= floor) continue;
      applyChannelEvent(state, rec.payload);
    }
    // Empty-channel reaper — same semantics as legacy load() (sub-semantics unchanged).
    reapEmptyChannels(state, eventLog.emptyChannelTtlHours);
    return state;
  }
}

/**
 * Canonicalize a post body for persistence. The rules are:
 *
 *  1. Strip C0 control characters (U+0000-U+001F) EXCEPT for the
 *     whitespace pass-throughs: `\t` (0x09), `\n` (0x0A), `\r` (0x0D).
 *     This catches terminal escape sequences (0x1B ESC), NULs, and
 *     other bytes that could corrupt downstream TUI consumers when
 *     the post is fanned out to a live PTY.
 *  2. Trim leading/trailing whitespace so a padded body cannot
 *     bypass the byte cap (`CHANNEL_BODY_MAX` is measured on this
 *     sanitized form).
 *
 * Unicode whitespace beyond C0 (e.g. zero-width joiner U+200D,
 * non-breaking space U+00A0) is intentionally NOT stripped here —
 * the renderer / MCP tools treat it as content. If a future
 * "normalize Unicode" rule is added it should land in a single
 * shared helper, not in each transport.
 */
export function sanitizePostText(text: string): string {
  // Strip C0 controls except tab/newline/CR. Use a single regex pass
  // for speed — post bodies can be up to 8 KiB and we do this on the
  // hot path.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
}

/**
 * A11: sender-scoped idempotency key. Keying only by clientMsgId let a
 * predictable id collide ACROSS senders — an attacker could pre-seed a key to
 * suppress another sender's post, or a retry could return the wrong sender's
 * message. JSON-encode the (workspaceId, clientMsgId) pair (collision-free,
 * same rationale as the mention dedup key). The persisted shape keys by this
 * composite string too, so hydration round-trips unchanged.
 */
function idempotencyKey(workspaceId: string, clientMsgId: string): string {
  return JSON.stringify([workspaceId, clientMsgId]);
}
