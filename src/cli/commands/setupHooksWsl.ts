/**
 * `wmux setup-hooks --wsl [<distro>] [--uninstall]` — the explicit opt-in that
 * lets Claude Code sessions started in a WSL distro OUTSIDE wmux report to it
 * (external sessions, shared/externalSessions.ts).
 *
 * It merges hook entries into that distro's Claude user settings, resolved as
 * Claude Code resolves them: `$CLAUDE_CONFIG_DIR/settings.json` when set, else
 * `~/.claude/settings.json`. Both the read and the write run INSIDE the distro
 * through wsl.exe (no \\wsl$ access), the write tmp + rename. The user's own
 * entries and every other key are kept; a re-run changes nothing; `--uninstall`
 * removes only this instance's entries.
 *
 * Each entry runs the hook script shared/wslGlobalHook.ts writes under
 * `~/.wmux<suffix>/hooks/` on the Windows side, by its /mnt path. The events
 * are the Windows install's signals-only profile (setupHooks.ts specsFor),
 * SessionEnd included: the wide permission gate fires on EVERY tool call, and
 * here each one would start a Windows process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dataSuffix } from '../../shared/constants';
import { decodeWslOutput, isValidWslDistroName } from '../../shared/wslDistro';
import { shellQuote } from '../../shared/resumeShell';
import { getWmuxDir } from '../../daemon/config';
import {
  isScriptableSuffix,
  writeWslHookScript,
  WSL_GLOBAL_HOOK_SCRIPT,
  WSL_RUNTIME_POINTER,
} from '../../shared/wslGlobalHook';
import { safeReviver, specsFor } from './setupHooks';

/** Seconds Claude Code waits for one hook: a cold Electron start over interop can be slow. */
const WSL_HOOK_TIMEOUT_S = 10;
const WSL_RUN_TIMEOUT_MS = 60_000;

export interface WslRunResult {
  status: number | null;
  /** The Linux child's stdout, UTF-8. */
  stdout: string;
  /** wsl.exe's own message or the child's stderr, decoded. */
  stderr: string;
  /** A spawn failure (wsl.exe missing, timeout). */
  error?: string;
}

/** Runs wsl.exe with `args`, `input` on stdin. Injectable: tests never start a distro. */
export type WslRunner = (args: string[], input?: string) => WslRunResult;

/** A runner over `command` (wsl.exe; tests pass a local sh). */
export function spawnRunner(command: string): WslRunner {
  return (args, input) => runSpawned(command, args, input);
}

export const defaultWslRunner: WslRunner = spawnRunner('wsl.exe');

function runSpawned(command: string, args: string[], input: string | undefined): WslRunResult {
  const out = spawnSync(command, args, {
    // A Buffer: with encoding 'buffer', a string input is refused ("Unknown encoding").
    input: Buffer.from(input ?? '', 'utf8'),
    encoding: 'buffer',
    timeout: WSL_RUN_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    cwd: os.homedir(),
  });
  return {
    status: out.status,
    stdout: out.stdout ? out.stdout.toString('utf8') : '',
    stderr: out.stderr ? decodeWslOutput(out.stderr).trim() : '',
    ...(out.error ? { error: out.error.message } : {}),
  };
}

/**
 * Inside the distro: the settings path, the hook script's Linux path (`$1` is
 * its Windows path) and the settings file, NUL-separated. CLAUDE_CONFIG_DIR is
 * read from this process first (a caller can pass it through WSLENV); this
 * process ran no startup files, so otherwise the user's shell is asked for
 * it as a WSL terminal starts it — login and interactive, so ~/.profile and
 * ~/.bashrc (or zsh's, fish's) both count — bounded, its output discarded but
 * for one marker line. `printenv` reads the exported value (what claude
 * inherits) and needs no POSIX syntax, so fish answers too.
 */
