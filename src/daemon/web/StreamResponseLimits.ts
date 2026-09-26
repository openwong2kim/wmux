import type { ServerResponse } from 'node:http';

/** Enough for the attention stream, pane viewers and parallel media downloads. */
export const MAX_STREAMS_PER_PRINCIPAL = 8;
export const STREAM_IDLE_MS = 60_000;
export const MAX_QUEUED_BYTES = 1024 * 1024;

/** Shared admission and backpressure lifetime for media and SSE responses. */
export class StreamResponseLimits {
  private readonly active = new Map<string, number>();

  constructor(
    private readonly idleMs = STREAM_IDLE_MS,
    private readonly maxPerPrincipal = MAX_STREAMS_PER_PRINCIPAL,
  ) {}

  acquire(principalKey: string, res: ServerResponse, options: {
    exemptCeiling?: boolean; sse?: boolean; maxQueuedBytes?: number;
    noDrainMs?: number; log?: (reason: string) => void;
  } = {}): boolean {
    if (res.destroyed || res.writableEnded) return false;
    const count = this.active.get(principalKey) ?? 0;
    if (!options.exemptCeiling && count >= this.maxPerPrincipal) return false;
    this.active.set(principalKey, count + 1);

    let released = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const originalWrite = res.write;
    const originalEnd = res.end;
    const originalWriteHead = res.writeHead;
    let started = false;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = options.maxQueuedBytes ?? MAX_QUEUED_BYTES;
    const expire = (reason = 'idle response'): void => { options.log?.(reason); res.destroy(); };
    const timeout = (): void => expire();
    const progress = (): void => {
      if (progressTimer) clearTimeout(progressTimer);
      if (options.sse && !released) {
        progressTimer = setTimeout(() => expire('SSE no drain progress; rotate connection'), options.noDrainMs ?? 300_000);
        progressTimer.unref();
      }
    };
    const start = (): void => {
      if (started) return;
      started = true;
      res.setTimeout(this.idleMs, timeout);
      progress();
    };
    const fits = (chunk: unknown): boolean => {
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk instanceof Uint8Array ? chunk.byteLength : 0);
      if (res.writableLength + bytes <= cap) return true;
      expire('response queue limit exceeded');
      return false;
    };
    const clearBlocked = (): void => {
      if (blockedTimer) clearTimeout(blockedTimer);
      blockedTimer = undefined;
    };
    // A socket timeout alone can be postponed by repeated SSE writes into its
    // queue. Once backpressured, only drain counts as progress; more writes do
    // not restart this deadline. Bound the queue as well as its lifetime.
    const thisLimitsIdleMs = this.idleMs;
    res.write = function (this: ServerResponse, ...args: Parameters<ServerResponse['write']>): boolean {
      start();
      if (!fits(args[0])) return false;
      const ready = originalWrite.apply(this, args);
      if (!ready && !blockedTimer && !released) {
        blockedTimer = setTimeout(() => expire('blocked response'), thisLimitsIdleMs);
        blockedTimer.unref();
      }
      return ready;
    } as ServerResponse['write'];
    res.writeHead = function (this: ServerResponse, ...args: Parameters<ServerResponse['writeHead']>) {
      start();
      return originalWriteHead.apply(this, args);
    } as ServerResponse['writeHead'];
    res.end = function (this: ServerResponse, ...args: Parameters<ServerResponse['end']>) {
      start();
      if (!fits(args[0])) return this;
      return originalEnd.apply(this, args);
    } as ServerResponse['end'];
    res.on('drain', clearBlocked);
    res.on('drain', progress);

    const release = (): void => {
      if (released) return;
      released = true;
      clearBlocked();
      res.write = originalWrite;
      res.end = originalEnd;
      res.writeHead = originalWriteHead;
      if (progressTimer) clearTimeout(progressTimer);
      res.off('drain', progress);
      res.off('drain', clearBlocked);
      res.off('timeout', timeout);
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
