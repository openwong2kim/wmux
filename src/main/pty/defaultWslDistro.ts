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
import { execFile } from 'child_process';
import * as path from 'path';
import { parseWslDistros } from '../../shared/wslDistro';

let defaultWslDistro: string | null = null;
/**
 * The installed distros as of the last successful, non-empty enumeration;
 * null until one succeeds. A failed or empty enumeration never replaces it —
 * "could not ask" is not "nothing is installed".
 */
let knownWslDistros: string[] | null = null;

export function setDefaultWslDistro(distro: string | null): void {
  defaultWslDistro = distro ? distro : null;
  // Re-check the choice against what is installed whenever it is pushed —
  // boot included — so a distro uninstalled since it was chosen falls back
  // to the system default instead of `wsl.exe -d <gone>` exiting every new
  // pane on the spot.
  if (defaultWslDistro && process.platform === 'win32') void enumerateWslDistros();
}

export function noteKnownWslDistros(distros: string[]): void {
  if (distros.length > 0) knownWslDistros = [...distros];
}

export function getDefaultWslDistro(): string | null {
  if (!defaultWslDistro) return null;
  if (knownWslDistros && !knownWslDistros.includes(defaultWslDistro)) {
    console.warn(`[wsl] chosen distro "${defaultWslDistro}" is not installed — booting the system default`);
    return null;
  }
  return defaultWslDistro;
}

/**
 * `wsl --list --quiet`, bounded and total: off-Windows, a missing wsl.exe, a
 * timeout, or garbage output all answer []. WSL_UTF8=1 asks wsl.exe for
 * UTF-8; parseWslDistros still decodes the UTF-16LE older installs emit.
 * ASYNC on purpose — a synchronous child_process call would block the main
 * process for up to the full timeout. Every successful answer refreshes the
 * known-distro cache getDefaultWslDistro checks.
 */
export async function enumerateWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const wslPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
  const stdout = await new Promise<Buffer | null>((resolve) => {
    try {
      execFile(wslPath, ['--list', '--quiet'], {
        // BUFFER, not a forced encoding: wsl.exe emits UTF-16LE on installs
        // that ignore WSL_UTF8, and utf8-decoding those bytes mangles every
        // non-ASCII distro name beyond recovery.
        encoding: 'buffer',
        timeout: 3000,
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: '1' },
      }, (err, out) => { resolve(err ? null : out); });
    } catch {
      resolve(null);
    }
  });
  const distros = stdout === null ? [] : parseWslDistros(stdout);
  noteKnownWslDistros(distros);
  return distros;
}
