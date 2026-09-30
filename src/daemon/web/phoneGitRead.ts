import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gitArgv, type GitRunner } from './sessionDiff';
import { SessionGitError } from './sessionGit';
import { runGhJson, sessionPullRequests, type PullRequestRunner } from './sessionPullRequests';
import {
  PHONE_GIT_MAX_BRANCHES, PHONE_GIT_MAX_PROJECTS, summarizeChecks,
  type PhoneCheckSummary, type PhoneGitBranch, type PhoneGitBranches, type PhoneGitProject,
} from '../../shared/phoneGitV1';

/**
 * Phone Git v1 reads (docs/phone-client-contract.md, item 5): the project list,
 * a session's local branches and its PR's CI checks.
 *
 * Every input is daemon state: a session's trusted `spawnCwd`, never a path,
 * ref or refspec from the phone. Every git call goes through the hardened phone
 * runner (fixed `-c` config, sanitized environment, timeout, output bound).
 */

/** How long one `spawnCwd`'s repository facts are reused. */
export const PHONE_GIT_CACHE_MS = 10_000;
const CACHE_LIMIT = 256;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** What a session's `spawnCwd` resolves to. */
export interface PhoneGitRepo {
  /** sha256(realpath of the main worktree root)[0,12): the desktop's `repoHash`. */
  projectId: string;
  name: string;
  /** Realpath of the main worktree root. */
  mainRoot: string;
  /** Absolute git common dir, as git reports it. */
  commonDir: string;
  branch: string | null;
  linkedWorktree: boolean;
}

/** A live session the caller may attach, with the facts these routes read. */
export interface PhoneGitSessionRef { id: string; spawnCwd: string; lastActivity?: string }

export interface PhoneGitChecks extends PhoneCheckSummary {
  state: 'available' | 'no-pr' | 'unsupported' | 'unavailable';
  pr?: { number: number; url: string; headOid: string; headMatchesLocal: boolean };
}

export type GhJsonRunner = (args: readonly string[], maxBuffer?: number) => Promise<unknown>;

const failed = () => new SessionGitError(409, 'git-operation-failed');
const realpathOr = async (p: string) => fs.realpath(p).catch(() => path.resolve(p));

/**
 * The same derivation as the desktop's task worktrees (`resolveRepoInfo` in
 * worktask.handler.ts): git common dir → its parent → `--show-toplevel` →
 * realpath → sha256, first 12 hex. Null when the directory is not in a
 * worktree of a non-bare repository; throws when git itself could not answer.
 */
export async function resolvePhoneGitRepo(cwd: string, git: GitRunner): Promise<PhoneGitRepo | null> {
  const here = await git(gitArgv('rev-parse', '--show-toplevel', '--git-common-dir'), cwd);
  if (!here.ok) {
    if (here.ran === false) throw failed();
    return null;
  }
  const [top, common] = here.stdout.split('\n');
  if (!top || !common) return null;
  const commonDir = path.resolve(cwd, common);
  const main = await git(gitArgv('rev-parse', '--show-toplevel'), path.dirname(commonDir));
  if (!main.ok) {
    if (main.ran === false) throw failed();
    return null;
  }
  const mainRoot = await realpathOr(main.stdout.trimEnd());
  const head = await git(gitArgv('symbolic-ref', '-q', '--short', 'HEAD'), cwd);
  if (!head.ok && head.code !== 1) throw failed();
  return {
    projectId: createHash('sha256').update(mainRoot).digest('hex').slice(0, 12),
    name: path.basename(mainRoot),
    mainRoot,
    commonDir,
    branch: head.ok && head.stdout.trim() ? head.stdout.trim() : null,
    linkedWorktree: await realpathOr(top) !== mainRoot,
  };
}

interface WorktreeRow { path: string; branch: string | null }

/** `git worktree list --porcelain -z`: records of `key value` fields, each record ended by an empty field. */
export function parseWorktreeList(stdout: string): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  let current: WorktreeRow | null = null;
  for (const field of stdout.split('\0')) {
    if (!field) { if (current) rows.push(current); current = null; continue; }
    if (field.startsWith('worktree ')) current = { path: field.slice('worktree '.length), branch: null };
    else if (current && field.startsWith('branch refs/heads/')) current.branch = field.slice('branch refs/heads/'.length);
  }
  if (current) rows.push(current);
  return rows;
}

