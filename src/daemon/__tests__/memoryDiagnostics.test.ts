import { describe, expect, it, vi } from 'vitest';
import { collectDaemonMemoryDiagnostics } from '../memoryDiagnostics';
import { RingBuffer } from '../RingBuffer';
import { SessionPipe } from '../SessionPipe';
import type { ManagedSession } from '../DaemonSessionManager';
import { isDaemonMemoryDiagnostics } from '../../shared/memoryDiagnostics';

describe('daemon memory diagnostics', () => {
  it('observes a backed-up socket without suppressing writes, and preserves its peak after drain', () => {
    const pipe = new SessionPipe('slow', new RingBuffer(1024), 'test');
    const socket = { destroyed: false, writableLength: 0, write: vi.fn((data: Buffer) => {
      socket.writableLength += data.length;
      return false;
    }) };
    Object.assign(pipe, { client: socket, flushed: true });
    const chunk = Buffer.from('output 한글');
    pipe.writeToClient(chunk);
    pipe.writeToClient(chunk);
    expect(socket.write).toHaveBeenCalledTimes(2);
    expect(pipe.getMemoryDiagnostics()).toMatchObject({
      socketQueuedBytes: chunk.length * 2, socketPeakQueuedBytes: chunk.length * 2,
    });
    socket.writableLength = 0;
    expect(pipe.getMemoryDiagnostics()).toMatchObject({ socketQueuedBytes: 0, socketPeakQueuedBytes: chunk.length * 2 });
  });

  it('reads buffer allocation without copying history, including sessions without an attached pipe', () => {
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.write(Buffer.alloc(100_000));
    const read = vi.spyOn(ring, 'readAll').mockImplementation(() => { throw new Error('diagnostics must not copy'); });
    const pipe = new SessionPipe('s1', ring, 'test');
    const sessions = [
      { meta: { id: 's1', state: 'attached' }, ringBuffer: ring },
      { meta: { id: 's2', state: 'dead' }, ringBuffer: new RingBuffer(1024) },
    ] as ManagedSession[];
    const result = collectDaemonMemoryDiagnostics(sessions, new Map([['s1', pipe]]));
    expect(isDaemonMemoryDiagnostics(result)).toBe(true);
    expect(result.sessions[0]).toMatchObject({ ringStoredBytes: 100_000, ringAllocatedBytes: 131_072, ringCapacityBytes: 8 * 1024 * 1024 });
    expect(result.sessions[1]).toMatchObject({ state: 'dead', socketQueuedBytes: 0, socketPeakQueuedBytes: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(result.pid).toBe(process.pid);
    expect(result.sessions[0].ringLifetimeBytes).toBe(100_000);
    expect(result.snapshotQueue).toEqual(expect.objectContaining({ jobs: expect.any(Number), waitMsMax: expect.any(Number) }));
    expect(result.screenParses).toEqual(expect.any(Object));
    expect(result.eventLoop!.activeMs + result.eventLoop!.idleMs).toBeGreaterThan(0);
    for (const backend of [result.snapshots!.ansi, result.snapshots!.text]) {
      expect(backend).toEqual({ native: expect.any(Number), fallbacks: expect.any(Number), skipped: expect.any(Number),
        circuitOpen: expect.any(Boolean), reasons: expect.any(Object) });
    }
  });
});
