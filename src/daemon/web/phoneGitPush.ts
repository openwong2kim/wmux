import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { getWmuxDir } from '../config';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { getExecEnv } from '../../shared/execEnv';
import { readWorkerFile } from '../../shared/readWorkerFile';
import { parseRawGitConfigList, parseTaskHead, relayGitConfigArgs, type RawGitConfigEntry } from '../../shared/taskGitRelay';
import { buildGitEnv, gitArgv, type GitRunResult } from './sessionDiff';
import { canonicalPath, pathKey } from './phoneGitRead';
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
 * - Which repository: the routes resolve the session's trusted spawn cwd to
 *   its common git dir and bind the confirm token to it. Each read here finds
 *   the pane's git dir and common dir once (`paneGitDirs`), requires that
 *   same common dir, and from then on names both explicitly (`--git-dir` and
 *   `GIT_COMMON_DIR`); nothing is looked up through the worktree again. The
 *   preview pins both dirs and the execute must find the same ones. HEAD is
 *   read from the git dir's own HEAD file, strictly (`parseTaskHead`).
 * - Before any network call: the repository's own config may not set
 *   transport, credential or URL keys (`isolatedConfigKey`), and the
 *   effective `origin` URLs must be `https://github.com/<owner>/<repo>`.
 *   Network calls then name that validated URL, never the remote `origin`,
 *   and the preview pins it into the confirm token.
 * - Every network git call (each `ls-remote`, the push) runs in a bare relay
 *   repository the daemon owns, made for that call under the daemon's data
 *   folder (`phone-git-relay/`) and removed after it. The relay borrows the
 *   pane repository's objects through `objects/info/alternates`, so the push
 *   reads the commit from there, and git in the relay reads only the relay's
 *   own config and this module's `-c` options: never the pane repository's.
 * - Nothing is written under the pane repository: no ref, no config. A branch
 *   the push created has no upstream until the pane sets one; the next push
 *   from it goes to the same-named remote branch as a fast-forward.
 * - Global and system git config are never loaded; the argv fixes every push
 *   option a repository's config could otherwise change. Never forced.
 *   No git call fetches a missing object on its own (`GIT_NO_LAZY_FETCH`),
 *   and a partial clone is refused.
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
/** One bare relay repository per network call, removed after it. */
export const PHONE_GIT_RELAY_DIR = 'phone-git-relay';
/** A relay this old is left over from a daemon that stopped mid-call. */
const RELAY_SWEEP_AGE_MS = 60 * 60 * 1000;
/** The most of a shallow list read (about 25,000 boundary commits). */
const SHALLOW_MAX = 1024 * 1024;

/** A git runner with an explicit environment. Never throws; a failure is data. */
export type PushGitRunner = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<GitRunResult>;
/** A git runner fed `input` on stdin; stdout as bytes, at most `maxBytes` (more fails). */
export type PushGitInputRunner = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input: string, maxBytes: number) => Promise<{ ok: boolean; stdout: Buffer }>;
/** A gh runner with an explicit environment. */
export type PushGhRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<GitRunResult>;
export interface PushChildResult { spawned: boolean; code: number | null; timedOut: boolean; stdout: string; stderr: string }
/** Runs `git push` in its own process group, killed after `timeoutMs` and on daemon exit. */
export type PushSpawner = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<PushChildResult>;

export interface PhoneGitPushDeps {
  /** Local reads and the relay's setup. Never reaches the network. */
  git: PushGitRunner;
  /** Network git (`ls-remote`), always in a relay. */
  remote: PushGitRunner;
  /** Local git with stdin (`cat-file --batch`). Never reaches the network. */
  gitInput: PushGitInputRunner;
  gh: PushGhRunner;
  push: PushSpawner;
  /** The environment git and gh are found in (PATH, HOME). */
  baseEnv: () => NodeJS.ProcessEnv;
  /** Where the in-flight intents and the relays are written. */
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

const gitWithInput: PushGitInputRunner = (args, cwd, env, input, maxBytes) => new Promise((resolve) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  const child = spawn('git', [...args], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (!ok) child.kill('SIGKILL');
    resolve({ ok, stdout: Buffer.concat(chunks) });
  };
  const timer = setTimeout(() => finish(false), LOCAL_TIMEOUT_MS);
  child.stdout.on('data', (b: Buffer) => {
    size += b.length;
    if (size > maxBytes) return finish(false);
    chunks.push(b);
  });
  child.once('error', () => finish(false));
  child.once('close', (code) => finish(code === 0));
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
});

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
  gitInput: gitWithInput,
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

