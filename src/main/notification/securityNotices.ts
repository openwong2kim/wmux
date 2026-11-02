import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import { SECURITY_NOTICE_IPC, type SecurityNotice } from '../../shared/securityNotice';
import { wrapHandler } from '../ipc/wrapHandler';

// The pending daemon security notices (shared/securityNotice.ts), oldest
// first. Recorded here, not through the renderer notification policy, so
// focus, a muted workspace or category and the toast setting cannot hide one.
// Bounded so a misbehaving daemon cannot grow it without limit.
const MAX_PENDING = 50;
const pending: SecurityNotice[] = [];

export function recordSecurityNotice(notice: { title: string; body: string; ptyId: string | null }): void {
  const recorded: SecurityNotice = { id: randomUUID(), ...notice, timestamp: Date.now() };
  pending.push(recorded);
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    // A frame being torn down can throw; the other windows and the caller's
    // OS toast must still go ahead, and the notice stays listed.
    try {
      win.webContents.send(SECURITY_NOTICE_IPC.added, recorded);
    } catch (err) {
      console.warn('[securityNotices] send failed:', err);
    }
  }
}

/** Registered once, outside the registerAllHandlers swap: the notices outlive a daemon connection. */
export function registerSecurityNoticeHandlers(): void {
  ipcMain.removeHandler(SECURITY_NOTICE_IPC.list);
  ipcMain.handle(SECURITY_NOTICE_IPC.list, wrapHandler(SECURITY_NOTICE_IPC.list, (): SecurityNotice[] => [...pending]));
  ipcMain.removeHandler(SECURITY_NOTICE_IPC.acknowledge);
  ipcMain.handle(SECURITY_NOTICE_IPC.acknowledge, wrapHandler(SECURITY_NOTICE_IPC.acknowledge, (_event, id: unknown): void => {
    // A non-string id matches no notice, so it is a no-op like an unknown one.
    const index = pending.findIndex((notice) => notice.id === id);
    if (index !== -1) pending.splice(index, 1);
  }));
}
