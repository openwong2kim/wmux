// Stateful merge-session helper built on an isolated integration worktree (B-MVP).
//
// Primitive: never touch the user's base checkout (local main, etc.) directly.
// Run a git-native merge in an **isolated integration worktree** branched off the
// base ref → verify gate (exit code) → fast-forward base via Land only on success.
//
// Safety contract (locked by the 3-model review):
//  - Conflict detection is based on whether
//    `git diff --name-only --diff-filter=U -z` is empty, not on the merge exit
//    code or stderr (which is locale-dependent).
//  - The merge target is a captured source OID, not a moving branch name.
//  - Never trust "done" text — verify is judged solely by the process exit code.
//  - The session's source of truth is derived from git's on-disk state
//    (MERGE_HEAD), so it recovers even after an app restart.
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from './git';
import { getGitExecEnv } from '../../shared/execEnv';
import { branchToDirName } from '../../shared/worktreeParse';

const execFileAsync = promisify(execFile);

/** Leaf prefix of the integration worktree directory — recognition marker for restart recovery. */
export const INTEGRATION_PREFIX = '.wmux-merge-';

export type MergePhase = 'merging' | 'conflicted' | 'clean' | 'verifying' | 'verified' | 'failed';

export interface VerifyResult {
  readonly ok: boolean;
  /** The step that failed (if any). */
  readonly failedStep?: 'test' | 'lint';
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  /** Tail of the last output (for diagnostics, capped). */
  readonly output: string;
}

/** Public session snapshot sent down to the renderer (internal OIDs etc. are kept separately by the handler). */
export interface MergeSessionStatus {
  readonly sessionId: string;
  readonly baseBranch: string;
  readonly baseCheckoutPath: string;
  readonly sourceBranch: string | null;
  readonly sourceOid: string;
  readonly integrationPath: string;
  readonly phase: MergePhase;
  /** Unresolved conflict files (relative paths). */
  readonly conflicts: string[];
  /** Number of staged changed files (for the summary). */
  readonly changedFiles: number;
  readonly verify?: VerifyResult;
}

type OkErr = { ok: true } | { ok: false; error: string };

// ── Pure / low-level helpers (unit-tested) ─────────────────────────────────────

/** Parser for a NUL(-z)-separated list. Drops empty strings and trailing NULs. */
export function parseNulList(raw: string): string[] {
  return raw.split('\0').filter((s) => s.length > 0);
}

/** Whether this is an integration worktree (recognized by the path's leaf prefix). */
export function isIntegrationPath(p: string): boolean {
  return basename(p.replace(/[/\\]+$/, '')).startsWith(INTEGRATION_PREFIX);
}

/**
 * List of unmerged paths. Conflict detection is based solely on whether this
 * result is empty (not the exit code or stderr — a Codex correctness finding).
 */
export async function detectConflicts(cwd: string): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--diff-filter=U', '-z'], cwd);
  return parseNulList(r.stdout);
}

/** Number of staged changed files (index vs HEAD after the merge). */
export async function countStaged(cwd: string): Promise<number> {
  const r = await git(['diff', '--cached', '--name-only', '-z'], cwd);
  return parseNulList(r.stdout).length;
}

/**
 * Link node_modules from a base checkout into a fresh integration worktree so the
 * verify gate (`npm test` / `npm run lint`) can resolve dependencies.
 *
 * The integration worktree is a bare `git worktree add`, and node_modules is
 * gitignored, so it starts with no dependencies — in a real repo (unlike the
 * trivial dogfood scripts) verify would then always fail with "module not found".
 * We symlink (not copy) the first candidate base dir that has node_modules; on
 * Windows a junction is used since directory symlinks need elevation.
 *
 * Best-effort: if the link can't be created the verify still runs (that repo may
 * not need deps). Only the top-level node_modules is linked — nested workspaces
 * (monorepos) are out of B-MVP scope.
 */
