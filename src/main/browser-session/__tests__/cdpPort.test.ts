import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CDP_PORT_COUNT,
  CDP_PORT_MIN,
  claimCdpPort,
  probeCdpEndpoint,
  probeCdpEndpointWithRetry,
  claimDir,
  dropDebuggingSwitches,
  PRE_BOOT_SLACK_MS,
  releaseCdpPort,
  releaseCdpPortOnQuit,
} from '../cdpPort';
import { readSourceText } from '../../../test-utils/sourceText';

// #1331 — the port used to be a bare draw handed to --remote-debugging-port and
// announced as enabled. A second wmux instance drawing the same number left
// Chromium with no listening CDP port at all, and the log still said "enabled".

describe('dropDebuggingSwitches', () => {
  it('removes every switch that opens or loosens a debugging endpoint', () => {
    const removeSwitch = vi.fn();
    dropDebuggingSwitches({ removeSwitch });
    expect(removeSwitch.mock.calls.map(([name]) => name)).toEqual([
      'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins',
    ]);
  });
});

describe('claimCdpPort', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const alive = () => true;
  const dead = () => false;

  it('uses the same claims across launches with different TMPDIR values', () => {
    const previous = process.env.TMPDIR;
    try {
      process.env.TMPDIR = path.join(dir, 'dock-temp');
      const dockDir = claimDir(dir);
      const first = claimCdpPort({ dir: dockDir, pid: 1, isAlive: alive, firstOffset: 4 });
      process.env.TMPDIR = path.join(dir, 'shell-temp');
      expect(claimDir(dir)).toBe(dockDir);
      const second = claimCdpPort({ dir: claimDir(dir), pid: 2, isAlive: alive, firstOffset: 4 });
      expect(second.port).not.toBe(first.port);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  it('claims the drawn port and records the pid', () => {
    const claim = claimCdpPort({ dir, pid: 4242, isAlive: alive, firstOffset: 7 });
    expect(claim).toEqual({ port: CDP_PORT_MIN + 7, claimed: true });
    expect(fs.readFileSync(path.join(dir, `wmux-cdp-${CDP_PORT_MIN + 7}.lock`), 'utf8')).toBe('4242');
  });

  it('steps past a port a LIVE instance holds — the reported collision', () => {
    const first = claimCdpPort({ dir, pid: 1, isAlive: alive, firstOffset: 7 });
    const second = claimCdpPort({ dir, pid: 2, isAlive: alive, firstOffset: 7 });
    expect(second.claimed).toBe(true);
    expect(second.port).not.toBe(first.port);
  });

  it('reclaims a port whose holder is gone', () => {
    claimCdpPort({ dir, pid: 999, isAlive: alive, firstOffset: 3 });
    // The crash case: nothing ran at exit, so the file is still there. The pid
    // being gone is what releases it — which is why a crash needs no exit handler.
    const next = claimCdpPort({ dir, pid: 1000, isAlive: dead, firstOffset: 3 });
    expect(next).toEqual({ port: CDP_PORT_MIN + 3, claimed: true });
    expect(fs.readFileSync(path.join(dir, `wmux-cdp-${CDP_PORT_MIN + 3}.lock`), 'utf8')).toBe('1000');
  });

  it('wraps around the range rather than giving up at the top', () => {
    // Hold the top of the range; a draw that lands there must wrap to 18800.
    claimCdpPort({ dir, pid: 1, isAlive: alive, firstOffset: CDP_PORT_COUNT - 1 });
    const wrapped = claimCdpPort({ dir, pid: 2, isAlive: alive, firstOffset: CDP_PORT_COUNT - 1 });
    expect(wrapped).toEqual({ port: CDP_PORT_MIN, claimed: true });
  });

  it('still returns a port when the whole range is held, and says it did not claim it', () => {
    for (let i = 0; i < CDP_PORT_COUNT; i++) {
      claimCdpPort({ dir, pid: i + 1, isAlive: alive, firstOffset: i });
    }
    // A boot must not fail over a debugging socket. The probe reports the truth.
    const claim = claimCdpPort({ dir, pid: 9999, isAlive: alive, firstOffset: 12 });
    expect(claim).toEqual({ port: CDP_PORT_MIN + 12, claimed: false });
  });

  it('does not steal a port whose claim it cannot read', () => {
    // An unreadable claim is treated as held: the range has ninety-nine other
    // numbers, and guessing is how two instances end up on one port again.
    const held = path.join(dir, `wmux-cdp-${CDP_PORT_MIN + 5}.lock`);
    fs.writeFileSync(held, 'not-a-pid');
    const claim = claimCdpPort({ dir, pid: 7, isAlive: alive, firstOffset: 5 });
    expect(claim.port).not.toBe(CDP_PORT_MIN + 5);
  });
});

describe('claimCdpPort — claims from an earlier boot (#3286)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const lock = (port: number) => path.join(dir, `wmux-cdp-${port}.lock`);
  const bootTimeMs = Date.now() - 3_600_000;
  const writtenAt = (port: number, content: string, ms: number) => {
    fs.writeFileSync(lock(port), content);
    fs.utimesSync(lock(port), ms / 1000, ms / 1000);
  };

  it('reclaims a pre-boot claim whose pid the OS has handed to another process', () => {
    // The pid reads as alive, but nothing that ran before the boot still runs.
    writtenAt(CDP_PORT_MIN + 4, '7752', bootTimeMs - PRE_BOOT_SLACK_MS - 60_000);
    const claim = claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 4, bootTimeMs });
    expect(claim).toEqual({ port: CDP_PORT_MIN + 4, claimed: true });
    expect(fs.readFileSync(lock(CDP_PORT_MIN + 4), 'utf8')).toBe('1234');
  });

  it('reclaims an empty or unreadable claim from an earlier boot', () => {
    writtenAt(CDP_PORT_MIN + 5, '', bootTimeMs - PRE_BOOT_SLACK_MS - 60_000);
    const claim = claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 5, bootTimeMs });
    expect(claim).toEqual({ port: CDP_PORT_MIN + 5, claimed: true });
  });

  it('respects a claim written this boot by a live pid', () => {
    writtenAt(CDP_PORT_MIN + 6, '4242', bootTimeMs + 60_000);
    const claim = claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 6, bootTimeMs });
    expect(claim.port).not.toBe(CDP_PORT_MIN + 6);
    expect(fs.readFileSync(lock(CDP_PORT_MIN + 6), 'utf8')).toBe('4242');
  });

  it('leaves a claim inside the slack before the boot to the pid check', () => {
    // Uptime rounding and clock corrections: a claim just before the computed
    // boot may be from this boot, so only a live pid decides.
    writtenAt(CDP_PORT_MIN + 8, '4242', bootTimeMs - PRE_BOOT_SLACK_MS + 60_000);
    const claim = claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 8, bootTimeMs });
    expect(claim.port).not.toBe(CDP_PORT_MIN + 8);
  });

  it('defaults the boot time to the OS uptime, so a fresh claim by a live pid is held', () => {
    fs.writeFileSync(lock(CDP_PORT_MIN + 9), '4242');
    const claim = claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 9 });
    expect(claim.port).not.toBe(CDP_PORT_MIN + 9);
  });
});

