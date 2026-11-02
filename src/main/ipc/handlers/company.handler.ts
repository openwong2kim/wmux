// Company presets: the worktree and launch line of each seat, and of a seat
// added later (main/company/seatLaunch.ts).
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { hireSeat, seatLaunches, type HireSeatResult, type SeatLaunchResult } from '../../company/seatLaunch';

export function registerCompanyHandlers(): () => void {
  ipcMain.removeHandler(IPC.COMPANY_SEAT_LAUNCHES);
  ipcMain.handle(
    IPC.COMPANY_SEAT_LAUNCHES,
    wrapHandler(IPC.COMPANY_SEAT_LAUNCHES, (_e: Electron.IpcMainInvokeEvent, req: unknown): Promise<SeatLaunchResult> => seatLaunches(req)),
  );
  ipcMain.removeHandler(IPC.COMPANY_HIRE_SEAT);
  ipcMain.handle(
    IPC.COMPANY_HIRE_SEAT,
    wrapHandler(IPC.COMPANY_HIRE_SEAT, (_e: Electron.IpcMainInvokeEvent, req: unknown): Promise<HireSeatResult> => hireSeat(req)),
  );
  return () => {
    ipcMain.removeHandler(IPC.COMPANY_SEAT_LAUNCHES);
    ipcMain.removeHandler(IPC.COMPANY_HIRE_SEAT);
  };
}
