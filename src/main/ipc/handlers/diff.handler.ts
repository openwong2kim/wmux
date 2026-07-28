// J2 — diff:read / diff:applyHunks main 핸들러 (스펙 §2·§3)
//
// diff:read: 태스크 worktree cwd에서 워킹트리 대조 diff를 읽어 파싱·numstat·
//   untracked 합성·타겟 스냅샷을 동봉해 반환(§2).
// diff:applyHunks: 스냅샷 드리프트 게이트 → dirty 거부 → per-hunk 프로브 →
//   선택 hunk 단일 패치 all-or-nothing apply(§3). 타겟 repo 단위 뮤텍스.
//   A source integrity gate runs between the drift gate and the dirty gate:
//   the selection is pinned to the read it was made against by per-file
//   fingerprint, so an adoption can only ever apply the diff the user saw
//   (plans/apply-hunks-toctou-design.md).
import { ipcMain } from 'electron';
import { readFile, lstat } from 'node:fs/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, isAbsolute, normalize, dirname } from 'node:path';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { git } from '../../git/git';
import { resolveAccessiblePath } from './fs.handler';
import {
  parseUnifiedDiff,
  reassemblePatch,
  synthesizeNewFileDiff,
  fileFingerprintInput,
  DIFF_TOTAL_CAP_BYTES,
  DIFF_FILE_CAP_BYTES,
  type DiffFile,
  type DiffReadFile,
  type DiffReadResult,
  type DiffReadError,
  type DiffNumstat,
  type DiffTargetSnapshot,
  type DiffApplyRequest,
  type DiffApplyResult,
  type HunkProbe,
} from '../../../shared/diffParse';

// git 실행 헬퍼는 main/git/git.ts로 승격 추출됨(동작 무변경) — worktree
// 핸들러와 공유. throw 대신 stdout/stderr/code 반환 계약은 그대로다.

// 타겟 repo 단위 직렬 큐(§3 R15 — J1 per-repo 뮤텍스 패턴 재사용).
// key = 타겟 repo 경로. J1 TaskWorktreeManager.withRepoLock과 동형이나
// 그 인스턴스는 FanOutService 내부라 additive 원칙상 동일 패턴을 복제.
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

// 워크트리 cwd → 본 repo 경로. 실패 시 null.
// F9: 취약한 문자열 조작 폴백(`.git` 접미 정규식 제거)을 폐기하고 git에 직접 물어본다.
//   common-dir(`<repo>/.git`)의 상위 디렉토리에서 `rev-parse --show-toplevel`을
//   실행하면 본 repo 루트를 정확히 얻는다(worktree cwd에서 직접 --show-toplevel은
//   worktree 자신을 반환하므로 타겟=본 repo 계약과 어긋난다 — 상위에서 실행).
async function resolveTargetRepo(worktreePath: string): Promise<string | null> {
  const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath);
  if (r.code !== 0) return null;
  const commonDir = r.stdout.trim();
  if (!commonDir) return null;
  // common-dir의 상위(`<repo>/.git` → `<repo>`)를 work tree로 삼아 toplevel을 도출.
  const top = await git(['-C', dirname(commonDir), 'rev-parse', '--show-toplevel'], worktreePath);
  if (top.code !== 0 || !top.stdout.trim()) return null;
  return top.stdout.trim();
}

// `git status --porcelain -z`의 NUL 구획 출력을 레코드 단위로 파싱한다(F1 — quotepath).
//   - 각 레코드: "XY <space>path\0". core.quotepath=false + -z로 공백·한글·따옴표
//     파일명도 원문 그대로(따옴표·8진 이스케이프 없음).
//   - rename/copy(X 또는 Y가 'R'/'C')는 "XY newpath\0oldpath\0" — 뒤따르는 NUL
//     필드가 oldpath라 한 레코드가 2필드를 소비한다. status/xy는 newpath 기준.
interface StatusEntry {
  readonly xy: string; // 2자 상태 코드(예: " M", "??", "R ").
  readonly path: string; // newpath(표시·매칭 대상).
  readonly origPath: string | null; // rename/copy의 oldpath. 그 외 null.
}
function parsePorcelainZ(raw: string): StatusEntry[] {
  const fields = raw.split('\0');
  const out: StatusEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const rec = fields[i];
    i += 1;
    // 마지막 NUL 뒤의 빈 꼬리 원소는 건너뜀.
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3); // "XY " 이후.
    // rename/copy는 다음 필드가 oldpath.
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

