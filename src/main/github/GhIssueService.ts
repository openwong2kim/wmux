// GhIssueService: a GitHub repo's open issues and one issue's detail, read
// through the gh CLI for the Git page's Issues view.
//
// Every read names its repo explicitly — `repos/<owner>/<repo>/issues` on the
// remote's host, `issue view --repo host/owner/repo` — so neither GH_REPO, a gh
// default repo nor an upstream remote can swap in another repo's issues under
// the origin's key. The list is the REST issues endpoint: it carries the
// comment count as a number, so no comment body is read until a detail opens.
//
// Same shape as GhPrService's list: keyed by the remote (host/owner/repo), so
// clones of one repo share a read; a 30s list TTL; an in-flight read is shared
// (single-flight); a detail is re-read only when the list's updatedAt moves.
// The gh gate (installed / signed in) is GhPrService's, called by the handler
// before this service runs.
//
// Rate limit: GitHub's rate-limit answer (read from gh's stderr only) trips a
// per-host breaker that backs off 1, 2, 4 … 15 minutes. While it is open no gh
// call is made and every read answers 'rate-limited' with the time it retries;
// the first success closes it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';
import type {
  IssueComment,
  IssueDetail,
  IssueDetailResult,
  IssueFilter,
  IssueSummary,
  RepoPermission,
} from '../../shared/issueSurface';
import { capBody } from './GhPrService';
import { GhRateBreaker, ghRateBreaker, isRateLimitError } from './ghRateBreaker';

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 30_000;
const GH_TIMEOUT_MS = 10_000;
/** Items read per list (the endpoint mixes in PRs, which are dropped);
 *  exactly this many issues shows as 100+. */
export const ISSUE_LIST_LIMIT = 100;
/** How long the signed-in login (for assigned/created filters) is believed. */
const LOGIN_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 128;
const GH_MAX_BUFFER = 16 * 1024 * 1024;

/** gh's env: the GUI exec env (process env with a fixed-up PATH) minus
 *  GH_REPO, which would point gh at another repo, plus the three
 *  non-interactive switches. */
export function ghIssueEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...getExecEnv(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' };
  delete env.GH_REPO;
  return env;
}

/** host, owner and repo of a GitHub remote key (host/owner/repo), or null. */
export function splitRepoKey(key: string): { host: string; owner: string; repo: string } | null {
  const parts = key.split('/');
  if (parts.length !== 3 || parts.some((p) => !p || !/^[\w.-]+$/.test(p))) return null;
  return { host: parts[0], owner: parts[1], repo: parts[2] };
}

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>;

/** The REST list path for a filter. `login` is the signed-in user, needed by
 *  assigned/created (the REST endpoint has no @me). */
export function issueListPath(owner: string, repo: string, filter: IssueFilter, login = ''): string {
  const q = new URLSearchParams({ state: 'open', per_page: String(ISSUE_LIST_LIMIT) });
  if (filter.kind === 'assigned') q.set('assignee', login);
  else if (filter.kind === 'created') q.set('creator', login);
  else if (filter.kind === 'label') q.set('labels', filter.label);
  // URLSearchParams writes a space as '+'; spell it %20 so a label keeps it.
  return `repos/${owner}/${repo}/issues?${q.toString().replace(/\+/g, '%20')}`;
}

function filterKey(filter: IssueFilter): string {
  return filter.kind === 'label' ? `label:${filter.label}` : filter.kind;
}

// ── gh JSON → wire types (pure, exported for tests) ─────────────────────────

interface GhIssueJson {
  number?: number;
  title?: string;
  state?: string;
  stateReason?: string;
  author?: { login?: string } | null;
  labels?: Array<{ name?: string }> | null;
  assignees?: Array<{ login?: string }> | null;
  updatedAt?: string;
  createdAt?: string;
  closedAt?: string | null;
  url?: string;
  body?: string;
  comments?: Array<{ author?: { login?: string } | null; body?: string; createdAt?: string; url?: string }>;
}

const labelsOf = (j: GhIssueJson) =>
  (j.labels ?? []).filter((l) => typeof l?.name === 'string' && l.name).map((l) => ({ name: l.name as string }));
const assigneesOf = (j: GhIssueJson) =>
  (j.assignees ?? []).map((a) => a?.login ?? '').filter(Boolean);
const stateOf = (j: GhIssueJson): 'open' | 'closed' => ((j.state ?? '').toUpperCase() === 'CLOSED' ? 'closed' : 'open');

