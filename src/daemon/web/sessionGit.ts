import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGitRunner, gitArgv, parseFilterNames, parsePorcelainZ, type GitRunner } from './sessionDiff';

export class SessionGitError extends Error {
  constructor(public readonly status: number, public readonly tag: string) { super(tag); }
}
export interface GitSnapshot {
  branch: string;
  /** Full symbolic ref of HEAD, e.g. `refs/heads/main`. The phone echoes it back
   * as `expectedRef` so a branch switch at the same HEAD/tree cannot pass. */
  ref: string;
  head: string | null;
  tree: string;
  files: ReturnType<typeof parsePorcelainZ>;
  lastSubject: string | null;
}
export interface GitMutationResult { applied: true; commit?: string }
export interface GitMutation {
  requestId: string;
  action: 'stage' | 'unstage' | 'commit';
  paths?: string[];
  message?: string;
  expectedHead: string | null;
  expectedTree: string;
  expectedRef: string;
}
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const WRITE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

/** Phone writes use literal paths, pinned trees and compare-and-swap refs. */
export class SessionGitController {
  private busy = new Set<string>();
  private receipts = new Map<string, { fingerprint: string; result: GitMutationResult }>();
  constructor(private readonly run: GitRunner = createGitRunner()) {}

  private async command(root: string, ...args: string[]) {
    const result = await this.run(gitArgv(...WRITE_CONFIG, ...args), root);
    if (!result.ok) throw new SessionGitError(409, 'git-operation-failed');
    return result.stdout.trimEnd();
  }

  private async root(cwd: string) {
    const result = await this.run(gitArgv('rev-parse', '--show-toplevel'), cwd);
    if (!result.ok) throw new SessionGitError(409, 'not-a-git-repo');
    return fs.realpath(result.stdout.trimEnd());
  }

