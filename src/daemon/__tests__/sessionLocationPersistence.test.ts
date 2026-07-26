import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionLocation } from '../../shared/sessionLocation';
import type { DaemonState } from '../types';

const io = vi.hoisted(() => ({
  asyncWrite: vi.fn(),
  syncWrite: vi.fn(),
}));

vi.mock('../util/atomicWrite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../util/atomicWrite')>()),
  atomicWriteJSON: io.asyncWrite,
  atomicWriteJSONSync: io.syncWrite,
}));

import { StateWriter } from '../StateWriter';
import {
  SessionLocationTransaction,
  type SessionLocationDurability,
} from '../sessionLocationPersistence';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function location(cwd: string, distro?: string): SessionLocation {
  return {
    domain: 'wsl',
    cwd,
    shell: 'wsl.exe',
    ...(distro ? { distro } : {}),
  };
}

function state(value: SessionLocation, marker = 'accepted'): DaemonState {
  return {
    version: 1,
    sessions: [{
      id: 'wsl-1',
      state: 'detached',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:00.000Z',
      pid: 1,
      cmd: 'wsl.exe',
      cwd: value.cwd,
      location: value,
      env: { MARKER: marker },
      cols: 80,
      rows: 24,
      deadTtlHours: 24,
    }],
  };
}

function writtenLocation(call: unknown[]): SessionLocation {
  return (call[1] as DaemonState).sessions[0].location!;
}

function locationLabel(value: SessionLocation): string {
  return value.domain === 'wsl' && value.distro ? value.distro : value.cwd;
}

let tmpDir = '';
let writer: StateWriter;
let transaction: SessionLocationTransaction;
let accepted: SessionLocation;
let generation: number;
let marker: string;
let durableOrder: string[];
let commitOrder: string[];
let publishOrder: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-location-transaction-'));
  writer = new StateWriter(tmpDir);
  transaction = new SessionLocationTransaction(writer);
  accepted = location('/home/me/old');
  generation = 1;
  marker = 'accepted';
  durableOrder = [];
  commitOrder = [];
  publishOrder = [];
  io.asyncWrite.mockReset().mockImplementation(
    async (_file: string, payload: DaemonState) => {
      durableOrder.push(locationLabel(payload.sessions[0].location!));
    },
  );
  io.syncWrite.mockReset().mockImplementation(
    (_file: string, payload: DaemonState) => {
      durableOrder.push(locationLabel(payload.sessions[0].location!));
    },
  );
});

