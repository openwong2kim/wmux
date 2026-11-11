/**
 * Post-install reconcile decision (postInstallReconcile.ts).
 *
 * The Squirrel install hook is cancelled at ~15 s, often before our code runs
 * (antivirus holds the freshly written exe on first execution). These tests pin
 * what the next boot may redo, and above all what it must NOT redo: a user's
 * autostart opt-out and deleted shortcuts must survive every update.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  planPostInstallReconcile,
  isEmptyPlan,
  autostartTargetAlive,
  isOnPath,
  pinRepairDue,
  parsePinRepairMarker,
  readPinRepairMarker,
  writePinRepairMarker,
  PIN_REPAIR_MARKER,
  PIN_REPAIR_ATTEMPTS,
  type ReconcileProbe,
} from '../postInstallReconcile';
import { parseRunValue } from '../autostart';

const CUR = 'C:\\Users\\u\\AppData\\Local\\wmux\\app-3.62.1\\wmux.exe';
const OLD = 'C:\\Users\\u\\AppData\\Local\\wmux\\app-3.60.0\\wmux.exe';

/** A healthy install on an existing profile: nothing to do. */
function probe(over: Partial<ReconcileProbe> = {}): ReconcileProbe {
  return {
    firstRun: false,
    freshInstall: false,
    shimCurrent: true,
    binOnPath: true,
    autostartTarget: CUR,
    autostartTargetExists: true,
    desktopShortcutExists: true,
    ...over,
  };
}

describe('planPostInstallReconcile', () => {
  it('does nothing when the hook finished its work', () => {
    expect(isEmptyPlan(planPostInstallReconcile(probe()))).toBe(true);
    expect(isEmptyPlan(planPostInstallReconcile(probe({ firstRun: true })))).toBe(true);
  });

  it('reinstalls a missing CLI shim on any boot', () => {
    expect(planPostInstallReconcile(probe({ shimCurrent: false })).installCliShim).toBe(true);
    expect(planPostInstallReconcile(probe({ shimCurrent: false, firstRun: true })).installCliShim).toBe(true);
  });

  it('redoes the PATH edit when the shim exists but bin is not on PATH', () => {
    // The hook can be cancelled between writing wmux.cmd and editing PATH.
    expect(planPostInstallReconcile(probe({ binOnPath: false })).installCliShim).toBe(true);
  });

  it('retargets a Run value whose versioned exe was deleted by the install', () => {
    const plan = planPostInstallReconcile(probe({ autostartTarget: OLD, autostartTargetExists: false }));
    expect(plan.autostart).toBe('retarget');
  });

  it('leaves a Run value alone while its target still exists', () => {
    expect(planPostInstallReconcile(probe({ autostartTarget: OLD, autostartTargetExists: true })).autostart).toBeNull();
  });

  it('creates a missing Run value only on the firstrun of a fresh install', () => {
    expect(planPostInstallReconcile(probe({ autostartTarget: null, firstRun: true, freshInstall: true })).autostart)
      .toBe('enable');
  });

  it('never resurrects an autostart opt-out on an existing profile', () => {
    // Update or reinstall: absence may be the user's choice.
    expect(planPostInstallReconcile(probe({ autostartTarget: null, firstRun: true })).autostart).toBeNull();
    // Ordinary boot, even on a fresh profile: not an install moment.
    expect(planPostInstallReconcile(probe({ autostartTarget: null, freshInstall: true })).autostart).toBeNull();
  });

  it('creates a missing Desktop shortcut, only on the firstrun of a fresh install', () => {
    const plan = planPostInstallReconcile(probe({
      firstRun: true, freshInstall: true, desktopShortcutExists: false,
    }));
    expect(plan.shortcuts).toEqual(['Desktop']);
  });

  // #2971: the Start Menu entry is the app's own (Electron's toast setup writes
  // it at startup); one from Update.exe would be a second "wmux" entry.
  it('never asks Update.exe for a Start Menu link, even on a fresh install with none yet', () => {
    const plan = planPostInstallReconcile(probe({ firstRun: true, freshInstall: true }));
    expect(plan.shortcuts).toEqual([]);
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it('never brings back a shortcut the user deleted', () => {
    // Update firstrun on an existing profile.
    expect(planPostInstallReconcile(probe({ firstRun: true, desktopShortcutExists: false })).shortcuts).toEqual([]);
    // Ordinary boot.
    expect(planPostInstallReconcile(probe({ freshInstall: true, desktopShortcutExists: false })).shortcuts).toEqual([]);
  });
});

// #3263: the install hook never repairs pins on a first install, so the app
// repairs them once per installed version.
describe('pinRepairDue', () => {
  const real: NodeJS.ProcessEnv = {};
  const isolated: NodeJS.ProcessEnv = { WMUX_DATA_SUFFIX: '-verify' };

  it('repairs on the first boot of a version: no marker yet, or an older one', () => {
    expect(pinRepairDue(null, '4.16.0', real)).toBe(true);
    expect(pinRepairDue({ version: '4.15.0', failures: 0 }, '4.16.0', real)).toBe(true);
    expect(pinRepairDue({ version: '4.15.0', failures: 3 }, '4.16.0', real)).toBe(true);
  });

  it('does not repair again once the running version is marked', () => {
    expect(pinRepairDue({ version: '4.16.0', failures: 0 }, '4.16.0', real)).toBe(false);
  });

  it('retries a pass that could not run, up to the attempt cap', () => {
    expect(pinRepairDue({ version: '4.16.0', failures: 1 }, '4.16.0', real)).toBe(true);
    expect(pinRepairDue({ version: '4.16.0', failures: PIN_REPAIR_ATTEMPTS - 1 }, '4.16.0', real)).toBe(true);
    expect(pinRepairDue({ version: '4.16.0', failures: PIN_REPAIR_ATTEMPTS }, '4.16.0', real)).toBe(false);
  });

  it('never repairs from an isolated instance: pins are not per profile', () => {
    expect(pinRepairDue(null, '4.16.0', isolated)).toBe(false);
    expect(pinRepairDue({ version: '4.15.0', failures: 0 }, '4.16.0', isolated)).toBe(false);
    // An empty suffix is the real profile.
    expect(pinRepairDue(null, '4.16.0', { WMUX_DATA_SUFFIX: '' })).toBe(true);
  });
});

describe('pin repair marker', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pin-marker-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parses a done version and a version with failed attempts', () => {
    expect(parsePinRepairMarker('4.16.0')).toEqual({ version: '4.16.0', failures: 0 });
    expect(parsePinRepairMarker('4.16.0 2\n')).toEqual({ version: '4.16.0', failures: 2 });
    expect(parsePinRepairMarker('4.16.0-beta.1')).toEqual({ version: '4.16.0-beta.1', failures: 0 });
    expect(parsePinRepairMarker('  ')).toBeNull();
    expect(parsePinRepairMarker('4.16.0 two')).toBeNull();
  });

  it('reads back what was written, and null when missing or blank', () => {
    const userData = path.join(dir, 'profile');
    expect(readPinRepairMarker(userData)).toBeNull();
    writePinRepairMarker(userData, { version: '4.16.0', failures: 1 });
    expect(fs.readFileSync(path.join(userData, PIN_REPAIR_MARKER), 'utf8')).toBe('4.16.0 1');
    writePinRepairMarker(userData, { version: '4.16.0', failures: 0 });
    expect(fs.readFileSync(path.join(userData, PIN_REPAIR_MARKER), 'utf8')).toBe('4.16.0');
    expect(pinRepairDue(readPinRepairMarker(userData), '4.16.0', {})).toBe(false);
    fs.writeFileSync(path.join(userData, PIN_REPAIR_MARKER), '  \n');
    expect(readPinRepairMarker(userData)).toBeNull();
  });

  it('does not throw when the marker cannot be written', () => {
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    expect(() => writePinRepairMarker(path.join(blocker, 'profile'), { version: '4.16.0', failures: 0 })).not.toThrow();
  });
});