export function linkNodeModules(integrationPath: string, baseDirs: readonly string[]): void {
  try {
    const dest = join(integrationPath, 'node_modules');
    if (existsSync(dest)) return; // already present (link or real dir) — skip
    for (const baseDir of baseDirs) {
      if (!baseDir) continue;
      const src = join(baseDir, 'node_modules');
      if (existsSync(src)) {
        symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
        return;
      }
    }
  } catch {
    // Best-effort: leave verify to run without the link (deps may be unneeded).
  }
}

/**
 * Resolve the base branch with plain git (no gh) — `symbolic-ref origin/HEAD`
 * → main/master fallback. Returns null if it can't be resolved. (The fallback
 * path of resolveBaseBranch, and the source of truth where gh isn't installed.)
 */
export async function resolveBaseFromGit(cwd: string): Promise<string | null> {
  const sym = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (sym.code === 0) {
    // --short abbreviates refs/remotes/origin/main → 'origin/main'. Strip the remote prefix.
    const name = sym.stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  }
  for (const cand of ['main', 'master']) {
    const v = await git(['rev-parse', '-q', '--verify', `refs/heads/${cand}`], cwd);
    if (v.code === 0) return cand;
  }
  return null;
}

/** Env that blocks gh interactivity (login prompt, pager). Includes the mac GUI PATH fix. */
function ghEnv(): NodeJS.ProcessEnv {
  return { ...getGitExecEnv(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' };
}

/** Default branch via `gh repo view` (same pattern as TaskPrService). null on failure/absence. */
async function ghDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      { cwd, timeout: 20_000, windowsHide: true, env: ghEnv() },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Whether origin is a GitHub remote — gates the gh call so a local or non-GitHub
 *  repo never pays for a (sometimes slow) `gh` subprocess. */
async function hasGithubOrigin(cwd: string): Promise<boolean> {
  const r = await git(['remote', 'get-url', 'origin'], cwd);
  if (r.code !== 0) return false;
  return /(?:@|\/\/)(?:[^/]*\.)?github\.com[:/]/i.test(r.stdout.trim());
}

/** Explicitly resolve the base branch: gh default (GitHub origin only) →
 *  git symbolic-ref → main/master. gh is skipped for local/non-GitHub repos so
 *  `start` never blocks on a needless gh call (the cause of Windows CI timeouts). */
export async function resolveBaseBranch(cwd: string): Promise<string | null> {
  if (await hasGithubOrigin(cwd)) {
    const viaGh = await ghDefaultBranch(cwd);
    if (viaGh) return viaGh;
  }
  return resolveBaseFromGit(cwd);
}

/**
 * Target (base checkout) preconditions: no MERGE_HEAD · not detached & HEAD==base ·
 * fully clean (status --porcelain empty). The base checkout is fast-forwarded
 * here, so if any of these break, Land would create an inconsistency.
 */
export async function checkTargetPreconditions(baseCheckoutPath: string, base: string): Promise<OkErr> {
  const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], baseCheckoutPath);
  if (mh.code === 0) return { ok: false, error: `Target worktree has a merge in progress (MERGE_HEAD)` };
  const sym = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], baseCheckoutPath);
  if (sym.code !== 0) return { ok: false, error: `Target worktree is in detached HEAD state` };
  const cur = sym.stdout.trim();
  if (cur !== base) return { ok: false, error: `Target worktree is on ${cur}, not base(${base})` };
  const st = await git(['status', '--porcelain'], baseCheckoutPath);
  if (st.code !== 0) return { ok: false, error: st.stderr.slice(0, 300) };
  if (st.stdout.trim() !== '') return { ok: false, error: `Target worktree has uncommitted changes` };
  return { ok: true };
}

/**
 * Derive the worktree's MERGING state from disk (for restart recovery and list
 * surfacing). MERGE_HEAD present → merging, along with the unresolved conflict count.
 */
