import type http from 'node:http';
import { createHash } from 'node:crypto';
import { resolvePhoneGitRepo, type PhoneGitRepo } from './phoneGitRead';
import type { GitRunner } from './sessionDiff';
import { GitWriteReceiptCapacityError, GitWriteReceipts, ghWriteEnv, type GitWriteReceiptRow, type PhoneGitWriteGate } from './phoneGitWriteGate';
import { phoneGitWriteHandlers, type GitWriteSessionContext, type GitWriteSettle, type PhoneGitWriteActionHandlers } from './phoneGitWriteRegistry';
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
 *   3. session, repository, receipt store, `gitWriteLogin`
 *   4. receipt GET answers here; an action without handlers answers 501
 *   5. execute: requestId lookup → token consume (receipt `pending`, durable)
 *      → re-authorization → identity → 202, then the action runs
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

export class PhoneGitWriteRoutes {
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
    const session = sessionId === null ? undefined : this.host.session(principal, sessionId);
    if (sessionId === null || !session?.spawnCwd) return this.host.json(res, 404, { error: 'session not found' });
    const cwd = session.spawnCwd;

    let number: number | undefined;
    if (route.rawNumber !== undefined) {
      const n = parsePrNumber(route.rawNumber);
      if (n === null) return this.fail(res, { error: 'invalid-git-request' });
      number = n;
    }
    let requestId: string | undefined;
    if (route.rawRequestId !== undefined) {
      const raw = decode(route.rawRequestId);
      if (raw === null || !GIT_WRITE_REQUEST_ID.test(raw)) return this.fail(res, { error: 'invalid-git-request' });
      requestId = raw.toLowerCase();
    }

    const gate = this.gate();
    if (!gate?.available) return this.fail(res, { error: 'git-receipts-unavailable' });
    let repo: PhoneGitRepo | null;
    try {
      repo = await resolvePhoneGitRepo(cwd, this.host.git());
    } catch {
      return this.host.json(res, 500, { error: 'git-operation-failed' });
    }
    if (!repo) return this.host.json(res, 409, { error: 'not-a-git-repo' });
    const owner = principal.kind === 'device' ? `device:${principal.deviceId}` : 'operator';

    if (route.kind === 'receipt') {
      const row = gate.receipts.find(GitWriteReceipts.key(owner, repo.commonReal, requestId as string));
      if (!row || row.action !== route.action || row.sessionId !== sessionId || row.number !== number) {
        return this.fail(res, { error: 'receipt-expired' });
      }
      return this.host.json(res, 200, receiptBody(row, false));
    }

    const handlers = phoneGitWriteHandlers(route.action);
    if (!handlers) return this.host.json(res, 501, { error: 'not-implemented' });
    if (!login) return this.fail(res, { error: 'gh-auth-missing' });

