/**
 * #3280: the install hook relaunches the app through ShellExecute, never as
 * its own child, and not at all when Squirrel's firstrun does (squirrelRelaunch.ts).
 */
import { describe, it, expect } from 'vitest';
import { FIRSTRUN_RELAUNCH_ENV, hookShouldRelaunch, relaunchCommand } from '../squirrelRelaunch';

function decode(args: string[]): string {
  const at = args.indexOf('-EncodedCommand');
  expect(at).toBeGreaterThanOrEqual(0);
  return Buffer.from(args[at + 1], 'base64').toString('utf16le');
}

describe('hookShouldRelaunch', () => {
  it('relaunches unless the in-app updater said firstrun will', () => {
    expect(hookShouldRelaunch({})).toBe(true);
    expect(hookShouldRelaunch({ [FIRSTRUN_RELAUNCH_ENV]: '0' })).toBe(true);
    expect(hookShouldRelaunch({ [FIRSTRUN_RELAUNCH_ENV]: '1' })).toBe(false);
  });
});

describe('relaunchCommand', () => {
  const root = 'C:\\Windows';

  it('runs Windows PowerShell from the system root, hidden and without a profile', () => {
    const { file, args } = relaunchCommand('C:\\Users\\u\\AppData\\Local\\wmux\\app-4.16.0\\wmux.exe', root);
    expect(file.toLowerCase()).toBe('c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe');
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden']));
  });

  it('starts the exe with Start-Process (ShellExecute), the path a single-quoted literal', () => {
    const exe = 'C:\\Users\\u\\AppData\\Local\\wmux\\app-4.16.0\\wmux.exe';
    expect(decode(relaunchCommand(exe, root).args)).toBe(`Start-Process -FilePath '${exe}'`);
  });

  it('keeps an apostrophe, spaces, $ and a backtick inside the literal', () => {
    const exe = "C:\\Users\\O'Connor $x `y\\AppData\\Local\\wmux\\app-4.16.0\\wmux.exe";
    expect(decode(relaunchCommand(exe, root).args))
      .toBe("Start-Process -FilePath 'C:\\Users\\O''Connor $x `y\\AppData\\Local\\wmux\\app-4.16.0\\wmux.exe'");
  });
});