  private async checkRepository(root: string) {
    // Do not silently stage unfiltered LFS/custom-filter bytes. These repos
    // require desktop Git, where the operator controls filter execution.
    const config = await this.command(root, 'config', '--list', '--name-only', '-z');
    if (parseFilterNames(config).length) throw new SessionGitError(409, 'git-filters-require-desktop');
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
      const location = await this.command(root, 'rev-parse', '--git-path', name);
      try {
        await fs.stat(path.resolve(root, location));
        throw new SessionGitError(409, 'git-operation-in-progress');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  /** The three values every write is compared against: the branch ref, the
   * commit it points at, and the index tree. Read on its own so a write can
   * re-read them immediately before it runs, with no listing in between. */
  private async position(root: string): Promise<{ref: string; head: string | null; tree: string}> {
    const ref = await this.command(root, 'symbolic-ref', 'HEAD');
    const headResult = await this.run(gitArgv('rev-parse', '--verify', '--quiet', 'HEAD'), root);
    if (!headResult.ok && headResult.code !== 1) throw new SessionGitError(409, 'git-operation-failed');
    const head = headResult.ok ? headResult.stdout.trim() : null;
    if (head !== null && !OID.test(head)) throw new SessionGitError(409, 'git-operation-failed');
    const tree = await this.command(root, 'write-tree');
    if (!OID.test(tree)) throw new SessionGitError(409, 'git-operation-failed');
    return {ref, head, tree};
  }

  private async snapshot(root: string): Promise<GitSnapshot> {
    await this.checkRepository(root);
    const branch = await this.command(root, 'symbolic-ref', '--short', 'HEAD');
    const {ref, head, tree} = await this.position(root);
    const files = parsePorcelainZ(await this.command(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'));
    const lastSubject = head ? await this.command(root, 'log', '-1', '--format=%s', head, '--') : null;
    return { branch, ref, head, tree, files, lastSubject };
  }

  async read(cwd: string) { return this.snapshot(await this.root(cwd)); }

  /** `authorized` is re-checked immediately before the first write: the preflight
   * above is asynchronous, and the caller's grant can be withdrawn inside it. */
  async mutate(cwd: string, value: unknown, authorized: () => Promise<boolean> = async () => true): Promise<GitMutationResult> {
    const body = value as Partial<GitMutation> | null;
    if (!body || typeof body !== 'object' || typeof body.requestId !== 'string' ||
        !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId) ||
        !['stage', 'unstage', 'commit'].includes(body.action ?? '') ||
        typeof body.expectedTree !== 'string' || !OID.test(body.expectedTree) ||
        typeof body.expectedRef !== 'string' || !body.expectedRef.startsWith('refs/heads/') ||
        body.expectedRef.length > 512 || body.expectedRef.includes('\0') ||
        !(body.expectedHead === null || (typeof body.expectedHead === 'string' && OID.test(body.expectedHead)))) {
      throw new SessionGitError(400, 'invalid-git-request');
    }
    const request = body as GitMutation;
    if (request.action === 'commit') {
      if (typeof request.message !== 'string' || !request.message.trim() || request.message.includes('\0') || Buffer.byteLength(request.message) > 10000) {
        throw new SessionGitError(400, 'invalid-commit-message');
      }
    } else if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > 100 ||
      request.paths.some(p => typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || path.isAbsolute(p) || p.split(/[\\/]/).some(c => c === '..' || c === '.git'))) {
      throw new SessionGitError(400, 'invalid-git-paths');
    }
    const root = await this.root(cwd);
    const key = `${root}\0${request.requestId}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new SessionGitError(409, 'request-id-reused');
      return previous.result;
    }
    if (this.busy.has(root) || this.busy.size >= 4) throw new SessionGitError(429, 'git-busy');
    this.busy.add(root);
    try {
      const before = await this.snapshot(root);
      // The reviewed BRANCH is pinned too: another branch can sit at the same
      // HEAD with the same index tree, and a stale phone write must not land on
      // whichever ref HEAD happens to point at now.
      if (before.head !== request.expectedHead || before.tree !== request.expectedTree ||
          before.ref !== request.expectedRef) throw new SessionGitError(409, 'git-state-changed');
      if (!await authorized()) throw new SessionGitError(401, 'authorization-expired');
      const result: GitMutationResult = { applied: true };
      if (request.action === 'commit') {
        if (!before.files.some(f => f.status[0] !== ' ' && f.status !== '??')) throw new SessionGitError(409, 'nothing-staged');
        const commit = await this.command(root, 'commit-tree', before.tree, ...(before.head ? ['-p', before.head] : []), '-m', request.message!);
        if (!OID.test(commit)) throw new SessionGitError(409, 'git-operation-failed');
        // CAS updates the ref the phone reviewed, never a newly switched HEAD.
        // The current index is left intact, preserving concurrent staging.
        await this.command(root, 'update-ref', '-m', 'wmux phone commit', request.expectedRef, commit, before.head ?? '0'.repeat(commit.length));
        result.commit = commit;
      } else {
        const paths = request.paths!;
        // Only paths in the reviewed status are valid. Include a rename's old
        // path explicitly so unstage returns both sides of the rename.
        const known = new Set(before.files.flatMap(f => [f.path, ...(f.from ? [f.from] : [])]));
        if (paths.some(p => !known.has(p))) throw new SessionGitError(409, 'git-state-changed');
        // `commit` compare-and-swaps through update-ref; `add`/`reset`/`rm` have
        // no such primitive, so the check is made here. The preflight above and
        // the authorization call are both asynchronous, and the `busy` lock only
        // excludes this daemon's own concurrent phone writes — a desktop terminal
        // or another tool can stage, switch branch or commit inside that window,
        // and the phone's write would then land on a state nobody reviewed.
        const now = await this.position(root);
        if (now.head !== request.expectedHead || now.tree !== request.expectedTree ||
            now.ref !== request.expectedRef) throw new SessionGitError(409, 'git-state-changed');
        if (request.action === 'stage') await this.command(root, '--literal-pathspecs', 'add', '--', ...paths);
        else if (before.head) await this.command(root, '--literal-pathspecs', 'reset', before.head, '--', ...paths);
        else await this.command(root, '--literal-pathspecs', 'rm', '--cached', '-f', '--', ...paths);
      }
      this.receipts.set(key, { fingerprint, result });
      if (this.receipts.size > 1024) this.receipts.delete(this.receipts.keys().next().value!);
      return result;
    } finally { this.busy.delete(root); }
  }
}
