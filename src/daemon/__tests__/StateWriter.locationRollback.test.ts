import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function state(distro?: string): DaemonState {
  return {
    version: 1,
    sessions: [{
      id: 'wsl-1',
      state: 'detached',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:00.000Z',
      pid: 1,
      cmd: 'wsl.exe',
      cwd: '/home/me',
      location: {
        domain: 'wsl',
        cwd: '/home/me',
        shell: 'wsl.exe',
        ...(distro ? { distro } : {}),
      },
      env: {},
      cols: 80,
      rows: 24,
      deadTtlHours: 24,
    }],
  };
}

let tmpDir = '';
let writer: StateWriter | null = null;

afterEach(() => {
  writer?.dispose();
  writer = null;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
  io.asyncWrite.mockReset();
  io.syncWrite.mockReset();
  vi.restoreAllMocks();
});

describe('StateWriter exact location recovery', () => {
  it('keeps the previous accepted state after two failed exact writes and older async completion', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-location-rollback-'));
    writer = new StateWriter(tmpDir);
    let finishAsync!: () => void;
    io.asyncWrite.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishAsync = resolve; }),
    ).mockResolvedValue(undefined);
    io.syncWrite.mockImplementation(() => { throw new Error('locked'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    void writer.saveAsap(state());
    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledOnce());
    const outcome = writer.writeExactImmediate({
      prepare: () => state('Ubuntu'),
      commit: () => state('Ubuntu'),
      current: () => state(),
    }, 2);

    expect(outcome).toBe('failed');
    finishAsync();
    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledOnce());
    expect(io.syncWrite).toHaveBeenCalledTimes(2);
    for (const call of io.syncWrite.mock.calls) {
      expect((call[1] as DaemonState).sessions[0].location)
        .toHaveProperty('distro', 'Ubuntu');
    }
  });
});
