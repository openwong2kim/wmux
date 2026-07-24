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
    expect(resolveTargets()[0].pipe).toMatch(/wmux-daemon/);
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