export const WSL_SETTINGS_READ_SCRIPT = `set -u
dir=\${CLAUDE_CONFIG_DIR:-}
if [ -z "$dir" ]; then
  wmux_sh=\${SHELL:-/bin/bash}
  [ -x "$wmux_sh" ] || wmux_sh=/bin/bash
  wmux_bound=
  command -v timeout >/dev/null 2>&1 && wmux_bound="timeout -k 1 10"
  command -v setsid >/dev/null 2>&1 && wmux_bound="setsid $wmux_bound"
  # shellcheck disable=SC2086
  dir=$($wmux_bound "$wmux_sh" -lic 'echo; printf WMUX_CLAUDE_CONFIG_DIR=; printenv CLAUDE_CONFIG_DIR; echo' </dev/null 2>/dev/null \\
    | sed -n 's/^WMUX_CLAUDE_CONFIG_DIR=//p' | tail -n 1)
fi
[ -n "$dir" ] || dir="$HOME/.claude"
case "$dir" in
  '~') dir=$HOME ;;
  '~/'*) dir="$HOME/\${dir#\\~/}" ;;
esac
case "$dir" in
  /*) ;;
  *) printf 'wmux: CLAUDE_CONFIG_DIR is not an absolute path: %s\\n' "$dir" >&2; exit 5 ;;
esac
script=$(wslpath -u "$1" 2>/dev/null) || { printf '%s\\n' 'wmux: wslpath could not translate the hook path' >&2; exit 6; }
file="\${dir%/}/settings.json"
printf '%s\\0%s\\0' "$file" "$script"
if [ -e "$file" ]; then
  hash=nohash
  if command -v sha256sum >/dev/null 2>&1; then hash=$(sha256sum < "$file" | cut -d' ' -f1) || exit 4; fi
  printf 'present\\0%s\\0' "$hash"
  cat -- "$file" || exit 4
else
  printf 'absent\\0absent\\0'
fi
`;

/**
 * Inside the distro: stdin replaces `$1`, tmp + rename beside it (through a
 * symlink). The temp file is created owner-only (settings can hold tokens) and
 * takes the old file's mode when it can, so the file is never readable by
 * others, even for a moment. `$2` is the sha256 of the file as it was read
 * (`absent` when there was none): if Claude wrote it since, nothing is
 * replaced (exit 7) and the CLI asks for a re-run instead of losing that write.
 */
export const WSL_SETTINGS_WRITE_SCRIPT = `set -u
file=$1
expected=$2
if [ -L "$file" ]; then file=$(readlink -f -- "$file") || exit 4; fi
mkdir -p -- "\${file%/*}" || exit 4
umask 077
tmp="$file.wmux-$$.tmp"
if ! cat > "$tmp"; then rm -f -- "$tmp"; exit 4; fi
if [ -e "$file" ]; then
  # GNU and busybox stat both answer -c %a; without it the file stays owner-only.
  mode=$(stat -c %a -- "$file" 2>/dev/null) && chmod "$mode" "$tmp" 2>/dev/null
  if command -v sha256sum >/dev/null 2>&1; then
    now=$(sha256sum < "$file" | cut -d' ' -f1)
  else
    now=$expected
  fi
else
  now=absent
fi
if [ "$now" != "$expected" ]; then rm -f -- "$tmp"; exit 7; fi
if ! mv -f -- "$tmp" "$file"; then rm -f -- "$tmp"; exit 4; fi
`;

/**
 * What identifies this instance's entries: the hook script under ITS data dir.
 * `/.wmux/hooks/…` (production) is not a substring of `/.wmux-x/hooks/…`, so
 * an isolated instance never touches the production entries, or the reverse.
 */
export function wslHookMarker(suffix: string): string {
  return `/.wmux${suffix}/hooks/${WSL_GLOBAL_HOOK_SCRIPT}`;
}

export function wslHookCommand(scriptLinuxPath: string, event: string, extraArgs?: string): string {
  return `/bin/sh ${shellQuote(scriptLinuxPath)} ${event}${extraArgs ? ` ${extraArgs}` : ''}`;
}

interface HookLeaf { type?: unknown; command?: unknown; [k: string]: unknown }
interface HookGroup { matcher?: string; hooks?: unknown[]; [k: string]: unknown }

function isOurLeaf(leaf: unknown, marker: string): boolean {
  return !!leaf && typeof leaf === 'object' && typeof (leaf as HookLeaf).command === 'string' &&
    ((leaf as HookLeaf).command as string).includes(marker);
}

/**
 * Remove this instance's hook leaves, keeping a user's leaf that shares a
 * group with one of ours, and dropping groups, events and `hooks` left empty.
 * Returns the number of leaves removed. Mutates `settings`.
 */
export function stripWslHooks(settings: Record<string, unknown>, marker: string): number {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return 0;
  const map = hooks as Record<string, unknown>;
  let removed = 0;
  for (const event of Object.keys(map)) {
    const groups = map[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups) {
      const leaves = group && typeof group === 'object' ? (group as HookGroup).hooks : undefined;
      if (!Array.isArray(leaves) || !leaves.some((leaf) => isOurLeaf(leaf, marker))) {
        kept.push(group);
        continue;
      }
      const foreign = leaves.filter((leaf) => !isOurLeaf(leaf, marker));
      removed += leaves.length - foreign.length;
      if (foreign.length > 0) kept.push({ ...(group as HookGroup), hooks: foreign });
    }
    if (kept.length === 0) delete map[event];
    else map[event] = kept;
  }
  if (Object.keys(map).length === 0) delete settings.hooks;
  return removed;
}

