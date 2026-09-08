/**
 * #1103 — WSL distro selection.
 *
 * `wsl.exe` with no arguments boots the system's DEFAULT distro, which on a
 * machine with Docker Desktop is usually docker-desktop — not the Ubuntu the
 * user actually works in. These helpers carry one strict contract end to end:
 * the distro choice travels as EXACTLY `['-d', '<name>']` in front of any
 * other wsl.exe arguments, and every trust boundary validates that shape
 * before it reaches a spawn.
 */

/**
 * A WSL distro name as `wsl --list` prints it: letters, digits, dots,
 * underscores, hyphens (e.g. `Ubuntu-24.04`, `openSUSE-Leap-15.6`). Anchored
 * and charset-restricted on purpose — this value becomes a spawn argument, so
 * it must never be able to carry a flag, a space, or a quote.
 */
export const WSL_DISTRO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Basename check that tolerates any casing/separators of a wsl.exe path. */
export function isWslShellPath(shellPath: string | undefined): boolean {
  if (!shellPath) return false;
  const base = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return base === 'wsl.exe' || base === 'wsl';
}

export function isValidWslDistroName(name: unknown): name is string {
  return typeof name === 'string' && WSL_DISTRO_NAME_RE.test(name);
}

/**
 * The spawn arguments for a distro choice, or undefined when none applies
 * (not a wsl shell, or no distro chosen → system default, today's behaviour).
 */
export function wslDistroArgs(
  shellPath: string | undefined,
  distro: string | undefined | null,
): string[] | undefined {
  if (!isWslShellPath(shellPath)) return undefined;
  if (distro === undefined || distro === null || distro === '') return undefined;
  if (!isValidWslDistroName(distro)) return undefined;
  return ['-d', distro];
}

/**
 * Trust-boundary check for args arriving over a wire (the daemon RPC): they
 * must be exactly a validated distro selection for a wsl shell. Anything
 * else — extra flags, `--exec`, reordering, non-wsl shells — is refused
 * rather than argued with. The daemon's spawn surface is not a shell parser.
 */
export function isWslDistroSpawnArgs(
  shellPath: string | undefined,
  args: unknown,
): args is string[] {
  if (!Array.isArray(args) || args.length !== 2) return false;
  if (args[0] !== '-d') return false;
  if (!isValidWslDistroName(args[1])) return false;
  return isWslShellPath(shellPath);
}

/**
 * Parse `wsl --list --quiet` output into distro names. Invoked with
 * `WSL_UTF8=1`, the output is UTF-8; older/misbehaving installs still emit
 * UTF-16LE, which is detected by its interleaved NUL bytes and decoded by
 * stripping them. Blank lines, a BOM, and stray \r are tolerated; nothing
 * matching the name charset survives to the output by accident.
 * Docker-owned distros (`docker-desktop`, `docker-desktop-data`) sort LAST —
 * they are infrastructure, not workspaces (#1103's whole complaint).
 */
export function parseWslDistros(raw: string): string[] {
  let text = raw;
  if (raw.includes('\u0000')) {
    // UTF-16LE without the decoder: ASCII-range names survive NUL-stripping.
    text = raw.replace(/\u0000/g, '');
  }
  const names = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => WSL_DISTRO_NAME_RE.test(line));
  const unique = [...new Set(names)];
  return unique.sort((a, b) => {
    const aDocker = a.toLowerCase().startsWith('docker-desktop');
    const bDocker = b.toLowerCase().startsWith('docker-desktop');
    if (aDocker !== bDocker) return aDocker ? 1 : -1;
    return a.localeCompare(b);
  });
}
