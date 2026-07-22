/**
 * Edge-triggered "is this pane's agent process still alive?" tracker — the
 * process-truth gate for the persistent resume chip (ResumeInfoChip).
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
 * Mechanism:
 *  1. arm(sessionId, shellPid) — called when something PROVES the agent is
 *     running right now (a claude hook reaching daemon.setResumeBinding, or
 *     a live AgentDetector banner). Takes ONE process-table snapshot
 *     (pid/ppid/name), walks the pane shell's descendant tree, and picks the
 *     agent process (see selectAgentPid).
 *  2. The picked PID is handed to the daemon's existing ProcessMonitor batch
 *     (one shared tasklist per tick — no new spawn train; #538 discipline),
 *     which also guards against PID reuse via image-name identity.
 *  3. onDead → the session's state flips to alive=false and STAYS false until
 *     a fresh arm() (agent relaunched → new hook/banner) re-probes.
 *
 * statusFor() is tri-state on purpose: `undefined` (never armed / couldn't
 * attribute) keeps the renderer on its old heuristic, so this tracker only
 * ever REPLACES guesswork with process truth — it never invents a state.
 *
 * Cost: one process-table enumeration per agent LAUNCH per pane (not per
 * poll), then a piggyback ride on the ProcessMonitor cadence.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface ProcessTreeEntry {
  pid: number;
  ppid: number;
  /** Executable image name (basename), platform-cased. */
  name: string;
}

/** The watcher surface the tracker needs — ProcessMonitor satisfies it
 *  structurally, and tests inject a fake. */
export interface PidWatcher {
  watch(key: string, pid: number, onDead: () => void): void;
  unwatch(key: string): void;
}

/** Agent launcher binaries (native installs): a descendant with one of these
 *  stems IS the agent — the strongest possible attribution. */
const AGENT_STEMS: ReadonlySet<string> = new Set(['claude', 'codex']);

/** JS/TS runtime stems: an npm-installed agent runs as `node` (via a cmd shim
 *  on Windows), so the SHALLOWEST runtime in the tree is the CLI itself —
 *  deeper ones are its children (MCP servers), which the agent can restart
 *  mid-session and must not be watched. */
const RUNTIME_STEMS: ReadonlySet<string> = new Set(['node', 'bun', 'deno']);

/** `claude.exe` → `claude`; `C:\...\node.EXE` → `node`; `pwsh` → `pwsh`. */
function imageStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|com|cmd|bat)$/, '');
}

/**
 * Parse the normalized `pid|ppid|name` lines produced by the Windows
 * enumeration script. Malformed lines (PowerShell banners, blank tails) are
 * skipped. Pure — exported for unit tests.
 */
export function parsePipeDelimited(stdout: string): ProcessTreeEntry[] {
  const entries: ProcessTreeEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\|(\d+)\|(.+)$/);
    if (!m) continue;
    entries.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), name: m[3] });
  }
  return entries;
}

/**
 * Parse `ps -axo pid=,ppid=,comm=` output. `comm` may be a full path on
 * macOS — the stem logic basenames it later, so it is kept verbatim here.
 * Pure — exported for unit tests.
 */
export function parsePsOutput(stdout: string): ProcessTreeEntry[] {
  const entries: ProcessTreeEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    entries.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), name: m[3] });
  }
  return entries;
}

/**
 * Pick the agent process among `shellPid`'s descendants:
 *   1. the shallowest descendant whose stem is a known agent binary
 *      (`claude.exe` — native installs), else
 *   2. the shallowest descendant whose stem is a JS runtime (`node` — npm
 *      installs run through a cmd shim, so the CLI sits at depth 2; its own
 *      node children are MCP servers and must NOT be picked), else
 *   3. the first DIRECT child (depth 1) — an unknown wrapper still dies with
 *      the foreground command, so its death is the same edge, else
 *   4. undefined — nothing attributable (the caller stays undecided).
 *
 * BFS with a visited set: Windows PPIDs can be stale/reused and form cycles.
 * Pure — exported for unit tests.
 */
