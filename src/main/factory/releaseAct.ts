// ─── A release the owner approves: what main reads on GitHub, and the rules ─
//
// A `release` act (shared/botApproval.ts ApprovalReleaseAct) publishes one
// tag at one commit of the default branch, in one of two modes, decided when
// the bot asks from the workflows at that commit (a commit's contents never
// change, so neither does the mode):
//
//   workflow  a workflow there runs on pushing this tag (its `on.push.tags`
//             or `tags-ignore` take it): main pushes the tag alone (`POST
//             git/refs`), and that workflow builds and publishes the release.
//   release   no workflow there names this tag: main publishes it itself, a
//             draft first (`draft: true` makes no tag, and a 4xx on it leaves
//             none), its id journaled on the outbox row, then `PATCH` with
//             the approved fields and `draft: false`. Never one `POST
//             /releases` with `draft: false`: GitHub was measured answering
//             that 422 and creating the tag all the same, which starts the
//             repository's tag workflows.
//
// A workflow with a `tags:` list that does not take this tag, while none
// takes it, refuses the request (`tag-not-matching-release-workflow`):
// pushing it would publish nothing. A workflow with no push filter runs on
// the tag push too, one on `create` when the tag is made, and in `release`
// mode one on `release` when it is published: the card names them. A
// workflow file that cannot be read, or has a shape this reading does not
// know, refuses the request rather than guessing which mode is safe.
//
// The reads fail closed: a listing that is not whole (a page that failed,
// more pages than LIST_PAGES_MAX) proves nothing is there, and a symlink or
// a submodule where a file is read is not read through. Names GitHub gave
// (the default branch, a workflow's file name) are percent-encoded into the
// endpoint; the tag and the SHA are already plain (RELEASE_TAG_RE, 40 hex).

import { parse as parseYaml } from 'yaml';
import type { GhActPort } from '../github/GhActService';
import type { ApprovalReleaseAct } from '../../shared/botApproval';
import { normalizeActText } from './actPayload';
import { failed, isFail, loginOf, readPaged, readRefusal, rec, repoPath, str, unreadable, type Read, type ReadFail } from './actRead';

type RepoPath = { host: string; base: string };

/** Workflow files read from GitHub at once (each read is one gh process). */
const BLOBS_AT_ONCE = 8;

/** Workflow files read at most; a repository with more cannot be read whole. */
const WORKFLOWS_MAX = 100;

// ── The tag ──────────────────────────────────────────────────────────────

/** One ref segment: what `git check-ref-format` takes, in plain characters. */
export const RELEASE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** Why a tag name cannot be a release's tag, or null. Pure. */
export function releaseTagProblem(tag: string): string | null {
  if (!RELEASE_TAG_RE.test(tag)) return 'tagName is one ref segment: letters, digits, ".", "_" and "-", starting with a letter or digit, at most 100 characters';
  if (tag.includes('..') || tag.endsWith('.lock') || tag.endsWith('.')) return 'tagName may not hold "..", or end in ".lock" or "."';
  // The version and prerelease checks read `v<semver>`: a capital V would pass them by.
  if (/^V\d/.test(tag)) return 'a version tag starts with a lowercase v (v1.2.3)';
  return null;
}

const SEMVER_RE = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The semver a `v?<semver>` tag names (without `v` or build metadata), or null. Pure. */
export function tagVersion(tag: string): string | null {
  return SEMVER_RE.exec(tag)?.[1] ?? null;
}

/** Whether the tag reads as a prerelease: a semver with a prerelease part
 *  does, a tag with no `-` does not; any other tag says nothing (null). Pure. */
export function tagPrereleaseShape(tag: string): boolean | null {
  const m = SEMVER_RE.exec(tag);
  if (m) return m[2] !== undefined;
  return tag.includes('-') ? null : false;
}

// ── Workflows: which run on a tag push, which on a push to a branch ─────

/** `on.push` of one workflow, as GitHub reads it: the filters it names
 *  (`{}` when it names none: every branch and every tag). `paths`: it names
 *  `paths` or `paths-ignore`, so a push to a branch may not run it. */
export interface PushFilter {
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: true;
}

export interface WorkflowPush {
  path: string;
  /** Null: the workflow does not run on a push. */
  push: PushFilter | null;
  /** `on.release`: `true` with no `types` (every type), else its types. */
  release?: true | string[];
  /** It runs when a tag is created (`on.create`, which takes no filter). */
  create?: boolean;
}

/** Whether publishing a draft starts a workflow on `on.release`: with no
 *  `types`, or with `published`, or `released` (a release) or `prereleased`
 *  (a prerelease). `created` is not fired for a draft. Pure. */
export function runsOnPublish(release: true | string[] | undefined, prerelease: boolean): boolean {
  if (release === undefined) return false;
  return release === true || release.includes('published') || release.includes(prerelease ? 'prereleased' : 'released');
}

/** One filter pattern as a regular expression, in GitHub's syntax: `*` any
 *  run without `/`, `**` any run, `?` and `+` zero-or-one and one-or-more of
 *  the character before, `[…]` a class of plain characters and ranges, `\`
 *  escapes. Throws on anything else (the workflow is not read), a `?` or `+`
 *  after a `*` included. Pure. */
export function filterRegex(pattern: string): RegExp {
  let out = '';
  let atom = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      i += 1;
      if (i >= pattern.length) throw new Error(`a filter ends in "\\": ${pattern}`);
      out += pattern[i].replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
      atom = true;
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else out += '[^/]*';
      atom = false;
    } else if (c === '?' || c === '+') {
      if (!atom) throw new Error(`"${c}" follows no character in the filter ${pattern}`);
      out += c;
      atom = false;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      const body = end > i ? pattern.slice(i + 1, end) : '';
      if (!/^[A-Za-z0-9._-]+$/.test(body)) throw new Error(`a character class this reading does not know in ${pattern}`);
      out += `[${body.replace(/\./g, '\\.')}]`;
      i = end;
      atom = true;
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
      atom = true;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Whether a name passes a `branches` / `tags` list: patterns in order, a
 *  `!pattern` taking back what an earlier one matched. Pure. */
function listMatches(patterns: readonly string[], name: string): boolean {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (filterRegex(p.slice(1)).test(name)) hit = false;
    } else if (filterRegex(p).test(name)) hit = true;
  }
  return hit;
}

function anyMatches(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => filterRegex(p).test(name));
}

/** Whether a parsed YAML value holds a `<<` key anywhere: a merge key, which
 *  YAML 1.2 reads as a plain key, so the filters it brings would be lost. */
