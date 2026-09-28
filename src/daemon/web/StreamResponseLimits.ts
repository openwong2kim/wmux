import type { ServerResponse } from 'node:http';

/** Device budgets are shared across pane viewers, events and media transfers. */
export const MAX_STREAMS_PER_PRINCIPAL = 8;
export const STREAM_IDLE_MS = 60_000;
export const MAX_QUEUED_BYTES = 1024 * 1024;

/** Admission and output-progress limits; healthy long-lived SSE has no age cap. */
export class StreamResponseLimits {
  private readonly active = new Map<string, number>();

  constructor(
    private readonly idleMs = STREAM_IDLE_MS,
    private readonly maxPerPrincipal = MAX_STREAMS_PER_PRINCIPAL,
  ) {}

  acquire(principalKey: string, res: ServerResponse, options: {
    exemptCeiling?: boolean; maxQueuedBytes?: number;
    log?: (reason: string) => void;
  } = {}): boolean {
    if (res.destroyed || res.writableEnded) return false;
    const count = this.active.get(principalKey) ?? 0;
    if (!options.exemptCeiling && count >= this.maxPerPrincipal) return false;
    this.active.set(principalKey, count + 1);

    const originalWrite = res.write;
    const originalEnd = res.end;
    const originalWriteHead = res.writeHead;
    const cap = options.maxQueuedBytes ?? MAX_QUEUED_BYTES;
    let released = false;
    let started = false;
    let pendingWrites = 0;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    const expire = (reason: string): void => { options.log?.(reason); res.destroy(); };
    const timeout = (): void => expire('idle response');
    const clearProgress = (): void => {
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = undefined;
    };
    const armProgress = (): void => {
      clearProgress();
      progressTimer = setTimeout(() => expire('response write made no progress'), this.idleMs);
      progressTimer.unref();
    };
    const start = (): void => {
      if (started) return;
      started = true;
      res.setTimeout(this.idleMs, timeout);
      res.socket?.setKeepAlive(true, this.idleMs);
    };
    const fits = (chunk: unknown): boolean => {
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk instanceof Uint8Array ? chunk.byteLength : 0);
      if (res.writableLength + bytes <= cap) return true;
      expire('response queue limit exceeded');
      return false;
    };
    // write(true) only means the high-water mark was not reached. Watch its
    // completion callback too: a small stalled heartbeat need never emit drain.
    // Completion means handed to the OS, not consumed by the client. TCP handles
    // peer liveness; the device ceiling bounds idle SSE's server-side resources.
    const trackWrite = (): (() => void) => {
      if (++pendingWrites === 1) armProgress();
      let completed = false;
      return () => {
        if (completed || released) return;
        completed = true;
        pendingWrites--;
        if (pendingWrites) armProgress();
        else clearProgress();
      };
    };
    res.write = function (this: ServerResponse, ...args: Parameters<ServerResponse['write']>): boolean {
      start();
      if (!fits(args[0])) return false;
      const done = trackWrite();
      const callback = typeof args[args.length - 1] === 'function' ? args.pop() as (error?: Error | null) => void : undefined;
      while (args.length && args[args.length - 1] === undefined) args.pop();
      args.push((error?: Error | null) => { done(); callback?.(error); });
      try { return originalWrite.apply(this, args); }
      catch (error) { done(); throw error; }
    } as ServerResponse['write'];
    res.writeHead = function (this: ServerResponse, ...args: Parameters<ServerResponse['writeHead']>) {
      start();
      return originalWriteHead.apply(this, args);
    } as ServerResponse['writeHead'];
    res.end = function (this: ServerResponse, ...args: Parameters<ServerResponse['end']>) {
      start();
      if (!fits(args[0])) return this;
      const done = trackWrite();
      const callback = typeof args[args.length - 1] === 'function' ? args.pop() as () => void : undefined;
      while (args.length && args[args.length - 1] === undefined) args.pop();
      args.push(() => { done(); callback?.(); });
      try { return originalEnd.apply(this, args); }
      catch (error) { done(); throw error; }
    } as ServerResponse['end'];

    const release = (): void => {
      if (released) return;
      released = true;
      clearProgress();
      res.write = originalWrite;
      res.end = originalEnd;
      res.writeHead = originalWriteHead;
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
