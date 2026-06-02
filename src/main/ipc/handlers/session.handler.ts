import { ipcMain, app } from 'electron';
import * as path from 'path';
import { IPC } from '../../../shared/constants';
import { SessionManager } from '../../session/SessionManager';
import type { SessionData } from '../../../shared/types';
import { wrapHandler } from '../wrapHandler';
import {
  atomicReadTextSync,
  atomicWriteTextSync,
} from '../../../daemon/util/atomicWrite';
import {
  analyzeScrollbackContent,
  isLikelyChoppedScrollback,
} from '../../scrollback/corruption';

/**
 * Module-level singleton. Exported so the main-process boot path
 * (`src/main/index.ts`) can wire its `saveMetadataSync` into the
 * `MetadataStore` persist callback (M0-e) and hydrate the store from
 * `metadata.json` on launch. Keep a single instance so the IPC handlers
 * and the metadata persistence path share the same `pendingData` /
 * debounce timer / queue state.
 */
export const sessionManager = new SessionManager();

// Hard cap on a single dump payload. Matches the renderer's expectation
// that an autosave produces at most ~5 MB of text per surface.
const SCROLLBACK_MAX_BYTES = 5 * 1024 * 1024;

function scrollbackFilePath(surfaceId: string): string {
  return path.join(app.getPath('userData'), 'scrollback', `${surfaceId}.txt`);
}

/**
 * Live getter kept for register-site compatibility. Scrollback dump/load is
 * intentionally no longer gated on daemon state: rendered snapshots are the
 * UI recovery source for repainting TUIs, while daemon raw bytes are a
 * fallback when no snapshot exists.
 */
export function registerSessionHandlers(
  _isDaemonConnected: () => boolean = () => false,
): () => void {
  // Instrumentation: scrollback restore race investigation. This function is
  // called from `registerAllHandlers`, which is invoked both at module load
  // AND during the daemon-connect/disconnect handler swap in main/index.ts.
  // Logging the exact register/unregister boundaries lets us correlate any
  // renderer-side `scrollback.load` rejection ("No handler registered for
  // 'scrollback:load'") against the swap window timing.
  console.error(`[session.handler] register cycle: install (ts=${new Date().toISOString()})`);

  ipcMain.removeHandler(IPC.SESSION_SAVE);
  ipcMain.handle(IPC.SESSION_SAVE, wrapHandler(IPC.SESSION_SAVE, (_event: Electron.IpcMainInvokeEvent, data: SessionData) => {
    sessionManager.save(data);
    return { success: true };
  }));

  ipcMain.removeHandler(IPC.SESSION_LOAD);
  ipcMain.handle(IPC.SESSION_LOAD, wrapHandler(IPC.SESSION_LOAD, () => {
    return sessionManager.load();
  }));

  // scrollback:dump — write terminal buffer to file.
  //
  // Hardening over the previous direct-writeFileSync implementation:
  //   - Atomic write via tmp + rename so a crash mid-write cannot
  //     leave a half-written primary file on disk.
  //   - Rotation chain `.bak` → `.bak.1` → … → `.bak.3`, so a single
  //     bad dump (e.g. an unguarded hidden-container fit() that slipped
  //     past the renderer guard) does not destroy the only good copy.
  //   - Pre-write corruption check: if the renderer somehow hands us a
  //     payload that already exhibits the cols-collapse signature, we
  //     refuse the write and leave the existing primary + backups
  //     untouched. This is defense in depth — the renderer-side cols
  //     guard in `serializeTerminalBuffer` is the primary fix.
  ipcMain.removeHandler(IPC.SCROLLBACK_DUMP);
  ipcMain.handle(IPC.SCROLLBACK_DUMP, wrapHandler(IPC.SCROLLBACK_DUMP, (_event: Electron.IpcMainInvokeEvent, surfaceId: string, content: string) => {
    // Validate surfaceId (alphanumeric + hyphens only, prevent path traversal)
    if (!/^[a-zA-Z0-9-]+$/.test(surfaceId)) return { success: false };

    // Cap at SCROLLBACK_MAX_BYTES to prevent disk bloat. Keep the tail
    // so the user's most recent output is what survives the truncation.
    const capped =
      content.length > SCROLLBACK_MAX_BYTES
        ? content.slice(-SCROLLBACK_MAX_BYTES)
        : content;

    if (isLikelyChoppedScrollback(capped)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[scrollback:dump] refused write — content matches cols-collapse corruption signature surfaceId=${surfaceId} bytes=${capped.length}`,
      );
      return { success: false, reason: 'corrupt-content' };
    }

    try {
      atomicWriteTextSync(scrollbackFilePath(surfaceId), capped, {
        rotationEnabled: true,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[scrollback:dump] write failed surfaceId=${surfaceId}:`, err);
      return { success: false, reason: 'write-failed' };
    }
    return { success: true };
  }));

  // scrollback:load — read terminal buffer from file.
  //
  // Hardening over the previous direct-readFileSync implementation:
  //   - Walks the rotation chain (`.bak`, `.bak.1`, …) when the primary
  //     fails validation, so a single bad write does not erase the
  //     user's restorable history.
  //   - Quarantines any candidate file whose content matches the
  //     cols-collapse corruption signature into `corrupted/` so the
  //     next successful dump cannot silently overwrite the evidence.
  //     This also breaks the corruption feedback loop where a chopped
  //     file is restored into a fresh xterm and then re-dumped over
  //     the next good content on the next 5s tick.
  ipcMain.removeHandler(IPC.SCROLLBACK_LOAD);
  ipcMain.handle(IPC.SCROLLBACK_LOAD, wrapHandler(IPC.SCROLLBACK_LOAD, (_event: Electron.IpcMainInvokeEvent, surfaceId: string) => {
    if (!/^[a-zA-Z0-9-]+$/.test(surfaceId)) return null;
    const filePath = scrollbackFilePath(surfaceId);
    try {
      const result = atomicReadTextSync(filePath, {
        validate: (text) => {
          const report = analyzeScrollbackContent(text);
          if (report.isCorrupt) {
            // eslint-disable-next-line no-console
            console.warn(
              `[scrollback:load] rejecting candidate ${report.reason} surfaceId=${surfaceId}`,
            );
            return false;
          }
          return true;
        },
      });
      if (!result) return null;
      if (result.path !== filePath) {
        // eslint-disable-next-line no-console
        console.warn(
          `[scrollback:load] primary unusable, recovered from backup surfaceId=${surfaceId} path=${path.basename(result.path)}`,
        );
      }
      return result.content;
    } catch {
      return null;
    }
  }));

  return () => {
    // Instrumentation: see register-cycle log above. This is the window we
    // suspect the renderer's scrollback.load lands in during cold boot.
    console.error(`[session.handler] register cycle: uninstall (ts=${new Date().toISOString()})`);
    ipcMain.removeHandler(IPC.SESSION_SAVE);
    ipcMain.removeHandler(IPC.SESSION_LOAD);
    ipcMain.removeHandler(IPC.SCROLLBACK_DUMP);
    ipcMain.removeHandler(IPC.SCROLLBACK_LOAD);
  };
}
