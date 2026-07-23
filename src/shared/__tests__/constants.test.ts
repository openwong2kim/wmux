import { afterEach, describe, expect, it } from 'vitest';
import {
  dataSuffix,
  getPipeName,
  getAuthTokenPath,
  getWmuxHomeDir,
  getPidMapDir,
  getTcpPortPath,
  getDaemonAuthTokenPath,
  getLegacyDaemonAuthTokenPath,
} from '../constants';

// WMUX_DATA_SUFFIX instance isolation. Prevents dev and packaged builds (or builds from
// different checkouts) from colliding on the same socket·token·~/.fmux.
describe('dataSuffix instance isolation', () => {
  const orig = process.env.WMUX_DATA_SUFFIX;
  afterEach(() => {
    if (orig === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = orig;
  });

  it('keeps legacy paths when suffix unset (packaged default)', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    expect(dataSuffix()).toBe('');
    expect(getAuthTokenPath()).toMatch(/\.fmux-auth-token$/);
    expect(getWmuxHomeDir()).toMatch(/\.fmux$/);
    expect(getPidMapDir()).toMatch(/\.fmux[\\/]pid-map$/);
    if (process.platform !== 'win32') {
      expect(getPipeName()).toMatch(/\.fmux\.sock$/);
    }
  });

  it('applies isolation to all paths (socket/token/home/pid-map/tcp) when suffix set', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(dataSuffix()).toBe('-dev');
    expect(getAuthTokenPath()).toMatch(/\.fmux-dev-auth-token$/);
    expect(getWmuxHomeDir()).toMatch(/\.fmux-dev$/);
    expect(getPidMapDir()).toMatch(/\.fmux-dev[\\/]pid-map$/);
    expect(getTcpPortPath()).toMatch(/\.fmux-dev-tcp-port$/);
    if (process.platform === 'win32') {
      expect(getPipeName()).toContain('fmux-dev-');
    } else {
      expect(getPipeName()).toMatch(/\.fmux-dev\.sock$/);
    }
  });

  it('core invariant: packaged and dev paths never overlap', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    const packagedPipe = getPipeName();
    const packagedHome = getWmuxHomeDir();
    const packagedToken = getAuthTokenPath();

    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(getPipeName()).not.toBe(packagedPipe);
    expect(getWmuxHomeDir()).not.toBe(packagedHome);
    expect(getAuthTokenPath()).not.toBe(packagedToken);
  });
});

// The daemon control-pipe auth token. Unlike the main token (a
// ~/.fmux${suffix}-auth-token FILE) this lives INSIDE the ~/.fmux dir, so the
// suffix rides on the DIRECTORY. The daemon WRITES it, the launcher + CLI READ
// it — all three route through getDaemonAuthTokenPath so they cannot drift.
describe('daemon auth token path (suffix-aware, 3-way lockstep)', () => {
  const orig = process.env.WMUX_DATA_SUFFIX;
  afterEach(() => {
    if (orig === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = orig;
  });

  it('default (no suffix) is byte-identical to the legacy path — no stranding on upgrade', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    expect(getDaemonAuthTokenPath()).toBe(getLegacyDaemonAuthTokenPath());
    expect(getDaemonAuthTokenPath()).toMatch(/\.fmux[\\/]daemon-auth-token$/);
  });

  it('lives inside the suffix-aware home dir (co-located with config.json / daemon pipe)', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    expect(getDaemonAuthTokenPath()).toBe(`${getWmuxHomeDir()}/daemon-auth-token`);
  });

  it('a suffix isolates the token from production; the legacy fallback stays unsuffixed', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(getDaemonAuthTokenPath()).toMatch(/\.fmux-dev[\\/]daemon-auth-token$/);
    // Isolation: a suffixed instance must NOT resolve to the shared prod file.
    expect(getDaemonAuthTokenPath()).not.toBe(getLegacyDaemonAuthTokenPath());
    expect(getLegacyDaemonAuthTokenPath()).toMatch(/\.fmux[\\/]daemon-auth-token$/);
    expect(getLegacyDaemonAuthTokenPath()).not.toContain('.fmux-dev');
  });
});

// P7 — move daemon/session sockets under ~/.fmux{suffix}/. Binder (daemon) and
// clients (main/cli) all use this helper, so path shape is fixed here.
describe('P7 socket paths (under ~/.fmux + sun_path limit)', () => {
  const orig = process.env.WMUX_DATA_SUFFIX;
  afterEach(() => {
    if (orig === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = orig;
  });

  it('new sockets under ~/.fmux{suffix}/; legacy stays home-direct form', async () => {
    if (process.platform === 'win32') return; // named pipe not subject to path rules
    // Mock HOME to a deterministic short value so the socket-path length assert
    // below doesn't depend on the real $HOME (flaky on CI with long profile
    // names). getWmuxHomeDir prefers USERPROFILE over HOME, so drop USERPROFILE
    // to make HOME authoritative. Both are restored in the finally.
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = '/tmp/wmux-test-home';
    delete process.env.USERPROFILE;
    delete process.env.WMUX_DATA_SUFFIX;
    try {
      const {
        getDaemonSocketPath, getLegacyDaemonSocketPath,
        getSessionSocketPath, getLegacySessionSocketPath, getWmuxHomeDir,
      } = await import('../constants');
      const sessionId = '123e4567-e89b-42d3-a456-426614174000'; // uuid 36 chars
      expect(getDaemonSocketPath()).toBe(`${getWmuxHomeDir()}/daemon.sock`);
      expect(getSessionSocketPath(sessionId)).toBe(`${getWmuxHomeDir()}/session-${sessionId}.sock`);
      // Legacy path must be byte-identical to old code for fallback/migration checks
      expect(getLegacyDaemonSocketPath()).toMatch(/\/\.fmux-daemon\.sock$/);
      expect(getLegacySessionSocketPath(sessionId)).toMatch(/\/\.fmux-session-.*\.sock$/);
      // sun_path 104-byte limit (macOS) — verify headroom with uuid session id
      expect(Buffer.byteLength(getSessionSocketPath(sessionId))).toBeLessThanOrEqual(104);
      // suffix only on directory (no duplicate filename → shorter path)
      process.env.WMUX_DATA_SUFFIX = '-dev';
      expect(getDaemonSocketPath()).toMatch(/\/\.fmux-dev\/daemon\.sock$/);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    }
  });
});
