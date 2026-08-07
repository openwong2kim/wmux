// ─── T2 fan-out environment: port assignment + setup-hook trust gate ─────────
//
// Both units are the ones a bug would be invisible in: a port collision only
// shows up as "task 3's dev server died", and a trust-gate hole only shows up
// as a command from an unreviewed wmux.json having already run.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assignFanoutPorts,
  clearFanoutPortReservationsForTest,
  isFanoutPortReserved,
  isPortFree,
  releaseFanoutPorts,
  resolveFanoutSetup,
  runFanoutSetup,
  FANOUT_PORT_RESERVATION_TTL_MS,
} from '../fanoutEnvironment';
import { parseFanoutPortRange } from '../../../shared/wmuxProjectConfig';
import type { ProjectConfigState, ProjectTrustState } from '../../../shared/wmuxProjectConfig';

beforeEach(() => {
  clearFanoutPortReservationsForTest();
});
afterEach(() => {
  clearFanoutPortReservationsForTest();
});

describe('assignFanoutPorts', () => {
  it('gives every task a distinct free port and skips busy ones', async () => {
    const busy = new Set([3001, 3002]);
    const ports = await assignFanoutPorts({ min: 3000, max: 3010 }, 3, { probe: async (p) => !busy.has(p) });
    expect(ports).toEqual([3000, 3003, 3004]);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('leaves later tasks unassigned when the window runs out instead of reusing ports', async () => {
    const ports = await assignFanoutPorts({ min: 4000, max: 4001 }, 4, { probe: async () => true });
    expect(ports).toEqual([4000, 4001, undefined, undefined]);
  });

  it('never re-hands a port to a CONCURRENT fan-out before the dev server binds', async () => {
    // The probe says "free" for everything — exactly the real race: fan-out A's
    // tasks have not booted their dev servers yet when fan-out B assigns.
    const alwaysFree = { probe: async () => true };
    const first = await assignFanoutPorts({ min: 5000, max: 5010 }, 3, alwaysFree);
    const second = await assignFanoutPorts({ min: 5000, max: 5010 }, 3, alwaysFree);
    expect(first).toEqual([5000, 5001, 5002]);
    expect(second).toEqual([5003, 5004, 5005]);
    expect(new Set([...first, ...second]).size).toBe(6);
  });

  it('reclaims a reserved port once its TTL lapses', async () => {
    let now = 1_000_000;
    const opts = { probe: async () => true, now: () => now };
    const first = await assignFanoutPorts({ min: 6000, max: 6000 }, 1, opts);
    expect(first).toEqual([6000]);
    // Still reserved → the window has nothing left to give.
    expect(await assignFanoutPorts({ min: 6000, max: 6000 }, 1, opts)).toEqual([undefined]);
    now += FANOUT_PORT_RESERVATION_TTL_MS + 1;
    expect(await assignFanoutPorts({ min: 6000, max: 6000 }, 1, opts)).toEqual([6000]);
  });

  it('releases ports handed to tasks that never spawned', async () => {
    const opts = { probe: async () => true };
    const ports = await assignFanoutPorts({ min: 7000, max: 7005 }, 2, opts);
    expect(isFanoutPortReserved(ports[0] as number)).toBe(true);
    releaseFanoutPorts(ports);
    expect(isFanoutPortReserved(ports[0] as number)).toBe(false);
    expect(await assignFanoutPorts({ min: 7000, max: 7005 }, 2, opts)).toEqual(ports);
  });
});

describe('isPortFree', () => {
  it('reports a port bound on IPv6 loopback as busy (not just IPv4)', async () => {
    // A dev server listening on ::1 makes the port unusable even though a
    // 127.0.0.1 bind still succeeds on most stacks.
    const server = net.createServer();
    const bound = await new Promise<number | null>((resolve) => {
      server.once('error', () => resolve(null)); // no IPv6 on this host
      server.listen(0, '::1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : null);
      });
    });
    if (bound === null) return; // IPv6-less host — nothing to assert
    try {
      expect(await isPortFree(bound)).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('parseFanoutPortRange', () => {
  it('accepts "3000-3010"', () => {
    expect(parseFanoutPortRange('3000-3010')).toEqual({ ok: true, range: { min: 3000, max: 3010 } });
  });

  it('rejects malformed, privileged, inverted and oversized windows with a reason', () => {
    expect(parseFanoutPortRange('3000')).toEqual({ ok: false, reason: 'not-a-range' });
    expect(parseFanoutPortRange('80-90')).toEqual({ ok: false, reason: 'out-of-bounds' });
    expect(parseFanoutPortRange('3010-3000')).toEqual({ ok: false, reason: 'inverted' });
    expect(parseFanoutPortRange(3000)).toEqual({ ok: false, reason: 'not-a-string' });
    // The whole ephemeral space would mean tens of thousands of bind probes.
    expect(parseFanoutPortRange('1024-65535')).toEqual({ ok: false, reason: 'too-wide' });
    expect(parseFanoutPortRange('3000-3511')).toEqual({ ok: true, range: { min: 3000, max: 3511 } });
    expect(parseFanoutPortRange('3000-3512')).toEqual({ ok: false, reason: 'too-wide' });
  });
});

function stateWithSetup(trust: ProjectTrustState | undefined, setup?: string): ProjectConfigState {
  return {
    found: true,
    root: '/repo',
    configPath: '/repo/wmux.json',
    config: { version: 1, fanout: setup === undefined ? {} : { setup } },
    trust,
  };
}

describe('resolveFanoutSetup', () => {
  it('runs the hook only for currently-trusted bytes', () => {
    expect(resolveFanoutSetup(stateWithSetup('trusted', 'npm ci'))).toEqual({ run: true, command: 'npm ci' });
  });

  it('refuses to run a hook from untrusted, edited-since-approval, or denied config', () => {
    expect(resolveFanoutSetup(stateWithSetup('untrusted', 'npm ci'))).toEqual({ run: false, reason: 'untrusted' });
    expect(resolveFanoutSetup(stateWithSetup('stale', 'npm ci'))).toEqual({ run: false, reason: 'stale' });
    expect(resolveFanoutSetup(stateWithSetup('denied', 'npm ci'))).toEqual({ run: false, reason: 'denied' });
    // No trust verdict at all (config never evaluated) must fail closed too.
    expect(resolveFanoutSetup(stateWithSetup(undefined, 'npm ci'))).toEqual({ run: false, reason: 'untrusted' });
  });

  it('reports "none-declared" when there is no hook or no config', () => {
    expect(resolveFanoutSetup(stateWithSetup('trusted'))).toEqual({ run: false, reason: 'none-declared' });
    expect(resolveFanoutSetup({ found: false })).toEqual({ run: false, reason: 'none-declared' });
    expect(resolveFanoutSetup(null)).toEqual({ run: false, reason: 'none-declared' });
  });

  it('reports "malformed" — not "none-declared" — when a declared hook failed validation', () => {
    const state: ProjectConfigState = {
      found: true,
      root: '/repo',
      trust: 'trusted',
      config: { version: 1, fanout: { invalidFields: ['setup'] } },
    };
    expect(resolveFanoutSetup(state)).toEqual({ run: false, reason: 'malformed' });
  });
});

describe('runFanoutSetup', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hook-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs in the worktree with the task env and succeeds', async () => {
    const res = await runFanoutSetup(
      process.platform === 'win32'
        ? 'node -e "require(\'fs\').writeFileSync(\'marker\', process.env.WMUX_TASK_PORT)"'
        : "node -e \"require('fs').writeFileSync('marker', process.env.WMUX_TASK_PORT)\"",
      dir,
      { WMUX_TASK_PORT: '4321' },
    );
    expect(res).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(dir, 'marker'), 'utf8')).toBe('4321');
  });

  it('does NOT kill a chatty hook — heavy output is truncated for the report only', async () => {
    // ~2MB of stdout. The old implementation passed a 64KB `maxBuffer` to
    // exec(), which killed the child at that point and failed a healthy hook.
    const script = "node -e \"const l='x'.repeat(1000); for(let i=0;i<2000;i++) console.log(l)\"";
    const res = await runFanoutSetup(script, dir, {});
    expect(res).toEqual({ ok: true });
  });

  it('reports a failing hook with the tail of its output', async () => {
    const res = await runFanoutSetup("node -e \"console.error('boom detail'); process.exit(3)\"", dir, {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('exited with code 3');
      expect(res.error).toContain('boom detail');
    }
  });

  it('kills the whole process tree on timeout, not just the shell', async () => {
    if (process.platform === 'win32') return; // POSIX process-group assertion
    const pidFile = path.join(dir, 'grandchild.pid');
    const marker = path.join(dir, 'grandchild-survived');
    // The shell backgrounds a node grandchild that would keep writing into the
    // preserved worktree; the hook itself then hangs past the timeout.
    const grandchild = path.join(dir, 'grandchild.js');
    fs.writeFileSync(
      grandchild,
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'x'), 3000);\n`,
      'utf8',
    );
    const res = await runFanoutSetup(`node ${JSON.stringify(grandchild)} & sleep 30`, dir, {}, 700);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('timed out');

    // Give the grandchild's timer more than enough time to fire if it lived.
    await new Promise((r) => setTimeout(r, 3500));
    expect(fs.existsSync(marker)).toBe(false);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 15000);
});
