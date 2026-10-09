import type http from 'node:http';
import { createHash } from 'node:crypto';
import { resolvePhoneGitRepo, type PhoneGitRepo } from './phoneGitRead';
import type { GitRunner } from './sessionDiff';
import { GitWriteReceiptCapacityError, GitWriteReceipts, ghWriteEnv, type GitWriteReceiptRow, type PhoneGitWriteGate } from './phoneGitWriteGate';
import { phoneGitWriteHandlers, type GitWriteSessionContext, type GitWriteSettle, type PhoneGitWriteActionHandlers } from './phoneGitWriteRegistry';
import './phoneGitPr';
import './phoneGitPush';
import {
  GIT_WRITE_ERROR_STATUS, GIT_WRITE_MERGE_METHODS, GIT_WRITE_PR_BODY_MAX_BYTES, GIT_WRITE_REQUEST_ID,
  executeBodyPins, gitWriteFingerprintSource, parsePrCreateExecute, parsePrMergeExecute, parsePrNumber,
  parsePreviewBody, parsePushExecute,
  type GitWriteErrorBody, type GitWritePins, type PhoneGitWriteAction,
  type PrCreateExecuteBody, type PrMergeExecuteBody, type PushExecuteBody,
} from '../../shared/phoneGitWrite';

/**
 * HTTP surface of the phone git write actions (push, pr.create, pr.merge).
 *
 * The server hands every matching request here; this module owns the whole
 * gate so an action module never repeats it:
 *
 *   1. ceiling: `--allow-git-write` (403 `git-write-disabled`)
 *   2. grant: the input grant AND, for a device, one set explicitly; a record
 *      that predates grants does not pass (403 `read-only: …`)
 *   3. receipt store; a receipt GET answers here, by owner + requestId
 *   4. an action without handlers answers 501; then `gitWriteLogin`
 *   5. preview: admission (429 `git-busy`), session, repository, identity
 *   6. execute: requestId lookup → session and repository → durable `pending`
 *      row and token consume in one step → re-authorization → identity →
 *      202, then the action runs
 *
 * A resend with the same requestId and body gets the stored receipt with
 * `replayed: true`, also after its token was spent; a different body under
 * the same requestId is 409 `request-id-reused`.
 */

export type PhoneGitWriteRouteKind = 'preview' | 'execute' | 'receipt';

export interface PhoneGitWriteRoute {
  action: PhoneGitWriteAction;
  kind: PhoneGitWriteRouteKind;
  rawSessionId: string;
  rawNumber?: string;
  rawRequestId?: string;
}

const ROUTES: Array<{ method: string; re: RegExp; action: PhoneGitWriteAction; kind: PhoneGitWriteRouteKind; groups: Array<'rawNumber' | 'rawRequestId'> }> = [
  { method: 'POST', re: /^([^/]+)\/git\/push\/preview$/, action: 'push', kind: 'preview', groups: [] },
  { method: 'POST', re: /^([^/]+)\/git\/push$/, action: 'push', kind: 'execute', groups: [] },
  { method: 'GET', re: /^([^/]+)\/git\/push\/([^/]+)$/, action: 'push', kind: 'receipt', groups: ['rawRequestId'] },
  { method: 'POST', re: /^([^/]+)\/git\/pr$/, action: 'pr.create', kind: 'execute', groups: [] },
  { method: 'GET', re: /^([^/]+)\/git\/pr\/receipts\/([^/]+)$/, action: 'pr.create', kind: 'receipt', groups: ['rawRequestId'] },
  { method: 'POST', re: /^([^/]+)\/git\/pr\/([^/]+)\/merge\/preview$/, action: 'pr.merge', kind: 'preview', groups: ['rawNumber'] },
  { method: 'POST', re: /^([^/]+)\/git\/pr\/([^/]+)\/merge$/, action: 'pr.merge', kind: 'execute', groups: ['rawNumber'] },
  { method: 'GET', re: /^([^/]+)\/git\/pr\/([^/]+)\/merge\/([^/]+)$/, action: 'pr.merge', kind: 'receipt', groups: ['rawNumber', 'rawRequestId'] },
];

