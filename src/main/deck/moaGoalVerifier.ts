// Moa goal verifier — what `completed` has to show.
//
// MoaGoalService.end('moa', 'completed') used to take a summary and nothing
// else: a memo was enough to call a goal done. This module is the gate that
// replaces the memo. A goal Moa calls done must show, at the moment it says so:
//
//   1. GATES — every fan-out task the contract created ran the project's own
//      gate (TaskGateRunner: scripts/verify.sh, the trusted wmux.json `verify`
//      command, or npm lint + test) in its worktree, to a verdict of exit 0.
//      A project with no gate at all FAILS here (a skip is not a pass for a
//      goal, whatever it means for a plain task), and so does every other skip,
//      a busy gate, a refused gate and a task whose worktree is gone.
//   2. CRITERIA — each of the contract's done criteria is backed by at least
//      one artifact Moa names (a log, a test result file, a screenshot): an
//      existing, non-empty regular file inside a task worktree, the goal's
//      repository or the goal's evidence folder. It is hashed, not trusted.
//   3. BINDING — everything is pinned to the commit it proved: each gate
//      record carries the worktree's HEAD sha read before the gate ran, and the
//      head is read again afterwards; a head that moved under the gate fails.
//
// The verifier writes the gate logs it saw into the evidence folder and
// returns the record the service stores on the contract. It never edits a
// task, a branch or the ledger beyond the gate verdict the runner itself writes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GateRunInput, GateRunResult } from '../worktask/TaskGateRunner';
import type { GateOutcome } from './moaGoalLearning';
import {
  goalTermsOf,
  type MoaGoalContract,
  type MoaGoalVerification,
  type MoaGoalVerificationArtifact,
  type MoaGoalVerificationGate,
} from '../../shared/moaGoal';

/** The largest artifact the verifier will hash (bytes). */
export const GOAL_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;
/** Artifacts per criterion. */
export const GOAL_ARTIFACTS_PER_CRITERION_MAX = 8;

/** A task the contract created, as the verifier needs it. */
export interface GoalTaskRef {
  taskId: string;
  workspaceId: string;
  /** Absent when the task has no worktree on disk any more. */
  worktreePath?: string;
}

/** What Moa claims for one done criterion: the 1-based criterion number and
 *  the files that prove it. */
export interface GoalCriterionClaim {
  criterion: number;
  artifacts: string[];
}

export interface MoaGoalVerifierPorts {
  /** The contract's fan-out tasks; null when the task list cannot be read. */
  tasks: (contract: MoaGoalContract) => Promise<GoalTaskRef[] | null>;
  /** TaskGateRunner.run, or a stand-in in tests. */
  runGate: (input: GateRunInput) => Promise<GateRunResult>;
  /** `git rev-parse HEAD` in the worktree; null when it cannot be read. */
  headSha: (worktreePath: string) => Promise<string | null>;
  /** Where the goal's evidence is kept (created on demand). */
  evidenceDir: (goalId: string) => string;
  systemWorkspaceId?: string;
  now?: () => number;
  /** fs seams for tests. */
  stat?: (p: string) => fs.Stats | null;
  realpath?: (p: string) => string | null;
  readFile?: (p: string) => Buffer;
  writeFile?: (p: string, data: string) => void;
  /** Learning loop (moaGoalLearning.ts): a failed gate is run once more; a
   *  pass on the retry is a flake. Each real failure and each flake is
   *  reported here. Absent ⇒ no retry, nothing reported. */
  onGateOutcome?: (o: GateOutcome) => void;
}

export type MoaGoalVerifyResult =
  | { ok: true; verification: MoaGoalVerification }
  | { ok: false; code: 'unverified'; problems: string[] };

function defaultStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function defaultRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function defaultWriteFile(p: string, data: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data, 'utf8');
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** `child` is `root` or inside it (both already resolved). */
function within(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Parse the claims Moa sent. Shape errors are problems, never silently dropped. */
export function parseCriterionClaims(raw: unknown): GoalCriterionClaim[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: 'criteria must be a list of {criterion, artifacts}' };
  const out: GoalCriterionClaim[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'each criteria entry must be {criterion, artifacts}' };
    const rec = item as Record<string, unknown>;
    const n = rec.criterion;
    const a = rec.artifacts;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return { error: 'criterion must be the 1-based criterion number' };
    if (!Array.isArray(a) || a.length === 0 || a.length > GOAL_ARTIFACTS_PER_CRITERION_MAX || a.some((x) => typeof x !== 'string' || !x.trim())) {
      return { error: `criterion ${n}: artifacts must be 1-${GOAL_ARTIFACTS_PER_CRITERION_MAX} file paths` };
    }
    out.push({ criterion: n, artifacts: (a as string[]).map((x) => x.trim()) });
  }
  return out;
}

