// Element screenshot for the browser inspector's hand-off to an agent: the
// picked element's on-screen box is captured from its <webview> guest and
// saved as a PNG in the app's temp folder, so a terminal agent can open the
// path the hand-off line carries. Files share the paste-image prefix sweep in
// clipboard.handler.ts (removed at the next app start once older than 24 h).
import { app, ipcMain, session, webContents, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { ELEMENT_SHOT_PREFIX, elementShotRect, type ElementRect } from '../../../shared/browserElementHandoff';
import { imagePathForPane } from '../../../shared/imagePaste';
import { PRIVATE_BROWSER_PARTITION } from '../../../shared/privateBrowser';
import { getPtyShell } from '../../pty/ptyShellRegistry';
import { isTrustedMainFrameSender } from './browserPolicy.handler';
import { wrapHandler } from '../wrapHandler';

export const ELEMENT_SHOT_CHANNEL = 'browser:capture-element';
// capturePage can hang on some guests (see CAPTURE_PAGE_TIMEOUT_MS in
// browser.rpc.ts); the hand-off goes out without a screenshot rather than wait.
const CAPTURE_TIMEOUT_MS = 1_500;

export function registerElementShotHandler(getWindow: () => BrowserWindow | null): void {
  ipcMain.removeHandler(ELEMENT_SHOT_CHANNEL);
  ipcMain.handle(
    ELEMENT_SHOT_CHANNEL,
    wrapHandler(ELEMENT_SHOT_CHANNEL, async (event: IpcMainInvokeEvent, webContentsId: unknown, rect: unknown, ptyId: unknown): Promise<string | null> => {
      // Only the wmux window may ask, and only for a <webview> guest it hosts.
      if (!isTrustedMainFrameSender(event, getWindow)) return null;
      if (typeof webContentsId !== 'number' || !Number.isInteger(webContentsId)) return null;
      const wc = webContents.fromId(webContentsId);
      if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents !== event.sender) return null;
      // A private tab is never captured; the renderer skips it too, this holds if it did not.
      if (wc.session === session.fromPartition(PRIVATE_BROWSER_PARTITION)) return null;
      // Non-numeric fields make the clipped box NaN, which elementShotRect refuses.
      if (!rect || typeof rect !== 'object') return null;
      const box = elementShotRect(rect as ElementRect);
      if (!box) return null;
      // The rect is in the page's CSS pixels; capturePage takes the view's, which differ under zoom.
      const zoom = wc.getZoomFactor() || 1;
      const area = {
        x: Math.floor(box.x * zoom),
        y: Math.floor(box.y * zoom),
        width: Math.max(1, Math.round(box.width * zoom)),
        height: Math.max(1, Math.round(box.height * zoom)),
      };
      const image = await Promise.race([
        wc.capturePage(area).catch(() => null),
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (!image || image.isEmpty()) return null;
      const file = path.join(
        app.getPath('temp'),
        `${ELEMENT_SHOT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
      );
      try {
        // Owner-only: a page element can hold private content, and Linux /tmp is shared.
        await fsp.writeFile(file, image.toPNG(), { mode: 0o600, flag: 'wx' });
      } catch {
        return null;
      }
      // A WSL pane reads the Windows temp folder under /mnt (#1196).
      return imagePathForPane(file, {
        platform: process.platform,
        shellPath: getPtyShell(typeof ptyId === 'string' && ptyId ? ptyId : undefined),
      });
    }),
  );
}
