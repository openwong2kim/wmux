import { spawnSync } from 'node:child_process';

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
  const res = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
  const short = res.status === 0 ? res.stdout.trim() : '';
  return short && short.toLowerCase() !== p.toLowerCase() ? short : null;
}
