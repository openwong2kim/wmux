/**
 * A protected Edge start on a PC signed in with a Microsoft or work account.
 *
 * Edge signs a fresh profile in to that account by itself and, about 2 s after
 * start, opens an edge://sync-confirmation-dialog/ page that no CDP close
 * removes. A protected start closes the restored pages and waits for them to
 * go, so when the dialog was listed first the start failed with
 * PROTECTION_NOT_READY (about half the runs). edgeArgs turns the implicit
 * sign-in off.
 *
 * Windows only. Edge gets the real USERPROFILE (the test setup records it in
 * WMUX_TEST_REAL_HOME): under the setup's temp USERPROFILE it refuses remote
 * debugging. On a PC with no account signed in there is no dialog to see, and
 * the case passes without proving anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ChromeLauncher, type ChromeProtectionPlan } from '../ChromeLauncher';
import { compileHostPolicy } from '../../../shared/browserHostPolicy';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile } from '../../../test-utils/chromeProfile';
import { deliberateSleep } from '../../../test-utils/waitFor';

const RUNS = 4;
// The dialog opens about 2 s after start; this is well past it.
const DIALOG_WINDOW_MS = 5_000;

function edgeBinary(): string | null {
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (!base) continue;
    const exe = join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

const realUserProfile = process.env.WMUX_TEST_REAL_HOME;
const edge = process.platform === 'win32' ? edgeBinary() : null;
const skip = !edge || !realUserProfile;

const plan: ChromeProtectionPlan = {
  matcher: () => compileHostPolicy({ mode: 'allowlist', allow: ['a.test'], block: [] }),
  resolve: (_host, p) => ({ host: '127.0.0.1', port: p }),
};

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(skip)('a protected Edge start with the user signed in to Windows (real Edge)', () => {
  it(`starts every time, with no sync dialog (${RUNS} fresh profiles)`, async () => {
    vi.stubEnv('WMUX_CHROME_PATH', edge as string);
    for (let run = 0; run < RUNS; run++) {
      const profile = tempChromeProfile('wmux-edge-protected-');
      const launcher = new ChromeLauncher(profile.dir, {
        portEnvVar: null,
        profileName: `edge-protected-${run}`,
        protection: () => plan,
        extraArgs: ['--headless=new', '--password-store=basic'],
      });
      const savedProfile = process.env.USERPROFILE;
      process.env.USERPROFILE = realUserProfile;
      try {
        const startedAt = Date.now();
        await expect(launcher.ensureRunning(), `run ${run}`).resolves.toBeTypeOf('number');
        await deliberateSleep(
          Math.max(0, startedAt + DIALOG_WINDOW_MS - Date.now()),
          'a negative check: the dialog would have opened by now',
        );
        // The launcher's own view: the client endpoint filters targets by policy.
        const transport = (launcher as unknown as { reach(): { listTargets(signal?: AbortSignal): Promise<unknown> } }).reach();
        const targets = (await transport.listTargets(AbortSignal.timeout(5_000))) as Array<{ url: string }>;
        expect(targets.map((t) => t.url).filter((u) => u.startsWith('edge://sync-confirmation')), `run ${run}`).toEqual([]);
      } finally {
        process.env.USERPROFILE = savedProfile;
        await stopChrome(launcher);
        await profile.remove();
      }
    }
  }, RUNS * (60_000 + CHROME_TEARDOWN_TIMEOUT_MS));
});
