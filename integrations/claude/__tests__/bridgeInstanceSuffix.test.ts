/**
 * The bridge's path helpers are WMUX_DATA_SUFFIX-scoped.
 *
 * The bug (two independent live dogfoods, Windows 11 + macOS, 2026-07-27): the
 * MAIN endpoint honoured the suffix but the DAEMON endpoint, the resume spool,
 * the log and the activity stamps were hardcoded to the unsuffixed `~/.wmux`.
 * A `-chatview` pane's Stop hook therefore connected to the PRODUCTION daemon
 * pipe, was answered `no-workspace-match`, and spooled its resume binding into
 * production's directory — where no daemon knows that ptyId. The dev instance's
 * `daemon.transcript.status` stayed `no-binding` forever.
 *
 * Two halves to every assertion:
 *   - NO suffix  → the exact pre-fix path (production must be byte-identical).
 *   - suffix set → the suffixed path, in the SAME shape the writers use
 *                  (src/shared/constants.ts, src/daemon/config.ts).
 *
 * Both platform shapes are exercised: the bug was found on Windows, where the
 * daemon endpoint is a named pipe whose name carries the suffix INSIDE it
 * (`\\.\pipe\wmux-daemon-dev-<user>`), not a path under the home dir.
 *
 * Same harness as bridgeDaemonTargeting.test.ts: strip the CLI entrypoint,
 * re-export the functions under test, dynamic-import a temp copy.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');
const ENTRYPOINT_MARKER = '// Run; never throw upward';
const SUFFIX = '-chatview';

interface Target { name: string; pipe: string; token: string; method: string }

let tmp: string;
let fakeHome: string;
let resolveTargets: () => Target[];
let getBridgeLogPath: () => string;
let getResumeSpoolDir: () => string;
let getActivityStampPath: (key: string) => string;
let getDaemonAuthTokenPath: () => string;

let savedUserProfile: string | undefined;
let savedHome: string | undefined;
let savedSuffix: string | undefined;

/** Write the daemon token into `~/.wmux<suffix>/daemon-auth-token`. */
function writeDaemonToken(suffix: string, value = `daemon${suffix || '-prod'}`): void {
  mkdirSync(path.join(fakeHome, `.wmux${suffix}`), { recursive: true });
  writeFileSync(path.join(fakeHome, `.wmux${suffix}`, 'daemon-auth-token'), `${value}\n`, 'utf8');
}

function writeDaemonPipeHint(suffix: string, value: string): void {
  mkdirSync(path.join(fakeHome, `.wmux${suffix}`), { recursive: true });
  writeFileSync(path.join(fakeHome, `.wmux${suffix}`, 'daemon-pipe'), `${value}\n`, 'utf8');
}

function writeMainToken(suffix: string, value = `main${suffix || '-prod'}`): void {
  writeFileSync(path.join(fakeHome, `.wmux${suffix}-auth-token`), `${value}\n`, 'utf8');
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-suffix-'));
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  const cut = src.indexOf(ENTRYPOINT_MARKER);
  expect(cut).toBeGreaterThan(-1);
  const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
    + '\nexport { resolveTargets, getBridgeLogPath, getResumeSpoolDir,'
    + ' getActivityStampPath, getDaemonAuthTokenPath };\n';
  const mod = path.join(tmp, 'bridge-suffix-under-test.mjs');
  writeFileSync(mod, testable, 'utf8');
  ({
    resolveTargets, getBridgeLogPath, getResumeSpoolDir,
    getActivityStampPath, getDaemonAuthTokenPath,
  } = await import(pathToFileURL(mod).href));

  savedUserProfile = process.env.USERPROFILE;
  savedHome = process.env.HOME;
  savedSuffix = process.env.WMUX_DATA_SUFFIX;
});

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmp, 'home-'));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  delete process.env.WMUX_DATA_SUFFIX;
  delete process.env.WMUX_HOOKS_TO_MAIN;
  delete process.env.WMUX_PIPE_NAME;
});

afterAll(() => {
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
  else process.env.WMUX_DATA_SUFFIX = savedSuffix;
  rmSync(tmp, { recursive: true, force: true });
});

