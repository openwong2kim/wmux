// GlabPrService — GitLab (glab CLI) implementation of PrProvider.
//
// Symmetric to GhPrService (non-interactive env, version≠auth two-step gate, ENOENT silent
// for process lifetime, never-throw, 30s list TTL, updatedAt-keyed detail cache). Differences:
//  - Per-host auth: self-hosted GitLab is common, so gate uses
//    `glab auth status --hostname <host>` (why gate takes host).
//  - GitLab REST raw payloads: list = `glab mr list --output json` (REST MR array),
//    comments = `glab api projects/:id/merge_requests/<iid>/notes`
//    (`:id` substituted by glab from cwd repo). System notes ("added 1 commit", etc.) are
//    noise, not human comments — filtered out.
//  - checks: REST list payload has no pipeline rollup — v1 is honest null (neutral dot in UI).
//    head_pipeline per MR is deferred (extra call each).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PR_COMMENT_BODY_CAP,
  cliPath,
  type PrProvider,
  type PrGate,
  type PrListResult,
  type PrDetailResult,
  type PrSummary,
  type PrComment,
} from './PrProvider';

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 30_000;
const GLAB_TIMEOUT_MS = 10_000;
const LIST_LIMIT = 30;
const MAX_ENTRIES = 128;

const GLAB_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: cliPath(),
  // Force glab non-interactive — prompts/pager must not block the poll (same contract as gh).
  NO_PROMPT: '1',
  GLAB_PAGER: 'cat',
  NO_COLOR: '1',
};

// Cache key — filesystem case policy (same as gh path). POSIX keeps original form.
function cacheKey(repoPath: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? repoPath.toLowerCase()
    : repoPath;
}

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => Promise<{ stdout: string }>;

// ── GitLab REST payload mapping (pure, exported for tests) ─────────────────────────

interface GlabMrItem {
  iid?: number;
  title?: string;
  state?: string; // "opened" | "merged" | "closed" | "locked"
  draft?: boolean;
  work_in_progress?: boolean;
  author?: { username?: string };
  source_branch?: string;
  updated_at?: string;
  web_url?: string;
  has_conflicts?: boolean;
}

export function mapGlabMrItem(json: GlabMrItem): PrSummary | null {
  if (typeof json.iid !== 'number' || typeof json.web_url !== 'string') return null;
  const raw = (json.state ?? '').toLowerCase();
  const state: PrSummary['state'] =
    raw === 'merged'
      ? 'merged'
      : raw === 'closed' || raw === 'locked'
        ? 'closed'
        : json.draft || json.work_in_progress
          ? 'draft'
          : 'open';
  return {
    number: json.iid,
    title: json.title ?? '',
    state,
    author: json.author?.username ?? '',
    headRefName: json.source_branch ?? '',
    updatedAt: json.updated_at ?? '',
    url: json.web_url,
    reviewDecision: '',
    // REST list has no pipeline rollup — v1 honest null (neutral dot).
    checks: null,
    // Normalize GitLab has_conflicts to gh contract (CONFLICTING) vocabulary. Absent → ''.
    mergeable: json.has_conflicts === true ? 'CONFLICTING' : '',
  };
}

interface GlabNote {
  system?: boolean;
  author?: { username?: string };
  body?: string;
  created_at?: string;
}

function capBody(raw: string): { body: string; truncated: boolean } {
  // Same normalization as gh: strip bot HTML comment markers + cap.
  const body = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (Buffer.byteLength(body, 'utf8') <= PR_COMMENT_BODY_CAP) return { body, truncated: false };
  return { body: body.slice(0, PR_COMMENT_BODY_CAP), truncated: true };
}