describe('releaseCdpPort', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const lock = (port: number) => path.join(dir, `wmux-cdp-${port}.lock`);

  it('removes our own claim, so the next launch finds the port free', () => {
    const claim = claimCdpPort({ dir, pid: 4242, isAlive: () => true, firstOffset: 7 });
    releaseCdpPort(claim, { dir, pid: 4242 });
    expect(fs.existsSync(lock(claim.port))).toBe(false);
  });

  it('leaves a claim that names another pid: the port is theirs now', () => {
    const claim = claimCdpPort({ dir, pid: 4242, isAlive: () => true, firstOffset: 7 });
    fs.writeFileSync(lock(claim.port), '5151');
    releaseCdpPort(claim, { dir, pid: 4242 });
    expect(fs.readFileSync(lock(claim.port), 'utf8')).toBe('5151');
  });

  it('touches nothing for a port that was only drawn, not claimed', () => {
    fs.writeFileSync(lock(CDP_PORT_MIN + 12), '4242');
    releaseCdpPort({ port: CDP_PORT_MIN + 12, claimed: false }, { dir, pid: 4242 });
    expect(fs.existsSync(lock(CDP_PORT_MIN + 12))).toBe(true);
  });

  it('does not throw, or create the directory, when there is nothing to release', () => {
    const missing = path.join(dir, 'missing');
    expect(() => releaseCdpPort({ port: CDP_PORT_MIN, claimed: true }, { dir: missing, pid: 1 })).not.toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });
});

describe('releaseCdpPortOnQuit', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const lock = (port: number) => path.join(dir, `wmux-cdp-${port}.lock`);

  it('releases on will-quit; the later exit cannot remove a successor\'s claim', () => {
    let willQuit = (): void => undefined;
    let exit = (): void => undefined;
    const claim = claimCdpPort({ dir, pid: 4242, isAlive: () => true, firstOffset: 3 });
    releaseCdpPortOnQuit(claim, { onWillQuit: (l) => { willQuit = l; }, onExit: (l) => { exit = l; } }, { dir, pid: 4242 });
    expect(fs.existsSync(lock(claim.port))).toBe(true);
    willQuit();
    expect(fs.existsSync(lock(claim.port))).toBe(false);
    // Another launch takes the port between will-quit and exit.
    fs.writeFileSync(lock(claim.port), '5151');
    exit();
    expect(fs.readFileSync(lock(claim.port), 'utf8')).toBe('5151');
  });

  it('releases on exit alone (app.exit skips will-quit)', () => {
    let exit = (): void => undefined;
    const claim = claimCdpPort({ dir, pid: 77, isAlive: () => true, firstOffset: 9 });
    releaseCdpPortOnQuit(claim, { onWillQuit: () => undefined, onExit: (l) => { exit = l; } }, { dir, pid: 77 });
    exit();
    expect(fs.existsSync(lock(claim.port))).toBe(false);
  });

  it('returns the release, for a caller that ends the process before either event', () => {
    const claim = claimCdpPort({ dir, pid: 78, isAlive: () => true, firstOffset: 10 });
    const release = releaseCdpPortOnQuit(claim, { onWillQuit: () => undefined, onExit: () => undefined }, { dir, pid: 78 });
    release();
    expect(fs.existsSync(lock(claim.port))).toBe(false);
  });
});

