import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Electron-free so it can be unit-tested without an Electron runtime — the
// IPC registration that wraps this lives in ../ipc/handlers/fonts.handler.ts.

const execFileAsync = promisify(execFile);

// Enumerate installed font *family* names via .NET's
// InstalledFontCollection. This returns CSS-resolvable family names
// ("Cascadia Code", "JetBrains Mono", "D2Coding") — unlike the registry
// `…\Fonts` value-names, which are file-display strings like
// "Arial Bold (TrueType)" that don't match a CSS family. `[Console]::
// OutputEncoding = UTF-8` is set first so Korean/CJK family names survive the
// pipe instead of being mangled by the console's OEM codepage (CP949 on a
// Korean Windows). Single line by design (see feedback_command_single_line).
const PS_FONT_SCRIPT =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";

// PowerShell cold-start + assembly load is a few hundred ms; 5s is generous
// headroom while still bounding a hung spawn so the Settings panel never waits
// indefinitely for suggestions.
const PS_TIMEOUT_MS = 5000;

// 156 families on a stock box, longest ~40 chars → ~10KB. 1MB is ~100x
// headroom and caps a runaway/garbage stream.
const PS_MAX_BUFFER = 1024 * 1024;

/**
 * Parse the newline-delimited PowerShell stdout into a clean, de-duplicated,
 * locale-sorted list of family names. Pure (no I/O) so it is unit-testable
 * without spawning PowerShell. Trims each line, drops blanks, and collapses
 * the weight-variant duplicates PowerShell can emit (the datalist filters the
 * rest as the user types).
 */
export function parseFontList(stdout: string): string[] {
  const names = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

// Resolve powershell.exe candidates. A bare `'powershell.exe'` relies on
// %SystemRoot%\System32\WindowsPowerShell\v1.0 being on the *spawned* process's
// PATH — which is NOT guaranteed. In Electron's main process (and some shells)
// the lookup fails with ENOENT, so the enumeration silently fell into the
// catch-all `[]` and the Settings picker showed no installed fonts at all.
// Prefer the absolute path (SystemRoot is always set on Windows), then fall
// back to the bare name in case SystemRoot is somehow unset but PATH works.
function powershellCandidates(): string[] {
  const root = process.env.SystemRoot || process.env.windir;
  const candidates: string[] = [];
  if (root) candidates.push(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
  candidates.push('powershell.exe');
  return candidates;
}

// system_profiler can take several seconds on first run (cold font cache) — allow 15s.
// Suggestions are optional convenience; on timeout we quietly fall back to [].
const SP_TIMEOUT_MS = 15000;

// Hundreds of fonts × typeface metadata JSON — can reach several MB; cap at 16MB.
const SP_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Parse `system_profiler SPFontsDataType -json` stdout into CSS-usable font family
 * names. The typeface `family` field matches CSS family ("Menlo", "Apple SD Gothic Neo",
 * etc. — family name, not filename). Pure function (no I/O) so unit tests need no
 * system_profiler. On malformed input, collect what parses instead of throwing.
 */
export function parseMacFontProfile(stdout: string): string[] {
  const names: string[] = [];
  try {
    const json = JSON.parse(stdout) as {
      SPFontsDataType?: Array<{ typefaces?: Array<{ family?: unknown }> }>;
    };
    for (const font of json.SPFontsDataType ?? []) {
      for (const typeface of font.typefaces ?? []) {
        if (typeof typeface.family === 'string') {
          const name = typeface.family.trim();
          if (name.length > 0) names.push(name);
        }
      }
    }
  } catch {
    // Broken JSON — treat as no suggestions
    return [];
  }
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

async function listMacFonts(): Promise<string[]> {
  // system_profiler always lives at /usr/sbin — use absolute path, no PATH dependency.
  const { stdout } = await execFileAsync(
    '/usr/sbin/system_profiler',
    ['SPFontsDataType', '-json'],
    { timeout: SP_TIMEOUT_MS, maxBuffer: SP_MAX_BUFFER, encoding: 'utf8' as const },
  );
  return parseMacFontProfile(stdout);
}

async function listWindowsFonts(): Promise<string[]> {
  const args = ['-NoProfile', '-NonInteractive', '-Command', PS_FONT_SCRIPT];
  const opts = { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: PS_MAX_BUFFER, encoding: 'utf8' as const };
  let lastErr: unknown;
  for (const exe of powershellCandidates()) {
    try {
      const { stdout } = await execFileAsync(exe, args, opts);
      return parseFontList(stdout);
    } catch (err) {
      // Try the next candidate (e.g. ENOENT on the bare name); the public
      // listInstalledFonts() still swallows a total failure into [].
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Best-effort enumeration of installed font families for the Settings font
 * picker. Contract: NEVER throws and NEVER rejects. On a non-Windows platform,
 * a spawn failure, a timeout, or a parse error it resolves `[]`. The renderer's
 * font input is free-text, so an empty list simply means "no suggestions".
 */
export async function listInstalledFonts(): Promise<string[]> {
  try {
    if (process.platform === 'win32') return await listWindowsFonts();
    if (process.platform === 'darwin') return await listMacFonts();
    // Linux enumeration is follow-up work — [] means the picker stays free-text.
    return [];
  } catch {
    // Swallow: a missing/locked PowerShell, a slow system_profiler, or a slow
    // box must not surface an error toast for an optional convenience feature.
    return [];
  }
}