    const base: Omit<GitWriteSessionContext, 'ghEnv'> = {
      action: route.action, owner, deviceId: principal.kind === 'device' ? principal.deviceId : '',
      sessionId, cwd, repo, login, ...(number !== undefined ? { number } : {}),
    };
    if (route.kind === 'preview') {
      return this.host.readJsonBody(req, res, (body) => {
        void this.preview(res, body, gate, base, handlers.preview).catch((err: unknown) => this.crashed(res, err));
      }, MAX_PREVIEW_BODY_BYTES);
    }
    this.host.readJsonBody(req, res, (body) => {
      void this.execute(req, res, url, principal, body, gate, base).catch((err: unknown) => this.crashed(res, err));
    }, MAX_EXECUTE_BODY_BYTES);
  }

  private crashed(res: http.ServerResponse, err: unknown): void {
    this.host.log('warn', `[web] git write route failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) this.host.json(res, 500, { error: 'git-operation-failed' });
  }

  private async preview(
    res: http.ServerResponse, body: unknown, gate: PhoneGitWriteGate,
    base: Omit<GitWriteSessionContext, 'ghEnv'>, preview: PhoneGitWriteActionHandlers['preview'],
  ): Promise<void> {
    if (!parsePreviewBody(body).ok || !preview) return this.fail(res, { error: 'invalid-git-request' });
    const identity = await gate.identity(base.login);
    if (!identity.ok) {
      return identity.reason === 'missing'
        ? this.fail(res, { error: 'gh-auth-missing', login: base.login })
        : this.fail(res, { error: 'gh-unavailable' });
    }
    const result = await preview({ ...base, ghEnv: ghWriteEnv(process.env, identity.token) });
    if (!result.ok) return this.fail(res, result.body);
    const grant = gate.tokens.mint(
      { owner: base.owner, sessionId: base.sessionId, repo: base.repo.commonReal, action: base.action, login: base.login },
      result.pins,
    );
    this.host.json(res, 200, { ...result.facts, identity: { login: base.login }, ...grant });
  }

  private async execute(
    req: http.IncomingMessage, res: http.ServerResponse, url: URL, principal: GitWritePrincipal,
    raw: unknown, gate: PhoneGitWriteGate, base: Omit<GitWriteSessionContext, 'ghEnv'>,
  ): Promise<void> {
    const parsed = base.action === 'push' ? parsePushExecute(raw)
      : base.action === 'pr.merge' ? parsePrMergeExecute(raw)
        : parsePrCreateExecute(raw);
    if (!parsed.ok) return this.fail(res, { error: parsed.error });
    const body: PushExecuteBody | PrMergeExecuteBody | PrCreateExecuteBody = parsed.value;
    const { requestId } = body;
    const fingerprint = fingerprintOf(gitWriteFingerprintSource(base.action, body, base.number));
    const key = GitWriteReceipts.key(base.owner, base.repo.commonReal, requestId);

    // 1. requestId lookup: a resend gets its receipt back, never a 428.
    const existing = gate.receipts.find(key);
    if (existing) {
      // The fingerprint covers the action and PR number; the session is checked on its own.
      if (existing.fingerprint !== fingerprint || existing.action !== base.action || existing.sessionId !== base.sessionId) {
        return this.fail(res, { error: 'request-id-reused' });
      }
      return this.host.json(res, 200, receiptBody(existing, true));
    }

    // 2. Token consume and the durable `pending` row, in one synchronous step.
    let pins: GitWritePins | null = null;
    if (base.action !== 'pr.create') {
      const b = body as PushExecuteBody | PrMergeExecuteBody;
      const consumed = gate.tokens.consume(
        b.confirmToken,
        { owner: base.owner, sessionId: base.sessionId, repo: base.repo.commonReal, action: base.action, login: base.login },
        executeBodyPins(base.action, b, base.number),
      );
      if (!consumed.ok) {
        if (consumed.error !== 'stale') return this.fail(res, { error: consumed.error });
        const now = base.action === 'push' ? { head: String(consumed.pins.head) } : { headRefOid: String(consumed.pins.headRefOid) };
        return this.fail(res, { error: 'stale', ...now });
      }
      pins = consumed.pins;
    }
    try {
      gate.receipts.begin(key, {
        requestId, action: base.action, sessionId: base.sessionId, owner: base.owner, fingerprint,
        ...(base.number !== undefined ? { number: base.number } : {}),
      });
    } catch (error) {
      if (error instanceof GitWriteReceiptCapacityError) return this.fail(res, { error: 'git-busy' });
      this.host.log('warn', `[web] git write receipt could not be written: ${error instanceof Error ? error.message : String(error)}`);
      return this.fail(res, { error: 'git-receipts-unavailable' });
    }
    const settle = (outcome: GitWriteSettle | { state: 'uncertain' }) => gate.receipts.settle(key, outcome);

    // 3. Re-authorization with the same credential, both grants re-read.
    if (!(await this.host.stillAuthorized(req, url, principal, base.sessionId)) || !this.host.ceiling().allowGitWrite) {
      settle({ state: 'refused', error: 'authorization-expired' });
      return this.fail(res, { error: 'authorization-expired' });
    }
    // 4. The identity: the login must still hold a token.
    const identity = await gate.identity(base.login);
    if (!identity.ok || this.host.ceiling().login !== base.login) {
      settle({ state: 'refused', error: 'identity-changed' });
      return this.fail(res, { error: 'identity-changed' });
    }

    const handlers = phoneGitWriteHandlers(base.action);
    if (!handlers) {
      settle({ state: 'refused', error: 'gh-unavailable' });
      return this.host.json(res, 501, { error: 'not-implemented' });
    }
    this.host.json(res, 202, { requestId, replayed: false, state: 'pending' });
    try {
      await handlers.execute({
        ...base, ghEnv: ghWriteEnv(process.env, identity.token), requestId, body, pins,
        markInFlight: () => gate.receipts.markInFlight(key),
        settle,
      });
    } catch (err) {
      this.host.log('warn', `[web] git write ${base.action} failed: ${err instanceof Error ? err.message : String(err)}`);
      const row = gate.receipts.find(key);
      if (row?.state === 'inFlight') settle({ state: 'uncertain' });
      else if (row?.state === 'pending') settle({ state: 'refused', error: 'gh-unavailable' });
    }
  }
}
