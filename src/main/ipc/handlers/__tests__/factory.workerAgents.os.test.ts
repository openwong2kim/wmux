// FACTORY_WORKER_AGENTS: the engines a bot's workers may run on, with whether
// each CLI is found here; main window only.
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' }, dialog: {}, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, nativeImage: {} }));

import { factoryWorkerAgentsHandler } from '../factory.handler';

describe('factoryWorkerAgentsHandler', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;
  const deps = { env: async () => ({ PATH: '/bin' }), resolve: (cmd: string) => (cmd === 'claude' ? '/bin/claude' : null), platform: 'darwin' as NodeJS.Platform };

  it('lists the guarded engines with their install state, for the main window only', async () => {
    const h = factoryWorkerAgentsHandler(() => win, deps);
    expect(await h({ sender: webContents, senderFrame: mainFrame })).toEqual([
      { agent: 'claude', label: 'Claude Code', installed: true, supported: true },
      { agent: 'codex', label: 'Codex', installed: false, supported: true },
    ]);
    // Codex's worker guard is POSIX only: offered on Windows as not available.
    const win32 = factoryWorkerAgentsHandler(() => win, { ...deps, platform: 'win32' });
    expect((await win32({ sender: webContents, senderFrame: mainFrame })).find((o) => o.agent === 'codex')?.supported).toBe(false);
    expect(await h({ sender: {}, senderFrame: mainFrame })).toEqual([]);
  });
});
