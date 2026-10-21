// GlabIssueService: a GitLab project's open issues and one issue's detail,
// read through glab for the Git page's Issues view. GhIssueService's
// counterpart: it fills the same wire types (issueSurface).
//
// Every read names its project — `glab api --hostname <host>
// projects/<url-encoded path>/issues…`, the path taken from origin's key
// (host/group/…/project). glab's `:id` placeholder is not used: glab picks
// that project from the cwd's remotes, which need not be origin, the remote
// the list is keyed by.
//
// Same cache shape as GhIssueService: keyed by the remote, so clones of one
// project share a read; a 30s list TTL; an in-flight read is shared; a detail
// is re-read only when the list's updatedAt moves. The glab gate (installed /
// signed in on the host) is GlabPrService's, called by the handler first. No
// rate-limit breaker: GitLab's 429 reads as an error.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IssueComment, IssueDetail, IssueDetailResult, IssueFilter, IssueSummary } from '../../shared/issueSurface';
import { capBody } from './GhPrService';
import { GLAB_ENV, glabProjectOfKey } from './GlabPrService';
import { ISSUE_LIST_LIMIT } from './GhIssueService';

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 30_000;
const GLAB_TIMEOUT_MS = 10_000;
const MAX_ENTRIES = 128;
/** The REST list carries every issue's description. */
const GLAB_MAX_BUFFER = 16 * 1024 * 1024;

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>;

export { glabProjectOfKey };

/** The REST list path for a filter. GitLab's scope covers assigned/created,
 *  so no login is read. A label name cannot hold a comma on GitLab, which is
 *  what `labels` would split it at. */
export function glabIssueListPath(path: string, filter: IssueFilter): string {
  const q = new URLSearchParams({ state: 'opened', per_page: String(ISSUE_LIST_LIMIT) });
  q.set('scope', filter.kind === 'assigned' ? 'assigned_to_me' : filter.kind === 'created' ? 'created_by_me' : 'all');
  if (filter.kind === 'label') q.set('labels', filter.label);
  // URLSearchParams writes a space as '+'; spell it %20 so a label keeps it.
  return `projects/${encodeURIComponent(path)}/issues?${q.toString().replace(/\+/g, '%20')}`;
}

function filterKey(filter: IssueFilter): string {
  return filter.kind === 'label' ? `label:${filter.label}` : filter.kind;
}

// ── GitLab REST → wire types (pure, exported for tests) ─────────────────────

interface GlabIssueJson {
  iid?: number;
  title?: string;
  state?: string; // "opened" | "closed"
  description?: string | null;
  author?: { username?: string } | null;
  labels?: Array<string | { name?: string }> | null;
  assignees?: Array<{ username?: string }> | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  web_url?: string;
  user_notes_count?: number;
}

interface GlabNoteJson {
  id?: number;
  system?: boolean;
  author?: { username?: string } | null;
  body?: string;
  created_at?: string;
}

const labelsOf = (j: GlabIssueJson) =>
  (j.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean).map((name) => ({ name }));
const assigneesOf = (j: GlabIssueJson) => (j.assignees ?? []).map((a) => a?.username ?? '').filter(Boolean);
const stateOf = (j: GlabIssueJson): 'open' | 'closed' => ((j.state ?? '').toLowerCase() === 'closed' ? 'closed' : 'open');

export function mapGlabIssue(j: GlabIssueJson): IssueSummary | null {
  if (typeof j.iid !== 'number' || typeof j.web_url !== 'string') return null;
  return {
    number: j.iid,
    title: j.title ?? '',
    state: stateOf(j),
    author: j.author?.username ?? '',
    labels: labelsOf(j),
    assignees: assigneesOf(j),
    updatedAt: j.updated_at ?? '',
    url: j.web_url,
    comments: typeof j.user_notes_count === 'number' ? j.user_notes_count : 0,
  };
}

/** An issue and its notes; system notes ("changed the description", "mentioned
 *  in …") are activity, not comments, and are left out. The notes read asks
 *  for comments only, so activity cannot fill its page; a GitLab too old to
 *  know that filter sends everything and this drops it. */
export function mapGlabIssueDetail(j: GlabIssueJson, notes: GlabNoteJson[]): IssueDetail | null {
  if (typeof j.iid !== 'number' || typeof j.web_url !== 'string') return null;
  const body = capBody(typeof j.description === 'string' ? j.description : '');
  const comments: IssueComment[] = [];
  for (const n of notes) {
    if (n?.system || typeof n?.body !== 'string') continue;
    const { body: text, truncated } = capBody(n.body);
    const url = typeof n.id === 'number' ? `${j.web_url}#note_${n.id}` : j.web_url;
    comments.push({ author: n.author?.username ?? '', body: text, createdAt: n.created_at ?? '', url, truncated });
  }
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    number: j.iid,
    title: j.title ?? '',
    state: stateOf(j),
    // GitLab has no close reason on an issue.
    stateReason: '',
    author: j.author?.username ?? '',
    body: body.body,
    bodyTruncated: body.truncated,
    labels: labelsOf(j),
    assignees: assigneesOf(j),
    createdAt: j.created_at ?? '',
    closedAt: j.closed_at ?? '',
    url: j.web_url,
    comments,
  };
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).slice(0, 300);
}

