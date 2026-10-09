import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { getWmuxDir } from '../config';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { getExecEnv } from '../../shared/execEnv';
import { buildGitEnv, gitArgv, type GitRunResult } from './sessionDiff';
import { GitWriteReceipts, type GhTokenResult } from './phoneGitWriteGate';
import { registerPhoneGitWriteAction, type GitWriteExecuteContext, type GitWritePreviewResult, type GitWriteSessionContext } from './phoneGitWriteRegistry';
import {
  GIT_WRITE_OID, GIT_WRITE_PUSH_MAX_COMMITS, GIT_WRITE_RECEIPT_TTL_MS,
  type GitWriteErrorBody, type PushCommit, type PushExecuteBody, type PushPreviewFacts,
} from '../../shared/phoneGitWrite';

/**
 * The phone `push` action (docs/phone-client-contract.md, "Phone git write
 * actions"). The routes own the gate, the token and the receipt; this module
 * reads the facts, pushes exactly `expectedHead:<target ref>` and settles.
 *
 * - The target is the upstream's ref on `origin`; with no upstream the push
 *   creates `refs/heads/<branch>` only when the remote has no such branch.
 * - The effective `origin` URLs (after `insteadOf` / `pushInsteadOf`) must be
 *   `https://github.com/<owner>/<repo>` before any network call is made.
 * - Global and system git config are never loaded; the argv fixes every push
 *   option a repository's config could otherwise change. Never forced.
 * - The push child runs in its own process group and is killed on daemon
 *   exit. Its intent is written to disk before it spawns, so a restart can
 *   settle the `uncertain` receipt from the remote tip (`recoverUncertainPushes`).
 */

/** Wall clock for one push child. */
export const PUSH_TIMEOUT_MS = 60_000;
/** Recovery reads the remote no earlier than this after the push started. */
export const PUSH_RECHECK_DELAY_MS = 2 * PUSH_TIMEOUT_MS;
const NETWORK_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 10_000;
const MAX_PUSHES_PER_OWNER = 1;
const MAX_PUSHES = 2;
export const PHONE_GIT_PUSH_INFLIGHT_FILE = 'phone-git-push-inflight.json';

/** A git runner with an explicit environment. Never throws; a failure is data. */
export type PushGitRunner = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<GitRunResult>;
/** A gh runner with an explicit environment. */
export type PushGhRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<GitRunResult>;
export interface PushChildResult { spawned: boolean; code: number | null; timedOut: boolean; stdout: string; stderr: string }
/** Runs `git push` in its own process group, killed after `timeoutMs` and on daemon exit. */
export type PushSpawner = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<PushChildResult>;

export interface PhoneGitPushDeps {
  /** Local reads and the post-push upstream config. Never reaches the network. */
  git: PushGitRunner;
  /** Network git (`ls-remote`). */
  remote: PushGitRunner;
  gh: PushGhRunner;
  push: PushSpawner;
  /** The environment git and gh are found in (PATH, HOME). */
  baseEnv: () => NodeJS.ProcessEnv;
  /** Where the in-flight intents are written. */
  stateDir: () => string;
  now: () => number;
}

// ── Runners ──────────────────────────────────────────────────────────────────

