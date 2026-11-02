import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Only terminateStagedDaemons reaches child_process here: the win32 runs below
// answer PowerShell and taskkill from this table.
const { exec } = vi.hoisted(() => ({
  exec: { powershell: (): string => '', taskkill: ((): void => undefined) as (pid: string) => void },
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFileSync = (file: string, args: string[]) => {
    if (String(file).includes('powershell')) return exec.powershell();
    if (String(file).includes('taskkill')) return exec.taskkill(args[1] ?? '');
    throw new Error(`unexpected exec ${file}`);
  };
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

import {
  classifyWmuxProcess,
  selectAppInstancePids,
  selectStagedDaemonPids,
  parseCimProcessJson,
  terminateRunningAppInstances,
  terminateStagedDaemons,
  type WmuxProcessRow,
} from '../squirrelTeardown';

// Pure classification/parsing for the #502 installer-time takeover: which
// same-image processes the Squirrel hook may kill. The kill boundary is the
// whole fix — killing the daemon would destroy the user's live sessions
// (persistence promise), killing a concurrent hook would wedge the install,
// and NOT killing the running app instance is the original crash.

const OWN_PID = 4000;
const EXE = 'C:\\Users\\me\\AppData\\Local\\wmux\\app-3.27.0\\wmux.exe';

const row = (pid: number, commandLine: string): WmuxProcessRow => ({ pid, commandLine });

describe('classifyWmuxProcess', () => {
  it('classifies the hook process itself as self (even with a --squirrel arg)', () => {
    expect(classifyWmuxProcess(row(OWN_PID, `"${EXE}" --squirrel-updated 3.28.0`), OWN_PID)).toBe('self');
  });

  it('classifies a plain GUI launch as app — the kill target', () => {
    expect(classifyWmuxProcess(row(1234, `"${EXE}"`), OWN_PID)).toBe('app');
  });

  it('classifies Chromium helper children as helper (they die with the parent tree-kill)', () => {
    expect(
      classifyWmuxProcess(row(1300, `"${EXE}" --type=renderer --user-data-dir="C:\\Users\\me\\AppData\\Roaming\\wmux"`), OWN_PID),
    ).toBe('helper');
    expect(classifyWmuxProcess(row(1301, `"${EXE}" --type=gpu-process`), OWN_PID)).toBe('helper');
  });

  it.each([
    'C:\\Users\\me\\AppData\\Local\\wmux\\app-3.27.0\\resources\\daemon-bundle\\index.js',
    'C:\\Users\\me\\AppData\\Local\\wmux\\app-3.27.0\\resources\\daemon\\daemon\\index.js',
    'C:\\Users\\me\\AppData\\Local\\wmux\\app-3.27.0\\resources\\daemon\\index.js',
    'C:/dev/wmux/dist/daemon-bundle/index.js',
  ])('classifies the daemon (script %s) as daemon — never killed', (script) => {
    expect(classifyWmuxProcess(row(2000, `"${EXE}" "${script}"`), OWN_PID)).toBe('daemon');
  });

  it('classifies concurrent Squirrel processes as squirrel-hook — never killed', () => {
    // The old exe handling --squirrel-obsolete mid-update…
    expect(classifyWmuxProcess(row(3000, `"${EXE}" --squirrel-obsolete 3.27.0`), OWN_PID)).toBe('squirrel-hook');
    // …and the fresh post-install launch of the NEW version.
    expect(classifyWmuxProcess(row(3001, `"${EXE}" --squirrel-firstrun`), OWN_PID)).toBe('squirrel-hook');
  });

  it('treats an unreadable (empty) command line as app — old instance must not survive', () => {
    expect(classifyWmuxProcess(row(1500, ''), OWN_PID)).toBe('app');
  });
});

describe('selectAppInstancePids', () => {
  it('returns only GUI app instances from a realistic mixed process table', () => {
    const rows: WmuxProcessRow[] = [
      row(OWN_PID, `"${EXE}" --squirrel-updated 3.28.0`), // this hook process
      row(1234, `"${EXE}"`), // the running old app — kill
      row(1300, `"${EXE}" --type=renderer`), // its helper
      row(1301, `"${EXE}" --type=gpu-process`), // its helper
      row(2000, `"${EXE}" "C:\\...\\resources\\daemon-bundle\\index.js"`), // daemon
      row(3000, `"${EXE}" --squirrel-obsolete 3.27.0`), // old exe's obsolete hook
    ];
    expect(selectAppInstancePids(rows, OWN_PID)).toEqual([1234]);
  });

  it('returns [] when nothing is running besides ourselves (fresh install)', () => {
    expect(selectAppInstancePids([row(OWN_PID, `"${EXE}" --squirrel-install 3.28.0`)], OWN_PID)).toEqual([]);
  });
});

describe('parseCimProcessJson', () => {
  it('parses ConvertTo-Json single-object output (one match)', () => {
    const out = JSON.stringify({ ProcessId: 1234, CommandLine: '"C:\\wmux\\wmux.exe"' });
    expect(parseCimProcessJson(out)).toEqual([{ pid: 1234, commandLine: '"C:\\wmux\\wmux.exe"' }]);
  });

  it('parses ConvertTo-Json array output (several matches)', () => {
    const out = '[{"ProcessId":1,"CommandLine":"a"},{"ProcessId":2,"CommandLine":"b"}]';
    expect(parseCimProcessJson(out)).toEqual([
      { pid: 1, commandLine: 'a' },
      { pid: 2, commandLine: 'b' },
    ]);
  });

  it('maps a null CommandLine (access denied / exited mid-query) to empty string', () => {
    expect(parseCimProcessJson('{"ProcessId":9,"CommandLine":null}')).toEqual([{ pid: 9, commandLine: '' }]);
  });

  it('returns [] for empty output (no matching process)', () => {
    expect(parseCimProcessJson('')).toEqual([]);
    expect(parseCimProcessJson('   \r\n')).toEqual([]);
  });

  it('returns [] on malformed JSON instead of throwing into the installer hook', () => {
    expect(parseCimProcessJson('INFO: not json')).toEqual([]);
  });

  it('drops rows without a valid positive integer ProcessId', () => {
    expect(parseCimProcessJson('[{"ProcessId":0,"CommandLine":"x"},{"CommandLine":"y"},{"ProcessId":"12","CommandLine":"z"}]')).toEqual([]);
  });
});

describe('terminateRunningAppInstances', () => {
  it('is a no-op off win32 (never enumerates or kills)', () => {
    // On the POSIX CI/dev hosts this suite runs on, the function must return
    // [] without touching PowerShell/taskkill. The win32 behavior is covered
    // by the pure classification tests above plus the index.ts wiring lock.
    if (process.platform !== 'win32') {
      expect(terminateRunningAppInstances()).toEqual([]);
    }
  });
});

describe('selectStagedDaemonPids (uninstall)', () => {
  const STAGE = 'C:\\Users\\me\\.wmux\\daemon-runtime';
  const staged = `${STAGE}\\4.13.0-1730000000000`;

  it('selects only daemons running from a staged copy', () => {
    const rows = [
      row(11, `"${staged}\\wmux.exe" "${staged}\\resources\\daemon-bundle\\index.js"`),
      row(12, `"${EXE}" "C:\\Users\\me\\AppData\\Local\\wmux\\app-3.27.0\\resources\\daemon-bundle\\index.js"`),
      row(13, `"${staged}\\wmux.exe" --type=gpu-process`),
      row(14, `"${EXE}"`),
    ];
    expect(selectStagedDaemonPids(rows, OWN_PID, STAGE)).toEqual([11]);
  });

  it('matches regardless of case, slash direction and a trailing separator', () => {
    const rows = [row(21, `${staged.toLowerCase().replace(/\\/g, '/')}/wmux.exe ${staged.replace(/\\/g, '/')}/resources/daemon-bundle/index.js`)];
    expect(selectStagedDaemonPids(rows, OWN_PID, `${STAGE}\\`)).toEqual([21]);
  });

  it('does not take a sibling folder that only shares the prefix', () => {
    const rows = [row(31, `"${STAGE}-old\\x\\wmux.exe" "${STAGE}-old\\x\\resources\\daemon-bundle\\index.js"`)];
    expect(selectStagedDaemonPids(rows, OWN_PID, STAGE)).toEqual([]);
  });
});

describe('terminateStagedDaemons (uninstall, win32)', () => {
  const STAGE = 'C:\\Users\\me\\.wmux\\daemon-runtime';
  const staged = `${STAGE}\\4.13.0-1730000000000`;
  const realPlatform = process.platform;
  const realExecPath = process.execPath;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // posix path.basename on this host: forward slashes.
    Object.defineProperty(process, 'execPath', { value: EXE.replace(/\\/g, '/'), configurable: true, writable: true });
    exec.powershell = () => '';
    exec.taskkill = () => undefined;
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true, writable: true });
  });

  it('returns [] only when the listing worked and found no staged daemon', () => {
    expect(terminateStagedDaemons(STAGE)).toEqual([]);
  });

  it('returns null, not [], when the processes cannot be listed', () => {
    exec.powershell = () => { throw new Error('Get-CimInstance failed'); };
    expect(terminateStagedDaemons(STAGE)).toBeNull();
    exec.powershell = () => 'Get-CimInstance : Invalid class';
    expect(terminateStagedDaemons(STAGE)).toBeNull();
  });

  it('returns a found daemon even when its kill failed, so the caller waits on it', () => {
    exec.powershell = () => JSON.stringify([
      { ProcessId: 11, CommandLine: `"${staged}\\wmux.exe" "${staged}\\resources\\daemon-bundle\\index.js"` },
      { ProcessId: 12, CommandLine: `"${staged}\\wmux.exe" "${staged}\\resources\\daemon-bundle\\index.js"` },
    ]);
    exec.taskkill = (pid) => { if (pid === '11') throw new Error('Access is denied.'); };
    expect(terminateStagedDaemons(STAGE)).toEqual([11, 12]);
  });
});
