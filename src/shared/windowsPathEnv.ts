import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Refresh a child process's PATH from the live Windows registry at spawn time.
 *
 * THE BUG this addresses (RCA 2026-07-24): the env every pane inherits is built
 * from the wmux control process's `process.env` (`resolveSpawnEnv(globalThis.
 * process.env, …)` in PTYManager and pty.handler). That object is a SNAPSHOT
 * taken when the process launched, and a process launched at login / kept alive
 * in the tray for days never sees a PATH the OS wrote to the registry AFTER it
 * started — Node's `process.env` does not track `WM_SETTINGCHANGE`. So a user
 * who installs Node/Python/etc. (which append to `HKCU\Environment\Path`) and
 * then opens a NEW pane still gets the stale PATH and "command not found",
 * unlike every native terminal, which composes PATH fresh from the registry for
 * each new shell.
 *
 * Spawning a child shell to read its env does NOT help: a child inherits the
 * parent's (stale) environment block, it does not re-read the registry. Reading
 * the registry directly is the only way to recover the current PATH from inside
 * a long-lived process.
 *
 * Scope: PATH only. It is the variable installers mutate and the one behind the
 * "my tool isn't found" symptom, and machine+user PATH compose by a known rule
 * (concatenate) so it can be reconstructed safely. Refreshing arbitrary other
 * user variables is a larger, riskier change left for later. Recovery-replayed
 * sessions (the daemon replays a persisted create-time env verbatim on reboot)
 * are also out of scope here — this fixes the env at CREATE time.
 *
 * Fail-open everywhere: a non-win32 platform, the kill switch, or any failed
 * read returns the caller's env untouched, so a pane never ends up with a WORSE
 * PATH than before. Electron-free (only child_process/path) so the daemon could
 * reuse it for the recovery path later.
 */

const SYSTEM_ENV_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_ENV_KEY = 'HKCU\\Environment';

/** Coalesce spawn bursts (session recovery fans out many creates) to one read. */
const CACHE_TTL_MS = 5_000;

let cache: { value: string | null; at: number } | null = null;

/** Test seam: clear the module-level registry-read cache between cases. */
export function resetFreshPathCacheForTests(): void {
  cache = null;
}

/**
 * Ceiling on the exported `.reg` file. `query /v Path` was implicitly bounded by
 * being one value; exporting the whole key is not, and this read is synchronous
 * on the pty-create path. A user PATH is tens of KB at the outside.
 */
const MAX_EXPORT_BYTES = 1024 * 1024;

/** Decode the two escapes `.reg` string values use. NOT JSON unescaping — a
 *  literal `\n` in a path must survive as backslash-n, not become a newline. */
function unescapeRegString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && (s[i + 1] === '\\' || s[i + 1] === '"')) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Pull one value out of a `reg export` file.
 *
 * ```
 * Windows Registry Editor Version 5.00
 *
 * [HKEY_CURRENT_USER\Environment]     ← root section: the only one we read
 * "Path"=hex(2):44,00,3a,00,…,\       ← REG_EXPAND_SZ, UTF-16LE, \-continued
 *   5c,00,61,00,00,00
 * "TEMP"="C:\\Users\\me\\Temp"        ← REG_SZ, \\ and \" escaped
 *
 * [HKEY_CURRENT_USER\Environment\Sub] ← a subkey's "Path" is NOT our value
 * "Path"="C:\\decoy"
 * ```
 *
 * Returns null for anything it cannot decode with certainty — a malformed
 * export must fail open to the caller's existing PATH, never yield a partial
 * one that would silently drop entries.
 */
export function parseRegExportValue(text: string, name: string): string | null {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((l) => l.trimStart().startsWith('['));
  if (open === -1) return null;
  let close = lines.length;
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('[')) {
      close = i;
      break;
    }
  }
  const section = lines.slice(open + 1, close);

  const prefix = `"${name.toLowerCase()}"=`;
  const head = section.findIndex((l) => l.toLowerCase().startsWith(prefix));
  if (head === -1) return null;

  let body = section[head].slice(prefix.length);
  for (let i = head; body.endsWith('\\'); ) {
    i++;
    if (i >= section.length) return null; // continuation runs off the section
    const next = section[i].trim();
    if (!next) return null; // a trailing `\` must be followed by more tokens
    body = body.slice(0, -1) + next;
  }

  if (body.startsWith('"')) {
    if (body.length < 2 || !body.endsWith('"')) return null;
    return unescapeRegString(body.slice(1, -1));
  }

  const hex = body.match(/^hex\(([0-9a-f]+)\):(.*)$/i);
  if (!hex) return null;
  // 1 = REG_SZ, 2 = REG_EXPAND_SZ. Anything else (REG_MULTI_SZ, REG_BINARY…)
  // is not a PATH and must not be decoded as one.
  const type = parseInt(hex[1], 16);
  if (type !== 1 && type !== 2) return null;

  const tokens = hex[2].split(',').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0 || tokens.length % 2 !== 0) return null; // UTF-16 pairs
  const bytes = Buffer.alloc(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    if (!/^[0-9a-f]{1,2}$/i.test(tokens[i])) return null;
    bytes[i] = parseInt(tokens[i], 16);
  }
  return bytes.toString('ucs2').replace(/\0+$/, '');
}

/**
 * Read the raw `Path` value from a registry Environment key via `reg.exe`.
 * `reg.exe` is used (not a cmdlet/.NET call) because it is immune to PowerShell
 * language-mode lockdown and returns the value WITHOUT expanding `%VAR%` — we do
 * the expansion ourselves against the caller's env. Returns null on any failure
 * or when the key has no `Path` value (e.g. a user with no user-scoped PATH).
 *
 * `export` to a file, NOT `query` to a pipe (#849). `reg.exe` encodes piped text
 * in the console/ANSI code page, so a PATH entry like `D:\软件\Python312` comes
 * back with the characters that page cannot represent already replaced by `?`,
 * and the rest as invalid UTF-8 → U+FFFD. That loss happens in reg.exe before
 * Node sees a byte, so no choice of decoding recovers it. A `.reg` file is
 * UTF-16LE, so no code page is involved at all.
 *
 * Exported so a test can drive the real reader against a sandbox key: the
 * `deps.readRegistryPath` seam below means every existing test stubs this
 * function out, which is precisely why the encoding bug shipped green.
 */
export function readRegistryEnvPath(root: string): string | null {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const tmp = path.join(os.tmpdir(), `wmux-regpath-${randomBytes(8).toString('hex')}.reg`);
  try {
    // Synchronous because both callers sit on the synchronous pty-create path
    // (PTYManager.create). The timeout bounds the pathological case (AV hooking
    // child spawns), capping the worst-case main-process stall at 2×800ms per
    // cache miss. `/y` so a leftover file from a crashed run can never turn
    // this into an overwrite prompt that blocks until that timeout.
    execFileSync(reg, ['export', root, tmp, '/y'], {
      stdio: 'ignore',
      timeout: 800,
      windowsHide: true,
    });
    if (fs.statSync(tmp).size > MAX_EXPORT_BYTES) return null;
    const raw = fs.readFileSync(tmp);
    // `reg export` writes UTF-16LE with a BOM. Check it rather than decoding
    // blind: without this the parser only skips a stray U+FEFF because it
    // happens to scan for `[`, and a file that is not UTF-16 would decode to
    // garbage that the parser might still find a `Path=` line in. Wrong
    // encoding is exactly the failure this whole change is about, so it fails
    // open instead of guessing.
    if (raw.length < 2 || raw[0] !== 0xff || raw[1] !== 0xfe) return null;
    return parseRegExportValue(raw.subarray(2).toString('ucs2'), 'Path');
  } catch {
    return null;
  } finally {
    // Best-effort and swallowed: a failed unlink must not mask a good result
    // nor turn a caught failure into a throw.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone, or locked by a scanner — the OS reaps %TEMP% */
    }
  }
}

/** Expand `%VAR%` references against `baseEnv` (case-insensitive). Unknown vars
 *  are left literal so a bad reference degrades to a harmless dead PATH entry. */
export function expandPercentRefs(value: string, baseEnv: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(baseEnv).find((k) => k.toLowerCase() === name.toLowerCase());
    const v = key ? baseEnv[key] : undefined;
    return typeof v === 'string' ? v : whole;
  });
}

/**
 * Compose the current registry PATH the way Windows does — machine PATH then
 * user PATH — with `%VAR%` expanded. Returns null only when NEITHER key could be
 * read (so the caller keeps its existing PATH).
 */
export function composeRegistryPath(
  systemRaw: string | null,
  userRaw: string | null,
  baseEnv: NodeJS.ProcessEnv,
): string | null {
  if (systemRaw === null && userRaw === null) return null;
  const parts: string[] = [];
  if (systemRaw !== null) parts.push(expandPercentRefs(systemRaw, baseEnv));
  if (userRaw !== null) parts.push(expandPercentRefs(userRaw, baseEnv));
  return parts.filter(Boolean).join(';');
}

/**
 * Merge the fresh registry PATH with any entries the running process added at
 * runtime that the registry doesn't carry (e.g. the wmux `bin` shim path, or a
 * tool that mutated its own PATH). Fresh entries lead (native-terminal order);
 * runtime-only extras are appended. Dedup is case-insensitive (win32 paths).
 */
export function mergeFreshPathWithBase(freshPath: string, baseEnv: NodeJS.ProcessEnv): string {
  const SEP = ';';
  const fresh = freshPath.split(SEP).filter(Boolean);
  const seen = new Set(fresh.map((e) => e.toLowerCase()));
  const baseKey = Object.keys(baseEnv).find((k) => k.toLowerCase() === 'path');
  const baseVal = baseKey ? baseEnv[baseKey] : undefined;
  const extras =
    typeof baseVal === 'string'
      ? baseVal.split(SEP).filter((e) => e && !seen.has(e.toLowerCase()))
      : [];
  return [...fresh, ...extras].join(SEP);
}

export interface FreshPathDeps {
  platform?: NodeJS.Platform;
  disabled?: boolean;
  now?: () => number;
  readRegistryPath?: (root: string) => string | null;
}

/**
 * Return a copy of `baseEnv` whose PATH is refreshed from the live registry, so
 * a pane spawned by a long-lived process sees tools installed AFTER that process
 * started — matching what a freshly opened terminal gets. Off-win32, disabled
 * (`WMUX_NO_PATH_REFRESH=1`), or a failed read returns `baseEnv` UNCHANGED so a
 * pane never gets a worse PATH than today. `deps` is a test seam.
 */
export function withFreshWindowsPath(
  baseEnv: NodeJS.ProcessEnv,
  deps: FreshPathDeps = {},
): NodeJS.ProcessEnv {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return baseEnv;
  const disabled = deps.disabled ?? process.env.WMUX_NO_PATH_REFRESH === '1';
  if (disabled) return baseEnv;

  const now = deps.now ?? Date.now;
  const read = deps.readRegistryPath ?? readRegistryEnvPath;

  let fresh: string | null;
  const t = now();
  if (cache && t - cache.at < CACHE_TTL_MS) {
    fresh = cache.value;
  } else {
    fresh = composeRegistryPath(read(SYSTEM_ENV_KEY), read(USER_ENV_KEY), baseEnv);
    cache = { value: fresh, at: t };
  }
  if (!fresh) return baseEnv; // both reads failed — keep the existing PATH

  const merged = mergeFreshPathWithBase(fresh, baseEnv);
  const copy: NodeJS.ProcessEnv = { ...baseEnv };
  const baseKey = Object.keys(baseEnv).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  copy[baseKey] = merged;
  return copy;
}
