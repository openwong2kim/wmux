import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll } from 'vitest';
import { realProfileBrowserEnv } from './realProfileBrowserEnv';

// ---------------------------------------------------------------------------
// One real Google Chrome per mode, for the `*.chrome.runtime.test.ts` suites.
//
// Extracted from hoverSurfaces.chrome.runtime.test.ts, where every rule below
// was learned on CI; the comments that explain them came along unchanged.
// A suite calls `harnessFor(mode, ...)` at module scope, once per entry of
// MODES, and gets a browser plus a loopback fixture server for that mode.
// ---------------------------------------------------------------------------

/** Fast pre-check only — the launch attempt below is the real gate. */
const WINDOWS_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * Upper bound on the launch attempt.
 *
 * A machine without Google Chrome is the ordinary case — every Linux and macOS
 * runner that has not installed it — and `launch({ channel: 'chrome' })` does
 * not always answer that by throwing: it can sit there. A `beforeAll` that
 * merely catches would then fail the suite on its own timeout, which is exactly
 * how the cross-platform Baseline job went red on this branch. So the attempt is
 * bounded, and anything but a prompt success means "skip", never "fail" --
 * except on a CI runner that must run the mode (requiredOnThisRunner).
 */
const LAUNCH_TIMEOUT_MS = 30_000;

/**
 * The launch bound where the mode is required (requiredOnThisRunner).
 *
 * The short bound only exists to skip fast where Chrome may be absent; where
 * the mode is required a timeout fails either way, so there it only turns a
 * slow launch red. The first chrome.exe start on a fresh Windows runner is a
 * cold start (binary scan, new profile dir): across 70 green Windows Baseline
 * runs, setup for BOTH launches took 7.6-30.7 s (median ~13 s), and twice the
 * single headless launch did not answer within 30 s (2026-10-05). 120 s is
 * still well below Playwright's own 180 s default.
 */
const REQUIRED_LAUNCH_TIMEOUT_MS = 120_000;

/** How long teardown waits for Chrome to exit before killing its process
 *  (see the afterAll below). */
const BROWSER_CLOSE_WAIT_MS = 10_000;

interface CdpSession {
  send: (method: string, params?: unknown) => Promise<unknown>;
}

export type Browser = { newPage: () => Promise<unknown>; close: () => Promise<void> };
type BrowserWithCdp = { newBrowserCDPSession: () => Promise<CdpSession> };

/**
 * The two modes, and why both are here.
 *
 * Headless is what a CI runner can always do. HEADED is what the product
 * actually drives — wmux's chrome backend owns a dedicated, usually unfocused
 * Chrome window — and it is a different machine underneath: one
 * `Input.dispatchMouseEvent` costs ~100 ms there against ~15 ms headless, with
 * the first move of a run paying ~370 ms of compositor wake-up on top. A probe
 * tuned against headless numbers spent its whole budget on the first trigger and
 * silently listed nothing for the second (dogfood, 2026-09-18). So the mode the
 * product uses is a mode under test, and it is the one whose wall clock the
 * budget assertion has to hold in.
 */
export const MODES = [
  { name: 'headless', headless: true },
  { name: 'headed', headless: false },
] as const;

export type Mode = (typeof MODES)[number];

/**
 * Whether this mode must actually run here instead of skipping.
 *
 * Skipping is right on a contributor machine without Chrome, but on CI a skip
 * hid a real regression: a change to the test setup stopped Chrome from
 * launching on the Windows runner and all twelve cases went from passing to
 * skipped while the job stayed green. The GitHub Windows and macOS runners
 * ship Chrome and a display, so both modes must run there; the Linux runner
 * has Chrome but no display, so only headless is required.
 */
export function requiredOnThisRunner(mode: Mode): boolean {
  if (!process.env.CI) return false;
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return mode.headless;
}