/**
 * The push argv: to the validated URL, exactly one refspec. A lease pins the
 * verified remote tip (empty when the branch is being created), so the update
 * lands only while the remote is still what the fast-forward was verified
 * against; the push is otherwise never forced.
 */
export function pushArgv(pushUrl: string, expectedHead: string, targetRef: string, expectedTip: string | null): string[] {
  return [
    ...NETWORK_CONFIG, 'push', '--porcelain', '--no-recurse-submodules', '--no-follow-tags', '--no-signed', '--no-verify',
    `--force-with-lease=${targetRef}:${expectedTip ?? ''}`,
    pushUrl, `${expectedHead}:${targetRef}`,
  ];
}

const local = (...args: string[]) => gitArgv('-c', 'log.showSignature=false', ...args);

/** The relay's argv prefix: its git dir, then the relay's forced options (no
 *  automatic gc or maintenance, HTTPS only). Every network call starts so. */
const inRelay = (relay: string, ...args: string[]) => [`--git-dir=${relay}`, ...relayGitConfigArgs([], ['https']), ...args];

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
 * Every config entry the repository sets (local and worktree, includes
 * followed), or null when git cannot say. Global and system are off; the
 * `command` scope is this module's own `-c` and is left out.
 */
async function repoConfig(run: PaneGit): Promise<RawGitConfigEntry[] | null> {
  const out = await run('config', '--list', '-z', '--includes', '--show-scope');
  if (!out.ok) return null;
  return parseRawGitConfigList(out.stdout).filter((e) => e.scope !== 'command');
}

/** A local git call on the pane repository, by its pinned git dirs. */
type PaneGit = (...args: string[]) => Promise<GitRunResult>;

/** The pane repository's git dirs, canonical: the worktree's own git dir and
 *  the common dir. */
export interface PaneGitDirs { gitDir: string; commonDir: string }

/**
 * Find the pane repository's git dirs once, from the session's cwd: the
 * common dir must be the one the routes resolved (`expectedCommon`), and the
 * git dir must be it or one of its `worktrees/<id>`. Null when git cannot say
 * or the dirs do not match.
 */
async function paneGitDirs(git: PushGitRunner, cwd: string, env: NodeJS.ProcessEnv, expectedCommon: string): Promise<PaneGitDirs | null> {
  const out = await git(local('rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'), cwd, env);
  if (!out.ok) return null;
  const [rawGit, rawCommon] = out.stdout.split('\n');
  if (!rawGit || !rawCommon || !path.isAbsolute(rawGit) || !path.isAbsolute(rawCommon)) return null;
  let gitDir: string;
  let commonDir: string;
  try {
    gitDir = await fs.promises.realpath(rawGit);
    commonDir = await fs.promises.realpath(rawCommon);
  } catch {
    return null;
  }
  if (!expectedCommon || pathKey(commonDir) !== pathKey(await canonicalPath(expectedCommon))) return null;
  if (pathKey(gitDir) !== pathKey(commonDir) && pathKey(path.dirname(gitDir)) !== pathKey(path.join(commonDir, 'worktrees'))) return null;
  return { gitDir, commonDir };
}

/** Local git on the pinned dirs: `--git-dir` and `GIT_COMMON_DIR` named, run
 *  from a folder of no repository's, so git never looks one up. */
function paneGit(git: PushGitRunner, dirs: PaneGitDirs, env: NodeJS.ProcessEnv): PaneGit {
  const pinned = { ...env, GIT_COMMON_DIR: dirs.commonDir };
  return (...args) => git(local(`--git-dir=${dirs.gitDir}`, ...args), os.homedir(), pinned);
}

/**
 * The repository `origin` fetches from and pushes to, from git's own
 * expansion of the URLs. Every URL must be HTTPS github.com and name the same
 * repository; `pushUrl` is the one URL every network call then uses. Local only.
 */
