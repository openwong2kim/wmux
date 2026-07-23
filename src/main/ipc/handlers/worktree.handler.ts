// Deck Git tab — worktree GUI main handler (list / add / remove).
//
// Renderer-only IPC surface (not exposed on pipe RpcRouter — same trust basis as
// channelLocal/fanout). git is disk source of truth, no cache/persistent state:
// daemon/app restart has no effect; every call runs fresh `git worktree ...`.
//
// Safety contract:
//  - add: branch name via validateGitRef (blocks flag injection/traversal/control chars);
//    path derived by handler at conventional location (<repo-parent>/<repo-name>-worktrees/<branch>)
//    with no explicit arg — renderer cannot specify arbitrary disk paths.
//  - remove: plain `git worktree remove` — git rejects dirty worktrees and surfaces
//    stderr to user. --force not provided in v1 (careful principle).
//  - All failures demoted to { ok:false, error } (fail-soft display surface).
import { ipcMain } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { git } from '../../git/git';
import {
  parseWorktreePorcelain,
  validateGitRef,
  branchToDirName,
  type WorktreeEntry,
} from '../../../shared/worktreeParse';
import {
  resolveBaseBranch,
  checkTargetPreconditions,
  createIntegrationWorktree,
  removeIntegrationWorktree,
  runMergeNoCommit,
  runVerify,
  landMerge,
  abortIntegrationMerge,
  readMergeState,
  detectConflicts,
  countStaged,
  linkNodeModules,
  isIntegrationPath,
  type MergePhase,
  type MergeSessionStatus,
  type VerifyResult,
} from '../../git/mergeSession';

/** worktree list row — MERGING derived fields for restart recovery (computed from disk). */
export interface WorktreeRow extends WorktreeEntry {
  /** MERGE_HEAD present (merge in progress). */
  merging?: boolean;
  /** Our owned isolated integration worktree (path-prefix recognition). */
  integration?: boolean;
  /** Unresolved conflict file count (meaningful only when merging). */
  conflicts?: number;
}

export type WorktreeListResult =
  | {
      ok: true;
      /** Call-context worktree toplevel (current worktree — GUI "current" dot basis). */
      repoPath: string;
      /** Main worktree path — porcelain first block (git contract: main always first). */
      mainPath: string;
      worktrees: WorktreeRow[];
    }
  | { ok: false; error: string };

export type MergeStartResult = { ok: true; status: MergeSessionStatus } | { ok: false; error: string };
export type MergeStatusResult = { ok: true; status: MergeSessionStatus | null } | { ok: false; error: string };
export type MergeActionResult = { ok: true } | { ok: false; error: string };

export type WorktreeMutateResult =
  | { ok: true; worktreePath: string }
  | { ok: false; error: string };

// Per-repo mutex — same shape as diff.handler.withRepoLock (additive principle:
// that instance is diff-adopt serialization only, so queues are not shared).
const repoChains = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoChains.get(repoKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  repoChains.set(
    repoKey,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// cwd (subdir allowed) → own worktree toplevel. null if not git.
async function resolveToplevel(cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], cwd);
  const top = r.code === 0 ? r.stdout.trim() : '';
  return top || null;
}

