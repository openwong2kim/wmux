// GlabPrService — PrProvider의 GitLab(glab CLI) 구현.
//
// GhPrService와 대칭 구조(비대화형 env·버전≠인증 2단 게이트·ENOENT 영구침묵·
// never-throw·30s 목록 TTL·updatedAt 키 상세캐시). 차이점:
//  - 인증은 호스트 단위: self-hosted GitLab이 흔하므로 게이트가
//    `glab auth status --hostname <host>`를 쓴다 (gate가 host를 받는 이유).
//  - 데이터는 GitLab REST 원형: 목록 = `glab mr list --output json`(REST MR
//    배열), 코멘트 = `glab api projects/:id/merge_requests/<iid>/notes`
//    (`:id`는 glab이 cwd의 repo로 치환). system 노트("added 1 commit" 등)는
//    사람 코멘트가 아니라 노이즈라 걸러낸다.
//  - checks: the REST list carries no pipeline, and `head_pipeline` is on the
//    single-MR GET only (one call per MR). So one GraphQL call reads every
//    listed MR's head pipeline at once; if it fails (an old self-managed
//    schema, a timeout) the list still shows, with no dot (checks null).
//  - the factory's reads and merge (laneFacts, defaultBranchCi, merge,
//    currentLogin) name the project and host on every call (`--hostname`,
//    the remote key's path), as GlabIssueService does, never the cwd's repo.
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
import { mergeBlock, type MergeBlock, type PrCheck, type PrCheckBucket, type PrLaneFacts, type PrMergeRequest, type PrReviewHead, type PrReviewRead, type PrWriteResult } from '../../shared/prReview';
import type { CiRollup } from '../pipe/handlers/factoryRead.rpc';

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 30_000;
const GLAB_TIMEOUT_MS = 10_000;
const LIST_LIMIT = 30;
const MAX_ENTRIES = 128;
/** How long a missing / found glab binary is believed before probing again. */
const GATE_TTL_MS = 5 * 60 * 1000;
/** How long `glab auth status --hostname` is believed, per host. */
const AUTH_TTL_MS = 60 * 1000;
/** A forced probe (Check again, refresh) answered this recently is reused. */
const FORCED_REUSE_MS = 3_000;

export const GLAB_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: cliPath(),
  // glab 비대화형 강제 — 프롬프트/페이저가 폴을 블록하면 안 된다(gh와 동일 계약).
  NO_PROMPT: '1',
  // The name glab reads now (NO_PROMPT is deprecated there, kept for older glab).
  GLAB_NO_PROMPT: '1',
  GLAB_PAGER: 'cat',
  NO_COLOR: '1',
};

// 캐시 키 — 파일시스템 대소문자 정책 반영(gh 경로와 동일). POSIX는 원형 유지.
function cacheKey(repoPath: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? repoPath.toLowerCase()
    : repoPath;
}

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer?: number },
) => Promise<{ stdout: string }>;

// ── GitLab REST 페이로드 매핑(순수, 테스트용 export) ─────────────────────────

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
  /** `full` is `group/subgroup/project!iid`: the project's full path, which
   *  the GraphQL `project(fullPath:)` lookup needs. */
  references?: { full?: string };
}

/** GitLab's PipelineStatusEnum → the 3-state rollup. MANUAL (blocked on a
 *  manual job) is unfinished, so pending; skipped or unknown → null. */
export function mapGlabPipelineStatus(status: string | null | undefined): PrSummary['checks'] {
  switch ((status ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILED': // cancelled counts as failing, as in GhPrService mapChecks
    case 'CANCELED':
      return 'failing';
    case 'CREATED':
    case 'WAITING_FOR_RESOURCE':
    case 'PREPARING':
    case 'WAITING_FOR_CALLBACK':
    case 'PENDING':
    case 'RUNNING':
    case 'CANCELING':
    case 'SCHEDULED':
    case 'MANUAL':
      return 'pending';
    default:
      return null;
  }
}

/** The project's full path from an MR's `references.full`, or null. */
export function glabProjectPath(item: GlabMrItem): string | null {
  const full = item.references?.full ?? '';
  const bang = full.lastIndexOf('!');
  const path = bang > 0 ? full.slice(0, bang) : '';
  return /^[\w.-]+(?:\/[\w.-]+)+$/.test(path) ? path : null;
}

/** The GraphQL query for the head pipelines of these MRs (iids are numbers). */
export function glabPipelinesQuery(iids: readonly number[]): string {
  const list = iids.map((n) => JSON.stringify(String(n))).join(',');
  return `query($fullPath: ID!) { project(fullPath: $fullPath) { mergeRequests(iids: [${list}]) { nodes { iid headPipeline { status } } } } }`;
}

/** iid → head-pipeline rollup from the GraphQL reply; an MR with no pipeline is absent. */
export function mapGlabPipelines(reply: unknown): Map<number, NonNullable<PrSummary['checks']>> {
  const out = new Map<number, NonNullable<PrSummary['checks']>>();
  const nodes = (reply as { data?: { project?: { mergeRequests?: { nodes?: unknown } } | null } } | null)
    ?.data?.project?.mergeRequests?.nodes;
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes as Array<{ iid?: unknown; headPipeline?: { status?: string } | null }>) {
    const iid = Number(n?.iid);
    const checks = mapGlabPipelineStatus(n?.headPipeline?.status);
    if (Number.isInteger(iid) && checks) out.set(iid, checks);
  }
  return out;
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
    // Filled in from the GraphQL head-pipeline read (fetchList); null = no dot.
    checks: null,
    // GitLab의 has_conflicts를 gh 계약(CONFLICTING) 어휘로 정규화. 부재는 ''.
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
  // gh 쪽과 동일 정규화: 봇 HTML 주석 마커 스트립 + 캡.
  const body = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (Buffer.byteLength(body, 'utf8') <= PR_COMMENT_BODY_CAP) return { body, truncated: false };
  return { body: body.slice(0, PR_COMMENT_BODY_CAP), truncated: true };
}

