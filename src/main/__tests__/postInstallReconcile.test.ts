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
    shimExists: true,
    binOnPath: true,
    autostartTarget: CUR,
    autostartTargetExists: true,
    desktopShortcutExists: true,
    startMenuShortcutExists: true,
    ...over,
  };
}

describe('planPostInstallReconcile', () => {
  it('does nothing when the hook finished its work', () => {
    expect(isEmptyPlan(planPostInstallReconcile(probe()))).toBe(true);
    expect(isEmptyPlan(planPostInstallReconcile(probe({ firstRun: true })))).toBe(true);
  });

  it('reinstalls a missing CLI shim on any boot', () => {
    expect(planPostInstallReconcile(probe({ shimExists: false })).installCliShim).toBe(true);
    expect(planPostInstallReconcile(probe({ shimExists: false, firstRun: true })).installCliShim).toBe(true);
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

  it('creates only the missing shortcuts, only on the firstrun of a fresh install', () => {
    const plan = planPostInstallReconcile(probe({
      firstRun: true, freshInstall: true, desktopShortcutExists: false,
    }));
    expect(plan.shortcuts).toEqual(['Desktop']);
    expect(planPostInstallReconcile(probe({
      firstRun: true, freshInstall: true, desktopShortcutExists: false, startMenuShortcutExists: false,
    })).shortcuts).toEqual(['Desktop', 'StartMenu']);
  });

  it('never brings back a shortcut the user deleted', () => {
    // Update firstrun on an existing profile.
    expect(planPostInstallReconcile(probe({ firstRun: true, desktopShortcutExists: false })).shortcuts).toEqual([]);
    // Ordinary boot.
    expect(planPostInstallReconcile(probe({ freshInstall: true, desktopShortcutExists: false })).shortcuts).toEqual([]);
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