export async function readMergeState(worktreePath: string): Promise<{ merging: boolean; conflicts: number }> {
  const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktreePath);
  if (mh.code !== 0) return { merging: false, conflicts: 0 };
  const conflicts = await detectConflicts(worktreePath);
  return { merging: true, conflicts: conflicts.length };
}

// ── verify runner─────────────────────────────────────────────────────────────

/** npm.cmd on Windows. On the mac GUI, node/npm (Homebrew) are resolved via getGitExecEnv PATH. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export interface VerifyStep {
  readonly step: 'test' | 'lint';
  readonly cmd: string;
  readonly args: string[];
}

/** B-MVP hardcoded gate: `npm test` && `npm run lint` (plan §4). */
export const DEFAULT_VERIFY_STEPS: readonly VerifyStep[] = [
  { step: 'test', cmd: NPM, args: ['test'] },
  { step: 'lint', cmd: NPM, args: ['run', 'lint'] },
];

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CAP = 4000;

function tail(s: string, cap = OUTPUT_TAIL_CAP): string {
  return s.length <= cap ? s : s.slice(s.length - cap);
}

/**
 * Run the verify gate — each step runs sequentially, **failing immediately if any
 * step exits non-zero**. Judged solely by exit code. steps can be injected for tests
 * (defaults to npm test/lint).
 */
export async function runVerify(
  cwd: string,
  opts?: { steps?: readonly VerifyStep[]; signal?: AbortSignal; timeoutMs?: number },
): Promise<VerifyResult> {
  const steps = opts?.steps ?? DEFAULT_VERIFY_STEPS;
  let combined = '';
  for (const s of steps) {
    const header = `$ ${s.cmd} ${s.args.join(' ')}\n`;
    try {
      const { stdout, stderr } = await execFileAsync(s.cmd, s.args, {
        cwd,
        timeout: opts?.timeoutMs ?? VERIFY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: getGitExecEnv(),
        signal: opts?.signal,
        // Windows: npm is `npm.cmd`, and Node refuses to spawn a `.cmd`/`.bat` via
        // execFile without a shell (CVE-2024-27980 mitigation → `spawn EINVAL`). Without
        // this the verify gate always failed on Windows, so no clean merge could ever
        // reach 'verified' and Land was unreachable. Scope the shell to batch files only
        // (the default npm step on Windows) so real executables — `npm` on macOS/Linux,
        // and node.exe in the injected unit-test steps — keep their exact argv semantics.
        shell: /\.(cmd|bat)$/i.test(s.cmd),
      });
      combined += header + stdout + stderr;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; killed?: boolean; signal?: string; name?: string; code?: string };
      combined += header + (err.stdout ?? '') + (err.stderr ?? '');
      const aborted = err.name === 'AbortError' || err.code === 'ABORT_ERR';
      const timedOut = !aborted && err.killed === true;
      return { ok: false, failedStep: s.step, timedOut, aborted, output: tail(combined) };
    }
  }
  return { ok: true, output: tail(combined) };
}

// ── Worktree / merge / Land / Discard orchestration───────────────────────────────

/**
 * Create the isolated integration worktree — detached at the base OID. The
 * conventional location mirrors addWorktree
 * (<main-parent>/<main-name>-worktrees/<prefix+source>).
 */
export async function createIntegrationWorktree(
  mainWt: string,
  baseOid: string,
  sourceLeaf: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const parent = join(dirname(mainWt), `${basename(mainWt)}-worktrees`);
  const leaf = INTEGRATION_PREFIX + (branchToDirName(sourceLeaf) || 'src');
  const path = resolve(parent, leaf);
  if (existsSync(path)) return { ok: false, error: `Integration path already exists: ${path}` };
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const r = await git(['worktree', 'add', '--detach', path, baseOid], mainWt);
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
  return { ok: true, path };
}

/** Remove the integration worktree — a throwaway surface we own, so --force is safe. */
export async function removeIntegrationWorktree(mainWt: string, integrationPath: string): Promise<OkErr> {
  const r = await git(['worktree', 'remove', '--force', integrationPath], mainWt);
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
  return { ok: true };
}

