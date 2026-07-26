// Deck Git 탭 — 워크트리 GUI main 핸들러 (list / add / remove).
//
// 렌더러-전용 IPC 표면(파이프 RpcRouter 미노출 — channelLocal/fanout과 동일
// trust basis). git이 디스크 정본이라 캐시·영속 상태가 없다: 데몬 재시작·앱
// 재시작 무영향, 매 호출이 fresh `git worktree ...` 실행.
//
// 안전 계약:
//  - add: 브랜치명은 validateGitRef(플래그 주입·traversal·제어문자 차단),
//    경로는 명시 인자 없이 관례 위치(<repo부모>/<repo이름>-worktrees/<branch>)로
//    핸들러가 도출한다 — 렌더러가 임의 디스크 경로를 지정할 수 없다.
//  - remove: `git worktree remove` 그대로 — dirty 워크트리는 git 자신이 거부하고
//    그 stderr를 사용자에게 표면화한다. --force는 v1 미제공(careful 원칙).
//  - 모든 실패는 { ok:false, error }로 강등(fail-soft 표시 표면).
import { ipcMain } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { git } from '../../git/git';
import { resolveAccessiblePath } from './fs.handler';
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

/** worktree list 행 — 재시작 복구용 MERGING 파생 필드(디스크에서 계산). */
export interface WorktreeRow extends WorktreeEntry {
  /** MERGE_HEAD 존재 여부(진행 중 머지). */
  merging?: boolean;
  /** 우리 소유 격리 integration 워크트리 여부(경로 접두 인식). */
  integration?: boolean;
  /** 미해결 충돌 파일 수(merging일 때만 의미). */
  conflicts?: number;
}

