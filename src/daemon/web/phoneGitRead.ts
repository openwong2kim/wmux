import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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
/** How long one session's checks answer is reused (it costs two `gh` calls). */
export const PHONE_GIT_CHECKS_CACHE_MS = 20_000;
/** Wall clock for the whole project listing. */
export const PHONE_GIT_PROJECTS_DEADLINE_MS = 15_000;
/** Most sessions one listing or branch attribution looks at, newest first. */
export const PHONE_GIT_MAX_SESSIONS = 200;
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
  /** Canonical (native realpath) git common dir: what "same repository" compares. */
  commonReal: string;
  branch: string | null;
  linkedWorktree: boolean;
}

/** A live session the caller may attach, with the facts these routes read. */
export interface PhoneGitSessionRef { id: string; spawnCwd: string; lastActivity?: string }

export interface PhoneGitChecks extends PhoneCheckSummary {
  state: 'available' | 'no-pr' | 'unsupported' | 'unavailable';
  pr?: { number: number; url: string; headOid: string; headMatchesLocal: boolean };
}

export interface PhoneGitProjects { projects: PhoneGitProject[]; truncated: boolean; degraded?: true }

export type GhJsonRunner = (args: readonly string[], maxBuffer?: number) => Promise<unknown>;

const failed = () => new SessionGitError(409, 'git-operation-failed');
/** One canonical spelling for cache keys and path matching: the native realpath. */
export const canonicalPath = async (p: string) => fs.realpath(p).catch(() => path.resolve(p));
/**
 * The desktop's `repoHash` realpath exactly: the JS `realpathSync`, raw path on
 * failure. The native realpath differs on Windows (it expands 8.3 short
 * names), and a different string is a different projectId and directory.
 */
const repoHashRealpath = (p: string) => { try { return realpathSync(p); } catch { return p; } };

interface WorktreeRow { path: string; branch: string | null }

/**
 * `git worktree list --porcelain`: records of `key value` fields, each record
 * ended by an empty field. `sep` is NUL for `-z` (git 2.36+), newline otherwise.
 */
export function parseWorktreeList(stdout: string, sep = '\0'): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  let current: WorktreeRow | null = null;
  for (const field of stdout.split(sep)) {
    if (!field) { if (current) rows.push(current); current = null; continue; }
    if (field.startsWith('worktree ')) current = { path: field.slice('worktree '.length), branch: null };
    else if (current && field.startsWith('branch refs/heads/')) current.branch = field.slice('branch refs/heads/'.length);
  }
  if (current) rows.push(current);
  return rows;
}

/** The repository's worktrees, main first. Null when this git cannot list them; throws when git could not run. */
export async function listWorktrees(git: GitRunner, cwd: string): Promise<WorktreeRow[] | null> {
  const nul = await git(gitArgv('worktree', 'list', '--porcelain', '-z'), cwd);
  if (nul.ok) return parseWorktreeList(nul.stdout, '\0');
  if (nul.ran === false) throw failed();
  // `-z` needs git 2.36; the line form is exact for any path without a newline.
  const lines = await git(gitArgv('worktree', 'list', '--porcelain'), cwd);
  if (lines.ok) return parseWorktreeList(lines.stdout.replace(/\r/g, ''), '\n');
  if (lines.ran === false) throw failed();
  return null;
}

/**
 * The same derivation as the desktop's task worktrees (`resolveRepoInfo` in
 * worktask.handler.ts): git common dir → its parent → `--show-toplevel` →
 * realpath → sha256, first 12 hex. Where that parent is not a worktree (a
 * submodule's `.git/modules/<name>`), the main worktree git itself reports.
 * Null when the directory is not in a worktree of a non-bare repository;
 * throws when git itself could not answer.
 */
