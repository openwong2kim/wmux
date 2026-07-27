/**
 * M1 — the bridge aims at the DAEMON first.
 *
 * The daemon is the always-on process that owns hook ingest, so it is tried
 * before the main pipe; main stays as the fallback for an older wmux or a
 * daemon that is down, and `WMUX_HOOKS_TO_MAIN=1` forces the pre-M1 routing.
 * The fallback rule is the load-bearing part: the walk may only advance when
 * the request PROVABLY never reached a server, or a hook could fire twice.
 *
 * Same harness as bridgeActivityThrottle.test.ts: strip the CLI entrypoint,
 * re-export the functions under test, dynamic-import a temp copy.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');
const ENTRYPOINT_MARKER = '// Run; never throw upward';

interface Target { name: string; pipe: string; token: string; method: string }

let tmp: string;
let fakeHome: string;
let resolveTargets: () => Target[];
let shouldTryNextTarget: (result: unknown) => boolean;
let savedUserProfile: string | undefined;
let savedHome: string | undefined;
let savedKillSwitch: string | undefined;

function writeDaemonToken(value = 'daemon-token'): void {
  mkdirSync(path.join(fakeHome, '.wmux'), { recursive: true });
  writeFileSync(path.join(fakeHome, '.wmux', 'daemon-auth-token'), `${value}\n`, 'utf8');
}

function writeMainToken(value = 'main-token'): void {
  writeFileSync(path.join(fakeHome, '.wmux-auth-token'), `${value}\n`, 'utf8');
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-target-'));
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  const cut = src.indexOf(ENTRYPOINT_MARKER);
  expect(cut).toBeGreaterThan(-1);
  const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
    + '\nexport { resolveTargets, shouldTryNextTarget };\n';
  const mod = path.join(tmp, 'bridge-under-test.mjs');
  writeFileSync(mod, testable, 'utf8');
  ({ resolveTargets, shouldTryNextTarget } = await import(pathToFileURL(mod).href));

  savedUserProfile = process.env.USERPROFILE;
  savedHome = process.env.HOME;
  savedKillSwitch = process.env.WMUX_HOOKS_TO_MAIN;
});

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmp, 'home-'));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  delete process.env.WMUX_HOOKS_TO_MAIN;
  // Every path the bridge resolves is WMUX_DATA_SUFFIX-scoped, so a suffix
  // leaking in from the runner's env would point these fixtures at a dir the
  // test never wrote. The unsuffixed cases below are the production shape.
  delete process.env.WMUX_DATA_SUFFIX;
});

afterAll(() => {
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedKillSwitch === undefined) delete process.env.WMUX_HOOKS_TO_MAIN;
  else process.env.WMUX_HOOKS_TO_MAIN = savedKillSwitch;
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveTargets', () => {
  it('puts the daemon first and main second when both tokens exist', () => {
    writeDaemonToken();
    writeMainToken();
    const targets = resolveTargets();
    expect(targets.map((t) => t.name)).toEqual(['daemon', 'main']);
    expect(targets[0]).toMatchObject({ method: 'daemon.hooks.signal', token: 'daemon-token' });
    expect(targets[1]).toMatchObject({ method: 'hooks.signal', token: 'main-token' });
  });

  it('WMUX_HOOKS_TO_MAIN=1 drops the daemon target (kill switch)', () => {
    writeDaemonToken();
    writeMainToken();
    process.env.WMUX_HOOKS_TO_MAIN = '1';
    expect(resolveTargets().map((t) => t.name)).toEqual(['main']);
  });

  it('skips the daemon when it has no token (never booted)', () => {
    writeMainToken();
    expect(resolveTargets().map((t) => t.name)).toEqual(['main']);
  });

  it('skips main when only the daemon has a token', () => {
    writeDaemonToken();
    expect(resolveTargets().map((t) => t.name)).toEqual(['daemon']);
  });

  it('returns nothing when wmux has never run for this user', () => {
    expect(resolveTargets()).toEqual([]);
  });

  it('an empty token file counts as absent', () => {
    writeDaemonToken('   ');
    writeMainToken();
    expect(resolveTargets().map((t) => t.name)).toEqual(['main']);
  });

  it('prefers the daemon-pipe hint file over the derived pipe name', () => {
    // The daemon renames itself on a zombie-pipe fallback, so the hint file is
    // the only place the name it ACTUALLY bound shows up.
    writeDaemonToken();
    writeFileSync(path.join(fakeHome, '.wmux', 'daemon-pipe'), '\\\\.\\pipe\\wmux-daemon-renamed-1\n', 'utf8');
    expect(resolveTargets()[0].pipe).toBe('\\\\.\\pipe\\wmux-daemon-renamed-1');
  });

  it('derives a daemon pipe name when no hint file exists', () => {
    writeDaemonToken();
    const derived = resolveTargets()[0].pipe;
    // The derived name is platform-shaped, and asserting one shape on both is
    // how this test passed on Windows while failing everywhere else: POSIX has
    // no named pipes, so the daemon listens on a unix socket inside the wmux
    // home. Mirrors `getDaemonSocketPath` in src/shared/constants.ts.
    if (process.platform === 'win32') {
      expect(derived).toMatch(/^\\\\\.\\pipe\\wmux-daemon-/);
    } else {
      expect(derived).toBe(path.join(fakeHome, '.wmux', 'daemon.sock'));
    }
  });
});

describe('shouldTryNextTarget', () => {
  it('stops after an endpoint answered, even with a logical rejection', () => {
    expect(shouldTryNextTarget({ ok: true, result: { ok: true } })).toBe(false);
    expect(shouldTryNextTarget({ ok: true, result: { ok: false, reason: 'no-workspace-match' } })).toBe(false);
  });

  it('advances on a connect failure that happened before the write', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'connect-error', detail: 'ENOENT', retryable: true })).toBe(true);
  });

  it('advances on an explicit refusal — an older daemon without the method', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'Unknown method: daemon.hooks.signal' })).toBe(true);
    expect(shouldTryNextTarget({ ok: false, error: 'unauthorized' })).toBe(true);
  });

  it('STOPS when the request was written but never answered (ambiguous — no double-fire)', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'timeout', retryable: false })).toBe(false);
    expect(shouldTryNextTarget({ ok: false, error: 'closed-without-response', retryable: false })).toBe(false);
    expect(shouldTryNextTarget({ ok: false, error: 'connect-error', detail: 'ECONNRESET', retryable: false })).toBe(false);
  });
});

describe('WMUX_PIPE_NAME override', () => {
  const OVERRIDE =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\wmux-probe-1`
      : '/tmp/wmux-probe-1.sock';

  it('collapses the walk to exactly one explicit pipe', () => {
    writeDaemonToken();
    writeMainToken();
    process.env.WMUX_PIPE_NAME = OVERRIDE;
    try {
      const targets = resolveTargets();
      // One target, and NOT the real daemon: a probe that redirects the pipe
      // must not have its signals land in the operator's live session. The pipe
      // name is derived from the username, so a temp HOME does not isolate it —
      // this override is the only thing that does.
      expect(targets).toHaveLength(1);
      expect(targets[0].pipe).toBe(OVERRIDE);
      expect(targets[0].method).toBe('daemon.hooks.signal');
    } finally {
      delete process.env.WMUX_PIPE_NAME;
    }
  });

  it('returns nothing when no token exists, even with an override', () => {
    process.env.WMUX_PIPE_NAME = OVERRIDE;
    try {
      expect(resolveTargets()).toEqual([]);
    } finally {
      delete process.env.WMUX_PIPE_NAME;
    }
  });

  it('an empty override is ignored, so the normal walk still happens', () => {
    writeDaemonToken();
    process.env.WMUX_PIPE_NAME = '';
    try {
      const targets = resolveTargets();
      expect(targets.map((t) => t.name)).toEqual(['daemon']);
      expect(targets[0].pipe).not.toBe(OVERRIDE);
    } finally {
      delete process.env.WMUX_PIPE_NAME;
    }
  });
});
