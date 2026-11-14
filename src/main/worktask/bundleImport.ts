// ─── Bringing back an agent's work: the import into the home repository ────
//
// The bundle another PC made of a spawn's branch (shared/a2aBundle.ts),
// staged by the daemon (daemon/a2aRemote/bundleIntake.ts), is fetched into
// exactly one branch of the home repository the fan-out row recorded:
// `refs/heads/wmux/returned/<spawnId>`. Nothing is checked out, no hook or
// configured program runs, no tag or submodule is fetched, and an existing
// branch only moves forward.
//
// Before git touches the file it is checked here: a plain file of the size
// and hash its manifest names, whose header (v2 or v3, no capability but the
// object format) lists exactly one ref, the one this PC computed for the
// spawn, and only prerequisites the home repository already has. Git then
// reads it with every object checked (fsck).

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { A2aBundleManifestV1 } from '../../shared/a2aBundle';
import { returnedBranchName, type BundleAskerRefusal, type HomeRepoConfigKind } from '../../shared/a2aBundleAsk';
import { isSpawnId } from '../../shared/a2aSpawn';
import { defaultGit, type TaskPushGit } from './taskPush';
import { originUrlRepoKey, parseGitConfigList, workerGitConfigRefusal, workerGitSafeArgs, type GitConfigEntry } from './workerGit';

/** The longest a git call of the import may run before it is killed. */
export const BUNDLE_IMPORT_TIMEOUT_MS = 120_000;
/**
 * The oldest git seen to refuse a bundle whose objects fail fsck on fetch
 * (`fetch.fsckObjects`): measured, never guessed. An older git may fetch a
 * bundle without checking its objects, so the import refuses it.
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

/** Env over the worker git env (taskPush.ts): no global or system config, git's own words in English.
 *  `/dev/null` on every platform: Git for Windows reads it as its null device. */
const IMPORT_ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

export interface BundleHeader {
  version: 2 | 3;
  objectFormat: 'sha1' | 'sha256';
  prerequisites: string[];
  refs: { oid: string; name: string }[];
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
  return { version, objectFormat, prerequisites, refs };
}

export type HomeRepoResult =
  | { ok: true; top: string; origin: string }
  | { ok: false; reason: 'no-home-repo' }
  | { ok: false; reason: 'home-repo-config'; kind: HomeRepoConfigKind };

