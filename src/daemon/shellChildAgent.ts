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
 * starts none. The naming is the tracker's own (selectAgentProcess).
 */
import { readProcessCommandLine, tryProcessFamily } from '../main/pty/winSnapshotNative';
import { selectAgentProcess, type ProcessTreeEntry } from './AgentProcessTracker';
import type { AgentSlug } from '../shared/agentIdentity';

export interface ShellChildReaders {
  /** The shell and its direct children with image names; null when unreadable. */
  family: (shellPid: number) => Array<{ pid: number; ppid: number; name: string }> | null;
  commandLine: (pid: number) => string | null;
}

const NATIVE_READERS: ShellChildReaders = { family: tryProcessFamily, commandLine: readProcessCommandLine };

/** The agent `shellPid` is, or runs as a direct child; undefined when none can be named. */
export function shellChildAgent(shellPid: number, read: ShellChildReaders = NATIVE_READERS): AgentSlug | undefined {
  const family = read.family(shellPid);
  if (!family) return undefined;
  // A runtime (node.exe) is named by its script, which only its command line holds.
  const entries: ProcessTreeEntry[] = family.map((p) => ({ ...p, cmdline: read.commandLine(p.pid) ?? undefined }));
  return selectAgentProcess(entries, shellPid)?.slug;
}