export async function resolvePhoneGitRepo(cwd: string, git: GitRunner): Promise<PhoneGitRepo | null> {
  const here = await git(gitArgv('rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'), cwd);
  if (!here.ok) {
    if (here.ran === false) throw failed();
    return null;
  }
  const [top, common, own] = here.stdout.split('\n');
  if (!top || !common || !own) return null;
  const commonDir = path.resolve(cwd, common);
  let mainPath: string | null = null;
  const main = await git(gitArgv('rev-parse', '--show-toplevel'), path.dirname(commonDir));
  if (main.ok) mainPath = main.stdout.trimEnd();
  else if (main.ran === false) throw failed();
  else if (await canonicalPath(path.resolve(cwd, own)) === await canonicalPath(commonDir)) {
    // The common dir's parent is not a worktree (a submodule's
    // `.git/modules/<name>`), and this checkout is not a linked worktree: it
    // is the main worktree itself.
    mainPath = top;
  } else {
    // A linked worktree of such a repository: the main worktree is the one
    // the common dir's own configuration names.
    const named = await git(gitArgv(`--git-dir=${commonDir}`, 'rev-parse', '--show-toplevel'), commonDir);
    if (!named.ok && named.ran === false) throw failed();
    mainPath = named.ok ? named.stdout.trimEnd() : null;
  }
  if (!mainPath) return null;
  const mainRoot = repoHashRealpath(mainPath);
  const head = await git(gitArgv('symbolic-ref', '-q', '--short', 'HEAD'), cwd);
  if (!head.ok && head.code !== 1) throw failed();
  return {
    projectId: createHash('sha256').update(mainRoot).digest('hex').slice(0, 12),
    name: path.basename(mainRoot),
    mainRoot,
    commonDir,
    commonReal: await canonicalPath(commonDir),
    branch: head.ok && head.stdout.trim() ? head.stdout.trim() : null,
    linkedWorktree: repoHashRealpath(top) !== mainRoot,
  };
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
const newestFirst = (sessions: PhoneGitSessionRef[]) => [...sessions].sort((a, b) => activity(b) - activity(a));

function boundedSet<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= CACHE_LIMIT && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export class PhoneGitReads {
  private readonly cache = new Map<string, { at: number; value: Promise<PhoneGitRepo | null> }>();
  private readonly checksCache = new Map<string, { at: number; value: PhoneGitChecks }>();

  constructor(
    private readonly git: GitRunner,
    private readonly prList?: PullRequestRunner,
    private readonly gh: GhJsonRunner = runGhJson,
    private readonly now: () => number = Date.now,
  ) {}

  /** Repository facts for one `spawnCwd` (keyed by its realpath), reused for `PHONE_GIT_CACHE_MS`. */
  async repo(cwd: string): Promise<PhoneGitRepo | null> {
    const key = await canonicalPath(cwd);
    const at = this.now();
    const hit = this.cache.get(key);
    if (hit && at - hit.at < PHONE_GIT_CACHE_MS) return hit.value;
    for (const [k, entry] of this.cache) if (at - entry.at >= PHONE_GIT_CACHE_MS) this.cache.delete(k);
    const value = resolvePhoneGitRepo(cwd, this.git);
    boundedSet(this.cache, key, { at, value });
    // A git that could not answer is not a fact about the directory: retry next time.
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  /**
   * `GET /api/git/projects`: the caller's sessions grouped by repository.
   * Bounded by `PHONE_GIT_MAX_SESSIONS` and `PHONE_GIT_PROJECTS_DEADLINE_MS`
   * (what was not looked at sets `truncated`); stops when `aborted()` says the
   * caller is gone. Throws only when every repository read failed to run.
   */
  async projects(sessions: PhoneGitSessionRef[], opts: { aborted?: () => boolean; deadlineMs?: number } = {}): Promise<PhoneGitProjects> {
    const deadline = this.now() + (opts.deadlineMs ?? PHONE_GIT_PROJECTS_DEADLINE_MS);
    const ordered = newestFirst(sessions);
    let truncated = ordered.length > PHONE_GIT_MAX_SESSIONS;
    const considered = ordered.slice(0, PHONE_GIT_MAX_SESSIONS);
    const byCwd = new Map<string, PhoneGitRepo | null>();
    let failures = 0;
    let answered = 0;
    // Sequential on purpose: this whole listing holds one slot of the shared
    // four-slot Git budget, so it must not fan out into more git processes.
    for (const s of considered) {
      if (byCwd.has(s.spawnCwd)) continue;
      if (opts.aborted?.() || this.now() >= deadline) { truncated = true; break; }
      try {
        byCwd.set(s.spawnCwd, await this.repo(s.spawnCwd));
        answered += 1;
      } catch {
        byCwd.set(s.spawnCwd, null);
        failures += 1;
      }
    }
    if (failures > 0 && answered === 0) throw failed();
    const groups = new Map<string, { repo: PhoneGitRepo; members: Array<{ s: PhoneGitSessionRef; repo: PhoneGitRepo }> }>();
    for (const s of considered) {
      const repo = byCwd.get(s.spawnCwd);
      if (!repo) continue;
      const group = groups.get(repo.projectId) ?? { repo, members: [] };
      group.members.push({ s, repo });
      groups.set(repo.projectId, group);
    }
    // `considered` is newest first, so each group's first member is its newest.
    const projects = [...groups.values()].map(({ repo, members }) => ({
      projectId: repo.projectId, name: repo.name, sessionId: members[0].s.id,
      sessions: members.map(({ s, repo: r }) => ({ sessionId: s.id, branch: r.branch, linkedWorktree: r.linkedWorktree })),
    }));
    return {
      projects: projects.slice(0, PHONE_GIT_MAX_PROJECTS),
      truncated: truncated || projects.length > PHONE_GIT_MAX_PROJECTS,
      ...(failures > 0 ? { degraded: true as const } : {}),
    };
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
    // A git too old to list worktrees still gets its branches, without attribution.
    const worktrees = await Promise.all(((await listWorktrees(this.git, cwd)) ?? [])
      .map(async (w, index) => {
        const real = await canonicalPath(w.path);
        // A submodule lists its git dir as the main worktree; the checkout is mainRoot.
        return index === 0 && real === repo.commonReal
          ? { ...w, path: repo.mainRoot, index, real: await canonicalPath(repo.mainRoot) }
          : { ...w, index, real };
      }));
    // A pane belongs to a worktree only if it is in THIS repository (same
    // common dir), then by the longest path: a linked worktree can live inside
    // the main checkout (e.g. `.claude/worktrees/*`), and so can another
    // repository entirely.
    const owner = new Map<string, string[]>();
    for (const s of newestFirst(sessions).slice(0, PHONE_GIT_MAX_SESSIONS)) {
      const theirs = await this.repo(s.spawnCwd).catch(() => null);
      if (!theirs || theirs.commonReal !== repo.commonReal) continue;
      const real = await canonicalPath(s.spawnCwd);
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

  /**
   * `GET /api/sessions/<id>/git/checks`: the CI rollup of this branch's PR,
   * chosen as `/git/pr` chooses. A definite answer is reused for
   * `PHONE_GIT_CHECKS_CACHE_MS`; `unavailable` is never cached.
   */
  async checks(cwd: string): Promise<PhoneGitChecks> {
    const repo = await this.repo(cwd);
    if (!repo) throw new SessionGitError(409, 'not-a-git-repo');
    const key = await canonicalPath(cwd);
    const at = this.now();
    const hit = this.checksCache.get(key);
    if (hit && at - hit.at < PHONE_GIT_CHECKS_CACHE_MS) return hit.value;
    const value = await this.readChecks(cwd);
    if (value.state !== 'unavailable') boundedSet(this.checksCache, key, { at, value });
    return value;
  }

  private async readChecks(cwd: string): Promise<PhoneGitChecks> {
    const empty = (state: PhoneGitChecks['state']): PhoneGitChecks =>
      ({ state, ...summarizeChecks([]) });
    // No `origin` at all is a definite answer, not a CLI failure.
    const origin = await this.git(gitArgv('remote', 'get-url', 'origin'), cwd);
    if (!origin.ok) return empty(origin.ran === false ? 'unavailable' : 'unsupported');
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
