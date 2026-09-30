// Electron wiring for computer use: the one place that knows which native
// helper this OS runs and where the build put it.

import { app, globalShortcut } from 'electron';
import * as path from 'path';
import { platformChoice } from '../../shared/platform';
import { readComputerUseEnabled } from '../../shared/computer/config';
import { ComputerService, type ConsentRequester, type HelperLike } from './ComputerService';
import { HelperProcess } from './HelperProcess';

interface HelperSpec {
  /** Directory under resources/ (packaged) or native/ (dev build output). */
  dir: string;
  /** Executable path relative to `dir`. */
  exe: string;
}

// The macOS helper is a separately signed .app so TCC grants attach to it and
// survive wmux updates; main execs its binary directly so the helper, not
// wmux, is the responsible process TCC sees.
const HELPER_SPEC = platformChoice<HelperSpec | null>({
  win: { dir: 'computer-use-windows', exe: 'wmux-computer-use.exe' },
  mac: { dir: 'computer-use-macos', exe: 'wmux Computer Use.app/Contents/MacOS/wmux-computer-use' },
  default: null,
});

/**
 * Packaged builds ship the helper as an extraResource; dev builds look in the
 * helper project's publish output. Overridable with WMUX_COMPUTER_HELPER for
 * testing a locally built helper.
 */
export function resolveHelperPath(): string | null {
  const override = process.env.WMUX_COMPUTER_HELPER;
  if (override) return override;
  if (!HELPER_SPEC) return null;
  const base = app.isPackaged
    ? path.join(process.resourcesPath, HELPER_SPEC.dir)
    : path.join(app.getAppPath(), 'native', HELPER_SPEC.dir, 'dist');
  return path.join(base, HELPER_SPEC.exe);
}

/**
 * The stop key. Global because the person is, by definition, looking at some
 * other app while an agent drives it. Registered on first helper start rather
 * than at boot, so installs that never use computer use never claim the chord.
 */
export const COMPUTER_ABORT_ACCELERATOR = 'CommandOrControl+Alt+Shift+Escape';

export function createComputerService(deps: { requestConsent: ConsentRequester }): ComputerService {
  const helperPath = resolveHelperPath();
  let abortKeyRegistered = false;

  // A missing helper binary surfaces on first use (the spawn fails with
  // helper_unavailable), not at boot: most installs never enable computer use.
  const createHelper: (() => HelperLike) | null = helperPath
    ? () => {
        if (!abortKeyRegistered) {
          abortKeyRegistered = true;
          try {
            if (!globalShortcut.register(COMPUTER_ABORT_ACCELERATOR, () => service.abort())) {
              console.warn(`[computer] could not register the stop key ${COMPUTER_ABORT_ACCELERATOR}`);
            }
          } catch (err) {
            console.warn('[computer] stop key registration failed', err);
          }
        }
        return new HelperProcess({ command: helperPath, log: (m) => console.warn(m) });
      }
    : null;

  const service = new ComputerService({
    isEnabled: () => readComputerUseEnabled(),
    createHelper,
    requestConsent: deps.requestConsent,
    blockContext: () => ({
      selfPids: new Set(app.getAppMetrics().map((m) => m.pid).concat(process.pid)),
      selfExePath: process.execPath.toLowerCase(),
    }),
  });
  return service;
}
