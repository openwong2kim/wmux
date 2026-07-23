/**
 * WorktaskScanService — J3 §1 D1(CL5). Source of truth for task lifecycle "cleanup list".
 *
 * Source of truth is disk: J0 closed projection GC (WORKTASK_CLOSED_GC_MS=7 days) may destroy tasks
 * but worktree directories under dedicated root (`{wmux home}/worktrees/{repoHash}/{taskSlug}`)
 * remain. Each task meta dir `task.json` stamp (written by FanOutService on spawn) guarantees
 * taskId·title reverse trace. projection is auxiliary (open task cross-check).
 *
 * Four categories (§1):
 *   - 'unmaterialized-open' : open task missing worktreePath (half spawn —
 *       agent pane may remain empty. human close or re-materialize).
 *   - 'disk-missing'        : open task claims worktreePath but absent on disk
 *       (external delete·remove↔close crash. human close to reconcile).
 *   - 'preserved'           : worktree on disk matching open task and dirty
 *       (output preserved due to close hold — human re-read diff then commit/PR or discard).
 *   - 'orphan-dir'          : worktree on disk with no matching open task
 *       (GC'd closed task·crash remnant. reverse trace via task.json, safe delete candidate).
 *
 * clean+linked (normal in-progress) worktrees are not anomalies so excluded from list —
 * cleanup list carries only "needs attention" items.
 *
 * Cost (§7): on-demand call + dedicated root only traversal + git status only for preserved determination.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getWmuxHomeDir } from '../../shared/constants';
import { getGitExecEnv } from '../../shared/execEnv';
import { normalizeWorktreePath, WORKTASK_META_FILENAME, type WorkTaskMetaStamp } from '../../shared/workTask';
import { metaDirForWorktree } from './TaskWorktreeManager';

const execFileAsync = promisify(execFile);

export type WorktaskScanCategory =
  | 'unmaterialized-open'
  | 'disk-missing'
  | 'preserved'
  | 'orphan-dir';

export interface WorktaskScanEntry {
  category: WorktaskScanCategory;
  /** Recovered from projection or task.json. Absent when reverse trace impossible (unlinked directory). */
  taskId?: string;
  title?: string;
  /** F1 — owner (parent) ws id for open task anomaly entries. close authz is owner-scoped so
   *  reconcile button must call close with this identity. absent for orphan. */
  ownerWorkspaceId?: string;
  /** Disk worktree path (present in preserved·orphan-dir·disk-missing). */
  worktreePath?: string;
  /** closedAt from task.json (observed only on orphan from GC'd closed task). */
  closedAt?: number;
  /** Human-readable detail. */
  detail?: string;
}

export interface WorktaskScanResult {
  scannedRoot: string;
  entries: WorktaskScanEntry[];
}

/** Projection cross-check input (open tasks only — caller filters by status). */
export interface ScanOpenTask {
  taskId: string;
  title: string;
  /** F1 — owner (parent) ws id. Material for calling close in owner scope for anomaly entries. */
  ownerWorkspaceId?: string;
  worktreePath?: string;
}

export interface WorktaskScanServiceOptions {
  /** Dedicated root derivation override (tests). Default `{wmux home}/worktrees`. */
  worktreesRoot?: string;
  /** realpath resolution (symlinks) — actual path before normalization. Original on failure. */
  realpath?: (p: string) => string;
  /** git runner for worktree dirty determination (test injection). Default execFile git. */
  isDirty?: (worktreePath: string) => Promise<boolean>;
  /** Platform (path case normalization — tests). Default process.platform. */
  platform?: NodeJS.Platform;
}

export class WorktaskScanService {
  private readonly root: string;
  private readonly realpath: (p: string) => string;
  private readonly isDirty: (worktreePath: string) => Promise<boolean>;
  private readonly platform: NodeJS.Platform;

  constructor(opts?: WorktaskScanServiceOptions) {
    this.root = opts?.worktreesRoot ?? path.join(getWmuxHomeDir(), 'worktrees');
    this.realpath =
      opts?.realpath ??
      ((p) => {
        try {
          return fs.realpathSync(p);
        } catch {
          return p;
        }
      });
    this.isDirty = opts?.isDirty ?? defaultIsDirty;
    this.platform = opts?.platform ?? process.platform;
  }

