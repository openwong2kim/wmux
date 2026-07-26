// J2 — diff:read / diff:applyHunks main handlers (spec §2·§3)
//
// diff:read: read working-tree diff from task worktree cwd, parse, numstat,
//   synthesize untracked, and return with target snapshot (§2).
// diff:applyHunks: snapshot drift gate → dirty rejection → per-hunk probe →
//   selected-hunk single-patch all-or-nothing apply (§3). Per-target-repo mutex.
//
// Session locations (issue #21 AC 1). `worktreePath` here is host-native by
// construction, so it needs no SessionLocation on the wire:
//   • `diff:resolveRepo` is the ONLY entry that takes a raw pane cwd, and it
//     touches disk exclusively through `git()` — i.e. `hostCommandTarget` →
//     `prepareLocationCommand`, the shared choke point, which refuses a host
//     location carrying a guest cwd (UNRESOLVED_GUEST_PATH). A guest pane
//     therefore yields `{ ok: false }` and never mints a path.
//   • Every `worktreePath` the renderer sends back is either that
//     `rev-parse --show-toplevel` result (workspace mode) or a fan-out task's
//     `worktreePath`, which TaskWorktreeManager builds with `path.resolve`/
//     `path.join` on the host. Both are Windows paths on Windows, so the
//     direct `lstat`/`readFile` on untracked files below is safe.
import { ipcMain } from 'electron';
import { readFile, lstat } from 'node:fs/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, normalize, dirname } from 'node:path';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { git } from '../../git/git';
import {
  parseUnifiedDiff,
  reassemblePatch,
  synthesizeNewFileDiff,
  DIFF_TOTAL_CAP_BYTES,
  DIFF_FILE_CAP_BYTES,
  type DiffFile,
  type DiffReadResult,
  type DiffReadError,
  type DiffNumstat,
  type DiffTargetSnapshot,
  type DiffApplyRequest,
  type DiffApplyResult,
  type HunkProbe,
} from '../../../shared/diffParse';

// Git exec helper promoted to main/git/git.ts (behavior unchanged) — shared
// with worktree handler. Still returns stdout/stderr/code instead of throw.

// Per-target-repo serial queue (§3 R15 — reuses J1 per-repo mutex pattern).
// key = target repo path. Same shape as J1 TaskWorktreeManager.withRepoLock but
// that instance lives inside FanOutService, so additive principle duplicates the pattern.
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

// Worktree cwd → main repo path. null on failure.
// F9: drop fragile string-manipulation fallback (strip `.git` suffix regex); ask git directly.
//   Run `rev-parse --show-toplevel` from the parent of common-dir (`<repo>/.git`) to
//   get the main repo root exactly (direct --show-toplevel from worktree cwd returns
//   the worktree itself, breaking target=main-repo contract — run from parent).
async function resolveTargetRepo(worktreePath: string): Promise<string | null> {
  const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath);
  if (r.code !== 0) return null;
  const commonDir = r.stdout.trim();
  if (!commonDir) return null;
  // Derive toplevel using common-dir's parent (`<repo>/.git` → `<repo>`) as work tree.
  const top = await git(['-C', dirname(commonDir), 'rev-parse', '--show-toplevel'], worktreePath);
  if (top.code !== 0 || !top.stdout.trim()) return null;
  return top.stdout.trim();
}

// Parse NUL-delimited `git status --porcelain -z` output record-by-record (F1 — quotepath).
//   - Each record: "XY <space>path\0". core.quotepath=false + -z preserves spaces,
//     CJK, and quoted filenames verbatim (no quotes or octal escapes).
//   - rename/copy (X or Y is 'R'/'C'): "XY newpath\0oldpath\0" — trailing NUL
//     field is oldpath, so one record consumes 2 fields. status/xy is newpath-based.
interface StatusEntry {
  readonly xy: string; // 2-char status code (e.g. " M", "??", "R ").
  readonly path: string; // newpath (display and match target).
  readonly origPath: string | null; // oldpath for rename/copy; null otherwise.
}
function parsePorcelainZ(raw: string): StatusEntry[] {
  const fields = raw.split('\0');
  const out: StatusEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const rec = fields[i];
    i += 1;
    // Skip empty tail element after final NUL.
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3); // after "XY ".
    // rename/copy: next field is oldpath.
    const isRenameCopy = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
    let origPath: string | null = null;
    if (isRenameCopy && i < fields.length) {
      origPath = fields[i];
      i += 1;
    }
    out.push({ xy, path, origPath });
  }
  return out;
}

