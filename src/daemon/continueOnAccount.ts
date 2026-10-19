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
// write is rolled back.

import fs from 'node:fs';
import path from 'node:path';
import { CHATV2_PROVIDER_SESSION_ID } from '../shared/chatv2/ipc';
import { permissionFlagFor, type ResumeBinding } from '../shared/agentResume';
import { agentRow } from '../shared/agentIdentity';
import { inResumeCwd, type ResumeShell } from './chat/v2/handoff';
import { withChosenAccountEnv } from './phone/paneAccountSpawn';
import type { AgentStopResult } from './agentStop';

export type ContinueOnAccountCode =
  | 'no_session'
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
  | 'shell_busy';

export type ContinueOnAccountResult =
  | { ok: true; sessionId: string; transcriptPath: string }
  | { ok: false; code: ContinueOnAccountCode };

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

/** Whether `prefix`'s bytes start `file`'s. */
async function isBytePrefix(prefix: string, file: string): Promise<boolean> {
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

export interface ContinueOnAccountPane {
  resumeBinding?: ResumeBinding;
  exec?: unknown;
  wslTarget?: unknown;
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
  /** Bind the pane to `configDir` with `binding` (now at the copy), persisted; the undo, or null when it could not be saved (nothing changed). */
  rebind: (id: string, configDir: string, binding: ResumeBinding) => (() => void) | null;
  write: (id: string, data: string) => boolean;
  copy?: typeof copyTranscript;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the shell's prompt once the agent stopped. */
  promptWaitMs?: number;
}

const inFlight = new Set<string>();

export async function continueOnAccount(deps: ContinueOnAccountDeps, id: string, configDir: string): Promise<ContinueOnAccountResult> {
  if (inFlight.has(id)) return { ok: false, code: 'busy' };
  inFlight.add(id);
  try {
    return await run(deps, id, configDir);
  } finally {
    inFlight.delete(id);
  }
}

async function run(deps: ContinueOnAccountDeps, id: string, configDir: string): Promise<ContinueOnAccountResult> {
  const pane = deps.pane(id);
  if (!pane) return { ok: false, code: 'no_session' };
  if (pane.exec || pane.wslTarget) return { ok: false, code: 'unsupported' };
  const shell = deps.shellKind(id);
  if (!shell) return { ok: false, code: 'unsupported' };
  const live = deps.liveAgent(id);
  if (live !== undefined && !agentRow(live)?.continueOnAccount) return { ok: false, code: 'not_claude' };
  const binding = pane.resumeBinding;
  const plan = planTranscriptCopy(binding, configDir);
  if (!plan.ok || !binding) return { ok: false, code: plan.ok ? 'unknown_session' : plan.code };
  const line = relaunchLine(binding, configDir, shell);
  // The id and folder passed their checks above, so an untypeable line is the account folder's.
  if (!line) return { ok: false, code: 'invalid_account' };
  if (!fs.existsSync(plan.source)) return { ok: false, code: 'unknown_session' };
  try {
    if (!fs.statSync(configDir).isDirectory()) return { ok: false, code: 'invalid_account' };
  } catch {
    return { ok: false, code: 'invalid_account' };
  }
  if (!deps.turnClosed(id)) return { ok: false, code: 'turn_open' };

  // Stop first: Claude may still write to the transcript as it exits. The
  // turn is checked again right before the first signal.
  const stop = await deps.stopClaude(id, () => deps.turnClosed(id));
  if (!stop.ok) return { ok: false, code: stop.code === 'turn_open' ? 'turn_open' : 'still_running' };
  // Still the same conversation: a hook may have rebound the pane meanwhile.
  const stillOwn = () => deps.pane(id)?.resumeBinding?.sessionId === binding.sessionId;
  if (!stillOwn()) return { ok: false, code: 'unknown_session' };

  try {
    const copied = await (deps.copy ?? copyTranscript)(plan.source, plan.target);
    if (copied === 'diverged') return { ok: false, code: 'diverged' };
    if (copied === 'same') return { ok: false, code: 'same_account' };
  } catch {
    return { ok: false, code: 'copy_failed' };
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = deps.promptWaitMs ?? 5_000;
  let revision: number | null = null;
  for (let waited = 0; ; waited += 100) {
    revision = (await deps.paneFree(id)) ? deps.promptRevision(id) : null;
    if (revision !== null || waited >= waitMs) break;
    await sleep(100);
  }
  if (revision === null) return { ok: false, code: 'shell_busy' };
  if (!stillOwn()) return { ok: false, code: 'unknown_session' };

  // Bound before the line is typed: the new process's first hook is checked
  // against the pane's account folder. A rebind that could not be persisted
  // is undone and nothing is typed.
  const undo = deps.rebind(id, configDir, { ...binding, transcriptPath: plan.target });
  if (!undo) return { ok: false, code: 'save_failed' };
  let typed = false;
  try {
    typed = deps.promptRevision(id) === revision && deps.write(id, line);
  } catch {
    typed = false;
  }
  if (!typed) {
    undo();
    return { ok: false, code: 'shell_busy' };
  }
  return { ok: true, sessionId: binding.sessionId, transcriptPath: plan.target };
}