// 타겟 스냅샷 수집(§2 드리프트 게이트 재료).
async function collectSnapshot(targetRepoPath: string): Promise<DiffTargetSnapshot> {
  const [head, branch, status] = await Promise.all([
    git(['rev-parse', 'HEAD'], targetRepoPath),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], targetRepoPath),
    // F1: -z + quotepath=false로 특수문자 파일명을 원문 파싱. rename은 newpath만.
    git(['-c', 'core.quotepath=false', 'status', '--porcelain', '-z'], targetRepoPath),
  ]);
  const dirty: string[] = [];
  for (const e of parsePorcelainZ(status.stdout)) {
    // rename/copy는 newpath(e.path)를 dirty 대상으로. dirty 게이트는 채택 타겟
    // 경로 집합과 매칭되므로 표시 경로 기준.
    dirty.push(e.path);
  }
  return {
    targetRepoPath,
    targetBranch: branch.stdout.trim(),
    targetHeadOid: head.stdout.trim(),
    targetDirtyFiles: dirty,
  };
}

// numstat 파싱(파일 트리 표시용). binary는 "-\t-\tpath".
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

// Adoption fingerprint of a parsed file entry. Hashing lives here rather than in
// shared/ so the renderer bundle stays free of node:crypto — the renderer only
// ever echoes the digest back, never computes one.
function fileDigest(file: DiffFile): string {
  return createHash('sha256').update(fileFingerprintInput(file), 'utf8').digest('hex');
}

