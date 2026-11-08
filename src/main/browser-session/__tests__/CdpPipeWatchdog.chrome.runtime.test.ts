// The pipe's stall watch (C2c) against a real Chrome and real Playwright
// clients: a stopped client no longer holds every other client's new tabs, and
// a healthy one is never taken for stopped, even with main blocked past the
// stall period and large frames in flight.
//
// Chrome: CHROME_PATH, else what wmux's launcher would start
// (chromeForRuntimeSuite). Without one it skips locally, and fails on a CI
// runner that must run the real-Chrome suites. A temporary profile with a pinned
// download folder, headless, data: pages only; nothing is fetched. The child
// client is a process this suite spawns; only it is ever stopped, by its pid.
//
//   npx vitest run -c vitest.runtime.config.ts src/main/browser-session/__tests__/CdpPipeWatchdog.chrome.runtime.test.ts
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { CdpPipeMux, cdpPipeCounters, resetCdpPipeCounters } from '../CdpPipeMux';
import { CdpPipeRelay, type RelayGrant, type RelayRoute } from '../CdpPipeRelay';
import { STALL_MS } from '../CdpPipeStallWatch';
import { accountDownloads } from '../../../test-utils/chromeDownloads';
import { CHROME_TEARDOWN_TIMEOUT_MS, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';
import { chromeForRuntimeSuite } from '../../../test-utils/runtimeChrome';

const CHROME = chromeForRuntimeSuite();
const CLIENT = path.join(__dirname, 'fixtures', 'pipeClient.mjs');
/** Rounds of the false-fire check, each with main blocked this long right after the arm. */
const ROUNDS = 15;
const BLOCK_MS = 3_000;

interface Rig { chrome: ChildProcess; mux: CdpPipeMux; route: RelayRoute }
/** The relay, on a temp root of this file's own, so nothing here looks in a temp dir another wmux uses. */
let relayRoot: string | null = null;
let relay: CdpPipeRelay;
beforeAll(() => {
  relayRoot = process.platform === 'win32' ? null : fs.mkdtempSync('/tmp/wmux-rr-');
  if (relayRoot) fs.chmodSync(relayRoot, 0o700);
  relay = new CdpPipeRelay({ roots: relayRoot ? [relayRoot] : [] });
});
afterAll(async () => {
  await relay.close();
  if (relayRoot) fs.rmSync(relayRoot, { recursive: true, force: true });
});
const connectThrough = (grant: RelayGrant) => chromium.connectOverCDP(grant.endpoint, { headers: { ...grant.headers } });
let rig: Rig | null = null;
/** The test's temp profile, removed after its Chrome is gone, launched or not. */
let profile: TempChromeProfile | null = null;
let child: ChildProcess | null = null;
const browsers: Browser[] = [];

async function start(): Promise<Rig> {
  profile = tempChromeProfile('wmux-pipe-watchdog-');
  const chrome = spawn(CHROME as string, [
    '--remote-debugging-pipe', `--user-data-dir=${profile.dir}`, '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', 'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const mux = new CdpPipeMux(chrome.stdio[3] as Writable, chrome.stdio[4] as Readable);
  rig = { chrome, mux, route: relay.serve(mux) };
  return rig;
}

/** The Playwright client in its own process: send a command line, await its answer line. */
async function spawnClient(grant: RelayGrant) {
  const proc = spawn(process.execPath, [CLIENT], { stdio: ['pipe', 'pipe', 'inherit'], cwd: path.resolve(__dirname, '../../../..') });
  // The grant goes over stdin, never argv or env.
  proc.stdin?.write(`${JSON.stringify(grant)}\n`);
  child = proc;
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  readline.createInterface({ input: proc.stdout as Readable }).on('line', (line) => {
    lines.push(line);
    waiting.shift()?.(line);
  });
  const next = () => new Promise<string>((resolve) => waiting.push(resolve));
  const ask = (command: string) => { const answer = next(); proc.stdin?.write(`${command}\n`); return answer; };
  expect(await next()).toBe('ready');
  return { proc, ask, lines };
}

const fired = () => cdpPipeCounters().watchdog?.fired ?? 0;
const armed = () => cdpPipeCounters().watchdog?.armed ?? 0;

let accountBefore = new Set<string>();
beforeEach(() => {
  resetCdpPipeCounters();
  accountBefore = accountDownloads(['file.bin']);
});

afterEach(async () => {
  // Never leave the spawned client stopped.
  if (child?.pid && child.exitCode === null) {
    try { process.kill(child.pid, 'SIGCONT'); } catch { /* gone */ }
    child.kill('SIGKILL');
  }
  child = null;
  for (const b of browsers.splice(0)) await b.close().catch(() => undefined);
  if (rig) {
    rig.route.close();
    const exited = rig.chrome.exitCode === null ? new Promise((r) => rig?.chrome.once('exit', r)) : Promise.resolve();
    // The pipe closing ends Chrome; it must be gone before its profile is removed.
    rig.mux.close();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    if (rig.chrome.exitCode === null && rig.chrome.signalCode === null) {
      rig.chrome.kill('SIGKILL');
      await exited;
    }
    rig = null;
  }
  try {
    expect([...accountDownloads(['file.bin'])].filter((n) => !accountBefore.has(n))).toEqual([]);
  } finally {
    await profile?.remove();
    profile = null;
  }
}, CHROME_TEARDOWN_TIMEOUT_MS);

describe.skipIf(!CHROME)('the pipe\'s stall watch, real Chrome', () => {
  // SIGSTOP and SIGCONT: none on Windows.
  it.skipIf(process.platform === 'win32')('a stopped client no longer holds another client\'s new tab, and works again once resumed', { timeout: 60_000 }, async () => {
    const { route } = await start();
    const a = await spawnClient(await route.grant({}));
    process.kill(a.proc.pid as number, 'SIGSTOP');

    const b = await connectThrough(await route.grant({}));
    browsers.push(b);
    const started = performance.now();
    const page = await b.contexts()[0].newPage();
    await page.goto('data:text/html,<title>b</title>');
    const tookMs = performance.now() - started;
    expect(await page.title()).toBe('b');
    expect(tookMs).toBeGreaterThanOrEqual(STALL_MS - 100);
    expect(tookMs).toBeLessThan(5_000);
    expect(fired()).toBeGreaterThanOrEqual(1);
    console.log(`[watchdog] B's new tab with A stopped: ${Math.round(tookMs)} ms; counters ${JSON.stringify(cdpPipeCounters().watchdog)}`);

    process.kill(a.proc.pid as number, 'SIGCONT');
    expect(await a.ask('eval')).toBe('ok eval first');
    expect(await a.ask('page')).toBe('ok page');
    expect(a.lines.filter((l) => l.startsWith('error'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('a stopped client with a backlog, and events still coming its way, is let go within a few periods', { timeout: 90_000 }, async () => {
    const { route, mux } = await start();
    const a = await spawnClient(await route.grant({}));
    // The relay's view of A's socket (only A is attached yet).
    const drainOf = () => {
      const clients = [...(mux as unknown as { clients: Set<{ drain?: () => { buffered: number; flushed: number } }> }).clients];
      return clients.find((c) => c.drain)?.drain?.() ?? { buffered: 0, flushed: 0 };
    };
    // A steady stream toward A (its page's console, ~3 MB/s), then A stops:
    // what the socket can take, it takes, and the rest waits in the relay.
    expect(await a.ask('chatty 32')).toBe('ok chatty');
    process.kill(a.proc.pid as number, 'SIGSTOP');
    const backlogBy = performance.now() + 20_000;
    while (drainOf().buffered < (4 << 20) && performance.now() < backlogBy) await new Promise((r) => setTimeout(r, 50));
    const atArm = drainOf();
    expect(atArm.buffered, 'a backlog of at least 4 MB waits for A').toBeGreaterThanOrEqual(4 << 20);
    const b = await connectThrough(await route.grant({}));
    browsers.push(b);
    const started = performance.now();
    const page = await b.contexts()[0].newPage();
    await page.goto('data:text/html,<title>b</title>');
    const tookMs = performance.now() - started;
    const counters = cdpPipeCounters().watchdog;
    const after = drainOf();
    console.log(`[watchdog] B's new tab with A stopped behind a backlog: ${Math.round(tookMs)} ms; backlog ${atArm.buffered} -> ${after.buffered} B, flushed +${after.flushed - atArm.flushed} B; counters ${JSON.stringify(counters)}`);
    expect(fired()).toBeGreaterThanOrEqual(1);
    expect(tookMs).toBeLessThan(5 * STALL_MS);
  });

  it(`a healthy client is never taken for stopped: ${ROUNDS} new pages, main blocked ${BLOCK_MS} ms after each arm, large frames in flight`, { timeout: 180_000 }, async () => {
    const { route } = await start();
    const a = await spawnClient(await route.grant({}));
    const started = performance.now();
    for (let round = 0; round < ROUNDS; round++) {
      const before = armed();
      const answer = a.ask('page+big');
      // As soon as the arm is in, block main past the stall period.
      const deadline = performance.now() + 10_000;
      while (armed() === before && performance.now() < deadline) await new Promise((r) => setImmediate(r));
      expect(armed(), `round ${round}: no arm`).toBeGreaterThan(before);
      const until = performance.now() + BLOCK_MS;
      while (performance.now() < until) { /* main is busy */ }
      expect(await answer).toBe('ok page+big');
    }
    expect(fired()).toBe(0);
    expect(a.lines.filter((l) => l.startsWith('error'))).toEqual([]);
    console.log(`[watchdog] ${ROUNDS} rounds in ${Math.round(performance.now() - started)} ms; counters ${JSON.stringify(cdpPipeCounters().watchdog)}`);
  });
});
