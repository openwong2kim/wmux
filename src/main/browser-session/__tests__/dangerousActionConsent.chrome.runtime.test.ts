import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { ChromeLauncher } from '../ChromeLauncher';
import { openDownloadPass } from '../dangerousActionConsent';
import { compileHostPolicy } from '../../../shared/browserHostPolicy';
import { canonicalUrlHost } from '../../pipe/handlers/browserConsent.rpc';
import { requiredOnThisRunner } from '../../../test-utils/realBrowserHarness';
import { accountDownloads } from '../../../test-utils/chromeDownloads';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';
import { deliberateSleep } from '../../../test-utils/waitFor';

// The approved download against a REAL protected Chrome (production launcher,
// proxy and download guard, Playwright attached): exactly the approved tab's
// first download lands in main's directory; a second one, and one from another
// tab, are cancelled; and downloads are denied again afterwards.

let server: http.Server;
let port = 0;
let launcher: ChromeLauncher;
let profile: TempChromeProfile | null = null;
let browser: Browser | null = null;
let skipReason: string | null = null;

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return void res.end('<a id="d" href="/file.bin">file</a><a id="s" href="/slow.bin">slow</a>');
  }
  if (req.url === '/file.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' });
    return void res.end('PAYLOAD');
  }
  if (req.url === '/slow.bin') {
    // Streams for ~2s, so a cancel always lands before it could finish.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="slow.bin"' });
    let n = 0;
    const t = setInterval(() => {
      res.write('x'.repeat(1024));
      if (++n >= 40) {
        clearInterval(t);
        res.end();
      }
    }, 50);
    return;
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

/** What the fixture serves as downloads; the account's real Downloads folder is checked for these, read only. */
const SERVED_FILES = ['file.bin', 'slow.bin'];
let accountBefore = new Set<string>();

beforeAll(async () => {
  accountBefore = accountDownloads(SERVED_FILES);
  server = http.createServer(serve);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  profile = tempChromeProfile('wmux-consent-chrome-');
  const dir = profile.dir;
  launcher = new ChromeLauncher(dir, {
    portEnvVar: null,
    profileName: 'consent-download',
    protection: () => ({
      matcher: () => compileHostPolicy({ mode: 'allowlist', allow: ['a.test'], block: [] }),
      resolve: (_h, p) => ({ host: '127.0.0.1', port: p }),
    }),
    extraArgs: ['--headless=new', '--use-mock-keychain', '--password-store=basic'],
  });
  try {
    const { chromium } = await import('playwright-core');
    const cdpPort = await launcher.ensureRunning();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  } catch (err) {
    skipReason = `Chrome could not be launched here: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  }
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await stopChrome(launcher);
  server?.close();
  try {
    // Every download went to a temp folder: nothing new in the account's own.
    expect([...accountDownloads(SERVED_FILES)].filter((name) => !accountBefore.has(name))).toEqual([]);
  } finally {
    // After Chrome has gone, launched or not.
    await profile?.remove();
  }
}, CHROME_TEARDOWN_TIMEOUT_MS);

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
    // What the MCP engine does on a protected connection: a browser session
    // that set deny once and stays attached for the connection's life.
    const engineDeny = await browser!.newBrowserCDPSession();
    await engineDeny.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    const guard = launcher.consentDownloadGuard();
    expect(guard).not.toBeNull();
    const dir = profile!.scratch('wmux-consent-dl-');
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
    await other.click('#s');
    expect(await (await otherDl)?.failure()).toBe('canceled');

    // Longer than the guard's periodic deny re-assert: the approval must hold.
    await deliberateSleep(600, 'real timer: outlast the guard\'s periodic deny re-assert');
    await approved.click('#d');
    const got = await pass.done;
    expect(got.suggestedFilename).toBe('file.bin');
    expect(existsSync(got.path)).toBe(true);
    expect(readFileSync(got.path, 'utf8')).toBe('PAYLOAD');

    // Afterwards the same tab is denied again.
    const again = approved.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
    await approved.click('#d');
    expect(await (await again)?.failure()).toBe('canceled');
    await engineDeny.detach().catch(() => undefined);
  });
});
