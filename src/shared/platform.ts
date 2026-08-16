// OS-aware constants and helpers used across main / renderer / daemon / mcp / cli.
//
// Background: prior to this module, ~45 inline `process.platform === 'win32'`
// branches were scattered through src/. New code should prefer `platformChoice`
// and the boolean constants below; existing inline branches migrate boy-scout
// style as files are touched.

export type Platform = 'win32' | 'darwin' | 'linux' | 'other';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const isUnix = !isWindows;

export const currentPlatform: Platform = isWindows
  ? 'win32'
  : isMac
    ? 'darwin'
    : isLinux
      ? 'linux'
      : 'other';

// Pick a value per OS. `default` is required so the return type is non-nullable.
//
// Example:
//   const shellCandidates = platformChoice<string[]>({
//     win: ['pwsh.exe', 'powershell.exe', 'cmd.exe'],
//     mac: ['/bin/zsh', '/bin/bash'],
//     linux: ['/bin/bash', '/bin/zsh'],
//     default: ['/bin/sh'],
//   });
export interface PlatformChoice<T> {
  win?: T;
  mac?: T;
  linux?: T;
  default: T;
}

export function platformChoice<T>(choices: PlatformChoice<T>): T {
  if (isWindows && choices.win !== undefined) return choices.win;
  if (isMac && choices.mac !== undefined) return choices.mac;
  if (isLinux && choices.linux !== undefined) return choices.linux;
  return choices.default;
}

/**
 * Windows build number out of an OS version string — `10.0.19045` -> `19045`.
 *
 * Accepts what `os.release()` and Electron's `process.getSystemVersion()` both
 * return on Windows (measured: identical, `10.0.26200` on Win11 26200). The
 * build is the THIRD field; the first two are the marketing-frozen `10.0` that
 * Windows 11 still reports, so neither one distinguishes 10 from 11.
 *
 * Returns null for anything that is not a version string with a numeric third
 * field, so a caller can keep whatever its no-information default is instead of
 * acting on a number that was never really read.
 */
export function parseWindowsBuildNumber(systemVersion: string | null | undefined): number | null {
  if (typeof systemVersion !== 'string') return null;
  const build = systemVersion.trim().split('.')[2];
  if (build === undefined || !/^\d+$/.test(build)) return null;
  const parsed = Number(build);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

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
 * PTY backend and xterm's `windowsPty.buildNumber` never disagree.
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
 * Error fragments thrown by node-pty's LoadConptyDll when the BUNDLED
 * conpty.dll cannot be loaded (missing/corrupt in this install). Only these
 * justify demoting a spawn to the in-box ConPTY: a transient ConPTY failure
 * (error 87, which PaneSupervisor's restart backoff exists to absorb) must
 * keep failing, or one blip would silently disable the mouse fix for that
 * pane forever.
 *
 * Matched with `includes` against `err.message` (node-pty src/win/conpty.cc:
 * "Failed to get conpty.node module handle", "Failed to get conpty.node
 * module file name", "Cannot find conpty.dll at ...", "Failed to load
 * conpty.dll"). Re-check on node-pty upgrades.
 */
const CONPTY_DLL_LOAD_ERROR_FRAGMENTS = [
  'Failed to get conpty.node module handle',
  'Failed to get conpty.node module file name',
  'Cannot find conpty.dll',
  'Failed to load conpty.dll',
];

export function isConptyDllLoadError(message: string): boolean {
  return CONPTY_DLL_LOAD_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
}
