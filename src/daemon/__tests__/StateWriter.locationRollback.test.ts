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
});

describe('StateWriter rejected location recovery', () => {
  it('restores the rolled-back state after an older async write completes', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-location-rollback-'));
    writer = new StateWriter(tmpDir);
    let finishAsync!: () => void;
    io.asyncWrite.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishAsync = resolve; }),
    ).mockResolvedValue(undefined);
    io.syncWrite
      .mockImplementationOnce(() => { throw new Error('locked'); })
      .mockImplementationOnce(() => { throw new Error('locked'); })
      .mockImplementation(() => undefined);

    void writer.saveAsap(state());
    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledOnce());
    expect(writer.saveImmediate(state('Ubuntu'))).toBe(false);
    expect(writer.saveImmediate(state('Ubuntu'))).toBe(false);

    writer.recoverRejectedImmediateState(state());
    finishAsync();
    await writer.flush();

    const recoveredPayloads = io.syncWrite.mock.calls
      .slice(2)
      .map((call) => call[1] as DaemonState);
    expect(recoveredPayloads.length).toBeGreaterThan(0);
    for (const recovered of recoveredPayloads) {
      expect(recovered.sessions[0].location).not.toHaveProperty('distro');
    }
  });
});
