import fs from 'node:fs';

/**
 * The spelling of a directory to hand to `fs.watch`.
 *
 * libuv 1.52 on Windows keeps a watched directory's path exactly as given,
 * then expands every event's path to its LONG form and cuts the watched
 * directory's length off the front of it. When the directory was spelled with
 * an 8.3 short component (`C:\Users\RUNNER~1\...`, or a short `%TEMP%` as a
 * shell cwd) the long form no longer starts with it:
 *
 *   - builds with asserts on abort the whole process: `Assertion failed:
 *     !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72`.
 *     That is official Node 24.16–24.20 and 26.0–26.7, and the vitest fork
 *     death in #984;
 *   - builds with asserts off (Electron 41, whose Node is 24.18) cut the
 *     reported filename at the wrong offset: `rt-a1B2c3\.git\HEAD` for `HEAD`
 *     when the long spelling is longer, `on.jsonl` for `session.jsonl` when it
 *     is shorter (`a b` has the alias `AB2761~1`). A listener that matches on
 *     the name drops the event, and a name short enough underflows the length
 *     computation, which libuv/libuv#5152 calls potentially out-of-bounds.
 *
 * Regressed in libuv/libuv#4948 (1.52.0), fixed in libuv/libuv#5152 (1.53.0;
 * cherry-picked into Node 24.21.0 and 26.8.0). This can go once no supported
 * runtime ships libuv 1.52 without that fix: not the Electron we bundle, not
 * the Node that CI and development run the tests on, and not the system Node
 * a CLI-spawned daemon runs under (`findNodePath()` is `process.execPath`).
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