describe('index.ts wiring', () => {
  // index.ts runs appInit() at import, so its wiring is pinned over the source
  // text (the pattern of squirrelWiring.test.ts).
  const src = readSourceText(path.join(__dirname, '..', '..', 'index.ts'));

  it('registers the release right after the claim, on will-quit and on process exit', () => {
    expect(src).toMatch(
      /const claim = claimCdpPort\(\);\s*cdpPort = claim\.port;\s*releaseCdpClaim = releaseCdpPortOnQuit\(claim, \{\s*onWillQuit: \(listener\) => app\.on\('will-quit', listener\),\s*onExit: \(listener\) => process\.on\('exit', listener\),/,
    );
  });

  it('the duplicate that loses the single-instance lock releases its claim before quitting', () => {
    // The claim is taken before the lock is asked for, so the loser holds one.
    expect(src.indexOf('claimCdpPort()')).toBeLessThan(src.indexOf('requestSingleInstanceLock()'));
    expect(src).toMatch(/if \(!gotLock\) \{[^}]*releaseCdpClaim\(\);\s*app\.quit\(\);/);
  });
});

describe('probeCdpEndpoint', () => {
  it('reports the browser when the endpoint answers', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/json/list')) return { ok: true, json: async () => [{ id: 'own-target' }] };
      expect(url).toBe('http://127.0.0.1:18842/json/version');
      return { ok: true, json: async () => ({ Browser: 'Chrome/140.0.0.0' }) };
    }) as unknown as typeof fetch;
    await expect(probeCdpEndpoint(18842, 'own-target', { fetchImpl })).resolves.toEqual({
      ok: true,
      browser: 'Chrome/140.0.0.0',
    });
  });

  it('rejects a healthy foreign endpoint even when its browser version matches', async () => {
    const fetchImpl = (async (url: string) => ({ ok: true, json: async () =>
      url.endsWith('/json/list') ? [{ id: 'other-instance-target' }] : { Browser: 'Chrome/140.0.0.0' },
    })) as unknown as typeof fetch;
    await expect(probeCdpEndpoint(18842, 'own-target', { fetchImpl })).resolves.toEqual({
      ok: false, reason: 'local target is not yet present in the endpoint',
    });
  });

  it('reports a refused connection rather than assuming the port is up', async () => {
    // This is the whole bug: nothing was listening, and the log said enabled.
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:18842');
    }) as unknown as typeof fetch;
    const result = await probeCdpEndpoint(18842, 'own-target', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('ECONNREFUSED') });
  });

  it('treats a non-200 answer as not listening', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(probeCdpEndpoint(18842, 'own-target', { fetchImpl })).resolves.toEqual({
      ok: false,
      reason: 'HTTP 404',
    });
  });
});

it('retries list lag without treating absent targets as proof of foreign ownership', async () => {
  for (const scenario of ['lag', 'foreign', 'timeout']) {
    let lists = 0;
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = (async (url: string) => {
      if (scenario === 'timeout') throw new Error('timeout');
      return { ok: true, json: async () => url.endsWith('/json/list')
        ? (scenario === 'foreign' ? [{ id: 'foreign' }] : (++lists === 1 ? [] : [{ id: 'own' }]))
        : { Browser: 'Chromium' } };
    }) as unknown as typeof fetch;
    const result = await probeCdpEndpointWithRetry(18842, 'own', { fetchImpl, sleep });
    if (scenario === 'lag') {
      expect(result.ok).toBe(true);
      expect(sleep).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toMatchObject({ ok: false });
      expect(result).not.toHaveProperty('foreign');
      expect(sleep.mock.calls).toHaveLength(2);
    }
  }
});

it('recovers after more than three nonempty lists omit the local target', async () => {
  let lists = 0;
  const fetchImpl = (async (url: string) => ({ ok: true, json: async () => url.endsWith('/json/list')
    ? [{ id: ++lists <= 3 ? 'another-local-window' : 'own' }]
    : { Browser: 'Chromium' } })) as unknown as typeof fetch;
  const deps = { fetchImpl, sleep: async () => undefined };
  const first = await probeCdpEndpointWithRetry(18842, 'own', deps);
  expect(first).toMatchObject({ ok: false });
  expect(first).not.toHaveProperty('foreign');
  expect((await probeCdpEndpointWithRetry(18842, 'own', deps)).ok).toBe(true);
});