/** notes → comment stream. Excludes system notes (merge/commit auto-records). */
export function mapGlabNotes(notes: GlabNote[], mrUrl: string): PrComment[] {
  const out: PrComment[] = [];
  for (const n of notes) {
    if (n.system) continue;
    if (typeof n.body !== 'string') continue;
    const { body, truncated } = capBody(n.body);
    out.push({
      author: n.author?.username ?? '',
      body,
      createdAt: n.created_at ?? '',
      url: mrUrl,
      kind: 'comment',
      reviewState: '',
      truncated,
    });
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

// ── Service body ───────────────────────────────────────────────────────────────

interface ListEntry {
  value: PrListResult;
  fetchedAt: number;
  pending: Promise<PrListResult> | null;
}

export class GlabPrService implements PrProvider {
  private listCache = new Map<string, ListEntry>();
  /** key = repo\0iid — skip notes re-fetch when updatedAt unchanged. URL cached alongside. */
  private detailCache = new Map<string, { updatedAt: string; value: PrDetailResult }>();
  /** iid → web_url (filled from list — anchor URL for notes). */
  private urlByIid = new Map<string, string>();
  private glabAvailable: boolean | null = null;

  constructor(
    private now: () => number = Date.now,
    private exec: Exec = execFileAsync,
  ) {}

  private glab(args: string[], cwd: string): Promise<{ stdout: string }> {
    return this.exec(process.platform === 'win32' ? 'glab.exe' : 'glab', args, {
      cwd,
      timeout: GLAB_TIMEOUT_MS,
      env: GLAB_ENV,
      windowsHide: true,
    });
  }

  async gate(repoPath: string, host: string): Promise<PrGate> {
    if (this.glabAvailable === false) {
      return { ok: false, reason: 'cli-missing', message: 'GitLab CLI (glab) is not installed' };
    }
    try {
      await this.glab(['--version'], repoPath);
      this.glabAvailable = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') this.glabAvailable = false;
      return { ok: false, reason: 'cli-missing', message: 'GitLab CLI (glab) is not installed' };
    }
    try {
      // Per-host auth (self-hosted) — unauthenticated exits non-zero.
      await this.glab(['auth', 'status', '--hostname', host], repoPath);
    } catch {
      return {
        ok: false,
        reason: 'unauthenticated',
        message: `GitLab CLI is not authenticated for ${host} — run \`glab auth login --hostname ${host}\``,
      };
    }
    return { ok: true };
  }

  // force=true: manual refresh — skip TTL cache (same contract as gh path).
  async listPrs(repoPath: string, force = false): Promise<PrListResult> {
    const key = cacheKey(repoPath);
    const entry = this.listCache.get(key);
    const now = this.now();
    if (entry) {
      if (entry.pending) return entry.pending;
      if (!force && now - entry.fetchedAt < LIST_TTL_MS) return entry.value;
    }
    const pending = this.fetchList(repoPath)
      .then((value) => {
        this.listCache.set(key, { value, fetchedAt: this.now(), pending: null });
        return value;
      })
      .catch((err) => {
        const value: PrListResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
        this.listCache.set(key, { value, fetchedAt: this.now(), pending: null });
        return value;
      });
    this.listCache.set(key, {
      value: entry?.value ?? { ok: true, prs: [] },
      fetchedAt: entry?.fetchedAt ?? 0,
      pending,
    });
    this.evict(this.listCache);
    return pending;
  }

  private async fetchList(repoPath: string): Promise<PrListResult> {
    try {
      // Raw REST MR array — glab mr list json output (open MRs by default).
      const { stdout } = await this.glab(
        ['mr', 'list', '--per-page', String(LIST_LIMIT), '--output', 'json'],
        repoPath,
      );
      const arr = JSON.parse(stdout) as GlabMrItem[];
      const prs = (Array.isArray(arr) ? arr : [])
        .map(mapGlabMrItem)
        .filter((p): p is PrSummary => p !== null);
      for (const p of prs) this.urlByIid.set(`${cacheKey(repoPath)}\0${p.number}`, p.url);
      return { ok: true, prs };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, error: (e.stderr || e.message || String(err)).slice(0, 300) };
    }
  }

  async prDetail(repoPath: string, number: number, updatedAt: string): Promise<PrDetailResult> {
    const key = `${cacheKey(repoPath)}\0${number}`;
    const cached = this.detailCache.get(key);
    if (cached && cached.updatedAt === updatedAt && cached.value.ok) return cached.value;
    try {
      // `:id` substituted by glab from cwd repo (URL-encoded full path).
      const { stdout } = await this.glab(
        ['api', `projects/:id/merge_requests/${number}/notes?sort=asc&per_page=100`],
        repoPath,
      );
      const notes = JSON.parse(stdout) as GlabNote[];
      const mrUrl = this.urlByIid.get(key) ?? '';
      const value: PrDetailResult = {
        ok: true,
        detail: { number, comments: mapGlabNotes(Array.isArray(notes) ? notes : [], mrUrl) },
      };
      this.detailCache.set(key, { updatedAt, value });
      this.evict(this.detailCache);
      return value;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, error: (e.stderr || e.message || String(err)).slice(0, 300) };
    }
  }

  private evict(cache: Map<string, unknown>): void {
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
}

/** Process-global singleton — same lifetime contract as gh (ghPrService). */
export const glabPrService = new GlabPrService();