// Path normalization — reflect filesystem case policy (Codex P2). Windows/macOS are
// case-insensitive → lowercase; POSIX (case-sensitive) keeps original so
// `/repo/Foo` and `/repo/foo` are correctly distinct worktrees.
function normPath(p: string): string {
  const trimmed = resolve(p).replace(/[/\\]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
}

// Main worktree = first block of `git worktree list --porcelain` (git contract).
// Gets main repo even when cwd is a linked worktree.
async function resolveMainWorktree(top: string): Promise<string> {
  const r = await git(['worktree', 'list', '--porcelain'], top);
  if (r.code !== 0) return top;
  return parseWorktreePorcelain(r.stdout)[0]?.path ?? top;
}

async function listWorktrees(repoPath: string): Promise<WorktreeListResult> {
  const top = await resolveToplevel(repoPath);
  if (!top) return { ok: false, error: 'not a git repository' };
  const r = await git(['worktree', 'list', '--porcelain'], top);
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
  const parsed = parseWorktreePorcelain(r.stdout);
  // Restart recovery: derive each worktree's MERGING state from disk (parallel).
  // Even if in-memory session is lost on app restart, git disk state is source of
  // truth so UI can recognize integration worktrees and offer Land/Discard.
  const worktrees: WorktreeRow[] = await Promise.all(
    parsed.map(async (e) => {
      const integration = isIntegrationPath(e.path);
      const ms = existsSync(e.path) ? await readMergeState(e.path) : { merging: false, conflicts: 0 };
      return { ...e, merging: ms.merging, integration, conflicts: ms.conflicts };
    }),
  );
  // Dogfood silver bug: top is the "calling worktree" toplevel, not main repo
  // (opening from linked worktree returns itself). Main worktree is porcelain first
  // block by contract, so return mainPath separately.
  return { ok: true, repoPath: top, mainPath: worktrees[0]?.path ?? top, worktrees };
}

async function addWorktree(repoPath: string, branch: string): Promise<WorktreeMutateResult> {
  let safeBranch: string;
  try {
    safeBranch = validateGitRef(branch);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const top = await resolveToplevel(repoPath);
  if (!top) return { ok: false, error: 'not a git repository' };
  // Path derivation basis = main worktree (Codex P2). When opened from linked worktree,
  // top was that worktree itself, producing `<linked>-worktrees` bug.
  const mainWt = await resolveMainWorktree(top);
  return withRepoLock(normPath(mainWt), async () => {
    // Conventional location: <main-parent>/<main-name>-worktrees/<branch-dir>. Same shape as
    // owner's real usage (D:\wmux-worktrees\*) — sibling dir, not inside repo, so
    // worktrees don't become untracked noise in their own repo.
    const parent = join(dirname(mainWt), `${basename(mainWt)}-worktrees`);
    const wtPath = resolve(parent, branchToDirName(safeBranch));
    if (existsSync(wtPath)) {
      return { ok: false, error: `path already exists: ${wtPath}` };
    }
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    // Branch resolution 3-way (Codex P2 — preserve remote-only branches):
    //  ① Local branch exists → checkout.
    //  ② Else try --guess-remote → if origin/<branch> exists, create local branch
    //     tracking it (prevents forced -b ignoring remote and creating new branch).
    //     Fail if no remote match.
    //  ③ If ② fails, create new branch from HEAD with -b.
    const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${safeBranch}`], mainWt);
    if (local.code === 0) {
      const r = await git(['worktree', 'add', wtPath, safeBranch], mainWt);
      if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
      return { ok: true, worktreePath: wtPath };
    }
    const guess = await git(['worktree', 'add', '--guess-remote', wtPath, safeBranch], mainWt);
    if (guess.code === 0) return { ok: true, worktreePath: wtPath };
    const created = await git(['worktree', 'add', '-b', safeBranch, wtPath], mainWt);
    if (created.code !== 0) return { ok: false, error: created.stderr.slice(0, 300) };
    return { ok: true, worktreePath: wtPath };
  });
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<WorktreeMutateResult> {
  const top = await resolveToplevel(repoPath);
  if (!top) return { ok: false, error: 'not a git repository' };
  // Renderer path comes from prior list result, but re-validate against actual
  // worktree list (block arbitrary path args).
  const listed = await git(['worktree', 'list', '--porcelain'], top);
  if (listed.code !== 0) return { ok: false, error: listed.stderr.slice(0, 300) };
  const entries = parseWorktreePorcelain(listed.stdout);
  const target = entries.find((e) => normPath(e.path) === normPath(worktreePath));
  if (!target) return { ok: false, error: 'not a listed worktree of this repository' };
  // Reject removing main worktree (porcelain first block).
  const mainPath = entries[0]?.path ?? top;
  if (normPath(target.path) === normPath(mainPath)) {
    return { ok: false, error: 'cannot remove the main worktree' };
  }
  // Reject removing active (call-context) worktree (Codex P2): git removes clean
  // worktrees even from their own cwd — block user deleting current worktree and
  // losing pane cwd. top = active pane toplevel.
  if (normPath(target.path) === normPath(top)) {
    return { ok: false, error: 'cannot remove the worktree you are currently in' };
  }
  // Unify lock key to base (main worktree) — prior bug: add used normPath(mainWt), remove
  // used normPath(top), so same-repo add/remove didn't serialize (key mismatch).
  // merge session must share same base key for repo-wide mutex.
  const mainWt = entries[0]?.path ?? top;
  return withRepoLock(normPath(mainWt), async () => {
    // No --force: git rejects dirty/locked worktrees and surfaces reason as-is.
    const r = await git(['worktree', 'remove', target.path], top);
    if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
    return { ok: true, worktreePath: target.path };
  });
}

// ── Merge session ────────────────────────────────────────────────────────────────
//
// Git-native merge in isolated integration worktree → verify gate → Land/Discard.
// Max one session per base key (main worktree); concurrent start rejected. Source of
// truth is git disk state (MERGE_HEAD); status recovers session from disk after restart.

/** Session internal state (public status + OIDs for revalidation, verify cancel handle). */
interface MergeSessionState {
  sessionId: string;
  repoKey: string;
  mainWt: string;
  base: string;
  baseCheckoutPath: string;
  baseOid: string;
  sourceBranch: string | null;
  sourceOid: string;
  integrationPath: string;
  phase: MergePhase;
  conflicts: string[];
  changedFiles: number;
  verify?: VerifyResult;
  abort?: AbortController;
  /** In-flight verify run (kickVerify) — awaited before we delete the integration worktree. */
  verifyPromise?: Promise<void>;
}

// repoKey(normPath(mainWt)) → session. Shares base key with add/remove.
const mergeSessions = new Map<string, MergeSessionState>();

function toStatus(s: MergeSessionState): MergeSessionStatus {
  return {
    sessionId: s.sessionId,
    baseBranch: s.base,
    baseCheckoutPath: s.baseCheckoutPath,
    sourceBranch: s.sourceBranch,
    sourceOid: s.sourceOid,
    integrationPath: s.integrationPath,
    phase: s.phase,
    conflicts: s.conflicts,
    changedFiles: s.changedFiles,
    verify: s.verify,
  };
}

// Run verify async outside lock after clean merge — update session phase. Discard
// replacing/deleting session in between → discard result (stale prevention).
function kickVerify(s: MergeSessionState): void {
  // The integration worktree is a fresh checkout with no node_modules (gitignored),
  // so link deps from the base checkout first or `npm test`/`npm run lint` can't
  // resolve anything and verify fails in every real repo.
  linkNodeModules(s.integrationPath, [s.baseCheckoutPath, s.mainWt]);
  s.abort = new AbortController();
  s.phase = 'verifying';
  // Keep the promise on the session so Discard/Land can await the child process
  // unwinding before deleting the integration worktree it may still be touching.
  s.verifyPromise = runVerify(s.integrationPath, { signal: s.abort.signal })
    .then((res) => {
      if (mergeSessions.get(s.repoKey) !== s) return;
      s.verify = res;
      s.phase = res.ok ? 'verified' : 'failed';
    })
    .catch(() => {
      if (mergeSessions.get(s.repoKey) !== s) return;
      s.phase = 'failed';
      s.verify = { ok: false, output: 'verify execution error' };
    });
}

type MergeCtx = { top: string; mainWt: string; repoKey: string; entries: WorktreeEntry[] };

async function resolveMergeContext(repoPath: string): Promise<MergeCtx | { error: string }> {
  const top = await resolveToplevel(repoPath);
  if (!top) return { error: 'not a git repository' };
  const listed = await git(['worktree', 'list', '--porcelain'], top);
  if (listed.code !== 0) return { error: listed.stderr.slice(0, 300) };
  const entries = parseWorktreePorcelain(listed.stdout);
  const mainWt = entries[0]?.path ?? top;
  return { top, mainWt, repoKey: normPath(mainWt), entries };
}

async function mergeStart(repoPath: string, sourcePath: string): Promise<MergeStartResult> {
  const ctx = await resolveMergeContext(repoPath);
  if ('error' in ctx) return { ok: false, error: ctx.error };
  const { mainWt, repoKey, entries } = ctx;
  return withRepoLock(repoKey, async () => {
    if (mergeSessions.has(repoKey)) return { ok: false, error: 'A merge session is already in progress' };
    // Disk re-check: reject if prior session's integration worktree still MERGING.
    for (const e of entries) {
      if (isIntegrationPath(e.path) && existsSync(e.path)) {
        const ms = await readMergeState(e.path);
        if (ms.merging) return { ok: false, error: 'Previous merge was not cleaned up — Land or Discard first' };
      }
    }
    // Resolve base explicitly (not worktree[0] HEAD) → find worktree with that branch checked out.
    const base = await resolveBaseBranch(mainWt);
    if (!base) return { ok: false, error: 'Cannot resolve base branch (gh/origin/main and master both failed)' };
    const baseEntry = entries.find((e) => e.branch === base);
    if (!baseEntry) return { ok: false, error: `Base branch (${base}) is not checked out in any worktree — check it out in a clean state` };
    const baseCheckoutPath = baseEntry.path;
    const pre = await checkTargetPreconditions(baseCheckoutPath, base);
    if (!pre.ok) return { ok: false, error: pre.error };

    // source worktree → capture OID (not moving branch name) + branch name (if any).
    const sourceTop = await resolveToplevel(sourcePath);
    if (!sourceTop) return { ok: false, error: 'Source is not a git worktree' };
    // Re-validate against this repo's worktree list (like removeWorktree) — the
    // renderer must not be able to inject an arbitrary git repo path as source.
    const srcEntry = entries.find((e) => normPath(e.path) === normPath(sourceTop));
    if (!srcEntry) return { ok: false, error: 'Source is not a worktree of this repo' };
    const sourceBranch = srcEntry.branch ?? null;
    // Refuse a dirty source: only the committed HEAD is merged, so uncommitted or
    // untracked work would be silently dropped (especially risky in AI worktrees).
    const srcStatus = await git(['status', '--porcelain'], sourceTop);
    if (srcStatus.code !== 0) return { ok: false, error: srcStatus.stderr.slice(0, 300) };
    if (srcStatus.stdout.trim() !== '') {
      return { ok: false, error: 'Source worktree has uncommitted changes — commit first' };
    }
    const srcHead = await git(['rev-parse', 'HEAD'], sourceTop);
    if (srcHead.code !== 0) return { ok: false, error: 'Failed to read source HEAD' };
    const sourceOid = srcHead.stdout.trim();
    const baseHead = await git(['rev-parse', 'HEAD'], baseCheckoutPath);
    if (baseHead.code !== 0) return { ok: false, error: 'Failed to read base HEAD' };
    const baseOid = baseHead.stdout.trim();

    // Create isolated integration worktree → merge captured source OID with --no-commit --no-ff.
    const created = await createIntegrationWorktree(mainWt, baseOid, sourceBranch ?? sourceOid.slice(0, 7));
    if (!created.ok) return { ok: false, error: created.error };
    const merged = await runMergeNoCommit(created.path, sourceOid);
    if (!merged.ok) {
      await removeIntegrationWorktree(mainWt, created.path);
      return { ok: false, error: merged.error };
    }
    const { outcome } = merged;
    // No-op merge (source already in base): git leaves no MERGE_HEAD and 0 changed
    // files. Creating a session/worktree here would orphan the integration worktree
    // (recoverSession skips a non-merging one), so reject and clean it up instead.
    if (outcome.phase === 'clean' && outcome.changedFiles === 0) {
      await removeIntegrationWorktree(mainWt, created.path);
      return { ok: false, error: 'Already up to date — nothing to merge' };
    }
    const session: MergeSessionState = {
      sessionId: randomUUID(),
      repoKey,
      mainWt,
      base,
      baseCheckoutPath,
      baseOid,
      sourceBranch,
      sourceOid,
      integrationPath: created.path,
      // Conflicts → stop at conflicted (B-MVP: manual entry). clean (with changes) → verify.
      // (0-change clean = no-op already rejected above.)
      phase: outcome.phase === 'conflicted' ? 'conflicted' : 'verifying',
      conflicts: outcome.conflicts,
      changedFiles: outcome.changedFiles,
    };
    mergeSessions.set(repoKey, session);
    if (session.phase === 'verifying') kickVerify(session);
    return { ok: true, status: toStatus(session) };
  });
}

// After app restart in-memory session loss, reconstruct session from integration
// worktree MERGING state (source of truth = disk). base/OID fully derivable from
// integration HEAD/MERGE_HEAD and base re-resolution. Re-run verify if clean.
async function recoverSession(ctx: MergeCtx): Promise<MergeSessionState | null> {
  const { mainWt, repoKey, entries } = ctx;
  const intEntry = entries.find((e) => isIntegrationPath(e.path) && existsSync(e.path));
  if (!intEntry) return null;
  const ms = await readMergeState(intEntry.path);
  if (!ms.merging) return null;
  const headR = await git(['rev-parse', 'HEAD'], intEntry.path); // pre-commit, so base OID.
  const mhR = await git(['rev-parse', 'MERGE_HEAD'], intEntry.path); // source OID.
  if (headR.code !== 0 || mhR.code !== 0) return null;
  // Don't degrade into a corrupt session: without a resolved base + its checkout,
  // a later Land would call landMerge with an empty baseCheckoutPath and fail
  // confusingly. Same clear failure contract as mergeStart — bail instead.
  const base = await resolveBaseBranch(mainWt);
  if (!base) return null;
  const baseEntry = entries.find((e) => e.branch === base);
  if (!baseEntry) return null;
  const conflicts = ms.conflicts > 0 ? await detectConflicts(intEntry.path) : [];
  const session: MergeSessionState = {
    sessionId: randomUUID(),
    repoKey,
    mainWt,
    base,
    baseCheckoutPath: baseEntry.path,
    baseOid: headR.stdout.trim(),
    sourceBranch: null,
    sourceOid: mhR.stdout.trim(),
    integrationPath: intEntry.path,
    phase: ms.conflicts > 0 ? 'conflicted' : 'verifying',
    conflicts,
    changedFiles: 0,
  };
  mergeSessions.set(repoKey, session);
  if (session.phase === 'verifying') kickVerify(session);
  return session;
}

async function mergeStatus(repoPath: string): Promise<MergeStatusResult> {
  const ctx = await resolveMergeContext(repoPath);
  if ('error' in ctx) return { ok: false, error: ctx.error };
  const existing = mergeSessions.get(ctx.repoKey);
  if (existing) {
    // A conflicted session must re-check disk: the user resolves & stages the
    // conflict in the integration worktree, so we can't stay pinned to the cached
    // 'conflicted' snapshot or verify never starts and Land never unlocks.
    if (existing.phase === 'conflicted') {
      const ms = await readMergeState(existing.integrationPath);
      if (ms.merging && ms.conflicts === 0) {
        // Resolved & staged on disk → advance to the verify gate. Guarded against a
        // double kick: phase leaves 'conflicted', so a repeat status call won't re-enter.
        existing.conflicts = [];
        existing.changedFiles = await countStaged(existing.integrationPath);
        kickVerify(existing);
      } else {
        // Still conflicting (or the merge is no longer in progress) — refresh the list.
        existing.conflicts = await detectConflicts(existing.integrationPath);
      }
    }
    return { ok: true, status: toStatus(existing) };
  }
  const recovered = await recoverSession(ctx);
  return { ok: true, status: recovered ? toStatus(recovered) : null };
}

async function mergeLand(repoPath: string): Promise<MergeActionResult> {
  const ctx = await resolveMergeContext(repoPath);
  if ('error' in ctx) return { ok: false, error: ctx.error };
  const { repoKey } = ctx;
  return withRepoLock(repoKey, async () => {
    const s = mergeSessions.get(repoKey);
    if (!s) return { ok: false, error: 'No merge session in progress' };
    if (s.phase !== 'verified') return { ok: false, error: 'Land is only allowed after verify passes (verified phase)' };
    const res = await landMerge({
      integrationPath: s.integrationPath,
      baseCheckoutPath: s.baseCheckoutPath,
      baseOid: s.baseOid,
      base: s.base,
      sourceOid: s.sourceOid,
    });
    if (!res.ok) return { ok: false, error: res.error };
    // Land only runs from 'verified', so verify has already settled — but join its
    // promise defensively before removing the worktree it ran in.
    await s.verifyPromise?.catch(() => undefined);
    await removeIntegrationWorktree(s.mainWt, s.integrationPath);
    mergeSessions.delete(repoKey);
    return { ok: true };
  });
}

async function mergeDiscard(repoPath: string): Promise<MergeActionResult> {
  const ctx = await resolveMergeContext(repoPath);
  if ('error' in ctx) return { ok: false, error: ctx.error };
  const { mainWt, repoKey, entries } = ctx;
  // Cancel an in-flight verify first (abort reflects immediately), then WAIT for its
  // child process to unwind before we delete the integration worktree it may still
  // be touching — abort only SIGTERMs npm (not the child tree), and kickVerify is
  // fire-and-forget, so we join its promise here to close the race.
  const pre = mergeSessions.get(repoKey);
  pre?.abort?.abort();
  await pre?.verifyPromise?.catch(() => undefined);
  return withRepoLock(repoKey, async () => {
    const s = mergeSessions.get(repoKey);
    // Even without session, clean up integration worktree on disk (post-restart Discard etc.).
    const integrationPath =
      s?.integrationPath ?? entries.find((e) => isIntegrationPath(e.path) && existsSync(e.path))?.path;
    if (!integrationPath) {
      mergeSessions.delete(repoKey);
      return { ok: true };
    }
    await abortIntegrationMerge(integrationPath);
    const rm = await removeIntegrationWorktree(mainWt, integrationPath);
    mergeSessions.delete(repoKey);
    if (!rm.ok) return { ok: false, error: rm.error };
    return { ok: true };
  });
}

export function registerWorktreeHandlers(): () => void {
  ipcMain.removeHandler(IPC.WORKTREE_LIST);
  ipcMain.handle(
    IPC.WORKTREE_LIST,
    wrapHandler(IPC.WORKTREE_LIST, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown) => {
      if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
      return listWorktrees(repoPath);
    }),
  );

  ipcMain.removeHandler(IPC.WORKTREE_ADD);
  ipcMain.handle(
    IPC.WORKTREE_ADD,
    wrapHandler(
      IPC.WORKTREE_ADD,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, branch: unknown) => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
        if (typeof branch !== 'string' || !branch) return { ok: false, error: 'branch required' };
        return addWorktree(repoPath, branch);
      },
    ),
  );

  ipcMain.removeHandler(IPC.WORKTREE_REMOVE);
  ipcMain.handle(
    IPC.WORKTREE_REMOVE,
    wrapHandler(
      IPC.WORKTREE_REMOVE,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, worktreePath: unknown) => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
        if (typeof worktreePath !== 'string' || !worktreePath) return { ok: false, error: 'worktreePath required' };
        return removeWorktree(repoPath, worktreePath);
      },
    ),
  );

  ipcMain.removeHandler(IPC.WORKTREE_MERGE_START);
  ipcMain.handle(
    IPC.WORKTREE_MERGE_START,
    wrapHandler(
      IPC.WORKTREE_MERGE_START,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, sourcePath: unknown): Promise<MergeStartResult> => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
        if (typeof sourcePath !== 'string' || !sourcePath) return { ok: false, error: 'sourcePath required' };
        return mergeStart(repoPath, sourcePath);
      },
    ),
  );

  ipcMain.removeHandler(IPC.WORKTREE_MERGE_STATUS);
  ipcMain.handle(
    IPC.WORKTREE_MERGE_STATUS,
    wrapHandler(
      IPC.WORKTREE_MERGE_STATUS,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown): Promise<MergeStatusResult> => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
        return mergeStatus(repoPath);
      },
    ),
  );

  ipcMain.removeHandler(IPC.WORKTREE_MERGE_LAND);
  ipcMain.handle(
    IPC.WORKTREE_MERGE_LAND,
    wrapHandler(
      IPC.WORKTREE_MERGE_LAND,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown): Promise<MergeActionResult> => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
        return mergeLand(repoPath);
      },
    ),
  );

  ipcMain.removeHandler(IPC.WORKTREE_MERGE_DISCARD);
  ipcMain.handle(
    IPC.WORKTREE_MERGE_DISCARD,
    wrapHandler(
      IPC.WORKTREE_MERGE_DISCARD,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown): Promise<MergeActionResult> => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
        return mergeDiscard(repoPath);
      },
    ),
  );

  return () => {
    ipcMain.removeHandler(IPC.WORKTREE_LIST);
    ipcMain.removeHandler(IPC.WORKTREE_ADD);
    ipcMain.removeHandler(IPC.WORKTREE_REMOVE);
    ipcMain.removeHandler(IPC.WORKTREE_MERGE_START);
    ipcMain.removeHandler(IPC.WORKTREE_MERGE_STATUS);
    ipcMain.removeHandler(IPC.WORKTREE_MERGE_LAND);
    ipcMain.removeHandler(IPC.WORKTREE_MERGE_DISCARD);
  };
}