/** Match `rest` (the path after `/api/sessions/`). Null for every other route, including GET `…/git/pr`. */
export function matchPhoneGitWriteRoute(method: string | undefined, rest: string): PhoneGitWriteRoute | null {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(rest);
    if (!m) continue;
    const route: PhoneGitWriteRoute = { action: r.action, kind: r.kind, rawSessionId: m[1] };
    r.groups.forEach((g, i) => { route[g] = m[i + 2]; });
    return route;
  }
  return null;
}

/** A principal as the routes see it. */
export type GitWritePrincipal = { kind: 'operator' } | { kind: 'device'; deviceId: string };

/** What the server lends this module. Everything is read at request time. */
export interface PhoneGitWriteHost {
  /** `--allow-git-write` and `gitWriteLogin` of the running server. */
  ceiling(): { allowGitWrite: boolean; login?: string };
  /** The server's input ceiling and the caller's resolved grant (`mayInput`). */
  mayInput(principal: GitWritePrincipal): boolean;
  /** Device only: the roster holds a grant somebody set (not a grandfathered one). */
  explicitInputGrant(deviceId: string): boolean;
  refuseInput(res: http.ServerResponse, principal: GitWritePrincipal, detail: string): void;
  /** The session this caller may attach, with its trusted spawn cwd. */
  session(principal: GitWritePrincipal, sessionId: string): { spawnCwd?: string } | undefined;
  /** After the body: the same credential still authenticates, holds both grants and reaches the session. */
  stillAuthorized(req: http.IncomingMessage, url: URL, principal: GitWritePrincipal, sessionId: string): Promise<boolean>;
  readJsonBody(req: http.IncomingMessage, res: http.ServerResponse, onBody: (body: unknown) => void, maxBytes: number): void;
  json(res: http.ServerResponse, status: number, body: unknown): void;
  gate(): PhoneGitWriteGate | undefined;
  git(): GitRunner;
  log(level: 'info' | 'warn', msg: string): void;
}

const MAX_EXECUTE_BODY_BYTES = GIT_WRITE_PR_BODY_MAX_BYTES * 2 + 8 * 1024;
const MAX_PREVIEW_BODY_BYTES = 1024;

function decode(raw: string): string | null {
  try { return decodeURIComponent(raw); } catch { return null; }
}

const fingerprintOf = (source: string) => createHash('sha256').update(source).digest('hex');

/** The receipt a GET or a resend answers with. */
function receiptBody(row: GitWriteReceiptRow, replayed: boolean): Record<string, unknown> {
  return {
    ...(row.fields ?? {}),
    requestId: row.requestId,
    ...(replayed ? { replayed: true } : {}),
    state: row.state,
    ...(row.state === 'refused' && row.error ? { error: row.error } : {}),
  };
}

/** What a request knows before its session is located. */
type Call = Omit<GitWriteSessionContext, 'ghEnv' | 'cwd' | 'repo'>;

const MAX_PREVIEWS_IN_FLIGHT = 4;
const PREVIEWS_PER_MINUTE = 12;

export class PhoneGitWriteRoutes {
  private previewsInFlight = 0;
  private readonly previewsByOwner = new Map<string, number>();
  private readonly previewTimes = new Map<string, number[]>();

  constructor(private readonly host: PhoneGitWriteHost) {}

  /**
   * The `/api/config` keys. Each is present only when its action can run for
   * this caller: ceiling on, `gitWriteLogin` set, receipt store loaded, an
   * explicit grant, AND the action's handlers registered. Omitted, never false.
   */
  configKeys(principal: GitWritePrincipal): { gitPush?: true; gitPrCreate?: true; gitPrMerge?: { methods: string[] } } {
    const { allowGitWrite, login } = this.host.ceiling();
    if (!allowGitWrite || !login || !this.granted(principal) || !this.gate()?.available) return {};
    return {
      ...(phoneGitWriteHandlers('push') ? { gitPush: true as const } : {}),
      ...(phoneGitWriteHandlers('pr.create') ? { gitPrCreate: true as const } : {}),
      ...(phoneGitWriteHandlers('pr.merge') ? { gitPrMerge: { methods: [...GIT_WRITE_MERGE_METHODS] } } : {}),
    };
  }

