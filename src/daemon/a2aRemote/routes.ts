import type http from 'node:http';
import {
  A2A_ROUTES,
  type A2aExposedResponse,
  type A2aLinkProposeRequest,
  type A2aLinkProposeResponse,
  type A2aLinkRecordV1,
  type A2aLinkStatusResponse,
  type A2aRemoteErrorCode,
  isAllowedEndpointPair,
  isConsistentEndpoint,
} from '../../shared/a2aRemote';
import type { A2aRemoteLinkEvent } from '../../shared/rpc';
import type { WebA2aPeer, WebA2aRoutes } from '../web/WebTerminalServer';
import type { ExposedPaneCache, ExposureCheck } from './exposedPanes';
import { linkFromProposal, type NewLinkInput } from './linkStore';
import { A2A_REQUEST_BODY_MAX, readJsonBody, sendJson } from './server';
import { errMsg, isPlainObject, isSafeId } from './storeFile';

/**
 * The authenticated `/api/a2a/*` routes behind the A2A listener (layers 2-3):
 * what this host exposes to the calling peer, and the link proposal, status
 * and revoke routes the joiner drives. `A2aServer` has already refused
 * browsers, authenticated the peer and handled pair/unpair/hello.
 *
 * A small method + path-pattern table so the delivery routes (messages,
 * stream, ack) can be added with `add()` without touching this dispatch.
 */

export interface A2aRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  /** `:name` segments of the matched pattern, URI-decoded. */
  params: Record<string, string>;
  peer: WebA2aPeer;
}

export type A2aRouteHandler = (ctx: A2aRouteContext) => Promise<void> | void;

/** The slice of `LinkStore` the routes need. */
export interface A2aRouteLinks {
  get(linkId: string): A2aLinkRecordV1 | undefined;
  receiveProposal(input: NewLinkInput & { linkId: string }): A2aLinkRecordV1;
  revoke(linkId: string, side: 'local' | 'remote'): A2aLinkRecordV1;
}

export interface A2aRouteDeps {
  exposures: ExposureCheck;
  panes: Pick<ExposedPaneCache, 'visibleTo'>;
  links: A2aRouteLinks;
  /** Drop stale undecided proposals (LinkStore.expireProposals); called before answering a link's state. */
  expireProposals?: () => void;
  /** Daemon -> app nudge (`pipeServer.broadcast`). */
  broadcast: (event: A2aRemoteLinkEvent) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface Route {
  method: string;
  segments: string[];
  handler: A2aRouteHandler;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['revoked', 'broken']);

export class A2aRouteTable implements WebA2aRoutes {
  private readonly routes: Route[] = [];

  /** Register `method pattern`; `pattern` segments starting with ':' capture. */
  add(method: string, pattern: string, handler: A2aRouteHandler): this {
    this.routes.push({ method, segments: pattern.split('/'), handler });
    return this;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, pathname: string, peer: WebA2aPeer): Promise<void> {
    const parts = pathname.split('/');
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      await route.handler({ req, res, url, params, peer });
      return;
    }
    refuse(res, pathMatched ? 405 : 404, 'bad-request', pathMatched ? undefined : 'not found');
  }
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    if (seg.startsWith(':')) {
      if (!parts[i]) return null;
      try {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
    } else if (seg !== parts[i]) {
      return null;
    }
  }
  return params;
}

function refuse(res: http.ServerResponse, status: number, error: A2aRemoteErrorCode, message?: string): void {
  sendJson(res, status, { ok: false, error, ...(message ? { message } : {}) });
}

/**
 * Is `end` (this host's side) one `hostId` may see right now? Exposed to it
 * by the exposure store AND present in the app's latest snapshot. Shared by
 * the proposal route and the accept RPC.
 */
export function isVisibleEnd(
  panes: Pick<ExposedPaneCache, 'visibleTo'>,
  exposures: ExposureCheck,
  hostId: string,
  end: { kind: string; workspaceId: string; paneId?: string },
): boolean {
  return panes
    .visibleTo(hostId, exposures)
    .some((p) => p.kind === end.kind && p.workspaceId === end.workspaceId && (end.kind === 'brain' || p.paneId === end.paneId));
}

