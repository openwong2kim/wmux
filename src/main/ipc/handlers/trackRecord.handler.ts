// Moa's track record — the renderer's side: the weekly retro card (shown on
// Moa's briefing) and the retro settings (Settings → Moa). The counts stay in
// main; the renderer only ever gets the finished card, and only while Moa is on.
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import type { RetroCard, RetroSchedule } from '../../../shared/trackRecord';
import { wrapHandler } from '../wrapHandler';
import { getHqWorkspaceId, isMoaEnabled } from '../../deck/deckHqStore';
import { getTrackRecordStore, parseRetroSchedule, type TrackRecordStore } from '../../deck/trackRecordStore';

export interface TrackRecordHandlerPorts {
  store?: TrackRecordStore;
  isMoaEnabled?: () => boolean;
  getHq?: () => string | null;
}

/** The retro card for a workspace's briefing, or null. Moa off, the retro
 *  turned off, dismissed, or (with an HQ) any workspace but the HQ: null. */
export function retroCardFor(
  workspaceId: unknown,
  store: TrackRecordStore,
  moaOn: boolean,
  hq: string | null,
): RetroCard | null {
  if (!moaOn || typeof workspaceId !== 'string') return null;
  if (hq !== null && workspaceId !== hq) return null;
  const { retro } = store.read();
  if (!retro.schedule.enabled || !retro.card || retro.dismissed) return null;
  return retro.card;
}

export function registerTrackRecordHandlers(
  getWindow: () => BrowserWindow | null,
  ports: TrackRecordHandlerPorts = {},
): () => void {
  const store = ports.store ?? getTrackRecordStore();
  const moaOn = ports.isMoaEnabled ?? (() => isMoaEnabled());
  const hq = ports.getHq ?? (() => getHqWorkspaceId());
  const changed = (): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.TRACK_RECORD_CHANGED);
  };
  const channels = [
    IPC.TRACK_RECORD_RETRO_GET,
    IPC.TRACK_RECORD_RETRO_DISMISS,
    IPC.TRACK_RECORD_SCHEDULE_GET,
    IPC.TRACK_RECORD_SCHEDULE_SET,
    IPC.TRACK_RECORD_CLEAR,
  ];
  for (const c of channels) ipcMain.removeHandler(c);

  ipcMain.handle(
    IPC.TRACK_RECORD_RETRO_GET,
    wrapHandler(IPC.TRACK_RECORD_RETRO_GET, (_e: Electron.IpcMainInvokeEvent, req: unknown): { card: RetroCard | null } => {
      const workspaceId = req && typeof req === 'object' ? (req as { workspaceId?: unknown }).workspaceId : undefined;
      return { card: retroCardFor(workspaceId, store, moaOn(), hq()) };
    }),
  );

  ipcMain.handle(
    IPC.TRACK_RECORD_RETRO_DISMISS,
    wrapHandler(IPC.TRACK_RECORD_RETRO_DISMISS, (): { ok: boolean } => {
      store.mutate((d) => {
        if (!d.retro.card || d.retro.dismissed) return false;
        d.retro.dismissed = true;
      });
      changed();
      return { ok: true };
    }),
  );

  ipcMain.handle(
    IPC.TRACK_RECORD_SCHEDULE_GET,
    wrapHandler(IPC.TRACK_RECORD_SCHEDULE_GET, (): RetroSchedule => store.read().retro.schedule),
  );

  ipcMain.handle(
    IPC.TRACK_RECORD_SCHEDULE_SET,
    wrapHandler(IPC.TRACK_RECORD_SCHEDULE_SET, (_e: Electron.IpcMainInvokeEvent, patch: unknown): RetroSchedule => {
      store.mutate((d) => {
        d.retro.schedule = parseRetroSchedule(patch, d.retro.schedule);
      });
      changed();
      return store.read().retro.schedule;
    }),
  );

  ipcMain.handle(
    IPC.TRACK_RECORD_CLEAR,
    wrapHandler(IPC.TRACK_RECORD_CLEAR, (): { ok: boolean } => {
      store.clear();
      changed();
      return { ok: true };
    }),
  );

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
