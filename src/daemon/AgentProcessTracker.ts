/**
 * Edge-triggered "is this pane's agent process still alive?" tracker — the
 * process-truth gate for the persistent resume chip (ResumeInfoChip) and,
 * since #919, tier-2 of the pane's canonical agent identity.
 *
 * Problem it solves: on panes WITHOUT OSC 133 shell integration the chip's
 * only busy signal was a decaying activity heuristic (HOOK_RUNNING_TTL_MS).
 * A live `claude` that stays quiet past the TTL (long thinking gap, or a
 * finished turn waiting for the user) read as "not busy", so the chip
 * surfaced MID-SESSION — clicking 복구 would type a resume command into the
 * agent's own input. The fix is an edge trigger: observe the agent PROCESS
 * and flip exactly once, on the alive→dead transition, no matter how the
 * agent exits (double Ctrl+C, /exit, Ctrl+D, crash).
 *
 * Identity (#919): the picked process now also answers WHICH agent runs in
 * the pane — a native agent stem (`claude`, `grok`, …) or a runtime whose
 * command line resolves to one (`node …/@anthropic-ai/claude-code/cli.js`).
 * identityFor() feeds the canonical tier rule (src/daemon/canonicalAgent.ts);
 * a slugless pick (unknown wrapper, direct child) still answers liveness
 * only, which is all the resume chip ever needed.
 *
 * Mechanism:
 *  1. arm(sessionId, shellPid) — called when something PROVES the agent is
 *     running right now (a claude hook reaching daemon.setResumeBinding, or
 *     a live AgentDetector banner). Takes ONE process-table snapshot
 *     (pid/ppid/name/cmdline), walks the pane shell's descendant tree, and
 *     picks the agent process (see selectAgentProcess). rearm() is the
 *     forced variant for conflicting-agent evidence (the old pick's death
 *     poll can lag a fresh launch by up to one ProcessMonitor cadence).
 *  2. The picked PID is handed to the daemon's existing ProcessMonitor batch
 *     (one shared tasklist per tick — no new spawn train; #538 discipline),
 *     which also guards against PID reuse via image-name identity.
 *  3. onDead → the session's state flips to alive=false and STAYS false until
 *     a fresh arm()/rearm() (agent relaunched → new hook/banner) re-probes.
 *     The flip also fires the state-change listener so the daemon can expire
 *     the pane's hook authority and recompute canonical identity.
 *
 * statusFor()/identityFor() are tri-state on purpose: `undefined` (never
 * armed / couldn't attribute) keeps the renderer on its old heuristic, so
 * this tracker only ever REPLACES guesswork with process truth — it never
 * invents a state. Both are synchronous map reads; the ONLY enumeration
 * lives inside arm()/rearm().
 *
 * Cost: one process-table enumeration per agent LAUNCH per pane (not per
 * poll), then a piggyback ride on the ProcessMonitor cadence. Unattributable
 * or failed probes back off for ARM_BACKOFF_MS so a chatty banner cannot
 * re-run `ps` per event.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AGENT_ROWS, AGENT_SLUG_SET, type AgentSlug } from '../shared/agentIdentity';
import type { WslAgentLocation, WslReportedAgent, WslWatchedAgent } from './wslAgentProcess';

const execFileAsync = promisify(execFile);

export interface ProcessTreeEntry {
  pid: number;
  ppid: number;
  /** Executable image name (basename). On POSIX derived from argv[0] of the
   *  args column — `comm` was dropped (macOS prints the full path there and
   *  spaces in it misalign every column). */
  name: string;
  /** Full command line (POSIX args / Windows CommandLine) when available —
   *  the input for runtime→agent resolution. */
  cmdline?: string;
  /** Windows only: the process's creation time (epoch ms), when it could be
   *  read. Windows never reparents, so a ppid alone can name a dead parent
   *  whose pid a later process reused; a child is never older than its parent. */
  created?: number;
}

/** The watcher surface the tracker needs — ProcessMonitor satisfies it
 *  structurally, and tests inject a fake. */
export interface PidWatcher {
  watch(key: string, pid: number, onDead: () => void): void;
  unwatch(key: string): void;
}

/** Native agent stems derive from the identity table (#919: the old
 *  hand-written two-entry set was 2 of 9 agents and a second list to drift).
 *  Membership test uses AGENT_SLUG_SET (ReadonlySet<string>) so raw stems
 *  narrow without a cast dance. */
const RUNTIME_STEMS: ReadonlySet<string> = new Set(['node', 'bun', 'deno', 'python', 'python3']);

/** Windows images that may hold a Claude conversation when their command
 *  line cannot be read (processesWithArg). */
const UNREADABLE_HOLDER_IMAGE = /^(claude|node|bun)(\.exe)?$/i;

/** Package-manager runners: when the script token is one of these (or
 *  python's `-m`), the agent name rides the NEXT non-flag argument
 *  (`npx -y gemini`, `python -m aider`). */
const RUNNER_STEMS: ReadonlySet<string> = new Set(['npx', 'npx-cli', 'bunx', 'yarn']);

/** Launcher spellings → slug: every npm package name and native executable
 *  name a registry row declares under `process` (agentIdentity.ts). The
 *  Kiro integration ships a `kiro-cli` executable; its slug is `kiro`. */
const ALIAS_TO_SLUG: ReadonlyMap<string, AgentSlug> = new Map(
  AGENT_ROWS.flatMap((row) =>
    [...(row.process?.packages ?? []), ...(row.process?.executables ?? [])].map((name) => [name, row.slug] as const),
  ),
);

/** Native executable stems whose binary name differs from the slug — the
 *  selectAgentProcess image-stem check consults this alongside the slug set
 *  (a `kiro-cli` process IS the kiro agent even though `kiro-cli` is not a
 *  slug). The registry rows' `process.executables`. */
const NATIVE_STEM_TO_SLUG: ReadonlyMap<string, AgentSlug> = new Map(
  AGENT_ROWS.flatMap((row) => (row.process?.executables ?? []).map((name) => [name, row.slug] as const)),
);

/** How long an unattributable/failed probe keeps `arm()` from re-enumerating
 *  (#919 panel: without this, a chatty banner re-runs `ps` per event). */
const ARM_BACKOFF_MS = 30_000;

/** Forced re-probes are stronger evidence than a plain arm, but still
 *  rate-limited: repeated conflicting banners against an OLD pick that keeps
 *  winning add no new information. */
const REARM_COOLDOWN_MS = 10_000;

/** How long an armIfAgent probe that found no named agent keeps the next one
 *  away. A guess-driven probe fires on every foreground command that outlives
 *  its settle window, so without this a run of long commands (or pwsh on
 *  Windows, where each listing spawns PowerShell) would enumerate per Enter.
 *  Shorter than the retry gap in commandStartAgentProbe.ts, so a command's
 *  own retry still runs. */
export const AGENT_MISS_BACKOFF_MS = 4_000;

/** `claude.exe` → `claude`; `C:\...\node.EXE` → `node`; `pwsh` → `pwsh`. */
function imageStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|com|cmd|bat)$/, '');
}

/**
 * Quote-aware command-line tokenizer. Windows CommandLine carries quoted
 * paths (`"C:\Program Files\node.exe" …`) that a bare whitespace split would
 * tear apart. Escaped quotes are not handled — agent command lines don't
 * carry them. Pure — exported for unit tests.
 */
export function tokenizeCmdline(cmdline: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of cmdline) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Token → lookup form: basename (separators split, which also unwraps
 *  `@scope/pkg` → `pkg`), lowercased, script/binary extension stripped. */
function lookupForm(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(js|mjs|cjs|exe|cmd|bat|py|pyw)$/, '');
}

/**
 * Resolve a runtime-hosted process (`node …`, `python …`) to an agent slug
 * from its command line. Token discipline (#919 panels): ONLY these
 * candidates are ever matched —
 *   • the script token right after the runtime (`argv[1]`, or the first
 *     non-flag token when runtime flags precede it) — PATH FORM ONLY: a
 *     bare `claude.js`/`aider.py` in the script slot is the user's own
 *     file, never an agent,
 *   • the first non-flag token after a package runner or `python -m`
 *     (that slot names a PACKAGE — `npx -y gemini` — so bare is fine),
 *   • the `node_modules/<pkg>` / `node_modules/@scope/<pkg>` boundary of any
 *     of the above.
 * Arbitrary ancestor directories NEVER match: `node /work/claude/scratch.js`
 * must not resolve claude, and `node demo.js claude` must not either (the
 * trailing positional is never a candidate). Every candidate must EQUAL a
 * slug stem or alias key — no substrings, no prefixes. Pure — exported for
 * unit tests.
 */
