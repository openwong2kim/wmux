import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { getQuickCommandStore } from '../../quickCommands/QuickCommandStore';

export function registerQuickCommandHandlers(): () => void {
  const channels = [IPC.QUICK_COMMAND_LIST, IPC.QUICK_COMMAND_REPLACE];
  for (const channel of channels) ipcMain.removeHandler(channel);
  ipcMain.handle(IPC.QUICK_COMMAND_LIST, wrapHandler(IPC.QUICK_COMMAND_LIST, async () => getQuickCommandStore().read()));
  ipcMain.handle(IPC.QUICK_COMMAND_REPLACE, wrapHandler(IPC.QUICK_COMMAND_REPLACE, async (_event, value: unknown) => getQuickCommandStore().replace(value)));
  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}
