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
import path from 'path';
import { AGENT_SLUG_SET, type AgentSlug } from '../shared/agentIdentity';

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

/** Package-manager runners: when the script token is one of these (or
 *  python's `-m`), the agent name rides the NEXT non-flag argument
 *  (`npx -y gemini`, `python -m aider`). */
const RUNNER_STEMS: ReadonlySet<string> = new Set(['npx', 'npx-cli', 'bunx', 'yarn']);

/** Launcher-package spellings → slug. Keys are npm package names, values are
 *  table slugs — the aliases belong here (they are launcher trivia), not in
 *  agentIdentity.ts. */
const ALIAS_TO_SLUG: ReadonlyMap<string, AgentSlug> = new Map([
  ['claude-code', 'claude'],
  ['@anthropic-ai/claude-code', 'claude'],
  ['gemini-cli', 'gemini'],
  ['@google/gemini-cli', 'gemini'],
  // The Kiro integration ships a `kiro-cli` executable (see KNOWN_AGENT_STEMS
  // in orchestratorRole.ts); its slug in the identity table is `kiro`.
  ['kiro-cli', 'kiro'],
]);

/** Native executable stems whose binary name differs from the slug — the
 *  selectAgentProcess image-stem check consults this alongside the slug set
 *  (a `kiro-cli` process IS the kiro agent even though `kiro-cli` is not a
 *  slug). */
const NATIVE_STEM_TO_SLUG: ReadonlyMap<string, AgentSlug> = new Map([
  ['kiro-cli', 'kiro'],
]);

/** How long an unattributable/failed probe keeps `arm()` from re-enumerating
 *  (#919 panel: without this, a chatty banner re-runs `ps` per event). */
const ARM_BACKOFF_MS = 30_000;

/** Forced re-probes are stronger evidence than a plain arm, but still
 *  rate-limited: repeated conflicting banners against an OLD pick that keeps
 *  winning add no new information. */
