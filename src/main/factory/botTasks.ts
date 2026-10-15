// ─── A bot's tasks with their stage (FactoryBotRow.tasks) ──────────────────
//
// The Bots page shows each bot's workers. Their stage (shared/botTask.ts) is
// derived here from what main holds itself:
//   - the task ledger row (status, the system-recorded gate);
//   - the task's branch, from the daemon's mission list (cached: a task's
//     branch never changes);
//   - the pull request opened from that branch on the bot's repository, from
//     repo-watch facts (pr.opened → its number; pr.merged / pr.closed after
//     it → its end). No GitHub call is made for this.
// A bot's newest tasks first, at most BOT_TASK_VIEW_MAX, while the ledger
// keeps them (open ones, and ended ones until the ledger prunes them); before
// them the bot's workers still waiting for an agent slot, and on an ended
// task whether its stopped worker can be resumed.

import type { Fact } from '../../shared/facts';
import type { LedgerEntry } from '../../shared/ledger';
import { BOT_TASK_SUMMARY_MAX, botTaskStage, type BotTaskPr, type BotTaskView } from '../../shared/botTask';
import { normalizeRepoKey } from '../../shared/repoKey';

export const BOT_TASK_VIEW_MAX = 20;

/** The PR facts of the log's window, indexed by repo and branch / number. */
export interface PrIndex {
  /** `<repoKey> <branch>` → the newest PR opened from that branch. */
  opened: Map<string, number>;
  /** `<repoKey>#<n>` → how the PR ended, when it did after it opened. */
  ended: Map<string, 'merged' | 'closed'>;
}

/** Index pr.opened / pr.merged / pr.closed facts (oldest first). Pure. */
export function indexPrFacts(facts: readonly Fact[]): PrIndex {
  const opened = new Map<string, number>();
  const ended = new Map<string, 'merged' | 'closed'>();
  for (const f of facts) {
    const repo = normalizeRepoKey(f.repoKey);
    const n = f.ref?.pr;
    if (!repo || typeof n !== 'number') continue;
    if (f.kind === 'pr.opened') {
      // A task's branch lives on the repository itself; a fork's PR with the
      // same branch name is not the task's.
      if (f.payload?.isCrossRepository !== false) continue;
      const branch = typeof f.payload?.headRefName === 'string' ? f.payload.headRefName : '';
      if (branch) opened.set(`${repo} ${branch}`, n);
      ended.delete(`${repo}#${n}`);
    } else if (f.kind === 'pr.merged' || f.kind === 'pr.closed') {
      ended.set(`${repo}#${n}`, f.kind === 'pr.merged' ? 'merged' : 'closed');
    }
  }
  return { opened, ended };
}

/** The PR from `branch` on `repoKey`, or null. Pure. */
export function prOfBranch(index: PrIndex, repoKey: string | null | undefined, branch: string | null | undefined): BotTaskPr | null {
  const repo = normalizeRepoKey(repoKey);
  if (!repo || !branch) return null;
  const n = index.opened.get(`${repo} ${branch}`);
  if (n === undefined) return null;
  return { number: n, state: index.ended.get(`${repo}#${n}`) ?? 'open' };
}

/** One task as the Bots page shows it. Pure. */
export function botTaskView(row: LedgerEntry, pr: BotTaskPr | null): BotTaskView | null {
  const botId = row.dispatch?.origin.kind === 'bot' ? row.dispatch.origin.botId : undefined;
  if (!botId) return null;
  const g = row.gate?.recordedBy === 'system' ? row.gate : undefined;
  const summary = typeof row.summary === 'string' ? row.summary.replace(/\s+/g, ' ').trim().slice(0, BOT_TASK_SUMMARY_MAX) : '';
  return {
    taskId: row.id,
    taskWorkspaceId: row.taskWorkspaceId,
    ownerWorkspaceId: row.ownerWorkspaceId,
    botId,
    title: row.title,
    status: row.status,
    stage: botTaskStage(row, pr),
    ...(row.dispatch?.preset ? { preset: row.dispatch.preset } : {}),
    ...(g ? { gate: { exitCode: g.exitCode, at: g.at, ...(g.skipped ? { skipped: g.skipped } : {}), ...(g.headSha ? { headSha: g.headSha } : {}) } } : {}),
    ...(pr ? { pr } : {}),
    ...(summary ? { summary } : {}),
    updatedAt: row.updatedAt,
  };
}

/** taskId → branch, read from the daemon's mission list of each owner. */
export class TaskBranchCache {
  private readonly known = new Map<string, string | null>();

  constructor(private readonly listMissions: (ownerWorkspaceId: string) => Promise<unknown>, private readonly max = 2000) {}

