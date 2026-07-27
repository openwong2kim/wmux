/**
 * WorktaskScanService — J3 §1 D1(CL5). 태스크 수명주기 "정리 목록"의 정본.
 *
 * 정본은 디스크다: J0 closed projection GC(WORKTASK_CLOSED_GC_MS=7일)가 태스크를
 * 소멸시켜도, 전용 루트(`{wmux home}/worktrees/{repoHash}/{taskSlug}`)에 남은
 * worktree 디렉토리는 그대로다. 각 태스크 meta dir의 `task.json` 스탬프
 * (FanOutService가 스폰 시 각인)가 taskId·title 역추적을 보장한다. projection은
 * 보조(open 태스크 대조)다.
 *
 * 4종 판정(§1):
 *   - 'unmaterialized-open' : open 태스크인데 worktreePath 부재(스폰 반쪽 —
 *       에이전트 페인이 빈 채로 남았을 수 있음. 사람이 close 또는 재물질화).
 *   - 'disk-missing'        : open 태스크가 worktreePath를 주장하나 디스크에 부재
 *       (외부 삭제·remove↔close 크래시. 사람이 close로 정합화).
 *   - 'preserved'           : worktree가 디스크에 있고 open 태스크와 매칭되며 dirty
 *       (close 보류로 보존된 산출물 — 사람이 diff 재열람 후 커밋/PR 또는 폐기).
 *   - 'orphan-dir'          : worktree가 디스크에 있으나 매칭 open 태스크 없음
 *       (GC된 closed 태스크·크래시 잔여. task.json으로 역추적, 안전 삭제 대상).
 *
 * clean+linked(정상 작업 중)인 worktree는 이상이 아니므로 목록에서 제외한다 —
 * 정리 목록은 "손이 필요한 것"만 싣는다.
 *
 * 비용(§7): 온디맨드 호출 + 전용 루트 한정 순회 + preserved 판정만 git status.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getWmuxHomeDir } from '../../shared/constants';
import { getExecEnv } from '../../shared/execEnv';
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
  /** projection 또는 task.json에서 회수. 역추적 불가 시 부재(무연결 디렉토리). */
  taskId?: string;
  title?: string;
  /** F1 — 열린 태스크 이상 항목의 owner(부모) ws id. close authz가 owner 스코프라
   *  정합화 버튼이 이 신원으로 close를 불러야 한다. orphan은 부재. */
  ownerWorkspaceId?: string;
  /** 디스크 worktree 경로(preserved·orphan-dir·disk-missing에서 존재). */
  worktreePath?: string;
  /** task.json의 closedAt(GC된 closed 태스크의 orphan에서만 관측). */
  closedAt?: number;
  /** 사람용 부가 설명. */
  detail?: string;
}

export interface WorktaskScanResult {
  scannedRoot: string;
  entries: WorktaskScanEntry[];
}

/** projection 대조 입력(open 태스크만 — 호출측이 status로 필터). */
export interface ScanOpenTask {
  taskId: string;
  title: string;
  /** F1 — owner(부모) ws id. 이상 엔트리 close를 owner 스코프로 부르는 재료. */
  ownerWorkspaceId?: string;
  worktreePath?: string;
}

