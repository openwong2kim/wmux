import {
  A2A_ROUTES,
  a2aLinkPath,
  formatPeerCredential,
  isAllowedEndpointPair,
  isConsistentEndpoint,
  type A2aEndpointKind,
  type A2aExposureV1,
  type A2aLinkProposeRequest,
  type A2aLinkRecordV1,
  type A2aRemoteErrorCode,
  type A2aRemoteHostRecordV1,
  type HostId,
  type PeerCredential,
} from '../../shared/a2aRemote';
import type {
  A2aRemoteCallError,
  A2aRemoteHostsExposedResult,
  A2aRemoteLinkEvent,
  A2aRemoteLinkResult,
  A2aRemotePaneGoneParams,
} from '../../shared/rpc';
import { cleanExposedPane, type ExposedPaneCache, type ExposureCheck } from './exposedPanes';
import { isVisibleEnd } from './routes';
import type { JsonClient } from './joiner';
import type { BrokenReason, LinkStore } from './linkStore';
import { PinnedClientError, PinnedTlsClient, type PinnedClientOptions } from './pinnedClient';
import { errMsg, isPlainObject, isSafeId } from './storeFile';

/**
 * `a2a.remote.exposure.*`, `a2a.remote.hosts.exposed`, `a2a.remote.links.*`
 * and `a2a.remote.local.paneGone` — the machine-local control-pipe RPCs for
 * layers 2-3. `wmux.internal`: only the app's own human exposes panes,
 * proposes, accepts or revokes a link.
 *
 * Who calls whom: the JOINER (the PC that pasted the invite) is the only side
 * that can reach the other, so it proposes, polls the link's state
 * (`refresh`) and revokes over the pinned client. The SERVER only answers;
 * its accept / reject / revoke reach the joiner through `notifyLinkChange`
 * (the outbox + stream of the delivery layer).
 */

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Server -> joiner link notice (`link{ state }` envelope). The outbox lives in
 * the delivery layer; until it is wired in, this seam is a no-op and the
 * joiner learns the outcome by polling `refresh`.
 */
export type NotifyLinkChange = (hostId: HostId, linkId: string, state: 'active' | 'revoked' | 'broken', version: number) => void;

export interface A2aLinkRpcDeps {
  links: LinkStore;
  exposures: ExposureCheck & {
    get(hostId: HostId): A2aExposureV1 | undefined;
    list(): A2aExposureV1[];
    set(hostId: HostId, input: { workspaceIds: string[]; paneIds?: Record<string, string[]>; brain?: boolean }): A2aExposureV1;
    forgetPane(paneId: string): void;
    forgetWorkspace(workspaceId: string): void;
  };
  panes: ExposedPaneCache;
  remoteHosts: {
    get(hostId: HostId): A2aRemoteHostRecordV1 | undefined;
    credentialFor(hostId: HostId): PeerCredential | null;
  };
  broadcast: (event: A2aRemoteLinkEvent) => void;
  /** Default: no-op (wired to the outbox with the delivery layer). */
  notifyLinkChange?: NotifyLinkChange;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seam; default `new PinnedTlsClient(opts)`. */
  client?: (opts: PinnedClientOptions) => JsonClient;
  /** Test seam. */
  timeouts?: { connectMs: number; requestMs: number };
}

const DEFAULT_TIMEOUTS = { connectMs: 3_000, requestMs: 10_000 };
const NON_TERMINAL: ReadonlySet<string> = new Set(['proposed-out', 'proposed-in', 'active']);
const REMOTE_ERRORS: ReadonlySet<string> = new Set<A2aRemoteErrorCode>([
  'unauthorized', 'forbidden', 'unknown-link', 'link-not-active', 'stale-link-version', 'direction-not-allowed',
  'unknown-task', 'conflict', 'too-large', 'bad-request', 'protocol', 'unavailable',
]);
const GONE_REASONS: ReadonlySet<string> = new Set(['pane-closed', 'pane-moved', 'workspace-gone']);
/** Broken reasons the other PC may report for its end (`refresh`). */
const SERVER_BROKEN_REASONS: ReadonlySet<string> = new Set([...GONE_REASONS, 'exposure-revoked']);

