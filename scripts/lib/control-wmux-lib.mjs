// Pure helpers for scripts/control-wmux.mjs (the verify-wmux driver).
//
// Kept apart from the driver so the rules that keep an agent off the owner's
// real wmux (suffix validation, CDP port ownership, env scrubbing) can be unit
// tested without launching anything. See scripts/__tests__/controlWmux.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { parseCimDate } from '../perf-process-tree.mjs';

/**
 * Suffixes the driver must never launch or attach to:
 *   ''          the owner's real (production) instance
 *   '-dev'      the default suffix every unpackaged dev build forces on itself
 *   '-portable' the shared suffix of any packaged copy outside /Applications
 * Any of these may already be running a session somebody cares about.
 */
export const RESERVED_SUFFIXES = new Set(['', '-dev', '-portable']);

/**
 * Validate a WMUX_DATA_SUFFIX for a verification instance.
 * Returns null when acceptable, otherwise a human-readable refusal.
 */
export function suffixRefusal(suffix) {
  if (typeof suffix !== 'string') return 'suffix must be a string';
  if (RESERVED_SUFFIXES.has(suffix)) {
    return suffix === ''
      ? 'refusing to drive the main wmux instance (empty WMUX_DATA_SUFFIX)'
      : `refusing reserved suffix "${suffix}" (shared with the owner's own builds)`;
  }
  // The suffix is pasted into file names (~/.wmux<suffix>, sockets, userData),
  // so keep it to a conservative, path-safe alphabet.
  if (!/^-[a-z0-9][a-z0-9-]{0,39}$/.test(suffix)) {
    return `suffix "${suffix}" must look like -verify-abc123 (leading dash, [a-z0-9-], max 40 chars)`;
  }
  return null;
}

/**
 * Parse the CDP lines wmux writes to stdout during boot (src/main/index.ts).
 * `requested` is the port Chromium was asked to bind; `listening` is set only
 * once wmux has proven it owns the endpoint; `unverified` means the probe has
 * not succeeded (yet); `disabled` means CDP is off for this instance.
 */
export function parseCdpLog(text) {
  const out = { requested: null, listening: null, unverified: false, disabled: false };
  const s = String(text ?? '');
  const req = /\[WinMux\] CDP requested on port (\d+)/.exec(s);
  if (req) out.requested = Number(req[1]);
  const lis = /\[WinMux\] CDP listening on port (\d+)/.exec(s);
  if (lis) out.listening = Number(lis[1]);
  if (/\[WinMux\] CDP port \d+ is unverified/.test(s)) out.unverified = true;
  if (/\[WinMux\] CDP disabled/.test(s)) out.disabled = true;
  return out;
}

/**
 * Find the CDP port claimed by `pid` in wmux's claim directory
 * (~/.cache/wmux-cdp/wmux-cdp-<port>.lock, content = owner pid; see
 * src/main/browser-session/cdpPort.ts). Returns null when no claim matches.
 * Ownership by pid is what lets the driver attach to ITS instance and never to
 * another wmux that happens to sit in the same 18800-18899 range.
 */
export function findClaimedPort(dir, pid) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = /^wmux-cdp-(\d+)\.lock$/.exec(name);
    if (!m) continue;
    let holder;
    try {
      holder = Number.parseInt(fs.readFileSync(path.join(dir, name), 'utf8').trim(), 10);
    } catch {
      continue;
    }
    if (holder === pid) return Number(m[1]);
  }
  return null;
}

/**
 * The CDP port of the app `pid`: the port its own log says it requested, once
 * the claim for that port names the pid. A clean quit removes its claim, but
 * a crashed process's claim stays until a later launch reclaims that port, so
 * a stale one left by an earlier process whose pid the app now reuses names
 * the pid too; only the log decides. Until the app has logged that line
 * there is no port, and the caller keeps polling.
 */
export function ownedCdpPort(dir, pid, requested) {
  if (!requested) return null;
  return claimOwnedBy(dir, requested, pid) ? requested : null;
}