afterEach(() => {
  writer.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function submit(
  name: string,
  candidate: SessionLocation,
  durability: SessionLocationDurability,
  expectedGeneration = generation,
) {
  let preparedTransaction = 0;
  return transaction.submit({
    durability,
    prepare: (transactionId) => {
      if (generation !== expectedGeneration) return undefined;
      preparedTransaction = transactionId;
      return state(candidate, marker);
    },
    commit: (transactionId) => {
      if (
        generation !== expectedGeneration
        || transactionId !== preparedTransaction
      ) return undefined;
      accepted = candidate;
      commitOrder.push(name);
      return state(accepted, marker);
    },
    current: () => state(accepted, marker),
    publish: () => publishOrder.push(name),
  });
}

describe('SessionLocationTransaction', () => {
  it('commits and publishes once after a successful immediate write', async () => {
    await expect(submit(
      'enriched',
      location('/home/me/old', 'Ubuntu'),
      'immediate-retry',
    )).resolves.toBe('written');

    expect(io.syncWrite).toHaveBeenCalledOnce();
    expect(accepted).toHaveProperty('distro', 'Ubuntu');
    expect(commitOrder).toEqual(['enriched']);
    expect(publishOrder).toEqual(['enriched']);
  });

  it('retries an immediate candidate once and publishes only after retry success', async () => {
    io.syncWrite
      .mockImplementationOnce(() => { throw new Error('locked'); })
      .mockImplementationOnce((_file: string, payload: DaemonState) => {
        durableOrder.push(locationLabel(payload.sessions[0].location!));
      });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(submit(
      'enriched',
      location('/home/me/old', 'Ubuntu'),
      'immediate-retry',
    )).resolves.toBe('written');

    expect(io.syncWrite).toHaveBeenCalledTimes(2);
    expect(commitOrder).toEqual(['enriched']);
    expect(publishOrder).toEqual(['enriched']);
  });

  it('reports double failure without exposing the candidate or losing pending state', async () => {
    writer.saveDebounced(state(accepted, 'unrelated-newer'));
    io.syncWrite.mockImplementation(() => { throw new Error('locked'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(submit(
      'rejected',
      location('/home/me/old', 'Rejected'),
      'immediate-retry',
    )).resolves.toBe('failed');

    expect(accepted).not.toHaveProperty('distro');
    expect(commitOrder).toEqual([]);
    expect(publishOrder).toEqual([]);

    io.syncWrite.mockImplementation(() => undefined);
    writer.flushSync();
    const final = io.syncWrite.mock.calls.at(-1)![1] as DaemonState;
    expect(final.sessions[0].env).toEqual({ MARKER: 'unrelated-newer' });
    expect(final.sessions[0].location).not.toHaveProperty('distro');
  });

  it('surfaces an exact async write failure', async () => {
    io.asyncWrite.mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(submit(
      'cwd',
      location('/home/me/new'),
      'asap',
    )).resolves.toBe('failed');

    expect(accepted.cwd).toBe('/home/me/old');
    expect(commitOrder).toEqual([]);
    expect(publishOrder).toEqual([]);
  });

  it('restores accepted state when destroy and ID reuse fence an in-flight candidate', async () => {
    const pending = deferred();
    io.asyncWrite.mockImplementationOnce(() => pending.promise);
    const result = submit('stale-cwd', location('/home/me/stale'), 'asap', 1);
    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledOnce());

    generation = 2;
    accepted = location('/home/me/recreated');
    pending.resolve();

    await expect(result).resolves.toBe('superseded');
    expect(commitOrder).toEqual([]);
    expect(publishOrder).toEqual([]);
    expect(writtenLocation(io.syncWrite.mock.calls.at(-1)!))
      .toEqual(location('/home/me/recreated'));
  });

  it('restores retry success after an older async write completes', async () => {
    const oldWrite = deferred();
    io.asyncWrite.mockImplementationOnce(() => oldWrite.promise);
    void writer.saveAsap(state(accepted));
    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledOnce());

    await expect(submit(
      'enriched',
      location('/home/me/old', 'Ubuntu'),
      'immediate-retry',
    )).resolves.toBe('written');
    oldWrite.resolve();
    await vi.waitFor(() => expect(io.syncWrite.mock.calls.length).toBeGreaterThan(1));

    expect(writtenLocation(io.syncWrite.mock.calls.at(-1)!))
      .toHaveProperty('distro', 'Ubuntu');
    expect(publishOrder).toEqual(['enriched']);
  });

  it('accepts a newer candidate after a rejected candidate', async () => {
    io.syncWrite
      .mockImplementationOnce(() => { throw new Error('locked'); })
      .mockImplementationOnce(() => { throw new Error('locked'); })
      .mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(submit(
      'rejected',
      location('/home/me/old', 'Rejected'),
      'immediate-retry',
    )).resolves.toBe('failed');
    await expect(submit(
      'accepted',
      location('/home/me/old', 'Ubuntu'),
      'immediate-retry',
    )).resolves.toBe('written');

    expect(accepted).toHaveProperty('distro', 'Ubuntu');
    expect(commitOrder).toEqual(['accepted']);
    expect(publishOrder).toEqual(['accepted']);
  });

  it('rebases unrelated pending metadata over an exact async commit', async () => {
    const pending = deferred();
    io.asyncWrite.mockImplementationOnce(() => pending.promise);
    const result = submit('cwd', location('/home/me/new'), 'asap');
    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledOnce());

    marker = 'unrelated-newer';
    void writer.saveAsap(state(accepted, marker));
    pending.resolve();

    await expect(result).resolves.toBe('written');
    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledTimes(2));
    const final = io.asyncWrite.mock.calls.at(-1)![1] as DaemonState;
    expect(final.sessions[0].env).toEqual({ MARKER: 'unrelated-newer' });
    expect(final.sessions[0].cwd).toBe('/home/me/new');
  });

  it('preserves durable, commit, and publication order across cwd and enrichment', async () => {
    const cwd = submit('cwd', location('/home/me/new'), 'asap');
    const enriched = submit(
      'enriched',
      location('/home/me/new', 'Ubuntu'),
      'immediate-retry',
    );

    await expect(Promise.all([cwd, enriched]))
      .resolves.toEqual(['written', 'written']);

    expect(durableOrder).toEqual(['/home/me/new', 'Ubuntu']);
    expect(commitOrder).toEqual(['cwd', 'enriched']);
    expect(publishOrder).toEqual(['cwd', 'enriched']);
  });

  it('commits a queued exact write synchronously during flushSync', async () => {
    const candidate = location('/home/me/new');
    let committed = false;
    const result = writer.writeExactAsap({
      prepare: () => state(candidate),
      commit: () => {
        accepted = candidate;
        committed = true;
        return state(accepted);
      },
      current: () => state(accepted),
    });

    writer.flushSync();

    await expect(result).resolves.toBe('written');
    expect(committed).toBe(true);
    expect(io.asyncWrite).not.toHaveBeenCalled();
    expect(writtenLocation(io.syncWrite.mock.calls.at(-1)!)).toEqual(candidate);
  });

  it('flush waits for two producer-ordered requests', async () => {
    const cwd = submit('cwd', location('/home/me/new'), 'asap');
    const enriched = submit(
      'enriched',
      location('/home/me/new', 'Ubuntu'),
      'immediate-retry',
    );

    await transaction.flush();

    await expect(Promise.all([cwd, enriched]))
      .resolves.toEqual(['written', 'written']);
    expect(commitOrder).toEqual(['cwd', 'enriched']);
    expect(publishOrder).toEqual(['cwd', 'enriched']);
  });

  it('flushSync drains running I/O and every later coordinator request', async () => {
    const pending = deferred();
    io.asyncWrite.mockImplementationOnce(() => pending.promise);
    const cwd = submit('cwd', location('/home/me/new'), 'asap');
    const enriched = submit(
      'enriched',
      location('/home/me/new', 'Ubuntu'),
      'immediate-retry',
    );
    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledOnce());

    transaction.flushSync();

    await expect(Promise.all([cwd, enriched]))
      .resolves.toEqual(['written', 'written']);
    expect(commitOrder).toEqual(['cwd', 'enriched']);
    expect(publishOrder).toEqual(['cwd', 'enriched']);

    pending.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writtenLocation(io.syncWrite.mock.calls.at(-1)!))
      .toHaveProperty('distro', 'Ubuntu');
  });

  it('does not retry a commit that throws after a successful write', () => {
    const candidate = location('/home/me/new');
    const commit = vi.fn(() => {
      accepted = candidate;
      throw new Error('commit failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = writer.writeExactImmediate({
      prepare: () => state(candidate),
      commit,
      current: () => state(accepted),
    }, 2);

    expect(outcome).toBe('failed');
    expect(io.syncWrite).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
    expect(writtenLocation(io.syncWrite.mock.calls.at(-1)!)).toEqual(candidate);
  });
});
