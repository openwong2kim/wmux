import { execFile } from 'node:child_process';
import { isWslShell } from '../../shared/wslCwd';

/**
 * Resolve the WSL distribution a pane is actually running in.
 *
 * A pane launched as bare `wsl.exe` carries no distro anywhere in its
 * `SessionLocation` — `classifySessionLocation` can only recover one from a
 * `\\wsl$\<distro>\…` UNC cwd, and a pane started at `/home/me` has none. Every
 * consumer that must act on that pane (`prepareLocationCommand` →
 * `wsl.exe -d <distro> --exec git …`, `toHostAccessiblePath` →
 * `\\wsl.localhost\<distro>\…`) needs the name, so without this the pane's
 * branch / PR / dirty-count line stays empty for its whole first session.
 *
 * Cost discipline (issue #21 AC 4):
 *   - enumeration only — `wsl.exe -l …` reads the registered-distro list and
 *     never starts a distribution, so a passive metadata poll can call this on
 *     a pane whose distro is idle without booting it;
 *   - non-interactive — no shell, no stdin, `windowsHide`, bounded by a hard
 *     timeout and an output cap so a wedged `wsl.exe` can never hang the poll;
 *   - cached — the registered-distro list changes when a user installs or
 *     removes a distribution, i.e. essentially never, so one enumeration
 *     serves every pane for `WSL_LIST_TTL_MS`.
 */

const WSL_LIST_TIMEOUT_MS = 3_000;
const WSL_LIST_MAX_BUFFER = 256 * 1024;
const WSL_LIST_TTL_MS = 60_000;

export interface WslDistroList {
  /** Every registered distribution, in `wsl -l -q` order. */
  names: string[];
  /** Distributions currently running — none of them started by this call. */
  running: string[];
  /** The distribution a bare `wsl.exe` launches, when it can be identified. */
  defaultName?: string;
}

/**
 * Runs `wsl.exe` with the given args and returns its decoded stdout, or `''`
 * for any failure (missing wsl.exe, timeout, non-zero exit). Injected as a
 * defaulted parameter so tests drive the parsing without spawning anything.
 */
export type WslRunner = (args: readonly string[]) => Promise<string>;

type WslExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: 'buffer';
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    env: NodeJS.ProcessEnv;
  },
  callback: (error: Error | null, stdout: Buffer) => void,
) => unknown;

/**
 * `wsl.exe` writes UTF-16LE unless `WSL_UTF8=1` is honoured (newer builds
 * only), so sniff instead of trusting either: a NUL byte in the first chunk of
 * a distro listing can only come from UTF-16.
 */
function decodeWslOutput(buffer: Buffer): string {
  const probe = buffer.subarray(0, 64);
  const text = probe.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8');
  return text.replace(/^\uFEFF/, '');
}

export function createWslRunner(
  runFile: WslExecFile = execFile as unknown as WslExecFile,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): WslRunner {
  return (args) => new Promise<string>((resolve) => {
    if (platform !== 'win32') {
      resolve('');
      return;
    }
    try {
      runFile(
        'wsl.exe',
        [...args],
        {
          // `encoding: 'buffer'` because the codepage is decided per build (see
          // decodeWslOutput). WSL_UTF8 asks for UTF-8 where it is supported.
          encoding: 'buffer',
          timeout: WSL_LIST_TIMEOUT_MS,
          maxBuffer: WSL_LIST_MAX_BUFFER,
          windowsHide: true,
          env: { ...env, WSL_UTF8: '1' },
        },
        (error, stdout) => {
          if (error || !stdout) {
            resolve('');
            return;
          }
          resolve(decodeWslOutput(stdout));
        },
      );
    } catch {
      resolve('');
    }
  });
}

const defaultRunner = createWslRunner();

function parseQuietList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * `wsl -l -v` marks the default distribution with a leading `*`. The header row
 * and the STATE column are localized, but the marker and the name are not, so
 * we only read the marker and then match the remainder against the
 * (authoritative, header-free) `wsl -l -q` names — which also survives a distro
 * name containing spaces.
 */