// Collect target snapshot (§2 drift-gate material).
async function collectSnapshot(targetRepoPath: string): Promise<DiffTargetSnapshot> {
  const [head, branch, status] = await Promise.all([
    git(['rev-parse', 'HEAD'], targetRepoPath),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], targetRepoPath),
    // F1: -z + quotepath=false parses special-char filenames verbatim. rename uses newpath only.
    git(['-c', 'core.quotepath=false', 'status', '--porcelain', '-z'], targetRepoPath),
  ]);
  const dirty: string[] = [];
  for (const e of parsePorcelainZ(status.stdout)) {
    // rename/copy: newpath (e.path) is dirty target. dirty gate matches adopt-target
    // path set, so use display path.
    dirty.push(e.path);
  }
  return {
    targetRepoPath,
    targetBranch: branch.stdout.trim(),
    targetHeadOid: head.stdout.trim(),
    targetDirtyFiles: dirty,
  };
}

// Parse numstat (for file-tree display). binary is "-\t-\tpath".
function parseNumstat(raw: string): DiffNumstat[] {
  const out: DiffNumstat[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    const path = rest.join('\t');
    out.push({
      path,
      additions: a === '-' ? null : Number.parseInt(a, 10),
      deletions: d === '-' ? null : Number.parseInt(d, 10),
    });
  }
  return out;
}

