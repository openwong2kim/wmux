// Moa goal delivery — what happens after the evidence gate passes.
//
// The operator's direction for goals is freedom, not surveillance: once a goal
// is PROVED done (moaGoalVerifier.ts), Moa delivers it itself instead of
// handing the push and the PR back. For every task the verifier passed:
//
//   1. push the task branch (`wtask/…`) to `origin` — exactly the commit the
//      gate verified, as a plain fast-forward push. Never force, never a branch
//      outside `wtask/`, never the base branch;
//   2. open a pull request for it against the repository's default branch,
//      whose body carries the done criteria, the gate verdict and the evidence;
//   3. record the delivery and a revert recipe on the contract.
//
// Merging is the operator's for now. The merge path exists — a one-hour
// objection window, then `gh pr merge --merge` (a merge commit, so history is
// kept and a revert is one command) — but it runs only when
// MOA_GOAL_AUTO_MERGE is on AND the goal is level 3; the flag is off for the
// two-week trial.
//
// Everything here runs in main with the operator's own git and gh, never in a
// goal worker. Each step's failure is recorded on its item and reported; a
// failed push or PR never undoes the goal's completion (the work is verified;
// only its delivery stopped short).

import {
  MOA_GOAL_AUTO_MERGE,
  MOA_GOAL_MERGE_OBJECTION_MS,
  goalTermsOf,
  type MoaGoalContract,
  type MoaGoalDelivery,
  type MoaGoalDeliveryItem,
  type MoaGoalVerification,
} from '../../shared/moaGoal';
import type { GoalTaskRef } from './moaGoalVerifier';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface MoaGoalDeliveryPorts {
  tasks: (contract: MoaGoalContract) => Promise<GoalTaskRef[] | null>;
  git: (args: string[], cwd: string) => Promise<ExecResult>;
  gh: (args: string[], cwd: string) => Promise<ExecResult>;
  now?: () => number;
  /** Tests only: the auto-merge flag (default MOA_GOAL_AUTO_MERGE). */
  autoMerge?: boolean;
}

/** Only fan-out task branches are ever pushed. */
export const DELIVERABLE_BRANCH_RE = /^wtask\/[A-Za-z0-9._/-]+$/;

/** Arguments that must never reach `git push` from here. */
function assertNoForce(args: readonly string[]): void {
  if (args.some((a) => /^(-f|--force|--force-with-lease.*|--mirror|--delete|-d|\+.*)$/.test(a) || a.startsWith('+'))) {
    throw new Error(`refusing a forced or destructive push: ${args.join(' ')}`);
  }
}

function firstLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
}

/** The PR number in a GitHub PR URL. */
export function prNumberOf(url: string): number | undefined {
  const m = /\/pull\/(\d+)\b/.exec(url);
  return m ? Number(m[1]) : undefined;
}

async function defaultBranch(repoRoot: string, ports: MoaGoalDeliveryPorts): Promise<string> {
  const head = await ports.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repoRoot);
  const name = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : '';
  if (name) return name;
  const cur = await ports.git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const b = cur.code === 0 ? cur.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : 'main';
}

/** The PR body: what was asked, what "done" meant, and the proof. */
export function prBody(contract: MoaGoalContract, verification: MoaGoalVerification, item: { taskId: string; headSha: string }): string {
  const { doneCriteria } = goalTermsOf(contract);
  const gate = verification.gates.find((g) => g.taskId === item.taskId);
  const lines = [
    `Delivered by Moa for goal **${contract.id}** (operator-approved): ${contract.goal}`,
    '',
    '### Done criteria',
    ...(doneCriteria.length
      ? doneCriteria.map((c, i) => {
        const v = verification.criteria.find((x) => x.criterion === i + 1);
        return `- ✅ (${i + 1}) ${c}${v?.artifacts.length ? ` — evidence: ${v.artifacts.map((a) => `\`${a.path}\` (sha256 ${a.sha256.slice(0, 12)})`).join(', ')}` : ''}`;
      })
      : ['- (none stated; the project gate below is the proof)']),
    '',
    '### Gate',
    gate
      ? `- \`${gate.command}\` exited ${String(gate.exitCode)} on \`${gate.headSha}\` (log sha256 ${gate.logSha256.slice(0, 12)})`
      : `- verified on \`${item.headSha}\``,
    '',
    '### Revert',
    '- Not merged: close this PR. Merged: `git revert -m 1 <merge commit>` (merge commits only; history is never rewritten).',
  ];
  return lines.join('\n');
}

/**
 * Push and open a PR for every verified task of a completed goal. Never
 * throws; every problem lands on its item.
 */