/** notes → 코멘트 스트림. system 노트(머지/커밋 자동기록)는 제외. */
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

// ── The factory's merge request reads and merge (pure halves) ───────────────

/** Reads and the merge name the project on every call; a big MR's file list
 *  is long. */
const FACTORY_TIMEOUT_MS = 15_000;
const FACTORY_MAX_BUFFER = 8 * 1024 * 1024;
/** Changed paths kept per read (the GitHub lane read's page). */
const LANE_FILES = 100;
/** Jobs read on the default branch (FACTORY_READ_LIMITS.CI_CHECKS). */
const CI_JOBS = 50;

/** host and project path (group/…/project) of a GitLab remote key, or null. */
export function glabProjectOfKey(key: string): { host: string; path: string } | null {
  const parts = key.split('/');
  if (parts.length < 3 || parts.some((p) => !/^[\w.-]+$/.test(p) || p === '.' || p === '..')) return null;
  return { host: parts[0], path: parts.slice(1).join('/') };
}

/**
 * One merge request's lane facts (PrLaneFacts) in one answer, so its head,
 * labels, files and head pipeline belong to one moment. A retried job counts
 * by its latest run only.
 */
export const GLAB_LANE_MR_QUERY = `query($fullPath: ID!, $iid: String!) { project(fullPath: $fullPath) { ciConfigPathOrDefault mergeRequest(iid: $iid) { iid title state draft sourceBranch targetBranch diffHeadSha sourceProjectId targetProjectId conflicts detailedMergeStatus mergedAt mergeCommitSha author { username } labels(first: 50) { pageInfo { hasNextPage } nodes { title } } diffStatsSummary { fileCount } diffStats { path } headPipeline { sha status mergeRequestEventType jobs(first: 100, retried: false) { pageInfo { hasNextPage } nodes { name status allowFailure webPath startedAt finishedAt stage { name } } } } } } }`;

/** The synthetic required check that fails while an MR changes which jobs
 *  run: the jobs are the MR head's own CI config, so a required job set is
 *  only evidence when the head did not write it. */
export const GLAB_CI_CONFIG_CHECK = 'ci-config-changed';
/** Its twin when the changed files were not all read (that cannot be ruled out). */
export const GLAB_CI_CONFIG_UNVERIFIED_CHECK = 'ci-config-unverified';

/** A changed path that can change the MR's pipeline: the project's CI config
 *  file (its own path, when it lives in this repository), anything under
 *  `.gitlab/`, or any YAML file — a local `include:` can live anywhere, so
 *  every YAML change is treated as one. */
export function glabCiConfigTouched(path: string, ciConfigPath: string): boolean {
  const p = path.replace(/^\.\//, '');
  const own = ciConfigPath.includes('@') || ciConfigPath.includes('://') ? '' : ciConfigPath.replace(/^\.\//, '');
  return /\.ya?ml$/i.test(p) || p.startsWith('.gitlab/') || (own !== '' && p === own);
}

/** The default branch's name. */
export const GLAB_ROOT_REF_QUERY = 'query($fullPath: ID!) { project(fullPath: $fullPath) { repository { rootRef } } }';

/** The head commit of `ref` and its newest pipeline on that ref. */
export const GLAB_CI_QUERY = `query($fullPath: ID!, $ref: String!) { project(fullPath: $fullPath) { repository { tree(ref: $ref) { lastCommit { sha committedDate pipelines(ref: $ref, first: 1) { nodes { status jobs(first: ${CI_JOBS}, retried: false) { count nodes { name status allowFailure } } } } } } } } }`;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The first GraphQL error's message, or null. */
export function glabGraphqlError(raw: unknown): string | null {
  const errors = rec(raw)?.errors;
  const first = Array.isArray(errors) ? rec(errors[0]) : null;
  return first && typeof first.message === 'string' ? first.message.slice(0, 300) : null;
}

function glabErrorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).trim().slice(0, 300);
}

