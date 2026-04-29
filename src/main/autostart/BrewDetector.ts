import * as fs from 'fs';
import { isMac } from '../../shared/platform';

const BREW_CASKROOM_PATHS = [
  '/opt/homebrew/Caskroom/wmux',  // Apple Silicon (default Homebrew prefix)
  '/usr/local/Caskroom/wmux',     // Intel Mac (legacy Homebrew prefix)
];

/**
 * Returns true when this wmux installation appears to come from Homebrew Cask.
 * Used to disable in-app auto-update so brew/cask can manage upgrades.
 *
 * Detection: cask receipt directories live under Caskroom regardless of where
 * the .app is symlinked. This works even when Finder-launched apps don't have
 * brew on PATH (which would make `brew list --cask` always fail).
 */
export function isBrewInstalled(): boolean {
  if (!isMac) return false;
  for (const p of BREW_CASKROOM_PATHS) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return true;
    } catch { /* skip */ }
  }
  return false;
}

/** Returns the Caskroom path that matched, for diagnostics. */
export function getBrewCaskroomPath(): string | null {
  if (!isMac) return null;
  for (const p of BREW_CASKROOM_PATHS) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch { /* skip */ }
  }
  return null;
}
