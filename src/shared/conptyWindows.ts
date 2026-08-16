// ConPTY backend selection for Windows — pure functions only.
//
// IMPORTANT: this module must stay browser-safe. It is imported by the
// SANDBOXED renderer (useTerminal.ts), where the `process` global does not
// exist — unlike platform.ts, whose module-level constants read
// process.platform at import time and would throw a ReferenceError in the
// renderer bundle. Everything here takes platform/build as parameters.

/** The first Windows 11 build (21H2). */
export const WINDOWS_11_FIRST_BUILD = 22000;

/**
 * Whether PTYs on this machine should spawn against node-pty's bundled
 * conpty.dll (OpenConsole) instead of the OS in-box ConPTY (#910).
 *
 * Windows 10's in-box ConPTY never forwards mouse-mode DECSETs (`?1000`
 * `?1002` `?1006`) to the output pipe, so TUIs that enable mouse tracking
 * (vim `set mouse=a`, tmux, ...) never see clicks or wheel events. The
 * OpenConsole build shipped inside node-pty's prebuilds has the fix
 * (microsoft/terminal#15977), so below the cut we ask node-pty for the DLL
 * backend (`useConptyDll: true`).
 *
 * 22000 is a PRODUCT cut, not the upstream fix build: it covers Server 2022
 * (20348) and misses early/unpatched Win11 22000 — acceptable, because those
 * machines get mouse relay from their own in-box ConPTY. Do not present this
 * number as "the build where inbox ConPTY gained mouse".
 *
 * A null build means "could not read it" — keep the in-box backend rather
 * than acting on a number that was never really read.
 *
 * Both spawn sites (daemon `DaemonSessionManager`, local `PTYManager`) and
 * the renderer (via preload's static value) call this SAME predicate, so the
 * PTY backend and xterm's `windowsPty.buildNumber` never disagree. The one
 * exception is the damaged-install fallback: if the bundled DLL cannot load,
 * the spawn retries in-box while the renderer still reports a modern build —
 * a known, accepted trade-off (no session meta by design; see #910 review).
 */
export function shouldUseBundledConpty(platform: string, buildNumber: number | null): boolean {
  if (platform !== 'win32') return false;
  if (buildNumber === null) return false;
  return buildNumber < WINDOWS_11_FIRST_BUILD;
}

/**
 * The build number to hand xterm's `windowsPty.buildNumber` option.
 *
 * xterm switches on 21376 twice — reflow is enabled only at `>= 21376`
 * (Buffer `_isReflowEnabled`) and the legacy ConPTY wrapping heuristics only
 * at `< 21376` (CoreTerminal `_handleWindowsPtyOptionChange`). When the
 * bundled OpenConsole is driving the PTY, the honest value is "a modern
 * build", because reflow behaviour comes from OpenConsole, not the kernel:
 * 22621 is a capability token, NOT a claim about the user's OS.
 *
 * Returns null off Windows or when the build could not be read — the caller
 * then leaves the field out, which is the pre-#900 behaviour.
 */
export function xtermWindowsBuildNumber(platform: string, buildNumber: number | null): number | null {
  if (platform !== 'win32') return null;
  if (buildNumber === null) return null;
  return shouldUseBundledConpty(platform, buildNumber) ? 22621 : buildNumber;
}

/**
 * Fragments that mean the BUNDLED conpty.dll itself could not be loaded —
 * missing or corrupt in this install (node-pty src/win/conpty.cc: the
 * module-handle / module-file-name lookups, "Cannot find conpty.dll at ...",
 * and the LoadLibrary failure). A file that is not there will not be there on
 * a retry, so these demote to the in-box backend immediately.
 */
const CONPTY_DLL_LOAD_ERROR_FRAGMENTS = [
  'Failed to get conpty.node module handle',
  'Failed to get conpty.node module file name',
  'Cannot find conpty.dll',
  'Failed to load conpty.dll',
];

/**
 * "Cannot launch conpty" (conpty.cc:307) is thrown whenever
 * `CreateNamedPipesAndPseudoConsole` returns a failed HRESULT. That covers a
 * bundled OpenConsole.exe blocked by antivirus — where refusing to fall back
 * would leave the shell unable to start at all — but it equally covers a
 * TRANSIENT failure (named-pipe exhaustion, ConPTY error 87), which must not
 * quietly cost this pane its mouse for the rest of its life.
 *
 * The string cannot tell those apart. Persistence can: a blip clears on the
 * next attempt, a blocked binary does not. So this class means "try the
 * bundled backend once more", and only a second failure demotes.
 */
const CONPTY_PSEUDOCONSOLE_ERROR_FRAGMENT = 'Cannot launch conpty';

/** What a caller should do after a bundled-ConPTY spawn threw. */
export type ConptySpawnRecovery = 'demote-to-inbox' | 'retry-bundled' | 'rethrow';

/**
 * Classify a bundled-ConPTY spawn failure.
 *
 * `alreadyRetried` is the caller's memory of having taken `retry-bundled`
 * once for THIS spawn; it is what turns a persistent pseudoconsole failure
 * into a demotion instead of a loop.
 */
export function classifyConptySpawnError(
  message: string,
  alreadyRetried: boolean,
): ConptySpawnRecovery {
  if (CONPTY_DLL_LOAD_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment))) {
    return 'demote-to-inbox';
  }
  if (message.includes(CONPTY_PSEUDOCONSOLE_ERROR_FRAGMENT)) {
    return alreadyRetried ? 'demote-to-inbox' : 'retry-bundled';
  }
  // Everything else — notably `..., error code: 87` from the spawn path the
  // daemon already treats as transient — keeps failing, so the supervisor's
  // restart backoff sees it.
  return 'rethrow';
}

/**
 * Spawn against the bundled ConPTY, applying the recovery policy above.
 *
 * Lives here, next to the policy, because the two spawn sites (daemon
 * `DaemonSessionManager`, local `PTYManager`) had ~40 duplicated lines of
 * try/fallback each — the shape where one site gets a fix and the other keeps
 * the bug. `spawn` takes the backend it should use so this module never
 * imports node-pty (it is loaded by the sandboxed renderer too).
 *
 * `onNotice` reports which backend actually started, and every demotion, so
 * "the mouse stopped working on this pane" is answerable from the log.
 */
export function spawnWithConptyPolicy<T>(
  spawn: (useBundled: boolean) => T,
  useBundled: boolean,
  onNotice: (level: 'info' | 'warn', message: string) => void,
): T {
  if (!useBundled) {
    onNotice('info', 'ConPTY backend = in-box');
    return spawn(false);
  }
  let retried = false;
  for (;;) {
    try {
      const result = spawn(true);
      onNotice('info', `ConPTY backend = bundled conpty.dll${retried ? ' (after one retry)' : ''}`);
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const action = classifyConptySpawnError(detail, retried);
      if (action === 'retry-bundled') {
        retried = true;
        onNotice('warn', `bundled ConPTY failed to start (${detail}); retrying once before demoting`);
        continue;
      }
      if (action === 'demote-to-inbox') {
        onNotice('warn', `bundled ConPTY unusable (${detail}); falling back to in-box ConPTY — this pane has no mouse reporting`);
        const result = spawn(false);
        onNotice('info', 'ConPTY backend = in-box (after bundled demotion)');
        return result;
      }
      throw err;
    }
  }
}
