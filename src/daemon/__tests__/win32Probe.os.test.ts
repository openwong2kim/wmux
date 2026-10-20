import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1493: the Windows probes moved from wmic.exe to CIM through PowerShell.
// #2398: the per-process reads then moved to native calls. #2497: the boot ID
// moved to the registry boot counter (reg.exe). These pin the parsing and the fail-closed contract
// with a mocked execFile and native read; win32Probe.runtime.test.ts proves
// the real probes on a Windows box.
const { execFileMock, execFileSyncMock, tryProcessIdentityMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  tryProcessIdentityMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));
vi.mock('../../main/pty/winSnapshotNative', () => ({ tryProcessIdentity: tryProcessIdentityMock }));

import {
  classifyReapIdentity,
  getProcessCreatedAtFt,
  getProcessStartTime,
  getWin32BootId,
  getWin32BootIdSync,
  isShellExecutable,
  parseWin32BootId,
  readPosixStartTime,
  readProcessCreatedAtFt,
  readWin32ReapIdentity,
  resetNativeProcessReadWarn,
  resetWin32BootIdCache,
  setNativeProcessReadWarn,
} from '../phantomExit';

type Callback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function execFileReturns(stdout: string): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) => {
    cb(null, { stdout, stderr: '' });
  });
}

function execFileFails(message: string): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) => {
    cb(new Error(message));
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileSyncMock.mockReset();
  tryProcessIdentityMock.mockReset();
  resetWin32BootIdCache();
  resetNativeProcessReadWarn();
  setNativeProcessReadWarn(() => undefined);
});

const REG_OUT =
  '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters\r\n' +
  '    BootId    REG_DWORD    0x1a\r\n\r\n';

