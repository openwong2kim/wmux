// A company seat's first-run env reaches its agent through the typed launch
// line only: the pane's shell is spawned without it, so a later `claude` typed
// into the same shell starts without it.
import { describe, it, expect, vi } from 'vitest';

const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home', on: () => undefined },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { captured.set(channel, fn); },
    removeHandler: (channel: string) => { captured.delete(channel); },
    on: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {},
}));
vi.mock('../../../screenReaderService', () => ({ isScreenReaderOn: () => false, launcherVersionsIn: () => () => '2.1.316' }));

import { registerPTYHandlers } from '../pty.handler';
import { IPC } from '../../../../shared/constants';
import type { PTYManager } from '../../../pty/PTYManager';
import type { PTYBridge } from '../../../pty/PTYBridge';

/** A local create in `shell`: the env its pty is spawned with, and the line typed. */
async function createIn(shell: string, initialCommand: string): Promise<{ spawnEnv: unknown; typed: string }> {
  const written: string[] = [];
  const onData: Array<() => void> = [];
  let spawnEnv: unknown;
  const ptyManager = {
    createAsync: async (opts: { env?: unknown }) => {
      spawnEnv = opts.env;
      return {
        id: 'pty-s', cwd: '/tmp', shell,
        process: { onData: (fn: () => void) => { onData.push(fn); return { dispose: () => undefined }; } },
      };
    },
    write: (_id: string, data: string) => { written.push(data); },
  } as unknown as PTYManager;
  const dispose = registerPTYHandlers(ptyManager, { setupDataForwarding: () => undefined } as unknown as PTYBridge);
  try {
    const create = captured.get(IPC.PTY_CREATE);
    if (!create) throw new Error('pty:create not registered');
    await create({}, { initialCommand, shell, launchEnv: { CLAUDE_CODE_SANDBOXED: '1' }, ignoreAccountBinding: true });
    for (const fn of onData) fn();
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0), { timeout: 5_000 });
    return { spawnEnv, typed: written[0] };
  } finally {
    dispose();
  }
}

describe('pty:create launch env', () => {
  it.each([
    ['/bin/zsh', /^CLAUDE_CODE_SANDBOXED=1 claude --session-id [0-9a-f-]{36}\r$/],
    ['pwsh.exe', /^try \{ \$env:CLAUDE_CODE_SANDBOXED='1'; claude --session-id [0-9a-f-]{36} \} finally \{ Remove-Item Env:CLAUDE_CODE_SANDBOXED -ErrorAction SilentlyContinue \}\r$/],
    ['cmd.exe', /^cmd \/c set CLAUDE_CODE_SANDBOXED=1\^&\^& claude --session-id [0-9a-f-]{36}\r$/],
  ])('%s: the launch line carries it and the shell is spawned without it', async (shell, line) => {
    const { spawnEnv, typed } = await createIn(shell, 'claude');
    expect(typed).toMatch(line);
    expect(spawnEnv ?? {}).not.toHaveProperty('CLAUDE_CODE_SANDBOXED');
  });
});
