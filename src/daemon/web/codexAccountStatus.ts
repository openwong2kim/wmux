import {
  CODEX_ACCOUNT_STATUS_TTL_MS, projectCodexAuth, projectCodexRateLimits, type CodexAccountStatus,
} from '../../shared/phoneCodexAccountStatus';
import { codexUpstreamPath, queryUpstream, type CodexUpstreamRead } from './codexTuiRelay';

/** The account server did not answer the auth read (the route's 503 `upstream-failed`). */
export class CodexAccountStatusError extends Error {
  constructor() { super('Codex account status unavailable'); }
}

type Query = (upstreamPath: string, method: CodexUpstreamRead, params: Record<string, unknown>) => Promise<unknown>;
type Fresh = Omit<CodexAccountStatus, 'cached'>;
const MAX_ACCOUNTS = 32;

/**
 * Account status for the phone (contract v-next item 2), read from an account
 * server that is already running: never started here, and no model request.
 * The rate-limit read reaches the provider's backend, so answers are cached
 * per Codex home for 60 s and concurrent reads of one account share a request.
 */
export function createCodexAccountStatusReader(deps: { query?: Query; now?: () => number; ttlMs?: number } = {}) {
  const query = deps.query ?? queryUpstream;
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? CODEX_ACCOUNT_STATUS_TTL_MS;
  const cache = new Map<string, Fresh>();
  const inflight = new Map<string, Promise<Fresh>>();

  const fetchFresh = async (codeHome: string): Promise<Fresh> => {
    const upstream = codexUpstreamPath(codeHome);
    let auth: CodexAccountStatus['auth'];
    try { auth = projectCodexAuth(await query(upstream, 'getAuthStatus', { includeToken: false, refreshToken: false })); }
    catch { throw new CodexAccountStatusError(); }
    // A signed-out or API-key account has no plan limits to read.
    let rateLimits: CodexAccountStatus['rateLimits'] = null;
    if (auth.state === 'signed-in' && auth.method !== 'apikey') {
      try { rateLimits = projectCodexRateLimits(await query(upstream, 'account/rateLimits/read', { excludeResetCreditDetails: true })); }
      catch { rateLimits = null; }
    }
    return { auth, rateLimits, fetchedAt: now() };
  };

  return {
    async read(codeHome: string): Promise<CodexAccountStatus> {
      const hit = cache.get(codeHome);
      if (hit && now() - hit.fetchedAt < ttl) return { ...hit, cached: true };
      let pending = inflight.get(codeHome);
      if (!pending) {
        pending = fetchFresh(codeHome).then((fresh) => {
          cache.delete(codeHome);
          if (cache.size >= MAX_ACCOUNTS) cache.delete(cache.keys().next().value as string);
          cache.set(codeHome, fresh);
          return fresh;
        }).finally(() => inflight.delete(codeHome));
        inflight.set(codeHome, pending);
      }
      return { ...await pending, cached: false };
    },
  };
}
