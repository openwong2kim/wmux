// ─── Claude/Codex quota rotation — renderer → main IPC ──────────────────────
//
// Renderer-only boundary (ipcMain.handle). GET returns the per-vendor switch
// and each registered account's last quota verdict; it never triggers a
// network read. SET flips one vendor's switch.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { getAccountRotationService } from '../../account/AccountRotationService';

export function registerAccountRotationHandlers(): () => void {
  const channels = [IPC.ACCOUNT_ROTATION_GET, IPC.ACCOUNT_ROTATION_SET];
  for (const c of channels) ipcMain.removeHandler(c);
  const service = getAccountRotationService();

  ipcMain.handle(IPC.ACCOUNT_ROTATION_GET, wrapHandler(IPC.ACCOUNT_ROTATION_GET, async () => ({
    settings: service.getSettings(),
    rows: [...await service.rows('claude'), ...await service.rows('codex')],
  })));

  ipcMain.handle(IPC.ACCOUNT_ROTATION_SET, wrapHandler(IPC.ACCOUNT_ROTATION_SET,
    async (_e, args: { vendor?: unknown; on?: unknown }) => {
      if (args?.vendor !== 'claude' && args?.vendor !== 'codex') throw new Error('invalid vendor');
      await service.setEnabled(args.vendor, args.on === true);
      return { ok: true };
    }));

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
