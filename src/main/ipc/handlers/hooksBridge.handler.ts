// ─── Claude Code hook-bridge install (renderer-triggered) ────────────────────
//
// Completion/approval detection is HOOK-PRIMARY (#480): without the wmux hook
// bridge in ~/.claude/settings.json every agent lifecycle signal degrades to
// the regex detector, which can miss a real stop behind a TUI redraw. The CLI
// (`wmux setup-hooks`) has always been able to install the bridge; these two
// handlers expose the SAME logic to the in-app install prompt so a user who
// never opens a terminal still gets hook-quality signals.
//
// Deliberately NOT auto-run at boot: editing the user's Claude settings is an
// explicit, user-clicked action (owner decision 2026-07-17) — the renderer
// shows an install prompt (on launch and on off→assist/auto mode switches) and
// only this INSTALL handler writes.
//
// Reuses src/cli/commands/setupHooks.ts verbatim: same idempotent settings
// merge, same stable bridge copy under ~/.wmux/hooks/, same atomic writes.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import {
  defaultPaths,
  statusHooks,
  installHooks,
  type StatusOutcome,
  type InstallOutcome,
} from '../../../cli/commands/setupHooks';

/** The one bit the renderer prompt needs, plus the full outcome for detail UI. */
export interface HooksBridgeStatus {
  /** True when every wmux hook event is present and the bridge copy exists. */
  installed: boolean;
  outcome: StatusOutcome;
}

export function computeInstalled(s: StatusOutcome): boolean {
  // "Installed" for prompt purposes = settings has at least one wmux hook group
  // AND the copied bridge exists. A stale bridge still counts as installed
  // (signals flow; the CLI refresh path handles staleness) — the prompt is an
  // onboarding nudge, not a version checker.
  return s.installedEvents.length > 0 && s.bridgeExists && !s.settingsCorrupted;
}

export function registerHooksBridgeHandlers(): void {
  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_STATUS);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_STATUS,
    wrapHandler(IPC.HOOKS_BRIDGE_STATUS, async (): Promise<HooksBridgeStatus> => {
      const outcome = statusHooks(defaultPaths());
      return { installed: computeInstalled(outcome), outcome };
    }),
  );

  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_INSTALL);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_INSTALL,
    wrapHandler(IPC.HOOKS_BRIDGE_INSTALL, async (): Promise<InstallOutcome> => {
      return installHooks(defaultPaths());
    }),
  );
}