// ── service ─────────────────────────────────────────────────────────────────

type ServiceListResult =
  | { ok: true; issues: IssueSummary[] }
  | { ok: false; code: 'error'; message: string };

interface ListEntry {
  value: ServiceListResult | null;
  fetchedAt: number;
  pending: Promise<ServiceListResult> | null;
}

export class GlabIssueService {
  private listCache = new Map<string, ListEntry>();
  private detailCache = new Map<string, { updatedAt: string; value: IssueDetail }>();
  private detailPending = new Map<string, Promise<IssueDetailResult>>();

  constructor(
    private now: () => number = Date.now,
    private exec: Exec = execFileAsync,
  ) {}

  private async glab(host: string, apiPath: string, cwd: string): Promise<unknown> {
    const { stdout } = await this.exec(process.platform === 'win32' ? 'glab.exe' : 'glab', ['api', '--hostname', host, apiPath], {
      cwd,
      timeout: GLAB_TIMEOUT_MS,
      env: GLAB_ENV,
      windowsHide: true,
      maxBuffer: GLAB_MAX_BUFFER,
    });
    return JSON.parse(stdout);
  }

  /** Open issues of the remote `key` (host/group/…/project), read from
   *  `repoPath`. `force` (the page's refresh) skips the TTL. */
  async listIssues(repoPath: string, filter: IssueFilter, key: string, force = false): Promise<ServiceListResult> {
    const project = glabProjectOfKey(key);
    if (!project) return { ok: false, code: 'error', message: 'not a GitLab group/project remote' };
    const cacheKey = `${key}\0${filterKey(filter)}`;
    const entry = this.listCache.get(cacheKey);
    if (entry?.pending) return entry.pending;
    if (entry?.value && !force && this.now() - entry.fetchedAt < LIST_TTL_MS) return entry.value;
    const pending = (async (): Promise<ServiceListResult> => {
      try {
        const arr = await this.glab(project.host, glabIssueListPath(project.path, filter), repoPath);
        const issues = (Array.isArray(arr) ? arr : [])
          .map((j) => mapGlabIssue(j as GlabIssueJson))
          .filter((i): i is IssueSummary => i !== null);
        return { ok: true, issues };
      } catch (err) {
        return { ok: false, code: 'error', message: errorText(err) };
      }
    })().then((value) => {
      this.listCache.set(cacheKey, { value, fetchedAt: this.now(), pending: null });
      return value;
    });
    this.listCache.set(cacheKey, { value: entry?.value ?? null, fetchedAt: entry?.fetchedAt ?? 0, pending });
    evict(this.listCache);
    return pending;
  }

  /** One issue with its comments (two reads: the issue, its notes); re-read
   *  only when `updatedAt` moved. */
  async issueDetail(repoPath: string, number: number, updatedAt: string, key: string): Promise<IssueDetailResult> {
    const project = glabProjectOfKey(key);
    if (!project) return { ok: false, code: 'error', message: 'not a GitLab group/project remote' };
    const cacheKey = `${key}\0${number}`;
    const cached = this.detailCache.get(cacheKey);
    if (cached && updatedAt && cached.updatedAt === updatedAt) return { ok: true, detail: cached.value };
    // A read is shared only by callers asking for the same version: one that
    // began before the issue moved would answer with the old one.
    const pendingKey = `${cacheKey}\0${updatedAt}`;
    const inFlight = this.detailPending.get(pendingKey);
    if (inFlight) return inFlight;
    const base = `projects/${encodeURIComponent(project.path)}/issues/${number}`;
    const pending = (async (): Promise<IssueDetailResult> => {
      try {
        const [issue, notes] = await Promise.all([
          this.glab(project.host, base, repoPath),
          this.glab(project.host, `${base}/notes?activity_filter=only_comments&sort=asc&order_by=created_at&per_page=100`, repoPath),
        ]);
        const detail = mapGlabIssueDetail(
          (issue ?? {}) as GlabIssueJson,
          Array.isArray(notes) ? (notes as GlabNoteJson[]) : [],
        );
        if (!detail) return { ok: false, code: 'error', message: 'unexpected glab output' };
        this.detailCache.set(cacheKey, { updatedAt, value: detail });
        evict(this.detailCache);
        return { ok: true, detail };
      } catch (err) {
        return { ok: false, code: 'error', message: errorText(err) };
      } finally {
        this.detailPending.delete(pendingKey);
      }
    })();
    this.detailPending.set(pendingKey, pending);
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

/** Process-wide, so every caller shares the TTL window. */
export const glabIssueService = new GlabIssueService();