describe('no suffix — production paths are unchanged', () => {
  it('daemon auth token stays at ~/.wmux/daemon-auth-token', () => {
    expect(getDaemonAuthTokenPath()).toBe(path.join(fakeHome, '.wmux', 'daemon-auth-token'));
  });

  it('bridge.log, resume-spool and activity-stamps stay under ~/.wmux', () => {
    expect(getBridgeLogPath()).toBe(path.join(fakeHome, '.wmux', 'bridge.log'));
    expect(getResumeSpoolDir()).toBe(path.join(fakeHome, '.wmux', 'resume-spool'));
    expect(getActivityStampPath('pty-1')).toBe(
      path.join(fakeHome, '.wmux', 'activity-stamps', 'pty-1'),
    );
  });

  it('derives the unsuffixed daemon endpoint on both platform shapes', () => {
    writeDaemonToken('');
    const daemon = resolveTargets()[0];
    expect(daemon.token).toBe('daemon-prod');
    if (process.platform === 'win32') {
      expect(daemon.pipe).toBe(`\\\\.\\pipe\\wmux-daemon-${userInfo().username || 'default'}`);
    } else {
      expect(daemon.pipe).toBe(path.join(fakeHome, '.wmux', 'daemon.sock'));
    }
  });
});

describe('suffix set — every endpoint moves to the dev instance', () => {
  beforeEach(() => {
    process.env.WMUX_DATA_SUFFIX = SUFFIX;
  });

  it('daemon auth token moves into ~/.wmux<suffix>/', () => {
    expect(getDaemonAuthTokenPath()).toBe(
      path.join(fakeHome, `.wmux${SUFFIX}`, 'daemon-auth-token'),
    );
  });

  it('bridge.log, resume-spool and activity-stamps move with it', () => {
    expect(getBridgeLogPath()).toBe(path.join(fakeHome, `.wmux${SUFFIX}`, 'bridge.log'));
    expect(getResumeSpoolDir()).toBe(path.join(fakeHome, `.wmux${SUFFIX}`, 'resume-spool'));
    expect(getActivityStampPath('pty-1')).toBe(
      path.join(fakeHome, `.wmux${SUFFIX}`, 'activity-stamps', 'pty-1'),
    );
  });

  it('derives the SUFFIXED daemon pipe on both platform shapes', () => {
    writeDaemonToken(SUFFIX);
    const daemon = resolveTargets()[0];
    expect(daemon.token).toBe(`daemon${SUFFIX}`);
    if (process.platform === 'win32') {
      // The suffix sits between `wmux-daemon` and the username — the exact
      // shape getDaemonSocketPath() binds in src/shared/constants.ts.
      expect(daemon.pipe).toBe(
        `\\\\.\\pipe\\wmux-daemon${SUFFIX}-${userInfo().username || 'default'}`,
      );
    } else {
      expect(daemon.pipe).toBe(path.join(fakeHome, `.wmux${SUFFIX}`, 'daemon.sock'));
    }
  });

  it('reads the daemon-pipe hint from the SUFFIXED dir, not production’s', () => {
    writeDaemonToken(SUFFIX);
    writeDaemonPipeHint('', '\\\\.\\pipe\\wmux-daemon-PRODUCTION');
    writeDaemonPipeHint(SUFFIX, '\\\\.\\pipe\\wmux-daemon-DEV-1');
    expect(resolveTargets()[0].pipe).toBe('\\\\.\\pipe\\wmux-daemon-DEV-1');
  });

  it('main endpoint is suffixed too, and both targets are the dev instance’s', () => {
    writeDaemonToken(SUFFIX);
    writeMainToken(SUFFIX);
    const targets = resolveTargets();
    expect(targets.map((t) => t.name)).toEqual(['daemon', 'main']);
    expect(targets.map((t) => t.token)).toEqual([`daemon${SUFFIX}`, `main${SUFFIX}`]);
  });

  it('production tokens are invisible — a dev pane never targets production', () => {
    // The regression itself: only PRODUCTION has run, and a suffixed pane fires
    // a hook. Before the fix the daemon token was found at the unsuffixed path
    // and the signal was delivered to production's pipe (`no-workspace-match`).
    writeDaemonToken('');
    writeMainToken('');
    expect(resolveTargets()).toEqual([]);
  });
});