  private gate(): PhoneGitWriteGate | undefined {
    try { return this.host.gate(); } catch { return undefined; }
  }

  private granted(principal: GitWritePrincipal): boolean {
    if (!this.host.mayInput(principal)) return false;
    return principal.kind === 'operator' || this.host.explicitInputGrant(principal.deviceId);
  }

  private fail(res: http.ServerResponse, body: GitWriteErrorBody): void {
    this.host.json(res, GIT_WRITE_ERROR_STATUS[body.error], body);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, route: PhoneGitWriteRoute, url: URL, principal: GitWritePrincipal): Promise<void> {
    const { allowGitWrite, login } = this.host.ceiling();
    if (!allowGitWrite) return this.fail(res, { error: 'git-write-disabled' });
    if (!this.host.mayInput(principal)) return this.host.refuseInput(res, principal, 'Git write requires input permission');
    if (principal.kind === 'device' && !this.host.explicitInputGrant(principal.deviceId)) {
      return this.host.json(res, 403, {
        error: 'read-only: this device has no explicit input grant',
        detail: 'Git write needs an input grant set for this device. Set it from "Paired devices" on the machine running wmux web.',
      });
    }
    const sessionId = decode(route.rawSessionId);
    if (sessionId === null) return this.host.json(res, 404, { error: 'session not found' });
    let number: number | undefined;
    if (route.rawNumber !== undefined) {
      const n = parsePrNumber(route.rawNumber);
      if (n === null) return this.fail(res, { error: 'invalid-git-request' });
      number = n;
    }
    const gate = this.gate();
    if (!gate?.available) return this.fail(res, { error: 'git-receipts-unavailable' });
    const owner = principal.kind === 'device' ? `device:${principal.deviceId}` : 'operator';

    // A receipt is read by owner + requestId alone: it stays readable after
    // its session closed or its checkout moved.
    if (route.kind === 'receipt') {
      const raw = decode(route.rawRequestId as string);
      if (raw === null || !GIT_WRITE_REQUEST_ID.test(raw)) return this.fail(res, { error: 'invalid-git-request' });
      const row = gate.receipts.find(GitWriteReceipts.key(owner, raw.toLowerCase()));
      if (!row || row.action !== route.action || row.sessionId !== sessionId || row.number !== number) {
        return this.fail(res, { error: 'receipt-expired' });
      }
      return this.host.json(res, 200, receiptBody(row, false));
    }

    const handlers = phoneGitWriteHandlers(route.action);
    if (!handlers) return this.fail(res, { error: 'not-implemented' });
    if (!login) return this.fail(res, { error: 'gh-auth-missing' });
    const call: Call = {
      action: route.action, owner, deviceId: principal.kind === 'device' ? principal.deviceId : '',
      sessionId, login, ...(number !== undefined ? { number } : {}),
    };
    if (route.kind === 'preview') {
      return this.host.readJsonBody(req, res, (body) => {
        void this.preview(res, principal, body, gate, call, handlers.preview).catch((err: unknown) => this.crashed(res, err));
      }, MAX_PREVIEW_BODY_BYTES);
    }
    this.host.readJsonBody(req, res, (body) => {
      void this.execute(req, res, url, principal, body, gate, call).catch((err: unknown) => this.crashed(res, err));
    }, MAX_EXECUTE_BODY_BYTES);
  }

