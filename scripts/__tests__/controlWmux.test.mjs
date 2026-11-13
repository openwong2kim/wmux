// The rules that keep the verify-wmux driver (scripts/control-wmux.mjs) off the
// owner's real wmux: which suffixes it may launch, which CDP port is "ours",
// and which inherited identity it must not pass to the launched instance.
// @wmux-lane unit
// packagedCliBundle takes the platform as an argument ('win32' is a string
// here); nothing in this file reads the host OS.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appIdentityHolds,
  claimOwnedBy,
  daemonIdentityHolds,
  darwinEnvPart,
  electronUserDataDir,
  envHasSuffix,
  findClaimedPort,
  launchAppArgs,
  launchdJobsFor,
  launchEnv,
  launchUserDataDirArg,
  ownedCdpPort,
  packagedCliBundle,
  parseCdpLog,
  parseConsoleLine,
  parseDaemonStatusPid,
  parseKillResults,
  parseLstart,
  parseProcessStart,
  parseUserDataLog,
  processStartQuery,
  purgeSuffixedData,
  releaseRecordedClaim,
  resolvedPath,
  resolveUserDataRecord,
  samePath,
  sameProcess,
  scrubEnv,
  signalProcess,
  stopRecordedApp,
  suffixRefusal,
  windowsKillQuery,
} from '../lib/control-wmux-lib.mjs';

describe('suffixRefusal', () => {
  it('refuses the main instance and the shared dev/portable suffixes', () => {
    expect(suffixRefusal('')).toMatch(/main wmux instance/);
    expect(suffixRefusal('-dev')).toMatch(/reserved/);
    expect(suffixRefusal('-portable')).toMatch(/reserved/);
  });

  it('accepts a private verification suffix and rejects path-unsafe ones', () => {
    expect(suffixRefusal('-verify-0bc4de')).toBeNull();
    expect(suffixRefusal('verify')).toMatch(/must look like/);
    expect(suffixRefusal('-x/../y')).toMatch(/must look like/);
  });
});

describe('CDP port discovery', () => {
  let dir;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('picks the claim whose pid is ours, never a neighbour in the range', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-claims-'));
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18801.lock'), '111');
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18829.lock'), '222\n');
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18850.lock'), '');
    expect(findClaimedPort(dir, 222)).toBe(18829);
    expect(findClaimedPort(dir, 333)).toBeNull();
    expect(claimOwnedBy(dir, 18829, 222)).toBe(true);
    expect(claimOwnedBy(dir, 18801, 222)).toBe(false);
  });

  it('reads requested / listening / disabled from the boot log', () => {
    expect(parseCdpLog('[WinMux] CDP requested on port 18829\n[WinMux] CDP listening on port 18829 (Chrome/146)')).toEqual({
      requested: 18829, listening: 18829, unverified: false, disabled: false,
    });
    expect(parseCdpLog('[WinMux] CDP disabled — browser automation will be unavailable').disabled).toBe(true);
    expect(parseCdpLog('[WinMux] CDP port 18829 is unverified; remote').unverified).toBe(true);
  });
});

describe('scrubEnv', () => {
  it('drops the parent pane identity and Claude session, then sets our suffix', () => {
    const env = scrubEnv({ PATH: '/bin', WMUX_PTY_ID: 'p', WMUX_DATA_SUFFIX: '', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }, '-verify-a');
    expect(env).toEqual({ PATH: '/bin', WMUX_DATA_SUFFIX: '-verify-a', WMUX_TEST_CDP_PORT: '1' });
  });
});

describe('launchEnv', () => {
  it('applies --env-file variables after the scrub, one spelling per name', () => {
    const { env } = launchEnv(
      { Path: 'C:\\Windows', WMUX_NO_PATH_REFRESH: '0', CLAUDECODE: '1' },
      '-verify-a',
      { PATH: 'C:\\fake;C:\\Windows', WMUX_NO_PATH_REFRESH: '1' },
    );
    expect(env).toEqual({ PATH: 'C:\\fake;C:\\Windows', WMUX_NO_PATH_REFRESH: '1', WMUX_DATA_SUFFIX: '-verify-a', WMUX_TEST_CDP_PORT: '1' });
  });

  it('never lets the file pick the suffix, and wants string values', () => {
    expect(launchEnv({}, '-verify-a', { wmux_data_suffix: '' }).refusal).toMatch(/--suffix/);
    expect(launchEnv({}, '-verify-a', { X: 1 }).refusal).toMatch(/must be a string/);
    expect(launchEnv({}, '-verify-a', ['x']).refusal).toMatch(/JSON object/);
  });

  it('refuses WMUX_MCP_REGISTER_EXTERNAL in any spelling: it writes the real agent configs', () => {
    expect(launchEnv({}, '-verify-a', { WMUX_MCP_REGISTER_EXTERNAL: '1' }).refusal).toMatch(/WMUX_MCP_REGISTER_EXTERNAL/);
    expect(launchEnv({}, '-verify-a', { wmux_mcp_register_external: '0' }).refusal).toMatch(/WMUX_MCP_REGISTER_EXTERNAL/);
    // Inherited, it never reaches the instance either: the scrub drops WMUX_*.
    expect(launchEnv({ WMUX_MCP_REGISTER_EXTERNAL: '1' }, '-verify-a', {}).env).toEqual({ WMUX_DATA_SUFFIX: '-verify-a', WMUX_TEST_CDP_PORT: '1' });
  });
});

