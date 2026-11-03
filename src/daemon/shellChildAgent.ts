/**
 * The agent a pane's shell is running as its own child, read synchronously
 * (#2838). On Windows the process tracker names a newly started agent 2.4 to
 * 3.9 s after Enter, while Claude Code sends its OSC 7501 feature query at
 * about 2.6 s and takes a later reply as "unsupported" once the viewer has
 * answered the DA1 it sends right behind. This read lets the query be
 * answered on evidence that exists at that moment.
 *
 * Only the shell itself (an exec-rooted pane) and its direct children count:
 * an agent the shell started in the foreground is its child, and a `cat` of a
 * file holding the query (a cmdlet or builtin in PowerShell and cmd.exe)
 * starts none. The naming is the tracker's own (selectAgentProcess), over
 * the processes still running that started no earlier than the caller's
 * `since` (the shell's latest command start).
 */
import { readProcessCommandLine, readProcessExitState, tryProcessCreatedAt, tryProcessFamily } from '../main/pty/winSnapshotNative';
import { selectAgentProcess, type ProcessTreeEntry } from './AgentProcessTracker';
import type { AgentSlug } from '../shared/agentIdentity';

export interface ShellChildReaders {
  /** The shell and its direct children with image names; null when unreadable. */
  family: (shellPid: number) => Array<{ pid: number; ppid: number; name: string }> | null;
  commandLine: (pid: number) => string | null;
  /** Creation time as a FILETIME (100 ns since 1601), or null. */
  createdAt: (pid: number) => bigint | null;
  exitState: (pid: number) => 'exited' | 'running' | 'unknown';
}

const NATIVE_READERS: ShellChildReaders = {
  family: tryProcessFamily, commandLine: readProcessCommandLine, createdAt: tryProcessCreatedAt, exitState: readProcessExitState,
};

/** FILETIME ticks per ms, and the Unix epoch in FILETIME ms. */
const TICKS_PER_MS = 10_000n;
const UNIX_EPOCH_FILETIME_MS = 11_644_473_600_000n;

/**
 * The running agent `shellPid` is, or runs as a direct child, with its start
 * time (epoch ms); undefined when none can be named. Processes are filtered
 * before the naming: one that exited can stay listed while its last handles
 * close, and one started before `since` runs behind the latest command, and
 * either would otherwise stand in for, or hide, the agent that command started.
 */
export function shellChildAgent(shellPid: number, since: number, read: ShellChildReaders = NATIVE_READERS): { slug: AgentSlug; pid: number; startedAt: number } | undefined {
  const family = read.family(shellPid);
  if (!family) return undefined;
  const startedAt = new Map<number, number>();
  const entries: ProcessTreeEntry[] = [];
  for (const p of family) {
    const created = read.createdAt(p.pid);
    if (created === null) continue;
    const at = Number(created / TICKS_PER_MS - UNIX_EPOCH_FILETIME_MS);
    if (at < since || read.exitState(p.pid) !== 'running') continue;
    startedAt.set(p.pid, at);
    // A runtime (node.exe) is named by its script, which only its command line holds.
    entries.push({ ...p, cmdline: read.commandLine(p.pid) ?? undefined });
  }
  const pick = selectAgentProcess(entries, shellPid);
  const at = pick?.slug ? startedAt.get(pick.pid) : undefined;
  return pick?.slug && at !== undefined ? { slug: pick.slug, pid: pick.pid, startedAt: at } : undefined;
}