const BRANCH_FORMAT = ['refname', 'objectname', 'committerdate:unix', 'upstream:short', 'upstream:track,nobracket']
  .map((f) => `%(${f})`).join('%00');

/** One `for-each-ref` line in `BRANCH_FORMAT`. */
export function parseBranchLine(line: string): Omit<PhoneGitBranch, 'worktree'> | null {
  const [ref, head, date, upstream, track] = line.split('\0');
  if (!ref?.startsWith('refs/heads/') || !head || !OID.test(head)) return null;
  const seconds = Number(date);
  const branch: Omit<PhoneGitBranch, 'worktree'> = {
    name: ref.slice('refs/heads/'.length), head, committedAt: Number.isFinite(seconds) ? seconds * 1000 : 0,
  };
  if (upstream) {
    const count = (word: string) => Number(new RegExp(`${word} (\\d+)`).exec(track ?? '')?.[1] ?? 0);
    branch.upstream = { name: upstream, ahead: count('ahead'), behind: count('behind'), gone: track === 'gone' };
  }
  return branch;
}

const activity = (s: PhoneGitSessionRef) => {
  const t = Date.parse(s.lastActivity ?? '');
  return Number.isFinite(t) ? t : 0;
};

export class PhoneGitReads {
  private readonly cache = new Map<string, { at: number; value: Promise<PhoneGitRepo | null> }>();

  constructor(
    private readonly git: GitRunner,
    private readonly prList?: PullRequestRunner,
    private readonly gh: GhJsonRunner = runGhJson,
    private readonly now: () => number = Date.now,
  ) {}

  /** Repository facts for one `spawnCwd`, reused for `PHONE_GIT_CACHE_MS`. */
  repo(cwd: string): Promise<PhoneGitRepo | null> {
    const at = this.now();
    const hit = this.cache.get(cwd);
    if (hit && at - hit.at < PHONE_GIT_CACHE_MS) return hit.value;
    if (this.cache.size >= CACHE_LIMIT) {
      for (const [key, entry] of this.cache) if (at - entry.at >= PHONE_GIT_CACHE_MS) this.cache.delete(key);
      const oldest = this.cache.keys().next().value;
      if (this.cache.size >= CACHE_LIMIT && oldest !== undefined) this.cache.delete(oldest);
    }
    const value = resolvePhoneGitRepo(cwd, this.git);
    this.cache.set(cwd, { at, value });
    // A git that could not answer is not a fact about the directory: retry next time.
    value.catch(() => { if (this.cache.get(cwd)?.value === value) this.cache.delete(cwd); });
    return value;
  }

  /** `GET /api/git/projects`: the caller's sessions grouped by repository. */
  async projects(sessions: PhoneGitSessionRef[]): Promise<{ projects: PhoneGitProject[]; truncated: boolean }> {
    const byCwd = new Map<string, PhoneGitRepo | null>();
    // Sequential on purpose: this whole listing holds one slot of the shared
    // four-slot Git budget, so it must not fan out into more git processes.
    for (const s of sessions) {
      if (byCwd.has(s.spawnCwd)) continue;
      byCwd.set(s.spawnCwd, await this.repo(s.spawnCwd).catch(() => null));
    }
    const groups = new Map<string, { repo: PhoneGitRepo; members: Array<{ s: PhoneGitSessionRef; repo: PhoneGitRepo }> }>();
    for (const s of sessions) {
      const repo = byCwd.get(s.spawnCwd);
      if (!repo) continue;
      const group = groups.get(repo.projectId) ?? { repo, members: [] };
      group.members.push({ s, repo });
      groups.set(repo.projectId, group);
    }
    const projects = [...groups.values()].map(({ repo, members }) => {
      members.sort((a, b) => activity(b.s) - activity(a.s));
      return {
        at: activity(members[0].s),
        project: {
          projectId: repo.projectId, name: repo.name, sessionId: members[0].s.id,
          sessions: members.map(({ s, repo: r }) => ({ sessionId: s.id, branch: r.branch, linkedWorktree: r.linkedWorktree })),
        },
      };
    }).sort((a, b) => b.at - a.at).map((p) => p.project);
    return { projects: projects.slice(0, PHONE_GIT_MAX_PROJECTS), truncated: projects.length > PHONE_GIT_MAX_PROJECTS };
  }

  private async run(cwd: string, ...args: string[]): Promise<string> {
    const result = await this.git(gitArgv(...args), cwd);
    if (!result.ok) throw failed();
    return result.stdout;
  }

