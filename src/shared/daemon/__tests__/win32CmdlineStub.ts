import { vi } from 'vitest';

/**
 * Re-import daemonLauncherCore with ONLY the win32 command-line probe stubbed
 * to `argv`, so a kill test stays deterministic in the mode production uses.
 *
 * #1274: on win32 `getProcessArgv` shells out to PowerShell + Get-CimInstance
 * with a 5 s timeout and returns null on failure, which every mode now refuses.
 * On a loaded runner that turns a kill-success assertion into a flake, and a
 * refusal assertion into one decided by probe latency instead of the matcher.
 * The stub returns the quoted CIM string, so production's quote-aware tokenizer
 * still runs. Every other `execFileSync` call (tasklist, `ps`) and the real
 * `process.kill` pass through; on macOS/Linux the argv probe is untouched.
 * The native read that runs before CIM (#2992) returns the same string.
 *
 * Pair every call with `undoModuleStubs()` in a `finally`.
 */
export async function importWithStubbedWin32Cmdline(argv: string[]) {
  vi.resetModules();
  vi.doMock('../../../main/pty/winSnapshotNative', async () => ({
    ...(await vi.importActual<typeof import('../../../main/pty/winSnapshotNative')>('../../../main/pty/winSnapshotNative')),
    readProcessCommandLine: () => argv.map((part) => `"${part}"`).join(' '),
  }));
  vi.doMock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const execFileSync = ((file: unknown, args?: unknown, opts?: unknown) => {
      const isCimProbe = Array.isArray(args)
        && args.some((a) => typeof a === 'string' && a.includes('Get-CimInstance Win32_Process'));
      // The CIM string quotes arguments carrying spaces; production
      // re-tokenizes it quote-aware, so quote every part.
      if (isCimProbe) return argv.map((part) => `"${part}"`).join(' ');
      return (actual.execFileSync as (...rest: unknown[]) => unknown)(file, args, opts);
    }) as typeof actual.execFileSync;
    return { ...actual, default: { ...actual, execFileSync }, execFileSync };
  });
  return import('../daemonLauncherCore');
}

export function undoModuleStubs(): void {
  vi.doUnmock('../../../main/pty/winSnapshotNative');
  vi.doUnmock('child_process');
  vi.doUnmock('fs');
  vi.resetModules();
}