export function selectAgentPid(
  entries: ReadonlyArray<ProcessTreeEntry>,
  shellPid: number,
): number | undefined {
  const byParent = new Map<number, ProcessTreeEntry[]>();
  for (const e of entries) {
    const list = byParent.get(e.ppid);
    if (list) list.push(e);
    else byParent.set(e.ppid, [e]);
  }
  let agentHit: { pid: number; depth: number } | undefined;
  let runtimeHit: { pid: number; depth: number } | undefined;
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
      if (AGENT_STEMS.has(stem) && (!agentHit || childDepth < agentHit.depth)) {
        agentHit = { pid: child.pid, depth: childDepth };
      } else if (RUNTIME_STEMS.has(stem) && (!runtimeHit || childDepth < runtimeHit.depth)) {
        runtimeHit = { pid: child.pid, depth: childDepth };
      }
      queue.push({ pid: child.pid, depth: childDepth });
    }
  }
  return agentHit?.pid ?? runtimeHit?.pid ?? directChild;
}

/** One full process-table snapshot (pid/ppid/name). Windows has no PPID in
 *  tasklist, so this shells out to Windows PowerShell 5.1 (always present,
 *  absolute System32 path — no PATH trust) for a single CIM enumeration.
 *  POSIX uses one `ps`. Throws on failure — the caller stays undecided. */
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
        // contain '|'). Win32_Process is one WMI query — no per-PID walks.
        "Get-CimInstance -ClassName Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name }",
      ],
      { encoding: 'utf-8', timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    return parsePipeDelimited(stdout as string);
  }
  const { stdout } = await execFileAsync(
    'ps',
    ['-axo', 'pid=,ppid=,comm='],
    { encoding: 'utf-8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return parsePsOutput(stdout as string);
}

interface TrackedAgent {
  pid: number;
  alive: boolean;
}

export class AgentProcessTracker {
  private readonly states = new Map<string, TrackedAgent>();
  /** In-flight arm() per session — coalesces the hook-storm case (a claude
   *  turn can fire several hooks back-to-back) into one probe. */
  private readonly inFlight = new Set<string>();
  /** Bumped by disarm(); an arm() that resolves after its session was
   *  disarmed must not resurrect state for a destroyed pane. */
  private readonly generation = new Map<string, number>();
  /** Shared snapshot promise — concurrent arms across sessions ride one
   *  enumeration instead of spawning one each. */
  private snapshotInFlight: Promise<ProcessTreeEntry[]> | null = null;

  constructor(
    private readonly watcher: PidWatcher,
    private readonly enumerate: () => Promise<ProcessTreeEntry[]> = enumerateProcesses,
  ) {}

  private static watchKey(sessionId: string): string {
    // Namespaced so it can never collide with the daemon's shell-PID watches,
    // which key ProcessMonitor by the raw session id.
    return `agent:${sessionId}`;
  }

  /**
   * (Re)attach to the session's live agent process. Fire-and-forget: callers
   * sit on hot paths (hook RPC, banner event) and must not await a probe.
   * No-op while a live agent is already being watched — the probe runs once
   * per agent LAUNCH, not per hook.
   */
  arm(sessionId: string, shellPid: number): void {
    if (this.states.get(sessionId)?.alive) return;
    if (this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    const gen = this.generation.get(sessionId) ?? 0;
    void (async () => {
      try {
        const entries = await this.snapshot();
        if ((this.generation.get(sessionId) ?? 0) !== gen) return; // disarmed meanwhile
        const agentPid = selectAgentPid(entries, shellPid);
        // No attributable descendant (agent already gone, or an exotic launch
        // we can't see) → stay undecided so the renderer keeps its heuristic.
        if (agentPid === undefined) return;
        this.states.set(sessionId, { pid: agentPid, alive: true });
        this.watcher.watch(AgentProcessTracker.watchKey(sessionId), agentPid, () => {
          const cur = this.states.get(sessionId);
          // Only the SAME watched pid may flip the flag — a re-arm that
          // landed after this watch was superseded must win.
          if (cur && cur.pid === agentPid) cur.alive = false;
        });
      } catch {
        // Enumeration failed (timeout, spawn error) — undecided, never a lie.
      } finally {
        this.inFlight.delete(sessionId);
      }
    })();
  }

  /** true = agent process observed alive; false = it was observed and DIED
   *  (the edge); undefined = never attributed → caller falls back. */
  statusFor(sessionId: string): boolean | undefined {
    return this.states.get(sessionId)?.alive;
  }

  /** Drop all tracking for a session (died / interrupted / killed). */
  disarm(sessionId: string): void {
    this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1);
    this.watcher.unwatch(AgentProcessTracker.watchKey(sessionId));
    this.states.delete(sessionId);
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
