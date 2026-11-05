import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// One workspace with one leaf pane holding the clicked terminal tab. Its
// `shell` is the display label a Ctrl+T or palette tab stores.
const state = {
  terminalOpenFileLinksIn: 'wmux',
  workspaces: [{
    id: 'ws1',
    rootPane: {
      type: 'leaf',
      id: 'pane1',
      surfaces: [{ id: 's1', ptyId: 'pty1', shell: 'Terminal', cwd: '' }],
    },
  }],
  addEditorSurface: vi.fn(),
  addPreviewSurface: vi.fn(),
};
vi.mock('../../stores', () => ({ useStore: { getState: () => state } }));

import { openTerminalFileLink } from '../openTerminalFileLink';

const list = vi.fn();
const readFile = vi.fn();

function deps() {
  return { openWithOs: vi.fn(), onFailure: vi.fn() };
}

beforeEach(() => {
  state.addEditorSurface.mockReset();
  state.addPreviewSurface.mockReset();
  list.mockReset();
  readFile.mockReset().mockResolvedValue('hello');
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { platform: 'win32', pty: { list }, fs: { readFile } },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('openTerminalFileLink on Windows', () => {
  it('reads WSL from the session when the tab label is "Terminal"', async () => {
    list.mockResolvedValue([{
      id: 'pty1',
      shell: 'C:\\Windows\\System32\\wsl.exe',
      wslTarget: { distribution: 'Ubuntu', user: 'me' },
    }]);
    const d = deps();
    await openTerminalFileLink('/tmp/notes.txt', { line: 3 }, 'pty1', d);
    expect(readFile).toHaveBeenCalledWith('\\\\wsl$\\Ubuntu\\tmp\\notes.txt');
    expect(state.addEditorSurface).toHaveBeenCalledWith(
      'pane1',
      '\\\\wsl$\\Ubuntu\\tmp\\notes.txt',
      { workspaceId: 'ws1', line: 3 },
    );
    expect(d.openWithOs).not.toHaveBeenCalled();
    expect(d.onFailure).not.toHaveBeenCalled();
  });

  it('reads WSL from a wsl.exe session with no target (drive mount path)', async () => {
    list.mockResolvedValue([{ id: 'pty1', shell: 'wsl.exe' }]);
    const d = deps();
    await openTerminalFileLink('/mnt/c/work/a.txt', undefined, 'pty1', d);
    expect(state.addEditorSurface).toHaveBeenCalledWith('pane1', 'C:\\work\\a.txt', { workspaceId: 'ws1' });
  });

  it('takes the distro from a `wsl.exe -d <name>` session', async () => {
    list.mockResolvedValue([{ id: 'pty1', shell: 'wsl.exe', args: ['-d', 'Debian'] }]);
    const d = deps();
    await openTerminalFileLink('/home/me/a.txt', undefined, 'pty1', d);
    expect(state.addEditorSurface).toHaveBeenCalledWith('pane1', '\\\\wsl$\\Debian\\home\\me\\a.txt', { workspaceId: 'ws1' });
  });

  it('never hands a POSIX path from a non-WSL tab to the OS opener', async () => {
    list.mockResolvedValue([{ id: 'pty1', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }]);
    const d = deps();
    await openTerminalFileLink('/tmp/x.txt:4', undefined, 'pty1', d);
    expect(d.openWithOs).not.toHaveBeenCalled();
    expect(d.onFailure).toHaveBeenCalledTimes(1);
    expect(state.addEditorSurface).not.toHaveBeenCalled();
  });

  it('still hands an unread drive path to the OS opener (main validates it)', async () => {
    list.mockResolvedValue([{ id: 'pty1', shell: 'pwsh.exe' }]);
    readFile.mockResolvedValue(null);
    const d = deps();
    await openTerminalFileLink('C:\\work\\a.txt', undefined, 'pty1', d);
    expect(d.openWithOs).toHaveBeenCalledWith('C:\\work\\a.txt');
  });
});
