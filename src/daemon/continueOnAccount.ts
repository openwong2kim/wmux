// ─── Continue a pane's Claude conversation on another account ───────────────
//
// An account's environment reaches a Claude process only at spawn, so a live
// process cannot switch accounts. Continuing on another account is therefore:
//
//   1. check the pane: its own resume binding names a Claude conversation
//      whose transcript exists, the pane runs no other agent, and its turn is
//      over;
//   2. stop the pane's Claude (and everything below it), so one process owns
//      the conversation;
//   3. copy the transcript into the target account's `projects/` folder, under
//      the same project folder name the source uses (Claude derives that name
//      from the cwd the same way for every config dir, so no slug rule is
//      needed). The original is never moved or deleted;
//   4. wait for the shell's empty prompt, bind the pane to the account
//      (its env and resume binding), and type
//      `cd <cwd> && CLAUDE_CONFIG_DIR=<dir> claude --resume <id>`.
//
// Only the pane's own exact session id is ever resumed. A step that fails
// leaves every later step undone; a rebind whose prompt changed before the
// write is rolled back. A failure after the copy carries that line
// (`resumeCommand`), so the person can resume the copy by hand.

import fs from 'node:fs';
import path from 'node:path';
import { CHATV2_PROVIDER_SESSION_ID } from '../shared/chatv2/ipc';
import { permissionFlagFor, type ResumeBinding } from '../shared/agentResume';
import { agentRow } from '../shared/agentIdentity';
import { inResumeCwd, type ResumeShell } from './chat/v2/handoff';
import { beginPaneMove, endPaneMove } from './chat/v2/paneClaims';
import { withChosenAccountEnv } from './phone/paneAccountSpawn';
import type { AgentStopResult } from './agentStop';
import type { DaemonPTYBridge } from './DaemonPTYBridge';
import { isWslOwnTranscriptPath } from './hooks/transcriptPathGuard';
import { isLinuxCwd, validWslTarget, type WslTarget } from '../shared/wsl';
import { parseWslAccountKeys, setWslAccountKeys, WSL_ACCOUNT_DISTRO_ENV, WSL_ACCOUNT_KEYS_ENV, wslAccountLinuxHome } from '../shared/wslAccountHome';
import type { WslAccountCopyOutcome } from './wslAccountCopy';

export type ContinueOnAccountCode =
  | 'no_session'
  | 'folder_trust'
  | 'unsupported'
  | 'not_claude'
  | 'unknown_session'
  | 'invalid_account'
  | 'same_account'
  | 'turn_open'
  | 'busy'
  | 'still_running'
  | 'diverged'
  | 'copy_failed'
  | 'save_failed'
  | 'shell_busy'
  /** After the stop: the prompt was empty, but a program still ran in the shell. */
  | 'shell_running'
  /** After the stop: a key reached the pane while Claude stopped. */
  | 'shell_typed';

export type ContinueOnAccountResult =
  | { ok: true; sessionId: string; transcriptPath: string }
  /** Copy-only: what the new pane resumes, in which folder and mode. */
  | { ok: true; sessionId: string; transcriptPath: string; cwd: string; permissionMode?: ResumeBinding['permissionMode'] }
  /** `resumeCommand`: Claude stopped and the copy exists, but nothing was
   *  typed. The line that resumes the copy, in this pane's shell. */
  | { ok: false; code: ContinueOnAccountCode; resumeCommand?: string };

