import path from 'node:path';
import { CHATV2_PROVIDER_SESSION_ID, chatV2Error, type ChatV2Error, type ChatV2TerminalProcess } from '../../../shared/chatv2/ipc';
import type { ResumeBinding } from '../../../shared/agentResume';
import { agentRow } from '../../../shared/agentIdentity';
import type { ProcessTreeEntry } from '../../AgentProcessTracker';
import type { ChatV2TerminalDeps } from './types';

/**
 * Terminal → chat: the TUI half of `fromTerminal` (the host does the rest).
 * The order is the safety argument, the mirror of handoff.ts:
 *
 *   1. check, changing nothing: the pane's own Claude conversation (an exact
 *      session id whose transcript sits in the account folder the chat would
 *      use), a Claude the tracker follows and that is at rest (no turn, no
 *      approval, no dialog or draft on screen, no teammate at work), nobody
 *      else holding the conversation;
 *   2. stop the TUI's process tree, the turn checked again right before the
 *      first signal;
 *   3. prove it gone: the tree is not running (pid, name and argv), the pane
 *      is free (the tracked pid is dead and the shell has no children), no
 *      process anywhere carries the session id in its argv, and the
 *      transcript stopped changing.
 *
 * Only then does the host persist the record and start the driver. Anything
 * that cannot be read counts as running. After the stop nothing is restarted
 * here: the pane keeps its resume binding, so the terminal's Resume reopens
 * the conversation.
 */

export interface FromTerminalDeps extends ChatV2TerminalDeps {
  paneFree: (paneId: string) => Promise<boolean>;
  /** The resume line's grammar for the pane's shell (host.shellKind): null when wmux cannot type one into it. */
  shellKind: (paneId: string) => 'posix' | 'pwsh' | null;
  /** Size, mtime and inode of a file, or null when it is not a readable regular file. */
  stat: (file: string) => { size: number; mtimeMs: number; ino: number } | null;
  isDirectory: (dir: string) => boolean;
  /** Throws when the path does not resolve. */
  realpath: (p: string) => string;
  platform: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long the transcript must stay unchanged after the stop. */
  quietMs?: number;
  /** How long to wait for the pane to read free once the TUI stopped. */
  freeWaitMs?: number;
}

export type TerminalCheck =
  | { ok: true; binding: ResumeBinding; tree: { root: ProcessTreeEntry; descendants: ProcessTreeEntry[] } | null }
  | { ok: false; error: ChatV2Error };

export type TerminalRelease =
  | { ok: true; binding: ResumeBinding; stopped: boolean }
  | { ok: false; error: ChatV2Error };

const QUIET_MS = 500;
const FREE_WAIT_MS = 5_000;
const POLL_MS = 200;
/** Said after every failure that follows the stop. */
export const STOPPED_PREFIX = 'Claude was stopped; reopen it with Resume.';

// eslint-disable-next-line no-control-regex -- a control character in a path ends a typed line early
const CONTROL = /[\u0000-\u001f\u007f]/;

const refuse = (message: string): { ok: false; error: ChatV2Error } => chatV2Error('handoff-refused', message);

/** `name (pid N)` for a refusal that names who holds the conversation. */
function named(entries: readonly ProcessTreeEntry[]): string {
  return entries.slice(0, 3).map((e) => `${e.name} (pid ${e.pid})`).join(', ');
}

/**
 * Why `holders` keep the conversation from moving: a process whose argv
 * carries the session id, or (Windows) a claude, node or bun process whose
 * command line wmux cannot read. Names only, never argv.
 */
export function holdersRefusal(holders: readonly ProcessTreeEntry[]): string {
  const read = holders.filter((e) => !!e.cmdline);
  const unread = holders.filter((e) => !e.cmdline);
  if (!read.length) return `A process wmux cannot read may hold this conversation: ${named(unread)}.`;
  const held = `Another process holds this conversation: ${named(read)}.`;
  return unread.length ? `${held} A process wmux cannot read may hold it too: ${named(unread)}.` : held;
}

/** What the stop would end, for the confirmation: names only, never argv. */
export function describeProcesses(entries: readonly ProcessTreeEntry[]): ChatV2TerminalProcess[] {
  return entries.map((e) => ({ name: path.basename(e.name) || e.name, mcp: /mcp/i.test(e.cmdline ?? e.name) }));
}

/**
 * Why `binding` cannot be resumed by a chat on `configDir`, or null. Exactly
 * `<configDir>/projects/<project>/<sessionId>.jsonl`: Continue on another
 * account can leave the same id in two account folders, and the driver reads
 * only the one its env names.
 */
export function bindingRefusal(
  binding: ResumeBinding | undefined,
  configDir: string,
  deps: Pick<FromTerminalDeps, 'stat' | 'isDirectory' | 'realpath'>,
): string | null {
  const unknown = 'This pane has no Claude conversation wmux can resume.';
  if (!binding || !agentRow(binding.agent)?.continueInChat) return unknown;
  const { sessionId, transcriptPath, cwd } = binding;
  if (!CHATV2_PROVIDER_SESSION_ID.test(sessionId) || !transcriptPath || !path.isAbsolute(transcriptPath)) return unknown;
  const projectDir = path.dirname(transcriptPath);
  const projectsDir = path.dirname(projectDir);
  if (path.basename(transcriptPath) !== `${sessionId}.jsonl` || path.basename(projectsDir) !== 'projects') return unknown;
  if (!deps.stat(transcriptPath)) return unknown;
  // The `projects` folders themselves: one may be a link to the other.
  let same = false;
  try {
    same = deps.realpath(projectsDir) === deps.realpath(path.join(configDir, 'projects'));
  } catch { /* either side gone */ }
  if (!same) return 'This conversation belongs to another Claude account folder than this pane uses.';
  if (!cwd || !path.isAbsolute(cwd) || CONTROL.test(cwd) || !deps.isDirectory(cwd)) return 'The conversation’s folder is gone.';
  return null;
}

