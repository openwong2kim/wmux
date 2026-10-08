import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import {
  A2A_REMOTE_RECORD_V,
  isA2aRemoteMessageKind,
  isAllowedEndpointPair,
  isConsistentEndpoint,
  isHostId,
  type A2aEndpoint,
  type A2aEndpointKind,
  type A2aLinkProposeRequest,
  type A2aLinkRecordV1,
  type A2aLinkState,
  type A2aRemoteEnvelope,
  type A2aRemoteErrorCode,
  type A2aRemoteMessageKind,
  type HostId,
} from '../../shared/a2aRemote';
import {
  isIsoString,
  isPlainObject,
  isSafeId,
  loadStore,
  sanitizeName,
  sanitizeRepoKey,
  storeUnavailable,
  type StoreLog,
} from './storeFile';

/**
 * Layer 3 of cross-host A2A: one local pane <-> one remote pane (`links.json`),
 * stored from THIS host's perspective.
 *
 * Transitions (anything else throws):
 *
 *   (none)        --proposeOut-------> proposed-out
 *   (none)        --receiveProposal--> proposed-in
 *   proposed-in   --accept-----------> active   (version + 1)
 *   proposed-out  --applyRemoteAccept> active   (remote version, EXACTLY ours + 1)
 *   proposed-*|active --revoke-------> revoked  (terminal, version + 1; a remote
 *                                                revoke is taken at ANY version)
 *   proposed-*|active --markBroken---> broken   (terminal, version + 1; a remote
 *                                                notice must name EXACTLY ours + 1)
 *   proposed-*|active --forgetHost---> revoked  (revoked-remote; peer revoked here)
 *
 * Ends are a pane or the host's Moa (`brain`); only like with like
 * (`isAllowedEndpointPair`). Limits: at most one non-terminal link per (local
 * end, remote host, remote end), and per remote host's Moa; at most `LINKS_PER_HOST_MAX` non-terminal links per remote host; the
 * newest `TERMINAL_KEEP` terminal links are kept, older ones are pruned.
 *
 * Corrupt file (bad JSON, bad record, two live links on one pane triple):
 * start empty and keep the original as `links.json.corrupt-<ts>`. An
 * UNREADABLE file leaves the store unavailable (no link, every mutation throws)
 * so the original is never overwritten.
 *
 * Write failure: every op rolls memory back and throws, EXCEPT `revoke`,
 * `markBroken` and `forgetHost`, which keep the in-memory terminal state
 * (#658: a revocation that silently un-happens on a disk error is worse than
 * one that is only lost on restart) and still throw so the caller can surface it.
 */

export const LINKS_FILE = 'links.json';
/** Non-terminal links one remote host may hold here. */
export const LINKS_PER_HOST_MAX = 64;
/** Terminal (revoked/broken) links kept for display; older ones are pruned. */
export const TERMINAL_KEEP = 256;

type EndedReason = NonNullable<A2aLinkRecordV1['endedReason']>;
export type BrokenReason = Extract<EndedReason, 'pane-closed' | 'pane-moved' | 'workspace-gone' | 'exposure-revoked'>;
/** The `link` field of a lifecycle envelope. */
export type LinkNotice = NonNullable<A2aRemoteEnvelope['link']>;

/** What a caller supplies for a new link; the store stamps v/state/version/timestamps. */
export type NewLinkInput = Pick<A2aLinkRecordV1, 'local' | 'remote' | 'allow'>;

export type LinkCheckResult =
  /** `kind` is the link's end kind (both ends share it: isAllowedEndpointPair). */
  | { ok: true; link: A2aLinkRecordV1; kind: A2aEndpointKind }
  | {
      ok: false;
      error: Extract<
        A2aRemoteErrorCode,
        | 'unknown-link'
        | 'link-not-active'
        | 'stale-link-version'
        | 'direction-not-allowed'
        | 'forbidden'
        | 'bad-request'
        | 'unknown-task'
      >;
    };

const TERMINAL: ReadonlySet<A2aLinkState> = new Set(['revoked', 'broken']);
const BROKEN_REASONS: ReadonlySet<string> = new Set(['pane-closed', 'pane-moved', 'workspace-gone', 'exposure-revoked']);
/** A `proposed-in` link nobody decided on is dropped after this long. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const REVOKED_REASONS: ReadonlySet<string> = new Set(['revoked-local', 'revoked-remote']);
const STATES: ReadonlySet<string> = new Set(['proposed-out', 'proposed-in', 'active', 'revoked', 'broken']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Turn an incoming `A2aLinkProposeRequest` from `hostId` into THIS side's
 * perspective: the proposer's `to` is our local pane, its `from` is the remote
 * pane, and its directions flip (its outbound is our inbound).
 */