/** The kind of a config key main does not run git with (home-repo-config's words). Pure. */
export function homeRepoConfigKind(key: string): HomeRepoConfigKind {
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

/**
 * The recorded home repository as it is now: still a folder that is its own
 * git top level, with no program in its own config, and the key of its one
 * origin URL (what the box checks its worktree against). Never throws.
 */
export async function openHomeRepo(homeRepo: string, git: TaskPushGit = defaultGit): Promise<HomeRepoResult> {
  const noRepo = { ok: false as const, reason: 'no-home-repo' as const };
  let real: string;
  try {
    if (!fs.lstatSync(homeRepo).isDirectory()) return noRepo;
    // The native realpath: it also expands a Windows short (8.3) name, as git's own path does.
    real = fs.realpathSync.native(homeRepo);
  } catch {
    return noRepo;
  }
  const top = await git(['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], real, IMPORT_ENV, { timeoutMs: BUNDLE_IMPORT_TIMEOUT_MS });
  let topReal = '';
  try {
    topReal = top.code === 0 ? fs.realpathSync.native(top.stdout.trim()) : '';
  } catch {
    topReal = '';
  }
  if (!topReal || topReal !== real) return noRepo;
  const cfg = await git(['-c', 'core.fsmonitor=false', 'config', '-z', '--list', '--show-scope'], real, IMPORT_ENV, { timeoutMs: BUNDLE_IMPORT_TIMEOUT_MS });
  if (cfg.code !== 0) return noRepo;
  const entries = parseGitConfigList(cfg.stdout);
  // The first of its own keys main would refuse, told by its kind only.
  const hit = entries.find((e: GitConfigEntry) => workerGitConfigRefusal([e]) !== null);
  if (hit) return { ok: false, reason: 'home-repo-config', kind: homeRepoConfigKind(hit.key) };
  const urls = entries.filter((e) => (e.scope === 'local' || e.scope === 'worktree') && e.key === 'remote.origin.url');
  const origin = urls.length === 1 ? originUrlRepoKey(urls[0].value) : null;
  return origin ? { ok: true, top: real, origin } : noRepo;
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
  /** An empty folder for core.hooksPath. */
  noHooksDir: string;
}

export type BundleImportResult =
  | { ok: true; branch: string; sha: string; noop: boolean; warnings: BundleImportWarning[] }
  | { ok: false; reason: Extract<BundleAskerRefusal, 'base-not-local' | 'not-fast-forward' | 'bundle-unexpected' | 'import-failed' | 'git-too-old'> };

/** What the imported work holds that a branch alone does not bring (fixed words only). */
export type BundleImportWarning = 'submodules' | 'lfs';

export const BUNDLE_IMPORT_WARNING_TEXT: Record<BundleImportWarning, string> = {
  submodules: 'the work has submodules: their contents are not brought back',
  lfs: 'the work uses Git LFS: its large files stay pointers until they are fetched from the LFS server',
};

/** The staged file, checked as the manifest names it, then fetched into its one branch. Never throws. */
export async function importBundle(
  input: BundleImportInput,
  git: TaskPushGit = defaultGit,
  /** Test-only seam: the floor's measurement bypasses it to test git itself. Callers leave it as shipped. */
  gitFloor: readonly [number, number, number] = BUNDLE_IMPORT_GIT_FLOOR,
): Promise<BundleImportResult> {
  const unexpected = { ok: false as const, reason: 'bundle-unexpected' as const };
  if (!isSpawnId(input.spawnId)) return unexpected;
  const branch = returnedBranchName(input.spawnId);
  const target = `refs/heads/${branch}`;
  const header = await readCheckedHeader(input.file, input.manifest).catch(() => null);
  if (!header || header.refs.length !== 1 || header.refs[0].name !== input.ref) return unexpected;
  const tip = header.refs[0].oid;
  const safe = [...workerGitSafeArgs(input.noHooksDir), '-c', 'submodule.recurse=false'];
  const run = (args: string[]): ReturnType<TaskPushGit> => git([...safe, ...args], input.top, IMPORT_ENV, { timeoutMs: BUNDLE_IMPORT_TIMEOUT_MS });
  // A git older than the floor may not check the bundle's objects: nothing is fetched with it.
  const version = await run(['--version']);
  const v = version.code === 0 ? parseGitVersion(version.stdout) : null;
  if (!v || !gitAtLeast(v, gitFloor)) return { ok: false, reason: 'git-too-old' };
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
  const fetched = await run([
    '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', '-c', 'fetch.unpackLimit=1', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    'fetch', '--no-tags', '--recurse-submodules=no', '--no-write-fetch-head', '--no-auto-maintenance', '--no-write-commit-graph', '--quiet',
    // No `+`: an existing branch only moves forward.
    '--', input.file, `${input.ref}:${target}`,
  ]);
  if (fetched.code !== 0) {
    // The branch held other work when the bundle's tip does not descend from it. A refused ref update keeps the
    // pack, so the tip can be read; a pack refused (fsck) leaves none, and that is import-failed. Git's own words
    // are not read: with --quiet it prints none for a refused update.
    const notAhead = before !== null && (await commitOf(tip)) !== null
      && (await run(['merge-base', '--is-ancestor', '--end-of-options', before, tip])).code === 1;
    return { ok: false, reason: notAhead ? 'not-fast-forward' : 'import-failed' };
  }
  const after = await commitOf(target);
  if (after !== tip) return { ok: false, reason: 'import-failed' };
  return { ok: true, branch, sha: tip, noop: false, warnings: await warningsOf(run, tip) };
}

/** The header of the staged file, once it is a plain file of the manifest's size and hash; null otherwise. */
async function readCheckedHeader(file: string, m: A2aBundleManifestV1): Promise<BundleHeader | null> {
  const fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
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
  } finally {
    await fh.close();
  }
}

/** Submodules and LFS in the imported tip: read from its tree, never shown. */
async function warningsOf(run: (args: string[]) => ReturnType<TaskPushGit>, tip: string): Promise<BundleImportWarning[]> {
  const out: BundleImportWarning[] = [];
  if ((await run(['cat-file', '-e', `${tip}:.gitmodules`])).code === 0) out.push('submodules');
  const attrs = await run(['cat-file', 'blob', `${tip}:.gitattributes`]);
  if (attrs.code === 0 && /filter=lfs/.test(attrs.stdout)) out.push('lfs');
  return out;
}