// Git's well-known empty tree object — diff base for pre-first-commit (no HEAD) repos.
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// diff:read implementation.
//
// mode:
//  - 'task' (default): J2 task-output diff. Map worktree to main repo
//    (resolveTargetRepo) then merge-base compare — adopt task-branch output
//    against main repo.
//  - 'workspace': workspace diff. Only uncommitted changes on cwd repo/worktree
//    itself (`git diff HEAD` + untracked). Do not map to main repo — otherwise
//    linked worktree branch commits leak into diff (Codex P2). Pre-first-commit
//    repo has no HEAD, so show all files as added vs empty-tree.
async function readDiff(
  worktreePath: string,
  targetHeadOid: string,
  mode: 'task' | 'workspace' = 'task',
): Promise<DiffReadResult | DiffReadError> {
  // workspace mode: target repo = self (cwd toplevel). Do not map to main repo via resolveTargetRepo.
  const targetRepoPath =
    mode === 'workspace'
      ? await (async () => {
          const r = await git(['rev-parse', '--show-toplevel'], worktreePath);
          return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
        })()
      : await resolveTargetRepo(worktreePath);
  if (!targetRepoPath) {
    return { ok: false, error: 'Target repo not found (corrupt worktree?)', code: 'no-repo' };
  }

  // F8: targetHeadOid arg guard — when specified, allow SHA-1 hex (7–40 chars) only.
  //   Empty string (unspecified) passes; derived to target HEAD below. Explicitly
  //   validate format before passing arg injection into merge-base/git commands.
  if (targetHeadOid && !/^[0-9a-fA-F]{7,40}$/.test(targetHeadOid)) {
    return { ok: false, error: 'targetHeadOid format error (not SHA hex 7–40 chars)', code: 'bad-oid' };
  }

  let mergeBase: string;
  if (mode === 'workspace') {
    // Uncommitted only: base = own HEAD. Pre-first-commit uses empty-tree (all files added).
    const h = await git(['rev-parse', 'HEAD'], targetRepoPath);
    mergeBase = h.code === 0 && h.stdout.trim() ? h.stdout.trim() : EMPTY_TREE_OID;
  } else {
    // When targetHeadOid unspecified, use target repo's current HEAD (renderer need not know ahead).
    let headOid = targetHeadOid;
    if (!headOid) {
      const h = await git(['rev-parse', 'HEAD'], targetRepoPath);
      headOid = h.code === 0 ? h.stdout.trim() : '';
    }
    // mergeBase = merge-base HEAD {targetHeadOid} — single source (§2 G8).
    const mb = await git(['merge-base', 'HEAD', headOid], worktreePath);
    mergeBase = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : headOid;
  }

  // 1-arg working-tree compare (includes uncommitted). Excludes untracked — synthesized separately.
  const diffRes = await git(['diff', mergeBase], worktreePath);
  if (diffRes.code !== 0) {
    return { ok: false, error: `git diff failed: ${diffRes.stderr.slice(0, 200)}`, code: 'diff-fail' };
  }
  const numRes = await git(['diff', '--numstat', mergeBase], worktreePath);

  // Collect untracked → synthesize proper new-file headers (§2 R4).
  // F1: -z + quotepath=false parses special-char untracked filenames verbatim.
  const utRes = await git(
    ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '-z'],
    worktreePath,
  );
  const untracked: string[] = [];
  for (const e of parsePorcelainZ(utRes.stdout)) {
    if (e.xy === '??') untracked.push(e.path);
  }

  let diffText = diffRes.stdout;
  const truncated: string[] = [];
  const unsupported: string[] = [];
  const extraNumstat: DiffNumstat[] = [];

  for (const rel of untracked) {
    try {
      const full = join(worktreePath, rel);
      // F3: lstat before readFile — following symlinks exposes out-of-repo files in diff.
      // Synthesize regular files only. symlink/FIFO/socket/device etc. not adoptable ("unsupported").
      const ls = await lstat(full);
      if (!ls.isFile()) {
        unsupported.push(rel);
        extraNumstat.push({ path: rel, additions: null, deletions: null });
        continue;
      }
      const stat = await readFile(full);
      if (stat.length > DIFF_FILE_CAP_BYTES) {
        truncated.push(rel);
        extraNumstat.push({ path: rel, additions: null, deletions: null });
        continue;
      }
      // Binary heuristic: NUL byte present.
      if (stat.includes(0)) {
        truncated.push(rel);
        extraNumstat.push({ path: rel, additions: null, deletions: null });
        continue;
      }
      const content = stat.toString('utf8');
      diffText += synthesizeNewFileDiff(rel, content);
      const lineCount = content.length === 0 ? 0 : content.replace(/\n$/, '').split('\n').length;
      extraNumstat.push({ path: rel, additions: lineCount, deletions: 0 });
    } catch {
      // Read failure (race delete etc.) — skip quietly.
    }
  }

  // Total size cap (§2). On exceed, still parse but mark large files display-only.
  if (Buffer.byteLength(diffText, 'utf8') > DIFF_TOTAL_CAP_BYTES) {
    return {
      ok: false,
      error: 'Total diff exceeds 2MB — display only (cannot adopt). Narrow commit scope and re-read.',
      code: 'too-large',
    };
  }

  const parsed = parseUnifiedDiff(diffText);
  // Mark per-file cap exceeders as truncated (keep parsing but annotate).
  const files: DiffFile[] = [];
  for (const f of parsed.files) {
    const size = f.headerBlock.length + f.hunks.reduce((s, h) => s + h.bodyLines.join('\n').length, 0);
    const isTruncated = size > DIFF_FILE_CAP_BYTES;
    if (isTruncated && !truncated.includes(f.path)) truncated.push(f.path);
    // F7: cap-exceeded files demoted to hunkSelectable=false (pairs with applyHunks double rejection).
    //   Even if display diff wasn't truncated, exclude from adopt targets beyond re-serialization trust.
    if (isTruncated && f.hunkSelectable) {
      files.push({ ...f, hunkSelectable: false });
    } else {
      files.push(f);
    }
  }

  const snapshot = await collectSnapshot(targetRepoPath);
  const numstat = [...parseNumstat(numRes.stdout), ...extraNumstat];

  return { ok: true, files, numstat, snapshot, truncated, unsupported };
}