/**
 * Verify an open goal for completion. Every gate runs (even after a failure)
 * so the problems list is the whole picture, not the first miss.
 */
export async function verifyGoal(
  contract: MoaGoalContract,
  claims: readonly GoalCriterionClaim[],
  ports: MoaGoalVerifierPorts,
): Promise<MoaGoalVerifyResult> {
  const now = ports.now ?? Date.now;
  const stat = ports.stat ?? defaultStat;
  const realpath = ports.realpath ?? defaultRealpath;
  const readFile = ports.readFile ?? ((p: string) => fs.readFileSync(p));
  const writeFile = ports.writeFile ?? defaultWriteFile;
  const systemWorkspaceId = ports.systemWorkspaceId ?? 'ws-daemon';
  const problems: string[] = [];
  const evidenceDir = ports.evidenceDir(contract.id);

  // ── 1. gates ────────────────────────────────────────────────────────────
  const gates: MoaGoalVerificationGate[] = [];
  const roots: string[] = [];
  if (contract.taskWorkspaceIds.length === 0) {
    problems.push('the goal created no fan-out task, so there is no gate run to prove it; fan out the work (or ask the operator to end the goal)');
  }
  const tasks = contract.taskWorkspaceIds.length ? await ports.tasks(contract) : [];
  if (tasks === null) {
    problems.push('the goal\'s tasks could not be listed, so none of their gates could run');
  } else {
    for (const ws of contract.taskWorkspaceIds) {
      const t = tasks.find((x) => x.workspaceId === ws);
      if (!t) {
        problems.push(`task workspace ${ws}: no task found for it`);
        continue;
      }
      if (!t.worktreePath || !stat(t.worktreePath)?.isDirectory()) {
        problems.push(`task ${t.taskId}: its worktree is not on disk, so its gate cannot run`);
        continue;
      }
      const wt = realpath(t.worktreePath) ?? t.worktreePath;
      roots.push(wt);
      const before = await ports.headSha(wt);
      if (!before) {
        problems.push(`task ${t.taskId}: the worktree's HEAD could not be read`);
        continue;
      }
      let res: GateRunResult;
      try {
        res = await ports.runGate({
          taskId: t.taskId,
          worktreePath: wt,
          systemWorkspaceId,
          ...(contract.repoRoot ? { projectRoot: contract.repoRoot } : {}),
        });
      } catch (err) {
        problems.push(`task ${t.taskId}: the gate could not start (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      if (!res.ok) {
        problems.push(res.status === 'busy'
          ? `task ${t.taskId}: a gate is already running for it; wait for it and complete again`
          : `task ${t.taskId}: the gate was refused (${res.error})`);
        continue;
      }
      if (res.status === 'skipped') {
        problems.push(res.skipped === 'no_gate_command'
          ? `task ${t.taskId}: the project declares no test command (no scripts/verify.sh, no npm lint/test), and a goal needs one; add a test that proves the goal`
          : `task ${t.taskId}: the gate did not run (${res.skipped}: ${res.detail})`);
        continue;
      }
      let after = await ports.headSha(wt);
      let flakyRetry = false;
      if (ports.onGateOutcome && res.result.exitCode !== 0 && res.result.command !== 'none' && after === before) {
        // One retry tells a flaky test from a real failure.
        const first = res.result;
        const retry = await ports.runGate({
          taskId: t.taskId,
          worktreePath: wt,
          systemWorkspaceId,
          ...(contract.repoRoot ? { projectRoot: contract.repoRoot } : {}),
        }).catch(() => null);
        after = await ports.headSha(wt);
        const flaky = !!retry && retry.ok && retry.status !== 'skipped' && retry.result.exitCode === 0 && after === before;
        try {
          ports.onGateOutcome({ kind: flaky ? 'flake' : 'failure', goalId: contract.id, repoRoot: contract.repoRoot, taskId: t.taskId, command: first.command, tail: first.tail, at: now() });
        } catch {
          /* learning never breaks verification */
        }
        if (flaky && retry && retry.ok) {
          res = retry;
          flakyRetry = true;
        }
      }
      const log = `# goal ${contract.id} task ${t.taskId}\n# head ${before}\n# command ${res.result.command}\n# exit ${String(res.result.exitCode)}\n\n${res.result.tail}\n`;
      const logPath = path.join(evidenceDir, `${t.taskId}-${before.slice(0, 12)}.log`);
      let logSha256 = sha256(log);
      try {
        writeFile(logPath, log);
      } catch (err) {
        problems.push(`task ${t.taskId}: the gate log could not be saved (${err instanceof Error ? err.message : String(err)})`);
        logSha256 = '';
      }
      const gate: MoaGoalVerificationGate = {
        taskId: t.taskId,
        workspaceId: ws,
        headSha: before,
        command: res.result.command,
        exitCode: res.result.exitCode,
        at: res.result.at,
        logPath,
        logSha256,
        ...(flakyRetry ? { flaky: true as const } : {}),
      };
      gates.push(gate);
      if (res.result.skipped === 'no_gate_command' || res.result.command === 'none') {
        problems.push(`task ${t.taskId}: the project declares no test command, and a goal needs one`);
      } else if (res.result.exitCode !== 0) {
        problems.push(`task ${t.taskId}: the gate failed (${res.result.command}, exit ${String(res.result.exitCode)}); see ${logPath}`);
      }
      if (after !== before) {
        problems.push(`task ${t.taskId}: HEAD moved while the gate ran (${before.slice(0, 12)} → ${after ? after.slice(0, 12) : 'unknown'}); complete again once the branch is still`);
      }
    }
  }

  // ── 2. criteria ─────────────────────────────────────────────────────────
  const { doneCriteria } = goalTermsOf(contract);
  const repo = contract.repoRoot ? realpath(contract.repoRoot) ?? contract.repoRoot : null;
  const allowed = [...roots, ...(repo ? [repo] : []), realpath(evidenceDir) ?? path.resolve(evidenceDir)];
  const criteria: MoaGoalVerification['criteria'] = [];
  for (const c of claims) {
    if (c.criterion > doneCriteria.length) problems.push(`criterion ${c.criterion}: the goal has ${doneCriteria.length} done criteria`);
  }
  for (let i = 0; i < doneCriteria.length; i++) {
    const n = i + 1;
    const mine = claims.filter((c) => c.criterion === n).flatMap((c) => c.artifacts);
    if (mine.length === 0) {
      problems.push(`criterion ${n} ("${doneCriteria[i]}"): no evidence named; pass the log, test result or screenshot that proves it`);
      continue;
    }
    const artifacts: MoaGoalVerificationArtifact[] = [];
    for (const raw of mine) {
      const real = path.isAbsolute(raw) ? realpath(raw) : null;
      if (!real) {
        problems.push(`criterion ${n}: ${raw} is not an existing absolute path`);
        continue;
      }
      if (!allowed.some((r) => within(r, real))) {
        problems.push(`criterion ${n}: ${raw} is outside the goal's worktrees, repository and evidence folder`);
        continue;
      }
      const st = stat(real);
      if (!st?.isFile() || st.size === 0) {
        problems.push(`criterion ${n}: ${raw} is not a non-empty file`);
        continue;
      }
      if (st.size > GOAL_ARTIFACT_MAX_BYTES) {
        problems.push(`criterion ${n}: ${raw} is larger than ${GOAL_ARTIFACT_MAX_BYTES} bytes`);
        continue;
      }
      let hash: string;
      try {
        hash = sha256(readFile(real));
      } catch {
        problems.push(`criterion ${n}: ${raw} could not be read`);
        continue;
      }
      artifacts.push({ path: real, sha256: hash, bytes: st.size });
    }
    criteria.push({ criterion: n, text: doneCriteria[i], artifacts });
  }

  if (problems.length > 0) return { ok: false, code: 'unverified', problems };
  return { ok: true, verification: { at: now(), gates, criteria } };
}
