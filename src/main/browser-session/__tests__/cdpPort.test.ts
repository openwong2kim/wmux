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
  releaseCdpPort,
  releaseCdpPortOnExit,
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
    expect(fs.readFileSync(path.join(dir, `wmux-cdp-${CDP_PORT_MIN + 7}.lock`), 'utf8')).toMatch(/^4242 uptime=\d+$/);
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
    expect(fs.readFileSync(path.join(dir, `wmux-cdp-${CDP_PORT_MIN + 3}.lock`), 'utf8')).toMatch(/^1000 uptime=\d+$/);
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
  const uptime = () => 600;

  it('records the uptime after the pid', () => {
    const claim = claimCdpPort({ dir, pid: 4242, isAlive: () => true, firstOffset: 2, uptime });
    expect(fs.readFileSync(lock(claim.port), 'utf8')).toBe('4242 uptime=600');
  });

  it('reclaims a claim written at a higher uptime, whose pid the OS has handed to another process', () => {
    // The pid reads as alive, but the uptime says the writer ran in an earlier
    // boot, so nothing that wrote it still runs.
    fs.writeFileSync(lock(CDP_PORT_MIN + 4), '7752 uptime=172800');
    const claim = claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 4, uptime });
    expect(claim).toEqual({ port: CDP_PORT_MIN + 4, claimed: true });
    expect(fs.readFileSync(lock(CDP_PORT_MIN + 4), 'utf8')).toBe('1234 uptime=600');
  });

  it('respects a live claim written earlier in this boot', () => {
    fs.writeFileSync(lock(CDP_PORT_MIN + 6), '4242 uptime=599');
    const claim = claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 6, uptime });
    expect(claim.port).not.toBe(CDP_PORT_MIN + 6);
    expect(fs.readFileSync(lock(CDP_PORT_MIN + 6), 'utf8')).toBe('4242 uptime=599');
  });

  it('compares with a sample taken after the read: a claim written after the walk began is not from an earlier boot', () => {
    // The walk samples 600; another instance then writes its claim at 650, and
    // our read of that file comes after. A later sample (700) shows it is from
    // this boot, so only a live pid decides, and this one is alive.
    let calls = 0;
    const ticking = () => (calls++ === 0 ? 600 : 700);
    fs.writeFileSync(lock(CDP_PORT_MIN + 11), '4242 uptime=650');
    const claim = claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 11, uptime: ticking });
    expect(claim.port).not.toBe(CDP_PORT_MIN + 11);
    expect(fs.readFileSync(lock(CDP_PORT_MIN + 11), 'utf8')).toBe('4242 uptime=650');
    // Our own claim carries the walk's sample.
    expect(fs.readFileSync(lock(claim.port), 'utf8')).toBe('1234 uptime=600');
  });

  it('respects a live claim written in the same second', () => {
    fs.writeFileSync(lock(CDP_PORT_MIN + 7), '4242 uptime=600');
    const claim = claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 7, uptime });
    expect(claim.port).not.toBe(CDP_PORT_MIN + 7);
  });

  it('keeps the pid rule alone for an older wmux\'s claim, which has no uptime', () => {
    fs.writeFileSync(lock(CDP_PORT_MIN + 8), '4242');
    expect(claimCdpPort({ dir, pid: 1234, isAlive: () => true, firstOffset: 8, uptime }).port).not.toBe(CDP_PORT_MIN + 8);
    expect(claimCdpPort({ dir, pid: 1235, isAlive: () => false, firstOffset: 8, uptime }).port).toBe(CDP_PORT_MIN + 8);
  });

  it('writes a claim an older wmux still reads: parseInt gives the pid', () => {
    // An older wmux (and control-wmux-lib's claimOwnedBy) read the claim with
    // Number.parseInt, which stops at the space.
    const claim = claimCdpPort({ dir, pid: 4242, isAlive: () => true, firstOffset: 9, uptime });
    expect(Number.parseInt(fs.readFileSync(lock(claim.port), 'utf8').trim(), 10)).toBe(4242);
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
    fs.writeFileSync(lock(claim.port), '5151 uptime=9');
    releaseCdpPort(claim, { dir, pid: 4242 });
    expect(fs.readFileSync(lock(claim.port), 'utf8')).toBe('5151 uptime=9');
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

describe('releaseCdpPortOnExit', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const lock = (port: number) => path.join(dir, `wmux-cdp-${port}.lock`);

  it('releases on process exit, and only on exit', () => {
    const events: string[] = [];
    let exit = (): void => undefined;
    const claim = claimCdpPort({ dir, pid: 77, isAlive: () => true, firstOffset: 9 });
    releaseCdpPortOnExit(claim, { on: (event, listener) => { events.push(event); exit = listener; } }, { dir, pid: 77 });
    expect(events).toEqual(['exit']);
    expect(fs.existsSync(lock(claim.port))).toBe(true);
    exit();
    expect(fs.existsSync(lock(claim.port))).toBe(false);
  });

  it('returns the release, for an end that runs no exit handlers', () => {
    const claim = claimCdpPort({ dir, pid: 78, isAlive: () => true, firstOffset: 10 });
    const release = releaseCdpPortOnExit(claim, { on: () => undefined }, { dir, pid: 78 });
    release();
    expect(fs.existsSync(lock(claim.port))).toBe(false);
  });
});

describe('index.ts wiring', () => {
  // index.ts runs appInit() at import, so its wiring is pinned over the source
  // text (the pattern of squirrelWiring.test.ts).
  const src = readSourceText(path.join(__dirname, '..', '..', 'index.ts'));

  it('registers the release on process exit right after the claim', () => {
    expect(src).toMatch(/const claim = claimCdpPort\(\);[^;]*;\s*releaseCdpClaim = releaseCdpPortOnExit\(claim, process\);/);
  });

  it('the duplicate that loses the single-instance lock releases its claim before quitting', () => {
    // The claim is taken before the lock is asked for, so the loser holds one.
    expect(src.indexOf('claimCdpPort()')).toBeLessThan(src.indexOf('requestSingleInstanceLock()'));
    expect(src).toMatch(/if \(!gotLock\) \{[^}]*releaseCdpClaim\(\);\s*app\.quit\(\);/);
  });

  it('a Windows session end releases the claim before its first await', () => {
    const body = src.slice(src.indexOf('async function onWindowsSessionEnd'));
    const release = body.indexOf('releaseCdpClaim();');
    expect(release).toBeGreaterThan(0);
    expect(release).toBeLessThan(body.indexOf('await '));
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
