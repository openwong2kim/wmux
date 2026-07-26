/**
 * toolbar.handler — `git:status` takes a pane location, not a raw cwd.
 *
 * Issue #21 AC 1: every production consumer of a pane cwd resolves it through
 * the shared session-location API. This channel is invoked from the toolbar's
 * FileExplorerPopover with the pane's cwd, so a Git Bash pane used to send
 * `/c/...` and silently get an empty status.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

const execFile = vi.fn(
  (_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) =>
    cb(null, ' M src/index.ts\n', ''),
);

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], opts: unknown, cb: ExecFileCallback) =>
    execFile(file, args, opts, cb),
}));

import { IPC } from '../../../../shared/constants';
import { registerToolbarHandlers } from '../toolbar.handler';

const fakeEvent = {} as Electron.IpcMainInvokeEvent;
const canonical = path.join('C:', 'dev', 'proj');

function gitStatus(): (...args: unknown[]) => unknown {
  const fn = handlers.get(IPC.GIT_STATUS);
  if (!fn) throw new Error('git:status handler is not registered');
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
  handlers.clear();
  execFile.mockClear();
  vi.spyOn(os, 'homedir').mockReturnValue(path.join('C:', 'Users', 'tester'));
  vi.spyOn(fs.promises, 'realpath').mockResolvedValue(canonical as never);
  registerToolbarHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('git:status — pane location', () => {
  it('runs git in the host path converted from an MSYS location', async () => {
    await expect(gitStatus()(fakeEvent, {
      domain: 'msys',
      cwd: '/c/dev/proj',
      shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
    })).resolves.toBe(' M src/index.ts\n');

    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['-C', canonical, 'status', '--porcelain'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('still accepts a bare host cwd from the toolbar', async () => {
    await expect(gitStatus()(fakeEvent, canonical)).resolves.toBe(' M src/index.ts\n');
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['-C', canonical, 'status', '--porcelain'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('returns empty for a malformed payload', async () => {
    await expect(gitStatus()(fakeEvent, { domain: 'nope', cwd: '/x', shell: '' })).resolves.toBe('');
    expect(execFile).not.toHaveBeenCalled();
  });
});
