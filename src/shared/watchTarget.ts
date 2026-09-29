import fs from 'node:fs';

/**
 * The spelling of a directory to hand to `fs.watch`.
 *
 * libuv 1.52.x on Windows (Node 24.16–24.20, and the Node 24.18 inside
 * Electron 41) keeps a watched directory's path exactly as given, then expands
 * every event's path to its LONG form and strips the watched directory off the
 * front of it. When the directory was spelled with an 8.3 short component
 * (`C:\Users\RUNNER~1\...`, or a short `%TEMP%` as a shell cwd) the long form
 * no longer starts with it:
 *
 *   - builds with asserts on (official Node 24.16–24.20) abort the whole
 *     process: `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file
 *     src\win\fs-event.c, line 72` — the vitest fork death in #984;
 *   - builds with asserts off (Electron) report a garbled filename — the tail
 *     of the long path (`...rt-a1B2c3\.git\HEAD` instead of `HEAD`) — so a
 *     listener matching the exact name, like GitContextWatcher's HEAD filter,
 *     silently drops the event.
 *
 * Regressed in libuv/libuv#4948 (1.52.0), fixed in libuv/libuv#5152 (1.53.0,
 * cherry-picked into Node 24.21.0). This can go once the Electron we ship
 * carries that fix.
 *
 * `realpathSync.native` expands short names (it is the OS realpath, unlike the
 * JS `realpathSync`). On failure the input is returned unchanged, so a missing
 * directory still makes `fs.watch` throw exactly as before and every caller's
 * poll fallback still fires. Only the watch target is rewritten: callers keep
 * their own spelling for everything they compare.
 *
 * Off Windows this is a no-op — there are no short names, and resolving
 * symlinks there (macOS `/var` → `/private/var`) is not this helper's business.
 */
export function watchTarget(dir: string): string {
  if (process.platform !== 'win32') return dir;
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
