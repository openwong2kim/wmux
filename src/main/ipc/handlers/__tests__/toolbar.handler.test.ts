// The folder picker opens where it last chose: Electron opens a dialog with no
// defaultPath in Downloads.
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => electron.handlers.set(channel, fn),
    removeHandler: (channel: string) => electron.handlers.delete(channel),
  },
  dialog: { showOpenDialog: electron.showOpenDialog },
  BrowserWindow: { fromWebContents: () => null },
}));
vi.mock('../fs.handler', () => ({ resolveAccessiblePath: async () => null }));

import { registerToolbarHandlers } from '../toolbar.handler';
import { IPC } from '../../../../shared/constants';

describe('DIALOG_PICK_FOLDER', () => {
  it('opens beside the folder it last chose, and with no defaultPath before any choice', async () => {
    registerToolbarHandlers();
    const pick = electron.handlers.get(IPC.DIALOG_PICK_FOLDER) as (event: unknown) => Promise<string[]>;
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/o/code/app'] });
    await expect(pick({ sender: {} })).resolves.toEqual(['/Users/o/code/app']);
    expect(electron.showOpenDialog.mock.calls[0][0]).not.toHaveProperty('defaultPath');

    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(pick({ sender: {} })).resolves.toEqual([]);
    expect(electron.showOpenDialog.mock.calls[1][0]).toMatchObject({ defaultPath: '/Users/o/code' });
  });
});