function launchBoundFor(mode: Mode): number {
  return requiredOnThisRunner(mode) ? REQUIRED_LAUNCH_TIMEOUT_MS : LAUNCH_TIMEOUT_MS;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

export interface HarnessOptions {
  /** Log prefix, `[<suiteName> <mode>]`. */
  suiteName: string;
  /** Serves every fixture request, on both origins below. */
  serve: (req: IncomingMessage, res: ServerResponse) => void;
}

export interface Harness {
  browser: () => Browser;
  /** `http://127.0.0.1:<port>/` */
  origin: () => string;
  /**
   * `http://localhost:<port>/` — the same server under a different SITE, so a
   * frame loaded from here into an `origin()` page is cross-site and Chrome's
   * site isolation puts it in its own process (an OOPIF). A second port would
   * be same-site and stay in-process.
   */
  crossSiteOrigin: () => string;
  /** Mark the running test SKIPPED, with the reason, when Chrome is absent. */
  skipUnless: (ctx: { skip: (note?: string) => void }) => boolean;
}

/**
 * Stand up one Chrome for one mode, or record why not.
 *
 * Never throws and never hangs, so the suite cannot go red for want of a
 * browser or a display: every failure mode — no Chrome on disk, no
 * playwright-core, a launch that throws, a launch that never answers, no
 * loopback port — becomes a reason string, and every test then marks itself
 * SKIPPED rather than passing vacuously and reporting green for work it did not
 * do, or FAILS where requiredOnThisRunner says the mode has to run. A machine with no display fails the HEADED launch and skips exactly those
 * tests, keeping the headless ones.
 */
export function harnessFor(mode: Mode, options: HarnessOptions): Harness {
  const { suiteName, serve } = options;
  let browser: Browser | null = null;
  let browserPid: number | null = null;
  let server: Server | null = null;
  let port = 0;
  let skipReason: string | null = null;

  async function setUp(): Promise<void> {
    if (process.platform === 'win32' && !existsSync(WINDOWS_CHROME)) {
      skipReason = `Google Chrome is not installed at ${WINDOWS_CHROME}`;
      return;
    }

    let chromium: { launch: (o: unknown) => Promise<unknown> } | undefined;
    try {
      ({ chromium } = (await import('playwright-core')) as {
        chromium?: { launch: (o: unknown) => Promise<unknown> };
      });
    } catch (error) {
      skipReason = `playwright-core is not resolvable here: ${reason(error)}`;
      return;
    }
    if (!chromium) {
      skipReason = 'playwright-core exposes no chromium';
      return;
    }

    // Chrome refuses to start under the isolate setup's temp USERPROFILE on the
    // Windows runner, which skipped every case here; see realProfileBrowserEnv.
    // Playwright's own timeout kills a Chrome that did not answer, so it does
    // not keep cold-starting next to the following mode's launch, and its error
    // carries the launch call log. The race below stays as a backstop.
    const bound = launchBoundFor(mode);
    const launchStarted = Date.now();
    const launching = chromium.launch({
      channel: 'chrome',
      headless: mode.headless,
      env: realProfileBrowserEnv(),
      timeout: bound,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      browser = (await Promise.race([
        launching,
        new Promise<never>((_resolve, rejectRace) => {
          timer = setTimeout(
            () => rejectRace(new Error(`launch did not answer within ${bound} ms`)),
            bound + 5_000,
          );
        }),
      ])) as Browser;
    } catch (error) {
      skipReason = mode.headless
        ? `Google Chrome would not launch: ${reason(error)}`
        : `no display for a headed Chrome: ${reason(error)}`;
      // The whole error, with Playwright's launch call log, and the elapsed
      // time: the skip reason keeps only the first line.
      // eslint-disable-next-line no-console
      console.log(`[${suiteName} ${mode.name}] launch failed after ${Date.now() - launchStarted} ms:`, error);
      // A launch that only LOST the race is still going to produce a browser;
      // close it rather than leave the process behind.
      void launching.then((late) => (late as Browser | null)?.close?.()).catch(() => undefined);
      return;
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Remember the browser process id, so a teardown whose close never
    // returns can kill it instead of leaving Chrome behind. Bounded and
    // swallowed like the rest of setup: without a pid, teardown still works,
    // it just cannot force the kill.
    let pidTimer: ReturnType<typeof setTimeout> | undefined;
    browserPid = await Promise.race([
      (async () => {
        const cdp = await (browser as unknown as BrowserWithCdp).newBrowserCDPSession();
        const info = (await cdp.send('SystemInfo.getProcessInfo')) as {
          processInfo?: Array<{ type?: string; id?: number }>;
        };
        return info.processInfo?.find((p) => p.type === 'browser')?.id ?? null;
      })().catch(() => null),
      new Promise<null>((resolve) => {
        pidTimer = setTimeout(() => resolve(null), 5_000);
      }),
    ]);
    if (pidTimer) clearTimeout(pidTimer);

    server = createServer(serve);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      skipReason = 'could not bind a loopback port for the fixture';
      return;
    }
    port = address.port;

    if (!mode.headless) {
      // The shipped shape: the window the probe drives is NOT the focused one,
      // because the user is looking at something else. Chrome throttles input
      // and rendering for such a window, which is the whole reason this mode is
      // measured separately.
      //
      // Bounded and swallowed, like everything else in here: this is the last
      // await in setup, and an unbounded one would be the one way left for a
      // loaded machine to blow the hook timeout — which is a FAILURE, and this
      // whole gate exists so that a machine that cannot do headed Chrome skips
      // instead. Losing the spare window only costs the mode its unfocused
      // shape, so it is worth strictly less than the suite staying green.
      await Promise.race([
        (async () => {
          const spare = (await browser.newPage()) as { bringToFront: () => Promise<void> };
          await spare.bringToFront();
        })().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
  }

  beforeAll(async () => {
    await setUp();
    if (skipReason) {
      // eslint-disable-next-line no-console
      console.log(`[${suiteName} ${mode.name}] skipping: ${skipReason}`);
    }
  }, launchBoundFor(mode) + 35_000);

  // Vitest's default hook timeout is 10 s, which closing a real browser and a
  // real server does not always fit on a loaded CI runner — observed as
  // "Hook timed out in 10000ms" on #1424's macOS leg, in a suite whose own
  // tests had all passed. Teardown gets the same room `beforeAll` has.
  //
  // Even 60 s was not enough on macos-14 (headed leg), because neither step was
  // bounded by anything but the hook itself: `server.close()` waits for every
  // keep-alive socket Chrome still holds, and `browser.close()` waits for the
  // Chrome process to exit. Teardown asserts nothing, so it now drops the
  // sockets outright and gives the browser a bounded wait — the same "bounded
  // and swallowed" rule setup follows. A close that does not return in time
  // kills the browser process, so Chrome is not left running.
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    if (!browser) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      browser.close().then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), BROWSER_CLOSE_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!closed && browserPid !== null) {
      try {
        process.kill(browserPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }, 60_000);

  return {
    browser: () => browser!,
    origin: () => `http://127.0.0.1:${port}/`,
    crossSiteOrigin: () => `http://localhost:${port}/`,
    skipUnless: (ctx) => {
      if (!skipReason) return false;
      if (requiredOnThisRunner(mode)) {
        throw new Error(
          `[${suiteName} ${mode.name}] must run on this CI runner but could not: ${skipReason}`,
        );
      }
      ctx.skip(skipReason);
      return true;
    },
  };
}