function execRunner(bin: string, timeout: number): (args: readonly string[], cwd: string | undefined, env: NodeJS.ProcessEnv) => Promise<GitRunResult> {
  return (args, cwd, env) => new Promise((resolve) => {
    execFile(bin, [...args], { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const ran = !err || (typeof err.code === 'number' && err.killed !== true);
      resolve({
        ok: !err, ran,
        ...(ran ? { code: err ? (err.code as number) : 0 } : {}),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}

/** Process groups of running push children, killed when the daemon exits. */
const liveChildren = new Set<number>();
let exitHookInstalled = false;

function killGroup(pid: number): void {
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL');
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

const spawnPush: PushSpawner = (args, cwd, env, timeoutMs) => new Promise((resolve) => {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => { for (const pid of liveChildren) killGroup(pid); });
  }
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const child = spawn('git', [...args], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const pid = child.pid;
  if (pid !== undefined) liveChildren.add(pid);
  const timer = setTimeout(() => { timedOut = true; if (pid !== undefined) killGroup(pid); }, timeoutMs);
  child.stdout.on('data', (b: Buffer) => { if (stdout.length < 256 * 1024) stdout += b.toString('utf8'); });
  child.stderr.on('data', (b: Buffer) => { if (stderr.length < 256 * 1024) stderr += b.toString('utf8'); });
  const finish = (spawned: boolean, code: number | null) => {
    clearTimeout(timer);
    if (pid !== undefined) liveChildren.delete(pid);
    resolve({ spawned, code, timedOut, stdout, stderr });
  };
  child.once('error', () => finish(pid !== undefined, null));
  child.once('close', (code) => finish(true, code));
});

const localGit = execRunner('git', LOCAL_TIMEOUT_MS);
const networkGit = execRunner('git', NETWORK_TIMEOUT_MS);
const ghRun = execRunner('gh', NETWORK_TIMEOUT_MS);

export const defaultPushDeps: PhoneGitPushDeps = {
  git: localGit,
  remote: networkGit,
  gh: (args, env) => ghRun(args, undefined, env),
  push: spawnPush,
  baseEnv: getExecEnv,
  stateDir: getWmuxDir,
  now: Date.now,
};

// ── Environment and argv ─────────────────────────────────────────────────────

/**
 * The null device as git spells it on every platform: Git for Windows maps
 * `/dev/null` to `nul` itself and cannot open `\\.\nul` (`os.devNull`).
 */
export const GIT_NULL_DEVICE = '/dev/null';

/** The hardened git environment with global and system config off. */
function isolatedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...buildGitEnv(base), GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE, GIT_CONFIG_NOSYSTEM: '1' };
}

/** `isolatedEnv` plus the login's token from the routes' `ghEnv`. */
function networkEnv(base: NodeJS.ProcessEnv, ghEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = isolatedEnv(base);
  for (const name of ['GH_TOKEN', 'GH_HOST', 'GH_PROMPT_DISABLED']) {
    if (typeof ghEnv[name] === 'string') env[name] = ghEnv[name];
  }
  return env;
}

/** Fixed config for every network git call: HTTPS only, no redirects, gh as the only credential source. */
const NETWORK_CONFIG: readonly string[] = [
  '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
  '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
  '-c', 'core.askPass=', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${GIT_NULL_DEVICE}`,
  '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
  '-c', 'push.pushOption=', '-c', 'remote.origin.mirror=false',
];

/** The push argv. Exactly one refspec, never forced. */
export function pushArgv(expectedHead: string, targetRef: string): string[] {
  return [
    ...NETWORK_CONFIG, 'push', '--porcelain', '--no-recurse-submodules', '--no-follow-tags', '--no-signed', '--no-verify',
    'origin', `${expectedHead}:${targetRef}`,
  ];
}

const local = (...args: string[]) => gitArgv('-c', 'log.showSignature=false', ...args);

// ── Remote ───────────────────────────────────────────────────────────────────

const GITHUB_HTTPS = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/;

/** `owner/repo` of an HTTPS github.com URL, or null. */
export function githubHttpsRepo(url: string): string | null {
  const m = GITHUB_HTTPS.exec(url);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * The repository `origin` fetches from and pushes to, from git's own
 * expansion of the URLs (`insteadOf` / `pushInsteadOf` applied). Every URL
 * must be HTTPS github.com and name the same repository; local only.
 */
async function originRepo(git: PushGitRunner, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const fetchUrls = await git(local('remote', 'get-url', '--all', 'origin'), cwd, env);
  const pushUrls = await git(local('remote', 'get-url', '--push', '--all', 'origin'), cwd, env);
  if (!fetchUrls.ok || !pushUrls.ok) return null;
  const pushList = pushUrls.stdout.split('\n').filter(Boolean);
  if (pushList.length !== 1) return null;
  const repos = [...fetchUrls.stdout.split('\n').filter(Boolean), ...pushList].map(githubHttpsRepo);
  const first = repos[0];
  if (repos.length < 2 || !first || repos.some((r) => r === null || r.toLowerCase() !== first.toLowerCase())) return null;
  return first;
}

function remoteFailure(stderr: string, login: string): GitWriteErrorBody {
  return /Authentication failed|could not read Username|HTTP 40[13]|returned error: 40[34]|Permission to .* denied|Repository not found/i.test(stderr)
    ? { error: 'remote-forbidden', login }
    : { error: 'remote-unreachable' };
}

/** The remote's tip of `ref`, null when it has none. */
async function remoteTipOf(remote: PushGitRunner, where: string, cwd: string, ref: string, env: NodeJS.ProcessEnv, login: string): Promise<{ tip: string | null } | { fail: GitWriteErrorBody }> {
  const out = await remote([...NETWORK_CONFIG, 'ls-remote', '--refs', where, ref], cwd, env);
  if (!out.ok) return { fail: remoteFailure(out.stderr, login) };
  for (const line of out.stdout.split('\n')) {
    const [oid, name] = line.split('\t');
    if (name === ref && oid && GIT_WRITE_OID.test(oid)) return { tip: oid };
  }
  return { tip: null };
}

async function defaultBranch(gh: PushGhRunner, repo: string, env: NodeJS.ProcessEnv, login: string): Promise<{ ref: string } | { fail: GitWriteErrorBody }> {
  const out = await gh(['api', '--hostname', 'github.com', `repos/${repo}`], env);
  if (!out.ok) {
    if (out.ran === false) return { fail: { error: 'gh-unavailable' } };
    return { fail: /HTTP 40[34]/.test(out.stderr) ? { error: 'remote-forbidden', login } : { error: 'gh-unavailable' } };
  }
  try {
    const name = (JSON.parse(out.stdout) as { default_branch?: unknown }).default_branch;
    if (typeof name === 'string' && name) return { ref: `refs/heads/${name}` };
  } catch { /* fall through */ }
  return { fail: { error: 'gh-unavailable' } };
}

// ── Facts ────────────────────────────────────────────────────────────────────

type Facts = Omit<PushPreviewFacts, 'identity'> & { ownerRepo: string };
type Gathered = { ok: true; facts: Facts } | { ok: false; body: GitWriteErrorBody };

const failed = (body: GitWriteErrorBody): Gathered => ({ ok: false, body });
const gitFailed = (): Gathered => failed({ error: 'git-operation-failed' });

/**
 * Read every fact a push is decided on. Local first: the branch, its upstream
 * and the origin URLs; only then gh and `ls-remote`. `pin` (execute) names the
 * branch ref and the commit instead of reading HEAD.
 */
async function gather(ctx: GitWriteSessionContext, deps: PhoneGitPushDeps, pin?: { ref: string; head: string }): Promise<Gathered> {
  const base = deps.baseEnv();
  const env = isolatedEnv(base);
  const cwd = ctx.cwd;
  const run = (...args: string[]) => deps.git(local(...args), cwd, env);

  let ref: string;
  let head: string;
  if (pin) {
    ref = pin.ref;
    const has = await run('cat-file', '-e', `${pin.head}^{commit}`);
    if (!has.ok) return has.ran === false ? gitFailed() : failed({ error: 'stale', head: pin.head });
    head = pin.head;
  } else {
    const sym = await run('symbolic-ref', '-q', 'HEAD');
    if (!sym.ok) return sym.code === 1 ? failed({ error: 'detached-head' }) : gitFailed();
    ref = sym.stdout.trim();
    if (!ref.startsWith('refs/heads/')) return failed({ error: 'detached-head' });
    const h = await run('rev-parse', '--verify', '-q', 'HEAD^{commit}');
    if (!h.ok || !GIT_WRITE_OID.test(h.stdout.trim())) return gitFailed();
    head = h.stdout.trim();
  }
  const branch = ref.slice('refs/heads/'.length);

  // Upstream: `branch.<b>.remote` must be origin; `merge` is normalized to a full ref.
  const upRemote = await run('config', '--get', `branch.${branch}.remote`);
  const upMerge = await run('config', '--get', `branch.${branch}.merge`);
  if ((!upRemote.ok && upRemote.code !== 1) || (!upMerge.ok && upMerge.code !== 1)) return gitFailed();
  const remoteName = upRemote.ok ? upRemote.stdout.trim() : '';
  const mergeRaw = upMerge.ok ? upMerge.stdout.trim() : '';
  let targetRef: string;
  let hasUpstream = false;
  if (remoteName && mergeRaw) {
    if (remoteName !== 'origin') return failed({ error: 'remote-unsupported' });
    targetRef = mergeRaw.startsWith('refs/') ? mergeRaw : `refs/heads/${mergeRaw}`;
    if (!targetRef.startsWith('refs/heads/') || targetRef.length === 'refs/heads/'.length) return failed({ error: 'remote-unsupported' });
    hasUpstream = true;
  } else if (remoteName && remoteName !== 'origin') {
    return failed({ error: 'remote-unsupported' });
  } else {
    targetRef = ref;
  }

  // The effective URLs, before any network call.
  const ownerRepo = await originRepo(deps.git, cwd, env);
  if (!ownerRepo) return failed({ error: 'remote-unsupported' });

  const net = networkEnv(base, ctx.ghEnv);
  const def = await defaultBranch(deps.gh, ownerRepo, net, ctx.login);
  if ('fail' in def) return failed(def.fail);
  if (def.ref === targetRef) return failed({ error: 'protected-target' });

  const tipRead = await remoteTipOf(deps.remote, 'origin', cwd, targetRef, net, ctx.login);
  if ('fail' in tipRead) return failed(tipRead.fail);
  const remoteTip = tipRead.tip;
  if (!hasUpstream && remoteTip !== null) return failed({ error: 'remote-branch-exists' });
  if (remoteTip === head) return failed({ error: 'no-commits-ahead' });

  // Counts against the remote tip when this clone has it; otherwise against
  // everything known on origin, and the push cannot be a fast-forward.
  const tipKnown = remoteTip !== null && (await run('cat-file', '-e', `${remoteTip}^{commit}`)).ok;
  const range = tipKnown ? [head, `^${remoteTip}`] : [head, '--not', '--remotes=origin'];
  const aheadOut = await run('rev-list', '--count', ...range);
  if (!aheadOut.ok) return gitFailed();
  let behind = 0;
  let fastForward = remoteTip === null;
  if (remoteTip !== null && tipKnown) {
    const b = await run('rev-list', '--count', remoteTip, `^${head}`);
    if (!b.ok) return gitFailed();
    behind = Number(b.stdout.trim());
    fastForward = behind === 0;
  } else if (remoteTip !== null) {
    // The remote holds commits this clone never fetched: at least one.
    behind = 1;
  }
  const tracking = await run('rev-parse', '--verify', '-q', `refs/remotes/origin/${targetRef.slice('refs/heads/'.length)}^{commit}`);
  const trackingOid = tracking.ok ? tracking.stdout.trim() : null;

  let commits: PushCommit[] = [];
  let commitsTruncated = false;
  if (!pin) {
    const log = await run('log', '-z', '--format=%H%x1f%s%x1f%an', `-n${GIT_WRITE_PUSH_MAX_COMMITS + 1}`, ...range);
    if (!log.ok) return gitFailed();
    commits = log.stdout.split('\0').filter(Boolean).map((rec) => {
      const [oid, subject, author] = rec.replace(/^\n/, '').split('\x1f');
      return { oid: oid ?? '', subject: subject ?? '', author: author ?? '' };
    });
    commitsTruncated = commits.length > GIT_WRITE_PUSH_MAX_COMMITS;
    commits = commits.slice(0, GIT_WRITE_PUSH_MAX_COMMITS);
  }

  return {
    ok: true,
    facts: {
      branch, ref, head,
      target: { remote: 'origin', ref: targetRef, create: remoteTip === null },
      repo: `github.com/${ownerRepo}`,
      ahead: Number(aheadOut.stdout.trim()), behind, remoteTip,
      remoteMoved: trackingOid !== remoteTip,
      fastForward, commits, commitsTruncated, ownerRepo,
    },
  };
}

// ── In-flight intents ────────────────────────────────────────────────────────

/** What a restart needs to settle an `uncertain` push. Written before the child spawns. */
export interface PushIntent {
  ownerRepo: string;
  /** The local branch pushed from. */
  ref: string;
  targetRef: string;
  /** The push creates the remote branch, and records it as the upstream once it lands. */
  create: boolean;
  expectedHead: string;
  login: string;
  /** The session's spawn cwd: a local ancestor check is tried there first. */
  cwd: string;
  startedAt: number;
}

const intentFile = (dir: string) => path.join(dir, PHONE_GIT_PUSH_INFLIGHT_FILE);

function validIntent(v: unknown): v is PushIntent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.ownerRepo === 'string' && githubHttpsRepo(`https://github.com/${e.ownerRepo}`) !== null
    && typeof e.ref === 'string' && e.ref.startsWith('refs/heads/') && typeof e.create === 'boolean'
    && typeof e.targetRef === 'string' && e.targetRef.startsWith('refs/heads/')
    && typeof e.expectedHead === 'string' && GIT_WRITE_OID.test(e.expectedHead)
    && typeof e.login === 'string' && typeof e.cwd === 'string' && Number.isSafeInteger(e.startedAt);
}

/** Saved intents by receipt key; a file that cannot be read yields none. */
export function readPushIntents(dir: string): Record<string, PushIntent> {
  try {
    const saved = JSON.parse(fs.readFileSync(intentFile(dir), 'utf8')) as { version?: unknown; rows?: unknown };
    if (saved.version !== 1 || !saved.rows || typeof saved.rows !== 'object') return {};
    const out: Record<string, PushIntent> = {};
    for (const [k, v] of Object.entries(saved.rows as Record<string, unknown>)) if (validIntent(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Record one intent durably, dropping those past the receipt retention. Throws when it cannot be written. */
function writePushIntent(dir: string, key: string, intent: PushIntent, now: number): void {
  const rows = readPushIntents(dir);
  for (const [k, r] of Object.entries(rows)) if (r.startedAt <= now - GIT_WRITE_RECEIPT_TTL_MS) delete rows[k];
  rows[key] = intent;
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteJSONSync(intentFile(dir), { version: 1, rows }, { durable: true });
}

// ── Landing check ────────────────────────────────────────────────────────────

type Landed = 'landed' | 'not-landed' | 'unknown';

/**
 * Whether `expectedHead` is on the remote: the remote tip is it or descends
 * from it. Tried locally first; otherwise GitHub's compare answers.
 */
async function pushLanded(deps: PhoneGitPushDeps, intent: Omit<PushIntent, 'startedAt'>, net: NodeJS.ProcessEnv): Promise<Landed> {
  const url = `https://github.com/${intent.ownerRepo}.git`;
  const tipRead = await remoteTipOf(deps.remote, url, os.tmpdir(), intent.targetRef, net, intent.login);
  if ('fail' in tipRead) return 'unknown';
  const tip = tipRead.tip;
  if (tip === null) return 'not-landed';
  if (tip === intent.expectedHead) return 'landed';
  const env = isolatedEnv(deps.baseEnv());
  const known = await deps.git(local('cat-file', '-e', `${tip}^{commit}`), intent.cwd, env);
  if (known.ok) {
    const anc = await deps.git(local('merge-base', '--is-ancestor', intent.expectedHead, tip), intent.cwd, env);
    if (anc.ok) return 'landed';
    if (anc.code === 1) return 'not-landed';
  }
  const cmp = await deps.gh(['api', '--hostname', 'github.com', `repos/${intent.ownerRepo}/compare/${intent.expectedHead}...${tip}`], net);
  if (!cmp.ok) return /HTTP 404/.test(cmp.stderr) ? 'not-landed' : 'unknown';
  try {
    const status = (JSON.parse(cmp.stdout) as { status?: unknown }).status;
    if (status === 'identical' || status === 'ahead') return 'landed';
    if (status === 'behind' || status === 'diverged') return 'not-landed';
  } catch { /* unknown */ }
  return 'unknown';
}

/**
 * After a push that created the remote branch: name it as the branch's
 * upstream. The source is a commit id, so `--set-upstream` would not record
 * one. A branch that already has an upstream is left alone. Best effort.
 */
async function recordUpstream(deps: PhoneGitPushDeps, intent: PushIntent): Promise<void> {
  if (!intent.create) return;
  const env = isolatedEnv(deps.baseEnv());
  const branch = intent.ref.slice('refs/heads/'.length);
  const has = await deps.git(local('config', '--get', `branch.${branch}.merge`), intent.cwd, env);
  if (has.ok || has.code !== 1) return;
  await deps.git(local('config', `branch.${branch}.remote`, 'origin'), intent.cwd, env);
  await deps.git(local('config', `branch.${branch}.merge`, intent.targetRef), intent.cwd, env);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

const running = new Map<string, number>();
let runningTotal = 0;

export function createPhoneGitPushHandlers(deps: PhoneGitPushDeps = defaultPushDeps) {
  async function preview(ctx: GitWriteSessionContext): Promise<GitWritePreviewResult> {
    const g = await gather(ctx, deps);
    if (!g.ok) return { ok: false, body: g.body };
    const facts: Record<string, unknown> & Omit<Facts, 'ownerRepo'> = { ...g.facts };
    delete facts.ownerRepo;
    return {
      ok: true,
      facts,
      pins: { head: facts.head, ref: facts.ref, targetRef: facts.target.ref, remoteTip: facts.remoteTip },
    };
  }

  async function execute(ctx: GitWriteExecuteContext): Promise<void> {
    const body = ctx.body as PushExecuteBody;
    const pins = ctx.pins;
    if (!pins || typeof pins.ref !== 'string' || typeof pins.targetRef !== 'string') {
      return ctx.settle({ state: 'refused', error: 'confirm-required' });
    }
    const mine = running.get(ctx.owner) ?? 0;
    if (mine >= MAX_PUSHES_PER_OWNER || runningTotal >= MAX_PUSHES) return ctx.settle({ state: 'refused', error: 'git-busy' });
    running.set(ctx.owner, mine + 1);
    runningTotal += 1;
    try {
      await executePinned(ctx, body, { ref: pins.ref, targetRef: pins.targetRef, remoteTip: pins.remoteTip as string | null });
    } finally {
      runningTotal -= 1;
      const left = (running.get(ctx.owner) ?? 1) - 1;
      if (left > 0) running.set(ctx.owner, left); else running.delete(ctx.owner);
    }
  }

  async function executePinned(ctx: GitWriteExecuteContext, body: PushExecuteBody, pins: { ref: string; targetRef: string; remoteTip: string | null }): Promise<void> {
    const refuse = (b: GitWriteErrorBody) => {
      const { error, ...extras } = b;
      const fields = Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== undefined)) as Record<string, string | number | null>;
      ctx.settle({ state: 'refused', error, ...(Object.keys(fields).length ? { fields } : {}) });
    };
    // Re-read every pinned fact; the commit pushed is `expectedHead`, whatever HEAD is now.
    const g = await gather(ctx, deps, { ref: pins.ref, head: body.expectedHead });
    if (!g.ok) return refuse(g.body);
    const f = g.facts;
    if (!f.fastForward) return refuse({ error: 'non-fast-forward', remoteTip: f.remoteTip, behind: f.behind });
    if (f.target.ref !== pins.targetRef || f.remoteTip !== pins.remoteTip) return refuse({ error: 'stale', head: body.expectedHead });

    const base = deps.baseEnv();
    const net = networkEnv(base, ctx.ghEnv);
    const intent: PushIntent = {
      ownerRepo: f.ownerRepo, ref: f.ref, targetRef: f.target.ref, create: f.target.create, expectedHead: body.expectedHead, login: ctx.login, cwd: ctx.cwd, startedAt: deps.now(),
    };
    writePushIntent(deps.stateDir(), GitWriteReceipts.key(ctx.owner, ctx.requestId), intent, deps.now());
    ctx.markInFlight();
    const out = await deps.push(pushArgv(body.expectedHead, f.target.ref), ctx.cwd, net, PUSH_TIMEOUT_MS);
    if (!out.spawned) return refuse({ error: 'git-operation-failed' });

    const done = () => ctx.settle({ state: 'done', fields: { pushed: body.expectedHead, target: f.target.ref } });
    if (out.code === 0 && !out.timedOut) {
      await recordUpstream(deps, intent);
      return done();
    }
    if (!out.timedOut) {
      const rejected = out.stdout.split('\n').find((l) => l.startsWith('!'));
      if (rejected && /non-fast-forward|fetch first|stale info/.test(rejected)) {
        const tip = await remoteTipOf(deps.remote, 'origin', ctx.cwd, f.target.ref, net, ctx.login);
        return refuse({ error: 'non-fast-forward', remoteTip: 'tip' in tip ? tip.tip : null });
      }
      if (rejected || remoteFailure(out.stderr, ctx.login).error === 'remote-forbidden') {
        // Refused by the remote (permission, protection rule): nothing landed.
        return refuse({ error: 'remote-forbidden', login: ctx.login });
      }
    }
    // Killed or failed on the way: the remote tip says whether it landed.
    const landed = await pushLanded(deps, intent, net);
    if (landed === 'landed') {
      await recordUpstream(deps, intent);
      return done();
    }
    if (landed === 'not-landed') return refuse({ error: 'push-not-landed' });
    throw new Error('push outcome unknown');
  }

  return { preview, execute };
}

// ── Recovery ─────────────────────────────────────────────────────────────────

export interface PushRecoveryOptions {
  deps?: PhoneGitPushDeps;
  /** The login's token (the gate's `identity`). */
  identity: (login: string) => Promise<GhTokenResult>;
}

/**
 * One pass over the `uncertain` push receipts a restart left. A row is read
 * only once PUSH_RECHECK_DELAY_MS has passed since it started (a child that
 * outlived the daemon may still land), then settles `done` when `expectedHead`
 * is on the remote and `refused` / `push-not-landed` when it is not. Nothing
 * is ever pushed again. Returns how many rows are still `uncertain`.
 */
export async function recheckUncertainPushes(receipts: GitWriteReceipts, opts: PushRecoveryOptions): Promise<number> {
  const deps = opts.deps ?? defaultPushDeps;
  const intents = readPushIntents(deps.stateDir());
  let left = 0;
  for (const { key, row } of receipts.uncertain('push')) {
    const intent = intents[key];
    const startedAt = row.startedAt ?? intent?.startedAt ?? row.createdAt;
    if (!intent || deps.now() < startedAt + PUSH_RECHECK_DELAY_MS) { left += 1; continue; }
    const token = await opts.identity(intent.login);
    if (!token.ok) { left += 1; continue; }
    const net = networkEnv(deps.baseEnv(), { GH_TOKEN: token.token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' });
    const landed = await pushLanded(deps, intent, net).catch((): Landed => 'unknown');
    if (landed === 'landed') {
      await recordUpstream(deps, intent).catch(() => undefined);
      receipts.settle(key, { state: 'done', fields: { pushed: intent.expectedHead, target: intent.targetRef } });
    }
    else if (landed === 'not-landed') receipts.settle(key, { state: 'refused', error: 'push-not-landed' });
    else left += 1;
  }
  return left;
}

/**
 * Re-check the `uncertain` pushes now and every `intervalMs` until none is
 * left. Call once after the gate is built. Returns the stop function.
 */
export function startPushRecovery(receipts: GitWriteReceipts, opts: PushRecoveryOptions & { intervalMs?: number }): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    void recheckUncertainPushes(receipts, opts).catch(() => 1).then((left) => {
      if (stopped || left === 0) return;
      timer = setTimeout(tick, opts.intervalMs ?? 60_000);
      timer.unref?.();
    });
  };
  tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

registerPhoneGitWriteAction('push', createPhoneGitPushHandlers());