const REARM_COOLDOWN_MS = 10_000;

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
 * from its command line. Token discipline (#919 panel): ONLY these
 * candidates are ever matched —
 *   • the script token right after the runtime (`argv[1]`),
 *   • the first non-flag token after a package runner or `python -m`,
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
  const candidates: string[] = [argv[1]];
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
  if (scanFrom >= 0) {
    const next = argv.slice(scanFrom).find((t) => !t.startsWith('-'));
    if (next) candidates.push(next);
  }
  for (const c of [...candidates]) {
    // Exact path SEGMENT only: `not_node_modules` or a directory literally
    // named `xnode_modulesx` must not open a boundary (review: lastIndexOf
    // substring-matched both).
    const segs = c.split(/[\\/]/).filter(Boolean);
    const idx = segs.indexOf('node_modules');
    if (idx === -1 || idx + 1 >= segs.length) continue;
    const pkg = segs[idx + 1]!;
    candidates.push(pkg.startsWith('@') && idx + 2 < segs.length ? `${pkg}/${segs[idx + 2]}` : pkg);
  }
  for (const c of candidates) {
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
 * Parse the normalized `pid|ppid|name|cmdline` lines produced by the Windows
 * enumeration script. CommandLine may itself contain pipes, so everything
 * after the image name joins back into the cmdline. Malformed lines
 * (PowerShell banners, blank tails) are skipped. Pure — exported for tests.
 */
export function parsePipeDelimited(stdout: string): ProcessTreeEntry[] {
  const entries: ProcessTreeEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\|(\d+)\|(.+)$/);
    if (!m) continue;
    const parts = m[3].split('|');
    const cmdline = parts.slice(1).join('|');
    entries.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      name: parts[0] ?? '',
      ...(cmdline ? { cmdline } : {}),
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
      const slug = AGENT_SLUG_SET.has(stem)
        ? (stem as AgentSlug)
        : NATIVE_STEM_TO_SLUG.get(stem) ??
          (RUNTIME_STEMS.has(stem) ? resolveAgentSlug(child.cmdline) : undefined);
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
        // contain '|'; CommandLine may — the parser rejoins it). Win32_Process
        // is one WMI query — no per-PID walks.
        "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine }",
      ],
      { encoding: 'utf-8', timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    return parsePipeDelimited(stdout as string);
  }
  const { stdout } = await execFileAsync(
    'ps',
    ['-axo', 'pid=,ppid=,args='],
    { encoding: 'utf-8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return parsePsOutput(stdout as string);
}

interface TrackedAgent {
  pid: number;
  alive: boolean;
  slug?: AgentSlug;
}

/** Identity/liveness snapshot handed to the state-change listener. */
export interface TrackedAgentState {
  slug?: AgentSlug;
  alive: boolean;
}

export class AgentProcessTracker {
  private readonly states = new Map<string, TrackedAgent>();
  /** In-flight probe per session — coalesces the hook-storm case (a claude
   *  turn can fire several hooks back-to-back) into one enumeration. */
  private readonly inFlight = new Set<string>();
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
  /** Shared snapshot promise — concurrent probes across sessions ride one
   *  enumeration instead of spawning one each. */
  private snapshotInFlight: Promise<ProcessTreeEntry[]> | null = null;
  private stateListener: ((sessionId: string, state: TrackedAgentState) => void) | undefined;

  constructor(
    private readonly watcher: PidWatcher,
    private readonly enumerate: () => Promise<ProcessTreeEntry[]> = enumerateProcesses,
  ) {}

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

  private probe(sessionId: string, shellPid: number): void {
    if (this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    const gen = this.generation.get(sessionId) ?? 0;
    void (async () => {
      try {
        const entries = await this.snapshot();
        if ((this.generation.get(sessionId) ?? 0) !== gen) return; // disarmed meanwhile
        const pick = selectAgentProcess(entries, shellPid);
        // No attributable descendant (agent already gone, or an exotic launch
        // we can't see) → stay undecided so the renderer keeps its heuristic.
        if (!pick) {
          this.lastFailedAt.set(sessionId, Date.now());
          return;
        }
        this.states.set(sessionId, {
          pid: pick.pid,
          alive: true,
          ...(pick.slug ? { slug: pick.slug } : {}),
        });
        this.watcher.watch(AgentProcessTracker.watchKey(sessionId), pick.pid, () => {
          const cur = this.states.get(sessionId);
          // Only the SAME watched pid may flip the flag — a re-probe that
          // landed after this watch was superseded must win.
          if (cur && cur.pid === pick.pid) {
            cur.alive = false;
            this.emitState(sessionId, {
              ...(cur.slug ? { slug: cur.slug } : {}),
              alive: false,
            });
          }
        });
        this.emitState(sessionId, { ...(pick.slug ? { slug: pick.slug } : {}), alive: true });
      } catch {
        // Enumeration failed (timeout, spawn error) — undecided, never a lie.
        this.lastFailedAt.set(sessionId, Date.now());
      } finally {
        this.inFlight.delete(sessionId);
        // Replay a queued forced rearm DIRECTLY — routing it through rearm()
        // again would hit the cooldown already paid when the rearm queued it
        // (lastRearmAt was set seconds ago, so rearm() no-opped and the forced
        // probe was lost). forceQueued is a single bit: no self-retrigger.
        if (this.forceQueued.delete(sessionId)) {
          const pid = this.shellPids.get(sessionId);
          if (pid !== undefined) this.probe(sessionId, pid);
        }
      }
    })();
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

  /** Drop all tracking for a session (died / interrupted / killed). */
  disarm(sessionId: string): void {
    this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1);
    this.watcher.unwatch(AgentProcessTracker.watchKey(sessionId));
    this.states.delete(sessionId);
    this.shellPids.delete(sessionId);
    this.lastFailedAt.delete(sessionId);
    this.lastRearmAt.delete(sessionId);
    this.forceQueued.delete(sessionId);
  }

  private snapshot(): Promise<ProcessTreeEntry[]> {
    if (!this.snapshotInFlight) {
      this.snapshotInFlight = this.enumerate().finally(() => {
        this.snapshotInFlight = null;
      });
    }
    return this.snapshotInFlight;
  }
}