export interface WorktaskScanServiceOptions {
  /** 전용 루트 파생 override(테스트). 기본 `{wmux home}/worktrees`. */
  worktreesRoot?: string;
  /** realpath 해석(심링크) — 정규화 전 실경로. 실패 시 원본. */
  realpath?: (p: string) => string;
  /** worktree dirty 판정용 git 러너(테스트 주입). 기본 execFile git. */
  isDirty?: (worktreePath: string) => Promise<boolean>;
  /** 플랫폼(경로 대소문자 정규화 — 테스트). 기본 process.platform. */
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
   * 정리 스캔(§1). openTasks는 데몬 projection의 open 태스크(호출측이 필터). 반환은
   * 이상 항목만(clean+linked 정상 작업은 제외).
   */
  async scan(openTasks: ScanOpenTask[]): Promise<WorktaskScanResult> {
    const entries: WorktaskScanEntry[] = [];

    // ── projection 측: 물질화 필드 기준 인덱스 ──
    const openByNormPath = new Map<string, ScanOpenTask>();
    for (const t of openTasks) {
      if (!t.worktreePath) {
        entries.push({
          category: 'unmaterialized-open',
          taskId: t.taskId,
          title: t.title,
          ...(t.ownerWorkspaceId ? { ownerWorkspaceId: t.ownerWorkspaceId } : {}),
          detail: '물질화 미완(worktree 부재) — close 또는 재물질화',
        });
        continue;
      }
      const norm = this.norm(t.worktreePath);
      openByNormPath.set(norm, t);
    }

    // ── 디스크 측: 전용 루트 순회(worktree 디렉토리 열거) ──
    const seen = new Set<string>();
    for (const dir of this.enumerateWorktreeDirs()) {
      const norm = this.norm(dir);
      seen.add(norm);
      const matched = openByNormPath.get(norm);
      if (matched) {
        // linked — dirty만 '보존 잔존'으로. clean은 정상 작업이라 제외.
        let dirty = false;
        try {
          dirty = await this.isDirty(dir);
        } catch {
          // git 실패 → 보수적으로 dirty 간주(무해측: 목록에 노출해 사람이 확인).
          dirty = true;
        }
        if (dirty) {
          entries.push({
            category: 'preserved',
            taskId: matched.taskId,
            title: matched.title,
            ...(matched.ownerWorkspaceId ? { ownerWorkspaceId: matched.ownerWorkspaceId } : {}),
            worktreePath: dir,
            detail: '미커밋 산출물 보존 — diff 재열람 후 커밋/PR 또는 폐기',
          });
        }
        continue;
      }
      // 무연결 디렉토리 — task.json으로 역추적(GC된 closed·크래시 잔여).
      const stamp = this.readStamp(dir);
      entries.push({
        category: 'orphan-dir',
        ...(stamp?.taskId ? { taskId: stamp.taskId } : {}),
        ...(stamp?.title ? { title: stamp.title } : {}),
        ...(stamp?.closedAt !== undefined ? { closedAt: stamp.closedAt } : {}),
        worktreePath: dir,
        detail: stamp
          ? '연결된 open 태스크 없음(종료·GC 잔여) — 수동 확인 후 삭제 가능'
          : '연결된 태스크·스탬프 없음 — 수동 확인 후 삭제 가능',
      });
    }

    // ── disk-missing: worktreePath를 주장하나 디스크에 없는 open 태스크 ──
    for (const [norm, t] of openByNormPath) {
      if (seen.has(norm)) continue;
      entries.push({
        category: 'disk-missing',
        taskId: t.taskId,
        title: t.title,
        ...(t.ownerWorkspaceId ? { ownerWorkspaceId: t.ownerWorkspaceId } : {}),
        ...(t.worktreePath ? { worktreePath: t.worktreePath } : {}),
        detail: 'worktree 디스크 부재(외부 삭제·크래시) — close로 정합화',
      });
    }

    // ── F8 meta 고아: remove↔meta 삭제 사이 크래시로 worktree는 없어졌으나
    // `.meta/{slug}/task.json`이 남은 잔여. worktree 무매칭 + open 태스크 무매칭인
    // meta만 orphan-dir로 표시(사이드카 정리 대상). 자동 삭제는 하지 않는다.
    for (const meta of this.enumerateMetaDirs()) {
      const wtNorm = this.norm(meta.impliedWorktreePath);
      if (seen.has(wtNorm) || openByNormPath.has(wtNorm)) continue; // worktree/태스크 있으면 정상.
      const stamp = this.readStampFromMeta(meta.metaDir);
      entries.push({
        category: 'orphan-dir',
        ...(stamp?.taskId ? { taskId: stamp.taskId } : {}),
        ...(stamp?.title ? { title: stamp.title } : {}),
        ...(stamp?.closedAt !== undefined ? { closedAt: stamp.closedAt } : {}),
        worktreePath: meta.impliedWorktreePath,
        detail: 'worktree 없는 meta 잔여(remove↔meta 삭제 크래시) — 사이드카 확인 후 삭제 가능',
      });
    }

    return { scannedRoot: this.root, entries };
  }

  /** F8 — 전용 루트의 meta dir 열거: `{root}/{repoHash}/.meta/{slug}`와 그 slug가
   *  함의하는 worktree 경로 `{root}/{repoHash}/{slug}`. */
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
        continue; // .meta 부재면 스킵.
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
   * 전용 루트의 worktree 디렉토리 열거: `{root}/{repoHash}/{taskSlug}`. `.meta`는
   * 제외(사이드카). repoHash 층·taskSlug 층 2단 순회. 루트 부재는 빈 배열.
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
        if (s.name === '.meta') continue; // 사이드카(prompt.md·task.json).
        out.push(path.join(repoDir, s.name));
      }
    }
    return out;
  }

  /** worktree 경로의 sibling meta dir에서 task.json 스탬프 읽기(부재·손상 시 null). */
  private readStamp(worktreePath: string): WorkTaskMetaStamp | null {
    return this.readStampFromMeta(metaDirForWorktree(worktreePath));
  }

  /** meta dir에서 task.json 스탬프 읽기(부재·손상 시 null). */
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

/** 기본 dirty 판정: `git status --porcelain` 비어있지 않으면 dirty. */
async function defaultIsDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    timeout: 30000,
    windowsHide: true,
    env: getExecEnv(),
  });
  return stdout.trim().length > 0;
}