describe('process identity (pid + creation time)', () => {
  it('reads one CIM row the way a whole-table listing does', () => {
    expect(processStartQuery(1234, 'win32').args.at(-1)).toContain('ProcessId=1234');
    expect(parseProcessStart('{"ProcessId":1234,"CreationDate":"\\/Date(1784777530054)\\/"}', 1234, 'win32')).toBe(1784777530054);
    // Another pid's row, no row (process gone), or garbage: unknown.
    expect(parseProcessStart('{"ProcessId":99,"CreationDate":"\\/Date(1)\\/"}', 1234, 'win32')).toBeNull();
    expect(parseProcessStart('', 1234, 'win32')).toBeNull();
    expect(parseProcessStart('nope', 1234, 'win32')).toBeNull();
  });

  it('reads ps lstart on POSIX', () => {
    expect(processStartQuery(42, 'darwin')).toEqual({ file: 'ps', args: ['-o', 'lstart=', '-p', '42'] });
    expect(parseProcessStart('Thu Oct 22 10:00:05 2026\n', 42, 'linux')).toBe(parseLstart('Thu  Oct 22 10:00:05 2026'));
    expect(parseProcessStart('', 42, 'linux')).toBeNull();
  });

  it('never builds a query for a non-pid', () => {
    expect(processStartQuery(0, 'win32')).toBeNull();
    expect(processStartQuery('1; Remove-Item x', 'win32')).toBeNull();
  });

  it('matches only the same pid with the same creation time', () => {
    const recorded = { pid: 10, createdAt: 1000 };
    expect(sameProcess(recorded, { pid: 10, createdAt: 1000 })).toBe(true);
    // The pid was reused by a process that started later.
    expect(sameProcess(recorded, { pid: 10, createdAt: 5000 })).toBe(false);
    // Gone (no creation time readable), or never recorded: no match.
    expect(sameProcess(recorded, { pid: 10, createdAt: null })).toBe(false);
    expect(sameProcess({ pid: 10, createdAt: undefined }, { pid: 10, createdAt: 1000 })).toBe(false);
  });
});

describe('packagedCliBundle', () => {
  it('finds the CLI bundle in each platform’s packaged layout', () => {
    expect(packagedCliBundle('/Applications/wmux.app/Contents/MacOS/wmux', 'darwin')).toBe('/Applications/wmux.app/Contents/Resources/cli-bundle/index.js');
    expect(packagedCliBundle('C:\\out\\wmux-win32-x64\\wmux.exe', 'win32')).toBe('C:\\out\\wmux-win32-x64\\resources\\cli-bundle\\index.js');
    expect(packagedCliBundle('/x/out/wmux-linux-x64/wmux', 'linux')).toBe('/x/out/wmux-linux-x64/resources/cli-bundle/index.js');
  });
});

describe('parseConsoleLine', () => {
  it('parses the Chromium console line shape', () => {
    expect(parseConsoleLine('[1:1012/072134.2:ERROR:CONSOLE:26] "boom", source: file:///a/b/main_window-x.js (26)')).toEqual({
      level: 'error', text: 'boom', source: 'main_window-x.js (26)',
    });
    expect(parseConsoleLine('[Main] not a console line')).toBeNull();
  });
});

describe('envHasSuffix', () => {
  it('matches only the exact suffix, in ps -E and /proc environ shapes', () => {
    expect(envHasSuffix('node daemon.js HOME=/x WMUX_DATA_SUFFIX=-verify-a PATH=/bin', '-verify-a')).toBe(true);
    expect(envHasSuffix('HOME=/x\0WMUX_DATA_SUFFIX=-verify-a\0', '-verify-a')).toBe(true);
    expect(envHasSuffix('WMUX_DATA_SUFFIX=-verify-ab PATH=/bin', '-verify-a')).toBe(false);
    expect(envHasSuffix('PATH=/bin', '-verify-a')).toBe(false);
  });
});