  /** The branches of `rows` (null: a detached checkout has none). One
   *  mission-list read per owner with a task whose branch is not known yet;
   *  only a branch that was found is kept. */
  async branches(rows: readonly LedgerEntry[]): Promise<Map<string, string | null>> {
    const missing = new Map<string, Set<string>>();
    for (const r of rows) {
      if (this.known.has(r.id)) continue;
      if (r.dispatch?.checkout?.detached) {
        this.remember(r.id, null);
        continue;
      }
      const set = missing.get(r.ownerWorkspaceId) ?? new Set<string>();
      set.add(r.id);
      missing.set(r.ownerWorkspaceId, set);
    }
    await Promise.all([...missing].map(async ([owner, ids]) => {
      let reply: unknown;
      try {
        reply = await this.listMissions(owner);
      } catch {
        return; // read again next time
      }
      const tasks = (reply as { ok?: unknown; tasks?: unknown } | null);
      if (!tasks || tasks.ok !== true || !Array.isArray(tasks.tasks)) return;
      for (const t of tasks.tasks as Array<Record<string, unknown>>) {
        if (!t || typeof t.id !== 'string' || !ids.has(t.id)) continue;
        if (typeof t.branch === 'string' && t.branch) this.remember(t.id, t.branch);
      }
    }));
    const out = new Map<string, string | null>();
    for (const r of rows) if (this.known.has(r.id)) out.set(r.id, this.known.get(r.id) ?? null);
    return out;
  }

  private remember(taskId: string, branch: string | null): void {
    this.known.set(taskId, branch);
    while (this.known.size > this.max) {
      const oldest = this.known.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.known.delete(oldest);
    }
  }
}

export interface BotTaskSources {
  /** Every ledger row. */
  rows: () => LedgerEntry[];
  /** The reclaimed worker of a task (workerReclaim.ts), or null. */
  workerState?: (taskId: string) => BotTaskView['worker'] | null;
  /** The workspace a reclaimed worker's pane was last in, or null. */
  workerWorkspace?: (taskId: string) => string | null;
  /** Whether the ended task's folder was kept for uncommitted changes. */
  folderKept?: (taskId: string) => boolean;
  /** Bot workers waiting for an agent slot (agentSlots.ts), oldest first. */
  waiting?: () => ReadonlyArray<{ taskId: string; title: string; botId: string; ownerWorkspaceId: string; since: number }>;
  branches: (rows: readonly LedgerEntry[]) => Promise<Map<string, string | null>>;
  /** The PR facts in the fact log's window, oldest first ([] when not running). */
  prFacts: () => readonly Fact[];
}

/** Each bot's tasks, newest first (≤ BOT_TASK_VIEW_MAX), for `bots`. */
export async function botTaskViews(
  bots: ReadonlyArray<{ id: string; repo?: { repoKey?: string } }>,
  sources: BotTaskSources,
): Promise<Map<string, BotTaskView[]>> {
  const out = new Map<string, BotTaskView[]>();
  if (bots.length === 0) return out;
  const want = new Set(bots.map((b) => b.id));
  let rows: LedgerEntry[] = [];
  try {
    rows = sources.rows();
  } catch {
    rows = [];
  }
  const byBot = new Map<string, LedgerEntry[]>();
  for (const r of rows) {
    const origin = r.dispatch?.origin;
    if (origin?.kind !== 'bot' || !origin.botId || !want.has(origin.botId)) continue;
    const list = byBot.get(origin.botId) ?? [];
    list.push(r);
    byBot.set(origin.botId, list);
  }
  const shown: LedgerEntry[] = [];
  for (const [botId, list] of byBot) {
    list.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    byBot.set(botId, list.slice(0, BOT_TASK_VIEW_MAX));
    shown.push(...(byBot.get(botId) ?? []));
  }
  if (shown.length === 0 && !sources.waiting) return out;
  let branches = new Map<string, string | null>();
  try {
    branches = await sources.branches(shown);
  } catch {
    branches = new Map();
  }
  let index: PrIndex;
  try {
    index = indexPrFacts(sources.prFacts());
  } catch {
    index = indexPrFacts([]);
  }
  let waiting: ReturnType<NonNullable<BotTaskSources['waiting']>> = [];
  try {
    waiting = sources.waiting?.() ?? [];
  } catch {
    waiting = [];
  }
  for (const b of bots) {
    const views: BotTaskView[] = waiting.filter((w) => w.botId === b.id).map((w) => ({
      taskId: w.taskId, taskWorkspaceId: '', ownerWorkspaceId: w.ownerWorkspaceId, botId: w.botId,
      title: w.title, status: 'working', stage: 'waiting_slot', updatedAt: w.since,
    }));
    for (const r of byBot.get(b.id) ?? []) {
      const v = botTaskView(r, prOfBranch(index, b.repo?.repoKey, branches.get(r.id)));
      let worker: BotTaskView['worker'] | null = null;
      let workerWorkspaceId: string | null = null;
      try {
        worker = sources.workerState?.(r.id) ?? null;
        workerWorkspaceId = worker ? sources.workerWorkspace?.(r.id) ?? null : null;
      } catch {
        worker = null;
      }
      let kept = false;
      try {
        kept = sources.folderKept?.(r.id) === true;
      } catch {
        kept = false;
      }
      if (v) views.push({ ...v, ...(worker ? { worker, ...(workerWorkspaceId ? { workerWorkspaceId } : {}) } : {}), ...(kept ? { folder: 'kept_dirty' as const } : {}) });
    }
    if (views.length > 0) out.set(b.id, views);
  }
  return out;
}

let sources: BotTaskSources | null = null;

/** Set by the wiring module on start (null on dispose). */
export function setBotTaskSources(next: BotTaskSources | null): void {
  sources = next;
}

export function getBotTaskSources(): BotTaskSources | null {
  return sources;
}
