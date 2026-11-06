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

  it("opens an `ls --hyperlink` URL that names this machine's host", async () => {
    (window as unknown as { electronAPI: { localHostName: string } }).electronAPI.localHostName = 'DESKTOP-AB12';
    list.mockResolvedValue([{ id: 'pty1', shell: 'wsl.exe', args: ['-d', 'Debian'] }]);
    const d = deps();
    await openTerminalFileLink('file://desktop-ab12/home/me/a.txt', undefined, 'pty1', d);
    expect(state.addEditorSurface).toHaveBeenCalledWith('pane1', '\\\\wsl$\\Debian\\home\\me\\a.txt', { workspaceId: 'ws1' });
    expect(d.onFailure).not.toHaveBeenCalled();
  });

  it('never hands a POSIX path from a non-WSL tab to the OS opener', async () => {
    list.mockResolvedValue([{ id: 'pty1', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }]);
    const d = deps();
    await openTerminalFileLink('/tmp/x.txt:4', undefined, 'pty1', d);
    expect(d.openWithOs).not.toHaveBeenCalled();
    expect(d.onFailure).toHaveBeenCalledWith('not-found');
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

describe('openTerminalFileLink: why nothing opened', () => {
  it('a file: URL naming another computer says so, not that it is missing', async () => {
    list.mockResolvedValue([{ id: 'pty1', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }]);
    const d = { ...deps(), viewerOnly: true };
    await openTerminalFileLink('file://otherhost/share/x.txt', undefined, 'pty1', d);
    expect(d.openWithOs).not.toHaveBeenCalled();
    expect(d.onFailure).toHaveBeenCalledWith('remote');
  });

  it('a malformed file: URL is reported missing, not remote', async () => {
    list.mockResolvedValue([{ id: 'pty1', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }]);
    const d = deps();
    await openTerminalFileLink('file:///%E0%A4%A', undefined, 'pty1', d);
    expect(d.onFailure).toHaveBeenCalledWith('not-found');
  });

  it('an OSC 8 link the viewer cannot show is not handed to the OS, and says why', async () => {
    list.mockResolvedValue([{ id: 'pty1', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }]);
    readFile.mockResolvedValue(null);
    const d = { ...deps(), viewerOnly: true };
    await openTerminalFileLink('file:///C:/work/missing.txt', undefined, 'pty1', d);
    expect(d.openWithOs).not.toHaveBeenCalled();
    expect(d.onFailure).toHaveBeenCalledWith('viewer-only');
  });
});