/** Does the claim file for `port` still name `pid` as its owner? */
export function claimOwnedBy(dir, port, pid) {
  try {
    const holder = Number.parseInt(fs.readFileSync(path.join(dir, `wmux-cdp-${port}.lock`), 'utf8').trim(), 10);
    return holder === pid;
  } catch {
    return false;
  }
}

/**
 * Remove the CDP claim the recorded app left behind, once that app is gone.
 * The app gives its claim back only on a clean quit, and `stop` and `restart`
 * end it with a hard kill on Windows, so its file stayed until some later
 * launch happened to reclaim that port.
 *
 * Only the claim for `port` is touched (or, when launch never learned the
 * port, the claim naming `pid`), and only while it names `pid` and no process
 * holds that pid: a live holder may be a later process the OS gave the pid,
 * and the claim may then be its own. Returns a line for the command's steps.
 */
export function releaseRecordedClaim(dir, { port, pid }, deps) {
  if (!Number.isInteger(pid) || pid <= 0) return 'cdp claim: no recorded pid, nothing removed';
  const at = Number.isInteger(port) && port > 0 ? port : findClaimedPort(dir, pid);
  if (at == null) return `cdp claim: none names pid ${pid}`;
  const file = path.join(dir, `wmux-cdp-${at}.lock`);
  if (!fs.existsSync(file)) return `cdp claim ${at}: already gone`;
  if (!claimOwnedBy(dir, at, pid)) return `cdp claim ${at}: names another pid than ${pid}, left in place`;
  if (deps.pidAlive(pid)) return `cdp claim ${at}: pid ${pid} is still running, left in place`;
  try {
    fs.unlinkSync(file);
    return `cdp claim ${at}: removed (it named pid ${pid}, which is gone)`;
  } catch (err) {
    return `cdp claim ${at}: not removed (${err.code ?? err.message})`;
  }
}

/**
 * Environment for the launched instance. An agent usually runs INSIDE the
 * owner's wmux, so its env carries that instance's pane identity (WMUX_*) and
 * the parent Claude Code session (CLAUDE*). Inheriting either would make the
 * isolated instance, or agents inside it, talk to / impersonate the real one.
 */
export function scrubEnv(env, suffix) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^WMUX_/.test(k) || /^CLAUDE/.test(k)) continue;
    out[k] = v;
  }
  out.WMUX_DATA_SUFFIX = suffix;
  // The test harness opt-in (src/main/browser-session/cdpTestOptIn.ts).
  out.WMUX_TEST_CDP_PORT = '1';
  return out;
}

/**
 * `launch --env-file`: variables a harness sets on purpose (for example
 * WMUX_NO_PATH_REFRESH, or a sandbox HOME), applied AFTER the scrub so a
 * WMUX_* knob survives it. The suffix is only ever the one `--suffix` chose.
 * Returns { env } or { refusal }.
 */
export function launchEnv(baseEnv, suffix, extra = {}) {
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
    return { refusal: '--env-file must hold a JSON object of string values' };
  }
  const env = scrubEnv(baseEnv, suffix);
  for (const [key, value] of Object.entries(extra)) {
    if (key.toUpperCase() === 'WMUX_DATA_SUFFIX') {
      return { refusal: '--env-file may not set WMUX_DATA_SUFFIX; pass --suffix' };
    }
    // MCP registration writes the agents' real configs under Electron's own
    // home, which a sandboxed HOME does not move: an isolated instance must
    // never opt into it.
    if (key.toUpperCase() === 'WMUX_MCP_REGISTER_EXTERNAL') {
      return { refusal: '--env-file may not set WMUX_MCP_REGISTER_EXTERNAL (it writes the real ~/.claude.json and agent configs)' };
    }
    if (typeof value !== 'string') return { refusal: `--env-file value for ${key} must be a string` };
    // One spelling per name: Windows env names are case-insensitive, and a
    // second `Path` next to `PATH` would be picked nondeterministically.
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    }
    env[key] = value;
  }
  return { env };
}

/**
 * Where a packaged build keeps the wmux CLI bundle (forge extraResource
 * `./dist/cli-bundle`): Contents/Resources on macOS, resources/ next to the
 * executable on Windows and Linux.
 */