function parseDefaultName(verboseOutput: string, names: readonly string[]): string | undefined {
  const longestFirst = [...names].sort((a, b) => b.length - a.length);
  for (const rawLine of verboseOutput.split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, '').trim();
    if (!line.startsWith('*')) continue;
    const rest = line.slice(1).trim();
    const match = longestFirst.find((name) => rest === name || rest.startsWith(`${name} `));
    if (match) return match;
  }
  return undefined;
}

let cached: { at: number; value: Promise<WslDistroList> } | null = null;

/** Drops the memoized distro list so tests can isolate cache state. */
export function resetWslDistroCache(): void {
  cached = null;
}

async function enumerate(run: WslRunner): Promise<WslDistroList> {
  const [quiet, verbose, running] = await Promise.all([
    run(['-l', '-q']),
    run(['-l', '-v']),
    run(['-l', '-q', '--running']),
  ]);
  const names = parseQuietList(quiet);
  const defaultName = parseDefaultName(verbose, names);
  return {
    names,
    running: parseQuietList(running).filter((name) => names.includes(name)),
    ...(defaultName ? { defaultName } : {}),
  };
}

/**
 * The registered-distro list, memoized for `WSL_LIST_TTL_MS`. Concurrent
 * callers share one in-flight enumeration; an empty result is not retained, so
 * a transient `wsl.exe` failure does not stick for the whole TTL.
 */
export function listWslDistros(run: WslRunner = defaultRunner): Promise<WslDistroList> {
  const now = Date.now();
  if (cached && now - cached.at < WSL_LIST_TTL_MS) return cached.value;
  const entry = {
    at: now,
    value: enumerate(run).then((list) => {
      if (list.names.length === 0 && cached?.value === entry.value) cached = null;
      return list;
    }).catch(() => {
      if (cached?.value === entry.value) cached = null;
      return { names: [], running: [] } as WslDistroList;
    }),
  };
  cached = entry;
  return entry.value;
}

export interface WslPaneContext {
  /** The pane's shell command, e.g. `C:\\Windows\\System32\\wsl.exe`. */
  shell: string;
  /** Spawn argv, if the pane pinned a distribution with `-d` / `--distribution`. */
  args?: readonly string[];
  /** The pane's environment, if it is known to carry `WSL_DISTRO_NAME`. */
  env?: Record<string, string | undefined>;
}

/** `-d <name>`, `--distribution <name>`, `-d=<name>` — whichever the pane used. */
function distroFromArgs(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const inline = /^(?:-d|--distribution)=(.+)$/.exec(arg);
    if (inline) return inline[1];
    if (arg === '-d' || arg === '--distribution') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) return next;
    }
  }
  return undefined;
}

/**
 * The distribution this pane runs in, or `undefined` when it cannot be named
 * without guessing (a caller that gets `undefined` must fail closed rather than
 * pick a distro — see `WSL_DISTRO_REQUIRED`).
 *
 * Order: what the pane itself states (explicit `-d`, then `WSL_DISTRO_NAME`)
 * beats enumeration, because those are facts about THIS pane. Enumeration then
 * names the default distribution, which is exactly what a bare `wsl.exe` pane
 * launched; if the default cannot be identified, a single registered — or
 * single running — distribution is unambiguous, and anything else stays
 * unresolved.
 */
export async function resolveWslDistro(
  ctx: WslPaneContext,
  run: WslRunner = defaultRunner,
): Promise<string | undefined> {
  if (!isWslShell(ctx.shell)) return undefined;

  const explicit = distroFromArgs(ctx.args);
  if (explicit) return explicit;

  const fromEnv = ctx.env?.WSL_DISTRO_NAME?.trim();
  if (fromEnv) return fromEnv;

  const list = await listWslDistros(run);
  if (list.defaultName) return list.defaultName;
  if (list.names.length === 1) return list.names[0];
  if (list.running.length === 1) return list.running[0];
  return undefined;
}
