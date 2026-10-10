import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { ChromeLauncher } from '../ChromeLauncher';
import { openDownloadPass } from '../dangerousActionConsent';
import { compileHostPolicy } from '../../../shared/browserHostPolicy';
import { canonicalUrlHost } from '../../pipe/handlers/browserConsent.rpc';
import { requiredOnThisRunner } from '../../../test-utils/realBrowserHarness';

// The approved download against a REAL protected Chrome (production launcher,
// proxy and download guard, Playwright attached): exactly the approved tab's
// first download lands in main's directory; a second one, and one from another
// tab, are cancelled; and downloads are denied again afterwards.

let server: http.Server;
let port = 0;
let launcher: ChromeLauncher;
let browser: Browser | null = null;
let skipReason: string | null = null;

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return void res.end('<a id="d" href="/file.bin">file</a>');
  }
  if (req.url === '/file.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' });
    return void res.end('PAYLOAD');
  }
  res.writeHead(404);
  res.end();
}

async function targetIdOf(p: Page): Promise<string> {
  const s = await p.context().newCDPSession(p);
  try {
    return ((await s.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId;
  } finally {
    await s.detach().catch(() => undefined);
  }
}

beforeAll(async () => {
  server = http.createServer(serve);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), 'wmux-consent-chrome-'));
  launcher = new ChromeLauncher(dir, {
    portEnvVar: null,
    profileName: 'consent-download',
    protection: () => ({
      matcher: () => compileHostPolicy({ mode: 'allowlist', allow: ['a.test'], block: [] }),
      resolve: (_h, p) => ({ host: '127.0.0.1', port: p }),
    }),
    extraArgs: ['--headless=new', '--use-mock-keychain', '--password-store=basic'],
  });
  // Chrome under the isolate setup's temp USERPROFILE refuses remote debugging
  // on Windows (same as ProtectedChrome.chrome.runtime.test.ts); give it the real one.
  const savedProfile = process.env.USERPROFILE;
  const realUserProfile = process.env.WMUX_TEST_REAL_HOME;
  if (process.platform === 'win32' && realUserProfile) process.env.USERPROFILE = realUserProfile;
  try {
    const { chromium } = await import('playwright-core');
    const cdpPort = await launcher.ensureRunning();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  } catch (err) {
    skipReason = `Chrome could not be launched here: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  } finally {
    if (process.platform === 'win32') process.env.USERPROFILE = savedProfile;
  }
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  launcher?.dispose();
  server?.close();
});

describe('approved download (real Chrome)', { timeout: 60_000 }, () => {
  it('lets exactly the approved tab’s first download through, then denies again', async (ctx) => {
    if (skipReason) {
      if (requiredOnThisRunner({ name: 'headless', headless: true })) throw new Error(skipReason);
      ctx.skip(skipReason);
      return;
    }
    const context = browser!.contexts()[0];
    const approved = await context.newPage();
    const other = await context.newPage();
    await approved.goto(`http://a.test:${port}/`);
    await other.goto(`http://a.test:${port}/`);
    const guard = launcher.consentDownloadGuard();
    expect(guard).not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'wmux-consent-dl-'));
    const pass = await openDownloadPass(guard!, {
      frameId: await targetIdOf(approved),
      approvedHost: 'a.test',
      hostOf: canonicalUrlHost,
      dir,
      startTimeoutMs: 10_000,
      finishTimeoutMs: 20_000,
      join,
    });

    // Another tab first: cancelled, and the pass still waits for its own.
    const otherDl = other.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
    await other.click('#d');
    expect(await (await otherDl)?.failure()).toBe('canceled');

    // Longer than the guard's periodic deny re-assert: the approval must hold.
    await new Promise((r) => setTimeout(r, 600));
    await approved.click('#d');
    const got = await pass.done;
    expect(got.suggestedFilename).toBe('file.bin');
    expect(existsSync(got.path)).toBe(true);
    expect(readFileSync(got.path, 'utf8')).toBe('PAYLOAD');

    // Afterwards the same tab is denied again.
    const again = approved.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
    await approved.click('#d');
    expect(await (await again)?.failure()).toBe('canceled');
  });
});
