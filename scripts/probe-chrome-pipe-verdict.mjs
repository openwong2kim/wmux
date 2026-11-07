/**
 * The pipe probe's verdict on one run (scripts/probe-chrome-pipe.mjs), apart
 * so it can be tested.
 *
 * Every check fails the run, with one exception asked for by the CI workflow
 * (`--cold-start-warn`): the first start of a browser the runner image
 * preinstalled may take past the launcher's start ceiling while its disk
 * loads, so that one start is a warning. A warm start, a browser the probe
 * installed itself, and every other check still fail.
 */

/** CHROME_START_CEILING_MS in src/shared/chromeStart.ts: how long the launcher waits on a Chrome to start. */
export const LAUNCHER_START_CEILING_MS = 30_000;

/**
 * @param {object} r  one run's result (see probe() in probe-chrome-pipe.mjs)
 * @param {{ coldStartWarn?: boolean, preinstalled?: boolean }} opts
 * @returns {{ ok: boolean, warning: string | null }}
 */
export function probeVerdict(r, { coldStartWarn = false, preinstalled = false } = {}) {
  const checks = !r.error && r.target === true && r.browserSession === true && r.eofExitMs != null &&
    Array.isArray(r.processesLeft) && r.processesLeft.length === 0 && r.cookieKept === true && r.secondExitMs != null;
  if (!checks) return { ok: false, warning: null };
  if (r.withinLauncherCeiling) return { ok: true, warning: null };
  if (coldStartWarn && preinstalled && r.cold) {
    return {
      ok: true,
      warning: `cold start took ${r.firstAnswerMs} ms, past the ${LAUNCHER_START_CEILING_MS} ms start ceiling (first start of a preinstalled browser on this runner)`,
    };
  }
  return { ok: false, warning: null };
}
