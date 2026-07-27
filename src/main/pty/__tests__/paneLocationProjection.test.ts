import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCwd,
  getPaneCommandTarget,
  getPaneLocationSnapshot,
  onCwdUpdate,
  onPaneLocationUpdate,
  removeCwd,
  removePaneLocation,
  updateCwd,
  updatePaneLocation,
} from '../../ipc/handlers/metadata.handler';
import { PTYBridge } from '../PTYBridge';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: {},
}));
vi.mock('../../metadata/MetadataCollector', () => ({
  MetadataCollector: class {
    async getGitBranch(): Promise<string | null> { return null; }
  },
}));
vi.mock('../../metadata/PrStatusCache', () => ({
  prStatusCache: { get: vi.fn(async () => null) },
}));

const { resolveWslDistro } = vi.hoisted(() => ({
  resolveWslDistro: vi.fn<() => Promise<string | undefined>>(),
}));
vi.mock('../wslDistro', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../wslDistro')>()),
  resolveWslDistro,
}));

function reset(ptyId: string): void {
  removeCwd(ptyId);
  removePaneLocation(ptyId);
}

beforeEach(() => {
  resolveWslDistro.mockReset();
  resolveWslDistro.mockResolvedValue(undefined);
});

describe('local pane location projection', () => {
  it.each([
    {
      name: 'relative cwd',
      platform: 'win32',
      rejectedCwd: 'relative/path',
      location: {
        domain: 'host' as const,
        cwd: 'C:\\repo',
        shell: 'pwsh.exe',
      },
    },
    {
      name: 'Windows cwd on macOS',
      platform: 'darwin',
      rejectedCwd: 'C:\\repo',
      location: {
        domain: 'host' as const,
        cwd: '/Users/me/repo',
        shell: '/bin/zsh',
      },
    },
    {
      name: 'Windows cwd in WSL',
      platform: 'win32',
      rejectedCwd: 'C:\\repo',
      location: {
        domain: 'wsl' as const,
        cwd: '/home/me/repo',
        shell: 'wsl.exe',
        distro: 'Ubuntu',
      },
    },
  ])('rejects $name before changing accepted pane state', ({
    platform,
    rejectedCwd,
    location,
  }) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const ptyId = `local-rejected-${platform}`;
    reset(ptyId);
    const locationUpdates = vi.fn();
    const cwdUpdates = vi.fn();
    const unsubscribeLocation = onPaneLocationUpdate(locationUpdates);
    const unsubscribeCwd = onCwdUpdate(cwdUpdates);

    try {
      updatePaneLocation(ptyId, location);
      updateCwd(ptyId, location.cwd);
      const acceptedSnapshot = getPaneLocationSnapshot(ptyId);
      const acceptedTarget = getPaneCommandTarget(ptyId);
      locationUpdates.mockClear();
      cwdUpdates.mockClear();

      updateCwd(ptyId, rejectedCwd);

      expect(getCwd(ptyId)).toBe(location.cwd);
      expect(getPaneCommandTarget(ptyId)).toEqual(acceptedTarget);
      expect(getPaneLocationSnapshot(ptyId)).toBe(acceptedSnapshot);
      expect(locationUpdates).not.toHaveBeenCalled();
      expect(cwdUpdates).not.toHaveBeenCalled();
    } finally {
      unsubscribeLocation();
      unsubscribeCwd();
      reset(ptyId);
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('publishes a distro extracted by the spawn producer without enumeration', () => {
    const ptyId = 'local-explicit-wsl';
    reset(ptyId);

    updatePaneLocation(ptyId, {
      domain: 'wsl',
      cwd: '/home/me',
      shell: 'wsl.exe',
      distro: 'Debian',
    });

    expect(getPaneLocationSnapshot(ptyId)?.location).toMatchObject({ distro: 'Debian' });
    expect(resolveWslDistro).not.toHaveBeenCalled();
    reset(ptyId);
  });

  it('publishes atomic snapshots for create, cwd, and late distro resolution', async () => {
    const ptyId = 'local-wsl';
    reset(ptyId);
    let resolve!: (distro: string | undefined) => void;
    resolveWslDistro.mockReturnValue(new Promise((done) => { resolve = done; }));
    const received = vi.fn();
    const unsubscribe = onPaneLocationUpdate(received);

    updatePaneLocation(ptyId, {
      domain: 'wsl',
      cwd: '/home/me/old',
      shell: 'wsl.exe',
    });
    const created = getPaneLocationSnapshot(ptyId)!;
    updateCwd(ptyId, '/home/me/new');
    const moved = getPaneLocationSnapshot(ptyId)!;
    resolve('Ubuntu');
    await vi.waitFor(() => {
      expect(getPaneLocationSnapshot(ptyId)?.location).toMatchObject({
        cwd: '/home/me/new',
        distro: 'Ubuntu',
      });
    });
    const enriched = getPaneLocationSnapshot(ptyId)!;

    expect(moved.generation).toBe(created.generation);
    expect(moved.revision).toBeGreaterThan(created.revision);
    expect(enriched.generation).toBe(created.generation);
    expect(enriched.revision).toBeGreaterThan(moved.revision);
    expect(received).toHaveBeenLastCalledWith(ptyId, enriched);

    unsubscribe();
    reset(ptyId);
  });

  it('starts a newer generation when a local pty id is reused', () => {
    const ptyId = 'local-reused';
    reset(ptyId);
    updatePaneLocation(ptyId, {
      domain: 'host',
      cwd: 'C:\\old',
      shell: 'pwsh.exe',
    });
    const oldGeneration = getPaneLocationSnapshot(ptyId)!.generation;
    removePaneLocation(ptyId);
    updatePaneLocation(ptyId, {
      domain: 'host',
      cwd: 'C:\\new',
      shell: 'pwsh.exe',
    });
    expect(getPaneLocationSnapshot(ptyId)!.generation).toBeGreaterThan(oldGeneration);
    reset(ptyId);
  });

  it('does not publish or retain a late result after the pane ends', async () => {
    const ptyId = 'local-ended';
    reset(ptyId);
    let resolve!: (distro: string | undefined) => void;
    resolveWslDistro.mockReturnValue(new Promise((done) => { resolve = done; }));
    const received = vi.fn();
    const unsubscribe = onPaneLocationUpdate(received);

    updatePaneLocation(ptyId, {
      domain: 'wsl',
      cwd: '/home/me',
      shell: 'wsl.exe',
    });
    expect(received).toHaveBeenCalledTimes(1);

    removePaneLocation(ptyId);
    resolve('Ubuntu');
    await Promise.resolve();
    await Promise.resolve();

    expect(getPaneLocationSnapshot(ptyId)).toBeUndefined();
    expect(received).toHaveBeenCalledTimes(1);

    unsubscribe();
    reset(ptyId);
  });

  it('ends the location generation when the local process exits naturally', async () => {
    const ptyId = 'local-natural-exit';
    reset(ptyId);
    let resolve!: (distro: string | undefined) => void;
    resolveWslDistro.mockReturnValue(new Promise((done) => { resolve = done; }));
    let exit!: (info: { exitCode: number; signal?: number }) => void;
    const process = {
      pid: 123,
      onData: vi.fn(),
      onExit: vi.fn((listener) => { exit = listener; }),
    };
    const instance = { id: ptyId, process, shell: 'wsl.exe' };
    const manager = {
      get: vi.fn(() => instance),
      remove: vi.fn(),
      onDispose: vi.fn(),
    };
    const win = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    const bridge = new PTYBridge(
      manager as never,
      () => win as never,
      undefined,
      undefined,
      removePaneLocation,
    );
    bridge.setupDataForwarding(ptyId);
    const received = vi.fn();
    const unsubscribe = onPaneLocationUpdate(received);

    updatePaneLocation(ptyId, {
      domain: 'wsl',
      cwd: '/home/me',
      shell: 'wsl.exe',
    });
    exit({ exitCode: 0 });
    resolve('Ubuntu');
    await Promise.resolve();
    await Promise.resolve();

    expect(getPaneLocationSnapshot(ptyId)).toBeUndefined();
    expect(received).toHaveBeenCalledTimes(1);

    unsubscribe();
    reset(ptyId);
  });
});