interface RestIssueJson {
  number?: number;
  title?: string;
  state?: string;
  user?: { login?: string; type?: string } | null;
  labels?: Array<{ name?: string } | string> | null;
  assignees?: Array<{ login?: string }> | null;
  updated_at?: string;
  html_url?: string;
  comments?: number;
  pull_request?: unknown;
  draft?: boolean;
}

/** One open issue or PR of a list, lean: what Moa's proposals need
 *  (moaIssueProposals.ts). The REST endpoint returns both kinds, so one read covers
 *  them. Title and author are the author's own text (untrusted). */
export interface RepoItem {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  author: string;
  /** The host typed the author as a bot (`user.type === 'Bot'`). */
  authorIsBot: boolean;
  labels: string[];
  url: string;
  draft: boolean;
}

export function mapRestItem(j: RestIssueJson): RepoItem | null {
  if (typeof j.number !== 'number' || typeof j.html_url !== 'string') return null;
  if ((j.state ?? 'open').toLowerCase() !== 'open') return null;
  return {
    kind: j.pull_request ? 'pr' : 'issue',
    number: j.number,
    title: j.title ?? '',
    author: j.user?.login ?? '',
    authorIsBot: j.user?.type === 'Bot',
    labels: (j.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean),
    url: j.html_url,
    draft: j.draft === true,
  };
}

/** A REST issues-endpoint item; a pull request (which the endpoint mixes in) is null. */
export function mapRestIssue(j: RestIssueJson): IssueSummary | null {
  if (j.pull_request || typeof j.number !== 'number' || typeof j.html_url !== 'string') return null;
  return {
    number: j.number,
    title: j.title ?? '',
    state: (j.state ?? '').toLowerCase() === 'closed' ? 'closed' : 'open',
    author: j.user?.login ?? '',
    labels: (j.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : l?.name ?? ''))
      .filter(Boolean)
      .map((name) => ({ name })),
    assignees: (j.assignees ?? []).map((a) => a?.login ?? '').filter(Boolean),
    updatedAt: j.updated_at ?? '',
    url: j.html_url,
    comments: typeof j.comments === 'number' ? j.comments : 0,
  };
}

export function mapGhIssueDetail(j: GhIssueJson): IssueDetail | null {
  if (typeof j.number !== 'number' || typeof j.url !== 'string') return null;
  const body = capBody(typeof j.body === 'string' ? j.body : '');
  const comments: IssueComment[] = [];
  for (const c of j.comments ?? []) {
    if (typeof c?.body !== 'string') continue;
    const { body: text, truncated } = capBody(c.body);
    comments.push({ author: c.author?.login ?? '', body: text, createdAt: c.createdAt ?? '', url: c.url ?? j.url, truncated });
  }
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    number: j.number,
    title: j.title ?? '',
    state: stateOf(j),
    stateReason: (j.stateReason ?? '').toUpperCase(),
    author: j.author?.login ?? '',
    body: body.body,
    bodyTruncated: body.truncated,
    labels: labelsOf(j),
    assignees: assigneesOf(j),
    createdAt: j.createdAt ?? '',
    closedAt: j.closedAt ?? '',
    url: j.url,
    comments,
  };
}

/** The strongest role in a REST repo's `permissions` flags, or null when gh
 *  reports none (signed out, or a token without repo scope). */
export function roleOf(p: unknown): RepoPermission | null {
  if (!p || typeof p !== 'object') return null;
  const f = p as Record<string, unknown>;
  if (f.admin === true) return 'ADMIN';
  if (f.maintain === true) return 'MAINTAIN';
  if (f.push === true) return 'WRITE';
  if (f.triage === true) return 'TRIAGE';
  if (f.pull === true) return 'READ';
  return null;
}

export { isRateLimitError };

function errorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).slice(0, 300);
}

// ── service ─────────────────────────────────────────────────────────────────

type ServiceListResult =
  | { ok: true; issues: IssueSummary[]; items: RepoItem[] }
  | { ok: false; code: 'rate-limited'; message: string; retryAt: number }
  | { ok: false; code: 'error'; message: string };

interface ListEntry {
  value: ServiceListResult | null;
  fetchedAt: number;
  pending: Promise<ServiceListResult> | null;
}

class RateLimited extends Error {}

export class GhIssueService {
  private listCache = new Map<string, ListEntry>();
  private detailCache = new Map<string, { updatedAt: string; value: IssueDetail }>();
  private detailPending = new Map<string, Promise<IssueDetailResult>>();
  private logins = new Map<string, { login: string; at: number }>();
  private permissions = new Map<string, RepoPermission>();
  private permissionPending = new Map<string, Promise<RepoPermission | null>>();
  /** Per host rate-limit breaker; the process-wide one in production. */
  private breaker: GhRateBreaker;