  /** `GET /api/sessions/<id>/git/branches`. `sessions` attributes worktrees to the caller's panes. */
  async branches(cwd: string, sessions: PhoneGitSessionRef[]): Promise<PhoneGitBranches> {
    const repo = await this.repo(cwd);
    if (!repo) throw new SessionGitError(409, 'not-a-git-repo');
    const symbolic = await this.git(gitArgv('symbolic-ref', '-q', 'HEAD'), cwd);
    if (!symbolic.ok && symbolic.code !== 1) throw failed();
    const headRead = await this.git(gitArgv('rev-parse', '--verify', '-q', 'HEAD'), cwd);
    if (!headRead.ok && headRead.code !== 1) throw failed();
    const ref = symbolic.ok ? symbolic.stdout.trim() : '';
    const head = headRead.ok && OID.test(headRead.stdout.trim()) ? headRead.stdout.trim() : null;
    const current = {
      branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null,
      head,
      detached: !symbolic.ok,
    };

    const lines = (await this.run(cwd, 'for-each-ref', '--sort=-committerdate', `--count=${PHONE_GIT_MAX_BRANCHES + 1}`,
      `--format=${BRANCH_FORMAT}`, 'refs/heads/')).split('\n').filter(Boolean);
    const worktrees = await Promise.all(parseWorktreeList(await this.run(cwd, 'worktree', 'list', '--porcelain', '-z'))
      .map(async (w, index) => ({ ...w, index, real: await realpathOr(w.path) })));
    // Longest match wins: a linked worktree can live INSIDE the main checkout
    // (e.g. `.claude/worktrees/*`), and its panes belong to it, not to main.
    const owner = new Map<string, string[]>();
    for (const s of sessions) {
      const real = await realpathOr(s.spawnCwd);
      let best: (typeof worktrees)[number] | null = null;
      for (const w of worktrees) {
        if ((real === w.real || real.startsWith(w.real + path.sep)) && (!best || w.real.length > best.real.length)) best = w;
      }
      if (best) owner.set(best.real, [...(owner.get(best.real) ?? []), s.id]);
    }
    const checkedOut = new Map(worktrees.flatMap((w) => (w.branch === null ? [] : [[w.branch, w] as const])));
    const branches: PhoneGitBranch[] = [];
    for (const line of lines.slice(0, PHONE_GIT_MAX_BRANCHES)) {
      const branch = parseBranchLine(line);
      if (!branch) continue;
      const w = checkedOut.get(branch.name);
      branches.push(w
        ? { ...branch, worktree: { leaf: path.basename(w.path), main: w.index === 0, sessionIds: owner.get(w.real) ?? [] } }
        : branch);
    }
    return { projectId: repo.projectId, current, branches, truncated: lines.length > PHONE_GIT_MAX_BRANCHES };
  }

  /** `GET /api/sessions/<id>/git/checks`: the CI rollup of this branch's PR, chosen as `/git/pr` chooses. */
  async checks(cwd: string): Promise<PhoneGitChecks> {
    const empty = (state: PhoneGitChecks['state']): PhoneGitChecks =>
      ({ state, ...summarizeChecks([]) });
    const list = await sessionPullRequests(cwd, this.git, this.prList);
    if (list.state !== 'available') return empty(list.state);
    const chosen = list.items.find((pr) => pr.state === 'OPEN') ?? list.items[0];
    if (!chosen) return empty('no-pr');
    // `sessionPullRequests` pinned the URL to `https://github.com/<repo>/pull/<n>`.
    const repo = chosen.url.slice('https://github.com/'.length, chosen.url.lastIndexOf('/pull/'));
    let view: unknown;
    try {
      view = await this.gh(['pr', 'view', String(chosen.number), '--repo', `github.com/${repo}`,
        '--json', 'number,url,headRefOid,statusCheckRollup'], 1024 * 1024);
    } catch { return empty('unavailable'); }
    const v = view as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || v.number !== chosen.number || v.url !== chosen.url ||
        typeof v.headRefOid !== 'string' || !OID.test(v.headRefOid)) return empty('unavailable');
    const local = await this.git(gitArgv('rev-parse', '--verify', '-q', 'HEAD'), cwd);
    return {
      state: 'available',
      pr: { number: chosen.number, url: chosen.url, headOid: v.headRefOid, headMatchesLocal: local.ok && local.stdout.trim() === v.headRefOid },
      ...summarizeChecks(v.statusCheckRollup),
    };
  }
}
