// Suffix isolation + daemon-first routing for the OpenCode lifecycle plugin.
//
// Two invariants this locks:
//
//  1. INSTANCE ISOLATION. WMUX_DATA_SUFFIX is an instance boundary. Every
//     endpoint, credential and local-state path the plugin touches must stay
//     inside the selected namespace, and a suffixed instance must never fall
//     back to the production (unsuffixed) daemon token or hint. With no suffix
//     every path stays byte-identical to the pre-isolation paths.
//
//  2. AT-MOST-ONCE DELIVERY. The plugin walks daemon → main. It may only
//     advance when no server answered AND the request provably was not written;
//     any id-matched reply (including a rejection) owns the signal, and a
//     post-write disconnect is ambiguous, so both stop the walk.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dataSuffix,
  getWmuxHomeDir,
  getAuthTokenPath,
  getPipeName,
  getDaemonAuthTokenPath,
  getDaemonPipeName,
  resolveTargets,
  shouldTryNextTarget,
} from '../plugins/wmux.js';

const SAVED = { ...process.env };

// Every case runs against a throwaway home. These helpers read real files
// (auth tokens, the daemon-pipe hint), so a test that used the developer's home
// would both leak machine state into assertions and read whatever a live daemon
// happens to have written.
let home: string;

beforeEach(() => {
  for (const k of ['WMUX_DATA_SUFFIX', 'WMUX_PIPE_NAME', 'WMUX_HOOKS_TO_MAIN']) {
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'wmux-oc-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...SAVED };
});

describe('instance suffix', () => {
  it('is empty by default — production paths are unchanged', () => {
    expect(dataSuffix()).toBe('');
    expect(getWmuxHomeDir()).toBe(join(home, '.wmux'));
    expect(getAuthTokenPath()).toBe(join(home, '.wmux-auth-token'));
    expect(getDaemonAuthTokenPath()).toBe(join(home, '.wmux', 'daemon-auth-token'));
  });

  it('scopes EVERY path when a suffix is selected', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(getWmuxHomeDir()).toBe(join(home, '.wmux-dev'));
    expect(getAuthTokenPath()).toBe(join(home, '.wmux-dev-auth-token'));
    expect(getDaemonAuthTokenPath()).toBe(join(home, '.wmux-dev', 'daemon-auth-token'));
    // POSIX derives a daemon socket; win32 uses a named pipe (covered in the
    // 'win32 naming' suite). Only the socket path is platform-specific here.
    if (process.platform !== 'win32') {
      expect(getDaemonPipeName()).toBe(join(home, '.wmux-dev', 'daemon.sock'));
    }
  });

  it('never reaches into the production namespace from a suffixed instance', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    for (const p of [getAuthTokenPath(), getDaemonAuthTokenPath(), getDaemonPipeName(), getPipeName()]) {
      expect(p).toContain('-dev');
    }
  });
});

describe('main socket resolution matches the canonical formula', () => {
  // The main socket is a file only on POSIX; win32 uses a named pipe (covered
  // in the 'win32 naming' suite), so these socket-form assertions run POSIX-only.
  it.skipIf(process.platform === 'win32')('uses os.homedir(), NOT a USERPROFILE-first lookup', () => {
    // src/shared/constants.ts getPipeName() resolves the home with os.homedir().
    // A POSIX environment that happens to carry USERPROFILE must not send the
    // bridge looking for the socket in a directory main never bound.
    process.env.USERPROFILE = '/somewhere/else';
    // os.homedir() reads HOME on POSIX, which the harness points at the temp dir.
    expect(getPipeName()).toBe(join(homedir(), '.wmux.sock'));
    expect(getPipeName()).not.toContain('/somewhere/else');
  });

  it.skipIf(process.platform === 'win32')('applies the suffix to the socket name', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(getPipeName()).toBe(join(homedir(), '.wmux-dev.sock'));
  });

  it('token and state paths still honour USERPROFILE (isolated-dogfood contract)', () => {
    // Deliberately different from the socket: the dogfood harness isolates an
    // instance by pointing USERPROFILE at a scratch home.
    process.env.USERPROFILE = '/scratch/home';
    expect(getAuthTokenPath()).toBe(join('/scratch/home', '.wmux-auth-token'));
    expect(getWmuxHomeDir()).toBe(join('/scratch/home', '.wmux'));
  });

  it('honours an explicit WMUX_PIPE_NAME override', () => {
    process.env.WMUX_PIPE_NAME = '/tmp/probe.sock';
    expect(getPipeName()).toBe('/tmp/probe.sock');
  });
});