export async function deliverGoal(
  contract: MoaGoalContract,
  verification: MoaGoalVerification,
  ports: MoaGoalDeliveryPorts,
): Promise<MoaGoalDelivery> {
  const now = ports.now ?? Date.now;
  const autoMerge = (ports.autoMerge ?? MOA_GOAL_AUTO_MERGE) && contract.level === 3;
  const items: MoaGoalDeliveryItem[] = [];
  const repoRoot = contract.repoRoot;
  const tasks = (await ports.tasks(contract).catch(() => null)) ?? [];
  const base = repoRoot ? await defaultBranch(repoRoot, ports) : 'main';
  for (const gate of verification.gates) {
    const item: MoaGoalDeliveryItem = { taskId: gate.taskId, branch: '', headSha: gate.headSha, base, pushed: false };
    items.push(item);
    const task = tasks.find((t) => t.taskId === gate.taskId);
    if (!repoRoot || !task?.worktreePath) {
      item.error = 'the task worktree is gone, so its branch could not be pushed';
      continue;
    }
    const wt = task.worktreePath;
    const br = await ports.git(['rev-parse', '--abbrev-ref', 'HEAD'], wt);
    item.branch = br.code === 0 ? br.stdout.trim() : '';
    if (!DELIVERABLE_BRANCH_RE.test(item.branch) || item.branch === `wtask/${base}`) {
      item.error = `refusing to push ${item.branch || 'a detached HEAD'}: only wtask/ task branches are delivered`;
      continue;
    }
    const head = await ports.git(['rev-parse', 'HEAD'], wt);
    if (head.code !== 0 || head.stdout.trim() !== gate.headSha) {
      item.error = `the branch moved after verification (${head.stdout.trim().slice(0, 12) || 'unknown'} ≠ ${gate.headSha.slice(0, 12)}); complete the goal again`;
      continue;
    }
    // Exactly the verified commit, by sha, to the same-named branch: a plain
    // push that the remote rejects unless it is a fast-forward.
    const pushArgs = ['push', '--porcelain', 'origin', `${gate.headSha}:refs/heads/${item.branch}`];
    assertNoForce(pushArgs.slice(1));
    const push = await ports.git(pushArgs, wt);
    if (push.code !== 0) {
      item.error = `push failed: ${firstLine(push.stderr || push.stdout)}`;
      continue;
    }
    item.pushed = true;
    const title = `${contract.goal.slice(0, 200)} (Moa goal ${contract.id})`;
    const pr = await ports.gh(
      ['pr', 'create', '--head', item.branch, '--base', base, '--title', title, '--body', prBody(contract, verification, item)],
      repoRoot,
    );
    const url = firstLine(pr.stdout);
    if (pr.code !== 0 || !/^https?:\/\//.test(url)) {
      item.error = `pull request failed: ${firstLine(pr.stderr || pr.stdout)}`;
      continue;
    }
    item.prUrl = url;
    const n = prNumberOf(url);
    if (n !== undefined) item.prNumber = n;
    if (autoMerge) item.mergeAfter = now() + MOA_GOAL_MERGE_OBJECTION_MS;
  }
  return { at: now(), items, revertRecipe: revertRecipe(items) };
}

/** The steps that undo a delivery, as text for the record and the PR. */
export function revertRecipe(items: readonly MoaGoalDeliveryItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (!it.pushed) continue;
    if (it.prNumber !== undefined && !it.merged) out.push(`gh pr close ${it.prNumber}  # ${it.branch}`);
    else if (it.merged) out.push(`git revert -m 1 <merge commit of PR #${it.prNumber ?? '?'}>  # then push a revert PR`);
    out.push(`git push origin --delete ${it.branch}  # optional: the branch stays for history by default`);
  }
  return out;
}

/**
 * The merge path, behind MOA_GOAL_AUTO_MERGE. Merges every item whose
 * objection window has passed with a merge commit. Returns the items, updated.
 */
export async function runDueMerges(
  contract: MoaGoalContract,
  delivery: MoaGoalDelivery,
  ports: MoaGoalDeliveryPorts,
): Promise<MoaGoalDelivery> {
  const now = (ports.now ?? Date.now)();
  if (!(ports.autoMerge ?? MOA_GOAL_AUTO_MERGE) || contract.level !== 3 || delivery.reverted || !contract.repoRoot) return delivery;
  const items = delivery.items.map((x) => ({ ...x }));
  for (const it of items) {
    if (it.merged || it.mergeAfter === undefined || it.mergeAfter > now || it.prNumber === undefined) continue;
    const r = await ports.gh(['pr', 'merge', String(it.prNumber), '--merge'], contract.repoRoot);
    if (r.code === 0) it.merged = true;
    else it.error = `merge failed: ${firstLine(r.stderr || r.stdout)}`;
  }
  return { ...delivery, items, revertRecipe: revertRecipe(items) };
}

/**
 * "Revert this goal": close every open PR the delivery opened (the branches
 * stay, so nothing is lost). A merged PR is not touched here; its revert
 * recipe is reported instead.
 */
export async function revertDelivery(
  contract: MoaGoalContract,
  delivery: MoaGoalDelivery,
  ports: MoaGoalDeliveryPorts,
  by: 'operator' | 'moa' = 'operator',
): Promise<{ ok: boolean; delivery: MoaGoalDelivery; notes: string[] }> {
  const notes: string[] = [];
  let ok = true;
  if (!contract.repoRoot) return { ok: false, delivery, notes: ['the goal names no repository'] };
  for (const it of delivery.items) {
    if (!it.pushed || it.prNumber === undefined) continue;
    if (it.merged) {
      ok = false;
      notes.push(`PR #${it.prNumber} is merged: revert it with git revert -m 1 <merge commit>`);
      continue;
    }
    const r = await ports.gh(['pr', 'close', String(it.prNumber), '--comment', `Reverted: Moa goal ${contract.id} was reverted by the ${by}.`], contract.repoRoot);
    if (r.code === 0) notes.push(`closed PR #${it.prNumber} (${it.branch} kept)`);
    else {
      ok = false;
      notes.push(`could not close PR #${it.prNumber}: ${firstLine(r.stderr || r.stdout)}`);
    }
  }
  const now = (ports.now ?? Date.now)();
  return { ok, delivery: ok ? { ...delivery, reverted: { at: now, by, notes } } : delivery, notes };
}
