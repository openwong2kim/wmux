import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_QUEUED_BYTES, StreamResponseLimits } from '../StreamResponseLimits';

function response() {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, writableLength: 0,
    write: vi.fn(function (this: { writableLength: number }, chunk: Uint8Array | string, _callback?: () => void) {
      this.writableLength += Buffer.byteLength(chunk);
      return false;
    }),
    end: vi.fn((_chunk?: unknown) => undefined), writeHead: vi.fn((_status?: number) => undefined), setTimeout: vi.fn(),
    destroy: vi.fn(function (this: { destroyed: boolean; emit: (event: string) => boolean }) { this.destroyed = true; this.emit('close'); }),
  });
  return res;
}
afterEach(() => vi.useRealTimers());

it('bounds writers ignoring backpressure and final chunks, before enqueueing excess bytes', () => {
  const limits = new StreamResponseLimits();
  const res = response();
  expect(limits.acquire('device', res as unknown as ServerResponse)).toBe(true);
  for (let i = 0; i < 16; i++) res.write(Buffer.alloc(64 * 1024));
  expect(res.writableLength).toBe(MAX_QUEUED_BYTES);
  res.write('overflow');
  expect(res.destroyed).toBe(true);
  expect(res.writableLength).toBe(MAX_QUEUED_BYTES);
  const final = response();
  limits.acquire('device', final as unknown as ServerResponse);
  final.end(Buffer.alloc(MAX_QUEUED_BYTES + 1));
  expect(final.destroyed).toBe(true);
});

it('starts on output and expires a small stalled write even when write returns true', () => {
  vi.useFakeTimers();
  const res = response();
  res.write.mockImplementation(() => true); // accepted, but completion never arrives
  const limits = new StreamResponseLimits(60);
  limits.acquire('device', res as unknown as ServerResponse);
  vi.advanceTimersByTime(1000);
  expect(res.setTimeout).not.toHaveBeenCalled();
  expect(res.destroyed).toBe(false);
  res.writeHead(200);
  for (let i = 0; i < 3; i++) { res.write(': ping\n\n'); vi.advanceTimersByTime(20); }
  expect(res.destroyed).toBe(true);
});

it('keeps healthy SSE alive for ten minutes without requiring drain events', () => {
  vi.useFakeTimers();
  const res = response();
  res.write.mockImplementation((_chunk, callback) => { callback?.(); return true; });
  new StreamResponseLimits().acquire('device', res as unknown as ServerResponse);
  res.writeHead(200);
  const callback = vi.fn();
  for (let i = 0; i < 24; i++) {
    res.write(': ping\n\n', callback);
    vi.advanceTimersByTime(25_000);
  }
  expect(callback).toHaveBeenCalledTimes(24);
  expect(res.destroyed).toBe(false);
  res.destroy();
  expect(vi.getTimerCount()).toBe(0);
});
