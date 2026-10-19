import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getWmuxHomeDir } from '../../shared/constants';
import { getWmuxDir } from '../../daemon/config';
import { TaskLedger, getTaskLedgerPath } from '../../daemon/ledger/TaskLedger';
import { getTaskLedger, setTaskLedgerForTests } from '../../main/deck/taskLedgerHost';
import { createFilePersister } from '../../main/factory/versionedFile';

describe('isolateDataDir setup', () => {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origDataSuffix = process.env.WMUX_DATA_SUFFIX;
  const origIsolated = process.env.WMUX_TEST_ISOLATED;

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;

    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;

    if (origDataSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = origDataSuffix;

    if (origIsolated === undefined) delete process.env.WMUX_TEST_ISOLATED;
    else process.env.WMUX_TEST_ISOLATED = origIsolated;
  });

  it('inside the suite os.homedir() is under the temp root (/tmp on POSIX) and WMUX_DATA_SUFFIX is -vitest', () => {
    // The setup realpaths the temp HOME, and on macOS os.tmpdir() is the
    // /var/folders symlink to /private/var/folders, so both sides go through
    // the same realpath. fs.realpathSync (the JS one the setup uses) rather
    // than .native: .native expands the Windows runner's 8.3 RUNNER~1 name.
    const norm = (p: string) =>
      fs.realpathSync(path.resolve(p)).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    const homedir = norm(os.homedir());
    // POSIX roots at /tmp so unix socket paths fit sun_path (see isolateDataDir).
    const tmpdir = norm(process.platform === 'win32' ? os.tmpdir() : '/tmp');
    expect(homedir.startsWith(`${tmpdir}/`)).toBe(true);
    expect(path.posix.basename(homedir).startsWith('wmux-test-')).toBe(true);
    expect(process.env.WMUX_DATA_SUFFIX).toBe('-vitest');
  });

  it('getWmuxHomeDir() does not equal the real home path', () => {
    const realHome = process.env.WMUX_TEST_REAL_HOME;
    expect(realHome).toBeDefined();
    if (!realHome) return;
    const wmuxHome = getWmuxHomeDir();
    const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    expect(norm(wmuxHome)).not.toBe(norm(realHome));
    expect(norm(wmuxHome)).not.toBe(norm(path.join(realHome, '.wmux')));
  });

  it('with WMUX_DATA_SUFFIX deleted and HOME/USERPROFILE set to WMUX_TEST_REAL_HOME, getWmuxHomeDir() throws the refusal', () => {
    const realHome = process.env.WMUX_TEST_REAL_HOME;
    expect(realHome).toBeDefined();
    if (!realHome) return;

    delete process.env.WMUX_DATA_SUFFIX;
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;

    expect(() => getWmuxHomeDir()).toThrow('Refusing to touch the live wmux data dir from a test');
    expect(() => getWmuxDir()).toThrow('Refusing to touch the live wmux data dir from a test');
  });

  it('without the isolate marker (a runner that bypassed the config) any home is refused when the suffix is empty', () => {
    expect(process.env.WMUX_TEST_ISOLATED).toBe('1');
    delete process.env.WMUX_TEST_ISOLATED;
    delete process.env.WMUX_DATA_SUFFIX;
    // HOME still points at the temp dir: the missing marker alone must be enough.
    expect(() => getWmuxHomeDir()).toThrow('Refusing to touch the live wmux data dir');
    expect(() => getWmuxDir()).toThrow('Refusing to touch the live wmux data dir');
  });

  it('without the isolate marker a non-empty data suffix is still allowed (rig lanes spawn with their own suffix)', () => {
    delete process.env.WMUX_TEST_ISOLATED;
    process.env.WMUX_DATA_SUFFIX = '-rig';
    expect(getWmuxHomeDir()).toMatch(/\.wmux-rig$/);
  });

  it('the hosted task ledger the fan-out tests use writes under the temp home, never the real one', async () => {
    setTaskLedgerForTests(null);
    try {
      await getTaskLedger().register({ id: 'wtask-isolation-probe', taskWorkspaceId: 'ws-task-1', ownerWorkspaceId: 'ws-ceo', title: 'A' });
      const file = getTaskLedgerPath(getWmuxDir());
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.realpathSync(file).startsWith(fs.realpathSync(os.homedir()))).toBe(true);
    } finally {
      setTaskLedgerForTests(null);
    }
  });

  it('a store handed a path inside the real ~/.wmux is refused (task ledger, factory files)', () => {
    const realHome = process.env.WMUX_TEST_REAL_HOME;
    expect(realHome).toBeDefined();
    if (!realHome) return;
    expect(() => new TaskLedger({ dir: path.join(realHome, '.wmux') })).toThrow('Refusing to touch the live wmux data dir from a test');
    expect(() => createFilePersister(path.join(realHome, '.wmux', 'factory', 'sessions.json'), () => ({}))).toThrow('Refusing to touch the live wmux data dir');
    // A suffixed sibling (a rig lane's own data dir) is not the live one.
    expect(() => createFilePersister(path.join(realHome, '.wmux-rig', 'factory', 'x.json'), () => ({}))).not.toThrow();
  });
});