export type WorktreeListResult =
  | {
      ok: true;
      /** 호출 컨텍스트의 worktree toplevel(현재 워크트리 — GUI의 "현재" dot 기준). */
      repoPath: string;
      /** 본(main) 워크트리 경로 — porcelain 첫 블록(git 계약: main이 항상 먼저). */
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

// repo 단위 뮤텍스 — diff.handler.withRepoLock과 동형 복제(additive 원칙:
// 그쪽 인스턴스는 diff 채택 직렬화 전용이라 큐를 공유하지 않는다).
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

// cwd(서브디렉토리 가능) → 자기 worktree toplevel. 비-git이면 null.
// F2 (#615): every worktree entry point funnels through here, so confine the
// renderer-supplied path against the shared sensitive-path blocklist before it
// reaches `git -C <path>`. Closes the gap where an unconfined repoPath ran git
// inside e.g. ~/.ssh. resolveAccessiblePath also canonicalizes via realpath.
async function resolveToplevel(cwd: string): Promise<string | null> {
  const safe = await resolveAccessiblePath(cwd);
  if (!safe) return null;
  const r = await git(['rev-parse', '--show-toplevel'], safe);
  const top = r.code === 0 ? r.stdout.trim() : '';
  return top || null;
}

// 경로 정규화 — 파일시스템 대소문자 정책 반영(Codex P2). Windows/macOS는
// case-insensitive라 lowercase, POSIX(case-sensitive)는 원형 유지: 그래야
// `/repo/Foo`와 `/repo/foo`가 서로 다른 워크트리로 올바로 구분된다.
function normPath(p: string): string {
  const trimmed = resolve(p).replace(/[/\\]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
}

// 본 워크트리(main) = `git worktree list --porcelain` 첫 블록(git 계약).
// cwd가 linked worktree여도 여기서 본 repo를 얻는다.
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
  // 재시작 복구: 각 워크트리의 MERGING 상태를 디스크에서 파생해 붙인다(병렬).
  // 앱 재시작으로 in-memory 세션이 유실돼도 UI가 integration 워크트리를
  // 인식해 Land/Discard를 제시할 수 있게 하는 정본은 git 디스크 상태다.
  const worktrees: WorktreeRow[] = await Promise.all(
    parsed.map(async (e) => {
      const integration = isIntegrationPath(e.path);
      const ms = existsSync(e.path) ? await readMergeState(e.path) : { merging: false, conflicts: 0 };
      return { ...e, merging: ms.merging, integration, conflicts: ms.conflicts };
    }),
  );
  // dogfood가 잡은 실버그: top은 "호출한 워크트리"의 toplevel이지 본 repo가
  // 아니다(linked worktree에서 열면 자기 자신). 본 워크트리는 porcelain 첫
  // 블록이 계약이므로 그걸로 mainPath를 분리해 내려준다.
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
  // 경로 도출 기준 = 본(main) 워크트리(Codex P2). linked worktree에서 열면
  // top이 그 worktree 자신이라 `<linked>-worktrees`가 되던 버그를 막는다.
  const mainWt = await resolveMainWorktree(top);
  return withRepoLock(normPath(mainWt), async () => {
    // 관례 위치: <main부모>/<main이름>-worktrees/<branch-dir>. 오너의 실사용
    // 관례(D:\wmux-worktrees\*)와 동형 — repo 안이 아니라 형제 디렉토리라
    // 워크트리가 자기 repo의 untracked 노이즈가 되지 않는다.
    const parent = join(dirname(mainWt), `${basename(mainWt)}-worktrees`);
    const wtPath = resolve(parent, branchToDirName(safeBranch));
    if (existsSync(wtPath)) {
      return { ok: false, error: `path already exists: ${wtPath}` };
    }
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    // 브랜치 해석 3분기(Codex P2 — remote-only 브랜치 보존):
    //  ① 로컬 브랜치 존재 → 체크아웃.
    //  ② 아니면 --guess-remote 시도 → origin/<branch>가 있으면 그걸 추적하는
    //     로컬 브랜치를 만든다(강제 -b가 remote를 무시하고 새 브랜치를 만드는
    //     것 방지). remote 매칭이 없으면 실패.
    //  ③ ②가 실패하면 -b로 HEAD에서 새 브랜치 생성.
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
  // 렌더러가 넘기는 경로는 직전 list 결과에서 온 값이지만, 신뢰하지 않고
  // 실제 워크트리 목록에 있는 경로인지 재검증한다(임의 경로 인자 차단).
  const listed = await git(['worktree', 'list', '--porcelain'], top);
  if (listed.code !== 0) return { ok: false, error: listed.stderr.slice(0, 300) };
  const entries = parseWorktreePorcelain(listed.stdout);
  const target = entries.find((e) => normPath(e.path) === normPath(worktreePath));
  if (!target) return { ok: false, error: 'not a listed worktree of this repository' };
  // 본 워크트리(porcelain 첫 블록) 제거 거부.
  const mainPath = entries[0]?.path ?? top;
  if (normPath(target.path) === normPath(mainPath)) {
    return { ok: false, error: 'cannot remove the main worktree' };
  }
  // 활성(호출 컨텍스트) 워크트리 제거 거부(Codex P2): git은 clean 워크트리를
  // 그 자신의 cwd에서도 제거해준다 — 사용자가 지금 서 있는 워크트리를 지워
  // pane cwd가 사라지는 상황을 막는다. top = 활성 pane의 toplevel.
  if (normPath(target.path) === normPath(top)) {
    return { ok: false, error: 'cannot remove the worktree you are currently in' };
  }
  // 락 키를 base(본 워크트리)로 통일 — 기존 버그: add는 normPath(mainWt), remove는
  // normPath(top)을 써서 같은 repo의 add/remove가 서로 직렬화되지 않았다(키 불일치).
  // merge 세션까지 같은 base 키를 공유해야 repo-wide 뮤텍스가 성립한다.
  const mainWt = entries[0]?.path ?? top;
  return withRepoLock(normPath(mainWt), async () => {
    // --force 없음: dirty/잠김 워크트리는 git이 거부하며 그 사유를 그대로 표면화.
    const r = await git(['worktree', 'remove', target.path], top);
    if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
    return { ok: true, worktreePath: target.path };
  });
}

// ── 머지 세션 ────────────────────────────────────────────────────────────────
//
// 격리 integration 워크트리에서 git-native 머지 → verify 게이트 → Land/Discard.
// 세션은 base 키(본 워크트리)당 최대 1개(동시 start 거부). 정본은 git 디스크
// 상태(MERGE_HEAD)라 앱 재시작 후 status가 디스크에서 세션을 복구한다.

/** 세션 내부 상태(공개 status + 재검증용 OID·verify 취소 핸들). */
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

// repoKey(normPath(mainWt)) → 세션. add/remove와 같은 base 키를 공유한다.
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

// clean 머지 후 verify를 락 밖에서 비동기 실행 — 세션 phase를 갱신한다. 세션이
// 그 사이 Discard로 교체/삭제됐으면 결과를 버린다(stale 방지).
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
      s.verify = { ok: false, output: 'verify 실행 오류' };
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
    if (mergeSessions.has(repoKey)) return { ok: false, error: '이미 진행 중인 머지 세션이 있습니다' };
    // 디스크 재확인: 이전 세션의 integration 워크트리가 MERGING으로 남아있으면 거부.
    for (const e of entries) {
      if (isIntegrationPath(e.path) && existsSync(e.path)) {
        const ms = await readMergeState(e.path);
        if (ms.merging) return { ok: false, error: '이전 머지가 정리되지 않았습니다 — 먼저 Land/Discard 하세요' };
      }
    }
    // base 명시 해결(worktree[0] HEAD 아님) → 그 브랜치가 체크아웃된 워크트리 탐색.
    const base = await resolveBaseBranch(mainWt);
    if (!base) return { ok: false, error: 'base 브랜치를 확인할 수 없습니다(gh/origin/main·master 모두 실패)' };
    const baseEntry = entries.find((e) => e.branch === base);
    if (!baseEntry) return { ok: false, error: `base 브랜치(${base})가 어떤 워크트리에도 체크아웃되어 있지 않습니다 — clean 상태로 체크아웃하세요` };
    const baseCheckoutPath = baseEntry.path;
    const pre = await checkTargetPreconditions(baseCheckoutPath, base);
    if (!pre.ok) return { ok: false, error: pre.error };

    // source 워크트리 → 캡처 OID(움직이는 브랜치명 아님) + 브랜치명(있으면).
    const sourceTop = await resolveToplevel(sourcePath);
    if (!sourceTop) return { ok: false, error: 'source가 git 워크트리가 아닙니다' };
    // Re-validate against this repo's worktree list (like removeWorktree) — the
    // renderer must not be able to inject an arbitrary git repo path as source.
    const srcEntry = entries.find((e) => normPath(e.path) === normPath(sourceTop));
    if (!srcEntry) return { ok: false, error: 'source가 이 repo의 워크트리가 아닙니다' };
    const sourceBranch = srcEntry.branch ?? null;
    // Refuse a dirty source: only the committed HEAD is merged, so uncommitted or
    // untracked work would be silently dropped (especially risky in AI worktrees).
    const srcStatus = await git(['status', '--porcelain'], sourceTop);
    if (srcStatus.code !== 0) return { ok: false, error: srcStatus.stderr.slice(0, 300) };
    if (srcStatus.stdout.trim() !== '') {
      return { ok: false, error: 'source 워크트리에 커밋되지 않은 변경이 있습니다 — 먼저 커밋하세요' };
    }
    const srcHead = await git(['rev-parse', 'HEAD'], sourceTop);
    if (srcHead.code !== 0) return { ok: false, error: 'source HEAD 확인 실패' };
    const sourceOid = srcHead.stdout.trim();
    const baseHead = await git(['rev-parse', 'HEAD'], baseCheckoutPath);
    if (baseHead.code !== 0) return { ok: false, error: 'base HEAD 확인 실패' };
    const baseOid = baseHead.stdout.trim();

    // 격리 integration 워크트리 생성 → 캡처 source OID를 --no-commit --no-ff 머지.
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
      return { ok: false, error: '이미 최신입니다 — 머지할 변경이 없습니다' };
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
      // 충돌이면 conflicted에서 정지(B-MVP: 수동 진입). clean(변경 있음)이면 verify로.
      // (변경 0건 clean = no-op은 위에서 이미 거부됐다.)
      phase: outcome.phase === 'conflicted' ? 'conflicted' : 'verifying',
      conflicts: outcome.conflicts,
      changedFiles: outcome.changedFiles,
    };
    mergeSessions.set(repoKey, session);
    if (session.phase === 'verifying') kickVerify(session);
    return { ok: true, status: toStatus(session) };
  });
}

// 앱 재시작 후 in-memory 세션 유실 시, integration 워크트리의 MERGING 상태에서
// 세션을 재구성한다(정본=디스크). base/OID는 integration의 HEAD/MERGE_HEAD와
// base 재해결로 전부 파생 가능. clean이면 verify를 재실행한다.
async function recoverSession(ctx: MergeCtx): Promise<MergeSessionState | null> {
  const { mainWt, repoKey, entries } = ctx;
  const intEntry = entries.find((e) => isIntegrationPath(e.path) && existsSync(e.path));
  if (!intEntry) return null;
  const ms = await readMergeState(intEntry.path);
  if (!ms.merging) return null;
  const headR = await git(['rev-parse', 'HEAD'], intEntry.path); // 커밋 전이라 base OID.
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
    if (!s) return { ok: false, error: '진행 중인 머지 세션이 없습니다' };
    if (s.phase !== 'verified') return { ok: false, error: 'verify가 통과된 상태(verified)에서만 Land할 수 있습니다' };
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
    // 세션이 없어도 디스크의 integration 워크트리를 정리(재시작 후 Discard 등).
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
