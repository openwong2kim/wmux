import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// installedFonts.ts calls `promisify(execFile)` at module load. We give the
// mocked execFile a `util.promisify.custom` implementation so the promisified
// binding resolves to our spy — no real PowerShell spawn.
const { mockExecFileAsync } = vi.hoisted(() => ({ mockExecFileAsync: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(function execFile() { /* promisified via custom symbol below */ }, {
    [Symbol.for('nodejs.util.promisify.custom')]: mockExecFileAsync,
  }),
}));

import { parseFontList, parseMacFontProfile, listInstalledFonts } from '../fonts/installedFonts';

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  mockExecFileAsync.mockReset();
});
afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

describe('parseFontList', () => {
  it('trims, drops blanks, dedups, and sorts by locale', () => {
    const stdout = '  Fira Code \nConsolas\n\nFira Code\nCascadia Code\n   \n';
    expect(parseFontList(stdout)).toEqual(['Cascadia Code', 'Consolas', 'Fira Code']);
  });

  it('handles both CRLF and LF line endings', () => {
    expect(parseFontList('A\r\nB\nC')).toEqual(['A', 'B', 'C']);
  });

  it('returns [] for empty stdout', () => {
    expect(parseFontList('')).toEqual([]);
    expect(parseFontList('\r\n  \n')).toEqual([]);
  });
});

describe('parseMacFontProfile', () => {
  it('extracts, dedups, and locale-sorts typeface family names', () => {
    // Abbreviated system_profiler SPFontsDataType -json — typefaces array per font entry
    const stdout = JSON.stringify({
      SPFontsDataType: [
        { typefaces: [{ family: 'Menlo' }, { family: 'Menlo' }] },
        { typefaces: [{ family: ' Apple SD Gothic Neo ' }, { family: '' }, { family: 42 }] },
        { typefaces: [{ family: 'D2Coding' }] },
        {}, // entries without typefaces must be harmless
      ],
    });
    expect(parseMacFontProfile(stdout)).toEqual(['Apple SD Gothic Neo', 'D2Coding', 'Menlo']);
  });

  it('returns [] on broken JSON or missing top-level key', () => {
    expect(parseMacFontProfile('not json')).toEqual([]);
    expect(parseMacFontProfile('{}')).toEqual([]);
  });
});

describe('listInstalledFonts', () => {
  it('returns [] on Linux without spawning', async () => {
    setPlatform('linux');
    await expect(listInstalledFonts()).resolves.toEqual([]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('enumerates via system_profiler on darwin', async () => {
    setPlatform('darwin');
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify({ SPFontsDataType: [{ typefaces: [{ family: 'Menlo' }, { family: 'SF Mono' }] }] }),
      stderr: '',
    });
    await expect(listInstalledFonts()).resolves.toEqual(['Menlo', 'SF Mono']);
    const [exe, args] = mockExecFileAsync.mock.calls[0] as [string, string[]];
    expect(exe).toBe('/usr/sbin/system_profiler');
    expect(args).toEqual(['SPFontsDataType', '-json']);
  });

  it('returns [] (never throws) when system_profiler fails on darwin', async () => {
    setPlatform('darwin');
    mockExecFileAsync.mockRejectedValue(new Error('spawn ENOENT'));
    await expect(listInstalledFonts()).resolves.toEqual([]);
  });

  it('returns the parsed font list on Windows success', async () => {
    setPlatform('win32');
    mockExecFileAsync.mockResolvedValue({ stdout: 'JetBrains Mono\nConsolas\n', stderr: '' });
    await expect(listInstalledFonts()).resolves.toEqual(['Consolas', 'JetBrains Mono']);
    expect(mockExecFileAsync).toHaveBeenCalledOnce();
  });

  it('returns [] (never throws) when the spawn rejects', async () => {
    setPlatform('win32');
    mockExecFileAsync.mockRejectedValue(new Error('spawn ENOENT'));
    await expect(listInstalledFonts()).resolves.toEqual([]);
  });

  it('invokes PowerShell by absolute path, not a bare PATH lookup', async () => {
    // Regression guard: spawning a bare 'powershell.exe' relies on System32
    // being on the spawned process's PATH, which fails with ENOENT in Electron's
    // main process — the enumeration then silently returned []. The first
    // candidate must be an absolute path so the lookup can't depend on PATH.
    setPlatform('win32');
    const prevRoot = process.env.SystemRoot;
    process.env.SystemRoot = 'C:\\Windows';
    try {
      mockExecFileAsync.mockResolvedValue({ stdout: 'Consolas\n', stderr: '' });
      await listInstalledFonts();
      const exe = mockExecFileAsync.mock.calls[0][0] as string;
      expect(exe).not.toBe('powershell.exe');
      expect(exe).toMatch(/powershell\.exe$/i);
      expect(exe).toContain('System32');
    } finally {
      if (prevRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = prevRoot;
    }
  });

  it('falls back to the next candidate when the first spawn fails', async () => {
    setPlatform('win32');
    process.env.SystemRoot = 'C:\\Windows';
    // Absolute path ENOENT → bare name succeeds. End result must still parse.
    mockExecFileAsync
      .mockRejectedValueOnce(new Error('spawn ENOENT'))
      .mockResolvedValueOnce({ stdout: 'Consolas\nFira Code\n', stderr: '' });
    await expect(listInstalledFonts()).resolves.toEqual(['Consolas', 'Fira Code']);
    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
  });
});