describe('resolveTargets — daemon first, main as fallback', () => {
  const writeMainToken = () => writeFileSync(join(home, '.wmux-auth-token'), 'main-tok', 'utf8');
  const writeDaemonToken = () => {
    mkdirSync(join(home, '.wmux'), { recursive: true });
    writeFileSync(join(home, '.wmux', 'daemon-auth-token'), 'daemon-tok', 'utf8');
  };

  it('puts the daemon FIRST — it is the always-on process (works with the GUI closed)', () => {
    writeMainToken();
    writeDaemonToken();
    const targets = resolveTargets();
    expect(targets.map((t) => t.name)).toEqual(['daemon', 'main']);
    expect(targets[0].method).toBe('daemon.hooks.signal');
    expect(targets[1].method).toBe('hooks.signal');
    expect(targets[0].token).toBe('daemon-tok');
    expect(targets[1].token).toBe('main-tok');
  });

  it('skips an endpoint whose token file is absent', () => {
    writeDaemonToken();
    expect(resolveTargets().map((t) => t.name)).toEqual(['daemon']);
  });

  it('returns nothing when neither token exists (nothing to talk to)', () => {
    expect(resolveTargets()).toEqual([]);
  });

  it('WMUX_HOOKS_TO_MAIN=1 is a main-only kill switch', () => {
    writeMainToken();
    writeDaemonToken();
    process.env.WMUX_HOOKS_TO_MAIN = '1';
    expect(resolveTargets().map((t) => t.name)).toEqual(['main']);
  });

  it('WMUX_PIPE_NAME collapses the walk to ONE main-addressed target', () => {
    writeMainToken();
    writeDaemonToken();
    process.env.WMUX_PIPE_NAME = '/tmp/probe.sock';
    const targets = resolveTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ name: 'main', pipe: '/tmp/probe.sock', method: 'hooks.signal' });
  });

  it('an override with no main token yields no target rather than a daemon fallback', () => {
    writeDaemonToken();
    process.env.WMUX_PIPE_NAME = '/tmp/probe.sock';
    expect(resolveTargets()).toEqual([]);
  });

  it('prefers the daemon-pipe HINT over the derived socket name', () => {
    // The hint records the socket the daemon actually bound, which differs after
    // a zombie-socket fallback rename.
    writeDaemonToken();
    writeFileSync(join(home, '.wmux', 'daemon-pipe'), '/tmp/renamed-daemon.sock\n', 'utf8');
    expect(getDaemonPipeName()).toBe('/tmp/renamed-daemon.sock');
  });

  it('reads the hint only from its OWN suffix namespace', () => {
    mkdirSync(join(home, '.wmux'), { recursive: true });
    writeFileSync(join(home, '.wmux', 'daemon-pipe'), '/tmp/prod.sock', 'utf8');
    process.env.WMUX_DATA_SUFFIX = '-dev';
    // No -dev hint exists → derive inside -dev, never adopt the production one.
    if (process.platform !== 'win32') {
      expect(getDaemonPipeName()).toBe(join(home, '.wmux-dev', 'daemon.sock'));
    } else {
      const user = userInfo().username || 'default';
      expect(getDaemonPipeName()).toBe(`\\\\.\\pipe\\wmux-daemon-dev-${user}`);
    }
  });
});

describe('shouldTryNextTarget — at-most-once delivery', () => {
  it('advances when nothing was reached and the write never happened', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'timeout', retryable: true })).toBe(true);
    expect(shouldTryNextTarget({ ok: false, error: 'no-target', retryable: true })).toBe(true);
  });

  it('STOPS on an outer-ok reply — that server owns the signal', () => {
    // Including an inner logical rejection: the lifecycle handler DID run, so
    // re-sending to main would double-deliver the same event.
    expect(shouldTryNextTarget({ id: 'req-1', ok: true, result: { ok: true } })).toBe(false);
    expect(shouldTryNextTarget({ id: 'req-1', ok: true, result: { ok: false, reason: 'no-workspace-match' } }))
      .toBe(false);
  });

  it('ADVANCES on a transport/auth refusal — an older daemon never ran the handler', () => {
    // A daemon that predates daemon.hooks.signal answers with outer ok=false and
    // no retryable=false marker. Falling back to main is the only way that
    // install keeps working, and it cannot double-deliver.
    expect(shouldTryNextTarget({ id: 'req-1', ok: false, error: 'unknown-method' })).toBe(true);
    expect(shouldTryNextTarget({ id: 'req-1', ok: false, error: 'unauthorized' })).toBe(true);
  });

  it('STOPS after an ambiguous post-write disconnect (may have been delivered)', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'closed-without-response', retryable: false })).toBe(false);
    expect(shouldTryNextTarget({ ok: false, error: 'timeout', retryable: false })).toBe(false);
  });
});

describe('win32 naming', () => {
  it('uses the suffixed named-pipe convention for both endpoints', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      process.env.WMUX_DATA_SUFFIX = '-dev';
      const user = userInfo().username || 'default';
      expect(getPipeName()).toBe(`\\\\.\\pipe\\wmux-dev-${user}`);
      expect(getDaemonPipeName()).toBe(`\\\\.\\pipe\\wmux-daemon-dev-${user}`);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});