export function linkFromProposal(hostId: HostId, req: A2aLinkProposeRequest): NewLinkInput & { linkId: string } {
  return {
    linkId: req.linkId,
    local: endpointOf(req.to),
    remote: {
      hostId,
      ...endpointOf(req.from),
      ...(req.from.label !== undefined ? { label: req.from.label } : {}),
      ...(req.from.workspaceName !== undefined ? { workspaceName: req.from.workspaceName } : {}),
      ...(req.from.gitRemote !== undefined ? { gitRemote: req.from.gitRemote } : {}),
    },
    allow: { outbound: req.allow.inbound, inbound: req.allow.outbound },
  };
}

export interface LinkStoreOptions {
  /** Directory holding the store, e.g. `<wmux data dir>/a2a/`. */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the deferred owner-only re-harden. */
  scheduleHarden?: (filePath: string) => void;
  /** Test seam for `proposeOut` link ids (must return UUIDs). */
  mintId?: () => string;
  /**
   * Called after every state change of an existing link (accept, revoke,
   * broken, the host cascade) — also when the write failed but the change
   * stands in memory. The delivery layer ends the link's tasks from here.
   */
  onTransition?: (link: A2aLinkRecordV1) => void;
}

export class LinkStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly mintId: () => string;
  private readonly onTransition: (link: A2aLinkRecordV1) => void;
  private readonly links = new Map<string, A2aLinkRecordV1>();
  private writable = true;

  constructor(opts: LinkStoreOptions) {
    this.filePath = path.join(opts.dir, LINKS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.mintId = opts.mintId ?? ((): string => crypto.randomUUID());
    this.onTransition = opts.onTransition ?? ((): void => undefined);
    this.load();
  }

  // --- reads ------------------------------------------------------------------

  get(linkId: string): A2aLinkRecordV1 | undefined {
    const rec = this.links.get(linkId);
    return rec ? structuredClone(rec) : undefined;
  }

  list(): A2aLinkRecordV1[] {
    return [...this.links.values()].map((r) => structuredClone(r));
  }

  listByHost(hostId: HostId): A2aLinkRecordV1[] {
    return this.list().filter((r) => r.remote.hostId === hostId);
  }

  /** Every ACTIVE link on a local pane (a pane may link to several remote panes). */
  findActiveByLocalPane(workspaceId: string, paneId: string): A2aLinkRecordV1[] {
    return this.list().filter(
      (r) => r.state === 'active' && r.local.kind === 'pane' && r.local.workspaceId === workspaceId && r.local.paneId === paneId,
    );
  }

  /** Every ACTIVE link on this host's Moa (the brain of HQ `hqWorkspaceId`). */
  findActiveByLocalBrain(hqWorkspaceId: string): A2aLinkRecordV1[] {
    return this.list().filter((r) => r.state === 'active' && r.local.kind === 'brain' && r.local.workspaceId === hqWorkspaceId);
  }

  /** Every ACTIVE link to one remote pane (it may link to several local panes). */
  findActiveByRemote(hostId: HostId, workspaceId: string, paneId: string | undefined): A2aLinkRecordV1[] {
    return this.list().filter(
      (r) =>
        r.state === 'active' &&
        r.remote.hostId === hostId &&
        r.remote.workspaceId === workspaceId &&
        r.remote.paneId === paneId,
    );
  }

  // --- transitions ------------------------------------------------------------

  /** This side proposes; mints the linkId. */
  proposeOut(input: NewLinkInput): A2aLinkRecordV1 {
    this.assertWritable();
    let linkId = this.mintId();
    while (this.links.has(linkId)) linkId = this.mintId();
    return this.create(linkId, input, 'proposed-out');
  }

  /** The other side proposed (remote input). A duplicate linkId, in any state, is refused. */
  receiveProposal(input: NewLinkInput & { linkId: string }): A2aLinkRecordV1 {
    this.assertWritable();
    if (typeof input.linkId !== 'string' || !UUID_RE.test(input.linkId)) throw new Error('link: invalid linkId');
    if (this.links.has(input.linkId)) throw new Error(`link ${input.linkId}: duplicate linkId`);
    return this.create(input.linkId, input, 'proposed-in');
  }

  /**
   * Drop a `proposed-out` link the other side never acknowledged (its
   * proposal POST failed). Not a transition: the link never existed there.
   */
  discard(linkId: string): void {
    const rec = this.require(linkId, ['proposed-out'], 'discard');
    this.links.delete(linkId);
    try {
      this.persist();
    } catch (err) {
      this.links.set(linkId, rec);
      throw err;
    }
  }

  /**
   * Drop (`revoked-local`) every `proposed-in` link older than `ttlMs` that
   * nobody accepted or declined, so a proposal whose sender went silent does
   * not stay acceptable forever. Returns the links it ended.
   */
  expireProposals(ttlMs: number = PROPOSAL_TTL_MS): A2aLinkRecordV1[] {
    const cutoff = this.now() - ttlMs;
    const stale = [...this.links.values()].filter((r) => r.state === 'proposed-in' && Date.parse(r.createdAt) < cutoff);
    const ended: A2aLinkRecordV1[] = [];
    for (const rec of stale) {
      try {
        ended.push(this.revoke(rec.linkId, 'local'));
      } catch (err) {
        this.log('error', `[a2a-remote] expired proposal ${rec.linkId} not persisted: ${err instanceof Error ? err.message : String(err)}`);
        const now = this.links.get(rec.linkId);
        if (now) ended.push(structuredClone(now));
      }
    }
    return ended;
  }

  /** Our human accepted a `proposed-in` link. */
  accept(linkId: string): A2aLinkRecordV1 {
    const rec = this.require(linkId, ['proposed-in'], 'accept');
    return this.commit(rec, { state: 'active', version: rec.version + 1 }, true);
  }

  /**
   * The other side's human accepted our `proposed-out` link. Their accept bumps
   * the version once, so the notice must name EXACTLY ours + 1.
   */
  applyRemoteAccept(linkId: string, version: number): A2aLinkRecordV1 {
    const rec = this.require(linkId, ['proposed-out'], 'applyRemoteAccept');
    if (version !== rec.version + 1) {
      throw new Error(`link ${linkId}: remote accept version ${version}, expected ${rec.version + 1}`);
    }
    return this.commit(rec, { state: 'active', version }, true);
  }

  /**
   * End a link. `side: 'remote'` applies the owning host's revoke notice and is
   * taken at ANY version: a revocation must never be blockable by a version
   * race (the caller has already checked the sender owns the link — see
   * `checkMessage`).
   */
  revoke(linkId: string, side: 'local' | 'remote'): A2aLinkRecordV1 {
    const rec = this.require(linkId, ['proposed-out', 'proposed-in', 'active'], 'revoke');
    const endedReason: EndedReason = side === 'local' ? 'revoked-local' : 'revoked-remote';
    return this.commit(rec, { state: 'revoked', version: rec.version + 1, endedReason }, false);
  }

  /**
   * Mark a link broken. Locally (no `remoteVersion`) whenever a bound pane or
   * workspace goes away; from the other side's notice only when it names
   * EXACTLY ours + 1 (their markBroken bumped once).
   */
  markBroken(linkId: string, reason: BrokenReason, remoteVersion?: number): A2aLinkRecordV1 {
    if (!BROKEN_REASONS.has(reason)) throw new Error(`link ${linkId}: invalid broken reason`);
    const rec = this.require(linkId, ['proposed-out', 'proposed-in', 'active'], 'markBroken');
    if (remoteVersion !== undefined && remoteVersion !== rec.version + 1) {
      throw new Error(`link ${linkId}: remote broken version ${remoteVersion}, expected ${rec.version + 1}`);
    }
    return this.commit(rec, { state: 'broken', version: rec.version + 1, endedReason: reason }, false);
  }

  /**
   * The peer for `hostId` was revoked here: end every non-terminal link to it
   * as `revoked-remote`. Entry point of the revoke cascade. Keeps its
   * in-memory effect on a failed write (like `revoke`). Returns how many
   * links were ended.
   */
  forgetHost(hostId: HostId): number {
    this.assertWritable();
    const at = new Date(this.now()).toISOString();
    let ended = 0;
    const changed: A2aLinkRecordV1[] = [];
    for (const rec of [...this.links.values()]) {
      if (rec.remote.hostId !== hostId || TERMINAL.has(rec.state)) continue;
      const next: A2aLinkRecordV1 = {
        ...rec,
        state: 'revoked',
        version: rec.version + 1,
        endedReason: 'revoked-remote',
        updatedAt: at,
      };
      this.links.set(rec.linkId, next);
      changed.push(next);
      ended += 1;
    }
    if (ended === 0) return 0;
    try {
      this.persist();
    } catch (err) {
      this.log('error', `[a2a-remote] ${ended} link(s) to host ${hostId} are revoked in memory but could not be persisted`);
      this.announce(changed);
      throw err;
    }
    this.announce(changed);
    return ended;
  }

  // --- delivery gate ----------------------------------------------------------

  /**
   * May a message on `linkId` pass? `hostId` is the AUTHENTICATED peer host
   * (inbound) or the host we are about to send to (outbound). Check order is
   * deliberate: an unknown link, then a host that does not own the link
   * (`forbidden`, before anything about the link's state leaks), then state,
   * version and direction.
   *
   *   - `task`: needs an active link at exactly this version, and the
   *     direction flag (`allow.inbound` for a received task, `allow.outbound`
   *     for one we send).
   *   - `reply` / `state`: active link at this version, and ONLY for a task
   *     that really belongs to this link — the caller decides that from the
   *     ledger's remote-task marker and passes `task.onThisLink`; anything else
   *     is `unknown-task`. Direction flags do not apply: a reply into an
   *     existing task on this link is allowed either way, but a reply cannot
   *     be used to inject text or state into an arbitrary task id.
   *   - `link` (lifecycle notice): pass the envelope's `link` as `notice`; the
   *     envelope's `linkVersion` is not used, `notice.version` is. Missing
   *     notice → `bad-request`.
   *       - `active` (remote accept): link must be `proposed-out` and the
   *         notice must name exactly our version + 1.
   *       - `broken`: link must be non-terminal, notice exactly our version + 1.
   *       - `revoked`: link must be non-terminal; ANY version. A revocation
   *         from the authenticated owner of the link must never be blocked.
   *     The matching transition (`applyRemoteAccept` / `markBroken(…, v)` /
   *     `revoke(…, 'remote')`) enforces the same rule.
   */
  checkMessage(
    linkId: string,
    version: number,
    hostId: HostId,
    direction: 'inbound' | 'outbound',
    kind: A2aRemoteMessageKind,
    notice?: LinkNotice,
    task?: { onThisLink: boolean },
  ): LinkCheckResult {
    const rec = this.links.get(linkId);
    if (!rec) return { ok: false, error: 'unknown-link' };
    if (rec.remote.hostId !== hostId) return { ok: false, error: 'forbidden' };
    if (!isA2aRemoteMessageKind(kind)) return { ok: false, error: 'bad-request' };
    if (kind === 'link') {
      if (!isPlainObject(notice)) return { ok: false, error: 'bad-request' };
      if (TERMINAL.has(rec.state)) return { ok: false, error: 'link-not-active' };
      switch (notice.state) {
        case 'revoked':
          return { ok: true, link: structuredClone(rec), kind: rec.local.kind };
        case 'active':
          if (rec.state !== 'proposed-out') return { ok: false, error: 'link-not-active' };
          if (notice.version !== rec.version + 1) return { ok: false, error: 'stale-link-version' };
          return { ok: true, link: structuredClone(rec), kind: rec.local.kind };
        case 'broken':
          if (notice.version !== rec.version + 1) return { ok: false, error: 'stale-link-version' };
          return { ok: true, link: structuredClone(rec), kind: rec.local.kind };
        default:
          return { ok: false, error: 'bad-request' };
      }
    }
    if (rec.state !== 'active') return { ok: false, error: 'link-not-active' };
    if (version !== rec.version) return { ok: false, error: 'stale-link-version' };
    if (kind === 'task') {
      if (!(direction === 'inbound' ? rec.allow.inbound : rec.allow.outbound)) {
        return { ok: false, error: 'direction-not-allowed' };
      }
    } else if (task?.onThisLink !== true) {
      return { ok: false, error: 'unknown-task' };
    }
    return { ok: true, link: structuredClone(rec), kind: rec.local.kind };
  }

  // --- internals --------------------------------------------------------------

  private create(linkId: string, input: NewLinkInput, state: 'proposed-out' | 'proposed-in'): A2aLinkRecordV1 {
    const clean = cleanNewLink(input);
    if (typeof clean === 'string') throw new Error(`link ${linkId}: ${clean}`);
    const live = [...this.links.values()].filter((r) => !TERMINAL.has(r.state));
    const clash = live.find((r) => sameEnds(r, clean));
    if (clash) throw new Error(`link ${linkId}: pane pair already linked by ${clash.linkId} (${clash.state})`);
    if (live.filter((r) => r.remote.hostId === clean.remote.hostId).length >= LINKS_PER_HOST_MAX) {
      throw new Error(`link ${linkId}: host ${clean.remote.hostId} already holds ${LINKS_PER_HOST_MAX} live links`);
    }

    const at = new Date(this.now()).toISOString();
    const proposer = state === 'proposed-out' ? 'local' : 'remote';
    const rec: A2aLinkRecordV1 = { v: A2A_REMOTE_RECORD_V, linkId, version: 1, state, ...clean, proposer, createdAt: at, updatedAt: at };
    this.links.set(linkId, rec);
    try {
      this.persist();
    } catch (err) {
      this.links.delete(linkId);
      throw err;
    }
    return structuredClone(rec);
  }

  private require(linkId: string, from: A2aLinkState[], op: string): A2aLinkRecordV1 {
    this.assertWritable();
    const rec = this.links.get(linkId);
    if (!rec) throw new Error(`link ${linkId}: unknown link`);
    if (!from.includes(rec.state)) throw new Error(`link ${linkId}: ${op} not allowed from ${rec.state}`);
    return rec;
  }

  /** Apply `patch`; on a failed write roll back only when `rollback` is true. */
  private commit(
    rec: A2aLinkRecordV1,
    patch: Pick<A2aLinkRecordV1, 'state' | 'version'> & { endedReason?: EndedReason },
    rollback: boolean,
  ): A2aLinkRecordV1 {
    const next: A2aLinkRecordV1 = { ...rec, ...patch, updatedAt: new Date(this.now()).toISOString() };
    this.links.set(rec.linkId, next);
    try {
      this.persist();
    } catch (err) {
      if (rollback) this.links.set(rec.linkId, rec);
      else {
        this.log('error', `[a2a-remote] link ${rec.linkId} is ${next.state} in memory but could not be persisted`);
        this.announce([next]);
      }
      throw err;
    }
    this.announce([next]);
    return structuredClone(next);
  }

  /** Tell `onTransition` (a throwing listener never undoes a transition). */
  private announce(changed: A2aLinkRecordV1[]): void {
    for (const rec of changed) {
      try {
        this.onTransition(structuredClone(rec));
      } catch (err) {
        this.log('error', `[a2a-remote] link ${rec.linkId} transition listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private assertWritable(): void {
    if (!this.writable) throw storeUnavailable(LINKS_FILE);
  }

  private persist(): void {
    this.pruneTerminal();
    this.write(this.filePath, { v: A2A_REMOTE_RECORD_V, links: [...this.links.values()] });
    this.scheduleHarden(this.filePath);
  }

  /** Keep only the newest `TERMINAL_KEEP` terminal links. */
  private pruneTerminal(): void {
    const terminal = [...this.links.values()]
      .filter((r) => TERMINAL.has(r.state))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    for (const stale of terminal.slice(TERMINAL_KEEP)) this.links.delete(stale.linkId);
  }

  private load(): void {
    const { value, writable } = loadStore({
      filePath: this.filePath,
      fileName: LINKS_FILE,
      coerce: coerceFile,
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'starting with no links',
    });
    this.writable = writable;
    for (const rec of value ?? []) this.links.set(rec.linkId, rec);
  }
}

/** A link end without the display fields (kind + workspaceId + paneId when a pane). */
function endpointOf(e: { kind: A2aEndpointKind; workspaceId: string; paneId?: string }): A2aEndpoint {
  return e.kind === 'pane' ? { kind: 'pane', workspaceId: e.workspaceId, paneId: e.paneId } : { kind: 'brain', workspaceId: e.workspaceId };
}

function sameEnd(a: A2aEndpoint, b: A2aEndpoint): boolean {
  return a.kind === b.kind && a.workspaceId === b.workspaceId && a.paneId === b.paneId;
}

/**
 * Would `b` duplicate live link `a`? The same (local end, remote host, remote
 * end); and for Moa, any second link with the same remote host's Moa — an HQ
 * that was recreated (new workspaceId) must not open a parallel link.
 */
function sameEnds(a: NewLinkInput, b: NewLinkInput): boolean {
  if (a.remote.hostId !== b.remote.hostId) return false;
  if (a.remote.kind === 'brain' && b.remote.kind === 'brain') return true;
  return sameEnd(a.local, b.local) && sameEnd(a.remote, b.remote);
}

/**
 * Validate and copy a new link's pane pair. Ids are bounded and free of
 * control characters (they may come from a remote host); the label follows
 * the display-name rule and is dropped when empty.
 */
/** A bounded end: known kind, safe workspaceId, and a safe paneId exactly when it is a pane. */
function isSafeEnd(e: Record<string, unknown>): boolean {
  return isConsistentEndpoint(e) && isSafeId(e['workspaceId']) && (e['kind'] !== 'pane' || isSafeId(e['paneId']));
}

function cleanNewLink(input: unknown): NewLinkInput | string {
  if (!isPlainObject(input)) return 'invalid link';
  const { local, remote, allow } = input;
  if (!isPlainObject(local) || !isSafeEnd(local)) return 'invalid local end';
  if (
    !isPlainObject(remote) ||
    !isHostId(remote['hostId']) ||
    !isSafeEnd(remote) ||
    (remote['label'] !== undefined && typeof remote['label'] !== 'string') ||
    (remote['workspaceName'] !== undefined && typeof remote['workspaceName'] !== 'string') ||
    (remote['gitRemote'] !== undefined && typeof remote['gitRemote'] !== 'string')
  ) {
    return 'invalid remote end';
  }
  if (!isAllowedEndpointPair(local['kind'] as A2aEndpointKind, remote['kind'] as A2aEndpointKind)) return 'endpoint pair not allowed';
  if (!isPlainObject(allow) || typeof allow['outbound'] !== 'boolean' || typeof allow['inbound'] !== 'boolean') {
    return 'invalid allow flags';
  }
  const label = remote['label'] === undefined ? '' : sanitizeName(remote['label'], '');
  const workspaceName = remote['workspaceName'] === undefined ? '' : sanitizeName(remote['workspaceName'], '');
  const gitRemote = sanitizeRepoKey(remote['gitRemote']);
  return {
    local: endpointOf(local as unknown as A2aEndpoint),
    remote: {
      hostId: remote['hostId'],
      ...endpointOf(remote as unknown as A2aEndpoint),
      ...(label ? { label } : {}),
      ...(workspaceName ? { workspaceName } : {}),
      ...(gitRemote ? { gitRemote } : {}),
    },
    allow: { outbound: allow['outbound'], inbound: allow['inbound'] },
  };
}

/**
 * Whole-file validation: any bad record rejects the file. `endedReason` must
 * match the state (revoked → revoked-*, broken → a broken reason, absent on a
 * live link), and no pane triple may carry two live links.
 */
function coerceFile(raw: unknown): A2aLinkRecordV1[] | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !Array.isArray(raw['links'])) return null;
  const out: A2aLinkRecordV1[] = [];
  const seen = new Set<string>();
  for (const r of raw['links']) {
    if (!isPlainObject(r) || r['v'] !== 1) return null;
    const { linkId, version, state, endedReason, proposer, createdAt, updatedAt } = r;
    if (proposer !== 'local' && proposer !== 'remote') return null;
    if ((state === 'proposed-out' && proposer !== 'local') || (state === 'proposed-in' && proposer !== 'remote')) return null;
    if (typeof linkId !== 'string' || !UUID_RE.test(linkId) || seen.has(linkId)) return null;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
    if (typeof state !== 'string' || !STATES.has(state)) return null;
    if (!isIsoString(createdAt) || !isIsoString(updatedAt)) return null;
    if (state === 'revoked' ? !REVOKED_REASONS.has(endedReason as string) : state === 'broken' ? !BROKEN_REASONS.has(endedReason as string) : endedReason !== undefined) {
      return null;
    }
    const clean = cleanNewLink(r);
    if (typeof clean === 'string') return null;
    if (!TERMINAL.has(state as A2aLinkState) && out.some((o) => !TERMINAL.has(o.state) && sameEnds(o, clean))) return null;
    seen.add(linkId);
    out.push({
      v: 1,
      linkId,
      version,
      state: state as A2aLinkState,
      ...clean,
      proposer,
      createdAt,
      updatedAt,
      ...(endedReason !== undefined ? { endedReason: endedReason as EndedReason } : {}),
    });
  }
  return out;
}
