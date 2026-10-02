// Electron wiring for computer use: the one place that knows which native
// helper this OS runs and where the build put it.

import { app, globalShortcut, ipcMain } from 'electron';
import { platformChoice } from '../../shared/platform';
import { IPC } from '../../shared/constants';
import { readComputerUseEnabled, type ComputerUseSettingsPayload } from '../../shared/computer/config';
import { ComputerError } from '../../shared/computer/errors';
import { helperStatus, writeComputerUseEnabled } from './settings';
import { ComputerService, computerUseShutDown, type ConsentRequester, type HelperLike } from './ComputerService';
import { HelperProcess } from './HelperProcess';
import { StopKey } from './stopKey';
import { createHelperVerifier } from './verifyHelper';
import { resolveHelperPathFor, type HelperSpec } from './helperPath';

// The macOS helper is a separately signed .app so TCC grants attach to it and
// survive wmux updates; main execs its binary directly so the helper, not
// wmux, is the responsible process TCC sees.
const HELPER_SPEC = platformChoice<HelperSpec | null>({
  win: { dir: 'computer-use-windows', exe: 'wmux-computer-use.exe' },
  mac: { dir: 'computer-use-macos', exe: 'wmux Computer Use.app/Contents/MacOS/wmux-computer-use' },
  default: null,
});

/**
 * Packaged builds run only the helper they ship (an extraResource); dev builds
 * look in the helper project's publish output and may point
 * WMUX_COMPUTER_HELPER at a locally built helper (helperPath.ts).
 */
export function resolveHelperPath(): string | null {
  return resolveHelperPathFor({
    spec: HELPER_SPEC,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    env: process.env,
  });
}

/**
 * The stop key. Global because the person is, by definition, looking at some
 * other app while an agent drives it. Held only while computer use is on and
 * this build has its helper (stopKey.ts): taken on the first call or when Settings shows the switch on,
 * given back when the switch goes off and on quit, so installs that never use
 * computer use never claim the chord. While it cannot be held, input is
 * refused.
 */
export function stopKeyAcceleratorFor(platform: NodeJS.Platform): string {
  // Not Cmd on macOS: Cmd+Option+Shift+Esc held down force-quits the frontmost
  // app, so a person pressing it in a panic would kill the document the agent
  // was editing.
  return platform === 'darwin' ? 'Control+Alt+Shift+Escape' : 'CommandOrControl+Alt+Shift+Escape';
}

export const COMPUTER_ABORT_ACCELERATOR = stopKeyAcceleratorFor(process.platform);

const OS_NAME = platformChoice({ win: 'Windows', mac: 'macOS', default: process.platform as string });

/**
 * What an agent is told while this build ships no helper binary. Plain words
 * and no filesystem path: a raw spawn error sent agents hunting for other ways
 * to drive the desktop.
 */
export function helperMissingError(): ComputerError {
  return new ComputerError(
    'helper_unavailable',
    `this wmux build does not include the computer-use helper for ${OS_NAME} yet; it ships in a later release. ` +
      'Tell the user that desktop computer use is not available in this build, and do not try other ways to control the desktop',
  );
}

/**
 * A spawn that fails for want of a runnable binary (deleted or quarantined
 * after the check, or not executable). HelperProcess puts the OS error, path
 * included, into the message; the agent gets helperMissingError instead.
 */
const SPAWN_FAILURE = /\b(ENOENT|EACCES|EPERM)\b|could not start the computer-use helper/;

/**
 * The helper as ComputerService sees it. Readiness is re-checked on every
 * request, so a helper that appears later is used and one that disappears
 * stops the running process; spawn failures read as a missing helper.
 */
function lazyHelper(command: string, ready: () => boolean): HelperLike & { reset(): boolean } {
  let proc: HelperProcess | null = null;
  const reset = () => {
    const had = proc !== null;
    proc?.dispose();
    proc = null;
    return had;
  };
  return {
    async request(method, params) {
      if (!ready()) {
        reset();
        throw helperMissingError();
      }
      proc ??= new HelperProcess({ command, verify: verifyHelper, log: (m) => console.warn(m) });
      try {
        return await proc.request(method, params);
      } catch (err) {
        if (err instanceof ComputerError && err.code === 'helper_unavailable' && SPAWN_FAILURE.test(err.message)) {
          console.warn(`[computer] ${err.message}`);
          reset();
          throw helperMissingError();
        }
        throw err;
      }
    },
    abort: (reason) => proc?.abort(reason),
    dispose: () => { reset(); },
    reset,
  };
}