// git의 잘 알려진 empty tree 오브젝트 — 첫 커밋 전(HEAD 없음) repo의 diff base.
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// diff:read 구현.
//
// mode:
//  - 'task'(기본): J2 태스크 산출물 diff. worktree를 본 repo로 매핑
//    (resolveTargetRepo)한 뒤 merge-base 대조 — 태스크 브랜치의 산출물을
//    본 repo 기준으로 채택하기 위한 의미.
//  - 'workspace': 워크스페이스 diff. cwd repo/worktree 자신의 미커밋 변경만
//    (`git diff HEAD` + untracked). 본 repo로 매핑하지 않는다 — 그러면 linked
//    worktree의 브랜치 커밋 전체가 diff로 새어 나온다(Codex P2). 첫 커밋 전
//    repo는 HEAD가 없으므로 empty-tree 대비로 전 파일을 added로 보여준다.
async function readDiff(
  worktreePath: string,
  targetHeadOid: string,
  mode: 'task' | 'workspace' = 'task',
): Promise<DiffReadResult | DiffReadError> {
  // workspace 모드: 대상 repo = 자기 자신(cwd toplevel). resolveTargetRepo로
  // 본 repo 매핑을 하지 않는다.
  const targetRepoPath =
    mode === 'workspace'
      ? await (async () => {
          const r = await git(['rev-parse', '--show-toplevel'], worktreePath);
          return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
        })()
      : await resolveTargetRepo(worktreePath);
  if (!targetRepoPath) {
    return { ok: false, error: '타겟 repo를 찾을 수 없음(worktree 손상?)', code: 'no-repo' };
  }

  // F8: targetHeadOid 인자 가드 — 지정 시 SHA-1 hex(7~40자)만 허용.
  //   빈 문자열(미지정)은 아래에서 타겟 HEAD로 도출하므로 통과. 인자 주입을
  //   merge-base·git 명령에 그대로 넘기기 전에 형식을 명시 검증한다.
  if (targetHeadOid && !/^[0-9a-fA-F]{7,40}$/.test(targetHeadOid)) {
    return { ok: false, error: 'targetHeadOid 형식 오류(SHA hex 7~40자 아님)', code: 'bad-oid' };
  }

  let mergeBase: string;
  if (mode === 'workspace') {
    // 미커밋만: base = 자기 HEAD. 첫 커밋 전이면 empty-tree(전 파일 added).
    const h = await git(['rev-parse', 'HEAD'], targetRepoPath);
    mergeBase = h.code === 0 && h.stdout.trim() ? h.stdout.trim() : EMPTY_TREE_OID;
  } else {
    // targetHeadOid 미지정 시 타겟 repo의 현 HEAD를 사용(렌더러가 미리 알 필요 없음).
    let headOid = targetHeadOid;
    if (!headOid) {
      const h = await git(['rev-parse', 'HEAD'], targetRepoPath);
      headOid = h.code === 0 ? h.stdout.trim() : '';
    }
    // mergeBase = merge-base HEAD {targetHeadOid} — 단일 출처(§2 G8).
    const mb = await git(['merge-base', 'HEAD', headOid], worktreePath);
    mergeBase = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : headOid;
  }

  // 1-arg 워킹트리 대조(미커밋 포함). untracked 제외 — 별도 합성.
  // The patch has to come from git's own engine, whatever the user configured:
  //  - `diff.external` (difftastic and friends) replaces the output entirely,
  //    so parseUnifiedDiff sees zero files while --numstat below — which never
  //    consults it — still reports counts. The tree would show +/- against a
  //    file with no hunks at all, with nothing saying why.
  //  - textconv is on by default for `git diff` and rewrites the content, so
  //    the diff shown is one that cannot be applied to anything.
  // Both split what the user sees from what would be adopted. --numstat
  // deliberately gets neither flag: measured to be unaffected by both (a
  // line-doubling textconv driver still reports the raw counts).
  const diffRes = await git(['diff', '--no-ext-diff', '--no-textconv', mergeBase], worktreePath);
  if (diffRes.code !== 0) {
    return { ok: false, error: `git diff 실패: ${diffRes.stderr.slice(0, 200)}`, code: 'diff-fail' };
  }
  const numRes = await git(['diff', '--numstat', mergeBase], worktreePath);

  // untracked 수집 → 정식 new-file 헤더 합성(§2 R4).
  // F1: -z + quotepath=false로 특수문자 untracked 파일명을 원문 파싱.
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
      // F3: readFile 전 lstat — symlink는 follow하면 repo 밖 파일을 diff에 노출한다.
      // 정규 파일만 합성. symlink·FIFO·소켓·디바이스 등은 채택 불가("unsupported").
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
      // 바이너리 휴리스틱: NUL 바이트 존재.
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
      // 읽기 실패(레이스로 삭제 등) — 조용히 건너뜀.
    }
  }

  // 총량 캡(§2). 초과 시 파싱은 하되 큰 파일은 표시 전용 마킹.
  if (Buffer.byteLength(diffText, 'utf8') > DIFF_TOTAL_CAP_BYTES) {
    return {
      ok: false,
      error: 'diff 총량이 2MB를 초과 — 표시 전용(채택 불가). 커밋 단위를 좁혀 재열람.',
      code: 'too-large',
    };
  }

  const parsed = parseUnifiedDiff(diffText);
  // 파일당 캡 초과 파일을 truncated로(파싱은 유지하되 안내).
  const files: DiffReadFile[] = [];
  for (const f of parsed.files) {
    const size = f.headerBlock.length + f.hunks.reduce((s, h) => s + h.bodyLines.join('\n').length, 0);
    const isTruncated = size > DIFF_FILE_CAP_BYTES;
    if (isTruncated && !truncated.includes(f.path)) truncated.push(f.path);
    // F7: 캡 초과 파일은 hunkSelectable=false로 강등(applyHunks의 2중 거부와 짝).
    //   표시 diff는 잘리지 않았어도 재직렬화 신뢰 범위를 넘으므로 채택 대상에서 제외.
    const final = isTruncated && f.hunkSelectable ? { ...f, hunkSelectable: false } : f;
    // Fingerprint the entry as it is handed to the renderer — the demotion above
    // is part of what the user saw, so it has to be part of what we pin.
    files.push({ ...final, digest: fileDigest(final) });
  }

  const snapshot = await collectSnapshot(targetRepoPath);
  const numstat = [...parseNumstat(numRes.stdout), ...extraNumstat];

  return { ok: true, files, numstat, snapshot, truncated, unsupported };
}

