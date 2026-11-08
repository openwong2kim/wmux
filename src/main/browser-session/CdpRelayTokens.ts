import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// One-time tokens for the pipe relay (CdpPipeRelay). browser.cdp.info mints
// one per connect, hands it to the caller over the authenticated wmux pipe,
// and the relay spends it on the one WebSocket upgrade that presents it.
//  - Only a SHA-256 digest of each token is kept; a presented token is
//    compared against every unused digest in constant time.
//  - Single use, valid for RELAY_TOKEN_TTL_MS, at most RELAY_TOKENS_MAX_UNUSED
//    unused at once (the oldest goes first). The same on every OS.
//  - lookup() does not spend: the relay checks the token's Chrome is still
//    there and has room first, then spends it with consume(), synchronously,
//    so a refusal for lack of room leaves the token usable.
// Tokens are never logged.
// ---------------------------------------------------------------------------

export const RELAY_TOKEN_TTL_MS = 30_000;
export const RELAY_TOKENS_MAX_UNUSED = 32;

interface Entry<B> {
  readonly digest: Buffer;
  readonly binding: B;
  readonly expires: number;
}

/** An unused token found by lookup(), not yet spent. */
export interface RelayTicket<B> {
  readonly binding: B;
}

const digestOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export class CdpRelayTokens<B> {
  private entries: Array<Entry<B>> = [];

  /** `dropped` hears of every unused token that goes without being spent: expired, crowded out or forgotten. */
  constructor(private readonly dropped: (binding: B) => void = () => undefined) {}

  /** A new token for `binding`. */
  mint(binding: B): string {
    this.prune();
    const token = randomBytes(32).toString('base64url');
    this.entries.push({ digest: digestOf(token), binding, expires: Date.now() + RELAY_TOKEN_TTL_MS });
    if (this.entries.length > RELAY_TOKENS_MAX_UNUSED) {
      for (const entry of this.entries.splice(0, this.entries.length - RELAY_TOKENS_MAX_UNUSED)) this.dropped(entry.binding);
    }
    return token;
  }

  /** The unused, unexpired token `presented` is, without spending it. */
  lookup(presented: string): RelayTicket<B> | null {
    this.prune();
    const digest = digestOf(presented);
    let found: Entry<B> | null = null;
    // Every digest is compared: how long this takes does not say which one matched.
    for (const entry of this.entries) {
      if (timingSafeEqual(entry.digest, digest)) found = entry;
    }
    return found;
  }

  /** Spend `ticket`; false when it is no longer there (spent, expired or dropped). */
  consume(ticket: RelayTicket<B>): boolean {
    const at = this.entries.indexOf(ticket as Entry<B>);
    if (at === -1 || (ticket as Entry<B>).expires <= Date.now()) return false;
    this.entries.splice(at, 1);
    return true;
  }

  /** Drop every unused token whose binding `gone` names. */
  forget(gone: (binding: B) => boolean): void {
    this.drop((entry) => gone(entry.binding));
  }

  /** How many unused tokens are held (tests and diagnostics; never the tokens). */
  get size(): number {
    this.prune();
    return this.entries.length;
  }

  private prune(): void {
    const now = Date.now();
    if (this.entries.some((entry) => entry.expires <= now)) this.drop((entry) => entry.expires <= now);
  }

  private drop(gone: (entry: Entry<B>) => boolean): void {
    const kept: Array<Entry<B>> = [];
    for (const entry of this.entries) {
      if (gone(entry)) this.dropped(entry.binding);
      else kept.push(entry);
    }
    this.entries = kept;
  }
}