// Validate paths inside patch (§3 R16): normalize a/ b/, reject .. and absolute paths.
function patchPathsSafe(patch: string): boolean {
  for (const line of patch.split('\n')) {
    let p: string | null = null;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      p = line.slice(4).split('\t')[0];
    } else if (line.startsWith('diff --git ')) {
      // "diff --git a/x b/y" — check both paths.
      const m = line.match(/^diff --git (\S+) (\S+)$/);
      if (m) {
        for (const raw of [m[1], m[2]]) {
          const s = raw.replace(/^[ab]\//, '');
          if (s !== '/dev/null' && (isAbsolute(s) || normalize(s).startsWith('..'))) return false;
        }
      }
      continue;
    }
    if (p === null) continue;
    if (p === '/dev/null') continue;
    const s = p.replace(/^[ab]\//, '');
    if (isAbsolute(s) || normalize(s).startsWith('..')) return false;
  }
  return true;
}

// diff:applyHunks implementation.
async function applyHunks(req: DiffApplyRequest, worktreePath: string): Promise<DiffApplyResult> {
  const targetRepoPath = await resolveTargetRepo(worktreePath);
  if (!targetRepoPath) {
    return { ok: false, error: 'Target repo not found', code: 'apply' };
  }

  return withRepoLock(targetRepoPath, async (): Promise<DiffApplyResult> => {
    // ① Drift gate (§2·§3): snapshot HEAD/branch must match current.
    const cur = await collectSnapshot(targetRepoPath);
    if (
      cur.targetHeadOid !== req.snapshot.targetHeadOid ||
      cur.targetBranch !== req.snapshot.targetBranch
    ) {
      return { ok: false, error: 'Target moved — re-read diff required', code: 'drift' };
    }

    // Recompute diff for selected files (task worktree basis). Same source as read.
    const read = await readDiff(worktreePath, req.snapshot.targetHeadOid);
    if (!read.ok) return { ok: false, error: read.error, code: 'apply' };

    // Map selected files + validate adoptability.
    const selMap = new Map<string, readonly number[]>();
    for (const s of req.selections) selMap.set(s.path, s.hunkIndices);
    const selectedFiles: Array<{ file: DiffFile; hunkIndices: readonly number[] }> = [];
    const truncatedSet = new Set(read.truncated);
    for (const f of read.files) {
      const idxs = selMap.get(f.path);
      if (!idxs || idxs.length === 0) continue;
      // F7 double rejection: cap-exceeded (truncated) files also hit hunkSelectable=false,
      // but explicitly reject via truncated set to double-block adopt beyond re-serialization trust.
      if (truncatedSet.has(f.path)) {
        return {
          ok: false,
          error: `${f.path}: exceeds cap — display only, cannot adopt`,
          code: 'unsupported',
        };
      }
      if (!f.hunkSelectable) {
        return {
          ok: false,
          error: `${f.path}: rename/binary/mode changes cannot be adopted`,
          code: 'unsupported',
        };
      }
      selectedFiles.push({ file: f, hunkIndices: idxs });
    }
    if (selectedFiles.length === 0) {
      return { ok: false, error: 'No hunks selected', code: 'apply' };
    }

    // ② Dirty rejection (§3): reject if target file is currently dirty.
    const dirtySet = new Set(cur.targetDirtyFiles);
    for (const sf of selectedFiles) {
      if (dirtySet.has(sf.file.path)) {
        return {
          ok: false,
          error: `${sf.file.path}: target has uncommitted changes — rejected to avoid conflicts`,
          code: 'dirty',
        };
      }
    }

    const patch = reassemblePatch(selectedFiles);
    if (!patchPathsSafe(patch)) {
      return { ok: false, error: 'Patch path validation failed (.. or absolute path)', code: 'path' };
    }

    // ③ Probe (§3, F2 redefinition): per-hunk individual probes are UI-hint only;
    //    apply gate is separated as "selected-hunk combined patch single --check".
    //    - Individual --check false-negatives dependent hunks (later hunk needs earlier),
    //      so not used as gate.
    //    - alreadyApplied (--reverse --check succeeds) hunks fail explicitly before gate:
    //      when combined apply rejects all, don't hide "already-applied hunk was the cause";
    //      prompt user to deselect those hunks.
    const probes: HunkProbe[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'wmux-diff-'));
    try {
      for (const sf of selectedFiles) {
        for (const idx of sf.hunkIndices) {
          const single = reassemblePatch([{ file: sf.file, hunkIndices: [idx] }]);
          const pPath = join(dir, `probe-${Math.random().toString(36).slice(2)}.diff`);
          await writeFile(pPath, single);
          const check = await git(['apply', '--check', pPath], targetRepoPath);
          const reverse = await git(['apply', '--reverse', '--check', pPath], targetRepoPath);
          probes.push({
            path: sf.file.path,
            hunkIndex: idx,
            applicable: check.code === 0,
            alreadyApplied: reverse.code === 0,
          });
        }
      }

      // alreadyApplied hunks fail explicitly before gate (prompt deselection).
      const already = probes.filter((p) => p.alreadyApplied);
      if (already.length > 0) {
        return {
          ok: false,
          error: 'Some hunks are already applied on target — deselect them and retry',
          code: 'probe',
          failedProbes: already,
        };
      }

      // Apply gate: selected-hunk combined patch single --check (dependent hunks pass, all-or-nothing).
      const patchPath = join(dir, 'apply.diff');
      await writeFile(patchPath, patch);
      const gate = await git(['apply', '--check', patchPath], targetRepoPath);
      if (gate.code !== 0) {
        // Combined --check failed: attach applicable=false hunks from individual probes as UI hints
        // (show user which hunk is problematic). If no hints (each applies individually but
        // combined fails), report whole failure only.
        const notApplicable = probes.filter((p) => !p.applicable);
        return {
          ok: false,
          error: `Selected hunks cannot be applied together (target unchanged): ${gate.stderr.slice(0, 200)}`,
          code: 'probe',
          failedProbes: notApplicable.length > 0 ? notApplicable : probes,
        };
      }

      // ④ Single-patch all-or-nothing apply (§3). --unsafe-paths forbidden.
      const applied = await git(['apply', patchPath], targetRepoPath);
      if (applied.code !== 0) {
        return {
          ok: false,
          error: `git apply failed (target unchanged): ${applied.stderr.slice(0, 200)}`,
          code: 'apply',
        };
      }
      return { ok: true, appliedFiles: selectedFiles.map((s) => s.file.path) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

export function registerDiffHandlers(): () => void {
  ipcMain.removeHandler(IPC.DIFF_READ);
  ipcMain.handle(
    IPC.DIFF_READ,
    wrapHandler(
      IPC.DIFF_READ,
      async (
        _event: Electron.IpcMainInvokeEvent,
        worktreePath: unknown,
        targetHeadOid: unknown,
        mode: unknown,
      ): Promise<DiffReadResult | DiffReadError> => {
        if (typeof worktreePath !== 'string' || !worktreePath) {
          return { ok: false, error: 'worktreePath required', code: 'bad-args' };
        }
        // targetHeadOid is optional — when unspecified, derive from target repo HEAD.
        const head = typeof targetHeadOid === 'string' ? targetHeadOid : '';
        // Unspecified/invalid mode defaults to 'task' (existing contract). Only 'workspace' branches explicitly.
        return readDiff(worktreePath, head, mode === 'workspace' ? 'workspace' : 'task');
      },
    ),
  );

  // Workspace diff entry point — normalize cwd (subdir allowed) to own worktree toplevel.
  // diff:read worktreePath contract (untracked synthesis joins repo-root-relative paths)
  // assumes toplevel, so renderer persists this result as diffRepoPath.
  // Linked worktree cwd returns that worktree's toplevel (not main repo —
  // diff:read resolveTargetRepo performs main-repo compare afterward).
  ipcMain.removeHandler(IPC.DIFF_RESOLVE_REPO);
  ipcMain.handle(
    IPC.DIFF_RESOLVE_REPO,
    wrapHandler(
      IPC.DIFF_RESOLVE_REPO,
      async (
        _event: Electron.IpcMainInvokeEvent,
        cwd: unknown,
      ): Promise<{ ok: true; repoPath: string } | { ok: false }> => {
        if (typeof cwd !== 'string' || !cwd) return { ok: false };
        const r = await git(['rev-parse', '--show-toplevel'], cwd);
        const top = r.code === 0 ? r.stdout.trim() : '';
        return top ? { ok: true, repoPath: top } : { ok: false };
      },
    ),
  );

  ipcMain.removeHandler(IPC.DIFF_APPLY_HUNKS);
  ipcMain.handle(
    IPC.DIFF_APPLY_HUNKS,
    wrapHandler(
      IPC.DIFF_APPLY_HUNKS,
      async (
        _event: Electron.IpcMainInvokeEvent,
        req: unknown,
        worktreePath: unknown,
      ): Promise<DiffApplyResult> => {
        if (typeof worktreePath !== 'string' || !worktreePath) {
          return { ok: false, error: 'worktreePath required', code: 'apply' };
        }
        const r = req as DiffApplyRequest;
        if (!r || !r.snapshot || !Array.isArray(r.selections)) {
          return { ok: false, error: 'applyHunks request format error', code: 'apply' };
        }
        return applyHunks(r, worktreePath);
      },
    ),
  );

  return () => {
    ipcMain.removeHandler(IPC.DIFF_READ);
    ipcMain.removeHandler(IPC.DIFF_RESOLVE_REPO);
    ipcMain.removeHandler(IPC.DIFF_APPLY_HUNKS);
  };
}