/** One entry as event, matcher and leaf: what makes two installs the same. */
function entryKey(event: string, matcher: unknown, leaf: HookLeaf): string {
  return JSON.stringify([event, matcher ?? '', leaf.type ?? null, leaf.command, leaf.timeout ?? null]);
}

/** This instance's entries now in `settings`, as sorted entryKeys. */
function installedEntries(settings: Record<string, unknown>, marker: string): string[] {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const keys: string[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const leaves = group && typeof group === 'object' ? (group as HookGroup).hooks : undefined;
      if (!Array.isArray(leaves)) continue;
      for (const leaf of leaves) {
        if (isOurLeaf(leaf, marker)) keys.push(entryKey(event, (group as HookGroup).matcher, leaf as HookLeaf));
      }
    }
  }
  return keys.sort();
}

/**
 * Strip, then add this instance's entries after the user's. Mutates
 * `settings` — unless exactly these entries are already there, wherever the
 * user's own entries sit around them: then nothing moves, and a re-run never
 * rewrites the file.
 */
export function mergeWslHooks(settings: Record<string, unknown>, scriptLinuxPath: string, marker: string): string[] {
  const specs = specsFor('signals-only');
  const wanted = specs.map((spec) => ({
    event: spec.event,
    group: {
      matcher: spec.matcher,
      hooks: [{ type: 'command', command: wslHookCommand(scriptLinuxPath, spec.event, spec.extraArgs), timeout: WSL_HOOK_TIMEOUT_S }],
    },
  }));
  const events = specs.map((spec) => spec.event);
  const wantedKeys = wanted.map(({ event, group }) => entryKey(event, group.matcher, group.hooks[0])).sort();
  if (JSON.stringify(installedEntries(settings, marker)) === JSON.stringify(wantedKeys)) return events;
  stripWslHooks(settings, marker);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks as Record<string, unknown>
    : {};
  for (const { event, group } of wanted) {
    const existing = hooks[event];
    hooks[event] = Array.isArray(existing) ? [...existing, group] : [group];
  }
  settings.hooks = hooks;
  return events;
}

export interface WslSettingsRead {
  settingsPath: string;
  scriptLinuxPath: string;
  exists: boolean;
  /** sha256 of the file as read, `nohash` (no sha256sum in the distro) or `absent`. */
  hash: string;
  settings: Record<string, unknown>;
}

function distroArgs(distro: string | undefined): string[] {
  return distro ? ['-d', distro] : [];
}

function runFailure(what: string, run: WslRunResult): string {
  const detail = run.error ?? (run.stderr || `wsl.exe exited with code ${run.status}`);
  return `${what}: ${detail}`;
}