// eslint-disable-next-line no-control-regex -- a control character ends a typed line early
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Where the copy goes, or why the pane's conversation cannot be continued elsewhere. Pure but for realpath. */
export function planTranscriptCopy(
  binding: ResumeBinding | undefined,
  configDir: string,
  realpath: (p: string) => string = (p) => fs.realpathSync.native(p),
): { ok: true; source: string; target: string } | { ok: false; code: 'not_claude' | 'unknown_session' | 'invalid_account' | 'same_account' } {
  if (!binding) return { ok: false, code: 'unknown_session' };
  if (!agentRow(binding.agent)?.continueOnAccount) return { ok: false, code: 'not_claude' };
  const { sessionId, transcriptPath } = binding;
  if (!CHATV2_PROVIDER_SESSION_ID.test(sessionId) || !transcriptPath || !path.isAbsolute(transcriptPath)) {
    return { ok: false, code: 'unknown_session' };
  }
  // Exactly `<configDir>/projects/<project>/<sessionId>.jsonl`, or the copy's place is unknown.
  const file = path.basename(transcriptPath);
  const projectDir = path.dirname(transcriptPath);
  const projectsDir = path.dirname(projectDir);
  if (file !== `${sessionId}.jsonl` || path.basename(projectsDir) !== 'projects') return { ok: false, code: 'unknown_session' };
  if (!configDir || !path.isAbsolute(configDir) || CONTROL.test(configDir)) return { ok: false, code: 'invalid_account' };
  let sourceRoot: string;
  let targetRoot: string;
  try { sourceRoot = realpath(path.dirname(projectsDir)); } catch { return { ok: false, code: 'unknown_session' }; }
  try { targetRoot = realpath(configDir); } catch { return { ok: false, code: 'invalid_account' }; }
  if (sourceRoot === targetRoot) return { ok: false, code: 'same_account' };
  return { ok: true, source: transcriptPath, target: path.join(configDir, 'projects', path.basename(projectDir), file) };
}

/**
 * A WSL pane's env bound to the account at `configDir` (its Windows folder):
 * the folder, marked as account-sourced, in the pane's distro. The next spawn
 * of the pane (a recovery) then runs that account's home in the distro, and
 * the new Claude's hooks report a transcript there (isWslOwnTranscriptPath).
 */
export function wslAccountEnv(env: Readonly<Record<string, string>> | undefined, configDir: string, target: WslTarget): Record<string, string> {
  const next: Record<string, string> = { ...(env ?? {}), CLAUDE_CONFIG_DIR: configDir, [WSL_ACCOUNT_DISTRO_ENV]: target.distribution };
  setWslAccountKeys(next, [...parseWslAccountKeys(next[WSL_ACCOUNT_KEYS_ENV]), 'CLAUDE_CONFIG_DIR']);
  return next;
}

export interface WslCopyPlan {
  /** The source transcript's Linux path, as the pane's hook reported it. */
  source: string;
  project: string;
  /** The target account's home in the distro, as the pane's next spawn makes it. */
  home: string;
  /** Where the copy goes: `<home>/projects/<project>/<sessionId>.jsonl`. */
  target: string;
}

/**
 * The WSL counterpart of planTranscriptCopy, from the pane's own record alone:
 * its binding's `wslTranscriptPath` must still be its own Claude transcript
 * (in the distro user's default home or its account's home), and the target
 * home is the one the pane's next spawn would run on. Pure: every path is a
 * Linux one this process cannot open, so nothing is resolved here; the copy
 * script checks the folders themselves.
 */
export function planWslTranscriptCopy(
  binding: ResumeBinding | undefined,
  pane: { wslTarget?: unknown; env?: Readonly<Record<string, string>> },
  configDir: string,
): { ok: true; plan: WslCopyPlan } | { ok: false; code: 'not_claude' | 'unknown_session' | 'invalid_account' | 'same_account' | 'unsupported' } {
  if (!validWslTarget(pane.wslTarget)) return { ok: false, code: 'unsupported' };
  const target = pane.wslTarget;
  if (!binding) return { ok: false, code: 'unknown_session' };
  if (!agentRow(binding.agent)?.continueOnAccount) return { ok: false, code: 'not_claude' };
  const { sessionId, wslTranscriptPath: source } = binding;
  if (!CHATV2_PROVIDER_SESSION_ID.test(sessionId) || !source || !isWslOwnTranscriptPath(source, sessionId, target, pane.env)) {
    return { ok: false, code: 'unknown_session' };
  }
  if (!configDir || !(path.win32.isAbsolute(configDir) || path.posix.isAbsolute(configDir)) || CONTROL.test(configDir)) {
    return { ok: false, code: 'invalid_account' };
  }
  const home = wslAccountLinuxHome(wslAccountEnv(pane.env, configDir, target), 'claude', target.user);
  if (!home) return { ok: false, code: 'invalid_account' };
  const projectDir = path.posix.dirname(source);
  if (path.posix.dirname(path.posix.dirname(projectDir)) === home) return { ok: false, code: 'same_account' };
  const project = path.posix.basename(projectDir);
  return { ok: true, plan: { source, project, home, target: `${home}/projects/${project}/${sessionId}.jsonl` } };
}

