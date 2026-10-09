import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
 * - Before any network call: the repository's own config may not set
 *   transport, credential or URL keys (`isolatedConfigKey`), and the
 *   effective `origin` URLs must be `https://github.com/<owner>/<repo>`.
 *   Network calls then name that validated URL, never the remote `origin`,
 *   and the preview pins it into the confirm token.
 * - Global and system git config are never loaded; the argv fixes every push
 *   option a repository's config could otherwise change. Never forced.
 * - Every network git child runs in its own process group (a tree on
 *   Windows), killed on timeout and on daemon exit. A push's intent is written
 *   to disk before it spawns, so a restart can settle the `uncertain` receipt
 *   from the remote tip (`startPushRecovery`).
 */

/** Wall clock for one push child. */
export const PUSH_TIMEOUT_MS = 60_000;
/** Recovery reads the remote no earlier than this after the push started. */
export const PUSH_RECHECK_DELAY_MS = 2 * PUSH_TIMEOUT_MS;
const NETWORK_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 10_000;
const MAX_PUSHES_PER_OWNER = 1;
const MAX_PUSHES = 2;
/** One file per in-flight push, named by its receipt key. */
export const PHONE_GIT_PUSH_INTENTS_DIR = 'phone-git-push-intents';

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
  log: (msg: string) => void;
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

/** Running push children, killed with their process group when the daemon exits. */
const liveChildren = new Map<number, ChildProcess>();
let exitHookInstalled = false;

/** taskkill by absolute path: a bare name is looked up in the working directory first on Windows. */
const TASKKILL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

/**
 * Kill the push child and everything it started. On Windows there is no
 * process group and killing git.exe alone leaves git-remote-https, the
 * credential helper's sh and gh running: the push goes on, and the child's
 * pipes stay open until they exit, so neither the timeout nor daemon exit
 * would stop it. taskkill /T ends the tree, and only while git.exe still
 * runs: after it exits its pid may already belong to another process.
 * `sync` is for the exit hook, where nothing asynchronous runs.
 */
