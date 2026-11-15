// A create whose cwd is a WSL share folder spawns a WSL shell at the Linux
// path in that distro, on both the local and the daemon path; an unknown
// distro falls back to the default WSL shell's home with one toast per workspace.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const captured = new Map<string, (...args: unknown[]) => unknown>();
const notify = vi.fn();
let distros: string[] = [];
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
vi.mock('../../../notification/dispatchNotification', () => ({ dispatchNotification: (...a: unknown[]) => notify(...a) }));
vi.mock('../../../pty/defaultWslDistro', () => ({
  getDefaultWslDistro: () => null,
  enumerateWslDistros: async () => distros,
}));

import { registerPTYHandlers } from '../pty.handler';
import { IPC } from '../../../../shared/constants';
import type { PTYManager } from '../../../pty/PTYManager';
import type { PTYBridge } from '../../../pty/PTYBridge';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => { vi.spyOn(path, 'basename').mockImplementation(path.win32.basename); Object.defineProperty(process, 'platform', { value: 'win32' }); notify.mockClear(); distros = []; });
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, 'platform', realPlatform); });

async function create(opts: Record<string, unknown>[]): Promise<Array<{ shell?: string; cwd?: string; shellArgs?: string[] }>> {
  const spawned: Array<{ shell?: string; cwd?: string; shellArgs?: string[] }> = [];
  const ptyManager = {
    createAsync: async (o: { shell?: string; cwd?: string; shellArgs?: string[] }) => {
      spawned.push({ shell: o.shell, cwd: o.cwd, shellArgs: o.shellArgs });
      return { id: `p${spawned.length}`, cwd: o.cwd, shell: o.shell, process: { onData: () => ({ dispose: () => undefined }) } };
    },
    write: () => undefined,
  } as unknown as PTYManager;
  const dispose = registerPTYHandlers(ptyManager, { setupDataForwarding: () => undefined } as unknown as PTYBridge);
  try {
    const fn = captured.get(IPC.PTY_CREATE)!;
    for (const o of opts) await fn({}, { ignoreAccountBinding: true, ...o });
    return spawned;
  } finally { dispose(); }
}

const share = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

describe('pty:create with a WSL share cwd', () => {
  it('spawns a WSL shell in that distro at the Linux cwd', async () => {
    distros = ['Ubuntu'];
    const [s] = await create([{ cwd: share, workspaceId: 'w1' }]);
    expect(s.shell).toMatch(/wsl\.exe$/i);
    expect(s.cwd).toBe('/home/me/repo');
    expect(s.shellArgs).toEqual(['-d', 'Ubuntu']);
    expect(notify).not.toHaveBeenCalled();
  });

  it('an unknown distro opens the default WSL shell at home (no Windows home) and toasts once per workspace', async () => {
    distros = ['Debian'];
    const spawned = await create([{ cwd: share, workspaceId: 'w-once' }, { cwd: share, workspaceId: 'w-once' }]);
    expect(spawned).toHaveLength(2);
    for (const s of spawned) {
      expect(s.shell).toMatch(/wsl\.exe$/i);
      expect(s.cwd === undefined || s.cwd === '~').toBe(true);
      expect(s.shellArgs).toBeUndefined();
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(notify.mock.calls[0])).toContain('Ubuntu');
  });

  it('the daemon create forwards the rewritten shell, args and cwd', async () => {
    distros = ['Ubuntu'];
    const params: Array<Record<string, unknown>> = [];
    const daemonClient = {
      isConnected: true,
      on: () => undefined,
      off: () => undefined,
      removeListener: () => undefined,
      connectSessionPipe: async () => undefined,
      rpc: async (method: string, p: Record<string, unknown>) => {
        if (method === 'daemon.createSession') { params.push(p); return { cwd: p.cwd }; }
        return [];
      },
    };
    const dispose = registerPTYHandlers(
      {} as unknown as PTYManager,
      { setupDataForwarding: () => undefined } as unknown as PTYBridge,
      daemonClient as never,
    );
    try {
      await captured.get(IPC.PTY_CREATE)!({}, { cwd: share, workspaceId: 'w1', ignoreAccountBinding: true });
    } finally { dispose(); }
    expect(params).toHaveLength(1);
    expect(params[0].cmd).toMatch(/wsl\.exe$/i);
    expect(params[0].cwd).toBe('/home/me/repo');
    expect(params[0].args).toEqual(['-d', 'Ubuntu']);
  });
});