/** Whether `prefix`'s bytes start `file`'s. */
export async function isBytePrefix(prefix: string, file: string): Promise<boolean> {
  const [a, b] = await Promise.all([fs.promises.open(prefix, 'r'), fs.promises.open(file, 'r')]);
  try {
    const [sa, sb] = await Promise.all([a.stat(), b.stat()]);
    if (sa.size > sb.size) return false;
    const size = 64 * 1024;
    const ba = Buffer.alloc(size);
    const bb = Buffer.alloc(size);
    for (let pos = 0; pos < sa.size; pos += size) {
      const n = Math.min(size, sa.size - pos);
      await Promise.all([a.read(ba, 0, n, pos), b.read(bb, 0, n, pos)]);
      if (!ba.subarray(0, n).equals(bb.subarray(0, n))) return false;
    }
    return true;
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}

/**
 * Copy the transcript to `target` through a temp file and a rename. A target
 * that already exists is replaced only when it is an earlier state of the same
 * file (a round trip A → B → A); one that holds turns the source lacks is
 * refused. The conversation's sibling folder (`<project>/<sessionId>/`, tool
 * results and subagents) is copied without overwriting anything. A target
 * folder or file that resolves to the source itself (a linked `projects/`) is
 * `same`: the rename would replace the original.
 */
export async function copyTranscript(source: string, target: string): Promise<'copied' | 'diverged' | 'same'> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const real = (p: string) => fs.realpathSync.native(p);
  if (real(path.dirname(target)) === real(path.dirname(source))) return 'same';
  if (fs.existsSync(target) && real(target) === real(source)) return 'same';
  if (fs.existsSync(target) && !(await isBytePrefix(target, source))) return 'diverged';
  const temp = `${target}.wmux-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.promises.copyFile(source, temp);
    await fs.promises.rename(temp, target);
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
  const siblingSource = source.slice(0, -'.jsonl'.length);
  if (fs.existsSync(siblingSource)) {
    await fs.promises.cp(siblingSource, target.slice(0, -'.jsonl'.length), { recursive: true, force: false, errorOnExist: false })
      .catch(() => undefined);
  }
  return 'copied';
}

/**
 * The line typed into the pane's shell: back to the conversation's folder,
 * then Claude on the account's config dir, resuming exactly `sessionId` in
 * its recorded permission mode. Submitted. Null when a value cannot be typed.
 */
export function relaunchLine(binding: ResumeBinding, configDir: string, shell: ResumeShell): string | null {
  if (!CHATV2_PROVIDER_SESSION_ID.test(binding.sessionId) || !binding.cwd || CONTROL.test(binding.cwd)) return null;
  const agent = ['claude', '--resume', binding.sessionId, permissionFlagFor(binding.permissionMode)].filter(Boolean).join(' ');
  let pinned: string;
  try {
    pinned = withChosenAccountEnv(agent, { env: { CLAUDE_CONFIG_DIR: configDir }, paneAccount: { vendor: 'claude' } }, 'claude', shell);
  } catch {
    return null;
  }
  if (pinned === agent) return null;
  return `${inResumeCwd(binding.cwd, pinned, shell)}\r`;
}

/** The keys a pane had received when it was read. */
export interface PaneKeyMark {
  /** A key reached the pane since the mark. */
  typedSince: () => boolean;
  /** After a proven stop: the keys up to the mark went to the program that
   *  stopped, not to the shell's line editor (DaemonPTYBridge.rebaseShellKeyInput). */
  rebase: () => void;
}

/** The parts of a daemon session the shell's prompt is read from. */
export interface ShellPane {
  promptLog: { readonly size: number; isCommandRunning(): boolean };
  bridge: Pick<DaemonPTYBridge, 'isEmptyShellPrompt' | 'getInputRevision' | 'getKeyInputRevision' | 'rebaseShellKeyInput'>;
}

/** `promptRevision` and `markKeys` over the daemon's sessions. */
export function paneShellDeps(session: (id: string) => ShellPane | undefined): Pick<ContinueOnAccountDeps, 'promptRevision' | 'markKeys'> {
  return {
    promptRevision: (id) => {
      const pane = session(id);
      if (!pane || pane.promptLog.size === 0 || pane.promptLog.isCommandRunning()) return null;
      return pane.bridge.isEmptyShellPrompt() ? pane.bridge.getInputRevision() : null;
    },
    markKeys: (id) => {
      const pane = session(id);
      if (!pane) return undefined;
      const mark = pane.bridge.getKeyInputRevision();
      // Only the same session: a pane that closed meanwhile is not rebased.
      return {
        typedSince: () => session(id) === pane && pane.bridge.getKeyInputRevision() !== mark,
        rebase: () => { if (session(id) === pane) pane.bridge.rebaseShellKeyInput(mark); },
      };
    },
  };
}

export interface ContinueOnAccountPane {
  resumeBinding?: ResumeBinding;
  exec?: unknown;
  wslTarget?: unknown;
  env?: Readonly<Record<string, string>>;
}

/** What a WSL pane's continue needs besides the common deps. */
export interface ContinueOnAccountWslDeps {
  /** The pane's Claude was attributed from its own hook, so it can be stopped inside the distro. */
  agentTracked: (id: string) => boolean;
  /** The source transcript is an existing regular file on the distro share (proveWslTranscriptPath). */
  sourceReady: (id: string, binding: ResumeBinding) => Promise<boolean>;
  /** The copy inside the distro (wslAccountCopy.ts); never boots it. */
  copy: (id: string, req: { configDir: string; plan: WslCopyPlan; sessionId: string }) => Promise<WslAccountCopyOutcome>;
}

export interface ContinueOnAccountDeps {
  pane: (id: string) => ContinueOnAccountPane | undefined;
  /** The live agent's slug, or undefined when none runs. */
  liveAgent: (id: string) => string | undefined;
  /** The pane's turn is over by the daemon's own state. */
  turnClosed: (id: string) => boolean;
  shellKind: (id: string) => ResumeShell | null;
  /** Stop the pane's Claude tree; `stillIdle` is asked right before the first signal. */
  stopClaude: (id: string, stillIdle: () => boolean) => Promise<AgentStopResult>;
  /** The shell runs nothing (no agent, no children). */
  paneFree: (id: string) => Promise<boolean>;
  /** The shell's input revision while it sits at an empty prompt, else null. */
  promptRevision: (id: string) => number | null;
  /** Read right before the stop (see `paneShellDeps`). */
  markKeys: (id: string) => PaneKeyMark | undefined;
  /** Bind the pane to `configDir` with `binding` (now at the copy), persisted; the undo, or null when it could not be saved (nothing changed). */
  rebind: (id: string, configDir: string, binding: ResumeBinding) => (() => void) | null;
  write: (id: string, data: string) => boolean;
  copy?: typeof copyTranscript;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for the shell's prompt once the agent stopped. */
  promptWaitMs?: number;
  /** A chat-v2 record owns the pane, or a move into chat holds it. */
  chatOwnsPane?: (id: string) => boolean;
  /** The pane is on an agent's folder-trust prompt: a person's move, so
   *  only a prompt seen on screen stops it. Asked before the stop. */
  atFolderTrust?: (id: string) => Promise<boolean>;
  /** Absent: a WSL pane is refused as `unsupported`. */
  wsl?: ContinueOnAccountWslDeps;
}

/**
 * `copyOnly`: the target account or the pane signs in with a vault value (a
 * token), which reaches a process only at spawn and is never typed. So only
 * the copy is made (step 3,
 * after the same checks); the source pane is left as is, and main opens a new
 * pane that resumes the conversation. Nothing is stopped, rebound or typed.
 */
export async function continueOnAccount(
  deps: ContinueOnAccountDeps,
  id: string,
  configDir: string,
  opts: { copyOnly?: boolean } = {},
): Promise<ContinueOnAccountResult> {
  // One move per pane, shared with the chat ↔ terminal handoffs.
  if (!beginPaneMove(id)) return { ok: false, code: 'busy' };
  try {
    if (deps.chatOwnsPane?.(id)) return { ok: false, code: 'busy' };
    return await run(deps, id, configDir, opts.copyOnly === true);
  } finally {
    endPaneMove(id);
  }
}

async function run(deps: ContinueOnAccountDeps, id: string, configDir: string, copyOnly: boolean): Promise<ContinueOnAccountResult> {
  const pane = deps.pane(id);
  if (!pane) return { ok: false, code: 'no_session' };
  if (pane.exec) return { ok: false, code: 'unsupported' };
  if (pane.wslTarget) return runWsl(deps, id, pane, configDir, copyOnly);
  // A copy types nothing into this pane, so its shell does not matter.
  const shell = copyOnly ? null : deps.shellKind(id);
  if (!copyOnly && !shell) return { ok: false, code: 'unsupported' };
  const live = deps.liveAgent(id);
  if (live !== undefined && !agentRow(live)?.continueOnAccount) return { ok: false, code: 'not_claude' };
  const binding = pane.resumeBinding;
  const plan = planTranscriptCopy(binding, configDir);
  if (!plan.ok || !binding) return { ok: false, code: plan.ok ? 'unknown_session' : plan.code };
  let line = '';
  if (copyOnly) {
    // The new pane starts in this folder.
    if (!binding.cwd || !path.isAbsolute(binding.cwd) || CONTROL.test(binding.cwd)) return { ok: false, code: 'unknown_session' };
  } else {
    const typed = shell ? relaunchLine(binding, configDir, shell) : null;
    // The id and folder passed their checks above, so an untypeable line is the account folder's.
    if (!typed) return { ok: false, code: 'invalid_account' };
    line = typed;
  }
  if (!fs.existsSync(plan.source)) return { ok: false, code: 'unknown_session' };
  try {
    if (!fs.statSync(configDir).isDirectory()) return { ok: false, code: 'invalid_account' };
  } catch {
    return { ok: false, code: 'invalid_account' };
  }
  if (!deps.turnClosed(id)) return { ok: false, code: 'turn_open' };
  // A folder-trust prompt in the pane is the person's to answer: refused
  // before anything is stopped or copied.
  if (await deps.atFolderTrust?.(id)) return { ok: false, code: 'folder_trust' };

  if (copyOnly) {
    // Claude keeps running in the source pane; a closed turn means it is not
    // writing the transcript now.
    try {
      const copied = await (deps.copy ?? copyTranscript)(plan.source, plan.target);
      if (copied === 'diverged') return { ok: false, code: 'diverged' };
      if (copied === 'same') return { ok: false, code: 'same_account' };
    } catch {
      return { ok: false, code: 'copy_failed' };
    }
    return {
      ok: true,
      sessionId: binding.sessionId,
      transcriptPath: plan.target,
      cwd: binding.cwd,
      ...(binding.permissionMode ? { permissionMode: binding.permissionMode } : {}),
    };
  }

  return stopCopyRelaunch(deps, id, configDir, {
    binding,
    line,
    transcriptPath: plan.target,
    rebound: { ...binding, transcriptPath: plan.target },
    copy: () => (deps.copy ?? copyTranscript)(plan.source, plan.target),
  });
}

/**
 * A WSL pane: the same steps, inside its distro. The source is the pane's
 * Linux transcript (planWslTranscriptCopy), Claude is the one its own hook
 * reported (stopped inside the distro), the copy runs there as the pane's
 * user (wslAccountCopy.ts), and the line typed into its bash names the
 * account's home in the distro. Copy-only (a vault sign-in) is refused for
 * now: the new pane would start as the distro's default user, not the
 * source pane's.
 */
async function runWsl(
  deps: ContinueOnAccountDeps,
  id: string,
  pane: ContinueOnAccountPane,
  configDir: string,
  copyOnly: boolean,
): Promise<ContinueOnAccountResult> {
  const wsl = deps.wsl;
  if (!wsl || copyOnly) return { ok: false, code: 'unsupported' };
  const live = deps.liveAgent(id);
  if (live !== undefined && !agentRow(live)?.continueOnAccount) return { ok: false, code: 'not_claude' };
  // A Claude its hook never reported cannot be stopped from here.
  if (live !== undefined && !wsl.agentTracked(id)) return { ok: false, code: 'unsupported' };
  const binding = pane.resumeBinding;
  const planned = planWslTranscriptCopy(binding, pane, configDir);
  if (!planned.ok || !binding) return { ok: false, code: planned.ok ? 'unknown_session' : planned.code };
  const { plan } = planned;
  if (!isLinuxCwd(binding.cwd) || !binding.cwd.startsWith('/')) return { ok: false, code: 'unknown_session' };
  const line = relaunchLine(binding, plan.home, 'posix');
  if (!line) return { ok: false, code: 'invalid_account' };
  if (!(await wsl.sourceReady(id, binding))) return { ok: false, code: 'unknown_session' };
  if (!deps.turnClosed(id)) return { ok: false, code: 'turn_open' };
  if (await deps.atFolderTrust?.(id)) return { ok: false, code: 'folder_trust' };
  return stopCopyRelaunch(deps, id, configDir, {
    binding,
    line,
    transcriptPath: plan.target,
    // Only the Linux path: a binding's transcriptPath is always one this process can open.
    rebound: { ...binding, wslTranscriptPath: plan.target },
    copy: async () => {
      const out = await wsl.copy(id, { configDir, plan, sessionId: binding.sessionId });
      if (out.result === 'failed') throw new Error(out.reason);
      // The typed line names the home by /home/<user>, the script by $HOME: a
      // copy anywhere else is not the one the line would resume.
      if (out.result === 'copied' && out.home !== plan.home) throw new Error('the copy went to another home');
      return out.result;
    },
  });
}

/**
 * The steps after the checks, for both kinds of pane: stop Claude, copy,
 * wait for the shell's empty prompt, rebind, type `line`.
 */
async function stopCopyRelaunch(
  deps: ContinueOnAccountDeps,
  id: string,
  configDir: string,
  step: {
    binding: ResumeBinding;
    line: string;
    transcriptPath: string;
    /** The pane's binding once the copy exists. */
    rebound: ResumeBinding;
    copy: () => Promise<'copied' | 'diverged' | 'same'>;
  },
): Promise<ContinueOnAccountResult> {
  const { binding, line } = step;
  // Stop first: Claude may still write to the transcript as it exits. The
  // turn is checked again right before the first signal.
  const keys = deps.markKeys(id);
  const stop = await deps.stopClaude(id, () => deps.turnClosed(id));
  if (!stop.ok) return { ok: false, code: stop.code === 'turn_open' ? 'turn_open' : 'still_running' };
  // The keys typed so far went to the Claude just stopped, not to the shell,
  // so the prompt it leaves can read empty (#3437). A key after the mark
  // still counts as typed at the prompt.
  if (stop.stopped) keys?.rebase();
  // Still the same conversation: a hook may have rebound the pane meanwhile.
  const stillOwn = () => deps.pane(id)?.resumeBinding?.sessionId === binding.sessionId;
  if (!stillOwn()) return { ok: false, code: 'unknown_session' };

  try {
    const copied = await step.copy();
    if (copied === 'diverged') return { ok: false, code: 'diverged' };
    if (copied === 'same') return { ok: false, code: 'same_account' };
  } catch {
    return { ok: false, code: 'copy_failed' };
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  // A deadline, not a count of polls: paneFree reads the process table, which
  // takes about a second on Windows, so fifty polls of a busy pane took ~57 s.
  // The prompt costs nothing to read, so the pane is checked only once the
  // shell shows one.
  const deadline = now() + (deps.promptWaitMs ?? 5_000);
  // From here the copy exists: a failure says why and how to resume it by hand.
  const blocked = (code: ContinueOnAccountCode): ContinueOnAccountResult => ({
    ok: false,
    code: code === 'shell_busy' && keys?.typedSince() ? 'shell_typed' : code,
    resumeCommand: line.replace(/\r$/, ''),
  });
  let revision: number | null = null;
  let running = false;
  for (;;) {
    // Any key after the mark is the person's: even one submitted and run to
    // an empty prompt again, so the pane is no longer wmux's to type into.
    if (keys?.typedSince()) return blocked('shell_typed');
    const atPrompt = deps.promptRevision(id) !== null;
    running = atPrompt && !(await deps.paneFree(id));
    revision = atPrompt && !running && !keys?.typedSince() ? deps.promptRevision(id) : null;
    if (revision !== null || now() >= deadline) break;
    await sleep(100);
  }
  if (revision === null) return blocked(running ? 'shell_running' : 'shell_busy');
  if (!stillOwn()) return blocked('unknown_session');

  // Bound before the line is typed: the new process's first hook is checked
  // against the pane's account folder. A rebind that could not be persisted
  // is undone and nothing is typed.
  const undo = deps.rebind(id, configDir, step.rebound);
  if (!undo) return blocked('save_failed');
  let typed = false;
  try {
    typed = !keys?.typedSince() && deps.promptRevision(id) === revision && deps.write(id, line);
  } catch {
    typed = false;
  }
  if (!typed) {
    undo();
    return blocked('shell_busy');
  }
  return { ok: true, sessionId: binding.sessionId, transcriptPath: step.transcriptPath };
}
