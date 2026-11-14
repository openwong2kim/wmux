// ─── Bringing back an agent's work: the import into the home repository ────
//
// The bundle another PC made of a spawn's branch (shared/a2aBundle.ts),
// staged by the daemon (daemon/a2aRemote/bundleIntake.ts), lands in exactly
// one branch of the home repository the fan-out row recorded:
// `refs/heads/wmux/returned/<spawnId>`. Nothing is checked out, no hook or
// configured program runs, and an existing branch only moves forward.
//
// Git never reads the bundle as a repository or through a transport: no
// fetch, no remote, no URL. The staged file is opened once, and from that one
// open file it is checked (a plain file of the size and hash its manifest
// names, whose header lists exactly one ref, the one this PC computed for the
// spawn, and only prerequisites the home repository has), then the pack after
// its header is handed to `git index-pack --stdin --strict`, which checks
// every object. The tip must be a commit whose history is complete, and the
// branch is then set with `git update-ref`, compare-and-swap.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { A2aBundleManifestV1 } from '../../shared/a2aBundle';
import { returnedBranchName, type BundleAskerRefusal, type HomeRepoConfigKind } from '../../shared/a2aBundleAsk';
import { isSpawnId } from '../../shared/a2aSpawn';
import { getExecEnv } from '../../shared/execEnv';
import { resolveExecutable } from '../../shared/exeSearch';
import { originUrlRepoKey, parseGitConfigList, workerGitConfigRefusal, workerGitEnv, workerGitSafeArgs, type GitConfigEntry } from './workerGit';

/** The longest a git call of the import may run before it (and anything it started) is killed. */
export const BUNDLE_IMPORT_TIMEOUT_MS = 120_000;
/**
 * The oldest git seen to refuse a bundle whose objects fail fsck: measured,
 * never guessed. An older git may take objects without checking them, so the
 * import refuses it. It applies to the git of the PC that imports (the asking
 * PC), not to the PC that made the bundle.
 */
export const BUNDLE_IMPORT_GIT_FLOOR: readonly [number, number, number] = [2, 50, 1];

/** `git --version` output → [major, minor, patch], or null when it cannot be read. Pure. */
export function parseGitVersion(out: string): [number, number, number] | null {
  const m = /^git version (\d+)\.(\d+)\.(\d+)/.exec(out.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `v` is at least the floor. Pure. */
export function gitAtLeast(v: readonly [number, number, number], floor: readonly [number, number, number] = BUNDLE_IMPORT_GIT_FLOOR): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== floor[i]) return v[i] > floor[i];
  return true;
}

/** The most of a bundle read for its header: a header is a few lines. */
const HEADER_READ_MAX = 64 * 1024;
/** The most of git's output kept. */
const OUTPUT_MAX = 1024 * 1024;

/**
 * The env of every git the import runs: the worker git env (no variable that
 * moves git to another repository or adds config), no global or system config,
 * no prompt, git's own words in English. `/dev/null` on every platform: Git for
 * Windows reads it as its null device.
 */
