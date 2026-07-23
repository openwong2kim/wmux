// Verification rig — run isolation context (design §2 / G2)
//
// Fresh temp home per scenario + `WMUX_DATA_SUFFIX='-rig-{runId}'`. runId is required on all OSes
// (win32 named pipe is a global namespace outside the filesystem, so suffix runId is the only parallel-run
// isolation — §2, Codex M4). Home override covers all four: HOME (posix) +
// USERPROFILE·APPDATA·LOCALAPPDATA (win32) — path helpers use `USERPROFILE || HOME`
// (`src/shared/constants.ts:287,:342`) and existing dogfood follows the same convention (Codex M3).
//
// Suffix string must be a single shared constant between daemon spawn env and PipeClient
// (v1 review: `-rig` vs `-rig-{id}` drift caused auth mismatch — Claude axis ①).
// So pipe address·token path derivation is computed once here and carried on RigContext.
//
// Verified (orchestrator spike 1d): on macOS `os.homedir()` follows HOME override
// (falls back to $HOME when getpwuid fails), so daemon `getWmuxDir()` (`src/daemon/config.ts:11`,
// os.homedir-based)·socket location·token location are all isolated inside temp home.
//
// env construction = minimal allowlist (review reflected — no `...process.env` full inheritance). Parent shell
// WMUX_* would mutate daemon behavior — verified pollution vectors: `WMUX_IDLE_SHUTDOWN_MS`/
// `WMUX_IDLE_GRACE_MS` (`src/daemon/index.ts:3187-3188` — idle shutdown override causes daemon self-exit during tests)·
// `WMUX_WATCHDOG_TICK_MS` (:3202 — tick mutation causes flakes).
// allowlist (not denylist individual deletes) blocks this class at source.
// HOMEDRIVE/HOMEPATH delete dance also unnecessary (not on allowlist, never inherited).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** runId counter — increment when creating multiple contexts in one process (pid alone would collide). */
let runIdCounter = 0;

export interface RigContext {
  /** Unique identifier for this run (pid + counter). Used for failure log·artifact correlation. */
  readonly runId: string;
  /** `-rig-{runId}` — single suffix constant shared by daemon spawn env and PipeClient. */
  readonly suffix: string;
  /** Absolute temp home path from mkdtemp. Deleted wholesale on teardown. */
  readonly home: string;
  /** Isolated env for daemon spawn (allowlist + 4 home vars + WMUX_DATA_SUFFIX). */
  readonly env: NodeJS.ProcessEnv;
  /** Daemon control pipe address (unix: socket path / win32: named pipe). */
  readonly daemonPipePath: string;
  /** Daemon auth token file path (`{home}/.wmux{suffix}/daemon-auth-token`). */
  readonly daemonTokenPath: string;
}

/**
 * Minimal allowlist passed through from parent env. WMUX_* never passes (see module header pollution
 * vectors) — exception is WMUX_DATA_SUFFIX explicitly injected by the rig, injected in
 * buildIsolatedEnv not here.
 *   - common: PATH (minimum for child to resolve external binaries — for later RigSession shell)
 *   - win32: SystemRoot·ComSpec·windir·TEMP·TMP (Win32 API·shell resolution required)
 *   - posix: TMPDIR·LANG·LC_* (os.tmpdir follow + locale)
 */
function buildIsolatedEnv(
  home: string,
  appData: string,
  localAppData: string,
  suffix: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const copy = (key: string): void => {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  };

  copy('PATH');
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'ComSpec', 'windir', 'TEMP', 'TMP']) copy(key);
  } else {
    for (const key of ['TMPDIR', 'LANG']) copy(key);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LC_')) copy(key);
    }
  }

  // Isolation injection — 4 home vars + suffix. These five are the full and only WMUX_* keys.
  out.HOME = home;
  out.USERPROFILE = home;
  out.APPDATA = appData;
  out.LOCALAPPDATA = localAppData;
  out.WMUX_DATA_SUFFIX = suffix;
  return out;
}

/**
 * Creates a new isolated run context. Physically creates temp home via mkdtemp, computes env (minimal allowlist)
 * and derived paths (pipe·token) for daemon inheritance. Does not spawn processes or open sockets —
 * pure context factory (consumed by RigDaemon/PipeClient).
 */
export function createRigContext(): RigContext {
  const runId = `${process.pid}-${runIdCounter++}`;
  const suffix = `-rig-${runId}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rig-'));

  // Pre-create AppData subdirs win32 path helpers reference (daemon would recurse-create if missing,
  // but explicit per dogfood convention). Harmless on posix.
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });

  const env = buildIsolatedEnv(home, appData, localAppData, suffix);

  const username = os.userInfo().username || 'default';
  const daemonPipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\wmux-daemon${suffix}-${username}`
      : path.join(home, `.wmux-daemon${suffix}.sock`);

  // Daemon token is suffix-aware via directory, not filename
  // (`getDaemonAuthTokenPath` → `getWmuxHomeDir()`/`.wmux{suffix}/daemon-auth-token`
  //  — near `src/shared/constants.ts:342`).
  const daemonTokenPath = path.join(home, `.wmux${suffix}`, 'daemon-auth-token');

  return { runId, suffix, home, env, daemonPipePath, daemonTokenPath };
}

/**
 * Deletes the context's temp home. Process tree kill is RigDaemon.teardown's responsibility
 * (whoever owns the daemon handle) — this function only deletes home — order: daemon kill (including exit wait) →
 * removeRigHome. force+recursive so missing/already deleted does not throw.
 */
export function removeRigHome(ctx: RigContext): void {
  try {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  } catch {
    // best-effort: temp home, OS temp cleanup eventually reaps it.
  }
}