  /**
   * Cleanup scan (§1). openTasks are daemon projection open tasks (caller filters). Returns
   * anomaly entries only (excludes clean+linked normal work).
   */
  async scan(openTasks: ScanOpenTask[]): Promise<WorktaskScanResult> {
    const entries: WorktaskScanEntry[] = [];

    // ── projection side: index by materialization fields ──
    const openByNormPath = new Map<string, ScanOpenTask>();
    for (const t of openTasks) {
      if (!t.worktreePath) {
        entries.push({
          category: 'unmaterialized-open',
          taskId: t.taskId,
          title: t.title,
          ...(t.ownerWorkspaceId ? { ownerWorkspaceId: t.ownerWorkspaceId } : {}),
          detail: 'Materialization incomplete (missing worktree) — close or re-materialize',
        });
        continue;
      }
      const norm = this.norm(t.worktreePath);
      openByNormPath.set(norm, t);
    }

    // ── disk side: traverse dedicated root (enumerate worktree directories) ──
    const seen = new Set<string>();
    for (const dir of this.enumerateWorktreeDirs()) {
      const norm = this.norm(dir);
      seen.add(norm);
      const matched = openByNormPath.get(norm);
      if (matched) {
        // linked — only dirty as 'preserved remnant'. clean is normal work so excluded.
        let dirty = false;
        try {
          dirty = await this.isDirty(dir);
        } catch {
          // git failure → conservatively treat as dirty (harmless side: expose in list for human check).
          dirty = true;
        }
        if (dirty) {
          entries.push({
            category: 'preserved',
            taskId: matched.taskId,
            title: matched.title,
            ...(matched.ownerWorkspaceId ? { ownerWorkspaceId: matched.ownerWorkspaceId } : {}),
            worktreePath: dir,
            detail: 'Uncommitted output preserved — review diff, then commit/PR or discard',
          });
        }
        continue;
      }
      // Unlinked directory — reverse trace via task.json (GC'd closed·crash remnant).
      const stamp = this.readStamp(dir);
      entries.push({
        category: 'orphan-dir',
        ...(stamp?.taskId ? { taskId: stamp.taskId } : {}),
        ...(stamp?.title ? { title: stamp.title } : {}),
        ...(stamp?.closedAt !== undefined ? { closedAt: stamp.closedAt } : {}),
        worktreePath: dir,
        detail: stamp
          ? 'No linked open task (closed/GC remnant) — verify manually before delete'
          : 'No linked task or stamp — verify manually before delete',
      });
    }

    // ── disk-missing: open tasks claiming worktreePath absent on disk ──
    for (const [norm, t] of openByNormPath) {
      if (seen.has(norm)) continue;
      entries.push({
        category: 'disk-missing',
        taskId: t.taskId,
        title: t.title,
        ...(t.ownerWorkspaceId ? { ownerWorkspaceId: t.ownerWorkspaceId } : {}),
        ...(t.worktreePath ? { worktreePath: t.worktreePath } : {}),
        detail: 'Worktree missing on disk (external delete/crash) — close to reconcile',
      });
    }

    // ── F8 meta orphan: crash between remove↔meta delete left worktree gone but
    // `.meta/{slug}/task.json` remnant. Show meta-only as orphan-dir when worktree unmapped + open task unmapped
    // (sidecar cleanup target). No auto delete.
    for (const meta of this.enumerateMetaDirs()) {
      const wtNorm = this.norm(meta.impliedWorktreePath);
      if (seen.has(wtNorm) || openByNormPath.has(wtNorm)) continue; // normal when worktree/task present.
      const stamp = this.readStampFromMeta(meta.metaDir);
      entries.push({
        category: 'orphan-dir',
        ...(stamp?.taskId ? { taskId: stamp.taskId } : {}),
        ...(stamp?.title ? { title: stamp.title } : {}),
        ...(stamp?.closedAt !== undefined ? { closedAt: stamp.closedAt } : {}),
        worktreePath: meta.impliedWorktreePath,
        detail: 'Meta remnant without worktree (remove↔meta delete crash) — verify sidecar before delete',
      });
    }

    return { scannedRoot: this.root, entries };
  }

  /** F8 — enumerate meta dirs under dedicated root: `{root}/{repoHash}/.meta/{slug}` and implied
   *  worktree path `{root}/{repoHash}/{slug}`. */
  private enumerateMetaDirs(): Array<{ metaDir: string; impliedWorktreePath: string }> {
    const out: Array<{ metaDir: string; impliedWorktreePath: string }> = [];
    let repoHashes: fs.Dirent[];
    try {
      repoHashes = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const rh of repoHashes) {
      if (!rh.isDirectory()) continue;
      const metaRoot = path.join(this.root, rh.name, '.meta');
      let slugs: fs.Dirent[];
      try {
        slugs = fs.readdirSync(metaRoot, { withFileTypes: true });
      } catch {
        continue; // skip when .meta absent.
      }
      for (const s of slugs) {
        if (!s.isDirectory()) continue;
        out.push({
          metaDir: path.join(metaRoot, s.name),
          impliedWorktreePath: path.join(this.root, rh.name, s.name),
        });
      }
    }
    return out;
  }

  /**
   * Enumerate worktree directories under dedicated root: `{root}/{repoHash}/{taskSlug}`. Excludes `.meta`
   * (sidecar). Two-level traverse repoHash·taskSlug. Empty array when root absent.
   */
  private enumerateWorktreeDirs(): string[] {
    const out: string[] = [];
    let repoHashes: fs.Dirent[];
    try {
      repoHashes = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const rh of repoHashes) {
      if (!rh.isDirectory()) continue;
      const repoDir = path.join(this.root, rh.name);
      let slugs: fs.Dirent[];
      try {
        slugs = fs.readdirSync(repoDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of slugs) {
        if (!s.isDirectory()) continue;
        if (s.name === '.meta') continue; // sidecar (prompt.md·task.json).
        out.push(path.join(repoDir, s.name));
      }
    }
    return out;
  }

  /** Read task.json stamp from sibling meta dir of worktree path (null if absent·corrupt). */
  private readStamp(worktreePath: string): WorkTaskMetaStamp | null {
    return this.readStampFromMeta(metaDirForWorktree(worktreePath));
  }

  /** Read task.json stamp from meta dir (null if absent·corrupt). */
  private readStampFromMeta(metaDir: string): WorkTaskMetaStamp | null {
    try {
      const raw = fs.readFileSync(path.join(metaDir, WORKTASK_META_FILENAME), 'utf8');
      const parsed = JSON.parse(raw) as WorkTaskMetaStamp;
      if (parsed && typeof parsed.taskId === 'string') return parsed;
      return null;
    } catch {
      return null;
    }
  }

  private norm(p: string): string {
    return normalizeWorktreePath(this.realpath(p), this.platform);
  }
}

/** Default dirty determination: dirty when `git status --porcelain` is non-empty. */
async function defaultIsDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    timeout: 30000,
    windowsHide: true,
    env: getGitExecEnv(),
  });
  return stdout.trim().length > 0;
}
