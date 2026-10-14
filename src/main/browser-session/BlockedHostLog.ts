import { canonicalHost } from '../../shared/browserHostPolicy';
import type { BlockedHost } from '../../shared/browserPolicy';

// ---------------------------------------------------------------------------
// The hosts a protected profile's proxy refused recently (#2063).
//
// A site in "Only these sites" mode usually needs hosts the operator never
// saw (sign-in, CDNs, APIs); a missed one fails behind Chrome's generic
// connection error. This short list is what the pane's editor shows, with an
// Allow per host, so the operator does not have to guess.
//
// In memory only and small: one entry per host:port with how often and when
// it was last refused, the least recently refused one dropped past the bound.
// The owner (ChromeLauncher) clears it when the profile's Chrome launches
// again; main clears every list on any policy change.
// ---------------------------------------------------------------------------

/** Entries kept per profile. */
export const BLOCKED_HOST_LOG_LIMIT = 20;

export class BlockedHostLog {
  /** `host:port` → entry, least recently refused first. */
  private readonly entries = new Map<string, BlockedHost>();

  constructor(
    private readonly limit: number = BLOCKED_HOST_LOG_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  /** Note one refusal. A host that is not a valid host is not recorded. */
  record(rawHost: string, port: number): void {
    const host = canonicalHost(rawHost);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const key = `${host}:${port}`;
    const prev = this.entries.get(key);
    // Re-insert so the Map's order stays "least recently refused first".
    this.entries.delete(key);
    this.entries.set(key, { host, port, lastSeen: this.now(), count: (prev?.count ?? 0) + 1 });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Copies, most recently refused first. */
  list(): BlockedHost[] {
    return [...this.entries.values()].reverse().map((e) => ({ ...e }));
  }

  clear(): void {
    this.entries.clear();
  }
}
