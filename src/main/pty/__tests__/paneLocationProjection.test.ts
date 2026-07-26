import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPaneLocationSnapshot,
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
vi.mock('../wslDistro', () => ({ resolveWslDistro }));

function reset(ptyId: string): void {
  removeCwd(ptyId);
  removePaneLocation(ptyId);
}

beforeEach(() => {
  resolveWslDistro.mockReset();
  resolveWslDistro.mockResolvedValue(undefined);
});

describe('local pane location projection', () => {
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
