import { execFileSync } from 'node:child_process';

/**
 * Determine the UTF-8 locale to inject into spawned shells.
 *
 * Why (issue #321):
 *   On macOS, launching the app from Dock/Finder does not inherit the login shell's `LANG`.
 *   Child shells then fall back to C/POSIX locale, and zsh ZLE (line editor) cannot compose
 *   multibyte UTF-8 input (Korean/CJK), showing broken meta like `<0085>`.
 *   Windows console is codepage/UTF-16 based so `LANG` does not apply.
 *
 * Fix: when spawn env has none of `LANG`/`LC_ALL`/`LC_CTYPE`, inject a system-installed
 *   UTF-8 locale as fallback. Do not touch locale the user set via shell rc or workspace profile
 *   (enforced by callers).
 */

/**
 * Convert BCP-47 locale from `Intl` ("ko-KR") to POSIX region form ("ko_KR").
 * Returns undefined when there is no region subtag (e.g. "en") to avoid guessing without region.
 */
export function intlToPosixRegion(bcp47: string): string | undefined {
  // Script subtags like "ko-Kore-KR" may appear — take only language and 2-letter region.
  const parts = bcp47.split('-');
  const lang = parts[0]?.toLowerCase();
  const region = parts.find((p) => /^[A-Za-z]{2}$/.test(p) && p === p.toUpperCase());
  if (!lang || !region) return undefined;
  return `${lang}_${region}`;
}

/**
 * Pick the best UTF-8 locale from installed list (`locale -a` output).
 * Priority: system region → en_US.UTF-8 → C.UTF-8 → any UTF-8. undefined if none.
 *
 * Pure function (no I/O) for easy unit testing.
 */
export function pickUtf8Locale(available: string[], preferredRegion?: string): string | undefined {
  // Case-insensitive lookup map (normalized key → original string).
  const utf8 = new Map<string, string>();
  for (const raw of available) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase().replace('utf8', 'utf-8');
    if (key.endsWith('.utf-8')) utf8.set(key, name);
  }
  const lookup = (candidate: string): string | undefined => {
    const hit = utf8.get(candidate.toLowerCase().replace('utf8', 'utf-8'));
    return hit;
  };

  if (preferredRegion) {
    const hit = lookup(`${preferredRegion}.UTF-8`);
    if (hit) return hit;
  }
  return lookup('en_US.UTF-8') ?? lookup('C.UTF-8') ?? utf8.values().next().value;
}

// Computed once per process (avoid running `locale -a` on every spawn).
let cached: string | undefined;
let resolved = false;

/**
 * UTF-8 locale for spawn shells on this machine. undefined on Windows (unnecessary).
 * When `locale` binary is missing or fails, returns en_US.UTF-8 as best default
 * (virtually always present on darwin/linux).
 */
export function getShellUtf8Locale(): string | undefined {
  if (resolved) return cached;
  resolved = true;
  if (process.platform === 'win32') {
    cached = undefined;
    return cached;
  }
  let preferredRegion: string | undefined;
  try {
    preferredRegion = intlToPosixRegion(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    preferredRegion = undefined;
  }
  try {
    const out = execFileSync('locale', ['-a'], { encoding: 'utf8', timeout: 3000 });
    cached = pickUtf8Locale(out.split('\n'), preferredRegion) ?? 'en_US.UTF-8';
  } catch {
    // When `locale -a` fails, any value that enables UTF-8 composition is enough.
    cached = 'en_US.UTF-8';
  }
  return cached;
}

/** Test-only: reset memoization cache. */
export function __resetShellLocaleCacheForTest(): void {
  cached = undefined;
  resolved = false;
}