class CallFailure extends Error {
  /**
   * `sent`: request bytes may have reached the other PC. `answered`: it
   * replied (a definite refusal). Sent but not answered = outcome unknown.
   */
  constructor(readonly code: A2aRemoteCallError, detail: string, readonly sent = false, readonly answered = false) {
    super(detail);
  }
}

export function registerA2aLinkRpc(onRpc: (method: string, handler: RpcHandler) => void, deps: A2aLinkRpcDeps): void {
  const { links } = deps;
  const notify: NotifyLinkChange = deps.notifyLinkChange ?? ((): void => undefined);
  const makeClient = deps.client ?? ((opts: PinnedClientOptions): JsonClient => new PinnedTlsClient(opts));
  const timeouts = deps.timeouts ?? DEFAULT_TIMEOUTS;
  const str = (params: Record<string, unknown>, key: string): string =>
    typeof params[key] === 'string' ? (params[key] as string) : '';

  const changed = (link: A2aLinkRecordV1): void =>
    deps.broadcast({ type: 'a2a.remote.link.changed', linkId: link.linkId, state: link.state });

  /** A pinned client for a server this PC joined; throws `not-paired` when there is none. */
  const clientFor = (hostId: HostId): JsonClient => {
    const host = deps.remoteHosts.get(hostId);
    const credential = deps.remoteHosts.credentialFor(hostId);
    if (!host || !credential) throw new CallFailure('not-paired', `not paired with ${hostId}`);
    return makeClient({
      addresses: host.addresses,
      port: host.port,
      fingerprint256: host.fingerprint256,
      credential: formatPeerCredential(credential),
      connectTimeoutMs: timeouts.connectMs,
      requestTimeoutMs: timeouts.requestMs,
    });
  };

  /** One call to the server; a non-2xx answer becomes the server's error code. */
  const call = async (hostId: HostId, method: string, path: string, body?: unknown): Promise<unknown> => {
    const client = clientFor(hostId);
    let answer: { status: number; json: unknown };
    try {
      answer = await client.requestJson(method, path, body);
    } catch (err) {
      throw transportFailure(err);
    }
    if (answer.status >= 200 && answer.status < 300) return answer.json;
    const code = isPlainObject(answer.json) ? answer.json['error'] : undefined;
    throw new CallFailure(
      typeof code === 'string' && REMOTE_ERRORS.has(code) ? (code as A2aRemoteErrorCode) : 'failed',
      `the other PC answered HTTP ${answer.status}`,
      true,
      true,
    );
  };

  const fail = (err: unknown): A2aRemoteLinkResult => {
    if (err instanceof CallFailure) return { ok: false, error: err.code, message: err.message };
    return { ok: false, error: 'failed', message: errMsg(err) };
  };

  // --- exposure ---------------------------------------------------------------

  onRpc('a2a.remote.exposure.publish', async (params) => ({ ok: true, count: deps.panes.publish(params['panes']) }));

  onRpc('a2a.remote.exposure.list', async () => ({ exposures: deps.exposures.list() }));

  onRpc('a2a.remote.exposure.get', async (params) => ({ exposure: deps.exposures.get(str(params, 'hostId')) ?? null }));

  onRpc('a2a.remote.exposure.set', async (params) => {
    const hostId = str(params, 'hostId');
    const workspaceIds = params['workspaceIds'];
    if (!Array.isArray(workspaceIds) || !workspaceIds.every(isSafeId)) {
      throw new Error('a2a.remote.exposure.set: workspaceIds must be an array of ids');
    }
    // Always explicit: a listed workspace with no pane list exposes NO pane,
    // never "every pane" (the contract's meaning of an absent key).
    const rawPanes = isPlainObject(params['paneIds']) ? params['paneIds'] : {};
    const paneIds: Record<string, string[]> = {};
    for (const ws of workspaceIds) {
      const list = rawPanes[ws];
      paneIds[ws] = Array.isArray(list) ? list.filter(isSafeId) : [];
    }
    if (params['brain'] !== undefined && typeof params['brain'] !== 'boolean') {
      throw new Error('a2a.remote.exposure.set: brain must be boolean');
    }
    const exposure = deps.exposures.set(hostId, { workspaceIds, paneIds, brain: params['brain'] === true });
    // Hidden means unlinked: a live link from that PC to an end it can no
    // longer see breaks now (only links that PC proposed to this one).
    for (const rec of links.listByHost(hostId)) {
      if (rec.proposer !== 'remote' || !NON_TERMINAL.has(rec.state)) continue;
      const stillShown = rec.local.kind === 'brain'
        ? deps.exposures.isBrainExposed(hostId)
        : deps.exposures.isPaneExposed(hostId, rec.local.workspaceId, rec.local.paneId ?? '');
      if (!stillShown) breakLink(rec, 'exposure-revoked');
    }
    return { exposure };
  });

  onRpc('a2a.remote.hosts.exposed', async (params): Promise<A2aRemoteHostsExposedResult> => {
    try {
      const json = await call(str(params, 'hostId'), 'GET', A2A_ROUTES.exposed);
      const raw = isPlainObject(json) && Array.isArray(json['panes']) ? json['panes'] : null;
      if (!raw) return { ok: false, error: 'protocol' };
      // Remote input: re-validated like the app's own snapshot.
      return { ok: true, panes: raw.map(cleanExposedPane).filter((p) => p !== null) };
    } catch (err) {
      const r = fail(err);
      return { ok: false, error: r.ok ? 'failed' : r.error };
    }
  });

  // --- links ------------------------------------------------------------------

  /** Undecided proposals past their TTL end here (and the app hears it). */
  const expire = (): void => {
    try {
      for (const link of links.expireProposals()) changed(link);
    } catch (err) {
      deps.log('warn', `[a2a-remote] proposal expiry failed: ${errMsg(err)}`);
    }
  };

  onRpc('a2a.remote.links.list', async () => {
    expire();
    return { links: links.list() };
  });

  onRpc('a2a.remote.links.propose', async (params): Promise<A2aRemoteLinkResult> => {
    const hostId = str(params, 'hostId');
    const local = endArg(params['local']);
    const remote = endArg(params['remote']);
    const allow = params['allow'];
    if (!local || !remote || !isPlainObject(allow) || typeof allow['outbound'] !== 'boolean' || typeof allow['inbound'] !== 'boolean') {
      return { ok: false, error: 'bad-request' };
    }
    if (!allow['outbound'] && !allow['inbound']) return { ok: false, error: 'bad-request', message: 'no direction allowed' };
    if (!isAllowedEndpointPair(local.kind, remote.kind)) {
      return { ok: false, error: 'forbidden', message: 'Moa links only to Moa, a pane only to a pane' };
    }
    if (!deps.remoteHosts.get(hostId)) return { ok: false, error: 'not-paired' };

    let link: A2aLinkRecordV1;
    try {
      link = links.proposeOut({
        local: local.kind === 'pane' ? { kind: 'pane', workspaceId: local.workspaceId, paneId: local.paneId } : { kind: 'brain', workspaceId: local.workspaceId },
        remote: { hostId, ...remote },
        allow: { outbound: allow['outbound'], inbound: allow['inbound'] },
      });
    } catch (err) {
      return { ok: false, error: 'conflict', message: errMsg(err) };
    }
    const request: A2aLinkProposeRequest = {
      linkId: link.linkId,
      from: local,
      to: remote.kind === 'pane' ? { kind: 'pane', workspaceId: remote.workspaceId, paneId: remote.paneId } : { kind: 'brain', workspaceId: remote.workspaceId },
      allow: link.allow,
    };
    try {
      await call(hostId, 'POST', A2A_ROUTES.links, request);
    } catch (err) {
      // Went out, no answer: the other PC may hold it. Keep ours as
      // proposed-out so Check (refresh) can settle it either way; dropping it
      // would leave an acceptable proposal there that this PC cannot see.
      if (!(err instanceof CallFailure) || (err.sent && !err.answered)) {
        const r = fail(err);
        return r.ok ? r : { ...r, uncertain: true, link };
      }
      // Refused, or never sent: the other PC does not hold it.
      try {
        links.discard(link.linkId);
      } catch (discardErr) {
        deps.log('error', `[a2a-remote] could not drop failed proposal ${link.linkId}: ${errMsg(discardErr)}`);
      }
      return fail(err);
    }
    deps.log('info', `[a2a-remote] proposed link ${link.linkId} to host ${hostId}`);
    changed(link);
    return { ok: true, link };
  });

  onRpc('a2a.remote.links.accept', async (params): Promise<A2aRemoteLinkResult> => {
    expire();
    const rec = links.get(str(params, 'linkId'));
    if (!rec) return { ok: false, error: 'unknown-link' };
    if (rec.state !== 'proposed-in') return { ok: false, error: 'invalid-state' };
    // Re-checked at the moment of the human's yes: the pane (or Moa) must
    // still be shown to that PC and still exist. Otherwise the link stays
    // pending and the answer says why.
    if (!isVisibleEnd(deps.panes, deps.exposures, rec.remote.hostId, rec.local)) {
      return { ok: false, error: 'forbidden', message: 'that end is no longer shown to that PC' };
    }
    try {
      const link = links.accept(rec.linkId);
      notify(link.remote.hostId, link.linkId, 'active', link.version);
      changed(link);
      return { ok: true, link };
    } catch (err) {
      return fail(err);
    }
  });

  onRpc('a2a.remote.links.reject', async (params): Promise<A2aRemoteLinkResult> => {
    const rec = links.get(str(params, 'linkId'));
    if (!rec) return { ok: false, error: 'unknown-link' };
    if (rec.state !== 'proposed-in') return { ok: false, error: 'invalid-state' };
    const link = endLocally(rec);
    notify(link.remote.hostId, link.linkId, 'revoked', link.version);
    changed(link);
    return { ok: true, link };
  });

  onRpc('a2a.remote.links.revoke', async (params): Promise<A2aRemoteLinkResult> => {
    const rec = links.get(str(params, 'linkId'));
    if (!rec) return { ok: false, error: 'unknown-link' };
    if (!NON_TERMINAL.has(rec.state)) return { ok: false, error: 'invalid-state' };
    // Refused here first, whatever the other PC answers.
    const link = endLocally(rec);
    notify(link.remote.hostId, link.linkId, 'revoked', link.version);
    changed(link);
    // A server this PC joined: tell it directly (best effort).
    let remoteNotified: boolean | undefined;
    if (deps.remoteHosts.get(link.remote.hostId)) {
      remoteNotified = await call(link.remote.hostId, 'POST', a2aLinkPath(link.linkId) + A2A_ROUTES.linkRevokeSuffix, {})
        .then(() => true, () => false);
    }
    return { ok: true, link, ...(remoteNotified !== undefined ? { remoteNotified } : {}) };
  });

  onRpc('a2a.remote.links.refresh', async (params): Promise<A2aRemoteLinkResult> => {
    const rec = links.get(str(params, 'linkId'));
    if (!rec) return { ok: false, error: 'unknown-link' };
    if (!NON_TERMINAL.has(rec.state)) return { ok: true, link: rec };
    let status: Record<string, unknown>;
    try {
      const json = await call(rec.remote.hostId, 'GET', a2aLinkPath(rec.linkId));
      if (!isPlainObject(json)) return { ok: false, error: 'protocol' };
      status = json;
    } catch (err) {
      // The server no longer knows a link we still wait on: it is over there.
      if (err instanceof CallFailure && err.code === 'unknown-link') {
        changed(endRemotely(rec));
      }
      return fail(err);
    }
    try {
      const next = applyServerState(rec, status);
      if (next && next.state !== rec.state) changed(next);
      return { ok: true, link: next ?? rec };
    } catch (err) {
      return fail(err);
    }
  });

  // --- pane / workspace gone --------------------------------------------------

  onRpc('a2a.remote.local.paneGone', async (params) => {
    const workspaceId = str(params, 'workspaceId');
    const paneId = str(params, 'paneId');
    const reason = str(params, 'reason') as A2aRemotePaneGoneParams['reason'];
    const brainGone = params['endpoint'] === 'brain';
    if (!workspaceId || !GONE_REASONS.has(reason) || (reason !== 'workspace-gone' && !paneId) || (brainGone && reason !== 'workspace-gone')) {
      throw new Error('a2a.remote.local.paneGone: workspaceId, paneId and a known reason are required');
    }
    let broken = 0;
    for (const rec of links.list()) {
      if (!NON_TERMINAL.has(rec.state) || rec.local.workspaceId !== workspaceId) continue;
      if (brainGone && rec.local.kind !== 'brain') continue;
      if (reason !== 'workspace-gone' && (rec.local.kind !== 'pane' || rec.local.paneId !== paneId)) continue;
      breakLink(rec, reason as BrokenReason);
      broken += 1;
    }
    try {
      if (brainGone) {
        deps.panes.forgetBrain();
      } else if (reason === 'workspace-gone') {
        deps.exposures.forgetWorkspace(workspaceId);
        deps.panes.forgetWorkspace(workspaceId);
      } else {
        deps.exposures.forgetPane(paneId);
        deps.panes.forgetPane(paneId);
      }
    } catch (err) {
      deps.log('error', `[a2a-remote] exposure cleanup after ${reason} failed: ${errMsg(err)}`);
    }
    return { ok: true, broken };
  });

  /** Break here; a failed write keeps it broken in memory (LinkStore rule). */
  function breakLink(rec: A2aLinkRecordV1, reason: BrokenReason): void {
    let link: A2aLinkRecordV1;
    try {
      link = links.markBroken(rec.linkId, reason);
    } catch (err) {
      deps.log('error', `[a2a-remote] link ${rec.linkId} broken but not persisted: ${errMsg(err)}`);
      link = links.get(rec.linkId) ?? rec;
    }
    notify(link.remote.hostId, link.linkId, 'broken', link.version);
    changed(link);
  }

  /** Revoke here; a failed write keeps the revocation in memory (LinkStore rule). */
  function endLocally(rec: A2aLinkRecordV1): A2aLinkRecordV1 {
    try {
      return links.revoke(rec.linkId, 'local');
    } catch (err) {
      deps.log('error', `[a2a-remote] revoke of link ${rec.linkId} not persisted: ${errMsg(err)}`);
      return links.get(rec.linkId) ?? rec;
    }
  }

  /** The other side ended it; a failed write keeps the revocation in memory. */
  function endRemotely(rec: A2aLinkRecordV1): A2aLinkRecordV1 {
    try {
      return links.revoke(rec.linkId, 'remote');
    } catch (err) {
      deps.log('error', `[a2a-remote] revoke of link ${rec.linkId} not persisted: ${errMsg(err)}`);
      return links.get(rec.linkId) ?? rec;
    }
  }

  /**
   * Fold the server's view of a link into ours. Only moves forward: its
   * accept of our proposal, or its end of the link. Returns null when there
   * is nothing to apply.
   */
  function applyServerState(rec: A2aLinkRecordV1, status: Record<string, unknown>): A2aLinkRecordV1 | null {
    const state = status['state'];
    const version = status['version'];
    if (status['linkId'] !== rec.linkId || typeof version !== 'number') throw new CallFailure('protocol', 'malformed link status');
    if (state === 'active' && rec.state === 'proposed-out') return links.applyRemoteAccept(rec.linkId, version);
    if (state === 'revoked') return links.revoke(rec.linkId, 'remote');
    if (state === 'broken') {
      const reason = status['endedReason'];
      return links.markBroken(rec.linkId, SERVER_BROKEN_REASONS.has(reason as string) ? (reason as BrokenReason) : 'pane-closed');
    }
    return null;
  }
}