function holdsMergeKey(v: unknown, depth = 0): boolean {
  if (depth > 64 || !v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((e) => holdsMergeKey(e, depth + 1));
  return Object.entries(v as Record<string, unknown>).some(([k, e]) => k === '<<' || holdsMergeKey(e, depth + 1));
}

/** What a workflow's `on` says of a release: its `on.push` (null when it
 *  does not run on a push), whether publishing a release runs it
 *  (`on.release` with no `types`, or one publishing fires), and whether
 *  creating a tag does (`on.create`). Throws on a shape this reading does
 *  not know (fail closed). Pure. */
export function workflowOn(text: string): { push: PushFilter | null; release?: true | string[]; create: boolean } {
  const doc = rec(parseYaml(text) as unknown);
  if (!doc || !('on' in doc)) throw new Error('it has no "on"');
  const on = doc.on;
  if (holdsMergeKey(on)) throw new Error('its "on" uses a YAML merge key ("<<")');
  if (typeof on === 'string') return { push: on === 'push' ? {} : null, ...(on === 'release' ? { release: true as const } : {}), create: on === 'create' };
  if (Array.isArray(on)) {
    if (!on.every((e) => typeof e === 'string')) throw new Error('its "on" list holds something other than event names');
    return { push: on.includes('push') ? {} : null, ...(on.includes('release') ? { release: true as const } : {}), create: on.includes('create') };
  }
  const events = rec(on);
  if (!events) throw new Error('its "on" is not an event, a list or a map');
  return {
    push: 'push' in events ? pushFilter(events.push) : null, ...('release' in events ? { release: releaseTypes(events.release) } : {}), create: 'create' in events,
  };
}

/** An `on.release`: `true` with no `types`, else its types. Pure. */
function releaseTypes(v: unknown): true | string[] {
  if (v === null) return true;
  const r = rec(v);
  if (!r) throw new Error('its "on.release" is not a map');
  const types = r.types;
  if (types === undefined) return true;
  const list = typeof types === 'string' ? [types] : types;
  if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) throw new Error('its "on.release.types" is not a list of types');
  return list as string[];
}

/** One `on.push` value as filters. Throws on a shape this reading does not know. Pure. */
function pushFilter(value: unknown): PushFilter {
  if (value === null) return {};
  const push = rec(value);
  if (!push) throw new Error('its "on.push" is not a map');
  const list = (key: string): string[] | undefined => {
    const v = push[key];
    if (v === undefined) return undefined;
    if (typeof v === 'string') return [v];
    if (Array.isArray(v) && v.every((e) => typeof e === 'string')) return v as string[];
    throw new Error(`its "on.push.${key}" is not a list of patterns`);
  };
  const out: PushFilter = {};
  const branches = list('branches');
  const branchesIgnore = list('branches-ignore');
  const tags = list('tags');
  const tagsIgnore = list('tags-ignore');
  if (branches && branchesIgnore) throw new Error('it names both branches and branches-ignore');
  if (tags && tagsIgnore) throw new Error('it names both tags and tags-ignore');
  if (branches) out.branches = branches;
  if (branchesIgnore) out.branchesIgnore = branchesIgnore;
  if (tags) out.tags = tags;
  if (tagsIgnore) out.tagsIgnore = tagsIgnore;
  if (list('paths') || list('paths-ignore')) out.paths = true;
  // Every pattern is read now, so a match later cannot throw.
  for (const p of [...(branches ?? []), ...(tags ?? [])]) filterRegex(p.startsWith('!') ? p.slice(1) : p);
  for (const p of [...(branchesIgnore ?? []), ...(tagsIgnore ?? [])]) {
    if (p.startsWith('!')) throw new Error(`"!" in an ignore list: ${p}`);
    filterRegex(p);
  }
  return out;
}

/** Whether pushing this tag runs the workflow. A push with no filters runs
 *  on every tag; one that names only branches runs on none. Pure. */
export function runsOnTag(push: PushFilter | null, tag: string): boolean {
  if (!push) return false;
  if (push.tags) return listMatches(push.tags, tag);
  if (push.tagsIgnore) return !anyMatches(push.tagsIgnore, tag);
  return push.branches === undefined && push.branchesIgnore === undefined;
}

/** Whether a push to this branch runs the workflow. Pure. */
export function runsOnBranch(push: PushFilter | null, branch: string): boolean {
  if (!push) return false;
  if (push.branches) return listMatches(push.branches, branch);
  if (push.branchesIgnore) return !anyMatches(push.branchesIgnore, branch);
  return push.tags === undefined && push.tagsIgnore === undefined;
}

/** A release workflow for this tag: its push lists the tags it runs on, and
 *  the list takes this one. A workflow that only leaves some tags out
 *  (`tags-ignore`) runs on this tag push too, but is no release workflow:
 *  the card names it with the others that also run. Pure. */
export function tagWorkflowFor(push: PushFilter | null, tag: string): boolean {
  return !!push?.tags && listMatches(push.tags, tag);
}

/** The mode of a release of this tag over these workflows: `workflow` with
 *  the workflows whose `tags` list takes it; the refusal when a workflow
 *  lists the tags it runs on and none takes this one; else `release`. Pure. */
export function releaseMode(workflows: readonly WorkflowPush[], tag: string): { mode: 'workflow'; workflows: string[] } | { mode: 'release' } | { refusal: 'tag-not-matching-release-workflow' } {
  const run = workflows.filter((w) => tagWorkflowFor(w.push, tag)).map((w) => w.path).sort();
  if (run.length > 0) return { mode: 'workflow', workflows: run };
  return workflows.some((w) => w.push?.tags !== undefined) ? { refusal: 'tag-not-matching-release-workflow' } : { mode: 'release' };
}

/** What else starts a workflow when the act runs: the tag push, the tag's
 *  creation, and (`release` mode, where main publishes) the release. */
export type AlsoRunsOn = 'tag-push' | 'tag-create' | 'release-published';

export interface AlsoRuns {
  path: string;
  on: AlsoRunsOn[];
}

/** The workflows other than the release workflow that the act starts, and
 *  by what: the tag push (no push filter, or a `tags-ignore` that leaves
 *  this tag in), the tag's creation, publishing the release. They run,
 *  though they are not the release workflow (the card names them). Pure. */