describe('isOnPath', () => {
  const BIN = 'C:\\Users\\u\\AppData\\Local\\wmux\\bin';

  it('matches case-insensitively and ignores a trailing separator', () => {
    expect(isOnPath(BIN, 'C:\\Windows;c:\\users\\U\\appdata\\local\\WMUX\\bin\\;C:\\x')).toBe(true);
  });

  it('does not match a prefix, a sibling, or an empty PATH', () => {
    expect(isOnPath(BIN, `${BIN}2;C:\\Windows`)).toBe(false);
    expect(isOnPath(BIN, 'C:\\Users\\u\\AppData\\Local\\wmux')).toBe(false);
    expect(isOnPath(BIN, undefined)).toBe(false);
  });
});

describe('autostartTargetAlive', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-reconcile-'));
    fs.mkdirSync(path.join(root, 'app-3.62.1'));
    fs.writeFileSync(path.join(root, 'app-3.62.1', 'wmux.exe'), '');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('checks the app-X.Y.Z tail under our root, not the printed prefix', () => {
    // reg.exe prints in the OEM code page: a non-ASCII profile path arrives garbled.
    expect(autostartTargetAlive('C:\\Users\\???\\AppData\\Local\\wmux\\app-3.62.1\\wmux.exe', root)).toBe(true);
    expect(autostartTargetAlive('C:\\Users\\???\\AppData\\Local\\wmux\\app-3.60.0\\wmux.exe', root)).toBe(false);
  });

  it('treats a value it did not write as alive, so it is never rewritten', () => {
    expect(autostartTargetAlive('C:\\Tools\\launcher.exe', root)).toBe(true);
  });
});

describe('parseRunValue', () => {
  it('reads the quoted exe path reg.exe prints', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      `    wmux    REG_SZ    "${CUR}"`,
      '',
    ].join('\r\n');
    expect(parseRunValue(out)).toBe(CUR);
  });

  it('accepts an unquoted value and REG_EXPAND_SZ', () => {
    expect(parseRunValue(`    wmux    REG_EXPAND_SZ    ${CUR}\r\n`)).toBe(CUR);
  });

  it('keeps spaces inside a quoted path and drops trailing arguments', () => {
    const spaced = 'C:\\Users\\A B\\AppData\\Local\\wmux\\app-1.0.0\\wmux.exe';
    expect(parseRunValue(`    wmux    REG_SZ    "${spaced}" --hidden\r\n`)).toBe(spaced);
  });

  it('returns null when there is no wmux value line', () => {
    expect(parseRunValue('')).toBeNull();
    expect(parseRunValue('    other    REG_SZ    "C:\\x.exe"\r\n')).toBeNull();
    expect(parseRunValue('    wmux    REG_SZ    ""\r\n')).toBeNull();
  });
});
