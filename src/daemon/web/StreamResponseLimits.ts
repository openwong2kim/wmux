import type { ServerResponse } from 'node:http';

/** Enough for the attention stream, pane viewers and parallel media downloads. */
export const MAX_STREAMS_PER_PRINCIPAL = 8;
export const STREAM_IDLE_MS = 60_000;
const MAX_QUEUED_BYTES = 1024 * 1024;

/** Shared admission and backpressure lifetime for media and SSE responses. */
export class StreamResponseLimits {
  private readonly active = new Map<string, number>();

  constructor(
    private readonly idleMs = STREAM_IDLE_MS,
    private readonly maxPerPrincipal = MAX_STREAMS_PER_PRINCIPAL,
  ) {}

  acquire(principalKey: string, res: ServerResponse): boolean {
    if (res.destroyed || res.writableEnded) return false;
    const count = this.active.get(principalKey) ?? 0;
    if (count >= this.maxPerPrincipal) return false;
    this.active.set(principalKey, count + 1);

    let released = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const originalWrite = res.write;
    const expire = (): void => { res.destroy(); };
    const clearBlocked = (): void => {
      if (blockedTimer) clearTimeout(blockedTimer);
      blockedTimer = undefined;
    };
    // A socket timeout alone can be postponed by repeated SSE writes into its
    // queue. Once backpressured, only drain counts as progress; more writes do
    // not restart this deadline. Bound the queue as well as its lifetime.
    const thisLimitsIdleMs = this.idleMs;
    res.write = function (this: ServerResponse, ...args: Parameters<ServerResponse['write']>): boolean {
      if (res.writableLength > MAX_QUEUED_BYTES) {
        expire();
        return false;
      }
      const ready = originalWrite.apply(this, args);
      if (!ready && !blockedTimer && !released) {
        blockedTimer = setTimeout(expire, thisLimitsIdleMs);
        blockedTimer.unref();
      }
      return ready;
    } as ServerResponse['write'];
    res.setTimeout(this.idleMs, expire);
    res.on('drain', clearBlocked);

    const release = (): void => {
      if (released) return;
      released = true;
      clearBlocked();
      res.write = originalWrite;
      res.off('drain', clearBlocked);
      res.off('timeout', expire);
      if (!res.destroyed) res.setTimeout(0);
      res.off('finish', release);
      res.off('close', release);
      const remaining = (this.active.get(principalKey) ?? 1) - 1;
      if (remaining > 0) this.active.set(principalKey, remaining);
      else this.active.delete(principalKey);
    };
    res.once('finish', release);
    res.once('close', release);
    return true;
  }
}
