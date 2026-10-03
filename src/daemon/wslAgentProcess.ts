/**
 * #1727 — process truth for agents running inside a WSL pane.
 *
 * The pane's shell is `wsl.exe`; the agent is a Linux process the Windows
 * process table never lists, so AgentProcessTracker's tree walk cannot find
 * it. Instead the WSL hook (WSL_HOOK in src/shared/wslIntegration.ts), which
 * runs inside Linux as the agent's descendant, reports its ancestors:
 *
 *   hook.sh ──WMUX_WSL_AGENT_PROC──▶ wmux-bridge.mjs ──AgentSignal──▶ daemon
 *     "1:<boot id>" RS "<pid>:<starttime>:<cmdline>" RS …   (args US-separated)
 *
 * parseWslAgentReport + pickReportedAgent turn that into one (pid, starttime,
 * boot id) whose command line names the hook's agent. From then on only that
 * known pid is ever checked, from Windows, with one `wsl.exe` that stats it:
 *
 *   WslPidWatcher        every tick, ONE wsl.exe per distro+user, batched over
 *                        every watched pid; the death edge for the tracker
 *   checkWslAgentRunning a single fresh stat, for delivery-time checks
 *
 * Identity is (boot id, pid, starttime): a pid reused after the agent exits,
 * or after the distro restarts, has a different starttime or boot id.
 *
 * Never boots a VM: `wsl.exe -d <distro>` starts a stopped distro, so every
 * probe first checks the pane's own Windows `wsl.exe` is still alive. A dead
 * one means the pane, and so the agent, is gone; the death edge fires without
 * a spawn. Probe failures (timeout, interop down) are undecided, never death.
 */
import { execFile } from 'child_process';
import os from 'os';
import { selectAgentProcess, tokenizeCmdline } from './AgentProcessTracker';
import type { AgentSlug } from '../shared/agentIdentity';
import { wslTargetArgs, type WslTarget } from '../shared/wsl';
import { decodeWslOutput } from '../shared/wslDistro';

const RS = '\x1e';
const US = '\x1f';
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGITS = /^[0-9]{1,20}$/;
/** Linux pid_max is at most 2^22. */
const MAX_PID = 4_194_304;

export interface WslAgentReport {
  bootId: string;
  /** Nearest ancestor first. `cmdline` arguments are space-joined. */
  chain: Array<{ pid: number; start: string; cmdline: string }>;
}

/** The hook's raw report, or undefined when any part of it is malformed. */
export function parseWslAgentReport(raw: unknown): WslAgentReport | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return undefined;
  const [head, ...records] = raw.split(RS);
  if (!head?.startsWith('1:')) return undefined;
  const bootId = head.slice(2).trim().toLowerCase();
  if (!BOOT_ID.test(bootId)) return undefined;
  const chain: WslAgentReport['chain'] = [];
  for (const record of records) {
    const first = record.indexOf(':');
    const second = first < 0 ? -1 : record.indexOf(':', first + 1);
    if (second < 0) return undefined;
    const pidText = record.slice(0, first);
    const start = record.slice(first + 1, second);
    if (!DIGITS.test(pidText) || !DIGITS.test(start)) return undefined;
    const pid = Number(pidText);
    if (pid < 2 || pid > MAX_PID) return undefined;
    chain.push({ pid, start, cmdline: record.slice(second + 1).split(US).join(' ').trim() });
  }
  return chain.length > 0 ? { bootId, chain } : undefined;
}

export interface WslReportedAgent {
  pid: number;
  start: string;
  bootId: string;
  slug: AgentSlug;
  /** The reported pids ABOVE the agent: a tracked agent among them means this
   *  one is nested inside it (a `claude -p` run by the pane's own claude). */
  ancestors: number[];
}

/** The nearest reported ancestor whose command line names `expected`. A
 *  `sh -c` hop between the agent and the hook is skipped; a different agent
 *  is never accepted in its place. */
