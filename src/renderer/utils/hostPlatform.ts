/**
 * The HOST platform, as seen from the renderer.
 *
 * The renderer has no `process`, so anything that falls back to
 * `process.platform` resolves to a wrong default there. Shared helpers that
 * take a platform argument (e.g. `isPlausibleCwd`) must be handed this value
 * rather than being left to their own default — see #833, where the default
 * made every Windows path look implausible and froze each surface's cwd.
 *
 * Returns `undefined` when the bridge is unavailable (preload not yet
 * installed, or a jsdom unit test), which lets the callee apply its own
 * default rather than being fed a guess.
 */
export function hostPlatform(): string | undefined {
  // Reached from store slices, which unit tests exercise under the plain node
  // environment where `window` does not exist at all — so this cannot assume it.
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: { platform?: string } }).electronAPI?.platform;
}
