// Company presets: the worktree and launch line of each seat (main/company/seatLaunch.ts).
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { seatLaunches, type SeatLaunchResult } from '../../company/seatLaunch';

export function registerCompanyHandlers(): () => void {
  ipcMain.removeHandler(IPC.COMPANY_SEAT_LAUNCHES);
  ipcMain.handle(
    IPC.COMPANY_SEAT_LAUNCHES,
    wrapHandler(IPC.COMPANY_SEAT_LAUNCHES, (_e: Electron.IpcMainInvokeEvent, req: unknown): Promise<SeatLaunchResult> => seatLaunches(req)),
  );
  return () => ipcMain.removeHandler(IPC.COMPANY_SEAT_LAUNCHES);
}