  private crashed(res: http.ServerResponse, err: unknown): void {
    this.host.log('warn', `[web] git write route failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) this.fail(res, { error: 'git-operation-failed' });
  }

  /** The session's spawn cwd and repository, or the refusal to send. */
  private async locate(principal: GitWritePrincipal, sessionId: string): Promise<{ cwd: string; repo: PhoneGitRepo } | { refuse: GitWriteErrorBody | 'session' }> {
    const session = this.host.session(principal, sessionId);
    if (!session?.spawnCwd) return { refuse: 'session' };
    try {
      const repo = await resolvePhoneGitRepo(session.spawnCwd, this.host.git());
      return repo ? { cwd: session.spawnCwd, repo } : { refuse: { error: 'not-a-git-repo' } };
    } catch {
      return { refuse: { error: 'git-operation-failed' } };
    }
  }

  private refuseLocate(res: http.ServerResponse, refuse: GitWriteErrorBody | 'session'): void {
    if (refuse === 'session') return this.host.json(res, 404, { error: 'session not found' });
    return this.fail(res, refuse);
  }

  /**
   * Admit one preview: at most one in flight per owner and four overall, and
   * at most PREVIEWS_PER_MINUTE per owner. Each preview runs gh and git.
   * Returns the release function, or null when refused.
   */
  private admitPreview(owner: string): (() => void) | null {
    const now = Date.now();
    const recent = (this.previewTimes.get(owner) ?? []).filter((t) => t > now - 60_000);
    if ((this.previewsByOwner.get(owner) ?? 0) >= 1 || this.previewsInFlight >= MAX_PREVIEWS_IN_FLIGHT || recent.length >= PREVIEWS_PER_MINUTE) {
      this.previewTimes.set(owner, recent);
      return null;
    }
    recent.push(now);
    this.previewTimes.set(owner, recent);
    this.previewsInFlight += 1;
    this.previewsByOwner.set(owner, (this.previewsByOwner.get(owner) ?? 0) + 1);
    return () => {
      this.previewsInFlight -= 1;
      const left = (this.previewsByOwner.get(owner) ?? 1) - 1;
      if (left > 0) this.previewsByOwner.set(owner, left); else this.previewsByOwner.delete(owner);
    };
  }

  private async preview(
    res: http.ServerResponse, principal: GitWritePrincipal, body: unknown, gate: PhoneGitWriteGate,
    call: Call, preview: PhoneGitWriteActionHandlers['preview'],
  ): Promise<void> {
    if (!parsePreviewBody(body).ok || !preview) return this.fail(res, { error: 'invalid-git-request' });
    const release = this.admitPreview(call.owner);
    if (!release) return this.fail(res, { error: 'git-busy' });
    try {
      const where = await this.locate(principal, call.sessionId);
      if ('refuse' in where) return this.refuseLocate(res, where.refuse);
      const identity = await gate.identity(call.login);
      if (!identity.ok) {
        return identity.reason === 'missing'
          ? this.fail(res, { error: 'gh-auth-missing', login: call.login })
          : this.fail(res, { error: 'gh-unavailable' });
      }
      const result = await preview({ ...call, ...where, ghEnv: ghWriteEnv(process.env, identity.token) });
      if (!result.ok) return this.fail(res, result.body);
      const grant = gate.tokens.mint(
        { owner: call.owner, sessionId: call.sessionId, repo: where.repo.commonReal, action: call.action, login: call.login },
        result.pins,
      );
      this.host.json(res, 200, { ...result.facts, identity: { login: call.login }, ...grant });
    } finally {
      release();
    }
  }

  private async execute(
    req: http.IncomingMessage, res: http.ServerResponse, url: URL, principal: GitWritePrincipal,
    raw: unknown, gate: PhoneGitWriteGate, call: Call,
  ): Promise<void> {
    const parsed = call.action === 'push' ? parsePushExecute(raw)
      : call.action === 'pr.merge' ? parsePrMergeExecute(raw)
        : parsePrCreateExecute(raw);
    if (!parsed.ok) return this.fail(res, { error: parsed.error });
    const body: PushExecuteBody | PrMergeExecuteBody | PrCreateExecuteBody = parsed.value;
    const { requestId } = body;
    const fingerprint = fingerprintOf(gitWriteFingerprintSource(call.action, body, call.number));
    const key = GitWriteReceipts.key(call.owner, requestId);

    // 1. requestId lookup: a resend gets its receipt back, never a 428, also
    //    after its session closed. A live session that now resolves to another
    //    repository makes it a different request.
    const existing = gate.receipts.find(key);
    if (existing) {
      // The fingerprint covers the action and PR number; the session is checked on its own.
      if (existing.fingerprint !== fingerprint || existing.action !== call.action || existing.sessionId !== call.sessionId) {
        return this.fail(res, { error: 'request-id-reused' });
      }
      const where = this.host.session(principal, call.sessionId) ? await this.locate(principal, call.sessionId) : null;
      if (where && !('refuse' in where) && where.repo.commonReal !== existing.repo) return this.fail(res, { error: 'request-id-reused' });
      return this.host.json(res, 200, receiptBody(existing, true));
    }

    const where = await this.locate(principal, call.sessionId);
    if ('refuse' in where) return this.refuseLocate(res, where.refuse);
    const row = {
      requestId, action: call.action, sessionId: call.sessionId, owner: call.owner, repo: where.repo.commonReal, fingerprint,
      ...(call.number !== undefined ? { number: call.number } : {}),
    };
    // A request accepted while this one resolved its repository.
    if (gate.receipts.find(key)) return this.fail(res, { error: 'request-id-reused' });

    // 2. The durable `pending` row and the token consume, in one synchronous
    //    step. The token is spent only once the row is on disk.
    let pins: GitWritePins | null = null;
    let refusal: GitWriteErrorBody | null = null;
    const begin = () => gate.receipts.begin(key, row);
    try {
      if (call.action === 'pr.create') {
        begin();
      } else {
        const b = body as PushExecuteBody | PrMergeExecuteBody;
        const consumed = gate.tokens.consume(
          b.confirmToken,
          { owner: call.owner, sessionId: call.sessionId, repo: where.repo.commonReal, action: call.action, login: call.login },
          executeBodyPins(call.action, b, call.number),
          begin,
        );
        if (consumed.ok) pins = consumed.pins;
        else if (consumed.error === 'stale') {
          refusal = call.action === 'push'
            ? { error: 'stale', head: String(consumed.pins.head) }
            : { error: 'stale', headRefOid: String(consumed.pins.headRefOid) };
        } else refusal = { error: consumed.error };
      }
    } catch (error) {
      if (error instanceof GitWriteReceiptCapacityError) return this.fail(res, { error: 'git-busy' });
      this.host.log('warn', `[web] git write receipt could not be written: ${error instanceof Error ? error.message : String(error)}`);
      return this.fail(res, { error: 'git-receipts-unavailable' });
    }
    if (refusal) return this.fail(res, refusal);
    const settle = (outcome: GitWriteSettle | { state: 'uncertain' }) => gate.receipts.settle(key, outcome);

    // 3. Re-authorization with the same credential, both grants re-read.
    if (!(await this.host.stillAuthorized(req, url, principal, call.sessionId)) || !this.host.ceiling().allowGitWrite) {
      settle({ state: 'refused', error: 'authorization-expired' });
      return this.fail(res, { error: 'authorization-expired' });
    }
    // 4. The identity: the login must still hold a token.
    const identity = await gate.identity(call.login);
    if (!identity.ok || this.host.ceiling().login !== call.login) {
      settle({ state: 'refused', error: 'identity-changed' });
      return this.fail(res, { error: 'identity-changed' });
    }

    const handlers = phoneGitWriteHandlers(call.action);
    if (!handlers) {
      settle({ state: 'refused', error: 'not-implemented' });
      return this.fail(res, { error: 'not-implemented' });
    }
    this.host.json(res, 202, { requestId, replayed: false, state: 'pending' });
    try {
      await handlers.execute({
        ...call, ...where, ghEnv: ghWriteEnv(process.env, identity.token), requestId, body, pins,
        markInFlight: () => gate.receipts.markInFlight(key),
        settle,
      });
    } catch (err) {
      this.host.log('warn', `[web] git write ${call.action} failed: ${err instanceof Error ? err.message : String(err)}`);
      const now = gate.receipts.find(key);
      if (now?.state === 'inFlight') settle({ state: 'uncertain' });
      else if (now?.state === 'pending') settle({ state: 'refused', error: 'gh-unavailable' });
    }
  }
}