export function pickReportedAgent(report: WslAgentReport | undefined, expected: AgentSlug): WslReportedAgent | undefined {
  if (!report) return undefined;
  for (const [i, entry] of report.chain.entries()) {
    // The tracker's own identification, applied to this one process as a
    // root (native stem like `claude`, or a runtime naming the agent).
    const name = tokenizeCmdline(entry.cmdline)[0] ?? '';
    const slug = selectAgentProcess([{ pid: entry.pid, ppid: -1, name, cmdline: entry.cmdline }], entry.pid)?.slug;
    if (slug === expected) {
      return {
        pid: entry.pid, start: entry.start, bootId: report.bootId, slug: expected,
        ancestors: report.chain.slice(i + 1).map((e) => e.pid),
      };
    }
  }
  return undefined;
}

/**
 * The trust gate for a hook signal on a WSL pane (#1727): the reported agent
 * process, or undefined when this signal may not name one. Only the pane's
 * own hook (exact ptyId) may, only for a WSL session, and only as the agent
 * the hook itself speaks for. Pure — exported for tests.
 */
export function reportedAgentForPane(
  sessionId: string,
  isWslSession: boolean,
  signal: { ptyId?: string; agent: AgentSlug; wslAgentProcess?: string },
): WslReportedAgent | undefined {
  if (!isWslSession || signal.ptyId !== sessionId || !signal.wslAgentProcess) return undefined;
  return pickReportedAgent(parseWslAgentReport(signal.wslAgentProcess), signal.agent);
}

/** Where a watched WSL agent lives: the pane's own wsl.exe and its target. */
export interface WslAgentLocation {
  /** The pane's Windows `wsl.exe` path (session meta `cmd`). */
  shell: string;
  target: WslTarget;
  /** The pane's Windows `wsl.exe` pid — the never-boot-a-VM gate. */
  hostPid: number;
}

export interface WslProbeResult {
  bootId: string;
  /** pid → (starttime, state letter). A pid missing here does not exist. */
  procs: Map<number, { start: string; state: string }>;
}

export type WslProbe = (shell: string, target: WslTarget, pids: number[]) => Promise<WslProbeResult>;

// One stat read per pid; the function keeps `set --` off the loop's list.
const PROBE_SCRIPT = `
st() { set -f; set -- \${1##*) }; printf '%s %s' "$1" "\${20}"; }
{ read -r b < /proc/sys/kernel/random/boot_id; } 2>/dev/null || exit 3
printf 'B %s\\n' "$b"
for p; do
  s=$(cat "/proc/$p/stat" 2>/dev/null) || continue
  printf 'P %s %s\\n' "$p" "$(st "$s")"
done
`;
/** The watcher's periodic probe. A delivery check waits less: it holds a
 *  scheduled prompt, and a slow answer only defers it to the next try. */
const PROBE_TIMEOUT_MS = 10_000;
const DELIVERY_PROBE_TIMEOUT_MS = 5_000;

/** Exported for tests: the script, run as `sh -c PROBE_SCRIPT wmux-ps <pid>…`. */
export { PROBE_SCRIPT };

/** Pure — exported for tests. */
export function parseWslProbeOutput(stdout: string): WslProbeResult {
  let bootId = '';
  const procs = new Map<number, { start: string; state: string }>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'B' && parts[1] && BOOT_ID.test(parts[1].toLowerCase())) bootId = parts[1].toLowerCase();
    else if (parts[0] === 'P' && parts.length === 4 && DIGITS.test(parts[1]) && DIGITS.test(parts[3]) && /^[A-Za-z]$/.test(parts[2])) {
      procs.set(Number(parts[1]), { state: parts[2], start: parts[3] });
    }
  }
  if (!bootId) throw new Error('WSL process probe returned no boot id');
  return { bootId, procs };
}

