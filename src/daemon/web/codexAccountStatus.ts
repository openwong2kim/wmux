import { stat } from 'node:fs/promises';
import path from 'node:path';
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
/** A failed read (auth, or the rate limits alone) is kept this long, so a
 * failing account server is not reconnected to on every request. */
export const CODEX_ACCOUNT_STATUS_FAILURE_TTL_MS = 10_000;
/** At least the most panes the relay registry holds, so cycling accounts cannot defeat the cache. */
const MAX_ACCOUNTS = 256;

/** Which credential file an answer describes: a sign-in in the same Codex home changes it. */
async function authStamp(codeHome: string): Promise<string> {
  try { const s = await stat(path.join(codeHome, 'auth.json')); return `${s.ino}:${s.mtimeMs}:${s.size}`; }
  catch { return 'none'; }
}

/**
 * Account status for the phone (contract v-next item 2), read from an account
 * server that is already running: never started here, and no model request.
 * The rate-limit read reaches the provider's backend, so answers are cached
 * per Codex home and credential file for 60 s, failures for 10 s, and
 * concurrent reads of one account share a request.
 */
export function createCodexAccountStatusReader(deps: {
  query?: Query; now?: () => number; ttlMs?: number; failureTtlMs?: number; stamp?: (codeHome: string) => Promise<string>;
} = {}) {
  const query = deps.query ?? queryUpstream;
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? CODEX_ACCOUNT_STATUS_TTL_MS;
  const failureTtl = deps.failureTtlMs ?? CODEX_ACCOUNT_STATUS_FAILURE_TTL_MS;
  const stampOf = deps.stamp ?? authStamp;
  type Entry = { fresh?: Fresh; until: number };
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Fresh>>();

  const remember = (key: string, entry: Entry) => {
    cache.delete(key);
    if (cache.size >= MAX_ACCOUNTS) cache.delete(cache.keys().next().value as string);
    cache.set(key, entry);
  };

  const fetchFresh = async (codeHome: string, key: string): Promise<Fresh> => {
    const upstream = codexUpstreamPath(codeHome);
    let auth: CodexAccountStatus['auth'];
    try { auth = projectCodexAuth(await query(upstream, 'getAuthStatus', { includeToken: false, refreshToken: false })); }
    catch {
      const at = now();
      remember(key, { until: at + failureTtl });
      throw new CodexAccountStatusError();
    }
    // A signed-out or API-key account has no plan limits to read.
    let rateLimits: CodexAccountStatus['rateLimits'] = null;
    let limitsFailed = false;
    if (auth.state === 'signed-in' && auth.method !== 'apikey') {
      try { rateLimits = projectCodexRateLimits(await query(upstream, 'account/rateLimits/read', { excludeResetCreditDetails: true })); }
      catch { limitsFailed = true; }
    }
    const fresh = { auth, rateLimits, fetchedAt: now() };
    remember(key, { fresh, until: fresh.fetchedAt + (limitsFailed ? failureTtl : ttl) });
    return fresh;
  };

  return {
    async read(codeHome: string): Promise<CodexAccountStatus> {
      const key = `${codeHome}\n${await stampOf(codeHome)}`;
      const hit = cache.get(key);
      if (hit && now() < hit.until) {
        if (!hit.fresh) throw new CodexAccountStatusError();
        return { ...hit.fresh, cached: true };
      }
      const joined = inflight.get(key);
      if (joined) return { ...await joined, cached: true };
      const pending = fetchFresh(codeHome, key).finally(() => inflight.delete(key));
      inflight.set(key, pending);
      return { ...await pending, cached: false };
    },
  };
}