export function packagedCliBundle(app, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const mac = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(app);
  if (mac) return p.join(mac[1], 'Contents', 'Resources', 'cli-bundle', 'index.js');
  return p.join(p.dirname(app), 'resources', 'cli-bundle', 'index.js');
}

/** Paths a suffixed instance writes under the user's home (src/shared/constants.ts). */
export function suffixedPaths(home, suffix, platform = process.platform) {
  const paths = [
    path.join(home, `.wmux${suffix}`),
    path.join(home, `.wmux${suffix}.sock`),
    path.join(home, `.wmux-mcpb${suffix}.sock`),
    path.join(home, `.wmux-daemon${suffix}.sock`),
    path.join(home, `.wmux${suffix}-auth-token`),
    path.join(home, `.wmux${suffix}-tcp-port`),
  ];
  if (platform === 'darwin') paths.push(path.join(home, 'Library', 'Application Support', `wmux${suffix}`));
  return paths;
}

/** An env value by name, in whatever case this environment spells it. */
function envValue(env, name) {
  const key = Object.keys(env ?? {}).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Where a suffixed instance's Electron userData lands: appInit in
 * src/main/index.ts does `app.setPath('userData', app.getPath('userData') +
 * suffix)`, and getPath('userData') is `<appData>/<productName "wmux">`, or
 * the `--user-data-dir` switch when the app was given one. appData mirrors
 * src/cli/commands/role.ts defaultSessionPath: %APPDATA% on Windows,
 * ~/Library/Application Support on macOS, $XDG_CONFIG_HOME or ~/.config on
 * Linux. A prediction: `launch` checks it against the line the app logs.
 */
export function electronUserDataDir({ suffix, env = {}, home, platform = process.platform, userDataDirArg = null }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (userDataDirArg) return `${userDataDirArg}${suffix}`;
  if (platform === 'win32') {
    return p.join(envValue(env, 'APPDATA') || p.join(home, 'AppData', 'Roaming'), `wmux${suffix}`);
  }
  const posixHome = envValue(env, 'HOME') || home;
  if (platform === 'darwin') return p.join(posixHome, 'Library', 'Application Support', `wmux${suffix}`);
  return p.join(envValue(env, 'XDG_CONFIG_HOME') || p.join(posixHome, '.config'), `wmux${suffix}`);
}

/**
 * The `--user-data-dir` a launch gives the app: the caller's own (`launch
 * --user-data-dir`, which a harness points into its sandbox), else what the
 * first launch used (`restart`), else, on macOS, a dir inside the run's
 * ~/.wmux<suffix>, which the purge snapshot already covers. Elsewhere none:
 * userData stays where the wmux CLI looks for it (role.ts, doctor.ts), and
 * `stop --purge` removes it from there.
 */
export function launchUserDataDirArg({ explicit = null, previous, home, suffix, platform = process.platform }) {
  if (explicit) return explicit;
  if (previous !== undefined) return previous;
  if (platform !== 'darwin') return null;
  return path.posix.join(home, `.wmux${suffix}`, 'electron-user-data');
}

/**
 * The app's arguments. macOS: `--use-mock-keychain`, so the first safeStorage
 * call cannot open a login-keychain dialog on the owner's desktop (and block
 * the main thread on a locked screen); e2e/lib.mjs passes the same.
 */
export function launchAppArgs({ userDataDirArg = null, fakeAudio = null, platform = process.platform }) {
  const args = [];
  if (platform === 'darwin') args.push('--use-mock-keychain');
  if (userDataDirArg) args.push(`--user-data-dir=${userDataDirArg}`);
  // Chromium's fake capture device plays a WAV file as the microphone, once:
  // dictation can be proven on a machine with no microphone, and the real
  // one (and its OS prompt) is never touched. The audio service's sandbox
  // would refuse to read the file, so that one sandbox (only) is off.
  if (fakeAudio) args.push('--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeAudio}%noloop`, '--disable-features=AudioServiceSandbox');
  return args;
}

/** The userData path the app itself logged at boot (src/main/index.ts appInit), or null. */
export function parseUserDataLog(text) {
  const m = /\[Main\] WMUX_DATA_SUFFIX="([^"]*)" .{1,8}? userData="([^"]+)"/.exec(String(text ?? ''));
  return m ? { suffix: m[1], userData: m[2] } : null;
}

/**
 * `p` with every link in it resolved (macOS /tmp -> /private/tmp, a Windows
 * junction or 8.3 short name), also for a path that does not exist yet: the
 * longest existing ancestor is resolved and the rest re-joined. Only on the
 * platform this process runs on; a path for another platform comes back as
 * given.
 */
export function resolvedPath(p, platform = process.platform) {
  if (!p || platform !== process.platform) return p;
  const pm = platform === 'win32' ? path.win32 : path.posix;
  let head = pm.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return pm.join(fs.realpathSync.native(head), ...tail);
    } catch {
      const parent = pm.dirname(head);
      if (parent === head) return p;
      tail.unshift(pm.basename(head));
      head = parent;
    }
  }
}