export interface MergeOutcome {
  readonly phase: 'clean' | 'conflicted';
  readonly conflicts: string[];
  readonly changedFiles: number;
}

/**
 * Run `git merge --no-commit --no-ff <source-OID>` (captured OID), then detect
 * conflicts. unmerged>0 → conflicted. unmerged==0 && non-zero exit → operational
 * failure (distinguished). Otherwise clean.
 */
export async function runMergeNoCommit(
  integrationPath: string,
  sourceOid: string,
): Promise<{ ok: true; outcome: MergeOutcome } | { ok: false; error: string }> {
  const m = await git(['merge', '--no-commit', '--no-ff', sourceOid], integrationPath);
  const conflicts = await detectConflicts(integrationPath);
  if (conflicts.length > 0) {
    return { ok: true, outcome: { phase: 'conflicted', conflicts, changedFiles: await countStaged(integrationPath) } };
  }
  if (m.code !== 0) {
    // unmerged 0 + non-zero exit = operational failure (not a conflict). "Already up to date" exits 0, so it never reaches here.
    return { ok: false, error: (m.stderr || m.stdout).slice(0, 300) };
  }
  return { ok: true, outcome: { phase: 'clean', conflicts: [], changedFiles: await countStaged(integrationPath) } };
}

export interface LandParams {
  readonly integrationPath: string;
  readonly baseCheckoutPath: string;
  readonly baseOid: string;
  readonly base: string;
  readonly sourceOid: string;
}

/**
 * Land — re-verify the base OID, commit the integration result, and fast-forward
 * base to that result. Rejected if base moved or unresolved conflicts remain.
 */
export async function landMerge(
  p: LandParams,
): Promise<{ ok: true; landedOid: string; alreadyUpToDate?: boolean } | { ok: false; error: string }> {
  // 1) Re-verify base — hasn't it moved or been dirtied since we started?
  const head = await git(['rev-parse', 'HEAD'], p.baseCheckoutPath);
  if (head.code !== 0) return { ok: false, error: 'Failed to read base worktree HEAD' };
  if (head.stdout.trim() !== p.baseOid) {
    return { ok: false, error: 'Base moved since merge started — Discard and try again' };
  }
  const pre = await checkTargetPreconditions(p.baseCheckoutPath, p.base);
  if (!pre.ok) return { ok: false, error: pre.error };

  // 2) Re-verify the integration state, then commit.
  const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], p.integrationPath);
  if (mh.code === 0) {
    if (mh.stdout.trim() !== p.sourceOid) return { ok: false, error: 'Integration MERGE_HEAD does not match expected source' };
    const conflicts = await detectConflicts(p.integrationPath);
    if (conflicts.length > 0) return { ok: false, error: 'Unresolved conflicts remain' };
    const c = await git(['commit', '--no-edit'], p.integrationPath);
    if (c.code !== 0) return { ok: false, error: c.stderr.slice(0, 300) };
  }
  const landed = await git(['rev-parse', 'HEAD'], p.integrationPath);
  const landedOid = landed.stdout.trim();
  if (landedOid === p.baseOid) {
    // Nothing to advance (already up to date).
    return { ok: true, landedOid, alreadyUpToDate: true };
  }

  // 3) Fast-forward base to the integration result (consistently updates index and working tree).
  const ff = await git(['merge', '--ff-only', landedOid], p.baseCheckoutPath);
  if (ff.code !== 0) return { ok: false, error: `Base fast-forward failed: ${ff.stderr.slice(0, 300)}` };
  return { ok: true, landedOid };
}

/** Discard — abort the integration's in-progress merge (only if present). Worktree removal is the caller's job. */
export async function abortIntegrationMerge(integrationPath: string): Promise<void> {
  const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], integrationPath);
  if (mh.code === 0) await git(['merge', '--abort'], integrationPath);
}
