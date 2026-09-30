import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * The 8.3 short spelling of an existing Windows path (`C:\Users\RUNNER~1\...`),
 * or null when it has none: not Windows, or 8.3 name generation is off for that
 * volume (common on non-system drives). Callers skip on null.
 *
 * TEST-ONLY. Node has no GetShortPathName binding; cmd's `%~s` modifier is
 * the same call. Used to spell a watched directory the way a windows-latest
 * runner's `%TEMP%` does (#984).
 */
export function shortPathOf(p: string): string | null {
  if (process.platform !== 'win32') return null;
  // `/u` makes cmd write UTF-16LE to the pipe. Without it `echo` encodes with
  // the OEM code page (949 on ko-KR, 437 on the runner), so a non-ASCII
  // component (a Korean user name in %TEMP%) came back as mojibake.
  const res = spawnSync('cmd.exe', ['/d', '/u', '/c', `for %I in ("${p}") do @echo %~sI`], {
    encoding: 'utf16le',
    windowsVerbatimArguments: true,
  });
  const short = res.status === 0 ? res.stdout.trim() : '';
  if (!short || short.toLowerCase() === p.toLowerCase()) return null;
  // Anything that does not name an existing path (a decode oddity, a `%` in
  // the path that cmd expanded) must make the caller skip, never fail.
  return fs.existsSync(short) ? short : null;
}