/**
 * The same path? Links are resolved on both sides (resolvedPath), so the
 * `/private/tmp/…` macOS logs matches a predicted `/tmp/…`. Case-insensitive
 * and separator-blind on Windows.
 */
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const ra = resolvedPath(a, platform);
  const rb = resolvedPath(b, platform);
  if (platform !== 'win32') return path.posix.normalize(ra) === path.posix.normalize(rb);
  const norm = (s) => path.win32.normalize(s).replace(/[\\/]+$/, '').toLowerCase();
  return norm(ra) === norm(rb);
}

/**
 * The userData record `launch` keeps in state.json and `launch`/`doctor`
 * print. `recorded` is the record taken before launch (`{ path,
 * existedBeforeLaunch }` of the predicted path; null in a state from an older
 * driver); `logged` is parseUserDataLog of the app's log (null when the line
 * is absent).
 *   - Logged: `path` is the logged path, `source` 'logged'. When it is the
 *     predicted path the pre-launch record still holds; otherwise nobody saw
 *     that path absent before launch, so `existedBeforeLaunch` is null.
 *   - Not logged (an older build, or not yet): the prediction, `source`
 *     'predicted'.
 */
export function resolveUserDataRecord({ recorded, logged, platform = process.platform }) {
  if (!logged) return recorded ? { ...recorded, source: recorded.source ?? 'predicted' } : null;
  if (recorded && samePath(logged.userData, recorded.path, platform)) {
    return { ...recorded, path: logged.userData, source: 'logged' };
  }
  return { path: logged.userData, existedBeforeLaunch: null, predicted: recorded ? recorded.predicted ?? recorded.path : null, source: 'logged' };
}