async function originRepo(run: PaneGit): Promise<{ ownerRepo: string; pushUrl: string } | null> {
  const fetchUrls = await run('remote', 'get-url', '--all', 'origin');
  const pushUrls = await run('remote', 'get-url', '--push', '--all', 'origin');
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

/** The remote's tip of `ref`, null when it has none. Read in `relay`. */
async function remoteTipOf(remote: PushGitRunner, relay: string, where: string, ref: string, env: NodeJS.ProcessEnv, login: string): Promise<{ tip: string | null } | { fail: GitWriteErrorBody }> {
  const out = await remote(inRelay(relay, ...NETWORK_CONFIG, 'ls-remote', '--refs', where, ref), relay, env);
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

// ── Relay ────────────────────────────────────────────────────────────────────

/** What a relay borrows from the pane repository. */
interface RelaySource {
  commonDir: string;
  objectFormat: 'sha1' | 'sha256';
  /** The pane repository's shallow list, or '' when it is complete. */
  shallow: string;
}

/**
 * Run `fn` with a fresh bare relay repository under the daemon's data folder,
 * removed afterwards. With a `source`, the relay borrows its objects (and its
 * shallow list, so a push from a shallow clone stops where the clone does).
 * Null when the relay cannot be made; `fn` has not run then. What `fn` throws
 * is thrown.
 */
async function withRelay<T>(deps: PhoneGitPushDeps, source: RelaySource | null, fn: (relay: string) => Promise<T>): Promise<{ value: T } | null> {
  const dir = await makeRelay(deps, source);
  if (!dir) return null;
  try {
    return { value: await fn(dir) };
  } finally {
    removeRelay(dir);
  }
}

function removeRelay(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swept at the next start */ }
}

/** Make one relay, or null (nothing left behind) when it cannot be made. */
async function makeRelay(deps: PhoneGitPushDeps, source: RelaySource | null): Promise<string | null> {
  let dir: string | null = null;
  try {
    const root = path.join(deps.stateDir(), PHONE_GIT_RELAY_DIR);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    dir = path.join(root, crypto.randomBytes(12).toString('hex'));
    fs.mkdirSync(dir, { mode: 0o700 });
    const init = await deps.git(
      local(`--git-dir=${dir}`, 'init', '-q', '--bare', '--template=', `--object-format=${source?.objectFormat ?? 'sha1'}`),
      dir, isolatedEnv(deps.baseEnv()),
    );
    if (!init.ok) throw new Error(init.stderr.trim().slice(0, 300) || 'git init failed');
    if (source) {
      fs.mkdirSync(path.join(dir, 'objects', 'info'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'objects', 'info', 'alternates'), `${path.join(source.commonDir, 'objects')}\n`);
      if (source.shallow) fs.writeFileSync(path.join(dir, 'shallow'), source.shallow);
    }
    return dir;
  } catch (error) {
    deps.log(`the relay could not be made: ${error instanceof Error ? error.message : String(error)}`);
    if (dir) removeRelay(dir);
    return null;
  }
}

/** Remove relays left by a daemon that stopped mid-call. Best effort. */
export function sweepPhoneGitRelays(stateDir: string, now: number): void {
  const root = path.join(stateDir, PHONE_GIT_RELAY_DIR);
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    const p = path.join(root, name);
    try {
      if (fs.lstatSync(p).mtimeMs <= now - RELAY_SWEEP_AGE_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

// ── Verified ancestry ───────────────────────────────────────────────────────

/** The most commits a fast-forward check reads before it asks GitHub instead. */
export const PUSH_ANCESTRY_MAX_COMMITS = 2000;
/** The most bytes of commit objects that check reads. */
const PUSH_ANCESTRY_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Whether `tip` is an ancestor of `head`, from commits whose content hashes to
 * their own ids: the walk from `head` reads each commit's raw object
 * (`cat-file --batch`, replacement refs off), re-hashes it, and follows only
 * the parents written in it. `unverified` when an object is not a commit
 * matching its id, the walk passes PUSH_ANCESTRY_MAX_COMMITS, or git fails.
 */
async function verifiedAncestor(
  deps: PhoneGitPushDeps, dirs: PaneGitDirs, env: NodeJS.ProcessEnv, objectFormat: 'sha1' | 'sha256', tip: string, head: string,
): Promise<'ancestor' | 'not-ancestor' | 'unverified'> {
  const idRe = objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  if (!idRe.test(tip) || !idRe.test(head)) return 'unverified';
  if (tip === head) return 'ancestor';
  const pinned = { ...env, GIT_COMMON_DIR: dirs.commonDir, GIT_NO_REPLACE_OBJECTS: '1' };
  const seen = new Set<string>([head]);
  let frontier = [head];
  let bytes = 0;
  while (frontier.length > 0) {
    const out = await deps.gitInput(local(`--git-dir=${dirs.gitDir}`, 'cat-file', '--batch'), os.homedir(), pinned, `${frontier.join('\n')}\n`, PUSH_ANCESTRY_MAX_BYTES - bytes);
    if (!out.ok) return 'unverified';
    bytes += out.stdout.length;
    const next: string[] = [];
    let at = 0;
    for (const oid of frontier) {
      const nl = out.stdout.indexOf(0x0a, at);
      if (nl < 0) return 'unverified';
      const header = out.stdout.subarray(at, nl).toString('latin1').split(' ');
      // A missing parent (a shallow boundary) ends that line of history.
      if (header.length === 2 && header[0] === oid && header[1] === 'missing') { at = nl + 1; continue; }
      if (header.length !== 3 || header[0] !== oid || header[1] !== 'commit' || !/^\d+$/.test(header[2] as string)) return 'unverified';
      const size = Number(header[2]);
      const body = out.stdout.subarray(nl + 1, nl + 1 + size);
      if (body.length !== size || out.stdout[nl + 1 + size] !== 0x0a) return 'unverified';
      at = nl + 2 + size;
      const id = crypto.createHash(objectFormat).update(`commit ${size}\0`).update(body).digest('hex');
      if (id !== oid) return 'unverified';
      // A commit's parents are the `parent` lines right after `tree`, and only
      // those: git stops at the first header line that is not `parent`, so a
      // later `parent` (after `author`/`committer`) is not an ancestor edge.
      const end = body.indexOf('\n\n');
      const headerLines = body.subarray(0, end < 0 ? body.length : end).toString('latin1').split('\n');
      if (!headerLines[0]?.startsWith('tree ')) return 'unverified';
      for (let k = 1; k < headerLines.length; k++) {
        const line = headerLines[k] as string;
        if (!line.startsWith('parent ')) break;
        const parent = line.slice('parent '.length);
        if (!idRe.test(parent)) return 'unverified';
        if (parent === tip) return 'ancestor';
        if (seen.has(parent)) continue;
        seen.add(parent);
        next.push(parent);
      }
    }
    if (at !== out.stdout.length) return 'unverified';
    if (seen.size > PUSH_ANCESTRY_MAX_COMMITS) return 'unverified';
    frontier = next;
  }
  return 'not-ancestor';
}

/**
 * Whether pushing `head` onto `tip` is a fast-forward, from verified
 * ancestry only: the re-hashed local walk, and when that cannot answer,
 * GitHub's compare (which knows only commits already pushed). False on any
 * doubt.
 */
async function verifiedFastForward(
  deps: PhoneGitPushDeps, dirs: PaneGitDirs, env: NodeJS.ProcessEnv, objectFormat: 'sha1' | 'sha256',
  tip: string, head: string, ownerRepo: string, net: NodeJS.ProcessEnv,
): Promise<boolean> {
  const walked = await verifiedAncestor(deps, dirs, env, objectFormat, tip, head);
  if (walked !== 'unverified') return walked === 'ancestor';
  const cmp = await deps.gh(['api', '--hostname', 'github.com', `repos/${ownerRepo}/compare/${tip}...${head}`], net);
  if (!cmp.ok) return false;
  try {
    const status = (JSON.parse(cmp.stdout) as { status?: unknown }).status;
    return status === 'ahead' || status === 'identical';
  } catch {
    return false;
  }
}

// ── Facts ────────────────────────────────────────────────────────────────────

type Facts = Omit<PushPreviewFacts, 'identity'> & { ownerRepo: string; pushUrl: string };
type Gathered = { ok: true; facts: Facts; dirs: PaneGitDirs; source: RelaySource } | { ok: false; body: GitWriteErrorBody };

const failed = (body: GitWriteErrorBody): Gathered => ({ ok: false, body });
const gitFailed = (): Gathered => failed({ error: 'git-operation-failed' });

/** What an execute re-reads against: the preview's pins. */
interface GatherPin { ref: string; head: string; repo: string; pushUrl: string; gitDir: string; commonDir: string }

/** The pane repository's shallow list, '' when it has none, null when it
 *  cannot be read as one. Read by the daemon itself, bounded, no symlink. */
async function shallowList(commonDir: string, objectFormat: 'sha1' | 'sha256'): Promise<string | null> {
  const p = path.join(commonDir, 'shallow');
  try {
    await fs.promises.lstat(p);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null;
  }
  const text = await readWorkerFile(p, SHALLOW_MAX);
  const ids = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const idRe = objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  if (text === null || ids.length === 0 || !ids.every((id) => idRe.test(id))) return null;
  return `${[...new Set(ids)].join('\n')}\n`;
}

/**
 * Read every fact a push is decided on. Local first: the branch, its upstream
 * and the origin URLs; only then gh and `ls-remote`. `pin` (execute) names the
 * branch ref and the commit instead of reading HEAD, and the git dirs and URL
 * the preview found.
 */
async function gather(ctx: GitWriteSessionContext, deps: PhoneGitPushDeps, pin?: GatherPin): Promise<Gathered> {
  const base = deps.baseEnv();
  const env = isolatedEnv(base);
  const stale = (): Gathered => failed({ error: 'stale', head: pin?.head });

  // The one lookup through the session's cwd; every later call names the dirs.
  const dirs = await paneGitDirs(deps.git, ctx.cwd, env, ctx.repo.commonReal);
  if (!dirs) return pin ? stale() : gitFailed();
  if (pin && (dirs.gitDir !== pin.gitDir || dirs.commonDir !== pin.commonDir)) return stale();
  const run = paneGit(deps.git, dirs, env);

  const config = await repoConfig(run);
  if (!config) return gitFailed();
  const own = (key: string) => config.filter((e) => e.key === key).at(-1)?.value;
  const format = (own('extensions.objectformat') ?? 'sha1').toLowerCase();
  if (format !== 'sha1' && format !== 'sha256') return gitFailed();
  const objectFormat: 'sha1' | 'sha256' = format;
  // A partial clone would fetch what it lacks; this push never runs on one.
  if (config.some((e) => e.key === 'extensions.partialclone' || /^remote\..+\.promisor$/.test(e.key))) return failed({ error: 'remote-unsupported' });

  let ref: string;
  let head: string;
  if (pin) {
    ref = pin.ref;
    const has = await run('cat-file', '-e', `${pin.head}^{commit}`);
    if (!has.ok) return has.ran === false ? gitFailed() : failed({ error: 'stale', head: pin.head });
    head = pin.head;
  } else {
    // HEAD from the git dir's own file, strictly: a branch or a commit id.
    const text = await readWorkerFile(path.join(dirs.gitDir, 'HEAD'));
    const parsed = text === null ? null : parseTaskHead(text, objectFormat);
    if (!parsed) return gitFailed();
    if (parsed.kind === 'oid') return failed({ error: 'detached-head' });
    ref = parsed.ref;
    const h = await run('rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`);
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
  if (config.some((e) => isolatedConfigKey(e.key))) return failed({ error: 'remote-unsupported' });
  const origin = await originRepo(run);
  if (!origin) return failed({ error: 'remote-unsupported' });
  const { ownerRepo, pushUrl } = origin;
  // Execute: the URL the person confirmed, or nothing goes out.
  if (pin && (ownerRepo !== pin.repo || pushUrl !== pin.pushUrl)) return failed({ error: 'stale', head: pin.head });
  const shallow = await shallowList(dirs.commonDir, objectFormat);
  if (shallow === null) return gitFailed();
  const source: RelaySource = { commonDir: dirs.commonDir, objectFormat, shallow };

  const net = networkEnv(base, ctx.ghEnv);
  const def = await defaultBranch(deps.gh, ownerRepo, net, ctx.login);
  if ('fail' in def) return failed(def.fail);
  if (def.ref === targetRef) return failed({ error: 'protected-target' });

  const tipRead = await withRelay(deps, source, (relay) => remoteTipOf(deps.remote, relay, pushUrl, targetRef, net, ctx.login));
  if (!tipRead) return gitFailed();
  if ('fail' in tipRead.value) return failed(tipRead.value.fail);
  const remoteTip = tipRead.value.tip;
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
    // The count above follows the repository's own objects; whether the push
    // may go is decided on verified ancestry.
    fastForward = behind === 0 && await verifiedFastForward(deps, dirs, env, objectFormat, remoteTip, head, ownerRepo, net);
    if (!fastForward) behind = Math.max(behind, 1);
  } else if (remoteTip !== null) {
    // The remote holds commits this clone never fetched: at least one.
    behind = 1;
  }
  // No upstream: the same-named remote branch is pushed to only when it is
  // already in this branch's history (one this push created earlier, say).
  if (!hasUpstream && remoteTip !== null && !fastForward) return failed({ error: 'remote-branch-exists' });
  const tracking = await run('rev-parse', '--verify', '-q', '--end-of-options', `refs/remotes/origin/${targetRef.slice('refs/heads/'.length)}^{commit}`);
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
    dirs, source,
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
  /** The push creates the remote branch. */
  create: boolean;
  /** The verified remote tip the fast-forward was checked against (null on a
   *  create): the push leases it. */
  remoteTip: string | null;
  expectedHead: string;
  login: string;
  /** The session's spawn cwd. */
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
    && (e.remoteTip === null || (typeof e.remoteTip === 'string' && GIT_WRITE_OID.test(e.remoteTip)))
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
  // Owner-only, like the receipt store: the directory (also when an earlier build made it) and its files.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700);
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
 * from it. The tip is read in `relay`; the ancestry comes from GitHub's
 * compare, never from the pane repository's own history.
 */
async function pushLanded(deps: PhoneGitPushDeps, intent: Omit<PushIntent, 'startedAt'>, net: NodeJS.ProcessEnv, relay: string): Promise<Landed> {
  const tipRead = await remoteTipOf(deps.remote, relay, intent.pushUrl, intent.targetRef, net, intent.login);
  if ('fail' in tipRead) return 'unknown';
  const tip = tipRead.tip;
  if (tip === null) return 'not-landed';
  if (tip === intent.expectedHead) return 'landed';
  const cmp = await deps.gh(['api', '--hostname', 'github.com', `repos/${intent.ownerRepo}/compare/${intent.expectedHead}...${tip}`], net);
  if (!cmp.ok) return /HTTP 404/.test(cmp.stderr) ? 'not-landed' : 'unknown';
  try {
    const status = (JSON.parse(cmp.stdout) as { status?: unknown }).status;
    if (status === 'identical' || status === 'ahead') return 'landed';
    if (status === 'behind' || status === 'diverged') return 'not-landed';
  } catch { /* unknown */ }
  return 'unknown';
}

// ── Handlers ─────────────────────────────────────────────────────────────────

const running = new Map<string, number>();
let runningTotal = 0;

export function createPhoneGitPushHandlers(deps: PhoneGitPushDeps = defaultPushDeps) {
  async function preview(ctx: GitWriteSessionContext): Promise<GitWritePreviewResult> {
    const g = await gather(ctx, deps);
    if (!g.ok) return { ok: false, body: g.body };
    const { ownerRepo, pushUrl, ...facts } = g.facts;
    const { dirs } = g;
    return {
      ok: true,
      facts,
      pins: {
        head: facts.head, ref: facts.ref, targetRef: facts.target.ref, remoteTip: facts.remoteTip,
        repo: ownerRepo, pushUrl, gitDir: dirs.gitDir, commonDir: dirs.commonDir,
      },
    };
  }

  async function execute(ctx: GitWriteExecuteContext): Promise<void> {
    const body = ctx.body as PushExecuteBody;
    const pins = ctx.pins;
    if (!pins || typeof pins.ref !== 'string' || typeof pins.targetRef !== 'string' || typeof pins.repo !== 'string' || typeof pins.pushUrl !== 'string'
      || typeof pins.gitDir !== 'string' || typeof pins.commonDir !== 'string') {
      return ctx.settle({ state: 'refused', error: 'confirm-required' });
    }
    const mine = running.get(ctx.owner) ?? 0;
    if (mine >= MAX_PUSHES_PER_OWNER || runningTotal >= MAX_PUSHES) return ctx.settle({ state: 'refused', error: 'git-busy' });
    running.set(ctx.owner, mine + 1);
    runningTotal += 1;
    try {
      await executePinned(ctx, body, {
        ref: pins.ref, targetRef: pins.targetRef, remoteTip: pins.remoteTip as string | null, repo: pins.repo, pushUrl: pins.pushUrl,
        gitDir: pins.gitDir, commonDir: pins.commonDir,
      });
    } finally {
      runningTotal -= 1;
      const left = (running.get(ctx.owner) ?? 1) - 1;
      if (left > 0) running.set(ctx.owner, left); else running.delete(ctx.owner);
    }
  }

  type Pinned = { ref: string; targetRef: string; remoteTip: string | null; repo: string; pushUrl: string; gitDir: string; commonDir: string };

  async function executePinned(ctx: GitWriteExecuteContext, body: PushExecuteBody, pins: Pinned): Promise<void> {
    const refuse = (b: GitWriteErrorBody) => {
      const { error, ...extras } = b;
      const fields = Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== undefined)) as Record<string, string | number | null>;
      ctx.settle({ state: 'refused', error, ...(Object.keys(fields).length ? { fields } : {}) });
    };
    // Re-read every pinned fact; the commit pushed is `expectedHead`, whatever HEAD is now.
    const g = await gather(ctx, deps, {
      ref: pins.ref, head: body.expectedHead, repo: pins.repo, pushUrl: pins.pushUrl, gitDir: pins.gitDir, commonDir: pins.commonDir,
    });
    if (!g.ok) return refuse(g.body);
    const f = g.facts;
    if (!f.fastForward) return refuse({ error: 'non-fast-forward', remoteTip: f.remoteTip, behind: f.behind });
    if (f.target.ref !== pins.targetRef || f.remoteTip !== pins.remoteTip) return refuse({ error: 'stale', head: body.expectedHead });

    const net = networkEnv(deps.baseEnv(), ctx.ghEnv);
    const intent: PushIntent = {
      ownerRepo: f.ownerRepo, pushUrl: f.pushUrl, ref: f.ref, targetRef: f.target.ref, create: f.target.create,
      remoteTip: f.remoteTip, expectedHead: body.expectedHead, login: ctx.login, cwd: ctx.cwd, startedAt: deps.now(),
    };
    const dir = deps.stateDir();
    const key = GitWriteReceipts.key(ctx.owner, ctx.requestId);
    try {
      writePushIntent(dir, key, intent, deps.now());
    } catch (error) {
      deps.log(`the push intent could not be written: ${error instanceof Error ? error.message : String(error)}`);
      return refuse({ error: 'git-receipts-unavailable' });
    }
    try {
      // The relay is made before the receipt goes in flight: when it cannot
      // be, nothing was sent.
      const ran = await withRelay(deps, g.source, async (relay) => {
        ctx.markInFlight();
        return pushAndRead(ctx, intent, net, relay);
      });
      if (!ran) {
        removePushIntent(dir, key);
        return refuse({ error: 'git-operation-failed' });
      }
      const outcome = ran.value;
      if (outcome === 'unknown') throw new Error('push outcome unknown');
      if (outcome.state === 'done') {
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
  async function pushAndRead(ctx: GitWriteExecuteContext, intent: PushIntent, net: NodeJS.ProcessEnv, relay: string): Promise<{ state: 'done' } | { state: 'refused'; body: GitWriteErrorBody } | 'unknown'> {
    const out = await deps.push(inRelay(relay, ...pushArgv(intent.pushUrl, intent.expectedHead, intent.targetRef, intent.remoteTip)), relay, net, PUSH_TIMEOUT_MS);
    if (!out.spawned) return { state: 'refused', body: { error: 'git-operation-failed' } };
    if (out.code === 0 && !out.timedOut) return { state: 'done' };
    if (!out.timedOut) {
      const rejected = out.stdout.split('\n').find((l) => l.startsWith('!'));
      if (rejected && /non-fast-forward|fetch first|stale info/.test(rejected)) {
        const tip = await remoteTipOf(deps.remote, relay, intent.pushUrl, intent.targetRef, net, ctx.login);
        return { state: 'refused', body: { error: 'non-fast-forward', remoteTip: 'tip' in tip ? tip.tip : null } };
      }
      if (rejected || remoteFailure(out.stderr, ctx.login).error === 'remote-forbidden') {
        // Refused by the remote (permission, protection rule): nothing landed.
        return { state: 'refused', body: { error: 'remote-forbidden', login: ctx.login } };
      }
    }
    // Killed or failed on the way: the remote tip says whether it landed.
    const landed = await pushLanded(deps, intent, net, relay);
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
    const checked = await withRelay(deps, null, (relay) => pushLanded(deps, intent, net, relay).catch((): Landed => 'unknown'));
    const landed: Landed = checked ? checked.value : 'unknown';
    if (landed === 'unknown') { left += 1; continue; }
    if (landed === 'landed') {
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
  sweepPhoneGitRelays((opts.deps ?? defaultPushDeps).stateDir(), Date.now());
  schedule(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (activeRecovery === handle) activeRecovery = null;
  };
}

registerPhoneGitWriteAction('push', createPhoneGitPushHandlers());
