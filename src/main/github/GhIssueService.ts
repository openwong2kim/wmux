// GhIssueService: a GitHub repo's open issues and one issue's detail, read
// through the gh CLI for the Git page's Issues view.
//
// Same shape as GhPrService's list: keyed by the remote (host/owner/repo), so
// clones of one repo share a read; a 30s list TTL; an in-flight read is shared
// (single-flight); a detail is re-read only when the list's updatedAt moves.
// The gh gate (installed / signed in) is GhPrService's, called by the handler
// before this service runs.
//
// Rate limit: a 429 or a "rate limit" answer trips a per-host breaker that
// backs off 1, 2, 4 … 15 minutes. While it is open no gh call is made and
// every read answers 'rate-limited' with the time it retries; the first
// success closes it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';
import type {
  IssueComment,
  IssueDetail,
  IssueDetailResult,
  IssueFilter,
  IssueSummary,
} from '../../shared/issueSurface';
import { capBody } from './GhPrService';

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 30_000;
const GH_TIMEOUT_MS = 10_000;
/** Open issues read per list; exactly this many shows as 100+. */
export const ISSUE_LIST_LIMIT = 100;
const MAX_ENTRIES = 128;
const GH_MAX_BUFFER = 16 * 1024 * 1024;
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/** gh's env: the GUI exec env plus the three non-interactive switches, nothing else. */
export function ghIssueEnv(): NodeJS.ProcessEnv {
  return { ...getExecEnv(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' };
}

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>;

/** gh flags for a filter. A label goes in the `=` form so a name starting
 *  with `-` is never read as a flag. */
export function issueFilterArgs(filter: IssueFilter): string[] {
  switch (filter.kind) {
    case 'assigned': return ['--assignee', '@me'];
    case 'created': return ['--author', '@me'];
    case 'label': return [`--label=${filter.label}`];
    default: return [];
  }
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
  /** A count in the list (reduced by --jq), the comment nodes in a view. */
  comments?: number | Array<{ author?: { login?: string } | null; body?: string; createdAt?: string; url?: string }>;
}

const labelsOf = (j: GhIssueJson) =>
  (j.labels ?? []).filter((l) => typeof l?.name === 'string' && l.name).map((l) => ({ name: l.name as string }));
const assigneesOf = (j: GhIssueJson) =>
  (j.assignees ?? []).map((a) => a?.login ?? '').filter(Boolean);
const stateOf = (j: GhIssueJson): 'open' | 'closed' => ((j.state ?? '').toUpperCase() === 'CLOSED' ? 'closed' : 'open');

export function mapGhIssue(j: GhIssueJson): IssueSummary | null {
  if (typeof j.number !== 'number' || typeof j.url !== 'string') return null;
  return {
    number: j.number,
    title: j.title ?? '',
    state: stateOf(j),
    author: j.author?.login ?? '',
    labels: labelsOf(j),
    assignees: assigneesOf(j),
    updatedAt: j.updatedAt ?? '',
    url: j.url,
    comments: typeof j.comments === 'number' ? j.comments : Array.isArray(j.comments) ? j.comments.length : 0,
  };
}

export function mapGhIssueDetail(j: GhIssueJson): IssueDetail | null {
  if (typeof j.number !== 'number' || typeof j.url !== 'string') return null;
  const body = capBody(typeof j.body === 'string' ? j.body : '');
  const comments: IssueComment[] = [];
  for (const c of Array.isArray(j.comments) ? j.comments : []) {
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

/** A gh failure that is GitHub's rate limit (primary or secondary). A 403
 *  without "rate limit" is a permission or SSO answer and is not one. */
export function isRateLimitError(err: unknown): boolean {
  const e = err as { stderr?: string; message?: string };
  const text = `${e?.stderr ?? ''}\n${e?.message ?? ''}`;
  return /rate limit/i.test(text) || /\bHTTP 429\b/.test(text);
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).slice(0, 300);
}

// ── service ─────────────────────────────────────────────────────────────────

type ServiceListResult =
  | { ok: true; issues: IssueSummary[] }
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
  /** Per host: the breaker's retry time and the backoff that set it. */
  private breaker = new Map<string, { until: number; backoff: number }>();

  constructor(
    private now: () => number = Date.now,
    private exec: Exec = execFileAsync,
  ) {}

  /** When reads to this host resume, or null while they are allowed. */
  retryAt(host: string): number | null {
    const b = this.breaker.get(host);
    return b && this.now() < b.until ? b.until : null;
  }

  private rateLimited(host: string): { ok: false; code: 'rate-limited'; message: string; retryAt: number } | null {
    const until = this.retryAt(host);
    return until === null ? null : { ok: false, code: 'rate-limited', message: 'GitHub rate limit', retryAt: until };
  }

  private trip(host: string): void {
    const prev = this.breaker.get(host);
    const backoff = prev ? Math.min(prev.backoff * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
    this.breaker.set(host, { until: this.now() + backoff, backoff });
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
      this.breaker.delete(host);
      return stdout;
    } catch (err) {
      if (isRateLimitError(err)) {
        this.trip(host);
        throw new RateLimited(errorText(err));
      }
      throw err;
    }
  }

  /**
   * Open issues for the repo at `repoPath`. `key` is the remote identity
   * (host/owner/repo); its host scopes the breaker. `force` (the page's
   * refresh) skips the TTL but never an open breaker.
   */
  async listIssues(repoPath: string, filter: IssueFilter, key: string, force = false): Promise<ServiceListResult> {
    const host = key.split('/')[0] || 'github.com';
    const cacheKey = `${key}\0${filterKey(filter)}`;
    const entry = this.listCache.get(cacheKey);
    if (entry?.pending) return entry.pending;
    const limited = this.rateLimited(host);
    if (limited) return limited;
    if (entry?.value && !force && this.now() - entry.fetchedAt < LIST_TTL_MS) return entry.value;
    const pending = this.fetchList(host, repoPath, filter).then((value) => {
      this.listCache.set(cacheKey, { value, fetchedAt: this.now(), pending: null });
      return value;
    });
    this.listCache.set(cacheKey, { value: entry?.value ?? null, fetchedAt: entry?.fetchedAt ?? 0, pending });
    evict(this.listCache);
    return pending;
  }

  private async fetchList(host: string, repoPath: string, filter: IssueFilter): Promise<ServiceListResult> {
    try {
      const stdout = await this.gh(
        host,
        [
          'issue', 'list',
          '--state', 'open',
          '--limit', String(ISSUE_LIST_LIMIT),
          ...issueFilterArgs(filter),
          '--json', 'number,title,state,author,labels,assignees,updatedAt,url,comments',
          // Comments arrive as full nodes; only their count crosses to the page.
          '--jq', 'map(.comments |= length)',
        ],
        repoPath,
      );
      const arr = JSON.parse(stdout) as GhIssueJson[];
      const issues = (Array.isArray(arr) ? arr : []).map(mapGhIssue).filter((i): i is IssueSummary => i !== null);
      return { ok: true, issues };
    } catch (err) {
      if (err instanceof RateLimited) return this.rateLimited(host) ?? { ok: false, code: 'error', message: err.message };
      return { ok: false, code: 'error', message: errorText(err) };
    }
  }

  /** One issue with its comments; re-read only when `updatedAt` moved. */
  async issueDetail(repoPath: string, number: number, updatedAt: string, key: string): Promise<IssueDetailResult> {
    const host = key.split('/')[0] || 'github.com';
    const cacheKey = `${key}\0${number}`;
    const cached = this.detailCache.get(cacheKey);
    if (cached && updatedAt && cached.updatedAt === updatedAt) return { ok: true, detail: cached.value };
    const inFlight = this.detailPending.get(cacheKey);
    if (inFlight) return inFlight;
    const limited = this.rateLimited(host);
    if (limited) return limited;
    const pending = (async (): Promise<IssueDetailResult> => {
      try {
        const stdout = await this.gh(
          host,
          ['issue', 'view', String(number), '--json',
            'number,title,state,stateReason,author,body,labels,assignees,comments,createdAt,closedAt,updatedAt,url'],
          repoPath,
        );
        const detail = mapGhIssueDetail(JSON.parse(stdout) as GhIssueJson);
        if (!detail) return { ok: false, code: 'error', message: 'unexpected gh output' };
        this.detailCache.set(cacheKey, { updatedAt, value: detail });
        evict(this.detailCache);
        return { ok: true, detail };
      } catch (err) {
        if (err instanceof RateLimited) return this.rateLimited(host) ?? { ok: false, code: 'error', message: err.message };
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
export const ghIssueService = new GhIssueService();
