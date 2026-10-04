// GitHub's rate limit, per host: after a rate-limited gh call, reads to that
// host wait (60 s, doubling to 15 min while it keeps answering so); any
// success clears it. One limit, so every gh reader of a host shares one
// breaker (the issue list and the PR review read the same quota).

const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/** A gh failure that is GitHub's rate limit (primary or secondary). Read from
 *  gh's stderr lines only: the error message also holds the argv, where a
 *  label named "rate limit" would otherwise turn a plain 403 into a trip. A 403
 *  without a rate-limit body is a permission or SSO answer and is not one. */
export function isRateLimitError(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown })?.stderr;
  if (typeof stderr !== 'string') return false;
  return stderr.split('\n').some((line) =>
    /\bHTTP 429\b/.test(line) ||
    /API rate limit exceeded/i.test(line) ||
    /secondary rate limit/i.test(line) ||
    (/\bHTTP 403\b/.test(line) && /rate limit/i.test(line)));
}

export class GhRateBreaker {
  private hosts = new Map<string, { until: number; backoff: number }>();

  constructor(private now: () => number = Date.now) {}

  /** When reads to this host resume, or null while they are allowed. */
  retryAt(host: string): number | null {
    const b = this.hosts.get(host);
    return b && this.now() < b.until ? b.until : null;
  }

  trip(host: string): void {
    const prev = this.hosts.get(host);
    const backoff = prev ? Math.min(prev.backoff * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
    this.hosts.set(host, { until: this.now() + backoff, backoff });
  }

  reset(host: string): void {
    this.hosts.delete(host);
  }
}

/** The process-wide breaker every gh reader shares. */
export const ghRateBreaker = new GhRateBreaker();
