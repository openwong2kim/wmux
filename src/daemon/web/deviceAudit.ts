import fs from 'node:fs';
import path from 'node:path';

/**
 * M3 — append-only audit trail for device credentials (`device-audit.jsonl` in
 * the suffix-aware wmux data dir).
 *
 * What it answers: "when did that phone pair", "did I actually revoke it", and
 * "is something hammering the port with bad credentials". None of that is
 * recoverable from `devices.json`, which only ever holds the CURRENT roster —
 * a revoked record can be pruned, and a device that was never known leaves no
 * trace there at all.
 *
 * JSONL rather than JSON because the file is only ever appended to on a hot
 * path: one `appendFileSync` of a short line, no read-modify-write, and a torn
 * tail costs exactly one unparseable line instead of the whole history.
 *
 * NOTHING secret is written here — no secrets, no hashes, no salts, no tokens.
 * The file is deliberately readable for troubleshooting.
 */

const AUDIT_FILE = 'device-audit.jsonl';

/**
 * Size ceiling. `auth-failure` is reachable by anyone who can reach the port,
 * so the file must be bounded by something other than good behaviour. 128 KiB
 * is thousands of entries — far more than an operator will ever read — and
 * small enough that the compaction below is a single cheap rewrite.
 */
export const DEVICE_AUDIT_MAX_BYTES = 128 * 1024;

/**
 * How much survives a compaction. Keeping half (rather than truncating to
 * empty) means the newest history is always intact, and the rewrite happens
 * once per 64 KiB written rather than on every append past the cap.
 */
const COMPACT_KEEP_BYTES = DEVICE_AUDIT_MAX_BYTES / 2;

/**
 * Identical failures inside this window collapse to one line. An attacker
 * retrying a bad credential in a loop would otherwise turn every 401 into a
 * synchronous disk write; the throttle bounds that to one write per key per
 * window while still recording that the attempt is happening.
 */
export const AUTH_FAILURE_COALESCE_MS = 2_000;

export type DeviceAuditEvent = 'pair' | 'revoke' | 'auth-failure';

export interface DeviceAuditEntry {
  ts: number;
  event: DeviceAuditEvent;
  /** The device this concerns. Empty for a failed OPERATOR-token attempt. */
  deviceId: string;
  name?: string;
  reason?: string;
}

export function getDeviceAuditPath(wmuxDir: string): string {
  return path.join(wmuxDir, AUDIT_FILE);
}

export class DeviceAuditLog {
  private readonly filePath: string;
  /**
   * Bytes on disk, tracked in memory so the common append needs no `stat`.
   * Seeded once at construction; drift (a hand-deleted file) self-corrects at
   * the next compaction, which re-reads what is actually there.
   */
  private bytes = 0;
  private readonly lastFailureAt = new Map<string, number>();

  constructor(
    wmuxDir: string,
    private readonly now: () => number = Date.now,
    private readonly log?: (level: 'warn', msg: string) => void,
  ) {
    this.filePath = getDeviceAuditPath(wmuxDir);
    try {
      this.bytes = fs.statSync(this.filePath).size;
    } catch {
      this.bytes = 0; // no file yet — the first append creates it
    }
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Record one event. Best-effort and never throws: an audit line that cannot
   * be written must not fail the pairing or revocation it describes — the
   * operator-visible outcome of a revoke is decided by `devices.json`, not by
   * this file.
   *
   * Returns true when a line was written, so callers (and tests) can tell an
   * append apart from a coalesced duplicate.
   */
  append(entry: Omit<DeviceAuditEntry, 'ts'> & { ts?: number }): boolean {
    const ts = entry.ts ?? this.now();
    if (entry.event === 'auth-failure' && this.coalesce(entry.deviceId, entry.reason, ts)) {
      return false;
    }
    const line = `${JSON.stringify({ ts, ...stripUndefined(entry) })}\n`;
    // Bytes, not code units: an operator names a device in their own language,
    // and a `.length` budget would let a roster of non-ASCII names overshoot
    // the cap by up to 3x.
    const lineBytes = Buffer.byteLength(line, 'utf-8');
    try {
      if (this.bytes + lineBytes > DEVICE_AUDIT_MAX_BYTES) this.compact();
      // 0600 applies only when this call CREATES the file; an existing file
      // keeps its mode. Nothing sensitive is in here, so that is acceptable —
      // unlike devices.json, which is hardened on every write.
      fs.appendFileSync(this.filePath, line, { encoding: 'utf-8', mode: 0o600 });
      this.bytes += lineBytes;
      return true;
    } catch (err) {
      this.log?.('warn', `[web] device audit append failed: ${errMsg(err)}`);
      return false;
    }
  }

  /** Read the log back, newest last. Malformed lines are skipped, not thrown. */
  read(): DeviceAuditEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return [];
    }
    const out: DeviceAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as DeviceAuditEntry;
        if (parsed && typeof parsed.ts === 'number' && typeof parsed.event === 'string') {
          out.push(parsed);
        }
      } catch {
        // A torn tail from a killed process; the rest of the file is still good.
      }
    }
    return out;
  }

  /**
   * Drop the oldest half. Line-aligned: the retained tail starts at the first
   * newline inside the keep window, so compaction never leaves a truncated
   * record at the head of the file.
   */
  private compact(): void {
    try {
      // Byte-exact, via Buffer: slicing the decoded string at a byte offset
      // would cut in the wrong place for any non-ASCII name. Cutting the tail
      // at the first newline also discards whatever partial UTF-8 sequence the
      // byte-offset slice landed in the middle of.
      const buf = fs.readFileSync(this.filePath);
      const tail = buf.subarray(Math.max(0, buf.length - COMPACT_KEEP_BYTES));
      const firstBreak = tail.indexOf(0x0a);
      const kept = firstBreak >= 0 ? tail.subarray(firstBreak + 1) : Buffer.alloc(0);
      fs.writeFileSync(this.filePath, kept, { mode: 0o600 });
      this.bytes = kept.length;
    } catch (err) {
      this.log?.('warn', `[web] device audit compaction failed: ${errMsg(err)}`);
      // Leave `bytes` where it is; the next append retries the compaction.
    }
  }

  /** True when this failure is a repeat inside the coalescing window. */
  private coalesce(deviceId: string, reason: string | undefined, ts: number): boolean {
    const key = `${deviceId}|${reason ?? ''}`;
    const prev = this.lastFailureAt.get(key);
    if (prev !== undefined && ts - prev < AUTH_FAILURE_COALESCE_MS) return true;
    this.lastFailureAt.set(key, ts);
    // Bound the throttle map itself — an attacker rotating device ids must not
    // be able to grow it without limit.
    if (this.lastFailureAt.size > 256) {
      const oldest = this.lastFailureAt.keys().next();
      if (!oldest.done) this.lastFailureAt.delete(oldest.value);
    }
    return false;
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