/** Does anything (a file, a dir, a link, even a dangling one) sit at `p`? */
export function pathPresent(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first symlink or junction at or under `p`, or null. lstat never
 * follows one, and Node reports a Windows junction as a symbolic link, so a
 * tree that holds either is found without ever entering the link's target.
 */
export function linkInTree(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return p;
  if (!st.isDirectory()) return null;
  let names;
  try {
    names = fs.readdirSync(p);
  } catch {
    // Unreadable: nobody can say what it holds.
    return p;
  }
  for (const name of names) {
    const hit = linkInTree(path.join(p, name));
    if (hit) return hit;
  }
  return null;
}

/**
 * `stop --purge`: delete the suffixed data this run created, nothing else.
 *   - `paths` (suffixedPaths) go only when they are absent from `preExisting`,
 *     the existence snapshot `launch` took before starting the app;
 *   - `userData` is launch's record `{ path, existedBeforeLaunch }`: it goes
 *     only when `existedBeforeLaunch === false`. No record (a state written
 *     before the record existed) or an unknown pre-launch state is skipped and
 *     reported: never delete what nobody saw absent before launch;
 *   - a path whose name does not carry the suffix is never touched;
 *   - a symlink or junction, at the path or anywhere under it, leaves the
 *     whole path in place: it is never followed, so its target cannot be hit.
 * Returns { removed, skipped: [{ path, reason }] }.
 */
export function purgeSuffixedData({ suffix, paths, preExisting = [], userData, legacyUserDataPath = null, platform = process.platform }) {
  const removed = [];
  const skipped = [];
  const pre = new Set(preExisting);
  const candidates = [];
  for (const p of paths) {
    if (!pathPresent(p)) continue;
    if (pre.has(p)) skipped.push({ path: p, reason: 'existed before launch' });
    else candidates.push(p);
  }
  if (!userData) {
    if (legacyUserDataPath && pathPresent(legacyUserDataPath) && !paths.some((p) => samePath(p, legacyUserDataPath, platform))) {
      skipped.push({ path: legacyUserDataPath, reason: 'userData: the run state has no pre-launch record (written by an older control-wmux); left in place' });
    }
  } else if (userData.path && !paths.some((p) => samePath(p, userData.path, platform)) && pathPresent(userData.path)) {
    if (userData.existedBeforeLaunch === false) candidates.push(userData.path);
    else if (userData.existedBeforeLaunch === true) skipped.push({ path: userData.path, reason: 'userData existed before launch' });
    else skipped.push({ path: userData.path, reason: 'userData: pre-launch state unknown (the app logged another path than predicted); left in place' });
  }
  for (const p of candidates) {
    // userData inside an already removed ~/.wmux<suffix> is gone with it.
    if (!pathPresent(p)) continue;
    if (!path.basename(p).includes(suffix)) {
      skipped.push({ path: p, reason: `name does not carry the suffix ${suffix}` });
      continue;
    }
    const link = linkInTree(p);
    if (link) {
      skipped.push({ path: p, reason: `holds a symlink, junction or unreadable dir (${link}); never followed, left in place` });
      continue;
    }
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch (err) {
      // A file still held open: report it, never abort the rest of `stop`.
      skipped.push({ path: p, reason: `could not remove (${err.code || err.message}); part of it may be gone` });
    }
  }
  return { removed, skipped };
}

/**
 * One renderer console line as Chromium logs it with ELECTRON_ENABLE_LOGGING=1:
 *   [pid:mmdd/hhmmss.us:INFO:CONSOLE:26] "message", source: file:///…/main_window-x.js (26)
 * Older Chromium writes `CONSOLE(26)`; both shapes are accepted.
 */
export function parseConsoleLine(line) {
  const m = /:(INFO|WARNING|ERROR|VERBOSE\d*):CONSOLE(?::\d+|\(\d+\))\] "(.*)", source: (.*)$/.exec(String(line));
  if (!m) return null;
  const level = m[1] === 'WARNING' ? 'warning' : m[1] === 'ERROR' ? 'error' : 'info';
  return { level, text: m[2].slice(0, 500), source: m[3].replace(/^file:\/\/.*\/(?=[^/]+$)/, '') };
}

/**
 * Does a process environment dump (`/proc/<pid>/environ` NUL-separated, or
 * `ps -E` space-separated) set WMUX_DATA_SUFFIX to exactly `suffix`?
 */