/** Read the distro's Claude settings. Throws with a message the CLI prints. */
export function readWslSettings(runner: WslRunner, distro: string | undefined, scriptWindowsPath: string): WslSettingsRead {
  const run = runner([...distroArgs(distro), '--exec', '/bin/sh', '-c', WSL_SETTINGS_READ_SCRIPT, 'wmux-wsl-read', scriptWindowsPath]);
  if (run.error || run.status !== 0) throw new Error(runFailure('could not read the Claude settings in WSL', run));
  // path NUL script NUL state NUL hash NUL content
  const cuts: number[] = [];
  for (let i = 0, at = -1; i < 4; i++) {
    at = run.stdout.indexOf('\0', at + 1);
    if (at < 0) throw new Error('could not read the Claude settings in WSL: unexpected answer');
    cuts.push(at);
  }
  const settingsPath = run.stdout.slice(0, cuts[0]);
  const scriptLinuxPath = run.stdout.slice(cuts[0] + 1, cuts[1]);
  const state = run.stdout.slice(cuts[1] + 1, cuts[2]);
  const hash = run.stdout.slice(cuts[2] + 1, cuts[3]);
  const raw = run.stdout.slice(cuts[3] + 1);
  if (!settingsPath.startsWith('/') || !scriptLinuxPath.startsWith('/') || /[\r\n]/.test(scriptLinuxPath) || !/^(?:[0-9a-f]{64}|nohash|absent)$/.test(hash)) {
    throw new Error('could not read the Claude settings in WSL: unexpected answer');
  }
  if (state !== 'present' || raw.trim() === '') {
    return { settingsPath, scriptLinuxPath, exists: state === 'present', hash, settings: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeReviver);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} in WSL is not valid JSON — aborting to avoid overwriting your Claude Code config. Fix or remove the file and re-run.`);
  }
  return { settingsPath, scriptLinuxPath, exists: true, hash, settings: parsed as Record<string, unknown> };
}

/** Exit code of the write script when the file changed after it was read. */
const WRITE_CHANGED_SINCE_READ = 7;

function writeWslSettings(runner: WslRunner, distro: string | undefined, read: WslSettingsRead): void {
  const run = runner(
    [...distroArgs(distro), '--exec', '/bin/sh', '-c', WSL_SETTINGS_WRITE_SCRIPT, 'wmux-wsl-write', read.settingsPath, read.hash],
    JSON.stringify(read.settings, null, 2) + '\n',
  );
  if (!run.error && run.status === WRITE_CHANGED_SINCE_READ) {
    throw new Error(`${read.settingsPath} in WSL changed while wmux was updating it (a running claude saved it); nothing was written — re-run the command.`);
  }
  if (run.error || run.status !== 0) throw new Error(runFailure(`could not write ${read.settingsPath} in WSL`, run));
}

/**
 * A `hooks` value Claude would not read as wmux expects (not an object, or a
 * non-array event list) is the user's to fix: merging would drop it.
 */
function malformedHooks(settings: Record<string, unknown>, settingsPath: string): string | null {
  const hooks = settings.hooks;
  if (hooks === undefined) return null;
  const bad = !hooks || typeof hooks !== 'object' || Array.isArray(hooks)
    ? 'hooks'
    : Object.entries(hooks as Record<string, unknown>).find(([, groups]) => !Array.isArray(groups))?.[0];
  if (!bad) return null;
  return `${settingsPath} in WSL has a "${bad === 'hooks' ? 'hooks' : `hooks.${bad}`}" that is not ${bad === 'hooks' ? 'an object' : 'a list'} — aborting to avoid dropping it. Fix it and re-run.`;
}

export interface WslHooksOptions {
  /** Undefined → the default distro. */
  distro?: string;
  /** `~/.wmux<suffix>/hooks` on Windows. */
  hooksDir: string;
  suffix: string;
  runner?: WslRunner;
}

export interface WslHooksOutcome {
  ok: boolean;
  action: 'install' | 'uninstall';
  distro: string | null;
  settingsPath: string | null;
  /** The hook command's script, as Linux reaches it. */
  scriptPath: string | null;
  /** Whether the settings file was written (false: already as wanted). */
  changed: boolean;
  /** Events installed (install) — empty on uninstall. */
  events: string[];
  /** Entries removed (uninstall). */
  removed: number;
  warning: string | null;
  error: string | null;
}

function validate(options: WslHooksOptions): string | null {
  if (options.distro !== undefined && !isValidWslDistroName(options.distro)) return `not a WSL distribution name: ${JSON.stringify(options.distro)}`;
  if (!isScriptableSuffix(options.suffix)) return `WMUX_DATA_SUFFIX=${options.suffix} cannot be carried by the WSL hook`;
  return null;
}

export function installWslHooks(options: WslHooksOptions): WslHooksOutcome {
  const base: WslHooksOutcome = {
    ok: false, action: 'install', distro: options.distro ?? null, settingsPath: null, scriptPath: null,
    changed: false, events: [], removed: 0, warning: null, error: null,
  };
  const invalid = validate(options);
  if (invalid) return { ...base, error: invalid };
  const runner = options.runner ?? defaultWslRunner;
  try {
    // The script first: an entry must never name a file that is not there.
    const scriptWindowsPath = writeWslHookScript(options.hooksDir, options.suffix);
    const read = readWslSettings(runner, options.distro, scriptWindowsPath);
    const malformed = malformedHooks(read.settings, read.settingsPath);
    if (malformed) return { ...base, settingsPath: read.settingsPath, error: malformed };
    const before = JSON.stringify(read.settings);
    const events = mergeWslHooks(read.settings, read.scriptLinuxPath, wslHookMarker(options.suffix));
    const changed = JSON.stringify(read.settings) !== before;
    if (changed) writeWslSettings(runner, options.distro, read);
    const warning = fs.existsSync(path.join(options.hooksDir, WSL_RUNTIME_POINTER))
      ? null
      : 'wmux has not recorded its runtime yet: start wmux once, or the hooks stay silent until it does.';
    return { ...base, ok: true, settingsPath: read.settingsPath, scriptPath: read.scriptLinuxPath, changed, events, warning };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export function uninstallWslHooks(options: WslHooksOptions): WslHooksOutcome {
  const base: WslHooksOutcome = {
    ok: false, action: 'uninstall', distro: options.distro ?? null, settingsPath: null, scriptPath: null,
    changed: false, events: [], removed: 0, warning: null, error: null,
  };
  const invalid = validate(options);
  if (invalid) return { ...base, error: invalid };
  const runner = options.runner ?? defaultWslRunner;
  try {
    // The read translates this path but never opens it: uninstall writes no script.
    const read = readWslSettings(runner, options.distro, path.join(options.hooksDir, WSL_GLOBAL_HOOK_SCRIPT));
    const malformed = malformedHooks(read.settings, read.settingsPath);
    if (malformed) return { ...base, settingsPath: read.settingsPath, error: malformed };
    const removed = read.exists ? stripWslHooks(read.settings, wslHookMarker(options.suffix)) : 0;
    if (removed > 0) writeWslSettings(runner, options.distro, read);
    return { ...base, ok: true, settingsPath: read.settingsPath, scriptPath: read.scriptLinuxPath, changed: removed > 0, removed };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `<getWmuxDir()>/hooks` — this instance's own (suffix-scoped) dir, the one main writes the pointer into. */
export function defaultWslHooksDir(): string {
  return path.join(getWmuxDir(), 'hooks');
}

/**
 * Parse `--wsl [<distro>] [--uninstall|--remove]` (`args` without --json): the
 * distro, when given, is the word right after --wsl. Anything else is a usage
 * error, never a silent install.
 */
export function parseWslArgs(args: readonly string[]): { distro?: string; uninstall: boolean } | { usage: string } {
  const at = args.indexOf('--wsl');
  if (at === -1) return { usage: '--wsl is missing' };
  const next = args[at + 1];
  const distro = next !== undefined && !next.startsWith('-') ? next : undefined;
  const rest = args.filter((_, i) => i !== at && !(distro !== undefined && i === at + 1));
  let uninstall = false;
  for (const arg of rest) {
    if (arg === '--uninstall' || arg === '--remove') { uninstall = true; continue; }
    return { usage: `Unknown argument for --wsl: ${arg}. Usage: wmux setup-hooks --wsl [<distro>] [--uninstall]` };
  }
  return { ...(distro !== undefined ? { distro } : {}), uninstall };
}

export function handleSetupHooksWsl(args: string[], jsonMode: boolean, runner?: WslRunner): void {
  const parsed = parseWslArgs(args);
  if ('usage' in parsed) {
    console.error(parsed.usage);
    process.exit(1);
    return;
  }
  if (process.platform !== 'win32' && !runner) {
    console.error('--wsl is for wmux on Windows: it installs hooks in a WSL distribution.');
    process.exit(1);
    return;
  }
  const suffix = dataSuffix();
  const options: WslHooksOptions = {
    ...(parsed.distro !== undefined ? { distro: parsed.distro } : {}),
    hooksDir: defaultWslHooksDir(),
    suffix,
    ...(runner ? { runner } : {}),
  };
  const outcome = parsed.uninstall ? uninstallWslHooks(options) : installWslHooks(options);
  if (jsonMode) {
    console.log(JSON.stringify(outcome, null, 2));
  } else if (!outcome.ok) {
    console.error(`wsl hooks: ${outcome.error}`);
  } else {
    const where = outcome.distro ? `WSL ${outcome.distro}` : 'the default WSL distribution';
    if (outcome.action === 'install') {
      console.log(outcome.changed
        ? `wsl hooks: installed in ${outcome.settingsPath} (${where}) → ${outcome.scriptPath}`
        : `wsl hooks: already installed in ${outcome.settingsPath} (${where})`);
      if (outcome.warning) console.warn(`wsl hooks: ${outcome.warning}`);
      if (suffix) console.log(`wsl hooks: these entries report to the isolated instance (WMUX_DATA_SUFFIX=${suffix}).`);
      console.log('Restart claude sessions in that distribution so they load the hooks.');
    } else {
      console.log(outcome.removed > 0
        ? `wsl hooks: removed ${outcome.removed} wmux entries from ${outcome.settingsPath} (${where})`
        : `wsl hooks: no wmux entries in ${outcome.settingsPath} (${where})`);
    }
  }
  if (!outcome.ok) process.exit(1);
}