// 패치 내부 경로 검증(§3 R16): a/ b/ 정규화 후 .. 거부·절대경로 거부.
function patchPathsSafe(patch: string): boolean {
  for (const line of patch.split('\n')) {
    let p: string | null = null;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      p = line.slice(4).split('\t')[0];
    } else if (line.startsWith('diff --git ')) {
      // "diff --git a/x b/y" — 두 경로 모두 검사.
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

// diff:applyHunks 구현.
async function applyHunks(req: DiffApplyRequest, worktreePath: string): Promise<DiffApplyResult> {
  const targetRepoPath = await resolveTargetRepo(worktreePath);
  if (!targetRepoPath) {
    return { ok: false, error: '타겟 repo를 찾을 수 없음', code: 'apply' };
  }

  return withRepoLock(targetRepoPath, async (): Promise<DiffApplyResult> => {
    // ① 드리프트 게이트(§2·§3): 스냅샷의 HEAD/브랜치가 현재와 일치해야 함.
    const cur = await collectSnapshot(targetRepoPath);
    if (
      cur.targetHeadOid !== req.snapshot.targetHeadOid ||
      cur.targetBranch !== req.snapshot.targetBranch
    ) {
      return { ok: false, error: '타겟이 이동됨 — diff 재열람 필요', code: 'drift' };
    }

    // 선택 파일의 diff를 재계산(태스크 worktree 기준). read와 동일 소스.
    const read = await readDiff(worktreePath, req.snapshot.targetHeadOid);
    if (!read.ok) return { ok: false, error: read.error, code: 'apply' };

    // ①′ Source integrity gate: an adoption may only apply the diff the user
    //     actually saw. The selection was made against a read that happened
    //     before this one, so every entry is matched back to the fresh read by
    //     path *and* by adoption fingerprint, and every hunk index is checked to
    //     still exist. A selected path that vanished or a hunk index that no
    //     longer resolves is a rejection reason, never a silent skip — dropping
    //     either one would apply a subset of what the user ticked. All reasons
    //     are collected so the message can name every one of them, and any
    //     single one rejects the whole request (no partial adoption).
    const freshByPath = new Map<string, DiffReadFile>();
    for (const f of read.files) freshByPath.set(f.path, f);
    const staleReasons: string[] = [];
    const staleProbes: HunkProbe[] = [];
    const selMap = new Map<string, readonly number[]>();
    for (const s of req.selections) {
      const idxs = Array.isArray(s.hunkIndices) ? s.hunkIndices : [];
      // Mark every hunk the user picked for this path, so the panel can show
      // exactly which selections were refused.
      const flag = (): void => {
        for (const i of idxs) {
          staleProbes.push({
            path: s.path,
            hunkIndex: i,
            applicable: false,
            alreadyApplied: false,
          });
        }
      };
      if (selMap.has(s.path)) {
        staleReasons.push(`${s.path}: selected twice in one request`);
        flag();
        continue;
      }
      if (idxs.length === 0) {
        staleReasons.push(`${s.path}: no hunks selected`);
        continue;
      }
      if (new Set(idxs).size !== idxs.length) {
        staleReasons.push(`${s.path}: the same hunk is selected twice`);
        flag();
        continue;
      }
      const fresh = freshByPath.get(s.path);
      if (!fresh) {
        staleReasons.push(`${s.path}: no longer in this diff`);
        flag();
        continue;
      }
      if (typeof s.digest !== 'string' || s.digest.length === 0) {
        staleReasons.push(`${s.path}: selection carries no source fingerprint`);
        flag();
        continue;
      }
      if (s.digest !== fresh.digest) {
        staleReasons.push(`${s.path}: changed since you reviewed it`);
        flag();
        continue;
      }
      const gone = idxs.filter(
        (i) => !Number.isInteger(i) || i < 0 || i >= fresh.hunks.length,
      );
      if (gone.length > 0) {
        staleReasons.push(`${s.path}: hunk ${gone.join(', ')} no longer exists`);
        flag();
        continue;
      }
      selMap.set(s.path, idxs);
    }
    if (staleReasons.length > 0) {
      return {
        ok: false,
        error:
          'Adoption rejected — the selection no longer matches the diff you reviewed: ' +
          `${staleReasons.join('; ')}. Reload the diff and reselect.`,
        code: 'stale',
        failedProbes: staleProbes,
      };
    }

    // 선택 파일 매핑 + 채택 가능성 검증.
    const selectedFiles: Array<{ file: DiffFile; hunkIndices: readonly number[] }> = [];
    const truncatedSet = new Set(read.truncated);
    for (const f of read.files) {
      const idxs = selMap.get(f.path);
      if (!idxs) continue;
      // F7 2중 거부: 캡 초과(truncated) 파일은 hunkSelectable=false로도 걸리지만,
      // truncated 집합으로 명시 거부해 재직렬화 신뢰 범위를 넘는 채택을 이중 차단.
      if (truncatedSet.has(f.path)) {
        return {
          ok: false,
          error: `${f.path}: 캡 초과로 표시 전용 — 채택 불가`,
          code: 'unsupported',
        };
      }
      if (!f.hunkSelectable) {
        return {
          ok: false,
          error: `${f.path}: rename·binary·mode 변경은 채택 불가`,
          code: 'unsupported',
        };
      }
      selectedFiles.push({ file: f, hunkIndices: idxs });
    }
    if (selectedFiles.length === 0) {
      return { ok: false, error: '선택된 hunk 없음', code: 'apply' };
    }

    // ② dirty 거부(§3): 대상 파일이 현재 dirty면 거부.
    const dirtySet = new Set(cur.targetDirtyFiles);
    for (const sf of selectedFiles) {
      if (dirtySet.has(sf.file.path)) {
        return {
          ok: false,
          error: `${sf.file.path}: 타겟에 미커밋 변경 있음 — 충돌 방지로 거부`,
          code: 'dirty',
        };
      }
    }

    const patch = reassemblePatch(selectedFiles);
    if (!patchPathsSafe(patch)) {
      return { ok: false, error: '패치 내부 경로 검증 실패(.. 또는 절대경로)', code: 'path' };
    }

    // ③ 프로브(§3, F2 재정의): per-hunk 개별 프로브는 UI 힌트 전용이고,
    //    적용 게이트는 "선택 hunk 결합 패치 1회 --check"로 분리한다.
    //    - 개별 --check는 의존 hunk(앞 hunk가 있어야 뒤 hunk가 붙는 경우)를
    //      false-negative로 오판하므로 게이트로 쓰지 않는다.
    //    - alreadyApplied(--reverse --check 성공) hunk는 게이트 전에 명시 실패로
    //      반환한다: 결합 apply가 전체 거부될 때 "이미 적용된 hunk가 원인"임을
    //      은닉하지 않고, 사용자에게 해당 hunk 선택 해제를 유도한다.
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

      // alreadyApplied hunk는 게이트 통과 전 명시 실패(선택 해제 유도).
      const already = probes.filter((p) => p.alreadyApplied);
      if (already.length > 0) {
        return {
          ok: false,
          error: '일부 hunk가 타겟에 이미 적용됨 — 해당 hunk를 선택 해제 후 재시도',
          code: 'probe',
          failedProbes: already,
        };
      }

      // 적용 게이트: 선택 hunk 결합 패치 1회 --check(의존 hunk 통과, all-or-nothing).
      const patchPath = join(dir, 'apply.diff');
      await writeFile(patchPath, patch);
      const gate = await git(['apply', '--check', patchPath], targetRepoPath);
      if (gate.code !== 0) {
        // 결합 --check 실패: 개별 프로브에서 applicable=false인 hunk를 UI 힌트로
        // 동봉(어느 hunk가 문제인지 사용자에게 표시). 힌트가 없으면(전부 개별로는
        // 붙는데 결합에서만 실패) 전체 실패만 보고.
        const notApplicable = probes.filter((p) => !p.applicable);
        return {
          ok: false,
          error: `선택 hunk 결합 적용 불가(타겟 미변경): ${gate.stderr.slice(0, 200)}`,
          code: 'probe',
          failedProbes: notApplicable.length > 0 ? notApplicable : probes,
        };
      }

      // ④ 단일 패치 all-or-nothing apply(§3). --unsafe-paths 금지.
      const applied = await git(['apply', patchPath], targetRepoPath);
      if (applied.code !== 0) {
        return {
          ok: false,
          error: `git apply 실패(타겟 미변경): ${applied.stderr.slice(0, 200)}`,
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
          return { ok: false, error: 'worktreePath 필요', code: 'bad-args' };
        }
        // F2 (#615): confine the renderer path before it reaches `git -C`.
        const safeWt = await resolveAccessiblePath(worktreePath);
        if (!safeWt) return { ok: false, error: 'worktreePath 필요', code: 'bad-args' };
        // targetHeadOid는 선택 — 미지정 시 타겟 repo HEAD로 도출.
        const head = typeof targetHeadOid === 'string' ? targetHeadOid : '';
        // mode 미지정/오값은 'task'(기존 계약). 'workspace'만 명시 분기.
        return readDiff(safeWt, head, mode === 'workspace' ? 'workspace' : 'task');
      },
    ),
  );

  // 워크스페이스 diff 진입점 — cwd(서브디렉토리 가능)를 자기 worktree toplevel로
  // 정규화한다. diff:read의 worktreePath 계약(untracked 합성이 repo-root 상대경로를
  // join)이 toplevel을 전제하므로, 렌더러는 이 결과를 diffRepoPath로 영속한다.
  // linked worktree cwd면 그 worktree의 toplevel을 반환한다(본 repo 아님 —
  // 이후 diff:read의 resolveTargetRepo가 본 repo 대조를 알아서 수행).
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
        // F2 (#615): confine the renderer path before it reaches `git -C`.
        const safeCwd = await resolveAccessiblePath(cwd);
        if (!safeCwd) return { ok: false };
        const r = await git(['rev-parse', '--show-toplevel'], safeCwd);
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
          return { ok: false, error: 'worktreePath 필요', code: 'apply' };
        }
        // F2 (#615): confine the renderer path before git/file writes touch it.
        const safeWt = await resolveAccessiblePath(worktreePath);
        if (!safeWt) return { ok: false, error: 'worktreePath 필요', code: 'apply' };
        const r = req as DiffApplyRequest;
        if (!r || !r.snapshot || !Array.isArray(r.selections)) {
          return { ok: false, error: 'applyHunks 요청 형식 오류', code: 'apply' };
        }
        return applyHunks(r, safeWt);
      },
    ),
  );

  return () => {
    ipcMain.removeHandler(IPC.DIFF_READ);
    ipcMain.removeHandler(IPC.DIFF_RESOLVE_REPO);
    ipcMain.removeHandler(IPC.DIFF_APPLY_HUNKS);
  };
}