/** A job's bucket. A manual job allowed to fail is optional (skipping); one
 *  that is not holds the pipeline (pending). */
export function glabJobBucket(status: unknown, allowFailure: boolean): PrCheckBucket {
  switch (text(status).toUpperCase()) {
    case 'SUCCESS':
      return 'pass';
    case 'FAILED':
      return 'fail';
    case 'CANCELED':
    case 'CANCELING':
      return 'cancel';
    case 'SKIPPED':
      return 'skipping';
    case 'MANUAL':
      return allowFailure ? 'skipping' : 'pending';
    default:
      return 'pending';
  }
}

/** GitLab's detailedMergeStatus (and conflicts) in the GitHub words the lane
 *  and mergeBlock read: mergeable MERGEABLE/CONFLICTING/UNKNOWN and
 *  mergeStateStatus CLEAN/DIRTY/BEHIND/DRAFT/UNSTABLE/BLOCKED/UNKNOWN. Any
 *  status not named here (approvals missing, discussions open, CI must pass,
 *  a policy) is BLOCKED. */
export function glabMergeState(detailed: unknown, conflicts: unknown): { mergeable: string; mergeStateStatus: string } {
  const d = text(detailed).toUpperCase();
  const computing = d === '' || d === 'CHECKING' || d === 'UNCHECKED' || d === 'PREPARING';
  const mergeable = conflicts === true || d === 'CONFLICT' ? 'CONFLICTING' : computing ? 'UNKNOWN' : 'MERGEABLE';
  const mergeStateStatus = d === 'MERGEABLE' ? 'CLEAN'
    : d === 'CONFLICT' ? 'DIRTY'
      : d === 'NEED_REBASE' ? 'BEHIND'
        : d === 'DRAFT_STATUS' ? 'DRAFT'
          : d === 'CI_STILL_RUNNING' ? 'UNSTABLE'
            : computing ? 'UNKNOWN' : 'BLOCKED';
  return { mergeable, mergeStateStatus };
}

/** GLAB_LANE_MR_QUERY's answer → PrLaneFacts (the MR's iid is its number),
 *  or null when it is not a merge request. `checksHeadOid` is the head
 *  pipeline's commit: a merged-results pipeline's is a merge commit, which
 *  laneFacts resolves to the head it tested. */
export function mapGlabLaneFacts(raw: unknown, host: string): PrLaneFacts | null {
  const mr = rec(rec(rec(rec(raw)?.data)?.project)?.mergeRequest);
  const number = Number(mr?.iid);
  if (!mr || !Number.isSafeInteger(number) || number < 1 || typeof mr.diffHeadSha !== 'string' || !mr.diffHeadSha) return null;
  const rawState = text(mr.state).toLowerCase();
  // `locked` is a merge in progress: LOCKED, neither open nor final, so the
  // executor settles it as uncertain and reads it again later.
  const state = rawState === 'opened' ? 'OPEN' : rawState === 'merged' ? 'MERGED' : rawState === 'closed' ? 'CLOSED' : rawState.toUpperCase();
  const labelsConn = rec(mr.labels);
  const labelNodes = Array.isArray(labelsConn?.nodes) ? (labelsConn.nodes as unknown[]) : [];
  const labels = labelNodes.map((l) => text(rec(l)?.title)).filter(Boolean);
  const stats = Array.isArray(mr.diffStats) ? (mr.diffStats as unknown[]) : null;
  const paths = (stats ?? []).map((s) => text(rec(s)?.path)).filter(Boolean);
  const fileCount = rec(mr.diffStatsSummary)?.fileCount;
  const pipeline = rec(mr.headPipeline);
  const jobsConn = rec(pipeline?.jobs);
  const jobNodes = Array.isArray(jobsConn?.nodes) ? (jobsConn.nodes as unknown[]) : [];
  const checks = jobNodes.flatMap((n): PrCheck[] => {
    const j = rec(n);
    const name = text(j?.name);
    if (!j || !name) return [];
    const allowFailure = j.allowFailure === true;
    const webPath = text(j.webPath);
    return [{
      name,
      workflow: text(rec(j.stage)?.name),
      bucket: glabJobBucket(j.status, allowFailure),
      link: webPath.startsWith('/') ? `https://${host}${webPath}` : '',
      ...(text(j.startedAt) ? { startedAt: text(j.startedAt) } : {}),
      ...(text(j.finishedAt) ? { completedAt: text(j.finishedAt) } : {}),
      // A job allowed to fail does not fail its pipeline: not required.
      isRequired: !allowFailure,
    }];
  });
  const filesTruncated = stats === null || paths.length > LANE_FILES || paths.length !== stats.length
    || (typeof fileCount === 'number' && fileCount > paths.length);
  const ciConfigPath = text(rec(rec(rec(raw)?.data)?.project)?.ciConfigPathOrDefault) || '.gitlab-ci.yml';
  const ciConfig = paths.some((p) => glabCiConfigTouched(p, ciConfigPath)) ? GLAB_CI_CONFIG_CHECK : filesTruncated ? GLAB_CI_CONFIG_UNVERIFIED_CHECK : null;
  const sourceId = mr.sourceProjectId;
  const targetId = mr.targetProjectId;
  return {
    number,
    state,
    isDraft: mr.draft === true,
    // Unreadable project ids count as a fork (GitHub's mapping does the same).
    isCrossRepository: !(typeof sourceId === 'number' && sourceId === targetId),
    headRefOid: mr.diffHeadSha,
    headRefName: text(mr.sourceBranch),
    baseRefName: text(mr.targetBranch),
    author: text(rec(mr.author)?.username) || null,
    ...glabMergeState(mr.detailedMergeStatus, mr.conflicts),
    ...(typeof mr.title === 'string' ? { title: mr.title } : {}),
    mergedAt: text(mr.mergedAt) || null,
    mergeCommitOid: text(mr.mergeCommitSha) || null,
    labels,
    // An unreadable page flag is not proof that every label was read.
    labelsTruncated: rec(labelsConn?.pageInfo)?.hasNextPage !== false || labels.length !== labelNodes.length,
    files: paths.slice(0, LANE_FILES),
    filesTruncated,
    checksHeadOid: text(pipeline?.sha) || null,
    checks: ciConfig ? [...checks, { name: ciConfig, workflow: 'wmux', bucket: 'fail' as const, link: '', isRequired: true }] : checks,
    // No pipeline at all reads as nothing truncated.
    checksTruncated: pipeline ? rec(jobsConn?.pageInfo)?.hasNextPage !== false || checks.length !== jobNodes.length : false,
  };
}