type EndArg = { kind: A2aEndpointKind; workspaceId: string; paneId?: string; label?: string; workspaceName?: string; gitRemote?: string };

/** An end argument from the app: kind and ids required, display fields passed through for the store to sanitize. */
function endArg(raw: unknown): EndArg | null {
  if (!isPlainObject(raw) || !isConsistentEndpoint(raw) || !isSafeId(raw['workspaceId'])) return null;
  if (raw['kind'] === 'pane' && !isSafeId(raw['paneId'])) return null;
  const out: EndArg = raw['kind'] === 'pane'
    ? { kind: 'pane', workspaceId: raw['workspaceId'], paneId: raw['paneId'] as string }
    : { kind: 'brain', workspaceId: raw['workspaceId'] };
  for (const key of ['label', 'workspaceName', 'gitRemote'] as const) {
    if (typeof raw[key] === 'string' && raw[key]) out[key] = raw[key];
  }
  return out;
}

function transportFailure(err: unknown): CallFailure {
  if (err instanceof CallFailure) return err;
  if (!(err instanceof PinnedClientError)) return new CallFailure('failed', errMsg(err));
  switch (err.code) {
    case 'fingerprint-mismatch':
      return new CallFailure('fingerprint-mismatch', err.message);
    case 'connect-failed':
      return new CallFailure('unreachable', err.message);
    case 'timeout':
      return new CallFailure('timeout', err.message, true);
    default:
      return new CallFailure('failed', err.message, err.sent);
  }
}
