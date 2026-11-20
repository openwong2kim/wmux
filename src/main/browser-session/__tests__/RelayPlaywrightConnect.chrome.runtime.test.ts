import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { ChromeLauncher, setPipeRelayForTests } from '../ChromeLauncher';
import { CdpPipeRelay } from '../CdpPipeRelay';
import { chromeForRuntimeSuite } from '../../../test-utils/runtimeChrome';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';

// ---------------------------------------------------------------------------
// Stock playwright-core's connectOverCDP, given a relay grant as wmux hands it
// out: the endpoint (a Unix socket on macOS and Linux, a named pipe on
// Windows, both as `ws+unix:`) and its Authorization header. Nothing else.
// ---------------------------------------------------------------------------

const CHROME = chromeForRuntimeSuite();
const CASE_TIMEOUT_MS = 90_000;

let relayRoot: string | null = null;
const rigs: Array<{ launcher: ChromeLauncher; profile: TempChromeProfile }> = [];

beforeAll(async () => {
  relayRoot = process.platform === 'win32' ? null : fs.mkdtempSync('/tmp/wmux-rpc-');
  if (relayRoot) fs.chmodSync(relayRoot, 0o700);
  // No socket roots on Windows: the relay serves on its owner-only named pipe.
  await setPipeRelayForTests(new CdpPipeRelay({ roots: relayRoot ? [relayRoot] : [] }));
});

afterEach(async () => {
  for (const { launcher, profile } of rigs.splice(0)) {
    await stopChrome(launcher);
    await profile.remove();
  }
  vi.unstubAllEnvs();
}, CHROME_TEARDOWN_TIMEOUT_MS);

afterAll(async () => {
  await setPipeRelayForTests(null);
  if (relayRoot) fs.rmSync(relayRoot, { recursive: true, force: true });
});

describe.skipIf(!CHROME)('stock playwright-core on a relay endpoint (real Chrome)', () => {
  it('connectOverCDP takes the ws+unix: endpoint and its header, and drives a page', { timeout: CASE_TIMEOUT_MS }, async () => {
    vi.stubEnv('WMUX_CHROME_TRANSPORT', 'pipe');
    vi.stubEnv('WMUX_CHROME_PATH', CHROME as string);
    const profile = tempChromeProfile('wmux-relay-pw-');
    const launcher = new ChromeLauncher(profile.dir, {
      portEnvVar: null,
      profileName: 'relay-playwright',
      extraArgs: ['--headless=new', '--use-mock-keychain', '--password-store=basic'],
    });
    rigs.push({ launcher, profile });
    expect(await launcher.endpoint()).toEqual({ piped: true });
    const grant = await launcher.relayGrant({ lane: 'pane-script', workspaceId: 'ws-pw', ptyId: 'pty-pw' });
    expect(grant.endpoint.startsWith('ws+unix:')).toBe(true);
    if (process.platform === 'win32') expect(grant.endpoint).toMatch(/^ws\+unix:\\\\\.\\pipe\\/);
    process.stderr.write(`[relay-playwright] ${process.platform} endpoint kind=${process.platform === 'win32' ? 'named pipe' : 'unix socket'}\n`);

    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP(grant.endpoint, { headers: { ...grant.headers } });
    try {
      const page = await browser.contexts()[0].newPage();
      await page.setContent('<title>relay</title><p id="x">ok</p>');
      expect(await page.title()).toBe('relay');
      expect(await page.textContent('#x')).toBe('ok');
    } finally {
      await browser.close();
    }
  });
});
