import { existsSync } from 'node:fs';
import { discoverChromeBinary } from '../main/browser-session/ChromeLauncher';
import { MODES, requiredOnThisRunner } from './realBrowserHarness';

/**
 * The Chrome a real-Chrome runtime suite that starts Chrome itself runs
 * against: CHROME_PATH when it is set (and exists), else what wmux's launcher
 * would start (WMUX_CHROME_PATH, then the usual install paths).
 *
 * Undefined skips the suite where nothing requires it. On a CI runner that
 * must run the real-Chrome suites (realBrowserHarness.requiredOnThisRunner)
 * it throws instead, so a suite cannot go quietly unrun there.
 */
export function chromeForRuntimeSuite(): string | undefined {
  const override = process.env.CHROME_PATH;
  const chrome = override ? (existsSync(override) ? override : undefined) : (discoverChromeBinary() ?? undefined);
  if (!chrome && requiredOnThisRunner(MODES[0])) {
    throw new Error(override
      ? `CHROME_PATH names no file (${override}), on a runner that must run the real-Chrome suites`
      : 'no Chrome found on a runner that must run the real-Chrome suites (install Chrome, or set CHROME_PATH or WMUX_CHROME_PATH)');
  }
  return chrome;
}
