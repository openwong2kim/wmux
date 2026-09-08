/**
 * #1103 — main-side mirror of the renderer's default-WSL-distro setting.
 *
 * Same pattern as the shell path itself: the renderer picks the distro in
 * Settings (it owns the persisted copy in session.json) and pushes it here,
 * so pty.create sites never need to thread it through every call — the
 * injection happens at the single place the effective shell is resolved.
 * null means "no choice" → wsl.exe boots the system default (today's
 * behaviour). Values are re-validated at use time (wslDistroArgs); a garbage
 * push degrades to no-args rather than to a broken spawn.
 */
let defaultWslDistro: string | null = null;

export function setDefaultWslDistro(distro: string | null): void {
  defaultWslDistro = distro ? distro : null;
}

export function getDefaultWslDistro(): string | null {
  return defaultWslDistro;
}