  constructor(
    private now: () => number = Date.now,
    private exec: Exec = execFileAsync,
    breaker?: GhRateBreaker,
  ) {
    this.breaker = breaker ?? new GhRateBreaker(now);
  }

  /** When reads to this host resume, or null while they are allowed. */
  retryAt(host: string): number | null {
    return this.breaker.retryAt(host);
  }

  private rateLimited(host: string): { ok: false; code: 'rate-limited'; message: string; retryAt: number } | null {
    const until = this.retryAt(host);
    return until === null ? null : { ok: false, code: 'rate-limited', message: 'GitHub rate limit', retryAt: until };
  }

  private async gh(host: string, args: string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await this.exec(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
        cwd,
        timeout: GH_TIMEOUT_MS,
        env: ghIssueEnv(),
        windowsHide: true,
        maxBuffer: GH_MAX_BUFFER,
      });
      this.breaker.reset(host);
      return stdout;
    } catch (err) {
      if (isRateLimitError(err)) {
        this.breaker.trip(host);
        throw new RateLimited(errorText(err));
      }
      throw err;
    }
  }

  /** The signed-in login on `host`, for the assigned/created filters. */
  private async login(host: string, cwd: string, force = false): Promise<string> {
    const hit = this.logins.get(host);
    if (hit && !force && this.now() - hit.at < LOGIN_TTL_MS) return hit.login;
    const login = (await this.gh(host, ['api', '--hostname', host, 'user', '--jq', '.login'], cwd)).trim();
    if (!login) throw new Error('could not read the signed-in GitHub login');
    // Another account on this host (gh auth switch): its roles are not ours.
    if (hit && hit.login !== login) this.clearPermissions(host);
    this.logins.set(host, { login, at: this.now() });
    return login;
  }

  private clearPermissions(host: string): void {
    for (const k of [...this.permissions.keys()]) if (k.startsWith(`${host}/`)) this.permissions.delete(k);
  }

  /** The login gh is signed in as on `host` (cached like the filters' read),
   *  or null when it cannot be read or the breaker is open. Never throws. */
  async signedInLogin(host: string, cwd: string, force = false): Promise<string | null> {
    if (this.retryAt(host) !== null) return null;
    try {
      return (await this.login(host, cwd, force)).toLowerCase();
    } catch {
      return null;
    }
  }

  /** The signed-in viewer's role on the remote `key` (host/owner/repo) and
   *  the login it was read under. Kept per repo and login for the session, so
   *  another account (gh auth switch) reads its own; `force` (the page's
   *  refresh) reads the login and the role again. A repo that answers with no
   *  permissions (a public repo the viewer does not collaborate on) is READ
   *  and kept like any role. When the login cannot be read the role is
   *  still read, answered with a null login and not kept. A failed read (gh
   *  error, the breaker open) is null and not kept, so the next page show
   *  asks again. Never throws. */
  async repoPermission(key: string, cwd: string, force = false): Promise<{ permission: RepoPermission | null; login: string | null }> {
    const repo = splitRepoKey(key);
    if (!repo || this.retryAt(repo.host) !== null) return { permission: null, login: null };
    let login: string | null = null;
    try {
      login = (await this.login(repo.host, cwd, force)).toLowerCase();
    } catch {
      if (this.retryAt(repo.host) !== null) return { permission: null, login: null };
    }
    // Without a login the answer is not kept: it cannot say whose role it is.
    const cacheKey = login === null ? null : `${key}\0${login}`;
    const hit = cacheKey === null ? undefined : this.permissions.get(cacheKey);
    if (hit && !force) return { permission: hit, login };
    const pendingKey = cacheKey ?? `${key}\0`;
    let read = this.permissionPending.get(pendingKey);
    // A refresh never takes the answer of a read that began before it.
    if (force && read) {
      await read;
      read = this.permissionPending.get(pendingKey);
    }
    if (!read) {
      read = this.gh(repo.host, ['api', '--hostname', repo.host, `repos/${repo.owner}/${repo.repo}`, '--jq', '.permissions'], cwd)
        .then((stdout) => {
          // Answered: no permissions there means no more than read access.
          const role = roleOf(JSON.parse(stdout.trim() || 'null')) ?? 'READ';
          if (cacheKey !== null) {
            this.permissions.set(cacheKey, role);
            evict(this.permissions);
          }
          return role;
        })
        .catch(() => null)
        .finally(() => this.permissionPending.delete(pendingKey));
      this.permissionPending.set(pendingKey, read);
    }
    return { permission: await read, login };
  }

  /**
   * Open issues of the remote `key` (host/owner/repo), read from `repoPath`.
   * Its host scopes the breaker. `force` (the page's refresh) skips the TTL
   * but never an open breaker.
   */
  async listIssues(repoPath: string, filter: IssueFilter, key: string, force = false): Promise<ServiceListResult> {
    const repo = splitRepoKey(key);
    if (!repo) return { ok: false, code: 'error', message: 'not a GitHub owner/repo remote' };
    const cacheKey = `${key}\0${filterKey(filter)}`;
    const entry = this.listCache.get(cacheKey);
    if (entry?.pending) return entry.pending;
    // A fresh answer is served even while the breaker is open: it costs no call.
    if (entry?.value && !force && this.now() - entry.fetchedAt < LIST_TTL_MS) return entry.value;
    const limited = this.rateLimited(repo.host);
    if (limited) return limited;
    const pending = this.fetchList(repo, repoPath, filter).then((value) => {
      this.listCache.set(cacheKey, { value, fetchedAt: this.now(), pending: null });
      return value;
    });
    this.listCache.set(cacheKey, { value: entry?.value ?? null, fetchedAt: entry?.fetchedAt ?? 0, pending });
    evict(this.listCache);
    return pending;
  }

  private async fetchList(
    repo: { host: string; owner: string; repo: string },
    repoPath: string,
    filter: IssueFilter,
  ): Promise<ServiceListResult> {
    try {
      const me = filter.kind === 'assigned' || filter.kind === 'created' ? await this.login(repo.host, repoPath) : '';
      const stdout = await this.gh(
        repo.host,
        ['api', '--hostname', repo.host, issueListPath(repo.owner, repo.repo, filter, me)],
        repoPath,
      );
      const arr = JSON.parse(stdout) as RestIssueJson[];
      const all = Array.isArray(arr) ? arr : [];
      const issues = all.map(mapRestIssue).filter((i): i is IssueSummary => i !== null);
      const items = all.map(mapRestItem).filter((i): i is RepoItem => i !== null);
      return { ok: true, issues, items };
    } catch (err) {
      if (err instanceof RateLimited) return this.rateLimited(repo.host) ?? { ok: false, code: 'error', message: err.message };
      return { ok: false, code: 'error', message: errorText(err) };
    }
  }

  /** One issue with its comments; re-read only when `updatedAt` moved. */
  async issueDetail(repoPath: string, number: number, updatedAt: string, key: string): Promise<IssueDetailResult> {
    const repo = splitRepoKey(key);
    if (!repo) return { ok: false, code: 'error', message: 'not a GitHub owner/repo remote' };
    const cacheKey = `${key}\0${number}`;
    const cached = this.detailCache.get(cacheKey);
    if (cached && updatedAt && cached.updatedAt === updatedAt) return { ok: true, detail: cached.value };
    const inFlight = this.detailPending.get(cacheKey);
    if (inFlight) return inFlight;
    const limited = this.rateLimited(repo.host);
    if (limited) return limited;
    const pending = (async (): Promise<IssueDetailResult> => {
      try {
        const stdout = await this.gh(
          repo.host,
          ['issue', 'view', String(number), '--repo', key, '--json',
            'number,title,state,stateReason,author,body,labels,assignees,comments,createdAt,closedAt,updatedAt,url'],
          repoPath,
        );
        const detail = mapGhIssueDetail(JSON.parse(stdout) as GhIssueJson);
        if (!detail) return { ok: false, code: 'error', message: 'unexpected gh output' };
        this.detailCache.set(cacheKey, { updatedAt, value: detail });
        evict(this.detailCache);
        return { ok: true, detail };
      } catch (err) {
        if (err instanceof RateLimited) return this.rateLimited(repo.host) ?? { ok: false, code: 'error', message: err.message };
        return { ok: false, code: 'error', message: errorText(err) };
      } finally {
        this.detailPending.delete(cacheKey);
      }
    })();
    this.detailPending.set(cacheKey, pending);
    return pending;
  }
}

function evict(cache: Map<string, unknown>): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Process-wide, so every caller shares the TTL window and the breaker. */
export const ghIssueService = new GhIssueService(Date.now, execFileAsync, ghRateBreaker);