/**
 * Packaged macOS builds spawn the helper only after its code signature checks
 * out (verifyHelper.ts); one verifier, so its verdict cache is shared.
 */
const verifyHelper = createHelperVerifier({ platform: process.platform, isPackaged: app.isPackaged });

let stopKey: StopKey | null = null;
let liveService: ComputerService | null = null;

/** Only touched from IPC handlers and RPC calls, i.e. after `ready`. */
function computerStopKey(): StopKey {
  stopKey ??= new StopKey({
    registry: globalShortcut,
    accelerator: COMPUTER_ABORT_ACCELERATOR,
    onPress: () => liveService?.abort(),
    log: (m) => console.warn(m),
  });
  return stopKey;
}

export function createComputerService(deps: { requestConsent: ConsentRequester }): ComputerService {
  const helperPath = resolveHelperPath();

  // Checked per call, not at boot: most installs never enable computer use.
  const helperReady = () => helperStatus(helperPath) === 'ready';
  const helper = helperPath ? lazyHelper(helperPath, helperReady) : null;
  const key = computerStopKey();

  const service: ComputerService = new ComputerService({
    isEnabled: () => readComputerUseEnabled(),
    createHelper: helper && (() => helper),
    requestConsent: deps.requestConsent,
    // No helper, no chord. Every call arms the key before it reaches the
    // helper, so refusing here keeps the chord free and gives the agent the
    // plain answer instead of stop_key_unavailable. If the helper vanished
    // while in use, stop its work before the key goes: input must never run
    // without a held stop key.
    stopKey: {
      arm: () => {
        if (!helperReady()) {
          if (key.status() === 'held' || helper?.reset()) service.abort();
          key.release();
          throw helperMissingError();
        }
        return key.arm();
      },
      release: () => key.release(),
    },
    blockContext: () => ({
      selfPids: new Set(app.getAppMetrics().map((m) => m.pid).concat(process.pid)),
      selfExePath: process.execPath.toLowerCase(),
    }),
  });
  liveService = service;
  return service;
}

/**
 * App quit: stop the helper (a helper stuck in a native call would otherwise
 * outlive wmux), take down open consent prompts, and give the chord back.
 */
export function disposeComputerUse(service: ComputerService | null): void {
  try {
    service?.dispose();
  } finally {
    stopKey?.release();
    liveService = null;
  }
}

/**
 * Settings › Computer use. `getService` returns the service only if one was
 * ever built, so opening Settings never spawns a helper; turning the switch
 * off stops whatever an agent is doing right now instead of waiting for its
 * next call to notice.
 */
export function registerComputerUseIpc(getExistingService: () => ComputerService | null): void {
  const snapshot = (error?: string): ComputerUseSettingsPayload => {
    const enabled = readComputerUseEnabled();
    const helper = helperStatus(resolveHelperPath());
    // The key is held exactly while the switch is on and a helper exists.
    // Taking it here (Settings is open, so the app is ready) lets the tab say
    // whether the chord is free before any agent calls; turning the switch off
    // gives it back.
    const key = computerStopKey();
    // During quit (the service is disposed) Settings must not take the chord
    // back after disposeComputerUse gave it up.
    if (enabled && helper === 'ready' && !computerUseShutDown()) key.arm();
    else {
      // The helper went away while the key was held: stop agents first.
      if (enabled && key.status() === 'held') getExistingService()?.abort();
      key.release();
    }
    return {
      enabled,
      helper,
      stopKey: COMPUTER_ABORT_ACCELERATOR,
      stopKeyStatus: key.status(),
      ...(error && { error }),
    };
  };

  ipcMain.removeHandler(IPC.COMPUTER_USE_GET);
  ipcMain.handle(IPC.COMPUTER_USE_GET, () => snapshot());

  ipcMain.removeHandler(IPC.COMPUTER_USE_SET);
  ipcMain.handle(IPC.COMPUTER_USE_SET, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    // Settings disables the switch too; this covers any other caller, which
    // sees `enabled: false` with the helper status that explains it. Turning
    // it off is always allowed.
    if (enabled && helperStatus(resolveHelperPath()) !== 'ready') return snapshot();
    try {
      writeComputerUseEnabled(enabled);
    } catch (err) {
      return snapshot(err instanceof Error ? err.message : String(err));
    }
    if (!enabled) getExistingService()?.abort();
    return snapshot();
  });
}