describe('parseDaemonStatusPid (daemon status --json)', () => {
  it('takes the pid only from a running answer', () => {
    expect(parseDaemonStatusPid('{"ok":true,"running":true,"status":"ok","pid":4242,"uptime":3}\n')).toBe(4242);
    expect(parseDaemonStatusPid('{"ok":false,"running":false,"error":"wmux is not running"}')).toBeNull();
    expect(parseDaemonStatusPid('{"ok":true,"running":true}')).toBeNull();
    expect(parseDaemonStatusPid('{"ok":true,"running":true,"pid":"4242"}')).toBeNull();
    expect(parseDaemonStatusPid('wmux daemon is running.')).toBeNull();
    expect(parseDaemonStatusPid('')).toBeNull();
  });
});

describe('daemonIdentityHolds: is daemon.pid this instance\'s daemon?', () => {
  const PID = 4242;
  const SUFFIX = '-verify-a';
  const probes = (over = {}) => ({
    pidAlive: () => true,
    pingPid: vi.fn(() => PID),
    envText: vi.fn(() => ''),
    ...over,
  });

  it('win32: accepts the pid the daemon on the suffixed pipe reports', () => {
    expect(daemonIdentityHolds({ pid: PID, suffix: SUFFIX }, probes(), 'win32')).toMatchObject({ ok: true, how: 'pipe' });
  });

  it('win32: refuses a reused pid (the suffixed pipe answers with another pid)', () => {
    const v = daemonIdentityHolds({ pid: PID, suffix: SUFFIX }, probes({ pingPid: () => 999 }), 'win32');
    expect(v).toMatchObject({ ok: false, how: null });
    expect(v.reason).toMatch(/pid 999, not daemon\.pid's 4242/);
  });

  it('win32: refuses when nothing answers on the suffixed pipe, and never trusts env text there', () => {
    const p = probes({ pingPid: () => null, envText: vi.fn(() => `WMUX_DATA_SUFFIX=${SUFFIX}`) });
    const v = daemonIdentityHolds({ pid: PID, suffix: SUFFIX }, p, 'win32');
    expect(v).toMatchObject({ ok: false, how: null });
    expect(v.reason).toMatch(/no daemon answered/);
    expect(p.envText).not.toHaveBeenCalled();
  });

  it('refuses when the ping probe throws', () => {
    const p = probes({ pingPid: () => { throw new Error('ETIMEDOUT'); } });
    expect(daemonIdentityHolds({ pid: PID, suffix: SUFFIX }, p, 'win32').ok).toBe(false);
  });

  it('refuses a dead pid without asking anything', () => {
    const p = probes({ pidAlive: () => false });
    expect(daemonIdentityHolds({ pid: PID, suffix: SUFFIX }, p, 'win32').ok).toBe(false);
    expect(p.pingPid).not.toHaveBeenCalled();
  });

  it('refuses a missing pid or suffix', () => {
    expect(daemonIdentityHolds({ pid: null, suffix: SUFFIX }, probes(), 'win32').ok).toBe(false);
    expect(daemonIdentityHolds({ pid: PID, suffix: '' }, probes(), 'win32').ok).toBe(false);
  });

  it('posix: the process environment still proves it when the pipe does not answer', () => {
    const p = probes({ pingPid: () => null, envText: () => `HOME=/x\0WMUX_DATA_SUFFIX=${SUFFIX}\0` });
    expect(daemonIdentityHolds({ pid: PID, suffix: SUFFIX }, p, 'darwin')).toMatchObject({ ok: true, how: 'env' });
  });

  it('posix: refuses a reused pid whose environment lacks the suffix', () => {
    const p = probes({ pingPid: () => 999, envText: () => 'HOME=/x\0WMUX_DATA_SUFFIX=\0' });
    expect(daemonIdentityHolds({ pid: PID, suffix: SUFFIX }, p, 'linux').ok).toBe(false);
  });
});

describe('Electron userData of a suffixed instance', () => {
  const W = path.win32.join;
  it('derives the per-platform default the way appInit and the CLI do', () => {
    const roaming = W('C:', 'Users', 'u', 'AppData', 'Roaming');
    expect(electronUserDataDir({ suffix: '-verify-a', env: { AppData: roaming }, home: W('C:', 'Users', 'u'), platform: 'win32' }))
      .toBe(W(roaming, 'wmux-verify-a'));
    expect(electronUserDataDir({ suffix: '-verify-a', env: {}, home: W('C:', 'Users', 'u'), platform: 'win32' }))
      .toBe(W(roaming, 'wmux-verify-a'));
    expect(electronUserDataDir({ suffix: '-verify-a', env: { HOME: '/Users/u' }, home: '/ignored', platform: 'darwin' }))
      .toBe('/Users/u/Library/Application Support/wmux-verify-a');
    expect(electronUserDataDir({ suffix: '-verify-a', env: { HOME: '/home/u' }, home: '/ignored', platform: 'linux' }))
      .toBe('/home/u/.config/wmux-verify-a');
    expect(electronUserDataDir({ suffix: '-verify-a', env: { HOME: '/home/u', XDG_CONFIG_HOME: '/cfg' }, home: '/home/u', platform: 'linux' }))
      .toBe('/cfg/wmux-verify-a');
  });

  it('appends the suffix to a --user-data-dir, as setPath does to whatever getPath returned', () => {
    expect(electronUserDataDir({ suffix: '-verify-a', home: '/h', platform: 'darwin', userDataDirArg: '/h/.wmux-verify-a/electron-user-data' }))
      .toBe('/h/.wmux-verify-a/electron-user-data-verify-a');
  });

  it('reads the path the app logs at boot', () => {
    const ud = W('C:', 'Users', 'u', 'AppData', 'Roaming', 'wmux-verify-a');
    const line = `[Main] WMUX_DATA_SUFFIX="-verify-a" → userData="${ud}"`;
    expect(parseUserDataLog(['noise', line, 'more'].join('\n'))).toEqual({ suffix: '-verify-a', userData: ud });
    expect(parseUserDataLog('[Main] something else')).toBeNull();
  });

  describe('the userData field launch and doctor print (resolveUserDataRecord)', () => {
    const roaming = W('C:', 'Users', 'u', 'AppData', 'Roaming');
    const predicted = { path: W(roaming, 'wmux-verify-a'), existedBeforeLaunch: false };
    const logLine = (ud) => `noise\n[Main] WMUX_DATA_SUFFIX="-verify-a" → userData="${ud}"\nmore`;

    it('is the path the app logged, not the prediction', () => {
      const actual = W('D:', 'elsewhere', 'wmux-verify-a');
      const rec = resolveUserDataRecord({ recorded: predicted, logged: parseUserDataLog(logLine(actual)), platform: 'win32' });
      expect(rec).toEqual({ path: actual, existedBeforeLaunch: null, predicted: predicted.path, source: 'logged' });
    });

    it('takes the logged spelling and keeps the pre-launch record when both name one dir', () => {
      const logged = W(roaming.toUpperCase(), 'wmux-verify-a');
      const rec = resolveUserDataRecord({ recorded: predicted, logged: parseUserDataLog(logLine(logged)), platform: 'win32' });
      expect(rec).toEqual({ path: logged, existedBeforeLaunch: false, source: 'logged' });
    });

    it('falls back to the prediction, labelled predicted, only when the line is absent', () => {
      expect(resolveUserDataRecord({ recorded: predicted, logged: parseUserDataLog('no such line'), platform: 'win32' }))
        .toEqual({ ...predicted, source: 'predicted' });
      expect(resolveUserDataRecord({ recorded: null, logged: null, platform: 'win32' })).toBeNull();
    });
  });
});

describe('samePath resolves links', () => {
  let root;
  let link;
  afterEach(() => {
    // The link itself first (rmdir/unlink), so cleanup never walks into its target.
    if (link) {
      if (process.platform === 'win32') fs.rmdirSync(link);
      else fs.unlinkSync(link);
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
    link = null;
  });

  it('matches a path through a linked tmp dir with its resolved form, existing or not yet', () => {
    // Everything inside this test's own temp dir: `real` stands in for
    // /private/tmp and `tmp` for the /tmp symlink (a junction on Windows).
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-samepath-'));
    const real = path.join(root, 'real');
    fs.mkdirSync(path.join(real, 'wmux-fr-x', 'electron-user-data-e2e'), { recursive: true });
    link = path.join(root, 'tmp');
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(samePath(path.join(link, 'wmux-fr-x', 'electron-user-data-e2e'), path.join(real, 'wmux-fr-x', 'electron-user-data-e2e'))).toBe(true);
    // userData the app has not created yet: no realpath of its own.
    expect(samePath(path.join(link, 'wmux-fr-x', 'not-yet', 'deeper'), path.join(real, 'wmux-fr-x', 'not-yet', 'deeper'))).toBe(true);
    expect(samePath(path.join(link, 'wmux-fr-x', 'a'), path.join(real, 'wmux-fr-x', 'b'))).toBe(false);
    expect(resolvedPath(path.join(link, 'wmux-fr-x', 'not-yet'))).toBe(path.join(fs.realpathSync.native(real), 'wmux-fr-x', 'not-yet'));
  });
});

describe('stop --purge (purgeSuffixedData)', () => {
  const suffix = '-verify-p1';
  let root;
  afterEach(() => {
    // Links first, by unlink/rmdir only, so cleanup never walks into a target.
    if (root) {
      for (const name of fs.readdirSync(root)) {
        const p = path.join(root, name);
        if (fs.lstatSync(p).isSymbolicLink()) removeDirLink(p);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
    root = null;
  });
  const setup = () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-purge-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    return home;
  };
  /** A directory link: a junction on Windows (no admin needed), a symlink elsewhere. */
  const dirLink = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  /** Remove the link itself, never what it points at. */
  const removeDirLink = (link) => (process.platform === 'win32' ? fs.rmdirSync(link) : fs.unlinkSync(link));

  it('purges userData this run created', () => {
    const home = setup();
    const ud = path.join(root, `wmux${suffix}`);
    fs.mkdirSync(path.join(ud, 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'session.json'), '{}');
    const r = purgeSuffixedData({ suffix, paths: [path.join(home, `.wmux${suffix}`)], userData: { path: ud, existedBeforeLaunch: false } });
    expect(r.removed).toEqual([ud]);
    expect(fs.existsSync(ud)).toBe(false);
  });

  it('keeps userData that existed before launch', () => {
    const home = setup();
    const ud = path.join(root, `wmux${suffix}`);
    fs.mkdirSync(ud);
    const r = purgeSuffixedData({ suffix, paths: [path.join(home, `.wmux${suffix}`)], userData: { path: ud, existedBeforeLaunch: true } });
    expect(r.removed).toEqual([]);
    expect(r.skipped).toEqual([{ path: ud, reason: 'userData existed before launch' }]);
    expect(fs.existsSync(ud)).toBe(true);
  });

  it('never deletes a userData that is a junction or symlink, nor its target', () => {
    const home = setup();
    const target = path.join(root, 'someone-elses');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
    const ud = path.join(root, `wmux${suffix}`);
    dirLink(target, ud);
    const r = purgeSuffixedData({ suffix, paths: [path.join(home, `.wmux${suffix}`)], userData: { path: ud, existedBeforeLaunch: false } });
    expect(r.removed).toEqual([]);
    expect(r.skipped[0].path).toBe(ud);
    expect(r.skipped[0].reason).toMatch(/symlink, junction/);
    expect(fs.lstatSync(ud).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('leaves a created dir in place when a link sits inside it', () => {
    const home = setup();
    const target = path.join(root, 'someone-elses');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
    const data = path.join(home, `.wmux${suffix}`);
    fs.mkdirSync(data);
    dirLink(target, path.join(data, 'linked'));
    const r = purgeSuffixedData({ suffix, paths: [data], userData: null });
    expect(r.removed).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/linked/);
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('x');
    removeDirLink(path.join(data, 'linked'));
  });

  it('skips userData when the state has no record (older driver), and reports it', () => {
    const home = setup();
    const ud = path.join(root, `wmux${suffix}`);
    fs.mkdirSync(ud);
    const data = path.join(home, `.wmux${suffix}`);
    fs.mkdirSync(data);
    const r = purgeSuffixedData({ suffix, paths: [data], preExisting: [], userData: undefined, legacyUserDataPath: ud });
    expect(r.removed).toEqual([data]);
    expect(r.skipped).toEqual([{ path: ud, reason: expect.stringMatching(/no pre-launch record/) }]);
    expect(fs.existsSync(ud)).toBe(true);
  });

  it('skips userData whose pre-launch state is unknown', () => {
    setup();
    const ud = path.join(root, `wmux${suffix}`);
    fs.mkdirSync(ud);
    const r = purgeSuffixedData({ suffix, paths: [], userData: { path: ud, existedBeforeLaunch: null } });
    expect(r.removed).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/unknown/);
    expect(fs.existsSync(ud)).toBe(true);
  });

  it('reports a path it could not remove and carries on with the rest', () => {
    const home = setup();
    const a = path.join(home, `.wmux${suffix}`);
    const b = path.join(home, `.wmux${suffix}-auth-token`);
    fs.mkdirSync(a);
    fs.writeFileSync(b, 't');
    const real = fs.rmSync;
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      if (p === a) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return real(p, o);
    });
    try {
      const r = purgeSuffixedData({ suffix, paths: [a, b], userData: null });
      expect(r.removed).toEqual([b]);
      expect(r.skipped).toEqual([{ path: a, reason: expect.stringMatching(/could not remove \(EPERM\)/) }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('skips userData already removed with the ~/.wmux<suffix> that held it', () => {
    const home = setup();
    const data = path.join(home, `.wmux${suffix}`);
    const ud = path.join(data, `electron-user-data${suffix}`);
    fs.mkdirSync(ud, { recursive: true });
    const r = purgeSuffixedData({ suffix, paths: [data], userData: { path: ud, existedBeforeLaunch: false } });
    expect(r.removed).toEqual([data]);
    expect(r.skipped).toEqual([]);
  });

  it('keeps a pre-existing suffixed path and never touches a name without the suffix', () => {
    const home = setup();
    const kept = path.join(home, `.wmux${suffix}`);
    const other = path.join(home, 'not-ours');
    fs.mkdirSync(kept);
    fs.mkdirSync(other);
    const r = purgeSuffixedData({ suffix, paths: [kept, other], preExisting: [kept], userData: null });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(kept) && fs.existsSync(other)).toBe(true);
  });
});

describe('launch app arguments', () => {
  it('macOS always gets the mock keychain; a --user-data-dir is passed through as one argument', () => {
    expect(launchAppArgs({ platform: 'darwin' })).toEqual(['--use-mock-keychain']);
    expect(launchAppArgs({ platform: 'darwin', userDataDirArg: '/tmp/s/electron-user-data' }))
      .toEqual(['--use-mock-keychain', '--user-data-dir=/tmp/s/electron-user-data']);
    expect(launchAppArgs({ platform: 'win32' })).toEqual([]);
    expect(launchAppArgs({ platform: 'win32', userDataDirArg: 'C:/s/u' })).toEqual(['--user-data-dir=C:/s/u']);
    // A clip stands in for the microphone, played once.
    expect(launchAppArgs({ platform: 'linux', fakeAudio: '/tmp/ko.wav' }))
      .toEqual(['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=/tmp/ko.wav%noloop', '--disable-features=AudioServiceSandbox']);
  });

  it('picks the caller’s dir, else the first launch’s, else on macOS one inside ~/.wmux<suffix>', () => {
    const base = { home: '/Users/u', suffix: '-verify-a' };
    expect(launchUserDataDirArg({ ...base, explicit: '/tmp/s/ud', platform: 'darwin' })).toBe('/tmp/s/ud');
    expect(launchUserDataDirArg({ ...base, previous: '/tmp/first', platform: 'darwin' })).toBe('/tmp/first');
    expect(launchUserDataDirArg({ ...base, previous: null, platform: 'darwin' })).toBeNull();
    expect(launchUserDataDirArg({ ...base, platform: 'darwin' })).toBe('/Users/u/.wmux-verify-a/electron-user-data');
    expect(launchUserDataDirArg({ ...base, platform: 'linux' })).toBeNull();
    expect(launchUserDataDirArg({ ...base, platform: 'win32' })).toBeNull();
  });
});

describe('Windows kill through a pinned handle (windowsKillQuery)', () => {
  it('builds nothing without a pid and a creation time', () => {
    expect(windowsKillQuery([])).toBeNull();
    expect(windowsKillQuery([{ pid: 12, createdAt: null }, { pid: 0, createdAt: 5 }])).toBeNull();
  });

  it('opens each handle before reading creation times, and kills only on a match', () => {
    const q = windowsKillQuery([{ pid: 4242, createdAt: 1792639189428 }]);
    expect(q.file).toBe('powershell.exe');
    const decoded = Buffer.from(q.args[q.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(decoded).toBe(q.script);
    expect(q.script).toContain('"pid":4242,"createdAt":1792639189428');
    const handle = q.script.indexOf('$null = $p.Handle');
    const cim = q.script.indexOf('Get-CimInstance Win32_Process -Filter');
    const compare = q.script.indexOf("$created[$id] -ne [long]$t.createdAt");
    const kill = q.script.indexOf('$p.Kill()');
    expect(handle).toBeGreaterThan(-1);
    expect(handle).toBeLessThan(cim);
    expect(cim).toBeLessThan(compare);
    expect(compare).toBeLessThan(kill);
    // The creation time goes through the same ConvertTo-Json pipeline as the recorded identity.
    expect(q.script).toContain('Select-Object CreationDate | ConvertTo-Json -Compress');
    expect(q.script).not.toMatch(/taskkill|Stop-Process/);
  });

  it('reads per-pid results, one row or many', () => {
    expect(parseKillResults('[{"pid":1,"result":"killed"},{"pid":2,"result":"mismatch"}]')).toEqual({ 1: 'killed', 2: 'mismatch' });
    expect(parseKillResults('{"pid":3,"result":"gone"}')).toEqual({ 3: 'gone' });
    expect(parseKillResults('not json')).toEqual({});
  });
});

describe('signalProcess', () => {
  const throwing = (code) => () => { throw Object.assign(new Error(code), { code }); };
  it('reports EPERM as denied and ESRCH as gone, and throws anything else', () => {
    expect(signalProcess(5, 'SIGTERM', () => true)).toBe('sent');
    expect(signalProcess(5, 'SIGTERM', throwing('EPERM'))).toBe('denied');
    expect(signalProcess(5, 'SIGTERM', throwing('ESRCH'))).toBe('gone');
    expect(() => signalProcess(5, 'SIGTERM', throwing('EINVAL'))).toThrow(/EINVAL/);
  });
});

describe('stop: ending the recorded app', () => {
  const state = { pid: 700, pidCreatedAt: 1000 };
  /** Fake process table: what startedAt sees, call by call. */
  const deps = ({ alive = true, starts = [1000], term = 'sent', dies = false, kills = {} } = {}) => {
    const calls = [];
    let i = 0;
    return {
      calls,
      pidAlive: () => alive,
      startedAt: () => starts[Math.min(i++, starts.length - 1)],
      signal: (pid, sig) => { calls.push(sig); return sig === 'SIGTERM' ? term : 'sent'; },
      waitDead: async () => dies,
      killByIdentity: async (targets) => { calls.push(['handle', targets]); return kills; },
    };
  };

  it('identity: only the same pid with the same creation time', () => {
    expect(appIdentityHolds(state, deps())).toBe(true);
    expect(appIdentityHolds(state, deps({ starts: [999] }))).toBe(false);
    expect(appIdentityHolds(state, deps({ alive: false }))).toBe(false);
    expect(appIdentityHolds({ pid: 700, pidCreatedAt: null }, deps())).toBe(false);
  });

  it('never signals a pid now held by another process', async () => {
    const d = deps({ starts: [1234] });
    expect(await stopRecordedApp(state, d, 'linux')).toMatch(/now another process/);
    expect(d.calls).toEqual([]);
  });

  it('never signals without a recorded creation time', async () => {
    const d = deps();
    expect(await stopRecordedApp({ pid: 700, pidCreatedAt: null }, d, 'darwin')).toMatch(/no creation time recorded/);
    expect(d.calls).toEqual([]);
  });

  it('skips a process it may not signal (EPERM)', async () => {
    const d = deps({ term: 'denied' });
    expect(await stopRecordedApp(state, d, 'linux')).toMatch(/not permitted to signal/);
    expect(d.calls).toEqual(['SIGTERM']);
  });

  it('re-checks the identity before SIGKILL, and skips it when the pid changed hands', async () => {
    const d = deps({ starts: [1000, 1001] });
    expect(await stopRecordedApp(state, d, 'linux')).toMatch(/identity or permission lost, not killed/);
    expect(d.calls).toEqual(['SIGTERM']);
  });

  it('SIGKILLs after the SIGTERM timeout only while the identity still holds', async () => {
    const d = deps({ starts: [1000, 1000] });
    expect(await stopRecordedApp(state, d, 'darwin')).toMatch(/SIGKILL after SIGTERM timeout/);
    expect(d.calls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('Windows: one pinned-handle kill, never a signal on the bare pid', async () => {
    const killed = deps({ kills: { 700: 'killed' } });
    expect(await stopRecordedApp(state, killed, 'win32')).toMatch(/handle pinned to its recorded creation time/);
    expect(killed.calls).toEqual([['handle', [{ pid: 700, createdAt: 1000 }]]]);
    const reused = deps({ kills: { 700: 'mismatch' } });
    expect(await stopRecordedApp(state, reused, 'win32')).toMatch(/now another process/);
    expect(reused.calls.filter((c) => typeof c === 'string')).toEqual([]);
  });
});

describe('darwinEnvPart (ps -E)', () => {
  it('matches the environment only, never an argument that looks like it', () => {
    const args = '/usr/bin/node daemon.js WMUX_DATA_SUFFIX=-verify-a';
    const withEnv = `${args} HOME=/Users/u PATH=/bin\n`;
    const env = darwinEnvPart(withEnv, `${args}\n`);
    expect(env).toBe(' HOME=/Users/u PATH=/bin');
    expect(envHasSuffix(env, '-verify-a')).toBe(false);
    expect(envHasSuffix(darwinEnvPart(`${args} WMUX_DATA_SUFFIX=-verify-a HOME=/x`, args), '-verify-a')).toBe(true);
  });

  it('gives nothing when the two listings do not line up', () => {
    expect(darwinEnvPart('other WMUX_DATA_SUFFIX=-verify-a', 'node daemon.js')).toBe('');
    expect(darwinEnvPart('node WMUX_DATA_SUFFIX=-verify-a', '')).toBe('');
  });
});

describe('launchdJobsFor', () => {
  it('lists only this suffix’s daemon jobs, with their pid when running', () => {
    const list = [
      'PID\tStatus\tLabel',
      '-\t0\tcom.wmux.daemon-verify-a.1',
      '4321\t0\tcom.wmux.daemon-verify-a.2',
      '-\t0\tcom.wmux.daemon-verify-ab.1',
      '-\t0\tcom.wmux.daemon.1',
    ].join('\n');
    expect(launchdJobsFor(list, '-verify-a')).toEqual([
      { label: 'com.wmux.daemon-verify-a.1', pid: null },
      { label: 'com.wmux.daemon-verify-a.2', pid: 4321 },
    ]);
    expect(launchdJobsFor(list, '')).toEqual([]);
  });
});

describe('ownedCdpPort', () => {
  let dir;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('trusts the port the app logged over a stale claim that names a reused pid', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-owned-'));
    // An earlier process with the same pid left 18801 behind; the app took 18830.
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18801.lock'), '29944');
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18830.lock'), '29944');
    expect(ownedCdpPort(dir, 29944, 18830)).toBe(18830);
    // Logged, but the claim does not name us (yet): no port.
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18831.lock'), '1');
    expect(ownedCdpPort(dir, 29944, 18831)).toBeNull();
  });

  it('has no port until the app logs "CDP requested", even when a stale claim names the pid', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-owned-'));
    fs.writeFileSync(path.join(dir, 'wmux-cdp-18801.lock'), '29944');
    expect(findClaimedPort(dir, 29944)).toBe(18801);
    expect(ownedCdpPort(dir, 29944, null)).toBeNull();
    expect(ownedCdpPort(dir, 29944, parseCdpLog('[WinMux] starting').requested)).toBeNull();
  });
});

describe('releaseRecordedClaim', () => {
  let dir;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });
  const claim = (port) => path.join(dir, `wmux-cdp-${port}.lock`);
  const gone = { pidAlive: () => false, startedAt: () => null };
  const mkdir = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cdp-release-')); };

  it('removes the recorded port claim once its pid is gone', () => {
    mkdir();
    fs.writeFileSync(claim(18830), '29944 uptime=1200');
    expect(releaseRecordedClaim(dir, { port: 18830, pid: 29944 }, gone)).toMatch(/18830: removed .*which is gone/);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(releaseRecordedClaim(dir, { port: 18830, pid: 29944 }, gone)).toMatch(/already gone/);
  });

  it('leaves a claim that names another pid, or holds none', () => {
    mkdir();
    fs.writeFileSync(claim(18830), '31000 uptime=5');
    expect(releaseRecordedClaim(dir, { port: 18830, pid: 29944 }, gone)).toMatch(/names pid 31000, not 29944/);
    fs.writeFileSync(claim(18831), '');
    expect(releaseRecordedClaim(dir, { port: 18831, pid: 29944 }, gone)).toMatch(/holds no pid/);
    expect(fs.readdirSync(dir).sort()).toEqual(['wmux-cdp-18830.lock', 'wmux-cdp-18831.lock']);
    expect(fs.readFileSync(claim(18830), 'utf8')).toBe('31000 uptime=5');
  });

  it('removes it when the pid now belongs to a process started after the claim was written', () => {
    mkdir();
    fs.writeFileSync(claim(18830), '29944');
    const written = fs.statSync(claim(18830)).mtimeMs;
    // The app itself, still running: it started before it wrote the claim.
    expect(releaseRecordedClaim(dir, { port: 18830, pid: 29944 }, { pidAlive: () => true, startedAt: () => written - 500 })).toMatch(/still running/);
    // A creation time it cannot read is no proof either.
    expect(releaseRecordedClaim(dir, { port: 18830, pid: 29944 }, { pidAlive: () => true, startedAt: () => null })).toMatch(/still running/);
    expect(fs.existsSync(claim(18830))).toBe(true);
    expect(releaseRecordedClaim(dir, { port: 18830, pid: 29944 }, { pidAlive: () => true, startedAt: () => written + 1000 })).toMatch(/removed .*started after it was written/);
    expect(fs.existsSync(claim(18830))).toBe(false);
  });

  it('puts back a claim another wmux wrote after the check', () => {
    mkdir();
    fs.writeFileSync(claim(18830), '29944');
    // Another instance replaces the stale claim between the check and the rename.
    const racing = { pidAlive: () => { fs.writeFileSync(claim(18830), '31000 uptime=9'); return false; }, startedAt: () => null };
    expect(releaseRecordedClaim(dir, { port: 18830, pid: 29944 }, racing)).toMatch(/names pid 31000/);
    expect(fs.readdirSync(dir)).toEqual(['wmux-cdp-18830.lock']);
    expect(fs.readFileSync(claim(18830), 'utf8')).toBe('31000 uptime=9');
    // Same pid, but written again since the check: not the file that was checked.
    fs.writeFileSync(claim(18831), '29944');
    const rewrite = { pidAlive: () => { const t = new Date(Date.now() + 60_000); fs.utimesSync(claim(18831), t, t); return false; }, startedAt: () => null };
    expect(releaseRecordedClaim(dir, { port: 18831, pid: 29944 }, rewrite)).toMatch(/rewritten meanwhile/);
    expect(fs.existsSync(claim(18831))).toBe(true);
  });

  it('never looks a claim up by pid when the port is unknown', () => {
    mkdir();
    fs.writeFileSync(claim(18842), '29944');
    expect(releaseRecordedClaim(dir, { port: null, pid: 29944 }, gone)).toMatch(/never logged its port/);
    expect(releaseRecordedClaim(dir, { port: 18842, pid: null }, gone)).toMatch(/no recorded pid/);
    expect(fs.existsSync(claim(18842))).toBe(true);
  });
});
