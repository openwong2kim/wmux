// cwd plausibility check — guards against prompt-scraping false positives (shared).
//
// Background (2026-07-20): the prompt scraper mistook a string like "PS C:\…>"
// shown in terminal text for a real prompt and overwrote a macOS pane's cwd with
// a Windows path. This filters out paths whose shape can't exist on the platform.
// It does not check existence (fs) — this module is used in the renderer too.
//
// Tightened (2026-07-21): a real cwd is always absolute (or ~-anchored, the way
// bash's \w renders $HOME). A bare relative token like "path" can only come from
// scraping screen text that happened to match a prompt regex (observed live: a
// pane's cwd stored as the literal string "path", which then broke the Git tab's
// repo resolution). Reject anything that is not drive-absolute, UNC, POSIX-
// absolute, or ~-anchored — on every platform.

/**
 * Resolve the host platform from whichever channel this process actually has.
 *
 * The renderer runs under `contextIsolation: true` / `nodeIntegration: false`,
 * so it has no `process` global at all — the preload bridge is its only source
 * of the host platform. The old default fell straight through to 'linux' there,
 * which made every Windows path implausible in the renderer (issue #833): the
 * per-surface cwd write silently dropped `C:\…` on every `cd`, so `surface.list`
 * / `pane.list` stayed pinned to the spawn directory while the workspace row —
 * fed by a second, unguarded path — followed along correctly.
 *
 * Order is deliberate: the bridge first (it is the only correct answer in the
 * renderer, and in main it agrees with `process.platform` anyway), then the real
 * `process`, then the historical 'linux' fallback for a bare non-Electron host.
 */
function hostPlatform(): NodeJS.Platform | string {
  const bridged = (globalThis as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  if (typeof bridged === 'string' && bridged) return bridged;
  if (typeof process !== 'undefined' && process.platform) return process.platform;
  return 'linux';
}

/** Whether the cwd shape can exist on the current platform. platform defaults to the runtime environment. */
export function isPlausibleCwd(
  cwd: string,
  platform: NodeJS.Platform | string = hostPlatform(),
): boolean {
  if (!cwd) return false;
  const isWinShape = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\');
  // Absolute (or ~-anchored) shapes only — a relative token is never a real cwd.
  const isPosixShape = cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/');
  if (!isWinShape && !isPosixShape) return false;
  // win32 also allows WSL POSIX paths — both shapes pass.
  if (platform === 'win32') return true;
  return !isWinShape;
}
