import crypto from 'node:crypto';
import { formatInvite, parseInvite, type CertFingerprint256 } from '../../shared/a2aRemote';

/**
 * The A2A listener's one-shot invite slot. Separate from the phone web
 * server's pairing slot on purpose: this one only ever leads to a PEER
 * credential. Same code shape as the other pair flows (8 chars from the
 * unambiguous A-Z2-9 alphabet), 10 minute lifetime, 5 wrong attempts.
 */

/** A-Z2-9 minus the visually ambiguous 0/O/1/I. 32 symbols, so `byte % 32` is unbiased. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
export const A2A_PAIR_TTL_MS = 10 * 60 * 1000;
export const A2A_PAIR_MAX_ATTEMPTS = 5;

export interface PairingBeginResult {
  /** `wmux-a2a://<host>:<port>/<CODE>#sha256=<fingerprint>` */
  invite: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface PairingStatus {
  active: boolean;
  expiresAt: number | null;
  attemptsLeft: number;
}

/** What `check` decided about a presented code. */
export type PairingCheck =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'invalid-code' };

export interface PairingSlotOptions {
  now?: () => number;
  /** Test seam for the code. */
  mintCode?: () => string;
}

export function mintPairCode(): string {
  const bytes = crypto.randomBytes(CODE_LEN);
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

/**
 * Pick the invite's host: this machine's name when the invite grammar accepts
 * it (company DNS survives DHCP), otherwise the first external IPv4. Null when
 * neither is usable.
 */
export function inviteHost(hostname: string, ipv4s: readonly string[]): string | null {
  const probe = (host: string): boolean =>
    parseInvite(formatInvite({ host, port: 1, code: 'AAAAAAAA', fingerprint256: ZERO_FP })).ok;
  const name = hostname.trim();
  if (name && probe(name)) return name;
  return ipv4s.find((ip) => probe(ip)) ?? null;
}

const ZERO_FP = Array.from({ length: 32 }, () => '00').join(':');

export class PairingSlot {
  private readonly now: () => number;
  private readonly mintCode: () => string;
  private code: string | null = null;
  private expiresAt = 0;
  private attemptsLeft = 0;

  constructor(opts: PairingSlotOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.mintCode = opts.mintCode ?? mintPairCode;
  }

  /** Open (or replace) the invite. */
  begin(params: { host: string; port: number; fingerprint256: CertFingerprint256; alt?: string[] }): PairingBeginResult {
    this.code = this.mintCode();
    this.expiresAt = this.now() + A2A_PAIR_TTL_MS;
    this.attemptsLeft = A2A_PAIR_MAX_ATTEMPTS;
    return {
      invite: formatInvite({
        host: params.host,
        port: params.port,
        code: this.code,
        fingerprint256: params.fingerprint256,
        ...(params.alt && params.alt.length > 0 ? { alt: params.alt } : {}),
      }),
      expiresAt: this.expiresAt,
    };
  }

  cancel(): void {
    this.code = null;
    this.expiresAt = 0;
    this.attemptsLeft = 0;
  }

  status(): PairingStatus {
    this.expireIfDue();
    return this.code
      ? { active: true, expiresAt: this.expiresAt, attemptsLeft: this.attemptsLeft }
      : { active: false, expiresAt: null, attemptsLeft: 0 };
  }

  /**
   * Judge a presented code WITHOUT consuming it. A wrong code costs one
   * attempt; the last one burns the invite. The caller consumes a right code
   * with `consume()` before any await, so one code mints at most once.
   */
  check(supplied: string): PairingCheck {
    this.expireIfDue();
    if (!this.code) return { ok: false, reason: 'expired' };
    if (!timingSafeEqualStr(supplied.trim().toUpperCase(), this.code)) {
      this.attemptsLeft -= 1;
      if (this.attemptsLeft <= 0) this.cancel();
      return { ok: false, reason: 'invalid-code' };
    }
    return { ok: true };
  }

  /** Burn the invite after a successful `check`. */
  consume(): void {
    this.cancel();
  }

  private expireIfDue(): void {
    if (this.code && this.now() >= this.expiresAt) this.cancel();
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compare against itself on a length mismatch so the time does not depend on where it differs.
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