export function resolveAgentSlug(cmdline: string | undefined): AgentSlug | undefined {
  if (!cmdline) return undefined;
  const argv = tokenizeCmdline(cmdline);
  if (argv.length < 2) return undefined;
  const form0 = lookupForm(argv[0]);
  const form1 = lookupForm(argv[1]);
  // Package runners and `python -m`: the agent name rides the next non-flag
  // positional AFTER the runner token — index 1 when the runner is the image
  // itself (shebang `npx -y gemini`), index 2 when a runtime hosts the runner
  // script (`node …/npx-cli.js -y gemini`).
  const scanFrom =
    RUNNER_STEMS.has(form0) || form0 === '-m' ? 1
      : RUNNER_STEMS.has(form1) || form1 === '-m' ? 2
        : -1;
  // Script slot: argv[1], or the first non-flag beyond it when the launcher
  // prefixed runtime flags (`node --max-old-space-size=… cli.js` used to
  // lose its identity entirely — Claude panel #919). `bare` marks a name
  // with no path separator, which in THIS slot never matches.
  const scriptToken = argv[1].startsWith('-')
    ? argv.slice(2).find((t) => !t.startsWith('-'))
    : argv[1];
  const candidates: Array<{ token: string; bare: boolean }> = [];
  if (scriptToken) candidates.push({ token: scriptToken, bare: !/[/\\]/.test(scriptToken) });
  if (scanFrom >= 0) {
    const next = argv.slice(scanFrom).find((t) => !t.startsWith('-'));
    if (next) candidates.push({ token: next, bare: false });
  }
  for (const { token } of [...candidates]) {
    // Exact path SEGMENT only: `not_node_modules` or a directory literally
    // named `xnode_modulesx` must not open a boundary (review: lastIndexOf
    // substring-matched both).
    const segs = token.split(/[\\/]/).filter(Boolean);
    const idx = segs.indexOf('node_modules');
    if (idx === -1 || idx + 1 >= segs.length) continue;
    const pkg = segs[idx + 1];
    candidates.push({
      token: pkg.startsWith('@') && idx + 2 < segs.length ? `${pkg}/${segs[idx + 2]}` : pkg,
      bare: false,
    });
  }
  for (const { token: c, bare } of candidates) {
    if (bare) continue;
    // Scoped-package spellings never basename-match: `@acme/claude` must not
    // resolve claude (lookupForm unwraps the scope, so it cannot be trusted
    // here). Only an exact alias entry may speak for a scoped name.
    const scoped = c.startsWith('@') || /[/\\]@[^/\\]+[\\/]/.test(c);
    if (scoped) {
      const alias = ALIAS_TO_SLUG.get(c.replace(/\\/g, '/').toLowerCase());
      if (alias) return alias;
      continue;
    }
    const form = lookupForm(c);
    if (AGENT_SLUG_SET.has(form)) return form as AgentSlug;
    const alias = ALIAS_TO_SLUG.get(form);
    if (alias) return alias;
  }
  return undefined;
}

/**
 * Parse the normalized `pid|ppid|created|name|cmdline` lines produced by the
 * Windows enumeration script (`created`: epoch ms, empty when unreadable).
 * CommandLine may itself contain pipes, so everything after the image name
 * joins back into the cmdline. Malformed lines (PowerShell banners, blank
 * tails) are skipped. Pure — exported for tests.
 */
export function parsePipeDelimited(stdout: string): ProcessTreeEntry[] {
  const entries: ProcessTreeEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\|(\d+)\|(\d*)\|(.+)$/);
    if (!m) continue;
    const parts = m[4].split('|');
    const cmdline = parts.slice(1).join('|');
    entries.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      name: parts[0] ?? '',
      ...(cmdline ? { cmdline } : {}),
      ...(m[3] ? { created: parseInt(m[3], 10) } : {}),
    });
  }
  return entries;
}

/**
 * Parse `ps -axo pid=,ppid=,args=` output. `comm` is gone entirely (macOS
 * comm is a full path; spaces in it misaligned every column) — argv[0] (the
 * first whitespace token of args) carries the image, the whole tail is the
 * cmdline. Known limit: an argv[0] containing spaces is unparseable; agent
 * binaries don't ship in spaced paths. Pure — exported for unit tests.
 */
export function parsePsOutput(stdout: string): ProcessTreeEntry[] {
  const entries: ProcessTreeEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const cmdline = m[3];
    const argv0 = cmdline.split(/\s+/)[0] ?? cmdline;
    entries.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), name: argv0, cmdline });
  }
  return entries;
}

/** The picked process: `pid` always (liveness), `slug` only when the image
 *  or command line identifies the agent. */
export interface AgentProcessPick {
  pid: number;
  slug?: AgentSlug;
}

/**
 * Pick the agent process among `shellPid`'s descendants:
 *   1. the SHALLOWEST descendant that RESOLVES to an agent — native stem
 *      (`claude`) or slug-resolved runtime (`node …/claude-code/cli.js`)
 *      compared by depth regardless of class (#919 panel: the old
 *      native-beats-runtime priority let a deeper native MCP-server binary
 *      steal the identity from a shallower node-hosted primary CLI),
 *   2. the shallowest UNRESOLVED runtime (a `node` we cannot name — watch
 *      it for death, claim no identity),
 *   3. the first DIRECT child (depth 1) — an unknown wrapper still dies with
 *      the foreground command, so its death is the same edge,
 *   4. undefined — nothing attributable (the caller stays undecided).
 *
 * Depth 0 comes first: when the ROOT itself resolves to an agent it is the
 * pick. Exec-rooted panes (`bash -lc <agent>`) have the shell exec-replace
 * itself, so the PTY root IS the agent and its children are MCP servers and
 * tools; searching descendants only would name one of those instead. A plain
 * shell root (zsh/bash) never resolves, so interactive panes are unaffected.
 *
 * An exact-depth tie between two DIFFERENT slugs is ambiguous (two agents at
 * equal depth) → the pick keeps the pid for the death edge but drops the slug
 * rather than guessing. BFS with a visited set: Windows PPIDs can be
 * stale/reused and form cycles. Pure — exported for unit tests.
 */
