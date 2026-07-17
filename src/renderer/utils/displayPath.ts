// Display-boundary path normalization (macOS NFD → NFC).
//
// macOS reports $PWD and file names in the filesystem's NFD form, so a Korean
// folder arrives as decomposed jamo and renders as broken syllable parts in
// the tab tooltip / working-directories menu. Normalizing for DISPLAY fixes
// the rendering; the underlying state keeps the raw spelling because it
// doubles as the split-inheritance spawn seed, and on normalization-SENSITIVE
// filesystems (NFS/macFUSE mounts) the NFC spelling may not name the real
// directory (Codex review, PR #479 — the same display-vs-execution split
// VS Code and iTerm2 make).
//
// Identity for already-NFC input and on non-mac platforms, so callers can use
// it unconditionally.

/** Normalize a path (or any short label) for rendering on macOS. */
export function displayPath(p: string | undefined | null): string {
  if (!p) return '';
  if (window.electronAPI?.platform !== 'darwin') return p;
  try {
    return p.normalize('NFC');
  } catch {
    return p;
  }
}
