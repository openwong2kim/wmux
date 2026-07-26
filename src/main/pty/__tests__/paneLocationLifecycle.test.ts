import { describe, it, expect, beforeEach, vi } from 'vitest';
import { preparePaneCommand } from '../../git/paneCommand';
import {
  updateCwd,
  updatePaneLocation,
  removePaneLocation,
  getPaneCommandTarget,
  removeCwd,
} from '../../ipc/handlers/metadata.handler';

/**
 * Issue #21 I1/I2 — a live pane's SessionLocation must (I1) carry the distro
 * and active-session identity needed to act on it from the moment it exists,
 * and (I2) always reflect that pane's CURRENT working directory.
 *
 * These go through the real interface: `updateCwd` (the live cwd feed every
 * OSC 7 / prompt scrape / daemon cwd event already funnels into) and
 * `getPaneCommandTarget` (what metadata.handler's poll and localContextWatch
 * read), then straight into `preparePaneCommand`.
 */

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: {},
}));

// Keep module import from reaching git / gh subprocesses.
vi.mock('../../metadata/MetadataCollector', () => ({
  MetadataCollector: class {
    async getGitBranch(): Promise<string | null> { return null; }
  },
}));
vi.mock('../../metadata/PrStatusCache', () => ({
  prStatusCache: { get: vi.fn(async () => null) },
}));

const { resolveWslDistro } = vi.hoisted(() => ({
  resolveWslDistro: vi.fn<(ctx: { shell: string }) => Promise<string | undefined>>(),
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

describe('I2 — a pane location follows the pane cwd', () => {
  it('reflects a live cwd change (OSC 7 / prompt scrape) without a second writer', () => {
    const ptyId = 'pty-cwd-follow';
    reset(ptyId);
    updatePaneLocation(ptyId, { domain: 'host', cwd: 'C:\\repo-a', shell: 'pwsh.exe' });
    updateCwd(ptyId, 'C:\\repo-a');
    expect(getPaneCommandTarget(ptyId)?.location.cwd).toBe('C:\\repo-a');

    // `cd C:\repo-b` — the shell reports the new cwd through the live feed.
    updateCwd(ptyId, 'C:\\repo-b');
    expect(getPaneCommandTarget(ptyId)?.location.cwd).toBe('C:\\repo-b');
    expect(preparePaneCommand(getPaneCommandTarget(ptyId)!, 'git', ['status'])).toEqual({
      ok: true,
      file: 'git',
      args: ['status'],
      cwd: 'C:\\repo-b',
    });
    reset(ptyId);
  });

  it('keeps a WSL pane in its guest domain across a cd', () => {
    const ptyId = 'pty-cwd-wsl';
    reset(ptyId);
    updatePaneLocation(ptyId, {
      domain: 'wsl', cwd: '/home/me/a', shell: 'wsl.exe', distro: 'Ubuntu',
    });
    updateCwd(ptyId, '/home/me/a');
    updateCwd(ptyId, '/home/me/b');
    const target = getPaneCommandTarget(ptyId)!;
    expect(target.location).toEqual({
      domain: 'wsl', cwd: '/home/me/b', shell: 'wsl.exe', distro: 'Ubuntu',
    });
    reset(ptyId);
  });

  it('re-classifies a Git Bash pane once the shell reports its MSYS cwd', () => {
    // Created with the Windows cwd the profile supplied, so it starts `host`;
    // the shell's own OSC 7 then reports `/c/dev/x`.
    const ptyId = 'pty-cwd-msys';
    reset(ptyId);
    updatePaneLocation(ptyId, { domain: 'host', cwd: 'C:\\dev\\x', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    updateCwd(ptyId, 'C:\\dev\\x');
    updateCwd(ptyId, '/c/dev/x');
    const target = getPaneCommandTarget(ptyId)!;
    expect(target.location.domain).toBe('msys');
    expect(preparePaneCommand(target, 'git', ['status'])).toEqual({
      ok: true, file: 'git', args: ['status'], cwd: 'C:\\dev\\x',
    });
    reset(ptyId);
  });

  it('has no target until the pane has both an identity and a cwd', () => {
    const ptyId = 'pty-cwd-partial';
    reset(ptyId);
    updateCwd(ptyId, 'C:\\repo');
    expect(getPaneCommandTarget(ptyId)).toBeUndefined();
    reset(ptyId);
  });
});

describe('I1 — a live WSL pane can be acted on in its first session', () => {
  it('derives the active-session identity from the live pane itself', () => {
    const ptyId = 'pty-wsl-first';
    reset(ptyId);
    updatePaneLocation(ptyId, {
      domain: 'wsl', cwd: '/home/me/repo', shell: 'wsl.exe', distro: 'Ubuntu',
    });
    updateCwd(ptyId, '/home/me/repo');
    const target = getPaneCommandTarget(ptyId)!;
    expect(target.activeContext).toEqual({ sessionId: ptyId, active: true, distro: 'Ubuntu' });
    expect(preparePaneCommand(target, 'git', ['status'])).toEqual({
      ok: true,
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '/home/me/repo', '--exec', 'git', 'status'],
    });
    reset(ptyId);
  });

  it('resolves the distro for a bare wsl.exe pane with no app restart', async () => {
    const ptyId = 'pty-wsl-nodistro';
    reset(ptyId);
    resolveWslDistro.mockResolvedValue('Ubuntu');
    updatePaneLocation(ptyId, { domain: 'wsl', cwd: '/home/me/repo', shell: 'wsl.exe' });
    updateCwd(ptyId, '/home/me/repo');

    // Before resolution lands the pane fails closed rather than guessing.
    expect(preparePaneCommand(getPaneCommandTarget(ptyId)!, 'git', ['status']))
      .toEqual({ ok: false, error: 'WSL_DISTRO_REQUIRED' });

    await vi.waitFor(() => {
      expect(getPaneCommandTarget(ptyId)?.location).toMatchObject({ distro: 'Ubuntu' });
    });
    expect(resolveWslDistro).toHaveBeenCalledWith(expect.objectContaining({ shell: 'wsl.exe' }));
    expect(preparePaneCommand(getPaneCommandTarget(ptyId)!, 'git', ['status'])).toEqual({
      ok: true,
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '/home/me/repo', '--exec', 'git', 'status'],
    });
    reset(ptyId);
  });

  it('never enumerates distros for a non-WSL pane', () => {
    const ptyId = 'pty-host-nodistro';
    reset(ptyId);
    updatePaneLocation(ptyId, { domain: 'host', cwd: 'C:\\repo', shell: 'pwsh.exe' });
    updateCwd(ptyId, 'C:\\repo');
    expect(resolveWslDistro).not.toHaveBeenCalled();
    reset(ptyId);
  });
});
