/**
 * projectConfig.handler — the renderer-facing wire boundary for `project:config:get`.
 *
 * Issue #21: this handler used to re-declare the SessionLocation contract and
 * reject `domain: 'msys'`, so a Git Bash pane never reached ProjectConfigStore
 * and the project-config surface stayed empty.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPC } from '../../../../shared/constants';

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
}));

const getState = vi.fn(async () => ({ found: true as const }));

vi.mock('../../../project/ProjectConfigStore', () => ({
  getProjectConfigStore: () => ({ getState }),
}));

import { registerProjectConfigHandlers } from '../projectConfig.handler';

const fakeEvent = {} as Electron.IpcMainInvokeEvent;

function get(): (...args: unknown[]) => unknown {
  const fn = handlers.get(IPC.PROJECT_CONFIG_GET);
  if (!fn) throw new Error('project config get handler is not registered');
  return fn;
}

beforeEach(() => {
  handlers.clear();
  getState.mockClear();
  registerProjectConfigHandlers();
});

describe('project:config:get — location wire contract', () => {
  it('forwards an MSYS (Git Bash) location to the store', async () => {
    const location = {
      domain: 'msys',
      cwd: '/c/dev/proj',
      shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
    };

    await expect(get()(fakeEvent, { location })).resolves.toEqual({ found: true });
    expect(getState).toHaveBeenCalledWith(location);
  });

  it('forwards a bare cwd as a host location', async () => {
    await expect(get()(fakeEvent, 'C:\\dev\\proj')).resolves.toEqual({ found: true });
    expect(getState).toHaveBeenCalledWith({ domain: 'host', cwd: 'C:\\dev\\proj', shell: '' });
  });

  it('rejects a malformed payload without reaching the store', async () => {
    await expect(get()(fakeEvent, { location: { domain: 'nope', cwd: '/x', shell: '' } }))
      .resolves.toEqual({ found: false });
    expect(getState).not.toHaveBeenCalled();
  });
});
