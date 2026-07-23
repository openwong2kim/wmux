// ─── Statusline install (renderer-triggered, mirrors hooksBridge.handler) ─────
//
// The per-account usage statusline (`wmux setup-statusline`) shows model,
// account, and 5h/7d rate-limit numbers in Claude Code's status bar. The CLI
// can install it, but an app-only user (winget/Setup.exe) who never opens a
// terminal has no way to discover or enable it.
//
// These handlers expose the SAME logic to the in-app UI (Settings panel or
// install prompt). Same constraints as hooksBridge: explicitly user-clicked,
// never auto-run at boot (owner decision 2026-07-17).
//
// Reuses src/cli/commands/setupStatusline.ts verbatim: same idempotent
// settings merge, same stable script copy under ~/.wmux/hooks/, same atomic
// writes.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import {
  defaultPaths,
  statusStatusline,
  installStatusline,
  type StatuslineOutcome,
  type StatuslineStatus,
} from '../../../cli/commands/setupStatusline';

/** The one bit the renderer prompt needs, plus the full outcome for detail UI. */
export interface StatuslineBridgeStatus {
  /** True when the statusline script exists and at least one target has it set. */
  installed: boolean;
  outcome: StatuslineStatus;
}

export function computeStatuslineInstalled(s: StatuslineStatus): boolean {
  return s.scriptExists && s.targets.some((t) => t.state === 'wmux');
}

export function registerStatuslineBridgeHandlers(): void {
  ipcMain.removeHandler(IPC.STATUSLINE_BRIDGE_STATUS);
  ipcMain.handle(
    IPC.STATUSLINE_BRIDGE_STATUS,
    wrapHandler(IPC.STATUSLINE_BRIDGE_STATUS, async (): Promise<StatuslineBridgeStatus> => {
      const outcome = statusStatusline(defaultPaths());
      return { installed: computeStatuslineInstalled(outcome), outcome };
    }),
  );

  ipcMain.removeHandler(IPC.STATUSLINE_BRIDGE_INSTALL);
  ipcMain.handle(
    IPC.STATUSLINE_BRIDGE_INSTALL,
    wrapHandler(IPC.STATUSLINE_BRIDGE_INSTALL, async (): Promise<StatuslineOutcome> => {
      return installStatusline(defaultPaths());
    }),
  );
}