export function selectAgentProcess(
  entries: ReadonlyArray<ProcessTreeEntry>,
  shellPid: number,
): AgentProcessPick | undefined {
  const byParent = new Map<number, ProcessTreeEntry[]>();
  for (const e of entries) {
    const list = byParent.get(e.ppid);
    if (list) list.push(e);
    else byParent.set(e.ppid, [e]);
  }
  const slugOf = (entry: ProcessTreeEntry): AgentSlug | undefined => {
    const stem = imageStem(entry.name);
    return AGENT_SLUG_SET.has(stem)
      ? (stem as AgentSlug)
      : NATIVE_STEM_TO_SLUG.get(stem) ??
        (RUNTIME_STEMS.has(stem) ? resolveAgentSlug(entry.cmdline) : undefined);
  };
  const root = entries.find((e) => e.pid === shellPid);
  const rootSlug = root ? slugOf(root) : undefined;
  if (rootSlug) return { pid: shellPid, slug: rootSlug };
  let attributed: { pid: number; depth: number; slug: AgentSlug } | undefined;
  let ambiguous = false;
  let sluglessRuntime: { pid: number; depth: number } | undefined;
  let directChild: number | undefined;
  const visited = new Set<number>([shellPid]);
  const queue: Array<{ pid: number; depth: number }> = [{ pid: shellPid, depth: 0 }];
  while (queue.length > 0) {
    const { pid, depth } = queue.shift() as { pid: number; depth: number };
    for (const child of byParent.get(pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      const childDepth = depth + 1;
      if (childDepth === 1 && directChild === undefined) directChild = child.pid;
      const stem = imageStem(child.name);
      const slug = slugOf(child);
      if (slug) {
        if (!attributed || childDepth < attributed.depth) {
          attributed = { pid: child.pid, depth: childDepth, slug };
          ambiguous = false;
        } else if (childDepth === attributed.depth && slug !== attributed.slug) {
          ambiguous = true;
        }
      } else if (RUNTIME_STEMS.has(stem) && (!sluglessRuntime || childDepth < sluglessRuntime.depth)) {
        sluglessRuntime = { pid: child.pid, depth: childDepth };
      }
      queue.push({ pid: child.pid, depth: childDepth });
    }
  }
  if (attributed) return ambiguous ? { pid: attributed.pid } : { pid: attributed.pid, slug: attributed.slug };
  if (sluglessRuntime) return { pid: sluglessRuntime.pid };
  return directChild !== undefined ? { pid: directChild } : undefined;
}

const GITSTATUS_VALUE_FLAGS = new Map<string, RegExp>([
  ['-s', /^-?\d{1,9}$/], ['-u', /^-?\d{1,9}$/], ['-c', /^-?\d{1,9}$/], ['-d', /^-?\d{1,9}$/],
  ['-m', /^-?\d{1,12}$/], ['-t', /^\d{1,4}$/], ['-v', /^[A-Z]{1,8}$/],
]);
const GITSTATUS_SWITCHES = new Set(['-e', '-U', '-W', '-D']);

/** Homebrew's powerlevel10k package (Apple silicon, Intel): the only roots outside home. */
const GITSTATUS_PACKAGE_DIRS = [
  '/opt/homebrew/share/powerlevel10k/gitstatus/usrbin',
  '/usr/local/share/powerlevel10k/gitstatus/usrbin',
] as const;

/**
 * The fixed package dirs, plus each one's resolved form when it exists:
 * Homebrew links `share/powerlevel10k` into its Cellar, so the real image
 * (lsof / `/proc/<pid>/exe`) names the versioned Cellar directory. Still an
 * exact-directory list; nothing here comes from the pane.
 */
export function gitstatusPackageDirs(realpath: (dir: string) => string = fs.realpathSync): ReadonlySet<string> {
  const dirs = new Set<string>(GITSTATUS_PACKAGE_DIRS);
  for (const dir of GITSTATUS_PACKAGE_DIRS) {
    try { dirs.add(realpath(dir)); } catch { /* not installed */ }
  }
  return dirs;
}

/**
 * Whether `image` is a gitstatusd install: under the daemon user's home,
 * `gitstatusd-<os>-<arch>` in the gitstatus download cache
 * (`$GITSTATUS_CACHE_DIR`, `${XDG_CACHE_HOME:-~/.cache}/gitstatus`,
 * `~/.cache/gitstatus`) or `gitstatusd` in a plugin checkout's
 * `gitstatus/usrbin`; outside home, only `gitstatusd` whose directory is
 * exactly one of `packageDirs` (the Homebrew powerlevel10k package), never a
 * suffix match. Absolute, normalized path; a pane env or a checkout in /tmp
 * cannot widen it, and the `$GITSTATUS_DAEMON` override is not trusted.
 */
export function isHelperImage(
  image: string | undefined,
  env: NodeJS.ProcessEnv = {},
  userHome = os.homedir(),
  packageDirs: ReadonlySet<string> = gitstatusPackageDirs(),
): boolean {
  if (!image || !path.posix.isAbsolute(image) || path.posix.normalize(image) !== image) return false;
  const home = path.posix.normalize(userHome).replace(/\/+$/, '');
  const underHome = (value: string) => home.length > 1 && value.startsWith(home + '/');
  const base = path.posix.basename(image);
  const dir = path.posix.dirname(image);
  const cacheDirs = [env.GITSTATUS_CACHE_DIR, path.posix.join(env.XDG_CACHE_HOME || path.posix.join(home, '.cache'), 'gitstatus'),
    path.posix.join(home, '.cache', 'gitstatus')].filter((value): value is string => !!value && path.posix.isAbsolute(value))
    .map(value => path.posix.normalize(value).replace(/\/+$/, '')).filter(underHome);
  return /^gitstatusd-[a-z0-9_]+-[a-z0-9_]+$/.test(base) && cacheDirs.includes(dir) ||
    base === 'gitstatusd' && (packageDirs.has(dir) || dir.endsWith('/gitstatus/usrbin') && underHome(dir));
}

/**
 * A resident shell child that cannot be reading the terminal, so typing a
 * launcher at the prompt still reaches the shell (N19). Only gitstatusd
 * (gitstatus / powerlevel10k), and only when every property matches the way
 * gitstatus.plugin.zsh starts it — a process NAME alone never qualifies:
 *   - argv[0] passes `isHelperImage`;
 *   - argv exactly `<image> -G v<x.y.z>` followed only by the plugin's flags;
 *   - a direct child of this shell with no children of its own.
 * argv is self-reported (`exec -a`), so `idleShellState` also checks the real
 * executable image. Note the current plugin starts the daemon from a
 * backgrounded process substitution, which usually reparents it away from the
 * shell; this covers installs where it does stay the shell's child. Pure
 * apart from resolving the fixed package roots — exported for tests.
 */
export function isVerifiedPassiveHelper(
  entry: ProcessTreeEntry,
  shellPid: number,
  entries: ReadonlyArray<ProcessTreeEntry>,
  env: NodeJS.ProcessEnv = {},
  userHome = os.homedir(),
): boolean {
  if (entry.ppid !== shellPid || entries.some(other => other.ppid === entry.pid)) return false;
  const image = entry.name;
  if (!isHelperImage(image, env, userHome)) return false;
  const argv = (entry.cmdline ?? '').trim().split(/\s+/);
  if (argv[0] !== image || argv[1] !== '-G' || !/^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(argv[2] ?? '')) return false;
  for (let i = 3; i < argv.length; i++) {
    const value = GITSTATUS_VALUE_FLAGS.get(argv[i]);
    if (value) { if (!value.test(argv[++i] ?? '')) return false; continue; }
    if (!GITSTATUS_SWITCHES.has(argv[i])) return false;
  }
  return true;
}

/**
 * The executable image a process really runs, or undefined when it cannot be
 * read — never argv[0], which the process sets itself. darwin: the first `txt`
 * name lsof reports; linux: `/proc/<pid>/exe`. Absolute lsof path, no PATH trust.
 */
export async function readExecutableImage(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  readlink: (file: string) => string = fs.readlinkSync,
): Promise<string | undefined> {
  try {
    // The kernel's link already names the resolved file. A binary replaced
    // while it runs (an in-place update) reads `<path> (deleted)`.
    if (platform === 'linux') return readlink(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    if (platform !== 'darwin') return undefined;
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'],
      { encoding: 'utf-8', timeout: 5_000 });
    const lines = (stdout as string).split('\n');
    const txt = lines.indexOf('ftxt');
    const name = txt === -1 ? undefined : lines[txt + 1];
    return name?.startsWith('n') && name.length > 1 ? name.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

/** npm packages a runtime-hosted agent ships in: each registry row's
 *  `process.packages`, plus the packages of agents whose rows name none. */
const EXTRA_AGENT_PACKAGES: Partial<Record<AgentSlug, readonly string[]>> = {
  codex: ['@openai/codex'],
  opencode: ['opencode-ai'],
  copilot: ['@github/copilot'],
  openclaude: ['@gitlawb/openclaude'],
};
const AGENT_PACKAGES: ReadonlyMap<AgentSlug, ReadonlySet<string>> = new Map(
  AGENT_ROWS.map((row) => [row.slug, new Set([...(row.process?.packages ?? []), ...(EXTRA_AGENT_PACKAGES[row.slug] ?? [])])] as const),
);

/** Python packages a python-hosted agent ships in (`site-packages/aider`). */
const PYTHON_PACKAGES: Partial<Record<AgentSlug, string>> = { aider: 'aider' };

/** Native agents whose installer names each binary by its version, in a
 *  directory under the user's home (`~/.local/share/claude/versions/2.1.307`,
 *  `~/.grok/downloads/grok-1.0.52-macos-aarch64`). */
const NATIVE_INSTALL_DIRS: ReadonlyMap<AgentSlug, { dir: string; name: RegExp }> = new Map([
  ['claude', { dir: '.local/share/claude/versions', name: /^\d+\.\d+\.\d+/ }],
  ['grok', { dir: '.grok/downloads', name: /^grok-\d+\.\d+\.\d+-(?:macos|linux)-(?:aarch64|arm64|x86_64|x64)$/ }],
]);

/** A release binary named for its target (`codex-aarch64-apple-darwin`). */
const NATIVE_TARGET_SUFFIX = /-(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-(?:gnu|musl))$/;

/**
 * Whether the real path of a python agent's script lies inside its package:
 * a file under `site-packages/<pkg>/`, or a console script in an
 * environment's `bin/` whose `lib/pythonX.Y/site-packages` holds the package
 * (a venv, pipx or uv tool, a Homebrew libexec, a user prefix).
 */
function inPythonPackage(real: string, slug: AgentSlug): boolean {
  const pkg = PYTHON_PACKAGES[slug];
  if (!pkg) return false;
  const segs = real.split('/');
  const at = segs.lastIndexOf('site-packages');
  if (at !== -1 && segs[at + 1] === pkg && at + 2 < segs.length) return true;
  const form = lookupForm(path.posix.basename(real));
  if ((AGENT_SLUG_SET.has(form) ? form : ALIAS_TO_SLUG.get(form)) !== slug) return false;
  const bin = path.posix.dirname(real);
  if (path.posix.basename(bin) !== 'bin') return false;
  const lib = path.posix.join(path.posix.dirname(bin), 'lib');
  try {
    return fs.readdirSync(lib).some((dir) => /^python\d*(?:\.\d+)?$/.test(dir) &&
      fs.statSync(path.posix.join(lib, dir, 'site-packages', pkg), { throwIfNoEntry: false })?.isDirectory() === true);
  } catch {
    return false;
  }
}

/**
 * Whether the executable the kernel reports for `entry` (`image`, from
 * readExecutableImage) really is the `slug` agent the process's own argv
 * claims (darwin, linux). argv is self-reported, so:
 *   - a native agent's image must itself be that agent: its file name is the
 *     agent's executable (`claude`, `kiro-cli`, `codex-aarch64-apple-darwin`),
 *     or it is a version binary in that agent's install directory;
 *   - a runtime-hosted agent's image must be a runtime (`node`, `python3.12`),
 *     and the real path of its absolute script argument must lie inside one
 *     of that agent's packages (`…/node_modules/@anthropic-ai/claude-code/cli.js`,
 *     `…/site-packages/aider/`).
 * Anything else, or an unreadable image, is not that agent. A copied binary or
 * package still passes. Reads the file system — exported for tests.
 */
export function isAgentImage(
  entry: ProcessTreeEntry,
  slug: AgentSlug,
  image: string | undefined,
  userHome = os.homedir(),
  realpath: (file: string) => string = fs.realpathSync,
): boolean {
  if (!image || !path.posix.isAbsolute(image)) return false;
  if (!RUNTIME_STEMS.has(imageStem(entry.name))) {
    const stem = imageStem(image).replace(NATIVE_TARGET_SUFFIX, '');
    if ((AGENT_SLUG_SET.has(stem) ? stem : NATIVE_STEM_TO_SLUG.get(stem)) === slug) return true;
    const install = NATIVE_INSTALL_DIRS.get(slug);
    if (!install || !install.name.test(path.posix.basename(image))) return false;
    // The image path is resolved, so compare against the resolved home too.
    const homes = [userHome];
    try {
      homes.push(realpath(userHome));
    } catch {
      // Home unreadable: the plain path only.
    }
    return homes.some((home) => path.posix.dirname(image) === path.posix.join(home, install.dir));
  }
  const runtime = imageStem(image).replace(/^nodejs$/, 'node').replace(/^(python3)\.\d+$/, '$1');
  if (!RUNTIME_STEMS.has(runtime)) return false;
  const argv = tokenizeCmdline(entry.cmdline ?? '');
  const script = argv[1]?.startsWith('-') ? argv.slice(2).find((t) => !t.startsWith('-')) : argv[1];
  if (!script || !path.posix.isAbsolute(script)) return false;
  let real: string;
  try {
    real = realpath(script);
  } catch {
    return false;
  }
  if (runtime.startsWith('python')) return inPythonPackage(real, slug);
  // The innermost package owns the file.
  const segs = real.split('/');
  const at = segs.lastIndexOf('node_modules');
  if (at === -1) return false;
  const scoped = segs[at + 1]?.startsWith('@') === true;
  if (at + (scoped ? 3 : 2) >= segs.length) return false;
  const pkg = scoped ? `${segs[at + 1]}/${segs[at + 2]}` : segs[at + 1];
  return AGENT_PACKAGES.get(slug)?.has(pkg) === true;
}

/** One full process-table snapshot (pid/ppid/name[/cmdline]). Windows has no
 *  PPID in tasklist, so this shells out to Windows PowerShell 5.1 (always
 *  present, absolute System32 path — no PATH trust) for a single CIM
 *  enumeration. POSIX uses one `ps`. Throws on failure — the caller stays
 *  undecided. */
async function enumerateProcesses(): Promise<ProcessTreeEntry[]> {
  if (process.platform === 'win32') {
    const psPath = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const { stdout } = await execFileAsync(
      psPath,
      [
        '-NoProfile', '-NonInteractive', '-Command',
        // Pipe-delimited to keep the parser trivial (image names never
        // contain '|'; CommandLine may — the parser rejoins it, so the
        // creation time goes before the name). Win32_Process is one WMI
        // query — no per-PID walks. A null CreationDate prints empty.
        "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }), $_.Name, $_.CommandLine }",
      ],
      { encoding: 'utf-8', timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    return parsePipeDelimited(stdout as string);
  }
  const { stdout } = await execFileAsync(
    'ps',
    // `-ww`: never cut argv to a width (a conversation id past the cut would read as absent).
    ['-ww', '-axo', 'pid=,ppid=,args='],
    { encoding: 'utf-8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return parsePsOutput(stdout as string);
}

interface TrackedAgent {
  pid: number;
  alive: boolean;
  slug?: AgentSlug;
  /** #1727 — set for an agent inside a WSL pane: `pid` is a LINUX pid, and
   *  this says where it lives and how to tell it from a reused one. */
  wsl?: WslWatchedAgent;
  /** The last executable check of `pid` (isAgentImage), keyed by the slug and
   *  argv it was made for: one image read per launch, not per delivery. */
  image?: { key: string; ok: boolean };
  /** #2673 — the pane's launch count (setLaunchCounter) when this process was
   *  picked: a later command start in the pane may have launched its successor. */
  launchSeq?: number;
}

/** #1727 — what the tracker needs to follow agents inside WSL panes. All
 *  optional: without them WSL panes simply stay unattributed. */
export interface WslTrackingOptions {
  /** True for a session whose shell is `wsl.exe`. Such a session never takes
   *  the Windows tree walk: the agent is not in that table, and the walk's
   *  slugless fallback would pick a Windows interop child instead. */
  isWslSession?: (sessionId: string) => boolean;
  watcher?: {
    watch(key: string, agent: WslWatchedAgent, onDead: () => void): void;
    unwatch(key: string): void;
  };
  /** Fresh delivery-time check (checkWslAgentRunning). */
  isRunning?: (agent: WslWatchedAgent) => Promise<boolean>;
}

/** Identity/liveness snapshot handed to the state-change listener. */
export interface TrackedAgentState {
  slug?: AgentSlug;
  alive: boolean;
  /** Actual process snapshot start (or WSL hook payload time), only on fresh launch edges.
   * Cached identityFor reads deliberately omit it. */
  observedAt?: number;
  /** This launch edge replaced a different process the pane ran: a same-boot WSL
   * relaunch, or (#2673) the successor noteWatchedDeath found where its watched
   * agent died. It is teardown evidence for the old process (the edge carries no
   * death); on its own it cannot seed detector identity, which still needs
   * observedAt, which the native successor's edge always carries. */
  replacedLive?: true;
  /** Captured detector epoch on a fresh probe; null means its owner changed. */
  identityEpoch?: number | null;
}

export class AgentProcessTracker {
  private readonly states = new Map<string, TrackedAgent>();
  /** In-flight probe per session — coalesces the hook-storm case (a claude
   *  turn can fire several hooks back-to-back) into one enumeration. */
  private readonly inFlight = new Set<string>();
  /** The in-flight probe came from armIfAgent (commits named agents only). */
  private readonly slugOnlyInFlight = new Set<string>();
  /** Bumped by disarm(); a probe that resolves after its session was
   *  disarmed must not resurrect state for a destroyed pane. */
  private readonly generation = new Map<string, number>();
  /** Last shell pid per session — a force-queued rearm replays against it. */
  private readonly shellPids = new Map<string, number>();
  /** Negative cache: last unattributable/failed probe per session (#919
   *  panel — bounds re-enumeration on chatty banners). */
  private readonly lastFailedAt = new Map<string, number>();
  /** Last forced rearm per session (cooldown clock). */
  private readonly lastRearmAt = new Map<string, number>();
  /** rearm() called while a probe was in flight → replay once it lands. */
  private readonly forceQueued = new Set<string>();
  /** armIfAgent() called while a probe was in flight → replay once it lands. */
  private readonly slugQueued = new Set<string>();
  /** armIfAgent's own backoff: until when the next agent-only probe waits. */
  private readonly slugProbeBlockedUntil = new Map<string, number>();
  /** Shared snapshot promise — concurrent probes across sessions ride one
   *  enumeration instead of spawning one each. */
  private snapshotInFlight: Promise<ProcessTreeEntry[]> | null = null;
  /** The tracked agent each agentProcessTree() root entry is, so a
   *  stillRunning() verdict on that entry is a verdict on that agent. */
  private readonly treeRoots = new WeakMap<ProcessTreeEntry, { sessionId: string; state: TrackedAgent }>();
  private snapshotStartedAt = 0;
  private identityProbeGuard?: (sessionId: string) => { epoch: number; isCurrent: () => boolean } | undefined;
  private launchCounter?: (sessionId: string) => number | undefined;
  private stateListener: ((sessionId: string, state: TrackedAgentState) => void) | undefined;

  constructor(
    private readonly watcher: PidWatcher,
    private readonly enumerate: () => Promise<ProcessTreeEntry[]> = enumerateProcesses,
    private readonly readImage: (pid: number) => Promise<string | undefined> = readExecutableImage,
    private readonly userHome: string = os.homedir(),
    private readonly wsl: WslTrackingOptions = {},
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** Whether `entry`'s real executable is the `slug` agent (isAgentImage).
   *  Only darwin and linux can read it; Windows keeps the image-name check.
   *  `state`, when it tracks this pid, caches the verdict for this argv. */
  private async imageMatches(entry: ProcessTreeEntry, slug: AgentSlug, state?: TrackedAgent): Promise<boolean> {
    if (this.platform !== 'darwin' && this.platform !== 'linux') return true;
    const key = `${slug}\0${entry.name}\0${entry.cmdline ?? ''}`;
    const cache = state?.pid === entry.pid ? state : undefined;
    if (cache?.image?.key === key) return cache.image.ok;
    const image = await this.readImage(entry.pid).catch(() => undefined);
    const ok = isAgentImage(entry, slug, image, this.userHome);
    // A failed read (a timeout, a permission error) is not a verdict: the
    // next check reads again.
    if (cache && image !== undefined) cache.image = { key, ok };
    return ok;
  }

  private isWsl(sessionId: string): boolean {
    return this.wsl.isWslSession?.(sessionId) === true;
  }

  async verifyIdleShell(pid: number): Promise<boolean> {
    return (await this.idleShellState(pid)).ok;
  }

  /** A live pid's full command line from the process table, or undefined when it is gone. */
  async commandLineOf(pid: number): Promise<string | undefined> {
    const entry = (await this.snapshot()).find((e) => e.pid === pid);
    return entry ? entry.cmdline ?? entry.name : undefined;
  }

  /** Which launch precondition failed, so a phone can be told what to do.
   *  `env` is the pane's spawn env, used only to locate a helper's install.
   *  `anyShell` also accepts PowerShell, pwsh and cmd: for a caller that only
   *  needs the shell idle and never types a command into it. `fresh` starts
   *  its own enumeration: a confirming read must not join a snapshot that
   *  began before its caller captured the pane's input/output witness. */
  async idleShellState(pid: number, env: NodeJS.ProcessEnv = {}, anyShell = false, options: { fresh?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'unsupported-shell' | 'shell-has-children' }> {
    const entries = await (options.fresh ? this.enumerate() : this.snapshot());
    const root = entries.find(entry => entry.pid === pid);
    if (!root) return { ok: false, reason: 'missing' };
    const shell = anyShell ? /^(?:-?)(?:zsh|bash|sh|powershell|pwsh|cmd)(?:\.exe)?$/i : /^(?:-?)(?:zsh|bash|sh)$/i;
    if (!shell.test(path.basename(root.name))) return { ok: false, reason: 'unsupported-shell' };
    for (const child of entries.filter(entry => entry.ppid === pid)) {
      // The real image is read only for a child whose self-reported argv already qualifies.
      if (!isVerifiedPassiveHelper(child, pid, entries, env, this.userHome) ||
          !isHelperImage(await this.readImage(child.pid).catch(() => undefined), env, this.userHome)) {
        return { ok: false, reason: 'shell-has-children' };
      }
    }
    return { ok: true };
  }

  private static watchKey(sessionId: string): string {
    // Namespaced so it can never collide with the daemon's shell-PID watches,
    // which key ProcessMonitor by the raw session id.
    return `agent:${sessionId}`;
  }

  /** Daemon wiring point for #919: attribution completion and the
   *  alive→false edge both re-evaluate canonical identity and expire hook
   *  authority (see daemon/index.ts). */
  setStateChangeListener(cb: (sessionId: string, state: TrackedAgentState) => void): void {
    this.stateListener = cb;
  }

  /** #2673 — how many commands the pane's shell has started (OSC 133 C), or
   *  undefined when it does not report them. See noteWatchedDeath. */
  setLaunchCounter(count: (sessionId: string) => number | undefined): void {
    this.launchCounter = count;
  }

  /** Captures only detector-seeding authority; process liveness keeps its own generation guard. */
  setIdentityProbeGuard(capture: (sessionId: string) => { epoch: number; isCurrent: () => boolean } | undefined): void {
    this.identityProbeGuard = capture;
  }

  private emitState(sessionId: string, state: TrackedAgentState): void {
    try {
      this.stateListener?.(sessionId, state);
    } catch {
      // Listener errors must never break tracking.
    }
  }

  /**
   * (Re)attach to the session's live agent process. Fire-and-forget: callers
   * sit on hot paths (hook RPC, banner event) and must not await a probe.
   * No-op while a live agent is already being watched or within the failure
   * backoff — the probe runs once per agent LAUNCH, not per hook.
   */
  arm(sessionId: string, shellPid: number): void {
    if (this.isWsl(sessionId)) return; // attributed by armWsl() instead
    this.shellPids.set(sessionId, shellPid);
    if (this.states.get(sessionId)?.alive) return;
    const failedAt = this.lastFailedAt.get(sessionId);
    if (failedAt !== undefined && Date.now() - failedAt < ARM_BACKOFF_MS) return;
    this.probe(sessionId, shellPid);
  }

  /**
   * FORCED probe for conflicting-agent evidence: a banner/hook naming a
   * DIFFERENT agent than the tracked one is launch evidence that invalidates
   * the "already alive" assumption — the old pick's death poll can lag a
   * fresh launch by up to one ProcessMonitor cadence (≤28 s), during which
   * plain arm() would no-op and keep the dead slug winning. Bypasses the
   * failure backoff (explicit evidence beats it) but rate-limits itself:
   * repeated conflicting banners against a pick that keeps winning add
   * nothing new.
   */
  rearm(sessionId: string, shellPid: number): void {
    if (this.isWsl(sessionId)) return;
    this.shellPids.set(sessionId, shellPid);
    const last = this.lastRearmAt.get(sessionId);
    if (last !== undefined && Date.now() - last < REARM_COOLDOWN_MS) return;
    this.lastRearmAt.set(sessionId, Date.now());
    this.lastFailedAt.delete(sessionId);
    if (this.inFlight.has(sessionId)) {
      this.forceQueued.add(sessionId);
      return;
    }
    this.probe(sessionId, shellPid);
  }

  /**
   * Probe for a NAMED agent with no evidence that one is running — the
   * banner- and hook-independent trigger (a foreground command outlived its
   * settle window — see commandStartAgentProbe.ts). An agent with no session-start
   * hook (Codex) is otherwise named only by its banner, and a missed banner
   * left the pane anonymous until its first turn ended.
   *
   * Commits ONLY a pick that resolves to an agent slug. A plain long-running
   * command (`npm run dev`, `vim`) leaves no state behind, so it can mint
   * neither an alive flag nor a later `agent.processExit` edge. A miss backs
   * off only this trigger (AGENT_MISS_BACKOFF_MS; an enumeration failure,
   * ARM_BACKOFF_MS): a guess that found no agent must not delay the arm() of
   * an agent launched seconds later.
   *
   * It probes even while the tracked agent reads alive. A new command-start
   * means the shell got the terminal back, so the tracked agent has usually
   * exited and the ProcessMonitor has not polled it yet (up to one cadence).
   * If the tracked pid is gone from the table, its death edge is recorded
   * then and there, and the new agent is named instead of the dead one.
   */
  armIfAgent(sessionId: string, shellPid: number): void {
    if (this.isWsl(sessionId)) return;
    this.shellPids.set(sessionId, shellPid);
    const blockedUntil = this.slugProbeBlockedUntil.get(sessionId);
    if (blockedUntil !== undefined && Date.now() < blockedUntil) return;
    if (this.inFlight.has(sessionId)) {
      this.slugQueued.add(sessionId);
      return;
    }
    this.probe(sessionId, shellPid, true);
  }

  private probe(sessionId: string, shellPid: number, requireSlug = false): void {
    if (this.inFlight.has(sessionId)) {
      // A hook or banner arm arriving while an armIfAgent probe runs must not
      // be swallowed: that probe discards a slugless pick, which this arm
      // would have kept for liveness. Replay it once the probe lands.
      if (!requireSlug && this.slugOnlyInFlight.has(sessionId)) this.forceQueued.add(sessionId);
      return;
    }
    this.inFlight.add(sessionId);
    if (requireSlug) this.slugOnlyInFlight.add(sessionId);
    const gen = this.generation.get(sessionId) ?? 0;
    const identity = this.identityProbeGuard?.(sessionId);
    void (async () => {
      try {
        const ownsSnapshot = this.snapshotInFlight === null;
        const snapshot = this.snapshot();
        // A concurrent probe can share an older enumeration. Preserve its
        // original time rather than laundering it through this delivery.
        const observedAt = this.snapshotStartedAt;
        const entries = await snapshot;
        if ((this.generation.get(sessionId) ?? 0) !== gen) return; // disarmed meanwhile
        const pick = selectAgentProcess(entries, shellPid);
        let replaced = false;
        if (requireSlug) {
          const cur = this.states.get(sessionId);
          if (cur?.alive) {
            // Still running: the same agent, or one left in the background.
            // Nothing new to name. (The walk covers every descendant of the
            // shell, not only the foreground job, so `codex &` followed by a
            // long command can name the pane after the background agent.
            // Narrowing to the terminal's foreground process group needs a
            // pgid column no Windows listing has.)
            if (entries.some((e) => e.pid === cur.pid)) return;
            // Gone before the monitor noticed: drop its watch so the monitor
            // cannot report the same death again, and record its death edge
            // now, unless the same agent already took its place (#2673: the
            // pick below is its relaunch's edge, and the pane's agent never
            // ended). Another agent in its place ends it as before.
            this.watcher.unwatch(AgentProcessTracker.watchKey(sessionId));
            cur.alive = false;
            if (pick?.slug !== undefined && pick.slug === cur.slug) replaced = true;
            else this.emitState(sessionId, { ...(cur.slug ? { slug: cur.slug } : {}), alive: false });
          }
          // No named agent → leave the session as it is.
          if (!pick?.slug) {
            this.slugProbeBlockedUntil.set(sessionId, Date.now() + AGENT_MISS_BACKOFF_MS);
            return;
          }
        }
        // No attributable descendant (agent already gone, or an exotic launch
        // we can't see) → stay undecided so the renderer keeps its heuristic.
        if (!pick) {
          this.lastFailedAt.set(sessionId, Date.now());
          return;
        }
        this.commitPick(sessionId, pick, observedAt,
          identity ? (identity.isCurrent() ? (ownsSnapshot ? identity.epoch : undefined) : null) : undefined, replaced);
      } catch {
        // Enumeration failed (timeout, spawn error) — undecided, never a lie.
        if (requireSlug) this.slugProbeBlockedUntil.set(sessionId, Date.now() + ARM_BACKOFF_MS);
        else this.lastFailedAt.set(sessionId, Date.now());
      } finally {
        this.inFlight.delete(sessionId);
        this.slugOnlyInFlight.delete(sessionId);
        // Replay a queued forced rearm DIRECTLY — routing it through rearm()
        // again would hit the cooldown already paid when the rearm queued it
        // (lastRearmAt was set seconds ago, so rearm() no-opped and the forced
        // probe was lost). forceQueued is a single bit: no self-retrigger.
        const pid = this.shellPids.get(sessionId);
        if (this.forceQueued.delete(sessionId)) {
          this.slugQueued.delete(sessionId); // the plain probe covers it
          if (pid !== undefined) this.probe(sessionId, pid);
        } else if (this.slugQueued.delete(sessionId) && pid !== undefined) {
          // Through armIfAgent, so its backoff still applies.
          this.armIfAgent(sessionId, pid);
        }
      }
    })();
  }

  /** Track `pick` as the pane's agent: watch it and report its launch edge. */
  private commitPick(sessionId: string, pick: AgentProcessPick, observedAt: number, identityEpoch: number | null | undefined, replacedLive: boolean): void {
    const launchSeq = this.launchCounter?.(sessionId);
    this.states.set(sessionId, {
      pid: pick.pid,
      alive: true,
      ...(pick.slug ? { slug: pick.slug } : {}),
      ...(launchSeq !== undefined ? { launchSeq } : {}),
    });
    this.watcher.watch(AgentProcessTracker.watchKey(sessionId), pick.pid, () => this.noteWatchedDeath(sessionId, pick.pid));
    this.emitState(sessionId, { ...(pick.slug ? { slug: pick.slug } : {}), alive: true, observedAt,
      ...(replacedLive ? { replacedLive: true as const } : {}),
      ...(identityEpoch !== undefined ? { identityEpoch } : {}),
    });
  }

  /**
   * The watched agent process died. Only the SAME watched pid may flip the
   * flag: a re-probe that landed after this watch was superseded must win.
   *
   * #2673 — the pane may already run that agent's successor. `/exit`, then
   * `claude` again: the monitor reports the old pid gone seconds after the
   * new process started, before anything probed for it. Reporting that as the
   * pane's agent dying ended the relaunch: the bridge cleared the identity its
   * splash had just opened, and no launch edge followed to restore it. So when
   * the pane's shell has started a command since this process was picked
   * (its launch count moved), a fresh process table is read first. The same
   * agent under the pane's shell with another pid is the successor: it is
   * tracked, and its launch edge (`replacedLive`) is what the pane hears.
   * With no successor, no table, or no command started since, the death is
   * reported, as it always was.
   */
  private noteWatchedDeath(sessionId: string, pid: number): void {
    const dead = this.states.get(sessionId);
    if (!dead || dead.pid !== pid || !dead.alive) return;
    dead.alive = false;
    const reportDeath = (): void => this.emitState(sessionId, { ...(dead.slug ? { slug: dead.slug } : {}), alive: false });
    const shellPid = this.shellPids.get(sessionId);
    const launches = this.launchCounter?.(sessionId);
    if (shellPid === undefined || !dead.slug || dead.launchSeq === undefined || launches === undefined || launches <= dead.launchSeq) {
      reportDeath();
      return;
    }
    const gen = this.generation.get(sessionId) ?? 0;
    const identity = this.identityProbeGuard?.(sessionId);
    const observedAt = Date.now();
    void this.enumerate().then(
      (entries) => {
        if ((this.generation.get(sessionId) ?? 0) !== gen || this.states.get(sessionId) !== dead) return; // disarmed, or a probe took over
        const pick = selectAgentProcess(entries, shellPid);
        if (!pick || pick.slug !== dead.slug || pick.pid === pid) {
          reportDeath();
          return;
        }
        this.commitPick(sessionId, pick, observedAt, identity ? (identity.isCurrent() ? identity.epoch : null) : undefined, true);
      },
      () => {
        if ((this.generation.get(sessionId) ?? 0) !== gen || this.states.get(sessionId) !== dead) return;
        reportDeath();
      },
    );
  }

  /**
   * #1727 — attach to the agent a WSL pane's own hook reported (see
   * wslAgentProcess.ts). The caller has already checked the report came from
   * this exact pane and names the hook's own agent. A no-op while that same
   * process is tracked alive, so a hook storm costs nothing; a different
   * process (a relaunch) replaces it.
   */
  armWsl(sessionId: string, location: WslAgentLocation, agent: WslReportedAgent, observedAt?: number): void {
    if (!this.wsl.watcher) return;
    const cur = this.states.get(sessionId);
    if (cur?.alive && cur.wsl && cur.wsl.bootId === agent.bootId) {
      if (cur.pid === agent.pid && cur.wsl.start === agent.start) return;
      // Keep the tracked agent when the report comes from a process nested
      // inside it (the pane's claude ran `claude -p`, whose hooks also name
      // this pane), or from an older process (a late hook of the previous run).
      // Either would read the pane dead when that other process exits.
      if (agent.ancestors.includes(cur.pid)) return;
      if (BigInt(agent.start) < BigInt(cur.wsl.start)) return;
    }
    // Start times order launches only within one boot. A queued old-boot
    // report cannot establish that it replaced the current live owner.
    const replacedLive = cur?.alive === true && cur.wsl?.bootId === agent.bootId
      && (cur.pid !== agent.pid || cur.wsl.start !== agent.start);
    const identity = observedAt !== undefined ? this.identityProbeGuard?.(sessionId) : undefined;
    const key = AgentProcessTracker.watchKey(sessionId);
    const watched: WslWatchedAgent = { ...location, pid: agent.pid, start: agent.start, bootId: agent.bootId };
    const state: TrackedAgent = { pid: agent.pid, alive: true, slug: agent.slug, wsl: watched };
    this.states.set(sessionId, state);
    this.wsl.watcher.watch(key, watched, () => {
      // Only the same tracked process may flip the flag.
      if (this.states.get(sessionId) !== state) return;
      state.alive = false;
      this.emitState(sessionId, { slug: agent.slug, alive: false });
    });
    this.emitState(sessionId, { slug: agent.slug, alive: true, ...(observedAt !== undefined ? { observedAt } : {}),
      ...(replacedLive ? { replacedLive: true } : {}),
      ...(identity ? { identityEpoch: identity.isCurrent() ? identity.epoch : null } : {}),
    });
  }

  /** true = agent process observed alive; false = it was observed and DIED
   *  (the edge); undefined = never attributed → caller falls back. */
  statusFor(sessionId: string): boolean | undefined {
    return this.states.get(sessionId)?.alive;
  }

  /** #919 tier-2 input: the attributed process's identity and liveness.
   *  Synchronous map read — NEVER enumerates. `slug` undefined = slugless
   *  pick (wrapper/direct child): answers liveness, claims no name. */
  identityFor(sessionId: string): TrackedAgentState | undefined {
    const s = this.states.get(sessionId);
    if (!s) return undefined;
    return { ...(s.slug ? { slug: s.slug } : {}), alive: s.alive };
  }

  /** True while the session's agent is a live process inside WSL, attributed
   *  from its own hook's report (armWsl) and watched from inside the distro.
   *  Synchronous map read — never probes. */
  hasLiveWslAgent(sessionId: string): boolean {
    const s = this.states.get(sessionId);
    return s?.alive === true && s.wsl !== undefined;
  }

  /** A stop that confirmed this WSL agent gone (stopWslAgent): its death
   *  edge now, not on the WSL watcher's next poll, while the session still
   *  tracks that same agent (`agent` as wslAgentFor gave it, not one a hook
   *  reported since). */
  noteWslAgentGone(sessionId: string, agent: WslWatchedAgent): void {
    const s = this.states.get(sessionId);
    if (s?.wsl === agent) this.recordDeath(sessionId, s);
  }

  /** #2261 — the live WSL agent a stop may signal (its Linux pid, boot id and
   *  start time, and the pane's wsl.exe), or undefined. Never probes. */
  wslAgentFor(sessionId: string): WslWatchedAgent | undefined {
    const s = this.states.get(sessionId);
    return s?.alive === true ? s.wsl : undefined;
  }

  /** #1307 — the attributed process's pid, for a delivery-time liveness
   *  probe fresher than the cached `alive` flag (a death between
   *  ProcessMonitor polls). undefined = never attributed. */
  pidFor(sessionId: string): number | undefined {
    // Windows pids only: a WSL agent's pid is a Linux pid, and every caller
    // hands this to a Windows process check (#1727).
    const s = this.states.get(sessionId);
    return s?.wsl ? undefined : s?.pid;
  }

  /** #1307 — re-picks from a fresh process table: true only while the
   *  tracked pid is still the pane shell's agent descendant with the
   *  expected slug, so a reused pid fails. On macOS and Linux its real
   *  executable must also be that agent (isAgentImage), so a renamed process
   *  fails. Enumerates, unlike identityFor. */
  async verifyLive(sessionId: string, expectedSlug: AgentSlug): Promise<boolean> {
    const s = this.states.get(sessionId);
    if (s?.wsl) {
      if (!s.alive || s.slug !== expectedSlug || !this.wsl.isRunning) return false;
      const running = await this.wsl.isRunning(s.wsl);
      return running && this.states.get(sessionId) === s && s.alive;
    }
    const shellPid = this.shellPids.get(sessionId);
    if (!s?.alive || shellPid === undefined) return false;
    try {
      const table = await this.snapshot();
      const pick = selectAgentProcess(table, shellPid);
      // The death edge, disarm or a re-arm can land while the table is read.
      const current = () => this.states.get(sessionId) === s && s.alive && this.shellPids.get(sessionId) === shellPid;
      const picked = table.find((e) => e.pid === s.pid);
      if (!current() || !picked || pick?.pid !== s.pid || pick.slug !== expectedSlug) return false;
      // argv names the agent; the kernel's executable must back it.
      return await this.imageMatches(picked, expectedSlug, s) && current();
    } catch {
      return false;
    }
  }

  /**
   * #1727 — the delivery-time liveness check for session prompt scheduling:
   * the tracked agent is still this pane's `expectedSlug` agent AND running
   * (a stopped or zombie agent is not). Windows: verifyLive plus a fresh
   * process check of the pid. WSL: verifyLive already stats the Linux
   * process, state included.
   */
  async isAgentRunning(
    sessionId: string,
    expectedSlug: AgentSlug,
    isRunning: (pid: number) => Promise<boolean>,
  ): Promise<boolean> {
    const s = this.states.get(sessionId);
    if (!s) return false;
    if (s.wsl) return this.verifyLive(sessionId, expectedSlug);
    return await this.verifyLive(sessionId, expectedSlug) && await isRunning(s.pid);
  }

  /** Exec panes may own the agent as their PTY root, without a shell child.
   * Verify that exact armed root from fresh process metadata; never accept an
   * arbitrary PID or infer its executable from pane text. */
  async verifyOwnedRoot(sessionId: string, pid: number, expectedSlug: AgentSlug): Promise<boolean> {
    if (this.shellPids.get(sessionId) !== pid) return false;
    // A disarm (even one re-armed with the same pid), or the tracked agent
    // dying or being replaced, while the table or the image is read. A probe
    // still in flight may have no state yet; that is not a change.
    const gen = this.generation.get(sessionId) ?? 0;
    const state = this.states.get(sessionId);
    const unchanged = () => (this.generation.get(sessionId) ?? 0) === gen && this.shellPids.get(sessionId) === pid &&
      (!state || (this.states.get(sessionId) === state && state.alive));
    try {
      const root = (await this.snapshot()).find(entry => entry.pid === pid);
      return unchanged() && !!root &&
        selectAgentProcess([{ ...root, ppid: -1 }], -1)?.slug === expectedSlug &&
        await this.imageMatches(root, expectedSlug, state) && unchanged();
    } catch { return false; }
  }

  /** The session's live `expectedSlug` agent below its shell and every
   *  process under that agent, from one fresh process table; null when no
   *  such agent runs there. A WSL agent (a Linux pid) and an agent that is
   *  the pane's own root are never returned: stopping either is not a stop
   *  of the agent alone. Throws when the process table cannot be read (that
   *  is not "nothing runs").
   *
   *  Windows never reparents: a process whose parent died long ago keeps that
   *  parent's pid as its ppid, and the agent may have reused it. So there a
   *  process is below the agent only when it started after its parent; an
   *  older one (and what runs under it) is left out. One started in the same
   *  millisecond as its parent, or whose age cannot be told, is `uncertain`:
   *  never signalled, but a stop is not confirmed while it runs. */
  async agentProcessTree(sessionId: string, expectedSlug: AgentSlug): Promise<{ root: ProcessTreeEntry; descendants: ProcessTreeEntry[]; uncertain: ProcessTreeEntry[] } | null> {
    const s = this.states.get(sessionId);
    const shellPid = this.shellPids.get(sessionId);
    if (!s?.alive || s.wsl || shellPid === undefined || s.pid === shellPid) return null;
    const table = await this.snapshot();
    // The death edge, a disarm or a re-arm can land while the table is read.
    if (this.states.get(sessionId) !== s || !s.alive || this.shellPids.get(sessionId) !== shellPid) return null;
    const pick = selectAgentProcess(table, shellPid);
    const root = table.find((e) => e.pid === s.pid);
    // The tracked pid is in no process at all: its agent is gone.
    if (!root) {
      this.recordDeath(sessionId, s);
      return null;
    }
    if (pick?.pid !== s.pid || pick.slug !== expectedSlug) return null;
    const byParent = new Map<number, ProcessTreeEntry[]>();
    for (const e of table) {
      const list = byParent.get(e.ppid);
      if (list) list.push(e);
      else byParent.set(e.ppid, [e]);
    }
    const descendants: ProcessTreeEntry[] = [];
    const uncertain: ProcessTreeEntry[] = [];
    const dated = this.platform === 'win32';
    const seen = new Set<number>([root.pid, shellPid]);
    const queue: Array<{ entry: ProcessTreeEntry; sure: boolean }> = [{ entry: root, sure: true }];
    while (queue.length > 0) {
      const parent = queue.shift() as { entry: ProcessTreeEntry; sure: boolean };
      for (const child of byParent.get(parent.entry.pid) ?? []) {
        if (seen.has(child.pid)) continue;
        let sure = parent.sure;
        if (dated) {
          const born = child.created;
          const parentBorn = parent.entry.created;
          // Older than its parent, or than the agent (below an undated
          // parent): its ppid names an earlier process that had this pid.
          if (born !== undefined && ((parentBorn !== undefined && born < parentBorn) ||
              (root.created !== undefined && born < root.created))) continue;
          // A tie at millisecond resolution does not tell which came first.
          sure = sure && born !== undefined && parentBorn !== undefined && born > parentBorn;
        }
        seen.add(child.pid);
        (sure ? descendants : uncertain).push(child);
        queue.push({ entry: child, sure });
      }
    }
    this.treeRoots.set(root, { sessionId, state: s });
    return { root, descendants, uncertain };
  }

  /** Every live process whose command line carries `marker` (a conversation
   *  id), from a fresh table. On Windows also every claude, node or bun
   *  process whose command line cannot be read (another user's, an elevated
   *  one): it may carry the marker. Throws when the table cannot be read. */
  async processesWithArg(marker: string): Promise<ProcessTreeEntry[]> {
    if (!marker) return [];
    const unreadable = (e: ProcessTreeEntry) => this.platform === 'win32' && !e.cmdline && UNREADABLE_HOLDER_IMAGE.test(e.name);
    return (await this.enumerate()).filter((e) => (e.cmdline?.includes(marker) === true || unreadable(e)) && e.pid !== process.pid);
  }

  /** One fresh process table (on Windows with creation times), not shared
   *  with a probe in flight. Throws when it cannot be read. */
  async processTable(): Promise<ProcessTreeEntry[]> {
    return this.enumerate();
  }

  /** Of `entries`, the ones a fresh process table still shows as the same
   *  process: pid, image name and command line (a reused pid is another
   *  program, or the same program started with other arguments). Throws when
   *  the table cannot be read. */
  async stillRunning(entries: readonly ProcessTreeEntry[]): Promise<ProcessTreeEntry[]> {
    const { same, unsure } = await this.liveness(entries);
    return entries.filter((e) => same.includes(e) || unsure.includes(e));
  }

  /** stillRunning, split by how sure the match is. On Windows the creation
   *  time is part of a process's identity too: a different one is another
   *  process that took the pid (the same program with the same arguments is
   *  not told apart otherwise), and one missing on either side leaves the
   *  match `unsure`: still running, but not proven the same process. */
  async liveness(entries: readonly ProcessTreeEntry[]): Promise<{ same: ProcessTreeEntry[]; unsure: ProcessTreeEntry[] }> {
    if (entries.length === 0) return { same: [], unsure: [] };
    const table = await this.snapshot();
    const same: ProcessTreeEntry[] = [];
    const unsure: ProcessTreeEntry[] = [];
    for (const e of entries) {
      const row = table.find((t) => t.pid === e.pid && t.name === e.name && t.cmdline === e.cmdline);
      if (!row) continue;
      if (this.platform !== 'win32') same.push(e);
      else if (row.created === undefined || e.created === undefined) unsure.push(e);
      else if (row.created === e.created) same.push(e);
    }
    const left = [...same, ...unsure];
    // A tree read's root found gone is that tracked agent gone: the launch
    // the read was made for, or one tracked since on the same pid when no
    // process holds that pid any more (a re-probe of the same agent). A
    // process that took the pid since is another launch, left to its watch.
    for (const e of entries) {
      const tracked = this.treeRoots.get(e);
      if (!tracked || left.includes(e)) continue;
      const cur = this.states.get(tracked.sessionId);
      if (!cur || cur.wsl) continue;
      if (cur === tracked.state || (cur.pid === e.pid && !table.some((t) => t.pid === e.pid))) this.recordDeath(tracked.sessionId, cur);
    }
    return { same, unsure };
  }

  /** The agent's death edge, recorded by a fresh process table rather than
   *  the monitor's next poll (up to one cadence later), so a stop that just
   *  confirmed the agent gone (session.stopAgent) is what the next session
   *  list reports. Its watch is dropped so the monitor cannot report the
   *  same death again. */
  private recordDeath(sessionId: string, s: TrackedAgent): void {
    if (!s.alive) return;
    if (s.wsl) this.wsl.watcher?.unwatch(AgentProcessTracker.watchKey(sessionId));
    else this.watcher.unwatch(AgentProcessTracker.watchKey(sessionId));
    s.alive = false;
    this.emitState(sessionId, { ...(s.slug ? { slug: s.slug } : {}), alive: false });
  }

  /** Drop all tracking for a session (died / interrupted / killed). */
  disarm(sessionId: string): void {
    this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1);
    this.watcher.unwatch(AgentProcessTracker.watchKey(sessionId));
    this.wsl.watcher?.unwatch(AgentProcessTracker.watchKey(sessionId));
    this.states.delete(sessionId);
    this.shellPids.delete(sessionId);
    this.lastFailedAt.delete(sessionId);
    this.lastRearmAt.delete(sessionId);
    this.forceQueued.delete(sessionId);
    this.slugQueued.delete(sessionId);
    this.slugProbeBlockedUntil.delete(sessionId);
  }

  private snapshot(): Promise<ProcessTreeEntry[]> {
    if (!this.snapshotInFlight) {
      this.snapshotStartedAt = Date.now();
      this.snapshotInFlight = this.enumerate().finally(() => {
        this.snapshotInFlight = null;
      });
    }
    return this.snapshotInFlight;
  }
}