export function importGitEnv(base: NodeJS.ProcessEnv = getExecEnv()): NodeJS.ProcessEnv {
  return { ...workerGitEnv(base), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
}

export interface ImportGitOut { code: number; stdout: string; stderr: string }
/** Runs git in `cwd` with the import's env, `stdin` piped in when given; never throws. */
export type ImportGit = (args: string[], cwd: string, opts?: { stdin?: Readable; timeoutMs?: number }) => Promise<ImportGitOut>;

/** The import's git: past its time it is killed with its whole process group. */
export const importGit: ImportGit = (args, cwd, { stdin, timeoutMs = BUNDLE_IMPORT_TIMEOUT_MS } = {}) => new Promise((resolve) => {
  const env = importGitEnv();
  let stdout = '';
  let stderr = '';
  let settled = false;
  const done = (out: ImportGitOut): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(out);
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(resolveExecutable('git', { env }), args, {
      cwd, env, windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
  } catch (err) {
    resolve({ code: 1, stdout: '', stderr: String(err) });
    return;
  }
  const kill = (): void => {
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const timer = setTimeout(() => {
    kill();
    done({ code: 1, stdout, stderr: `${stderr}\ngit ran past ${timeoutMs} ms and was stopped` });
  }, timeoutMs);
  timer.unref?.();
  child.stdout?.on('data', (b: Buffer) => { if (stdout.length < OUTPUT_MAX) stdout += b.toString('utf8'); });
  child.stderr?.on('data', (b: Buffer) => { if (stderr.length < OUTPUT_MAX) stderr += b.toString('utf8'); });
  if (stdin && child.stdin) {
    child.stdin.on('error', () => undefined);
    stdin.on('error', (err) => {
      kill();
      done({ code: 1, stdout, stderr: String(err) });
    });
    stdin.pipe(child.stdin);
  }
  child.on('error', (err) => done({ code: 1, stdout, stderr: String(err) }));
  child.on('close', (code) => {
    stdin?.destroy();
    done({ code: code ?? 1, stdout, stderr });
  });
});

export interface BundleHeader {
  version: 2 | 3;
  objectFormat: 'sha1' | 'sha256';
  prerequisites: string[];
  refs: { oid: string; name: string }[];
  /** Where the pack starts: just past the header's empty line. */
  packOffset: number;
}

/**
 * A git bundle's header, or null when it is not one this PC reads: v2 or v3,
 * no capability but `object-format` (sha1 or sha256), prerequisites and refs
 * with object ids of that format, ended by an empty line. Pure.
 */
export function parseBundleHeader(buf: Buffer): BundleHeader | null {
  const end = buf.indexOf('\n\n');
  if (end < 0) return null;
  const lines = buf.subarray(0, end).toString('latin1').split('\n');
  const sig = lines.shift();
  const version = sig === '# v2 git bundle' ? 2 : sig === '# v3 git bundle' ? 3 : null;
  if (!version) return null;
  let objectFormat: 'sha1' | 'sha256' = 'sha1';
  const prerequisites: string[] = [];
  const refs: { oid: string; name: string }[] = [];
  let caps = version === 3;
  for (const line of lines) {
    if (caps && line.startsWith('@')) {
      const m = /^@object-format=(sha1|sha256)$/.exec(line);
      if (!m) return null;
      objectFormat = m[1] as 'sha1' | 'sha256';
      continue;
    }
    caps = false;
    const hex = objectFormat === 'sha1' ? '[0-9a-f]{40}' : '[0-9a-f]{64}';
    const pre = new RegExp(`^-(${hex})(?: .*)?$`).exec(line);
    if (pre) {
      prerequisites.push(pre[1]);
      continue;
    }
    const ref = new RegExp(`^(${hex}) (refs/[\\x21-\\x7e]+)$`).exec(line);
    if (!ref) return null;
    refs.push({ oid: ref[1], name: ref[2] });
  }
  return { version, objectFormat, prerequisites, refs, packOffset: end + 2 };
}

export type HomeRepoResult =
  | { ok: true; top: string; origin: string; linked: boolean }
  | { ok: false; reason: 'no-home-repo' }
  | { ok: false; reason: 'home-repo-config'; kind: HomeRepoConfigKind };

/** Keys that would weaken git's object checks. */
const FSCK_KEY_RE = /^(?:fsck\.|fetch\.fsck|receive\.fsck|transfer\.fsck)/;

/** The kind of a config key main does not run git with (home-repo-config's words). Pure. */
export function homeRepoConfigKind(key: string): HomeRepoConfigKind {
  if (FSCK_KEY_RE.test(key)) return 'fsck';
  if (key.startsWith('credential.')) return 'credential';
  if (key.startsWith('include.') || key.startsWith('includeif.')) return 'include';
  if (key.startsWith('protocol.')) return 'protocol';
  if (key.startsWith('url.')) return 'url';
  if (key.startsWith('remote.')) return 'remote';
  if (key.startsWith('push.')) return 'push';
  if (key.startsWith('http.') || key.startsWith('ssh.')) return 'transport';
  if (key.startsWith('gpg.')) return 'signing';
  if (key.startsWith('filter.')) return 'filter';
  return 'core';
}

/** The kind of the first of the repository's own keys main refuses (a program it would run, or weaker checks), or null. Pure. */
export function homeConfigRefusal(entries: readonly GitConfigEntry[]): HomeRepoConfigKind | null {
  const hit = entries.find((e) => workerGitConfigRefusal([e]) !== null
    || ((e.scope === 'local' || e.scope === 'worktree') && FSCK_KEY_RE.test(e.key)));
  return hit ? homeRepoConfigKind(hit.key) : null;
}

/** The repository's own config as git reads it now (`git config --list`), or null when it cannot be read. */
async function readOwnConfig(run: (args: string[]) => Promise<ImportGitOut>): Promise<GitConfigEntry[] | null> {
  const cfg = await run(['config', '-z', '--list', '--show-scope']);
  return cfg.code === 0 ? parseGitConfigList(cfg.stdout) : null;
}

const realOrNull = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

/**
 * The recorded home repository as it is now: still a folder that is its own
 * git top level, with no program and no weakened check in its own config, and
 * the key of its one origin URL (what the box checks its worktree against).
 * `linked` when it is a linked worktree: its branches live in the repository
 * it shares. Never throws.
 */
export async function openHomeRepo(homeRepo: string, git: ImportGit = importGit): Promise<HomeRepoResult> {
  const noRepo = { ok: false as const, reason: 'no-home-repo' as const };
  let real: string | null = null;
  try {
    // The native realpath: it also expands a Windows short (8.3) name, as git's own path does.
    if (fs.lstatSync(homeRepo).isDirectory()) real = realOrNull(homeRepo);
  } catch {
    real = null;
  }
  if (!real) return noRepo;
  const cwd = real;
  const run = (args: string[]): Promise<ImportGitOut> => git(['-c', 'core.fsmonitor=false', ...args], cwd);
  const top = await run(['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || realOrNull(top.stdout.trim()) !== real) return noRepo;
  const entries = await readOwnConfig(run);
  if (!entries) return noRepo;
  const kind = homeConfigRefusal(entries);
  if (kind) return { ok: false, reason: 'home-repo-config', kind };
  const urls = entries.filter((e) => (e.scope === 'local' || e.scope === 'worktree') && e.key === 'remote.origin.url');
  const origin = urls.length === 1 ? originUrlRepoKey(urls[0].value) : null;
  if (!origin) return noRepo;
  const dirs = await run(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  const [gitDir, commonDir] = dirs.code === 0 ? dirs.stdout.trim().split('\n').map((d) => realOrNull(d.trim())) : [null, null];
  return { ok: true, top: real, origin, linked: gitDir !== null && commonDir !== null && gitDir !== commonDir };
}

/**
 * The empty folder every import git takes as core.hooksPath, made 0700 when
 * missing: usable only while it is a real folder (not a link), ours, and empty.
 */
export function noHooksDirReady(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

export interface BundleImportInput {
  /** The home repository's top level (openHomeRepo). */
  top: string;
  /** Checked here before it names a branch. */
  spawnId: string;
  /** The staged file and the manifest it was staged under. */
  file: string;
  manifest: A2aBundleManifestV1;
  /** The one ref the bundle may hold, computed on this PC (bundleRefName). */
  ref: string;
  /** An empty folder for core.hooksPath (noHooksDirReady). */
  noHooksDir: string;
}

export type BundleImportResult =
  | { ok: true; branch: string; sha: string; noop: boolean; warnings: BundleImportWarning[] }
  | { ok: false; reason: Extract<BundleAskerRefusal, 'base-not-local' | 'not-fast-forward' | 'bundle-unexpected' | 'import-failed' | 'git-too-old'> }
  | { ok: false; reason: 'home-repo-config'; kind: HomeRepoConfigKind };

/** What the imported work holds that a branch alone does not bring (fixed words only). */
export type BundleImportWarning = 'submodules' | 'lfs';

export const BUNDLE_IMPORT_WARNING_TEXT: Record<BundleImportWarning, string> = {
  submodules: 'the work has submodules: their contents are not brought back',
  lfs: 'the work uses Git LFS: its large files stay pointers until they are fetched from the LFS server',
};

/** The staged file, checked as the manifest names it, then its objects and its one branch. Never throws. */
export async function importBundle(
  input: BundleImportInput,
  git: ImportGit = importGit,
  /** Test-only seam: the floor's measurement bypasses it to test git itself. Callers leave it as shipped. */
  gitFloor: readonly [number, number, number] = BUNDLE_IMPORT_GIT_FLOOR,
): Promise<BundleImportResult> {
  const unexpected = { ok: false as const, reason: 'bundle-unexpected' as const };
  const failed = { ok: false as const, reason: 'import-failed' as const };
  if (!isSpawnId(input.spawnId)) return unexpected;
  const branch = returnedBranchName(input.spawnId);
  const target = `refs/heads/${branch}`;
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(input.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return unexpected;
  }
  try {
    // Checked, then read by git, through this one open file.
    const header = await readCheckedHeader(fh, input.manifest).catch(() => null);
    if (!header || header.refs.length !== 1 || header.refs[0].name !== input.ref) return unexpected;
    const tip = header.refs[0].oid;
    // Checked right before the first git that takes it.
    if (!noHooksDirReady(input.noHooksDir)) return failed;
    const safe = ['--no-replace-objects', ...workerGitSafeArgs(input.noHooksDir), '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
    const run = (args: string[], stdin?: Readable): Promise<ImportGitOut> => git([...safe, ...args], input.top, { stdin });
    // A git older than the floor may not check the objects: nothing is taken in with it.
    const version = await run(['--version']);
    const v = version.code === 0 ? parseGitVersion(version.stdout) : null;
    if (!v || !gitAtLeast(v, gitFloor)) return { ok: false, reason: 'git-too-old' };
    // The bundle's object format is the repository's (a git that cannot say has only sha1).
    const fmt = await run(['rev-parse', '--show-object-format']);
    if ((fmt.code === 0 ? fmt.stdout.trim() : 'sha1') !== header.objectFormat) return unexpected;
    const commitOf = async (rev: string): Promise<string | null> => {
      const r = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
      return r.code === 0 ? r.stdout.trim() : null;
    };
    for (const oid of header.prerequisites) {
      // eslint-disable-next-line no-await-in-loop -- a bundle has a few prerequisites
      if (!(await commitOf(oid))) return { ok: false, reason: 'base-not-local' };
    }
    const before = await commitOf(target);
    if (before === tip) return { ok: true, branch, sha: tip, noop: true, warnings: await warningsOf(run, tip) };
    // The repository's config read again right before git takes the objects: it may have changed since it was opened.
    const entries = await readOwnConfig(run);
    if (!entries) return failed;
    const kind = homeConfigRefusal(entries);
    if (kind) return { ok: false, reason: 'home-repo-config', kind };
    // Every object checked; a thin pack completed from the prerequisites. A refused pack is never installed
    // (at most a temporary file is left, which git's own gc removes).
    const indexed = await run(['index-pack', '--stdin', '--fix-thin', '--strict', '--fsck-objects'],
      fh.createReadStream({ start: header.packOffset, autoClose: false }));
    if (indexed.code !== 0) return failed;
    // From here a refusal leaves only objects no ref reaches (git's own pruning removes them).
    const type = await run(['cat-file', '-t', tip]);
    if (type.code !== 0 || type.stdout.trim() !== 'commit') return failed;
    // Its history is complete: everything past the prerequisites is here.
    const complete = await run(['rev-list', '--objects', '--quiet', tip, '--not', ...header.prerequisites]);
    if (complete.code !== 0) return failed;
    if (before !== null) {
      const ahead = await run(['merge-base', '--is-ancestor', '--end-of-options', before, tip]);
      if (ahead.code === 1) return { ok: false, reason: 'not-fast-forward' };
      if (ahead.code !== 0) return failed;
    }
    // update-ref moves a branch a worktree has checked out: such a branch is refused here.
    const worktrees = await run(['worktree', 'list', '--porcelain']);
    if (worktrees.code !== 0 || worktrees.stdout.split('\n').some((l) => l.trim() === `branch ${target}`)) return failed;
    // A symbolic ref there would move the branch it points to.
    if ((await run(['symbolic-ref', '-q', target])).code !== 1) return failed;
    const zero = '0'.repeat(header.objectFormat === 'sha1' ? 40 : 64);
    // Compare-and-swap: only from the commit read above (or from nothing).
    const updated = await run(['update-ref', '--no-deref', '-m', 'wmux: bring back', target, tip, before ?? zero]);
    if (updated.code !== 0 || (await commitOf(target)) !== tip) return failed;
    return { ok: true, branch, sha: tip, noop: false, warnings: await warningsOf(run, tip) };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** The header of the open staged file, once it is a plain file of the manifest's size and hash; null otherwise. */
async function readCheckedHeader(fh: fs.promises.FileHandle, m: A2aBundleManifestV1): Promise<BundleHeader | null> {
  const st = await fh.stat();
  if (!st.isFile() || st.size !== m.bytes) return null;
  const hash = crypto.createHash('sha256');
  const head = Buffer.alloc(Math.min(HEADER_READ_MAX, m.bytes));
  let headLen = 0;
  const chunk = Buffer.alloc(1024 * 1024);
  let pos = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- one read at a time, bounded by the manifest's size
    const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    if (headLen < head.length) headLen += chunk.copy(head, headLen, 0, Math.min(bytesRead, head.length - headLen));
    pos += bytesRead;
    if (pos > m.bytes) return null;
  }
  if (pos !== m.bytes || hash.digest('hex') !== m.sha256) return null;
  return parseBundleHeader(head.subarray(0, headLen));
}

/** Submodules and LFS in the imported tip: read from its tree, never shown. */
async function warningsOf(run: (args: string[]) => Promise<ImportGitOut>, tip: string): Promise<BundleImportWarning[]> {
  const out: BundleImportWarning[] = [];
  if ((await run(['cat-file', '-e', `${tip}:.gitmodules`])).code === 0) out.push('submodules');
  const attrs = await run(['cat-file', 'blob', `${tip}:.gitattributes`]);
  if (attrs.code === 0 && /filter=lfs/.test(attrs.stdout)) out.push('lfs');
  return out;
}