/** Layers 2-3: exposed, link propose / status / revoke. */
export function createA2aRoutes(deps: A2aRouteDeps): A2aRouteTable {
  const table = new A2aRouteTable();
  const expireProposals = (): void => {
    try {
      deps.expireProposals?.();
    } catch (err) {
      deps.log('warn', `[a2a-remote] proposal expiry failed: ${errMsg(err)}`);
    }
  };
  const linkPath = `${A2A_ROUTES.links}/:linkId`;

  // What this host shows THIS peer: the app's last snapshot, filtered by the
  // exposure store at answer time (un-exposing takes effect immediately).
  table.add('GET', A2A_ROUTES.exposed, ({ res, peer }) => {
    const body: A2aExposedResponse = { panes: deps.panes.visibleTo(peer.hostId, deps.exposures) };
    sendJson(res, 200, body);
  });

  table.add('POST', A2A_ROUTES.links, async ({ req, res, peer }) => {
    const body = await readJsonBody(req, A2A_REQUEST_BODY_MAX);
    if (body === 'too-large') {
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.socket.destroy());
      return refuse(res, 413, 'too-large');
    }
    const proposal = parseProposal(body);
    if (!proposal) return refuse(res, 400, 'bad-request');
    // Like with like only (no Moa <-> pane in v1), and the receiver's end
    // must be one this peer may see right now: exposed to it AND live in the
    // app's latest snapshot (a closed pane or a replaced HQ is refused). Same
    // answer whether the end exists or not: nothing about unexposed panes leaks.
    if (!isAllowedEndpointPair(proposal.from.kind, proposal.to.kind) || !mayLinkTo(peer, proposal.to)) {
      return refuse(res, 403, 'forbidden');
    }
    if (deps.links.get(proposal.linkId)) return refuse(res, 409, 'conflict', 'duplicate linkId');
    let link: A2aLinkRecordV1;
    try {
      // The proposer's pane is recorded from THIS request and is canonical
      // from here on: later messages never re-read a sender off the wire.
      link = deps.links.receiveProposal(linkFromProposal(peer.hostId, proposal));
    } catch (err) {
      deps.log('warn', `[a2a-remote] link proposal from ${peer.hostId} refused: ${errMsg(err)}`);
      return refuse(res, 409, 'conflict');
    }
    deps.log('info', `[a2a-remote] host ${peer.hostId} proposed link ${link.linkId}`);
    deps.broadcast({ type: 'a2a.remote.link.proposed', linkId: link.linkId });
    const answer: A2aLinkProposeResponse = { linkId: link.linkId, state: 'proposed-in' };
    sendJson(res, 200, answer);
  });

  table.add('GET', linkPath, ({ res, params, peer }) => {
    expireProposals();
    const link = ownedLink(params['linkId'], peer, res);
    if (!link) return;
    const answer: A2aLinkStatusResponse = {
      linkId: link.linkId,
      state: link.state,
      version: link.version,
      ...(link.endedReason ? { endedReason: link.endedReason } : {}),
    };
    sendJson(res, 200, answer);
  });

  table.add('POST', `${linkPath}${A2A_ROUTES.linkRevokeSuffix}`, ({ res, params, peer }) => {
    const link = ownedLink(params['linkId'], peer, res);
    if (!link) return;
    // Already over: answer the same, so a retried revoke is not an error.
    if (TERMINAL.has(link.state)) return sendJson(res, 200, { ok: true, state: link.state });
    let ended: A2aLinkRecordV1;
    try {
      ended = deps.links.revoke(link.linkId, 'remote');
    } catch (err) {
      // A failed write keeps the revocation in memory (LinkStore rule).
      deps.log('error', `[a2a-remote] revoke of link ${link.linkId} could not be persisted: ${errMsg(err)}`);
      ended = deps.links.get(link.linkId) ?? link;
    }
    deps.broadcast({ type: 'a2a.remote.link.changed', linkId: ended.linkId, state: ended.state });
    sendJson(res, 200, { ok: true, state: ended.state });
  });

  /** The end is in what this peer can see right now: exposed AND present in the app's latest snapshot. */
  function mayLinkTo(peer: WebA2aPeer, to: A2aLinkProposeRequest['to']): boolean {
    return isVisibleEnd(deps.panes, deps.exposures, peer.hostId, to);
  }

  /** The link, when it exists AND belongs to the calling peer's host; otherwise answered here. */
  function ownedLink(linkId: string | undefined, peer: WebA2aPeer, res: http.ServerResponse): A2aLinkRecordV1 | null {
    const link = linkId && UUID_RE.test(linkId) ? deps.links.get(linkId) : undefined;
    if (!link) {
      refuse(res, 404, 'unknown-link');
      return null;
    }
    if (link.remote.hostId !== peer.hostId) {
      refuse(res, 403, 'forbidden');
      return null;
    }
    return link;
  }

  return table;
}

/** Strict shape check of `A2aLinkProposeRequest`; the link store re-validates ids and names. */
function parseProposal(raw: unknown): A2aLinkProposeRequest | null {
  if (!isPlainObject(raw)) return null;
  const { linkId, from, to, allow } = raw;
  if (typeof linkId !== 'string' || !UUID_RE.test(linkId)) return null;
  if (!isPlainObject(from) || !isSafeEnd(from)) return null;
  if (!isPlainObject(to) || !isSafeEnd(to)) return null;
  if (!isPlainObject(allow) || typeof allow['outbound'] !== 'boolean' || typeof allow['inbound'] !== 'boolean') return null;
  const optional = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const label = optional(from['label']);
  const workspaceName = optional(from['workspaceName']);
  const gitRemote = optional(from['gitRemote']);
  return {
    linkId,
    from: {
      ...endOf(from),
      ...(label !== undefined ? { label } : {}),
      ...(workspaceName !== undefined ? { workspaceName } : {}),
      ...(gitRemote !== undefined ? { gitRemote } : {}),
    },
    to: endOf(to),
    allow: { outbound: allow['outbound'], inbound: allow['inbound'] },
  };
}

function isSafeEnd(e: Record<string, unknown>): boolean {
  return isConsistentEndpoint(e) && isSafeId(e['workspaceId']) && (e['kind'] !== 'pane' || isSafeId(e['paneId']));
}

function endOf(e: Record<string, unknown>): A2aLinkProposeRequest['to'] {
  return e['kind'] === 'pane'
    ? { kind: 'pane', workspaceId: e['workspaceId'] as string, paneId: e['paneId'] as string }
    : { kind: 'brain', workspaceId: e['workspaceId'] as string };
}