/**
 * Step 1. `tombstone`: the pane holds a `handed-off` chat record, so a pane
 * whose Claude already exited may move too (there is nothing to stop).
 */
export async function checkTerminal(deps: FromTerminalDeps, paneId: string, opts: { tombstone: boolean; configDir: string }): Promise<TerminalCheck> {
  if (deps.platform !== 'darwin' && deps.platform !== 'linux' && deps.platform !== 'win32') return refuse('Continuing in chat is available on macOS, Linux and Windows.');
  const unsupported = deps.unsupported(paneId);
  if (unsupported) return refuse(unsupported);
  // cmd.exe has no resume line: after a failed start the terminal could not reopen the conversation.
  if (deps.platform === 'win32' && deps.shellKind(paneId) === null) return refuse('This pane’s shell cannot reopen the conversation afterwards. Use PowerShell.');
  const binding = deps.binding(paneId);
  const bad = bindingRefusal(binding, opts.configDir, deps);
  if (bad || !binding) return refuse(bad ?? 'This pane has no Claude conversation wmux can resume.');
  const live = deps.liveAgent(paneId);
  const claude = live !== undefined && agentRow(live)?.continueInChat === true;
  if (live !== undefined && !claude) return refuse('Another agent runs in this pane.');
  let tree: { root: ProcessTreeEntry; descendants: ProcessTreeEntry[] } | null = null;
  if (claude) {
    try {
      tree = await deps.tree(paneId);
    } catch {
      return refuse('Could not read the running processes.');
    }
    // A Claude the tracker does not follow cannot be stopped as a whole.
    if (!tree) return refuse('wmux does not track the Claude in this pane, so it cannot stop it safely.');
    const busy = await deps.notAtRest(paneId);
    if (busy) return refuse(busy);
  } else {
    if (!opts.tombstone) return refuse('No Claude conversation runs in this pane.');
    if (!(await deps.paneFree(paneId))) return refuse('Something is running in this pane. Finish it first.');
  }
  if (deps.otherOwners(paneId, binding.sessionId).length > 0) return refuse('This conversation is open in another pane.');
  const own = new Set(tree ? [tree.root.pid, ...tree.descendants.map((e) => e.pid)] : []);
  let holders: ProcessTreeEntry[];
  try {
    holders = (await deps.processesWithArg(binding.sessionId)).filter((e) => !own.has(e.pid));
  } catch {
    return refuse('Could not read the running processes.');
  }
  if (holders.length) return refuse(holdersRefusal(holders));
  return { ok: true, binding, tree };
}

/** Steps 2 and 3, after `checkTerminal` passed. */
export async function releaseTerminal(deps: FromTerminalDeps, paneId: string, checked: Extract<TerminalCheck, { ok: true }>): Promise<TerminalRelease> {
  const { binding, tree } = checked;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const stopped = tree !== null;
  const fail = (reason: string): TerminalRelease => refuse(stopped ? `${STOPPED_PREFIX} ${reason}` : reason);

  // 2. Stop the tree. `stopped: false` (nothing found to signal) is no proof.
  if (tree) {
    const stop = await deps.stop(paneId, () => deps.stillIdle(paneId)).catch(() => ({ ok: false as const, code: 'still_running' as const, pid: tree.root.pid }));
    if (!stop.ok && stop.code === 'turn_open') return refuse('Claude started working again. Try once its turn ends.');
    if (!stop.ok && stop.code === 'unverified') return refuse('wmux could not confirm which processes are Claude’s, so nothing was stopped. Try again.');
    if (!stop.ok) return fail('It did not exit; it may still be running in the terminal.');
    if (!stop.stopped) return refuse('Could not find the Claude process to stop.');
  }

  // 3. Prove it gone.
  const deadline = now() + (deps.freeWaitMs ?? FREE_WAIT_MS);
  let free = false;
  for (;;) {
    free = await deps.paneFree(paneId).catch(() => false);
    if (free || now() >= deadline) break;
    await sleep(POLL_MS);
  }
  if (!free) return fail('Something is still running in the terminal.');
  let holders: ProcessTreeEntry[];
  try {
    holders = await deps.processesWithArg(binding.sessionId);
  } catch {
    return fail('Could not confirm that it exited.');
  }
  if (holders.length) return fail(holdersRefusal(holders));
  const before = deps.stat(binding.transcriptPath!);
  await sleep(deps.quietMs ?? QUIET_MS);
  const after = deps.stat(binding.transcriptPath!);
  if (!before || !after || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    return fail('The conversation file is still being written.');
  }
  // Still the same conversation: a hook may have rebound the pane meanwhile.
  if (deps.binding(paneId)?.sessionId !== binding.sessionId) return fail('The pane moved to another conversation.');
  return { ok: true, binding, stopped };
}