/** The head pipeline's status (GitLab's PipelineStatusEnum), or null with no
 *  head pipeline. */
export function glabHeadPipelineStatus(raw: unknown): string | null {
  const p = rec(rec(rec(rec(rec(raw)?.data)?.project)?.mergeRequest)?.headPipeline);
  return p ? text(p.status).toUpperCase() : null;
}

/** The head pipeline ran on a merge ref (merged results, a merge train): its
 *  commit is GitLab's merge of the head into the target. */
export function glabPipelineOnMergeRef(raw: unknown): boolean {
  const t = text(rec(rec(rec(rec(rec(raw)?.data)?.project)?.mergeRequest)?.headPipeline)?.mergeRequestEventType).toUpperCase();
  return t === 'MERGED_RESULT' || t === 'MERGE_TRAIN';
}

/** A job's state in the CI rollup's (GitHub's) words: a failure allowed to
 *  fail is NEUTRAL, so the read's failing list leaves it out. */
export function glabCiCheckState(status: unknown, allowFailure: boolean): string {
  switch (text(status).toUpperCase()) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILED':
      return allowFailure ? 'NEUTRAL' : 'FAILURE';
    case 'CANCELED':
    case 'CANCELING':
      return 'CANCELLED';
    case 'SKIPPED':
      return 'SKIPPED';
    case 'MANUAL':
      return allowFailure ? 'SKIPPED' : 'PENDING';
    case 'RUNNING':
      return 'IN_PROGRESS';
    default:
      return 'QUEUED';
  }
}

/** GLAB_CI_QUERY's answer → CiRollup: the branch head and its newest
 *  pipeline on the branch (none yet: state null, no checks). Null when the
 *  answer names no commit. */
export function mapGlabCiRollup(raw: unknown, branch: string): CiRollup | null {
  const commit = rec(rec(rec(rec(rec(rec(raw)?.data)?.project)?.repository)?.tree)?.lastCommit);
  if (!commit || typeof commit.sha !== 'string' || !commit.sha) return null;
  const nodes = rec(commit.pipelines)?.nodes;
  const pipeline = Array.isArray(nodes) ? rec(nodes[0]) : null;
  const jobs = rec(pipeline?.jobs);
  const jobNodes = Array.isArray(jobs?.nodes) ? (jobs.nodes as unknown[]) : [];
  const checks = jobNodes.flatMap((n) => {
    const j = rec(n);
    return j && text(j.name) ? [{ name: text(j.name), state: glabCiCheckState(j.status, j.allowFailure === true) }] : [];
  });
  const rollup = pipeline ? mapGlabPipelineStatus(text(pipeline.status)) : null;
  return {
    branch,
    headSha: commit.sha,
    committedAt: text(commit.committedDate) || null,
    state: rollup === 'passing' ? 'SUCCESS' : rollup === 'failing' ? 'FAILURE' : rollup === 'pending' ? 'PENDING' : null,
    checks,
    checksTotal: typeof jobs?.count === 'number' ? jobs.count : checks.length,
  };
}

/** Why a merge request cannot be squash-merged now, from a fresh lane read
 *  and its head pipeline's status, in mergeBlock's terms. Only jobs that may
 *  not fail hold it (GitLab passes a pipeline over an allowed failure; the
 *  CI-config check is one of them); a job list not read whole, a pipeline of
 *  another commit, no pipeline, or one not SUCCESS hold it too. */