function killGroup(child: ChildProcess, sync = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGKILL');
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    const args = ['/PID', String(pid), '/T', '/F'];
    if (sync) execFileSync(TASKKILL, args, { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    else execFile(TASKKILL, args, { windowsHide: true, timeout: 5_000 }, () => { /* already gone */ });
  } catch { /* already gone */ }
}

/** Run git in its own process group (a tree on Windows), killed after `timeoutMs` and on daemon exit. */
const spawnGroup: PushSpawner = (args, cwd, env, timeoutMs) => new Promise((resolve) => {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => { for (const child of liveChildren.values()) killGroup(child, true); });
  }
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const child = spawn('git', [...args], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const pid = child.pid;
  if (pid !== undefined) liveChildren.set(pid, child);
  const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
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
const ghRun = execRunner('gh', NETWORK_TIMEOUT_MS);

/** `ls-remote` and the other network reads: same process-group handling as the push. */
export function createNetworkGitRunner(timeoutMs: number = NETWORK_TIMEOUT_MS): PushGitRunner {
  return async (args, cwd, env) => {
    const out = await spawnGroup(args, cwd, env, timeoutMs);
    const ran = out.spawned && !out.timedOut && out.code !== null;
    return { ok: ran && out.code === 0, ran, ...(ran ? { code: out.code as number } : {}), stdout: out.stdout, stderr: out.stderr };
  };
}

export const defaultPushDeps: PhoneGitPushDeps = {
  git: localGit,
  remote: createNetworkGitRunner(),
  gh: (args, env) => ghRun(args, undefined, env),
  push: spawnGroup,
  baseEnv: getExecEnv,
  stateDir: getWmuxDir,
  now: Date.now,
  // eslint-disable-next-line no-console
  log: (msg) => console.warn(`[web] git push: ${msg}`),
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

/** `isolatedEnv`, HTTPS as the only transport, plus the login's token from the routes' `ghEnv`. */
function networkEnv(base: NodeJS.ProcessEnv, ghEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = isolatedEnv(base);
  env.GIT_ALLOW_PROTOCOL = 'https';
  env.GIT_TERMINAL_PROMPT = '0';
  for (const name of ['GH_TOKEN', 'GH_HOST', 'GH_PROMPT_DISABLED']) {
    if (typeof ghEnv[name] === 'string') env[name] = ghEnv[name];
  }
  return env;
}

/**
 * Fixed config for every network git call: HTTPS only, no redirects, no
 * proxy, gh as the only credential source. `http.sslCAInfo` is not reset: an
 * empty value makes git load no CA at all, and with global and system config
 * off and repository http keys refused, nothing else can set it.
 */
const NETWORK_CONFIG: readonly string[] = [
  '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
  '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
  '-c', 'http.proxy=', '-c', 'https.proxy=',
  '-c', 'core.askPass=', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${GIT_NULL_DEVICE}`,
  '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
  '-c', 'push.pushOption=',
];

/** The push argv: to the validated URL, exactly one refspec, never forced. */
export function pushArgv(pushUrl: string, expectedHead: string, targetRef: string): string[] {
  return [
    ...NETWORK_CONFIG, 'push', '--porcelain', '--no-recurse-submodules', '--no-follow-tags', '--no-signed', '--no-verify',
    pushUrl, `${expectedHead}:${targetRef}`,
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
 * Repository config keys a push refuses to run under: anything that can
 * redirect, proxy or re-credential a transport, rewrite a URL, turn a remote
 * into a command, or pull in another config file. Keys arrive lowercased
 * (section and name; a subsection keeps its case).
 */
export function isolatedConfigKey(key: string): boolean {
  return /^(?:https?|credential|url|protocol|include|includeif)\./.test(key)
    || /^core\.(?:sshcommand|gitproxy)$/.test(key)
    || /^remote\..+\.(?:vcs|proxy|pushurl)$/.test(key);
}

/**
 * Every config key the repository sets (local and worktree, includes
 * followed), or null when git cannot say. Global and system are off; the
 * `command` scope is this module's own `-c` and is left out.
 */
async function repoConfigKeys(git: PushGitRunner, cwd: string, env: NodeJS.ProcessEnv): Promise<string[] | null> {
  const out = await git(local('config', '--list', '-z', '--includes', '--show-scope'), cwd, env);
  if (!out.ok) return null;
  const fields = out.stdout.split('\0');
  const keys: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i] as string;
    const entry = fields[i + 1] as string;
    if (scope === 'command') continue;
    const nl = entry.indexOf('\n');
    keys.push(nl === -1 ? entry : entry.slice(0, nl));
  }
  return keys;
}

/**
 * The repository `origin` fetches from and pushes to, from git's own
 * expansion of the URLs. Every URL must be HTTPS github.com and name the same
 * repository; `pushUrl` is the one URL every network call then uses. Local only.
 */
async function originRepo(git: PushGitRunner, cwd: string, env: NodeJS.ProcessEnv): Promise<{ ownerRepo: string; pushUrl: string } | null> {
  const fetchUrls = await git(local('remote', 'get-url', '--all', 'origin'), cwd, env);
  const pushUrls = await git(local('remote', 'get-url', '--push', '--all', 'origin'), cwd, env);
  if (!fetchUrls.ok || !pushUrls.ok) return null;
  const pushList = pushUrls.stdout.split('\n').filter(Boolean);
  if (pushList.length !== 1) return null;
  const repos = [...fetchUrls.stdout.split('\n').filter(Boolean), ...pushList].map(githubHttpsRepo);
  const first = repos[0];
  if (repos.length < 2 || !first || repos.some((r) => r === null || r.toLowerCase() !== first.toLowerCase())) return null;
  return { ownerRepo: first, pushUrl: pushList[0] as string };
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

type Facts = Omit<PushPreviewFacts, 'identity'> & { ownerRepo: string; pushUrl: string };
type Gathered = { ok: true; facts: Facts } | { ok: false; body: GitWriteErrorBody };

const failed = (body: GitWriteErrorBody): Gathered => ({ ok: false, body });
const gitFailed = (): Gathered => failed({ error: 'git-operation-failed' });

/**
 * Read every fact a push is decided on. Local first: the branch, its upstream
 * and the origin URLs; only then gh and `ls-remote`. `pin` (execute) names the
 * branch ref and the commit instead of reading HEAD.
 */
async function gather(ctx: GitWriteSessionContext, deps: PhoneGitPushDeps, pin?: { ref: string; head: string; repo: string; pushUrl: string }): Promise<Gathered> {
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

  // The repository's own config and the effective URLs, before any network call.
  const keys = await repoConfigKeys(deps.git, cwd, env);
  if (!keys) return gitFailed();
  if (keys.some(isolatedConfigKey)) return failed({ error: 'remote-unsupported' });
  const origin = await originRepo(deps.git, cwd, env);
  if (!origin) return failed({ error: 'remote-unsupported' });
  const { ownerRepo, pushUrl } = origin;
  // Execute: the URL the person confirmed, or nothing goes out.
  if (pin && (ownerRepo !== pin.repo || pushUrl !== pin.pushUrl)) return failed({ error: 'stale', head: pin.head });

  const net = networkEnv(base, ctx.ghEnv);
  const def = await defaultBranch(deps.gh, ownerRepo, net, ctx.login);
  if ('fail' in def) return failed(def.fail);
  if (def.ref === targetRef) return failed({ error: 'protected-target' });

  const tipRead = await remoteTipOf(deps.remote, pushUrl, cwd, targetRef, net, ctx.login);
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
      fastForward, commits, commitsTruncated, ownerRepo, pushUrl,
    },
  };
}

// ── In-flight intents ────────────────────────────────────────────────────────

/** What a restart needs to settle an `uncertain` push. Written before the child spawns. */
export interface PushIntent {
  ownerRepo: string;
  /** The validated URL the push went to. */
  pushUrl: string;
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

/**
 * One file per push, `<dir>/<receipt key>.json`, created once and removed when
 * the receipt settles. No file is shared or rewritten, so no writer can drop
 * another push's intent and none needs a lock of its own: a push reaches this
 * only after the receipt store, which holds the single-writer lock, accepted
 * its row.
 */
const intentPath = (dir: string, key: string) => path.join(dir, PHONE_GIT_PUSH_INTENTS_DIR, `${key}.json`);

function validIntent(v: unknown): v is PushIntent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.ownerRepo === 'string' && githubHttpsRepo(`https://github.com/${e.ownerRepo}`) !== null
    && typeof e.pushUrl === 'string' && githubHttpsRepo(e.pushUrl)?.toLowerCase() === e.ownerRepo.toLowerCase()
    && typeof e.ref === 'string' && e.ref.startsWith('refs/heads/') && typeof e.create === 'boolean'
    && typeof e.targetRef === 'string' && e.targetRef.startsWith('refs/heads/')
    && typeof e.expectedHead === 'string' && GIT_WRITE_OID.test(e.expectedHead)
    && typeof e.login === 'string' && typeof e.cwd === 'string' && Number.isSafeInteger(e.startedAt);
}

export type PushIntentRead = { state: 'ok'; intent: PushIntent } | { state: 'missing' } | { state: 'unreadable'; reason: string };

/**
 * The intent for one receipt key. The atomic writer moves a previous file to
 * `.bak` before it renames the new one in, so a missing or unreadable primary
 * falls back to a valid `.bak`. Unreadable is never reported as missing.
 */
export function readPushIntent(dir: string, key: string): PushIntentRead {
  const file = intentPath(dir, key);
  let reason: string | null = null;
  for (const candidate of [file, `${file}.bak`]) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      reason = error instanceof Error ? error.message : String(error);
      continue;
    }
    try {
      const saved = JSON.parse(raw) as { version?: unknown; intent?: unknown };
      if (saved.version === 1 && validIntent(saved.intent)) return { state: 'ok', intent: saved.intent };
      reason = 'invalid intent';
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  return reason === null ? { state: 'missing' } : { state: 'unreadable', reason };
}

/** Record one intent durably, and drop intents past the receipt retention. Throws when it cannot be written. */
function writePushIntent(dir: string, key: string, intent: PushIntent, now: number): void {
  const file = intentPath(dir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJSONSync(file, { version: 1, intent }, { durable: true });
  try {
    for (const name of fs.readdirSync(path.dirname(file))) {
      const p = path.join(path.dirname(file), name);
      if (fs.statSync(p).mtimeMs <= now - GIT_WRITE_RECEIPT_TTL_MS) fs.rmSync(p, { force: true });
    }
  } catch { /* sweeping is best effort */ }
}

function removePushIntent(dir: string, key: string): void {
  const file = intentPath(dir, key);
  for (const p of [file, `${file}.bak`]) {
    try { fs.rmSync(p, { force: true }); } catch { /* left for the sweep */ }
  }
}

// ── Landing check ────────────────────────────────────────────────────────────

type Landed = 'landed' | 'not-landed' | 'unknown';

/**
 * Whether `expectedHead` is on the remote: the remote tip is it or descends
 * from it. Tried locally first; otherwise GitHub's compare answers.
 */
async function pushLanded(deps: PhoneGitPushDeps, intent: Omit<PushIntent, 'startedAt'>, net: NodeJS.ProcessEnv): Promise<Landed> {
  const tipRead = await remoteTipOf(deps.remote, intent.pushUrl, os.tmpdir(), intent.targetRef, net, intent.login);
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
 * After a push landed, record locally what a push to `origin` would have: the
 * remote-tracking ref, and for a branch the push created, its upstream (the
 * source is a commit id, so `--set-upstream` would not record one; a branch
 * that already has an upstream is left alone). Best effort.
 */
async function recordPushed(deps: PhoneGitPushDeps, intent: PushIntent): Promise<void> {
  const env = isolatedEnv(deps.baseEnv());
  const run = (...args: string[]) => deps.git(local(...args), intent.cwd, env);
  await run('update-ref', `refs/remotes/origin/${intent.targetRef.slice('refs/heads/'.length)}`, intent.expectedHead);
  if (!intent.create) return;
  const branch = intent.ref.slice('refs/heads/'.length);
  const has = await run('config', '--get', `branch.${branch}.merge`);
  if (has.ok || has.code !== 1) return;
  await run('config', `branch.${branch}.remote`, 'origin');
  await run('config', `branch.${branch}.merge`, intent.targetRef);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

const running = new Map<string, number>();
let runningTotal = 0;

export function createPhoneGitPushHandlers(deps: PhoneGitPushDeps = defaultPushDeps) {
  async function preview(ctx: GitWriteSessionContext): Promise<GitWritePreviewResult> {
    const g = await gather(ctx, deps);
    if (!g.ok) return { ok: false, body: g.body };
    const facts: Record<string, unknown> & Omit<Facts, 'ownerRepo' | 'pushUrl'> = { ...g.facts };
    delete facts.ownerRepo;
    delete facts.pushUrl;
    return {
      ok: true,
      facts,
      pins: {
        head: facts.head, ref: facts.ref, targetRef: facts.target.ref, remoteTip: facts.remoteTip,
        repo: g.facts.ownerRepo, pushUrl: g.facts.pushUrl,
      },
    };
  }

  async function execute(ctx: GitWriteExecuteContext): Promise<void> {
    const body = ctx.body as PushExecuteBody;
    const pins = ctx.pins;
    if (!pins || typeof pins.ref !== 'string' || typeof pins.targetRef !== 'string' || typeof pins.repo !== 'string' || typeof pins.pushUrl !== 'string') {
      return ctx.settle({ state: 'refused', error: 'confirm-required' });
    }
    const mine = running.get(ctx.owner) ?? 0;
    if (mine >= MAX_PUSHES_PER_OWNER || runningTotal >= MAX_PUSHES) return ctx.settle({ state: 'refused', error: 'git-busy' });
    running.set(ctx.owner, mine + 1);
    runningTotal += 1;
    try {
      await executePinned(ctx, body, {
        ref: pins.ref, targetRef: pins.targetRef, remoteTip: pins.remoteTip as string | null, repo: pins.repo, pushUrl: pins.pushUrl,
      });
    } finally {
      runningTotal -= 1;
      const left = (running.get(ctx.owner) ?? 1) - 1;
      if (left > 0) running.set(ctx.owner, left); else running.delete(ctx.owner);
    }
  }

  type Pinned = { ref: string; targetRef: string; remoteTip: string | null; repo: string; pushUrl: string };

  async function executePinned(ctx: GitWriteExecuteContext, body: PushExecuteBody, pins: Pinned): Promise<void> {
    const refuse = (b: GitWriteErrorBody) => {
      const { error, ...extras } = b;
      const fields = Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== undefined)) as Record<string, string | number | null>;
      ctx.settle({ state: 'refused', error, ...(Object.keys(fields).length ? { fields } : {}) });
    };
    // Re-read every pinned fact; the commit pushed is `expectedHead`, whatever HEAD is now.
    const g = await gather(ctx, deps, { ref: pins.ref, head: body.expectedHead, repo: pins.repo, pushUrl: pins.pushUrl });
    if (!g.ok) return refuse(g.body);
    const f = g.facts;
    if (!f.fastForward) return refuse({ error: 'non-fast-forward', remoteTip: f.remoteTip, behind: f.behind });
    if (f.target.ref !== pins.targetRef || f.remoteTip !== pins.remoteTip) return refuse({ error: 'stale', head: body.expectedHead });

    const net = networkEnv(deps.baseEnv(), ctx.ghEnv);
    const intent: PushIntent = {
      ownerRepo: f.ownerRepo, pushUrl: f.pushUrl, ref: f.ref, targetRef: f.target.ref, create: f.target.create,
      expectedHead: body.expectedHead, login: ctx.login, cwd: ctx.cwd, startedAt: deps.now(),
    };
    const dir = deps.stateDir();
    const key = GitWriteReceipts.key(ctx.owner, ctx.requestId);
    try {
      writePushIntent(dir, key, intent, deps.now());
    } catch (error) {
      deps.log(`the push intent could not be written: ${error instanceof Error ? error.message : String(error)}`);
      return refuse({ error: 'git-receipts-unavailable' });
    }
    ctx.markInFlight();
    try {
      const outcome = await pushAndRead(ctx, intent, net);
      if (outcome === 'unknown') throw new Error('push outcome unknown');
      if (outcome.state === 'done') {
        await recordPushed(deps, intent).catch(() => undefined);
        ctx.settle({ state: 'done', fields: { pushed: intent.expectedHead, target: intent.targetRef } });
      } else {
        refuse(outcome.body);
      }
      removePushIntent(dir, key);
    } catch (error) {
      // The receipt reads `uncertain`; recovery reads the remote once the child can no longer land.
      schedulePushRecheck(PUSH_RECHECK_DELAY_MS);
      throw error;
    }
  }

  /** Push, then classify. `unknown` when neither git nor the remote can say whether it landed. */
  async function pushAndRead(ctx: GitWriteExecuteContext, intent: PushIntent, net: NodeJS.ProcessEnv): Promise<{ state: 'done' } | { state: 'refused'; body: GitWriteErrorBody } | 'unknown'> {
    const out = await deps.push(pushArgv(intent.pushUrl, intent.expectedHead, intent.targetRef), ctx.cwd, net, PUSH_TIMEOUT_MS);
    if (!out.spawned) return { state: 'refused', body: { error: 'git-operation-failed' } };
    if (out.code === 0 && !out.timedOut) return { state: 'done' };
    if (!out.timedOut) {
      const rejected = out.stdout.split('\n').find((l) => l.startsWith('!'));
      if (rejected && /non-fast-forward|fetch first|stale info/.test(rejected)) {
        const tip = await remoteTipOf(deps.remote, intent.pushUrl, ctx.cwd, intent.targetRef, net, ctx.login);
        return { state: 'refused', body: { error: 'non-fast-forward', remoteTip: 'tip' in tip ? tip.tip : null } };
      }
      if (rejected || remoteFailure(out.stderr, ctx.login).error === 'remote-forbidden') {
        // Refused by the remote (permission, protection rule): nothing landed.
        return { state: 'refused', body: { error: 'remote-forbidden', login: ctx.login } };
      }
    }
    // Killed or failed on the way: the remote tip says whether it landed.
    const landed = await pushLanded(deps, intent, net);
    if (landed === 'landed') return { state: 'done' };
    if (landed === 'not-landed') return { state: 'refused', body: { error: 'push-not-landed' } };
    return 'unknown';
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
 * One pass over the `uncertain` push receipts. A row is read only once
 * PUSH_RECHECK_DELAY_MS has passed since it started (a child that outlived
 * the daemon may still land), then settles `done` when `expectedHead` is on
 * the remote and `refused` / `push-not-landed` when it is not. A row whose
 * intent is missing or unreadable stays `uncertain`. Nothing is ever pushed
 * again. Returns how many rows are still `uncertain`.
 */
export async function recheckUncertainPushes(receipts: GitWriteReceipts, opts: PushRecoveryOptions): Promise<number> {
  const deps = opts.deps ?? defaultPushDeps;
  if (!receipts.available) return 0;
  const dir = deps.stateDir();
  let left = 0;
  for (const { key, row } of receipts.uncertain('push')) {
    const read = readPushIntent(dir, key);
    if (read.state !== 'ok') {
      if (read.state === 'unreadable') deps.log(`an in-flight push intent is unreadable: ${read.reason}`);
      left += 1;
      continue;
    }
    const intent = read.intent;
    if (deps.now() < (row.startedAt ?? intent.startedAt) + PUSH_RECHECK_DELAY_MS) { left += 1; continue; }
    const token = await opts.identity(intent.login);
    if (!token.ok) { left += 1; continue; }
    const net = networkEnv(deps.baseEnv(), { GH_TOKEN: token.token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' });
    const landed = await pushLanded(deps, intent, net).catch((): Landed => 'unknown');
    if (landed === 'unknown') { left += 1; continue; }
    if (landed === 'landed') {
      await recordPushed(deps, intent).catch(() => undefined);
      receipts.settle(key, { state: 'done', fields: { pushed: intent.expectedHead, target: intent.targetRef } });
    } else {
      receipts.settle(key, { state: 'refused', error: 'push-not-landed' });
    }
    removePushIntent(dir, key);
  }
  return left;
}

/** The recovery loop the daemon started, if any: an in-process `uncertain` push asks it for a re-check. */
let activeRecovery: { kick(delayMs: number): void } | null = null;

function schedulePushRecheck(delayMs: number): void {
  activeRecovery?.kick(delayMs);
}

/**
 * Re-check the `uncertain` pushes now, then every `intervalMs` while any is
 * left, and again whenever a push in this process turns `uncertain`. Call once
 * after the gate is built; the returned function stops it (daemon shutdown).
 */
export function startPushRecovery(receipts: GitWriteReceipts, opts: PushRecoveryOptions & { intervalMs?: number }): () => void {
  const interval = opts.intervalMs ?? 60_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let dueAt = Infinity;
  let running = false;
  const schedule = (delayMs: number) => {
    if (stopped || Date.now() + delayMs >= dueAt) return;
    if (timer) clearTimeout(timer);
    dueAt = Date.now() + delayMs;
    timer = setTimeout(tick, delayMs);
    timer.unref?.();
  };
  const tick = () => {
    timer = undefined;
    dueAt = Infinity;
    if (running) return schedule(1_000);
    running = true;
    void recheckUncertainPushes(receipts, opts).catch(() => 1).then((left) => {
      running = false;
      if (left > 0) schedule(interval);
    });
  };
  const handle = { kick: (delayMs: number) => schedule(delayMs) };
  activeRecovery = handle;
  schedule(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (activeRecovery === handle) activeRecovery = null;
  };
}

registerPhoneGitWriteAction('push', createPhoneGitPushHandlers());