export function envHasSuffix(envText, suffix) {
  if (!suffix) return false;
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s\\0])WMUX_DATA_SUFFIX=${escaped}($|[\\s\\0])`).test(String(envText ?? ''));
}

/**
 * The answering daemon's pid from `wmux daemon status --json` stdout, or null.
 * Decided on the JSON, not the exit code: a daemon that does not answer also
 * prints JSON (`{ ok: false, running: false, error }`) and exits 1.
 */
export function parseDaemonStatusPid(stdout) {
  let out;
  try {
    out = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return null;
  }
  if (out?.ok !== true || out.running !== true) return null;
  return Number.isInteger(out.pid) && out.pid > 0 ? out.pid : null;
}

/**
 * Does live `pid`, read from this run's suffixed daemon.pid, belong to the
 * recorded isolated instance? A stale pid file can name a reused pid, so the
 * pid alone proves nothing. Returns { ok, how, reason }.
 *   - 'pipe': the daemon on this suffix's own control pipe (its name and auth
 *     token both live under ~/.wmux<suffix>) answers `daemon.ping` with this
 *     very pid. Every platform; the only proof on Windows, where another
 *     process's environment is not readable.
 *   - 'env' (not Windows): the process's own environment sets
 *     WMUX_DATA_SUFFIX to exactly `suffix` (envHasSuffix).
 * probes: pidAlive(pid), pingPid() -> number|null, envText(pid) -> string.
 */
export function daemonIdentityHolds({ pid, suffix }, probes, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0 || !suffix) return { ok: false, how: null, reason: 'no daemon pid or suffix' };
  if (!probes.pidAlive(pid)) return { ok: false, how: null, reason: `daemon pid ${pid} is not running` };
  let answered = null;
  try { answered = probes.pingPid(); } catch { answered = null; }
  if (answered === pid) return { ok: true, how: 'pipe', reason: null };
  if (platform !== 'win32') {
    let envText = '';
    try { envText = probes.envText(pid); } catch { envText = ''; }
    if (envHasSuffix(envText, suffix)) return { ok: true, how: 'env', reason: null };
  }
  return {
    ok: false,
    how: null,
    reason: answered == null
      ? `no daemon answered on the ${suffix} pipe, and daemon pid ${pid} is not otherwise proven ours`
      : `the daemon on the ${suffix} pipe is pid ${answered}, not daemon.pid's ${pid}`,
  };
}

/**
 * macOS: the environment part of `ps -E -ww -o command=`, which prints the
 * command line and then the environment. `argsOnly` is the same process's
 * `ps -ww -o command=`; stripping it keeps a `WMUX_DATA_SUFFIX=...` that only
 * appears in the arguments from passing for the process's environment.
 * '' when the two do not line up (the process changed or is gone).
 */
export function darwinEnvPart(withEnv, argsOnly) {
  const full = String(withEnv ?? '').replace(/\n+$/, '');
  const args = String(argsOnly ?? '').replace(/\n+$/, '');
  if (!args || !full.startsWith(args)) return '';
  return full.slice(args.length);
}

/**
 * `launchctl list` rows whose label belongs to this suffix's daemon jobs
 * (`com.wmux.daemon<suffix>.<n>`): [{ label, pid }], pid null for a job that
 * is loaded but not running.
 */
export function launchdJobsFor(listText, suffix) {
  if (!suffix) return [];
  const base = `com.wmux.daemon${suffix}.`;
  const jobs = [];
  for (const line of String(listText ?? '').split('\n')) {
    const [pidCol, , label] = line.trim().split(/\s+/);
    if (!label?.startsWith(base)) continue;
    const pid = /^\d+$/.test(pidCol ?? '') ? Number(pidCol) : null;
    jobs.push({ label, pid });
  }
  return jobs;
}

/**
 * `ps -o lstart=` text (LC_ALL=C, e.g. `Thu Oct 22 10:00:05 2026`) as epoch
 * ms, or null. One parser for every caller, so a creation time recorded by one
 * script compares equal to the same process read by another.
 */
export function parseLstart(text) {
  const t = Date.parse(String(text ?? '').trim().replace(/\s+/g, ' '));
  return Number.isFinite(t) ? t : null;
}

/**
 * The command that reads one process's creation time. Its output goes through
 * parseProcessStart.
 *   - Windows: Win32_Process.CreationDate through `ConvertTo-Json`, the same
 *     shape (and the same parseCimDate) as a whole-table listing, so the two
 *     agree to the millisecond.
 *   - POSIX: `ps -o lstart=` (second precision), run with LC_ALL=C.
 */
