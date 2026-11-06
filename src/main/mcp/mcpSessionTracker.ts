import { MCP_SESSION_ID_RE } from '../../shared/mcpSessions';

/** A bundle session counts as live this long after its last request. */
export const MCP_SESSION_TTL_MS = 10 * 60_000;
/** Distinct sessions kept at most; the report says "at least" past it. */
export const MCP_SESSION_CAP = 256;

/**
 * Single-child MCP servers seen recently, by the `mcpSession` id on their
 * envelopes. Measurement for `wmux doctor` only: nothing routes or permits on
 * it. Bounded so a caller inventing ids cannot grow it.
 */
export class McpSessionTracker {
  /** id → last seen. Map order is least recently seen first. */
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cap: number;

  constructor(opts: { now?: () => number; ttlMs?: number; cap?: number } = {}) {
    // Monotonic: a wall clock set ahead would expire every session at once.
    this.now = opts.now ?? (() => performance.now());
    this.ttlMs = opts.ttlMs ?? MCP_SESSION_TTL_MS;
    this.cap = opts.cap ?? MCP_SESSION_CAP;
  }

  touch(id: unknown): void {
    if (typeof id !== 'string' || !MCP_SESSION_ID_RE.test(id)) return;
    this.seen.delete(id);
    this.seen.set(id, this.now());
    while (this.seen.size > this.cap) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
    }
  }

  has(id: string): boolean {
    this.prune();
    return this.seen.has(id);
  }

  summary(): { recent: number; capped: boolean; ttlS: number } {
    this.prune();
    return { recent: this.seen.size, capped: this.seen.size >= this.cap, ttlS: Math.round(this.ttlMs / 1000) };
  }

  /** A full pass: touch order is not time order once a clock steps back. */
  private prune(): void {
    const now = this.now();
    for (const [id, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(id);
    }
  }
}