export const probeWslProcesses = (
  shell: string, target: WslTarget, pids: number[], timeout = PROBE_TIMEOUT_MS,
): Promise<WslProbeResult> => new Promise((resolve, reject) => {
  const args = [...wslTargetArgs(target), '--exec', '/bin/sh', '-c', PROBE_SCRIPT, 'wmux-ps', ...pids.map(String)];
  execFile(shell, args, {
    encoding: 'buffer', timeout, maxBuffer: 1024 * 1024, windowsHide: true,
    cwd: os.homedir(), env: { ...process.env, WSL_UTF8: '1' },
  }, (error, stdout, stderr) => {
    if (error) { reject(new Error(decodeWslOutput(stderr).trim() || error.message)); return; }
    try { resolve(parseWslProbeOutput(stdout.toString('utf8'))); } catch (err) { reject(err as Error); }
  });
});

/** Whether a Windows pid exists, without spawning anything. */
export function windowsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface WslWatchedAgent extends WslAgentLocation {
  pid: number;
  start: string;
  bootId: string;
}

/** Same (boot, pid, starttime) and not a zombie. `T` (stopped) still exists:
 *  it is not a death edge, only "not running" for a delivery check. */
function sameProcess(agent: WslWatchedAgent, result: WslProbeResult): { exists: boolean; state?: string } {
  if (result.bootId !== agent.bootId) return { exists: false };
  const proc = result.procs.get(agent.pid);
  if (!proc || proc.start !== agent.start || proc.state === 'Z' || proc.state === 'X') return { exists: false };
  return { exists: true, state: proc.state };
}

/**
 * A fresh delivery-time check: the agent is the same process and running
 * (not stopped by Ctrl+Z, not a zombie). False on any doubt — a failed probe
 * must not let a scheduled prompt land in a pane whose agent may be gone.
 */
export async function checkWslAgentRunning(
  agent: WslWatchedAgent,
  probe: WslProbe = (shell, target, pids) => probeWslProcesses(shell, target, pids, DELIVERY_PROBE_TIMEOUT_MS),
  hostAlive: (pid: number) => boolean = windowsPidAlive,
): Promise<boolean> {
  if (!hostAlive(agent.hostPid)) return false;
  try {
    const seen = sameProcess(agent, await probe(agent.shell, agent.target, [agent.pid]));
    return seen.exists && seen.state !== 'T' && seen.state !== 't';
  } catch {
    return false;
  }
}

interface WatchEntry extends WslWatchedAgent {
  onDead: () => void;
}

/** Death-edge watcher for WSL agents; the WSL counterpart of the
 *  ProcessMonitor watch the tracker uses for Windows agents. */
export class WslPidWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly probe: WslProbe = probeWslProcesses,
    private readonly hostAlive: (pid: number) => boolean = windowsPidAlive,
    private readonly intervalMs = 15_000,
  ) {}

  watch(key: string, agent: WslWatchedAgent, onDead: () => void): void {
    this.entries.set(key, { ...agent, onDead });
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  unwatch(key: string): void {
    this.entries.delete(key);
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One pass. Exported through the class for tests; the timer calls it. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const groups = new Map<string, Array<[string, WatchEntry]>>();
      for (const [key, entry] of this.entries) {
        if (!this.hostAlive(entry.hostPid)) {
          this.fire(key, entry);
          continue;
        }
        const group = JSON.stringify([entry.shell, entry.target.distribution, entry.target.user]);
        groups.set(group, [...(groups.get(group) ?? []), [key, entry]]);
      }
      for (const members of groups.values()) {
        const { shell, target } = members[0][1];
        let result: WslProbeResult;
        try {
          result = await this.probe(shell, target, [...new Set(members.map(([, e]) => e.pid))]);
        } catch {
          continue; // undecided: never a death on a failed probe
        }
        for (const [key, entry] of members) {
          if (!sameProcess(entry, result).exists) this.fire(key, entry);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private fire(key: string, entry: WatchEntry): void {
    // Only the entry that was probed; a re-watch while the probe ran wins.
    if (this.entries.get(key) !== entry) return;
    this.unwatch(key);
    try {
      entry.onDead();
    } catch {
      // A listener error must not stop the other entries.
    }
  }
}
