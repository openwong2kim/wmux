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

/** Whether the cwd shape can exist on the current platform. platform defaults to the runtime environment. */
export function isPlausibleCwd(
  cwd: string,
  platform: NodeJS.Platform | string = typeof process !== 'undefined' ? process.platform : 'linux',
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
