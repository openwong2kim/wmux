// ─── Which live sessions are goal workers wmux itself started ───────────────
//
// Under an active goal Moa may type into the goal's fan-out task panes. That is
// safe only while the pane's CURRENT session is the one the goal fan-out
// spawned: its environment carries the goal worker profile (no credentials,
// disabled push URL) and its launch line carries the deny rules. A pane whose
// shell died and was recreated (the dead-session path), a split, or any other
// plain shell in a task workspace has neither. The 2026-10-10 dogfood: a goal
// pane's shell died during a renderer OOM crash, came back plain, and Moa
// typed `claude "…"` into it; that agent's `git push` reached the remote.
//
// main records a session here at create time, from the env it resolved and
// handed the daemon and the launch line it typed (pty.handler), never from
// anything the pane or Moa reports. A session leaves on death, and the whole
// record goes when main loses its daemon connection: a daemon-recovered shell
// is a new process with no agent running in it. An app restart starts empty.
// Every gap fails closed: Moa loses write access, the operator does not.

import {
  GOAL_WORKER_PUSH_URL,
  GOAL_WORKER_TOKEN_PLACEHOLDER,
  goalWorkerDenyRules,
} from '../../shared/moaGoalWorker';

const sessions = new Set<string>();

/** True when this env and launch line are the goal worker profile. Pure. */
export function isGoalWorkerSpawn(
  env: Readonly<Record<string, string | undefined>> | undefined,
  initialCommand: string | undefined,
): boolean {
  if (!env || typeof initialCommand !== 'string' || initialCommand.length === 0) return false;
  const profiled =
    env.GIT_CONFIG_KEY_0 === 'credential.helper' &&
    env.GIT_CONFIG_VALUE_0 === '' &&
    env.GIT_CONFIG_KEY_1 === 'remote.origin.pushurl' &&
    env.GIT_CONFIG_VALUE_1 === GOAL_WORKER_PUSH_URL &&
    env.GH_TOKEN === GOAL_WORKER_TOKEN_PLACEHOLDER &&
    env.GITHUB_TOKEN === GOAL_WORKER_TOKEN_PLACEHOLDER;
  return profiled && goalWorkerDenyRules().every((rule) => initialCommand.includes(rule));
}

/** pty.handler, after the daemon created the session: record a goal worker spawn. */
export function noteGoalWorkerSpawn(
  sessionId: string,
  args: { env: Readonly<Record<string, string | undefined>> | undefined; initialCommand: string | undefined; fanoutTaskOf: string | undefined },
): void {
  if (args.fanoutTaskOf && isGoalWorkerSpawn(args.env, args.initialCommand)) sessions.add(sessionId);
  else sessions.delete(sessionId);
}

export function isGoalWorkerSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function forgetGoalWorkerSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function clearGoalWorkerSessions(): void {
  sessions.clear();
}