export function alsoRunsOn(workflows: readonly WorkflowPush[], tag: string, mode: 'workflow' | 'release', prerelease: boolean): AlsoRuns[] {
  const out: AlsoRuns[] = [];
  for (const w of workflows) {
    if (tagWorkflowFor(w.push, tag)) continue;
    const on: AlsoRunsOn[] = [];
    if (runsOnTag(w.push, tag)) on.push('tag-push');
    if (w.create) on.push('tag-create');
    if (mode === 'release' && runsOnPublish(w.release, prerelease)) on.push('release-published');
    if (on.length > 0) out.push({ path: w.path, on });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The workflows a push to the default branch surely runs at the commit
 *  (one with path filters may not run), by path: each must have run on
 *  that push before the commit's checks count as passed. Pure. */
export function pushWorkflowsOf(workflows: readonly WorkflowPush[], branch: string): string[] {
  return workflows.filter((w) => runsOnBranch(w.push, branch) && !w.push?.paths).map((w) => w.path).sort();
}

// ── Checks ───────────────────────────────────────────────────────────────

/** What the checks on a commit say: every check run, every latest
 *  workflow run done and passed (or neutral, skipped), and the combined
 *  status success or no statuses at all. */
export type ReleaseChecks = 'passed' | 'failed' | 'running' | 'none' | 'not-started';

const CONCLUSION_OK: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped']);

type Run = { status: string; conclusion: string | null };

/** A workflow run: a check, with the event and the ref it ran for. */
type WorkflowRun = Run & { event: string; branch: string; path: string };

/** The latest attempt of each workflow's runs (by workflow, then the newest
 *  run, then its latest attempt). Pure. */
export function latestPerWorkflow<T extends { workflowId: string; id: number; attempt: number }>(runs: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const r of runs) {
    const b = best.get(r.workflowId);
    if (!b || r.id > b.id || (r.id === b.id && r.attempt > b.attempt)) best.set(r.workflowId, r);
  }
  return [...best.values()];
}

/** The workflows of `expected` with no push run on the default branch
 *  (`branch`) among these runs. Pure. */
export function missingPushRuns(workflowRuns: readonly WorkflowRun[], expected: readonly string[], branch: string): string[] {
  const ran = (path: string): boolean => workflowRuns.some((r) => r.event === 'push' && r.branch === branch && (r.path === path || r.path.startsWith(`${path}@`)));
  return expected.filter((w) => !ran(w));
}

/** The verdict over what GitHub listed: check runs, the combined status, and
 *  the latest run of each workflow (a queued run has no check run yet).
 *  `expected`: the workflows a push to the default branch (`branch`) surely
 *  ran at the commit; while one of them has no push run on that branch, the
 *  commit's push CI has not run, whatever other checks passed (a bot's, a
 *  deploy preview's, another workflow's). Pure. */
export function checksVerdict(o: { runs: readonly Run[]; status: { state: string; total: number }; workflowRuns: readonly WorkflowRun[]; expected: readonly string[]; branch: string }): ReleaseChecks {
  const bad = (r: Run): boolean => r.status === 'completed' && !CONCLUSION_OK.has(r.conclusion ?? '');
  const running = (r: Run): boolean => r.status !== 'completed';
  // GitHub answers `pending` for a commit with no statuses: read the count.
  const statuses = o.status.total > 0;
  if (o.runs.some(bad) || o.workflowRuns.some(bad) || (statuses && (o.status.state === 'failure' || o.status.state === 'error'))) return 'failed';
  if (o.runs.some(running) || o.workflowRuns.some(running) || (statuses && o.status.state !== 'success')) return 'running';
  if (missingPushRuns(o.workflowRuns, o.expected, o.branch).length > 0) return 'not-started';
  return o.runs.length > 0 || o.workflowRuns.length > 0 || statuses ? 'passed' : 'none';
}

/** The run-time refusal for a verdict, or null. Pure. */
export function checksRefusal(c: ReleaseChecks): string | null {
  return c === 'failed' ? 'checks-failing' : c === 'running' ? 'checks-pending' : c === 'not-started' ? 'checks-not-started' : null;
}

// ── Versions ─────────────────────────────────────────────────────────────

/** Why the versions at the commit are not the tag's (`problem`, or null):
 *  package.json's `version`, and package-lock.json's top-level `version` and
 *  `packages[""].version`, each where it is there; and package.json's
 *  version as read (`version`, when it is a string). Throws on a file that
 *  is not JSON. Pure. */
export function versionProblem(tag: string, pkg: string | null, lock: string | null): { problem: string | null; version: string | null } {
  const want = tagVersion(tag);
  if (!want) return { problem: null, version: null };
  const read = (text: string | null, what: string): Record<string, unknown> | null => {
    if (text === null) return null;
    try {
      return rec(JSON.parse(text) as unknown);
    } catch {
      throw new Error(`${what} is not JSON`);
    }
  };
  const p = read(pkg, 'package.json');
  const l = read(lock, 'package-lock.json');
  const found: Array<[string, unknown]> = [];
  if (p && 'version' in p) found.push(['package.json', p.version]);
  if (l && 'version' in l) found.push(['package-lock.json', l.version]);
  const root = rec(rec(l?.packages)?.['']);
  if (root && 'version' in root) found.push(['package-lock.json packages[""]', root.version]);
  const version = typeof p?.version === 'string' ? p.version : null;
  for (const [where, v] of found) {
    if (v !== want) return { problem: `${where} says ${typeof v === 'string' ? v : JSON.stringify(v)}, the tag says ${want}`, version };
  }
  return { problem: null, version };
}

// ── GitHub's answers ─────────────────────────────────────────────────────

/** A release as GitHub lists it. */
export interface GhRelease {
  id: number;
  tagName: string;
  draft: boolean;
  prerelease: boolean;
  author: string | null;
  url: string;
  target: string;
  name: string;
  body: string;
}

export function mapRelease(value: unknown): GhRelease | null {
  const v = rec(value);
  if (!v || !Number.isSafeInteger(v.id) || typeof v.tag_name !== 'string' || typeof v.draft !== 'boolean') return null;
  return {
    id: v.id as number, tagName: v.tag_name, draft: v.draft, prerelease: v.prerelease === true, author: loginOf(v.author),
    url: str(v.html_url), target: str(v.target_commitish), name: str(v.name), body: str(v.body),
  };
}

/** Whether a release's name and notes are the approved ones, read the way
 *  they were stored (`\n` line ends, no trailing whitespace), in case GitHub
 *  keeps other line ends or a trailing newline. Pure. */
export function sameText(r: Pick<GhRelease, 'name' | 'body'>, act: ApprovalReleaseAct): boolean {
  return normalizeActText(r.name) === act.title && normalizeActText(r.body) === act.notes;
}

/** Whether a draft holds exactly what the act publishes. Pure. */
export function sameDraft(r: GhRelease, act: ApprovalReleaseAct): boolean {
  return r.draft && r.tagName === act.tagName && r.target === act.targetSha && sameText(r, act) && r.prerelease === act.prerelease;
}

/** A draft this act made, by the owner's login with the act's tag: the
 *  draft the row journaled, and only that one once there is one. With none
 *  journaled, one that holds exactly the act counts only when an earlier
 *  try may have written it (`wroteBefore`: a draft made before its id
 *  reached the journal); before this act's first write, no draft is its. Pure. */
export function ownDraft(r: GhRelease, act: ApprovalReleaseAct, login: string, draftId: number | undefined, wroteBefore: boolean): boolean {
  if (!r.draft || r.tagName !== act.tagName || r.author !== login) return false;
  return draftId !== undefined ? r.id === draftId : wroteBefore && sameDraft(r, act);
}

/** The bodies main sends, nothing else (`make_latest` is one of two
 *  constants: GitHub takes any string there without a word). Publishing
 *  sends every approved field again, so an edit of the draft since is not
 *  what goes out. Pure. */
export function tagRefBody(act: ApprovalReleaseAct): Record<string, unknown> {
  return { ref: `refs/tags/${act.tagName}`, sha: act.targetSha };
}

export function draftBody(act: ApprovalReleaseAct): Record<string, unknown> {
  return { tag_name: act.tagName, target_commitish: act.targetSha, name: act.title, body: act.notes, draft: true, prerelease: act.prerelease };
}

export function publishBody(act: ApprovalReleaseAct): Record<string, unknown> {
  return {
    tag_name: act.tagName, target_commitish: act.targetSha, name: act.title, body: act.notes, prerelease: act.prerelease,
    draft: false, make_latest: act.prerelease ? 'false' : 'true',
  };
}

/** Whether `POST git/refs` answered the tag as approved. Pure. */
export function tagRefWritten(value: unknown, act: ApprovalReleaseAct): boolean {
  const v = rec(value);
  const o = rec(v?.object);
  return v?.ref === `refs/tags/${act.tagName}` && o?.sha === act.targetSha && o?.type === 'commit';
}

/** A draft as approved, made by the owner's login: its id, or null. Pure. */
export function draftWritten(value: unknown, act: ApprovalReleaseAct, login: string): GhRelease | null {
  const r = mapRelease(value);
  return r && r.author === login && sameDraft(r, act) ? r : null;
}

/** What publishing answered: the release as approved (url and id),
 *  `different` (this draft, published, by the owner's login, but not with
 *  the approved name, notes or prerelease flag), or null (another shape: the
 *  try is uncertain). Pure. */
export function publishedWritten(value: unknown, act: ApprovalReleaseAct, login: string, draftId: number): { url: string; id: number } | 'different' | null {
  const r = mapRelease(value);
  if (!r || r.id !== draftId || r.draft || r.tagName !== act.tagName || r.author !== login || !/^https:\/\//.test(r.url)) return null;
  return r.prerelease === act.prerelease && sameText(r, act) ? { url: r.url, id: r.id } : 'different';
}

// ── Reads ────────────────────────────────────────────────────────────────

/** A name GitHub gave, as path segments (each percent-encoded). Pure. */
export function pathOfName(name: string): string {
  return name.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

export async function readDefaultBranch(gh: GhActPort, p: RepoPath): Promise<Read<string>> {
  const a = await gh.read(p.host, p.base);
  if (!a.ok) return failed(a);
  const b = str(rec(a.value)?.default_branch);
  return b ? b : unreadable('GitHub named no default branch');
}

export async function readBranchHead(gh: GhActPort, p: RepoPath, branch: string): Promise<Read<string>> {
  const a = await gh.read(p.host, `${p.base}/git/ref/heads/${pathOfName(branch)}`);
  if (!a.ok) return failed(a);
  const o = rec(rec(a.value)?.object);
  return o?.type === 'commit' && FULL_SHA_RE.test(str(o.sha)) ? str(o.sha) : unreadable('the branch head could not be read');
}

/** The object a ref names exactly (`refs/<kind>/<name>`), null when there
 *  is no such ref, or why not known: an answer that is no ref, or another
 *  ref, proves nothing. */
async function readExactRef(gh: GhActPort, p: RepoPath, kind: 'tags' | 'heads', name: string): Promise<Read<Record<string, unknown> | null>> {
  const a = await gh.read(p.host, `${p.base}/git/ref/${kind}/${pathOfName(name)}`);
  if (!a.ok) return a.kind === 'http' && a.status === 404 ? null : failed(a);
  const want = `refs/${kind}/${name}`;
  // Refs that only start with the name: the exact one, or none.
  if (Array.isArray(a.value)) return (a.value as unknown[]).map(rec).find((r) => r?.ref === want) ?? null;
  const ref = rec(a.value);
  if (!ref) return unreadable('GitHub answered something that is not a ref');
  return ref.ref === want ? ref : unreadable('GitHub answered another ref');
}

/** Whether a branch has this name: its runs and suites would read as the
 *  tag's. */
export async function readBranchNamed(gh: GhActPort, p: RepoPath, name: string): Promise<Read<boolean>> {
  const ref = await readExactRef(gh, p, 'heads', name);
  return isFail(ref) ? ref : ref !== null;
}

/** Whether `sha` names a commit: true, false (GitHub's 404 or 422), or why not known. */
export async function readCommitExists(gh: GhActPort, p: RepoPath, sha: string): Promise<Read<boolean>> {
  const a = await gh.read(p.host, `${p.base}/commits/${sha}`);
  if (!a.ok) return a.kind === 'http' && (a.status === 404 || a.status === 422) ? false : failed(a);
  return str(rec(a.value)?.sha) === sha;
}

/** How the default branch's head stands to `sha`: `identical` or `ahead`
 *  (the commit is on it, `aheadBy` commits back), or another status. */
export async function readCompare(gh: GhActPort, p: RepoPath, sha: string, branch: string): Promise<Read<{ status: string; aheadBy: number }>> {
  const a = await gh.read(p.host, `${p.base}/compare/${sha}...heads/${pathOfName(branch)}?per_page=1`);
  if (!a.ok) return failed(a);
  const v = rec(a.value);
  return { status: str(v?.status), aheadBy: typeof v?.ahead_by === 'number' ? v.ahead_by : 0 };
}

/** The commit a tag points at (an annotated tag read through), null when
 *  there is no such tag, or why not known. */
export async function readTagTarget(gh: GhActPort, p: RepoPath, tag: string): Promise<Read<string | null>> {
  const ref = await readExactRef(gh, p, 'tags', tag);
  if (ref === null || isFail(ref)) return ref;
  let o = rec(ref.object);
  for (let hops = 0; hops < 4 && o?.type === 'tag'; hops += 1) {
    if (!FULL_SHA_RE.test(str(o.sha))) break;
    const t = await gh.read(p.host, `${p.base}/git/tags/${str(o.sha)}`);
    if (!t.ok) return failed(t);
    o = rec(rec(t.value)?.object);
  }
  if (o?.type === 'commit' && FULL_SHA_RE.test(str(o.sha))) return str(o.sha);
  // A tag on a tree or a blob is a tag that exists, at no commit of the act.
  return o && str(o.sha) ? `${str(o.type) || 'object'}:${str(o.sha)}` : unreadable('the tag could not be read');
}

/** The published release of a tag, or null (GitHub's 404: drafts answer
 *  404 here; readReleases lists them). */
export async function readReleaseByTag(gh: GhActPort, p: RepoPath, tag: string): Promise<Read<GhRelease | null>> {
  const a = await gh.read(p.host, `${p.base}/releases/tags/${tag}`);
  if (!a.ok) return a.kind === 'http' && a.status === 404 ? null : failed(a);
  return mapRelease(a.value) ?? unreadable('the release could not be read');
}

/** Every release of the repository, drafts included, or why not known. */
export async function readReleases(gh: GhActPort, p: RepoPath): Promise<Read<GhRelease[]>> {
  const list = await readPaged(gh, p.host, `${p.base}/releases`);
  if (isFail(list)) return list;
  const out: GhRelease[] = [];
  for (const v of list) {
    const r = mapRelease(v);
    if (!r) return unreadable('a release could not be read');
    out.push(r);
  }
  return out;
}

/** One entry of a folder: `blob` for a plain file; `other` is what it is
 *  instead (a folder, a symlink, a submodule, which a listing reports as a
 *  file with no download link). */
type FolderEntry = { name: string; blob: string } | { name: string; other: string };

/** A folder at a commit (`''`: the root), or null when there is no such folder. */
async function readFolder(gh: GhActPort, p: RepoPath, dir: string, sha: string): Promise<Read<FolderEntry[] | null>> {
  const a = await gh.read(p.host, `${p.base}/contents${dir ? `/${pathOfName(dir)}` : ''}?ref=${sha}`);
  if (!a.ok) return a.kind === 'http' && a.status === 404 ? null : failed(a);
  if (!Array.isArray(a.value)) return unreadable(`${dir || 'the root'} is not a folder`);
  const out: FolderEntry[] = [];
  for (const e of (a.value as unknown[]).map(rec)) {
    const name = str(e?.name);
    if (!e || !name) return unreadable(`${dir || 'the root'} could not be listed`);
    if (e.type !== 'file') out.push({ name, other: str(e.type) || 'unknown' });
    else if (e.download_url === null) out.push({ name, other: 'submodule' });
    else if (!FULL_SHA_RE.test(str(e.sha))) return unreadable(`${dir || 'the root'} could not be listed`);
    else out.push({ name, blob: str(e.sha) });
  }
  return out;
}

/** A blob's text. Read through the blob, whatever its size: `contents/`
 *  answers a file over 1 MB with a 403 (`too_large`) in the JSON GitHub
 *  gives gh by default. */
async function readBlob(gh: GhActPort, p: RepoPath, blob: string, what: string): Promise<Read<string>> {
  const b = await gh.read(p.host, `${p.base}/git/blobs/${blob}`);
  if (!b.ok) return failed(b);
  const v = rec(b.value);
  if (v?.encoding !== 'base64') return unreadable(`${what} could not be read`);
  return Buffer.from(str(v.content), 'base64').toString('utf8');
}

/** A file of a folder listing: its text, null when it is not there; a
 *  symlink, a submodule or a folder in its place is not read through. */
async function readEntry(gh: GhActPort, p: RepoPath, folder: readonly FolderEntry[] | null, path: string): Promise<Read<string | null>> {
  const entry = folder?.find((f) => f.name === path.slice(path.lastIndexOf('/') + 1));
  if (!entry) return null;
  return 'blob' in entry ? readBlob(gh, p, entry.blob, path) : unreadable(`${path} is a ${entry.other}, not a file`);
}

/** Read `items` BLOBS_AT_ONCE at a time, in order. */
async function inBatches<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BLOBS_AT_ONCE) out.push(...await Promise.all(items.slice(i, i + BLOBS_AT_ONCE).map(read)));
  return out;
}

/** The `on.push` of every workflow at a commit, or why they cannot be read
 *  (`refusal`: one that reads as no shape this module knows, or is not a
 *  plain file). */
export async function readWorkflows(gh: GhActPort, p: RepoPath, sha: string): Promise<Read<WorkflowPush[]> | { refusal: string }> {
  const dir = '.github/workflows';
  const folder = await readFolder(gh, p, dir, sha);
  if (folder === null) return [];
  if (isFail(folder)) return folder;
  const files = folder.filter((f) => /\.ya?ml$/i.test(f.name));
  if (files.length > WORKFLOWS_MAX) return { refusal: `the repository has more than ${WORKFLOWS_MAX} workflows` };
  const blobs: Array<{ name: string; blob: string }> = [];
  for (const f of files) {
    if (!('blob' in f)) return { refusal: `${dir}/${f.name} is a ${f.other}, not a file` };
    blobs.push(f);
  }
  const texts = await inBatches(blobs, (f) => readBlob(gh, p, f.blob, `${dir}/${f.name}`));
  const out: WorkflowPush[] = [];
  for (let i = 0; i < blobs.length; i += 1) {
    const path = `${dir}/${blobs[i].name}`;
    const text = texts[i];
    if (isFail(text)) return text;
    try {
      out.push({ path, ...workflowOn(text) });
    } catch (err) {
      return { refusal: `${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
    }
  }
  return out;
}

/** Which of these workflows GitHub would not run now (`Actions`: Actions
 *  is off for the repository, so none runs), or why not known. Actions' own
 *  switch is read where the login may read it (a 403 or 404 there says
 *  nothing). */
async function readDisabledWorkflows(gh: GhActPort, p: RepoPath, workflows: readonly string[], known?: ReadonlyMap<string, Record<string, unknown>>): Promise<Read<'Actions' | string[]>> {
  const perms = await gh.read(p.host, `${p.base}/actions/permissions`);
  if (perms.ok && rec(perms.value)?.enabled === false) return 'Actions';
  if (!perms.ok && !(perms.kind === 'http' && (perms.status === 403 || perms.status === 404))) return failed(perms);
  const off: string[] = [];
  for (const path of workflows) {
    const record = known?.get(path);
    if (record) {
      if (record.state !== 'active') off.push(path);
      continue;
    }
    const file = path.slice(path.lastIndexOf('/') + 1);
    const a = await gh.read(p.host, `${p.base}/actions/workflows/${pathOfName(file)}`);
    if (!a.ok) {
      if (a.kind === 'http' && a.status === 404) off.push(path);
      else return failed(a);
    } else if (rec(a.value)?.state !== 'active') off.push(path);
  }
  return off;
}

/** The first of these workflows GitHub would not run now (`Actions`: Actions
 *  is off), null when all run, or why not known. `known`: workflow records
 *  already read, not read again. */
export async function readDisabledWorkflow(gh: GhActPort, p: RepoPath, workflows: readonly string[], known?: ReadonlyMap<string, Record<string, unknown>>): Promise<Read<string | null>> {
  if (workflows.length === 0) return null;
  const off = await readDisabledWorkflows(gh, p, workflows, known);
  return isFail(off) ? off : off === 'Actions' ? 'Actions' : off[0] ?? null;
}

/** The push workflows a push to the default branch surely ran at the commit
 *  and GitHub runs now (a disabled one, or all with Actions off, never ran):
 *  those whose push run the checks wait for. */
async function expectedPushRuns(gh: GhActPort, p: RepoPath, workflows: readonly WorkflowPush[], branch: string): Promise<Read<string[]>> {
  const push = pushWorkflowsOf(workflows, branch);
  if (push.length === 0) return [];
  const off = await readDisabledWorkflows(gh, p, push);
  if (isFail(off)) return off;
  return off === 'Actions' ? [] : push.filter((w) => !off.includes(w));
}

/** What the checks on a commit say now. Every check run and push-or-other
 *  workflow run on the commit counts, whatever ref it ran for, except those
 *  of the act's own tag (`ownTag`): pushing it runs its own workflows there,
 *  which are the release, not its checks. The combined status cannot be
 *  told apart by ref: all of it counts. */
export async function readChecks(gh: GhActPort, p: RepoPath, sha: string, o: { ownTag: string; branch: string; expected: readonly string[] }): Promise<Read<{ checks: ReleaseChecks; missing: string[]; records: Map<string, Record<string, unknown>> }>> {
  const { ownTag, branch, expected } = o;
  const run = (v: unknown): Run => {
    const r = rec(v);
    return { status: str(r?.status), conclusion: typeof r?.conclusion === 'string' ? r.conclusion : null };
  };
  const suites = await readPaged(gh, p.host, `${p.base}/commits/${sha}/check-suites`, 'check_suites');
  if (isFail(suites)) return suites;
  const ownSuites = new Set<number>();
  for (const v of suites.map(rec)) {
    if (!v || !Number.isSafeInteger(v.id)) return unreadable('a check suite could not be read');
    if (v.head_branch === ownTag) ownSuites.add(v.id as number);
  }
  // Every run, re-runs included. A run counts unless a run of the same
  // check in the same suite started after it completed (a re-run of it):
  // runs that overlap, or whose times are not given, all count.
  const all = await readPaged(gh, p.host, `${p.base}/commits/${sha}/check-runs?filter=all`, 'check_runs');
  if (isFail(all)) return all;
  const groups = new Map<string, Array<{ run: Run; started: number; completed: number }>>();
  for (const v of all.map(rec)) {
    const suite = rec(v?.check_suite)?.id;
    if (!v || !Number.isSafeInteger(v.id) || !Number.isSafeInteger(suite) || typeof v.name !== 'string') return unreadable('a check run could not be read');
    if (ownSuites.has(suite as number)) continue;
    const key = `${suite as number}\u0000${v.name}`;
    const group = groups.get(key) ?? [];
    group.push({ run: run(v), started: Date.parse(str(v.started_at)), completed: Date.parse(str(v.completed_at)) });
    groups.set(key, group);
  }
  const counted: Run[] = [];
  for (const group of groups.values()) {
    for (const r of group) {
      if (!group.some((o) => o !== r && Number.isFinite(r.completed) && Number.isFinite(o.started) && o.started > r.completed)) counted.push(r.run);
    }
  }
  const s = await gh.read(p.host, `${p.base}/commits/${sha}/status`);
  if (!s.ok) return failed(s);
  const sv = rec(s.value);
  if (typeof sv?.total_count !== 'number') return unreadable('the combined status could not be read');
  // A run queued behind a concurrency group has no check run yet: the runs
  // are read whatever the check runs say.
  const listed = await readPaged(gh, p.host, `${p.base}/actions/runs?head_sha=${sha}`, 'workflow_runs');
  if (isFail(listed)) return listed;
  const runs = listed.map(rec).filter((r) => r?.head_branch !== ownTag);
  const latest = latestPerWorkflow(runs.map((r) => ({
    ...run(r),
    event: str(r?.event),
    branch: str(r?.head_branch),
    path: str(r?.path),
    workflowNum: typeof r?.workflow_id === 'number' ? r.workflow_id : null,
    // Each workflow's runs per event and ref: a later run of another event
    // does not hide a failed one.
    workflowId: `${String(r?.workflow_id ?? r?.id ?? '')}\u0000${str(r?.event)}\u0000${str(r?.head_branch)}`,
    id: typeof r?.id === 'number' ? r.id : 0,
    attempt: typeof r?.run_attempt === 'number' ? r.run_attempt : 1,
  })));
  // GitHub Enterprise Server may list a run without its workflow file's
  // path: such a run is matched on its workflow's id, read for each pinned
  // workflow no run names (only then).
  const records = new Map<string, Record<string, unknown>>();
  if (latest.some((r) => !r.path)) {
    for (const want of missingPushRuns(latest, expected, branch)) {
      const a = await gh.read(p.host, `${p.base}/actions/workflows/${pathOfName(want.slice(want.lastIndexOf('/') + 1))}`);
      // Not read: the workflow stays missing, and the disabled check reads
      // its record again, whose answer refuses as it would without this.
      if (!a.ok) continue;
      const record = rec(a.value);
      if (!record || !Number.isSafeInteger(record.id)) return unreadable('a workflow could not be read');
      records.set(want, record);
      for (const r of latest) if (!r.path && r.workflowNum === record.id) r.path = want;
    }
  }
  return {
    checks: checksVerdict({ runs: counted, status: { state: str(sv.state), total: sv.total_count }, workflowRuns: latest, expected, branch }),
    missing: missingPushRuns(latest, expected, branch),
    records,
  };
}

/** The Actions page of the runs the pushed tag starts: a link that needs no
 *  read (GitHub makes the run a moment after the push). The tag is plain
 *  characters (RELEASE_TAG_RE). Pure. */
export function tagRunsUrl(p: RepoPath, act: ApprovalReleaseAct): string {
  return `https://${p.host}/${p.base.replace(/^repos\//, '')}/actions?query=event%3Apush+branch%3A${act.tagName}`;
}

/** What became of a draft a release row made, when the row ended refused
 *  or was dropped: deleted (or already gone, or published since); kept,
 *  because the tag is made at the commit (a publish made it and stopped:
 *  the draft is what releases it) or could not be checked; or not deleted
 *  (the delete failed). */
export type DraftFate = 'deleted' | 'gone' | 'published' | 'kept-tag-made' | 'kept-unchecked' | 'kept-not-ours' | 'failed' | 'retry';

/** Delete a draft a release row made, best effort: read it first, keep it
 *  while it is published, changed on GitHub since the act made it, or its
 *  tag is made at the commit with no other release on it (or that cannot be
 *  read), and delete it only then: a draft on a tag another release holds
 *  could never be published. `want`: the act; absent (the request is gone),
 *  the draft's own tag and target. */
export async function deleteDraft(gh: GhActPort, p: RepoPath, draftId: number, want?: ApprovalReleaseAct): Promise<DraftFate> {
  // A read GitHub did not answer (no HTTP status) says nothing yet: `retry`,
  // and the draft stays open for a later sweep. GitHub's own answer, or an
  // answer this build cannot read, keeps it unchecked.
  const unchecked = (e: ReadFail): DraftFate => (e.status === undefined && !e.unreadable ? 'retry' : 'kept-unchecked');
  const r = await gh.read(p.host, `${p.base}/releases/${draftId}`).catch(() => null);
  if (!r) return 'retry';
  if (!r.ok) return r.kind === 'http' && r.status === 404 ? 'gone' : unchecked(failed(r));
  const release = mapRelease(r.value);
  if (!release) return 'kept-unchecked';
  if (!release.draft) return 'published';
  // A draft changed on GitHub (its tag, target, name, notes or prerelease
  // flag) is not what the act made any more: the owner's edit, never deleted.
  if (want && !sameDraft(release, want)) return 'kept-not-ours';
  const tagName = want?.tagName ?? release.tagName;
  const targetSha = want?.targetSha ?? release.target;
  if (!RELEASE_TAG_RE.test(tagName)) return 'kept-unchecked';
  const tag = await readTagTarget(gh, p, tagName).catch((err: unknown): ReadFail => ({ error: String(err) }));
  if (isFail(tag)) return unchecked(tag);
  if (tag !== null && tag === targetSha) {
    const all = await readReleases(gh, p).catch((err: unknown): ReadFail => ({ error: String(err) }));
    if (isFail(all)) return unchecked(all);
    if (!all.some((o) => o.tagName === tagName && o.id !== draftId)) return 'kept-tag-made';
  }
  const a = await gh.write(p.host, 'DELETE', `${p.base}/releases/${draftId}`, {}).catch(() => null);
  if (!a) return 'retry';
  if (a.ok) return 'deleted';
  // No answer, or a server error: the delete may have run; the next try's
  // read tells (a deleted draft reads as gone).
  if (a.kind !== 'http' || a.status >= 500) return 'retry';
  return a.status === 404 ? 'gone' : 'failed';
}

// ── When the bot asks ────────────────────────────────────────────────────

export interface ReleaseAskInput {
  tagName: string;
  /** Lowercase full SHA, or absent: the default branch's head now. */
  targetSha?: string;
  prerelease?: boolean;
  /** The default branch the repository read just named (approvals.ts reads
   *  the repository first); absent: read here. */
  defaultBranch?: string;
}

/** What main read for a release request: the pins, and the facts its card
 *  states. */
export interface ReleaseAsk {
  mode: 'workflow' | 'release';
  workflows: string[];
  /** The other workflows the act starts, and by what. */
  alsoRuns: AlsoRuns[];
  targetSha: string;
  defaultBranch: string;
  /** Commits the default branch's head is ahead of the target. */
  behindBy: number;
  checks: ReleaseChecks;
  /** package.json's version at the target, when it has one. */
  version: string | null;
  /** The tag's own shape where the bot named none. */
  prerelease: boolean;
  /** The workflows whose push run on the default branch the checks wait
   *  for (pushWorkflowsOf, enabled). */
  pushWorkflows: string[];
  /** Some workflow's push run is waited for (`pushWorkflows` not empty). */
  checksExpected: boolean;
}

export interface ReleaseAskRefusal {
  refuse: 'invalid' | 'read_failed';
  message: string;
}

/** Read GitHub for a release request; the request is refused (no card) when
 *  the repository cannot take this release as asked. */
export async function readReleaseAsk(gh: GhActPort, repoKey: string, input: ReleaseAskInput): Promise<ReleaseAsk | ReleaseAskRefusal> {
  const p = repoPath(repoKey);
  if (!p) return { refuse: 'invalid', message: 'not a GitHub repository' };
  const unread = (what: string, e: ReadFail): ReleaseAskRefusal => ({ refuse: 'read_failed', message: `${what} could not be read: ${e.error}`.slice(0, 300) });
  const no = (code: string, message: string): ReleaseAskRefusal => ({ refuse: 'invalid', message: `${code}: ${message}`.slice(0, 300) });
  const tag = input.tagName;
  const defaultBranch = input.defaultBranch || await readDefaultBranch(gh, p);
  if (isFail(defaultBranch)) return unread('the repository', defaultBranch);
  let targetSha = input.targetSha;
  if (targetSha === undefined) {
    const head = await readBranchHead(gh, p, defaultBranch);
    if (isFail(head)) return unread(`the head of ${defaultBranch}`, head);
    targetSha = head;
  } else {
    const exists = await readCommitExists(gh, p, targetSha);
    if (isFail(exists)) return unread('the commit', exists);
    if (!exists) return { refuse: 'invalid', message: `targetSha ${targetSha} is not a commit of ${repoKey}` };
  }
  const cmp = await readCompare(gh, p, targetSha, defaultBranch);
  if (isFail(cmp)) return cmp.status === undefined ? unread(`how ${targetSha.slice(0, 7)} stands to ${defaultBranch}`, cmp) : no('not-on-default-branch', `GitHub could not compare ${targetSha.slice(0, 7)} with ${defaultBranch} (HTTP ${cmp.status})`);
  if (cmp.status !== 'identical' && cmp.status !== 'ahead') return no('not-on-default-branch', `${targetSha.slice(0, 7)} is not on ${defaultBranch}`);
  const taken = await readTagTarget(gh, p, tag);
  if (isFail(taken)) return unread(`the tag ${tag}`, taken);
  if (taken !== null) return no('tag-taken', `the tag ${tag} already exists`);
  const branchNamed = await readBranchNamed(gh, p, tag);
  if (isFail(branchNamed)) return unread(`the branch ${tag}`, branchNamed);
  if (branchNamed) return no('tag-name-is-branch', `a branch is named ${tag}: its checks would read as the tag's; pick another tag`);
  const all = await readReleases(gh, p);
  if (isFail(all)) return unread('the releases', all);
  const listed = all.find((r) => r.tagName === tag);
  if (listed) return no('release-exists', listed.draft ? `a draft release of ${tag} is already there` : `a release of ${tag} is already published`);
  // None listed: GitHub's answer for the tag itself, in case the listing lags.
  const published = await readReleaseByTag(gh, p, tag);
  if (isFail(published)) return unread(`the release of ${tag}`, published);
  if (published) return no('release-exists', `a release of ${tag} is already published`);
  const workflows = await readWorkflows(gh, p, targetSha);
  if ('refusal' in workflows) return no('workflow-unreadable', `${workflows.refusal}; fix it or ask the owner to publish this release`);
  if (isFail(workflows)) return unread('the workflows', workflows);
  // Every pattern was read with its workflow: matching cannot throw.
  const mode = releaseMode(workflows, tag);
  if ('refusal' in mode) return no(mode.refusal, `the repository's tag workflows do not run on ${tag}, so pushing it would publish nothing`);
  if (mode.mode === 'workflow') {
    const off = await readDisabledWorkflow(gh, p, mode.workflows);
    if (isFail(off)) return unread('the workflows\' state', off);
    if (off) return no('workflow-disabled', `${off === 'Actions' ? 'GitHub Actions is off for the repository' : `${off} is disabled`}, so pushing the tag would publish nothing`);
  }
  const shape = tagPrereleaseShape(tag);
  if (mode.mode === 'workflow' && input.prerelease !== undefined && shape !== null && input.prerelease !== shape) {
    return no('prerelease-mismatch', `${tag} ${shape ? 'reads' : 'does not read'} as a prerelease, and its release workflow decides by the tag`);
  }
  let version: string | null = null;
  if (tagVersion(tag)) {
    // One listing of the root for both files.
    const root = await readFolder(gh, p, '', targetSha);
    if (isFail(root)) return unread('the repository\'s files', root);
    const pkg = await readEntry(gh, p, root, 'package.json');
    if (isFail(pkg)) return unread('package.json', pkg);
    const lock = await readEntry(gh, p, root, 'package-lock.json');
    if (isFail(lock)) return unread('package-lock.json', lock);
    let read: ReturnType<typeof versionProblem>;
    try {
      read = versionProblem(tag, pkg, lock);
    } catch (err) {
      return { refuse: 'invalid', message: `version-mismatch: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (read.problem) return no('version-mismatch', read.problem);
    version = read.version;
  }
  const expected = await expectedPushRuns(gh, p, workflows, defaultBranch);
  if (isFail(expected)) return unread('the workflows\' state', expected);
  const read = await readChecks(gh, p, targetSha, { ownTag: tag, branch: defaultBranch, expected });
  if (isFail(read)) return unread('the checks', read);
  const { checks } = read;
  const prerelease = input.prerelease ?? shape ?? false;
  return {
    mode: mode.mode, workflows: mode.mode === 'workflow' ? mode.workflows : [], alsoRuns: alsoRunsOn(workflows, tag, mode.mode, prerelease),
    targetSha, defaultBranch, behindBy: cmp.aheadBy, checks, version, prerelease, pushWorkflows: expected, checksExpected: expected.length > 0,
  };
}

// ── When it runs ─────────────────────────────────────────────────────────

/** Whether a tag that exists already is the one publishing this act's draft
 *  makes: at the commit, with that draft still a draft (a publish that
 *  answered 4xx can leave the tag made and the release a draft). Pure. */
export function tagIsOurs(act: ApprovalReleaseAct, tag: string | null, draft: GhRelease | null): boolean {
  return act.mode === 'release' && tag === act.targetSha && !!draft?.draft;
}

/** Why the release may not run as it stands now (`read-failed`: try again
 *  later), or null; and this act's own draft on GitHub, when there is one.
 *  `branch`: the default branch the repository read of this try named ('':
 *  none). `wroteBefore`: an earlier try of the row may have written. */
export async function releasePrecondition(gh: GhActPort, p: RepoPath, act: ApprovalReleaseAct, o: { login: string; branch: string; draftId: number | undefined; wroteBefore: boolean }): Promise<{ refusal: string | null; draft: GhRelease | null }> {
  const { login, draftId, wroteBefore } = o;
  const stop = (refusal: string, draft: GhRelease | null = null): { refusal: string; draft: GhRelease | null } => ({ refusal, draft });
  if (!o.branch) return stop('unreadable-answer');
  if (o.branch !== act.defaultBranch) return stop('default-branch-changed');
  const cmp = await readCompare(gh, p, act.targetSha, act.defaultBranch);
  if (isFail(cmp)) return stop(readRefusal(cmp, 'not-on-default-branch'));
  if (cmp.status !== 'identical' && cmp.status !== 'ahead') return stop('not-on-default-branch');
  const tag = await readTagTarget(gh, p, act.tagName);
  if (isFail(tag)) return stop(readRefusal(tag, 'tag-taken'));
  const all = await readReleases(gh, p);
  if (isFail(all)) return stop(readRefusal(all, 'repo-changed'));
  const same = all.filter((r) => r.tagName === act.tagName);
  let own = act.mode === 'release' ? same.find((r) => ownDraft(r, act, login, draftId, wroteBefore)) ?? null : null;
  // The draft the row journaled, not listed as this act's: read by its id.
  // Gone (the owner deleted it to cancel): draft-gone, before any tag test,
  // and no draft is made in its place. There but changed: found-different;
  // published: release-exists. As made (the listing was late): it is this
  // act's draft.
  if (act.mode === 'release' && draftId !== undefined && !own) {
    let found: GhRelease | null = all.find((r) => r.id === draftId) ?? null;
    if (!found) {
      const g = await gh.read(p.host, `${p.base}/releases/${draftId}`);
      if (!g.ok) return stop(readRefusal(failed(g), 'draft-gone'));
      found = mapRelease(g.value);
      if (!found) return stop('unreadable-answer');
    }
    if (!found.draft) return stop('release-exists');
    if (!ownDraft(found, act, login, draftId, wroteBefore)) return stop('found-different');
    own = found;
  }
  const branchNamed = await readBranchNamed(gh, p, act.tagName);
  // Only an exact ref names a branch (404: none); any other failure is not one.
  if (isFail(branchNamed)) return stop(readRefusal(branchNamed, `gh-${branchNamed.status ?? 0}`), own);
  if (branchNamed) return stop('tag-name-is-branch', own);
  if (tag !== null && !tagIsOurs(act, tag, own)) return stop('tag-taken', own);
  if (same.some((r) => r.id !== own?.id)) return stop('release-exists', own);
  // None other listed: GitHub's answer for the tag itself, in case the listing lags.
  const published = await readReleaseByTag(gh, p, act.tagName);
  if (isFail(published)) return stop(readRefusal(published, 'release-exists'), own);
  if (published) return stop('release-exists', own);
  // The draft this act made was changed on GitHub since: not what was approved.
  if (own && !sameDraft(own, act)) return stop('found-different', own);
  // The workflows at the commit do not change: the push workflows the checks
  // wait for were read with the request (pushWorkflows); a request an
  // earlier build stored without them reads them now.
  let expected = act.pushWorkflows;
  if (expected === undefined) {
    const workflows = await readWorkflows(gh, p, act.targetSha);
    if ('refusal' in workflows) return stop('workflow-unreadable', own);
    if (isFail(workflows)) return stop(readRefusal(workflows, 'workflow-unreadable'), own);
    const read = await expectedPushRuns(gh, p, workflows, act.defaultBranch);
    if (isFail(read)) return stop(readRefusal(read, 'workflow-disabled'), own);
    expected = read;
  }
  // The release workflow still runs (it publishes on the tag push).
  if (act.mode === 'workflow') {
    const off = await readDisabledWorkflow(gh, p, act.workflows);
    if (isFail(off)) return stop(readRefusal(off, 'workflow-disabled'), own);
    if (off) return stop('workflow-disabled', own);
  }
  const read = await readChecks(gh, p, act.targetSha, { ownTag: act.tagName, branch: act.defaultBranch, expected });
  if (isFail(read)) return stop(readRefusal(read, 'checks-failing'), own);
  const { checks } = read;
  // A push workflow waited for whose run is not there: disabled since, it
  // never will be. One that ran is counted whatever its state now.
  if (checks === 'not-started' && read.missing.length > 0) {
    const off = await readDisabledWorkflow(gh, p, read.missing, read.records);
    if (isFail(off)) return stop(readRefusal(off, 'workflow-disabled'), own);
    if (off) return stop('workflow-disabled', own);
  }
  const why = checksRefusal(checks);
  return why ? stop(why, own) : { refusal: null, draft: own };
}

export type ReleaseFound =
  | { status: 'done'; result: { url: string; id?: number } }
  | { status: 'refused'; reason: string; result?: { url: string; id?: number }; draft?: number }
  | { status: 'none'; draft?: number; tagMade?: true }
  | { status: 'unknown'; error?: string };

/** Whether the release is on GitHub as approved, read for a row that may
 *  have run. `draft`: this act's own draft, still a draft; `tagMade`: its
 *  tag is made at the commit (a publish stopped after making it). */
export async function findRelease(gh: GhActPort, p: RepoPath, act: ApprovalReleaseAct, login: string, draftId: number | undefined): Promise<ReleaseFound> {
  const tag = await readTagTarget(gh, p, act.tagName);
  if (isFail(tag)) return { status: 'unknown', error: tag.error };
  if (act.mode === 'workflow') {
    // The write is the tag itself: at the commit, it is this act's (no one
    // else's push of that ref would differ from it).
    if (tag === null) return { status: 'none' };
    if (tag !== act.targetSha) return { status: 'refused', reason: 'tag-taken' };
    return { status: 'done', result: { url: tagRunsUrl(p, act) } };
  }
  const all = await readReleases(gh, p);
  if (isFail(all)) return { status: 'unknown', error: all.error };
  const same = all.filter((r) => r.tagName === act.tagName);
  const published = same.find((r) => !r.draft);
  if (published) {
    const result = { url: published.url, id: published.id };
    if (published.author !== login) return { status: 'refused', reason: 'release-by-other' };
    // A published release has its tag; one not visible yet says nothing.
    if (tag === null) return { status: 'unknown' };
    if (tag !== act.targetSha) return { status: 'refused', reason: 'published-other-target', result };
    if (published.prerelease !== act.prerelease || !sameText(published, act)) return { status: 'refused', reason: 'found-different', result };
    return { status: 'done', result };
  }
  // A read settles a row that tried at least once: a draft holding exactly
  // the act may be one whose id never reached the journal.
  const own = same.find((r) => ownDraft(r, act, login, draftId, true)) ?? null;
  const draft = own ? { draft: own.id } : {};
  // The tag at the commit with this act's draft still a draft: publishing
  // made the tag and stopped (the next try publishes the draft). Any other
  // tag is not this act's.
  if (tag !== null && !tagIsOurs(act, tag, own)) return { status: 'refused', reason: 'tag-taken', ...draft };
  return { status: 'none', ...draft, ...(tag !== null ? { tagMade: true as const } : {}) };
}