export function glabMergeBlock(f: PrLaneFacts, pipelineStatus: string | null): MergeBlock | null {
  const head: PrReviewHead = {
    number: f.number, title: f.title ?? '', url: '', state: f.state, isDraft: f.isDraft,
    headRefOid: f.headRefOid, headRefName: f.headRefName, baseRefName: f.baseRefName,
    mergeable: f.mergeable ?? 'UNKNOWN', mergeStateStatus: f.mergeStateStatus ?? 'UNKNOWN',
  };
  const block = mergeBlock(head, f.checks.filter((c) => c.isRequired === true));
  if (block) return block;
  if (f.checksTruncated) return 'unknown';
  if (f.checksHeadOid !== f.headRefOid) return 'checks-pending';
  const rollup = mapGlabPipelineStatus(pipelineStatus);
  return rollup === 'passing' ? null : rollup === 'failing' ? 'checks-failing' : 'checks-pending';
}

/** The squash commit's subject when none is given: the title and the MR
 *  reference (`!n`; `#n` names an issue on GitLab). */
export function glabSquashSubject(title: string, iid: number): string {
  const t = title.replace(/\s+/g, ' ').trim() || `Merge request !${iid}`;
  return `${t} (!${iid})`;
}

/** A failed merge PUT → the write result. GitLab answers 409 when the head is
 *  not the `sha` sent, and 405/406/422 when the MR cannot merge now: neither
 *  merged anything. Any other failure may have, so it stays an error. */
export function glabMergeFailure(err: unknown): PrWriteResult {
  const e = err as { stderr?: string; message?: string };
  const full = (e?.stderr || e?.message || String(err)).trim();
  // The status is read from the whole output (glab may print a deprecation
  // notice first), and only from its `(HTTP nnn)`: a bare number can be the
  // MR's iid inside a network error's URL.
  const lines = full.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const status = /\(HTTP (\d{3})\)/.exec(full)?.[1] ?? '';
  const message = last.slice(0, 300);
  if (status === '409') return { ok: false, code: 'moved', message: 'the merge request has new commits since it was shown; review them first' };
  if (status === '405' || status === '406' || status === '422') return { ok: false, code: 'blocked', reason: 'blocked', message: `GitLab would not merge it now: ${message}` };
  return { ok: false, code: 'error', message };
}

/** The merge PUT's answer → the write result: only an MR that reads
 *  `merged` is a merge; anything else is an error (the executor records it
 *  uncertain and settles it from a later read). */
export function glabMergeAnswer(stdout: string, url: string): PrWriteResult {
  let state = '';
  try {
    state = text(rec(JSON.parse(stdout))?.state);
  } catch {
    state = '';
  }
  return state === 'merged' ? { ok: true, url } : { ok: false, code: 'error', message: `GitLab answered the merge without merging it (state: ${state || 'unreadable'})` };
}

/** `glab auth status`'s outcome for one host. */
export type GlabAuthProbe = 'ok' | 'signed-out' | 'unreachable';

/** PrGate, plus a host glab could not reach right now (transient). */
export type GlabConnection = PrGate | { ok: false; reason: 'unreachable'; message: string };

/** A failed `glab auth status` → a definite sign-out (no token for the host,
 *  or the host refused the token: 401/403), or `unreachable` for anything
 *  else (a timeout, DNS, a reset connection, a 5xx). */
