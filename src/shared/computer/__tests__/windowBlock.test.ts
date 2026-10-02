import { describe, expect, it } from 'vitest';
import { isFilesystemLocation, windowBlockReasonFor, windowRuleDependsOnLocation } from '../blocklist';

const EXPLORER = { path: 'c:\\windows\\explorer.exe' };

describe('explorer.exe windows', () => {
  it('allows a folder window on a filesystem path', () => {
    expect(windowBlockReasonFor(EXPLORER, { className: 'CabinetWClass', shellLocation: 'C:\\Users\\me\\Documents' })).toBeNull();
    expect(windowBlockReasonFor(EXPLORER, { className: 'CabinetWClass', shellLocation: '\\\\nas\\share\\docs' })).toBeNull();
  });

  it('blocks shell system surfaces and anything it cannot place', () => {
    const cases = [
      { className: 'CabinetWClass', shellLocation: '::{26EE0668-A00A-44D7-9371-BEB064C98683}' },
      { className: 'CabinetWClass', shellLocation: '::{26EE0668-A00A-44D7-9371-BEB064C98683}\\0' },
      { className: 'CabinetWClass' },
      { className: 'CabinetWClass', shellLocation: '' },
      { className: '#32770', shellLocation: 'C:\\Windows' },
      { className: 'Shell_TrayWnd' },
      { className: 'Progman' },
      {},
    ];
    for (const window of cases) expect(windowBlockReasonFor(EXPLORER, window)).toBe('system-tool');
  });

  it('leaves other apps to the app-level rule', () => {
    expect(windowBlockReasonFor({ path: 'c:\\windows\\notepad.exe' }, {})).toBeNull();
    expect(windowBlockReasonFor({ path: '/Applications/explorer.exe', bundleId: 'com.example.explorer' }, {})).toBeNull();
    expect(windowRuleDependsOnLocation(EXPLORER)).toBe(true);
    expect(windowRuleDependsOnLocation({ path: 'c:\\windows\\notepad.exe' })).toBe(false);
  });

  it('accepts only drive and UNC paths as filesystem locations', () => {
    expect(isFilesystemLocation('D:\\')).toBe(true);
    expect(isFilesystemLocation('\\\\server\\share')).toBe(true);
    expect(isFilesystemLocation('\\\\?\\C:\\x')).toBe(false);
    expect(isFilesystemLocation('\\\\.\\pipe\\x')).toBe(false);
    expect(isFilesystemLocation('shell:::{GUID}')).toBe(false);
    expect(isFilesystemLocation('C:relative')).toBe(false);
    expect(isFilesystemLocation(undefined)).toBe(false);
  });
});
