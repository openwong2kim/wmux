import type { RemoteHost, RemoteHostStatus } from '../../shared/remoteHosts';
import { isCredentialSafeOrigin } from '../../shared/remotePairInput';

/**
 * Reachability of each paired host, for the Remote hub's "Other computers".
 *
 * A probe is `GET /api/config` with the host's own credential, and the answer
 * is read narrowly on purpose:
 *
 *   - the request threw (DNS, refused, TLS, timeout) → `unreachable`. The
 *     host may simply be asleep; nothing here ever suggests re-pairing for it.
 *   - 401 → `needs-repair`. The host no longer accepts this credential (its
 *     server was restarted, or this computer was revoked). Only a 401: the
 *     host's 403s are feature gates, not a rejected credential.
 *   - any other HTTP answer → `reachable`. Something answered, as that host.
 *
 * Cached per host for `ttlMs` so reopening the hub does not re-probe every
 * machine, with at most `concurrency` probes in flight and a short timeout,
 * so a host that is off never holds the others up.
 */
export type ProbedStatus = Exclude<RemoteHostStatus, 'connected'>;

export interface HostStatusProberOptions {
  fetchImpl: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  concurrency?: number;
}

export const HOST_STATUS_TTL_MS = 60_000;
export const HOST_STATUS_TIMEOUT_MS = 4_000;
export const HOST_STATUS_CONCURRENCY = 3;

interface CacheEntry {
  status: ProbedStatus;
  at: number;
  /** The credential and address the answer was about; a re-pair changes them. */
  origin: string;
  token: string;
}

export class HostStatusProber {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: HostStatusProberOptions) {
    this.fetchImpl = opts.fetchImpl;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? HOST_STATUS_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? HOST_STATUS_TIMEOUT_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? HOST_STATUS_CONCURRENCY);
  }

  /** Forget one host's answer (paired again, removed), or every answer. */
  invalidate(hostId?: string): void {
    if (hostId === undefined) this.cache.clear();
    else this.cache.delete(hostId);
  }

  async probe(hosts: readonly RemoteHost[], opts: { force?: boolean } = {}): Promise<Record<string, ProbedStatus>> {
    const out: Record<string, ProbedStatus> = {};
    const due: RemoteHost[] = [];
    const at = this.now();
    for (const host of hosts) {
      const hit = this.cache.get(host.id);
      if (
        !opts.force &&
        hit &&
        at - hit.at < this.ttlMs &&
        hit.origin === host.origin &&
        hit.token === host.token
      ) {
        out[host.id] = hit.status;
      } else {
        due.push(host);
      }
    }
    // Forget hosts that are no longer paired, so the cache is bounded by the roster.
    const known = new Set(hosts.map((h) => h.id));
    for (const id of [...this.cache.keys()]) if (!known.has(id)) this.cache.delete(id);

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const host = due[next++];
        const status = await this.probeOne(host);
        this.cache.set(host.id, { status, at: this.now(), origin: host.origin, token: host.token });
        out[host.id] = status;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, due.length) }, () => worker()));
    return out;
  }

  private async probeOne(host: RemoteHost): Promise<ProbedStatus> {
    // The bearer token is never sent to another machine over plain http.
    // Such a host (registered before this rule) is reported, not probed.
    let url: URL;
    try {
      url = new URL(host.origin);
    } catch {
      return 'unreachable';
    }
    if (!isCredentialSafeOrigin(url)) return 'insecure';
    let res: Response;
    try {
      res = await this.fetchImpl(`${host.origin}/api/config`, {
        headers: { Authorization: `Bearer ${host.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return 'unreachable';
    }
    // The body is not needed; drop it so the socket is released promptly.
    try {
      await res.body?.cancel();
    } catch {
      /* already consumed or closed */
    }
    return res.status === 401 ? 'needs-repair' : 'reachable';
  }
}

/**
 * The hub row's status: the probe, sharpened by what this app already knows.
 * A client that latched the host's refusal is `needs-repair` whatever an older
 * probe said; a reachable host this app holds live streams to is `connected`.
 */
export function combineHostStatus(
  probed: ProbedStatus | undefined,
  client: { isAuthRejected(): boolean; liveAttachmentCount(): number } | undefined,
): RemoteHostStatus | undefined {
  if (client?.isAuthRejected()) return 'needs-repair';
  if (probed === 'reachable' && client && client.liveAttachmentCount() > 0) return 'connected';
  return probed;
}
