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
} from '../cdpPort';

// #1331 — the port used to be a bare draw handed to --remote-debugging-port and
// announced as enabled. A second wmux instance drawing the same number left
// Chromium with no listening CDP port at all, and the log still said "enabled".

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
    // being gone is what releases it — which is why no exit handler is needed.
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