export function processStartQuery(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress`],
    };
  }
  return { file: 'ps', args: ['-o', 'lstart=', '-p', String(pid)] };
}

/** A processStartQuery result as epoch ms; null when the process is gone or the output is unusable. */
export function parseProcessStart(stdout, pid, platform = process.platform) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  if (platform === 'win32') {
    let row;
    try { row = JSON.parse(text); } catch { return null; }
    if (Array.isArray(row)) row = row[0];
    if (!row || Number(row.ProcessId) !== pid) return null;
    return parseCimDate(row.CreationDate);
  }
  return parseLstart(text.split('\n')[0]);
}

/**
 * The command that lists every process with its parent and creation time, for
 * the e2e-first-run-lib normalizeProcessRows shape: CIM through
 * `ConvertTo-Json` on Windows (the same CreationDate pipeline as
 * processStartQuery), `ps` with lstart elsewhere (run it with LC_ALL=C).
 */
export function processListQuery(platform = process.platform) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress'],
    };
  }
  return { file: 'ps', args: ['-A', '-o', 'pid=,ppid=,lstart=,args='] };
}

/**
 * Is the recorded process (pid + creation time captured right after spawn)
 * the one holding that pid now? A missing creation time never matches:
 * without it the driver cannot tell its own process from a reused pid.
 */
export function sameProcess(recorded, current) {
  if (!recorded || !current) return false;
  if (!Number.isInteger(recorded.pid) || recorded.pid <= 0) return false;
  if (recorded.createdAt == null || current.createdAt == null) return false;
  return recorded.pid === current.pid && recorded.createdAt === current.createdAt;
}

/**
 * Windows: terminate recorded processes only through a handle that pins the
 * process whose creation time matched. Node's process.kill (SIGTERM or
 * SIGKILL) and taskkill both act on a bare pid, so a pid reused between the
 * identity check and the kill would hit the stranger. One PowerShell call:
 *   1. GetProcessById + `.Handle` opens and caches a handle per pid; while it
 *      is open Windows cannot hand that pid to another process;
 *   2. one CIM query then reads CreationDate for those pids, through the same
 *      `ConvertTo-Json` pipeline the identities were recorded with
 *      (processStartQuery, processListQuery), so the milliseconds agree;
 *   3. Kill() on the cached handle, only where pid AND creation time match.
 * Results per pid: killed | mismatch (another process holds it) | gone | denied.
 * `targets` are { pid, createdAt } with createdAt in epoch ms.
 */
export function windowsKillQuery(targets) {
  const list = (targets || [])
    .filter((t) => Number.isInteger(t?.pid) && t.pid > 0 && Number.isFinite(t?.createdAt))
    .map((t) => ({ pid: t.pid, createdAt: Math.trunc(t.createdAt) }));
  if (list.length === 0) return null;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // PowerShell 5.1 emits a JSON array as ONE object; the inner pipeline unrolls it.
    `$targets = @(('${JSON.stringify(list)}' | ConvertFrom-Json) | ForEach-Object { $_ })`,
    '$handles = @{}',
    '$res = @{}',
    'foreach ($t in $targets) {',
    '  $id = [int]$t.pid',
    '  try {',
    '    $p = [System.Diagnostics.Process]::GetProcessById($id)',
    '    $null = $p.Handle',
    '    $handles[$id] = $p',
    "  } catch [System.ArgumentException] { $res[$id] = 'gone' }",
    "  catch { $res[$id] = 'denied' }",
    '}',
    '$created = @{}',
    'if ($handles.Count -gt 0) {',
    "  $filter = (@($handles.Keys) | ForEach-Object { 'ProcessId=' + $_ }) -join ' OR '",
    '  foreach ($row in @(Get-CimInstance Win32_Process -Filter $filter)) {',
    '    $json = $row | Select-Object CreationDate | ConvertTo-Json -Compress',
    "    if ($json -match 'Date\\((\\d+)\\)') { $created[[int]$row.ProcessId] = [long]$Matches[1] }",
    '  }',
    '}',
    'foreach ($t in $targets) {',
    '  $id = [int]$t.pid',
    '  if ($res.ContainsKey($id)) { continue }',
    '  $p = $handles[$id]',
    '  try {',
    "    if ($p.HasExited -or -not $created.ContainsKey($id)) { $res[$id] = 'gone' }",
    "    elseif ($created[$id] -ne [long]$t.createdAt) { $res[$id] = 'mismatch' }",
    "    else { $p.Kill(); $res[$id] = 'killed' }",
    '  } catch {',
    "    try { if ($p.HasExited) { $res[$id] = 'gone' } else { $res[$id] = 'denied' } } catch { $res[$id] = 'denied' }",
    '  }',
    '}',
    'foreach ($p in $handles.Values) { $p.Dispose() }',
    '$out = @($targets | ForEach-Object { [pscustomobject]@{ pid = [int]$_.pid; result = [string]$res[[int]$_.pid] } })',
    'ConvertTo-Json -Compress -InputObject $out',
  ].join('\n');
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    script,
  };
}

/** windowsKillQuery output as { [pid]: result }; {} when unusable. */
export function parseKillResults(stdout) {
  let rows;
  try {
    rows = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return {};
  }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const out = {};
  for (const r of rows) {
    if (Number.isInteger(r?.pid) && typeof r.result === 'string') out[r.pid] = r.result;
  }
  return out;
}

/**
 * process.kill that reports instead of throwing for the two expected misses:
 * 'gone' (ESRCH) and 'denied' (EPERM: the process is alive but not ours to
 * signal). Anything else is a bug and throws.
 */
export function signalProcess(pid, sig, kill = process.kill.bind(process)) {
  try {
    kill(pid, sig);
    return 'sent';
  } catch (err) {
    if (err.code === 'ESRCH') return 'gone';
    if (err.code === 'EPERM') return 'denied';
    throw err;
  }
}

/**
 * Is the app a state recorded (pid + creation time read right after spawn)
 * still the process holding that pid? The only test that lets `stop` or
 * `restart` signal it: a pid alone may have been reused by anything.
 */
export function appIdentityHolds(state, { pidAlive, startedAt }) {
  if (!state?.pid || state.pidCreatedAt == null || !pidAlive(state.pid)) return false;
  return sameProcess({ pid: state.pid, createdAt: state.pidCreatedAt }, { pid: state.pid, createdAt: startedAt(state.pid) });
}

/**
 * `stop`, step 1: end the app `launch` spawned, never another process that
 * holds its pid now. Returns the step line.
 *   - Windows: through windowsKillQuery's pinned handle (Node's SIGTERM is a
 *     TerminateProcess on a bare pid there, so it is no gentler anyway).
 *   - POSIX: SIGTERM while the identity holds; after 10 s, re-check the
 *     identity, then SIGKILL. A pid that is not ours to signal is skipped.
 * deps: pidAlive, startedAt, signal(pid, sig) -> sent|gone|denied,
 * waitDead(pid, ms) -> bool, killByIdentity([{ pid, createdAt }]) -> { [pid]: result }.
 */
export async function stopRecordedApp(state, deps, platform = process.platform) {
  const { pidAlive, signal, waitDead, killByIdentity } = deps;
  const pid = state.pid;
  if (!pidAlive(pid)) return `app pid ${pid}: already gone`;
  if (state.pidCreatedAt == null) return `app pid ${pid}: no creation time recorded, identity not verified, not signalled`;
  if (platform === 'win32') {
    const result = (await killByIdentity([{ pid, createdAt: state.pidCreatedAt }]))[pid];
    if (result === 'killed') {
      await waitDead(pid, 10_000);
      return `app pid ${pid}: terminated through a handle pinned to its recorded creation time`;
    }
    if (result === 'mismatch') return `app pid ${pid}: now another process (creation time differs), not signalled`;
    if (result === 'gone') return `app pid ${pid}: already gone`;
    return `app pid ${pid}: not terminated (${result || 'no result'}), skipped`;
  }
  if (!appIdentityHolds(state, deps)) return `app pid ${pid}: now another process (creation time differs), not signalled`;
  const sent = signal(pid, 'SIGTERM');
  if (sent === 'denied') return `app pid ${pid}: not permitted to signal, skipped`;
  if (sent === 'gone') return `app pid ${pid}: already gone`;
  if (await waitDead(pid, 10_000)) return `app pid ${pid}: exited on SIGTERM`;
  // Re-check identity before the hard kill: 10 s is long enough to matter.
  if (appIdentityHolds(state, deps) && signal(pid, 'SIGKILL') === 'sent') {
    await waitDead(pid, 3000);
    return `app pid ${pid}: SIGKILL after SIGTERM timeout`;
  }
  return `app pid ${pid}: SIGTERM timed out; identity or permission lost, not killed`;
}
