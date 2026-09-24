import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1493: the Windows probes moved from wmic.exe to CIM through PowerShell.
// These pin the parsing and the fail-closed contract with a mocked execFile;
// win32Probe.runtime.test.ts proves the real probes on a Windows box.
const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import {
  classifyReapIdentity,
  getWin32BootId,
  getWin32BootIdSync,
  isWin32ShellProcess,
  parseWin32BootId,
  parseWin32ProcessInfo,
  probeWin32Process,
  resetWin32BootIdCache,
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
  resetWin32BootIdCache();
});

describe('parseWin32BootId', () => {
  it('reads the wmic-format DMTF boot time', () => {
    expect(parseWin32BootId('LastBootUpTime=20260915084549.500977+540\r\n')).toBe(
      '20260915084549.500977+540',
    );
  });

  it('accepts a negative UTC offset', () => {
    expect(parseWin32BootId('LastBootUpTime=20260915084549.500977-420')).toBe(
      '20260915084549.500977-420',
    );
  });

  it('rejects empty or malformed output', () => {
    expect(parseWin32BootId('')).toBeNull();
    expect(parseWin32BootId('LastBootUpTime=')).toBeNull();
    expect(parseWin32BootId('LastBootUpTime=9/15/2026 8:45:49 AM')).toBeNull();
  });
});

describe('getWin32BootId', () => {
  it('runs Windows PowerShell with a CIM query, never wmic', async () => {
    execFileReturns('LastBootUpTime=20260915084549.500977+540\r\n');
    await expect(getWin32BootId()).resolves.toBe('20260915084549.500977+540');
    const [file, args] = execFileMock.mock.calls[0];
    expect(String(file).toLowerCase()).toMatch(/windowspowershell\\v1\.0\\powershell\.exe$/);
    expect(String(file).toLowerCase()).not.toContain('wmic');
    expect(args.join(' ')).toContain('Win32_OperatingSystem');
  });

  it('memoizes the first good read, sync and async alike', async () => {
    execFileReturns('LastBootUpTime=20260915084549.500977+540');
    await getWin32BootId();
    await getWin32BootId();
    expect(getWin32BootIdSync()).toBe('20260915084549.500977+540');
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
    execFileReturns('LastBootUpTime=20260915084549.500977+540');
    await expect(getWin32BootId()).resolves.toBe('20260915084549.500977+540');
  });

  it('sync read parses the same output', () => {
    execFileSyncMock.mockReturnValue('LastBootUpTime=20260915084549.500977+540\r\n');
    expect(getWin32BootIdSync()).toBe('20260915084549.500977+540');
  });
});

describe('parseWin32ProcessInfo', () => {
  it('reads executable path and DMTF creation date', () => {
    expect(
      parseWin32ProcessInfo(
        'ExecutablePath=C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n' +
          'CreationDate=20260924205809.260729+540\r\n',
      ),
    ).toEqual({
      executablePath: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      creationDate: '20260924205809.260729+540',
    });
  });

  it('keeps the creation date when CIM withholds the executable path', () => {
    expect(parseWin32ProcessInfo('ExecutablePath=\r\nCreationDate=20260924205809.260729+540')).toEqual({
      executablePath: null,
      creationDate: '20260924205809.260729+540',
    });
  });

  it('is null when the process was not found (no output)', () => {
    expect(parseWin32ProcessInfo('')).toBeNull();
  });

  it('drops a creation date that is not DMTF', () => {
    expect(parseWin32ProcessInfo('ExecutablePath=C:\\x\\cmd.exe\r\nCreationDate=garbage')).toEqual({
      executablePath: 'C:\\x\\cmd.exe',
      creationDate: null,
    });
  });
});

describe('probeWin32Process', () => {
  it('null on probe failure or timeout (fail closed)', async () => {
    execFileFails('Command failed: timeout');
    await expect(probeWin32Process(1234)).resolves.toBeNull();
  });

  it('null for an invalid pid without spawning', async () => {
    await expect(probeWin32Process(0)).resolves.toBeNull();
    await expect(probeWin32Process(-1)).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('filters CIM on the exact pid', async () => {
    execFileReturns('ExecutablePath=C:\\x\\cmd.exe\r\nCreationDate=20260924205809.260729+540');
    await probeWin32Process(4321);
    expect(execFileMock.mock.calls[0][1].join(' ')).toContain('"ProcessId=4321"');
  });

  it('concurrent asks for the same pid share one spawn', async () => {
    execFileReturns('ExecutablePath=C:\\x\\cmd.exe\r\nCreationDate=20260924205809.260729+540');
    const [a, b] = await Promise.all([probeWin32Process(77), probeWin32Process(77)]);
    expect(a).toEqual(b);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('caps concurrent PowerShell spawns', async () => {
    const pending: Callback[] = [];
    execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Callback) => {
      pending.push(cb);
    });
    const probes = [101, 102, 103, 104, 105, 106].map((pid) => probeWin32Process(pid));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execFileMock).toHaveBeenCalledTimes(4);
    while (pending.length > 0) {
      pending.shift()!(null, { stdout: 'ExecutablePath=C:\\x\\cmd.exe', stderr: '' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(probes);
    expect(execFileMock).toHaveBeenCalledTimes(6);
  });
});

describe('isWin32ShellProcess', () => {
  it('matches the executable basename case-insensitively', async () => {
    execFileReturns('ExecutablePath=C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    await expect(isWin32ShellProcess(10, 'PowerShell.exe')).resolves.toBe(true);
  });

  it('matches a full expected path', async () => {
    execFileReturns('ExecutablePath=C:\\Program Files\\Git\\bin\\bash.exe');
    await expect(isWin32ShellProcess(11, 'C:\\Program Files\\Git\\bin\\bash.exe')).resolves.toBe(true);
  });

  it('rejects a different executable', async () => {
    execFileReturns('ExecutablePath=C:\\Windows\\System32\\notepad.exe');
    await expect(isWin32ShellProcess(12, 'powershell.exe')).resolves.toBe(false);
  });

  it('false when the path is withheld or the probe fails', async () => {
    execFileReturns('ExecutablePath=\r\n');
    await expect(isWin32ShellProcess(13, 'cmd.exe')).resolves.toBe(false);
    execFileFails('boom');
    await expect(isWin32ShellProcess(14, 'cmd.exe')).resolves.toBe(false);
  });
});

describe('start-time compatibility with wmic-era records', () => {
  it('a pidStartTime stored by wmic matches the same CIM reading', () => {
    // wmic printed `CreationDate=20260924205809.260729+540`; ToDmtfDateTime
    // prints the identical string, so the stored value keeps authorizing.
    const stored = '20260924205809.260729+540';
    const current = parseWin32ProcessInfo(
      'ExecutablePath=C:\\x\\powershell.exe\r\nCreationDate=20260924205809.260729+540',
    )!.creationDate;
    expect(classifyReapIdentity({ storedStartTime: stored, currentStartTime: current, looksLikeOurShell: false }))
      .toBe('start-time');
  });

  it('an unreadable start time still refuses the kill', () => {
    expect(
      classifyReapIdentity({ storedStartTime: '20260924205809.260729+540', currentStartTime: null, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });
});
