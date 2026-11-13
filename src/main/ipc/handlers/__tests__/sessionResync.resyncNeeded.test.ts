// main's answer to a daemon session pipe that fell behind: the renderer is told
// first (after the batched output), the re-flush runs once, a request repeated
// while one runs joins it, and a failure is reported back to the renderer.

import { describe, it, expect } from 'vitest';
import { createResyncNeededHandler, createSessionResync, type SessionResyncClient } from '../sessionResync';

function harness(rpc: (method: string) => Promise<unknown>) {
  const steps: string[] = [];
  const client: SessionResyncClient = {
    isSessionPipeWritable: () => true,
    armSessionResync: () => { steps.push('arm'); return true; },
    disarmSessionResync: () => { steps.push('disarm'); },
    rpc: (async (method: string) => { steps.push(`rpc:${method}`); return rpc(method); }) as SessionResyncClient['rpc'],
  };
  const resync = createSessionResync(client);
  const handle = createResyncNeededHandler({
    resync: () => resync,
    flushBatch: (id) => steps.push(`flush:${id}`),
    notify: (notice, id, code) => steps.push(`${notice}:${id}${code ? `:${code}` : ''}`),
  });
  return { steps, resync, handle };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createResyncNeededHandler', () => {
  it('flushes the batch and tells the renderer before it starts the re-flush', async () => {
    const { steps, handle } = harness(async () => ({ mode: 'snapshot' }));
    handle('s1');
    await settle();
    expect(steps).toEqual(['flush:s1', 'starting:s1', 'arm', 'rpc:daemon.resyncSession']);
  });

  it('leaves a re-flush in flight alone, and asks again once it is over', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { steps, resync, handle } = harness(() => new Promise((r) => { release = r; }));
    handle('s1');
    // The daemon repeats its request while the re-flush runs (or the renderer's own is in flight).
    handle('s1');
    await settle();
    expect(steps.filter((s) => s === 'rpc:daemon.resyncSession')).toHaveLength(1);
    expect(steps.filter((s) => s === 'starting:s1')).toHaveLength(1);
    release({ mode: 'snapshot' });
    await settle();
    expect(resync.inFlight('s1')).toBe(false);
    // A request after that one (the pipe fell behind again, or the first was lost) runs again.
    handle('s1');
    await settle();
    expect(steps.filter((s) => s === 'rpc:daemon.resyncSession')).toHaveLength(2);
  });

  it('a request repeated while the renderer\'s own re-flush is in flight joins it', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { steps, resync, handle } = harness(() => new Promise((r) => { release = r; }));
    const own = resync('s1');
    handle('s1');
    await settle();
    expect(steps).toEqual(['arm', 'rpc:daemon.resyncSession']);
    release({ mode: 'snapshot' });
    await expect(own).resolves.toEqual({ success: true, mode: 'snapshot' });
  });

  it('tells the renderer when the re-flush fails', async () => {
    const { steps, handle } = harness(async () => { throw new Error('NO_PIPE: gone'); });
    handle('s1');
    await settle();
    await settle();
    expect(steps).toContain('failed:s1:rpc-error');
    expect(steps.indexOf('failed:s1:rpc-error')).toBeGreaterThan(steps.indexOf('starting:s1'));
  });
});