export function glabAuthFailure(err: unknown): GlabAuthProbe {
  const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string | null };
  if (e?.killed || e?.signal) return 'unreachable';
  // glab wraps long lines, so the wording is matched on collapsed whitespace.
  const out = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}\n${e?.message ?? ''}`.replace(/\s+/g, ' ');
  return /\b40[13]\b|has not been authenticated|no gitlab instances have been authenticated|no token|not logged in/i.test(out) ? 'signed-out' : 'unreachable';
}

// ── 서비스 본체 ───────────────────────────────────────────────────────────────

interface ListEntry {
  value: PrListResult;
  fetchedAt: number;
  pending: Promise<PrListResult> | null;
}

export class GlabPrService implements PrProvider {
  private listCache = new Map<string, ListEntry>();
  /** key = repo\0iid — updatedAt 불변이면 notes 재fetch 생략. + url 동봉 캐시. */
  private detailCache = new Map<string, { updatedAt: string; value: PrDetailResult }>();
  /** iid → web_url (목록에서 채움 — notes의 앵커 URL로 쓴다). */
  private urlByIid = new Map<string, string>();
  private glabMissingAt: number | null = null;
  private glabFoundAt: number | null = null;
  /** Per host: the last `glab auth status` answer, and a probe in flight. */
  private authAt = new Map<string, { ok: boolean; at: number }>();
  private authPending = new Map<string, Promise<GlabAuthProbe>>();

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

  // Each probe is TTL-cached like GhPrService's: every 30 s list poll asks for
  // the gate, and `glab auth status` may go to the network. `force` (Check
  // again) re-probes both; back-to-back forced reads share one probe.
  async gate(repoPath: string, host: string, force = false): Promise<PrGate> {
    const c = await this.connection(repoPath, host, force);
    // The Git page knows two blocked states; an unreachable host shows its own words.
    return c.ok || c.reason !== 'unreachable' ? c : { ok: false, reason: 'unauthenticated', message: c.message };
  }

  /** gate, telling apart a host glab could not reach right now
   *  (`unreachable`: transient, never cached) from a definite missing glab or
   *  a definite sign-out. The factory's read gate asks the owner only for
   *  the definite ones. */
  async connection(repoPath: string, host: string, force = false): Promise<GlabConnection> {
    const now = this.now();
    const missing = { ok: false as const, reason: 'cli-missing' as const, message: 'GitLab CLI (glab) is not installed' };
    if (!force && this.glabMissingAt !== null && now - this.glabMissingAt < GATE_TTL_MS) return missing;
    if (force || this.glabFoundAt === null || now - this.glabFoundAt >= GATE_TTL_MS) {
      try {
        await this.glab(['--version'], repoPath);
        this.glabMissingAt = null;
        this.glabFoundAt = this.now();
      } catch (err) {
        this.glabFoundAt = null;
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          this.glabMissingAt = this.now();
          return missing;
        }
        return { ok: false, reason: 'unreachable', message: 'the GitLab CLI (glab) could not be run just now' };
      }
    }
    const auth = this.authAt.get(host);
    const fresh = !!auth && now - auth.at < (force ? FORCED_REUSE_MS : AUTH_TTL_MS);
    // Auth is per host (self-managed GitLab).
    const probe: GlabAuthProbe = fresh ? (auth.ok ? 'ok' : 'signed-out') : await this.probeAuth(repoPath, host);
    if (probe === 'unreachable') return { ok: false, reason: 'unreachable', message: `GitLab on ${host} could not be reached just now` };
    if (probe === 'signed-out') {
      return {
        ok: false,
        reason: 'unauthenticated',
        message: `GitLab CLI is not authenticated for ${host} — run \`glab auth login --hostname ${host}\``,
      };
    }
    return { ok: true };
  }

  /** `glab auth status` for a host. Only a definite answer is cached: a
   *  failure that is no sign-out (a timeout, a network error) is
   *  `unreachable` and asked again next time. */
  private probeAuth(repoPath: string, host: string): Promise<GlabAuthProbe> {
    const running = this.authPending.get(host);
    if (running) return running;
    const probe = this.glab(['auth', 'status', '--hostname', host], repoPath)
      .then((): GlabAuthProbe => 'ok', (err: unknown) => glabAuthFailure(err))
      .then((result) => {
        if (result !== 'unreachable') this.authAt.set(host, { ok: result === 'ok', at: this.now() });
        this.authPending.delete(host);
        return result;
      });
    this.authPending.set(host, probe);
    return probe;
  }

  // force=true: 수동 새로고침 — TTL 캐시를 건너뛴다(gh 경로와 동일 계약).
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
      // REST MR 배열 원형 — glab mr list의 json 출력(open MR 기본).
      const { stdout } = await this.glab(
        ['mr', 'list', '--per-page', String(LIST_LIMIT), '--output', 'json'],
        repoPath,
      );
      const parsed = JSON.parse(stdout) as GlabMrItem[];
      const items = Array.isArray(parsed) ? parsed : [];
      const mapped = items
        .map(mapGlabMrItem)
        .filter((p): p is PrSummary => p !== null);
      for (const p of mapped) this.urlByIid.set(`${cacheKey(repoPath)}\0${p.number}`, p.url);
      const pipelines = await this.readPipelines(repoPath, items, mapped);
      const prs = mapped.map((p) => {
        const checks = pipelines.get(p.number);
        return checks ? { ...p, checks } : p;
      });
      return { ok: true, prs };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, error: (e.stderr || e.message || String(err)).slice(0, 300) };
    }
  }

  /** Head-pipeline rollups for the listed MRs, in one GraphQL call. Any
   *  failure reads as "no pipelines": the list matters more than its dots. */
  private async readPipelines(
    repoPath: string,
    items: readonly GlabMrItem[],
    prs: readonly PrSummary[],
  ): Promise<Map<number, NonNullable<PrSummary['checks']>>> {
    const fullPath = items.map(glabProjectPath).find((p): p is string => p !== null);
    if (!fullPath || prs.length === 0) return new Map();
    try {
      const { stdout } = await this.glab(
        ['api', 'graphql', '-f', `query=${glabPipelinesQuery(prs.map((p) => p.number))}`, '-f', `fullPath=${fullPath}`],
        repoPath,
      );
      return mapGlabPipelines(JSON.parse(stdout));
    } catch {
      return new Map();
    }
  }

  async prDetail(repoPath: string, number: number, updatedAt: string): Promise<PrDetailResult> {
    const key = `${cacheKey(repoPath)}\0${number}`;
    const cached = this.detailCache.get(key);
    if (cached && cached.updatedAt === updatedAt && cached.value.ok) return cached.value;
    try {
      // `:id`는 glab이 cwd의 repo(URL-encoded full path)로 치환한다.
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

  // ── The factory's reads and merge (named project, never cached) ──────────

  private api(host: string, args: string[], cwd: string): Promise<{ stdout: string }> {
    return this.exec(process.platform === 'win32' ? 'glab.exe' : 'glab', ['api', '--hostname', host, ...args], {
      cwd,
      timeout: FACTORY_TIMEOUT_MS,
      env: GLAB_ENV,
      windowsHide: true,
      maxBuffer: FACTORY_MAX_BUFFER,
    });
  }

  private async graphql(host: string, query: string, vars: Record<string, string>, cwd: string): Promise<unknown> {
    const fields = Object.entries(vars).flatMap(([k, v]) => ['-f', `${k}=${v}`]);
    const { stdout } = await this.api(host, ['graphql', '-f', `query=${query}`, ...fields], cwd);
    return JSON.parse(stdout) as unknown;
  }

  private static project(key: string): { host: string; path: string } {
    const project = glabProjectOfKey(key);
    if (!project) throw new Error(`not a GitLab group/project remote: ${key}`);
    return project;
  }

  /** The lane read of merge request `iid` (GLAB_LANE_MR_QUERY): always
   *  fresh. A merged-results pipeline's merge commit counts as the head's
   *  pipeline when the head is one of its parents. */
  async laneFacts(repoPath: string, key: string, iid: number): Promise<PrReviewRead<PrLaneFacts>> {
    const r = await this.readLane(repoPath, key, iid);
    return r.ok ? { ok: true, value: r.value.facts } : r;
  }

  /** laneFacts with the head pipeline's status (the merge's gate reads it).
   *  Any GraphQL error, even beside data, fails the read: a partial answer
   *  is not a fact. */
  private async readLane(repoPath: string, key: string, iid: number): Promise<PrReviewRead<{ facts: PrLaneFacts; pipelineStatus: string | null }>> {
    try {
      const project = GlabPrService.project(key);
      const raw = await this.graphql(project.host, GLAB_LANE_MR_QUERY, { fullPath: project.path, iid: String(iid) }, repoPath);
      const partial = glabGraphqlError(raw);
      if (partial) throw new Error(partial);
      const facts = mapGlabLaneFacts(raw, project.host);
      if (!facts) throw new Error(`could not read merge request !${iid}`);
      const pipelineStatus = glabHeadPipelineStatus(raw);
      if (facts.checksHeadOid && facts.checksHeadOid !== facts.headRefOid && glabPipelineOnMergeRef(raw)) {
        const parents = await this.commitParents(project, facts.checksHeadOid, repoPath);
        if (parents.includes(facts.headRefOid)) return { ok: true, value: { facts: { ...facts, checksHeadOid: facts.headRefOid }, pipelineStatus } };
      }
      return { ok: true, value: { facts, pipelineStatus } };
    } catch (err) {
      return { ok: false, code: 'error', message: glabErrorText(err) };
    }
  }

  private async commitParents(project: { host: string; path: string }, sha: string, cwd: string): Promise<string[]> {
    if (!/^[0-9a-f]{40}$/.test(sha)) return [];
    try {
      const { stdout } = await this.api(project.host, [`projects/${encodeURIComponent(project.path)}/repository/commits/${sha}`], cwd);
      const parents = rec(JSON.parse(stdout))?.parent_ids;
      return Array.isArray(parents) ? parents.filter((p): p is string => typeof p === 'string') : [];
    } catch {
      return [];
    }
  }

  /** The project's default branch (the task gate's base). Never cached. */
  async defaultBranch(cwd: string, key: string): Promise<PrReviewRead<string>> {
    try {
      const project = GlabPrService.project(key);
      const root = await this.graphql(project.host, GLAB_ROOT_REF_QUERY, { fullPath: project.path }, cwd);
      const branch = text(rec(rec(rec(rec(root)?.data)?.project)?.repository)?.rootRef);
      if (!branch) throw new Error(glabGraphqlError(root) ?? 'the repository has no default branch');
      return { ok: true, value: branch };
    } catch (err) {
      return { ok: false, code: 'error', message: glabErrorText(err) };
    }
  }

  /** MRs merged from `branch` into `base` (at most `limit`), as
   *  GhPrReviewService.mergedOfBranch: the task gate's evidence that a
   *  task's branch merged. Unreadable project ids read as a fork. */
  async mergedOfBranch(cwd: string, key: string, branch: string, base: string, limit = 20): Promise<PrReviewRead<Array<{ pr: number; base: string; headSha: string; cross: boolean }>>> {
    try {
      const project = GlabPrService.project(key);
      for (const ref of [branch, base]) if (!ref || ref.startsWith('-')) throw new Error(`not a branch name: ${ref}`);
      const q = new URLSearchParams({ state: 'merged', source_branch: branch, target_branch: base, per_page: String(limit) });
      const { stdout } = await this.api(project.host, [`projects/${encodeURIComponent(project.path)}/merge_requests?${q.toString()}`], cwd);
      const raw = JSON.parse(stdout) as unknown;
      if (!Array.isArray(raw)) return { ok: true, value: [] };
      return {
        ok: true,
        value: raw.flatMap((r) => {
          const o = rec(r);
          return o && typeof o.iid === 'number' && typeof o.target_branch === 'string' && typeof o.sha === 'string'
            ? [{ pr: o.iid, base: o.target_branch, headSha: o.sha, cross: !(typeof o.source_project_id === 'number' && o.source_project_id === o.target_project_id) }]
            : [];
        }),
      };
    } catch (err) {
      return { ok: false, code: 'error', message: glabErrorText(err) };
    }
  }

  /** The default branch's head and its newest pipeline there (two reads:
   *  the branch name, then its head with the pipeline). */
  async defaultBranchCi(repoPath: string, key: string): Promise<CiRollup | { error: string }> {
    try {
      const project = GlabPrService.project(key);
      const root = await this.graphql(project.host, GLAB_ROOT_REF_QUERY, { fullPath: project.path }, repoPath);
      const branch = text(rec(rec(rec(rec(root)?.data)?.project)?.repository)?.rootRef);
      if (!branch) return { error: glabGraphqlError(root) ?? 'the default branch could not be read' };
      const raw = await this.graphql(project.host, GLAB_CI_QUERY, { fullPath: project.path, ref: branch }, repoPath);
      const partial = glabGraphqlError(raw);
      if (partial) return { error: partial };
      return mapGlabCiRollup(raw, branch) ?? { error: 'the default branch could not be read' };
    } catch (err) {
      return { error: glabErrorText(err) };
    }
  }

  /** The login glab signs in as on the key's host now, lowercased; never
   *  cached, so an account switch stops the next merge. */
  async currentLogin(repoPath: string, key: string): Promise<string | null> {
    try {
      return await this.loginOnHost(GlabPrService.project(key).host, repoPath);
    } catch {
      return null;
    }
  }

  /** The login glab signs in as on `host` now, lowercased, or null. */
  async loginOnHost(host: string, cwd: string): Promise<string | null> {
    try {
      const { stdout } = await this.api(host, ['user'], cwd);
      return text(rec(JSON.parse(stdout))?.username).toLowerCase() || null;
    } catch {
      return null;
    }
  }

  /**
   * Squash-merge merge request `iid` at `req.expectHead`, as the GitHub
   * merge does: a fresh read right before it refuses another head (`moved`)
   * or an MR that cannot merge now (glabMergeBlock), `authorize` is asked
   * last, and the PUT sends `sha` so GitLab itself refuses a head that moved
   * in between (409). An empty subject takes the title and `!iid`.
   */
  async merge(repoPath: string, key: string, iid: number, req: PrMergeRequest, authorize?: () => string | null): Promise<PrWriteResult> {
    let project: { host: string; path: string };
    try {
      project = GlabPrService.project(key);
    } catch (err) {
      return { ok: false, code: 'invalid', message: glabErrorText(err) };
    }
    const read = await this.readLane(repoPath, key, iid);
    if (!read.ok) return { ok: false, code: 'error', message: read.message };
    const { facts: f, pipelineStatus } = read.value;
    // A merge in progress may still land: not a refusal.
    if (f.state === 'LOCKED') return { ok: false, code: 'error', message: 'a merge of this merge request is in progress' };
    if (f.state !== 'OPEN') return { ok: false, code: 'blocked', reason: 'not-open', message: 'the merge request is not open' };
    if (f.headRefOid !== req.expectHead) {
      return { ok: false, code: 'moved', message: 'the merge request has new commits since it was shown; review them first', headRefOid: f.headRefOid };
    }
    const block = glabMergeBlock(f, pipelineStatus);
    if (block) return { ok: false, code: 'blocked', reason: block, message: `the merge request cannot be merged now (${block})` };
    const denied = authorize?.() ?? null;
    if (denied) return { ok: false, code: 'invalid', message: `the merge is not authorized now (${denied})` };
    const subject = req.subject.trim() || glabSquashSubject(f.title ?? '', iid);
    let answer: string;
    try {
      ({ stdout: answer } = await this.api(project.host, [
        '-X', 'PUT', `projects/${encodeURIComponent(project.path)}/merge_requests/${iid}/merge`,
        // `=` forms: a subject starting with "-" stays a value.
        '-f', `sha=${req.expectHead}`, '-F', 'squash=true', '-f', `squash_commit_message=${subject}`,
      ], repoPath));
    } catch (err) {
      return glabMergeFailure(err);
    }
    return glabMergeAnswer(answer, `https://${project.host}/${project.path}/-/merge_requests/${iid}`);
  }

  private evict(cache: Map<string, unknown>): void {
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
}

/** 프로세스 전역 싱글턴 — gh 쪽(ghPrService)과 동일 수명 계약. */
export const glabPrService = new GlabPrService();