describe('parseWin32BootId', () => {
  it('reads the registry boot counter', () => {
    expect(parseWin32BootId(REG_OUT)).toBe('win32-boot-26');
  });

  it('rejects empty or malformed output', () => {
    expect(parseWin32BootId('')).toBeNull();
    expect(parseWin32BootId('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
    expect(parseWin32BootId('LastBootUpTime=20260915084549.500977+540')).toBeNull();
  });
});

describe('getWin32BootId', () => {
  // #2497: CIM LastBootUpTime moved with clock steps, so a same-boot restart
  // read as a reboot. The boot counter in the registry cannot move.
  it('queries the registry boot counter with reg.exe, not CIM', async () => {
    execFileReturns(REG_OUT);
    await expect(getWin32BootId()).resolves.toBe('win32-boot-26');
    const [file, args] = execFileMock.mock.calls[0];
    expect(String(file).toLowerCase()).toMatch(/\\system32\\reg\.exe$/);
    expect(args).toEqual(['query', expect.stringContaining('PrefetchParameters'), '/v', 'BootId']);
  });

  it('memoizes the first good read, sync and async alike', async () => {
    execFileReturns(REG_OUT);
    await getWin32BootId();
    await getWin32BootId();
    expect(getWin32BootIdSync()).toBe('win32-boot-26');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('throws on a probe failure so the caller keeps its fallback', async () => {
    execFileFails('spawn ENOENT');
    await expect(getWin32BootId()).rejects.toThrow();
  });

  it('throws on unparseable output instead of caching garbage', async () => {
    execFileReturns('');
    await expect(getWin32BootId()).rejects.toThrow();
    execFileReturns(REG_OUT);
    await expect(getWin32BootId()).resolves.toBe('win32-boot-26');
  });

  it('sync read parses the same output', () => {
    execFileSyncMock.mockReturnValue(REG_OUT);
    expect(getWin32BootIdSync()).toBe('win32-boot-26');
  });
});

// #2398: process start time and executable are read natively now.
const FT = 134296036801234567n; // 2026-07-27T05:28:00.1234567Z

function identityReturns(imagePath: string | null, createdAt = FT): void {
  tryProcessIdentityMock.mockReturnValue({ createdAt, imagePath });
}

const withPlatform = <T>(platform: NodeJS.Platform, body: () => T): T => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return body();
  } finally {
    if (orig) Object.defineProperty(process, 'platform', orig);
  }
};

describe('process start time', () => {
  it('is the native FILETIME, with no subprocess', async () => {
    identityReturns('C:\\x\\cmd.exe');
    expect(withPlatform('win32', () => getProcessCreatedAtFt(4321))).toBe(FT);
    await expect(withPlatform('win32', () => getProcessStartTime(4321))).resolves.toBe('134296036801234567');
    expect(tryProcessIdentityMock).toHaveBeenCalledWith(4321);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('is null when the read fails (fail closed)', () => {
    tryProcessIdentityMock.mockReturnValue({ failure: 'OpenProcess failed (error 5)', gone: false });
    expect(withPlatform('win32', () => getProcessCreatedAtFt(4321))).toBeNull();
  });

  it('says when the pid is gone, and only then', () => {
    tryProcessIdentityMock.mockReturnValue({ failure: 'OpenProcess failed (error 87)', gone: true });
    expect(withPlatform('win32', () => readProcessCreatedAtFt(4321))).toEqual({ value: null, gone: true });
    tryProcessIdentityMock.mockReturnValue({ failure: 'OpenProcess failed (error 5)', gone: false });
    expect(withPlatform('win32', () => readProcessCreatedAtFt(4321))).toEqual({ value: null, gone: false });
    identityReturns('C:\\x\\cmd.exe');
    expect(withPlatform('win32', () => readProcessCreatedAtFt(4321))).toEqual({ value: FT, gone: false });
  });

  it('is never read natively off Windows', () => {
    identityReturns('/bin/bash');
    expect(withPlatform('linux', () => getProcessCreatedAtFt(4321))).toBeNull();
    expect(tryProcessIdentityMock).not.toHaveBeenCalled();
  });
});

// `ps -o lstart= -p <pid>` exits 1 and prints nothing when no process has the pid.
describe('posix start time', () => {
  function psFails(error: { code?: unknown; stdout?: string; stderr?: string }): void {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Callback) => {
      cb(Object.assign(new Error('Command failed'), error));
    });
  }

  it('reads lstart', async () => {
    execFileReturns('Mon Jul 27 14:28:00 2026\n');
    await expect(readPosixStartTime(4321)).resolves.toEqual({ value: 'Mon Jul 27 14:28:00 2026', gone: false });
    expect(execFileMock.mock.calls[0][0]).toBe('ps');
  });

  it('a silent exit 1 means the pid is gone', async () => {
    psFails({ code: 1, stdout: '', stderr: '' });
    await expect(readPosixStartTime(4321)).resolves.toEqual({ value: null, gone: true });
  });

  it('any other failure is a failed read, not gone', async () => {
    psFails({ code: 'ENOENT' });
    await expect(readPosixStartTime(4321)).resolves.toEqual({ value: null, gone: false });
    psFails({ code: null, stdout: '', stderr: '' }); // killed by the timeout
    await expect(readPosixStartTime(4321)).resolves.toEqual({ value: null, gone: false });
    psFails({ code: 1, stdout: '', stderr: 'ps: error: unsupported option' });
    await expect(readPosixStartTime(4321)).resolves.toEqual({ value: null, gone: false });
  });
});

describe('failed native reads', () => {
  it('log one line a minute, counting the failures in between', () => {
    const warn = vi.fn();
    setNativeProcessReadWarn(warn);
    vi.useFakeTimers();
    try {
      tryProcessIdentityMock.mockReturnValue({ failure: 'OpenProcess failed (error 5)', gone: false });
      for (let pid = 1; pid <= 5; pid++) withPlatform('win32', () => getProcessCreatedAtFt(pid));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('pid 1: OpenProcess failed (error 5)');
      vi.advanceTimersByTime(60_000);
      withPlatform('win32', () => getProcessCreatedAtFt(6));
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1][0]).toContain('pid 6: OpenProcess failed (error 5) (4 more since the last warning)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('do not count a pid that is gone', () => {
    const warn = vi.fn();
    setNativeProcessReadWarn(warn);
    tryProcessIdentityMock.mockReturnValue({ failure: 'OpenProcess failed (error 87)', gone: true });
    expect(withPlatform('win32', () => getProcessCreatedAtFt(99))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('isShellExecutable', () => {
  it('matches the executable basename case-insensitively', () => {
    expect(isShellExecutable('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'PowerShell.exe')).toBe(true);
  });

  it('matches a full expected path', () => {
    expect(isShellExecutable('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe')).toBe(true);
  });

  it('rejects a different executable, or none', () => {
    expect(isShellExecutable('C:\\Windows\\System32\\notepad.exe', 'powershell.exe')).toBe(false);
    expect(isShellExecutable(null, 'cmd.exe')).toBe(false);
  });
});

// #2416: the reaper takes the creation time and the executable from ONE read.
describe('readWin32ReapIdentity', () => {
  it('reads the creation time and the executable together', () => {
    identityReturns('C:\\Windows\\System32\\cmd.exe');
    expect(readWin32ReapIdentity(21, 'cmd.exe')).toEqual({ currentCreatedAtFt: FT, currentGone: false, looksLikeOurShell: true });
    expect(tryProcessIdentityMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a failed read is no evidence, even if a second read would have succeeded', () => {
    tryProcessIdentityMock
      .mockReturnValueOnce({ failure: 'OpenProcess failed (error 5)', gone: false })
      .mockReturnValue({ createdAt: FT, imagePath: 'C:\\Windows\\System32\\cmd.exe' });
    const current = readWin32ReapIdentity(22, 'cmd.exe');
    expect(current).toEqual({ currentCreatedAtFt: null, currentGone: false, looksLikeOurShell: false });
    expect(tryProcessIdentityMock).toHaveBeenCalledTimes(1);
    // A record with no stored start time: the recycled-pid case must not be
    // killed on the executable name alone — not even if a separate executable
    // read had matched.
    expect(classifyReapIdentity(current)).toBe('unconfirmed');
    expect(classifyReapIdentity({ ...current, looksLikeOurShell: true })).toBe('unconfirmed');
  });

  it('says gone for a pid that no longer exists', () => {
    tryProcessIdentityMock.mockReturnValue({ failure: 'OpenProcess failed (error 87)', gone: true });
    expect(readWin32ReapIdentity(23, 'cmd.exe')).toEqual({ currentCreatedAtFt: null, currentGone: true, looksLikeOurShell: false });
  });
});

describe('start-time compatibility with pre-#2398 records', () => {
  it('a DMTF pidStartTime from the CIM/wmic era authorizes against the native FILETIME', () => {
    // CIM printed `20260727142800.123456+540` for this process: the same
    // instant in UTC+9, truncated to microseconds.
    expect(
      classifyReapIdentity({ storedStartTime: '20260727142800.123456+540', currentCreatedAtFt: FT, looksLikeOurShell: false }),
    ).toBe('start-time');
  });

  it('an unreadable start time still refuses the kill', () => {
    expect(
      classifyReapIdentity({ storedStartTime: '20260727142800.123456+540', currentCreatedAtFt: null, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });
});
