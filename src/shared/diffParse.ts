// J2 — diff·hunk 채택: 원문 보존 파서 (스펙 §3)
//
// 설계 계약(피해야 할 급소 — 스펙 §3·§7·§10 R1/R11):
//   - 파일 헤더 블록(diff --git / index / mode / --- / +++)과 hunk 바디를
//     "바이트 원문"으로 보존한다. lossy 재구성 금지.
//   - 선택 hunk 재조립 시: 원본 파일 헤더를 그대로 재부착하고,
//     hunk 헤더의 라인카운트(@@ -a,b +c,d @@)만 재계산한다.
//   - `\ No newline at end of file` 마커·CRLF는 바디 원문 보존으로 자동 통과.
//   - 이 파서는 스스로를 신뢰하지 않는다 — 재직렬화 결과는 실제 `git apply`로
//     검증(왕복 오라클 테스트, R11). 파서 자기합의 금지.
//
// v1 채택 지원 범위: 평문 modify/add/delete만.
//   rename·copy·mode change·binary는 표시 전용(파일 단위 채택 불가 라벨).

// diff 총량·파일당 캡 (스펙 §2). 초과 시 표시 전용 라벨.
export const DIFF_TOTAL_CAP_BYTES = 2 * 1024 * 1024; // 2MB
export const DIFF_FILE_CAP_BYTES = 512 * 1024; // 512KB

// 파싱된 단일 hunk. body는 hunk 헤더(@@ 라인) 이후의 원문 바디를 그대로 보존한다.
export interface DiffHunk {
  // hunk 헤더 라인 전체 원문(예: "@@ -1,3 +1,4 @@ func foo()"). 개행 미포함.
  readonly header: string;
  // 헤더에서 파싱한 좌표(재계산·검증용).
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  // hunk 헤더 뒤 붙는 트레일링 텍스트(함수 컨텍스트 등). "@@ ... @@" 뒤 부분.
  readonly section: string;
  // hunk 바디 원문(각 라인은 ' '/'+'/'-'/'\' 접두). 바이트 원문 보존.
  // 배열 각 원소는 개행을 포함하지 않은 라인. 재직렬화 시 '\n'으로 결합.
  readonly bodyLines: readonly string[];
}

// 파일 단위 채택 가능성 분류.
export type FileChangeKind =
  | 'modify'
  | 'add'
  | 'delete'
  | 'rename'
  | 'copy'
  | 'mode'
  | 'binary';

// 파싱된 단일 파일 diff.
export interface DiffFile {
  // 표시·매칭용 경로(b/ 측 우선, delete면 a/ 측).
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly kind: FileChangeKind;
  // hunk 선택 채택 가능 여부. 평문 modify/add/delete만 true.
  readonly hunkSelectable: boolean;
  // 파일 헤더 블록 원문(diff --git ~ +++ 라인까지, 첫 hunk 헤더 직전). 개행 포함.
  readonly headerBlock: string;
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  readonly files: readonly DiffFile[];
}

// A parsed file annotated with its adoption fingerprint. `diff:read` returns
// these; `diff:applyHunks` recomputes the fingerprint from a fresh read and
// refuses to adopt anything whose fingerprint moved (see fileFingerprintInput).
export interface DiffReadFile extends DiffFile {
  readonly digest: string;
}

// Canonical serialization behind a file's adoption fingerprint.
//
// It covers exactly what decides the patch bytes reassembled from this entry —
// the header block and every hunk's header + body — plus the identity and
// adoptability class the user saw. Every hunk is included, not only the
// selected ones, because a selection is a positional index into this list.
//
// Fields are length-delimited so two different file entries cannot serialize
// alike, and the leading tag versions the format: change the covered fields and
// bump the tag, so old fingerprints compare unequal instead of comparing wrong.
export function fileFingerprintInput(file: DiffFile): string {
  const parts: string[] = [
    'wmux-diff-file-v1',
    file.path,
    file.kind,
    file.hunkSelectable ? 'sel' : 'nosel',
    file.headerBlock,
    String(file.hunks.length),
  ];
  for (const h of file.hunks) {
    parts.push(h.header);
    parts.push(String(h.bodyLines.length));
    for (const bl of h.bodyLines) parts.push(bl);
  }
  return parts.map((p) => `${p.length}:${p}`).join('\n');
}

// ── diff:read / diff:applyHunks RPC 계약 (main↔renderer 공유, 스펙 §2·§3) ──

// 타겟 repo 스냅샷(드리프트 게이트용, §2). applyHunks가 이를 되받아 재검증한다.
export interface DiffTargetSnapshot {
  readonly targetRepoPath: string;
  readonly targetBranch: string;
  readonly targetHeadOid: string;
  readonly targetDirtyFiles: readonly string[];
}

// diff:read 응답. files는 파싱된 diff, snapshot은 드리프트 게이트 재료.
export interface DiffReadResult {
  readonly ok: true;
  readonly files: readonly DiffReadFile[];
  readonly numstat: readonly DiffNumstat[];
  readonly snapshot: DiffTargetSnapshot;
  // 캡 초과·binary 등으로 표시 전용인 파일 경로 목록(사용자 안내용).
  readonly truncated: readonly string[];
  // F3: symlink·FIFO 등 비정규 파일 — 합성·채택 불가("unsupported" 라벨).
  //   repo 밖 노출(symlink 타겟 readFile) 차단을 위해 아예 합성에서 제외한다.
  readonly unsupported: readonly string[];
}

export interface DiffReadError {
  readonly ok: false;
  readonly error: string;
  readonly code?: string;
}

// numstat 한 줄(파일 트리 표시용). binary는 additions/deletions = null.
export interface DiffNumstat {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

// diff:applyHunks 요청. 스냅샷을 되받아 드리프트 재검증(§3).
export interface DiffApplyRequest {
  readonly taskId: string;
  readonly snapshot: DiffTargetSnapshot;
  readonly selections: ReadonlyArray<{
    readonly path: string; // 표시 경로(repo-relative).
    readonly hunkIndices: readonly number[];
    // Adoption fingerprint of the file entry these indices were picked from
    // (DiffReadFile.digest, echoed verbatim). The handler re-reads the source
    // diff at apply time and rejects the whole request unless this still
    // matches — an adoption may only apply the diff the user actually saw.
    readonly digest: string;
  }>;
}

// A selection the handler refused *without* probing it. It names which hunk was
// refused and nothing else — carrying HunkProbe here would state applicability
// that was never measured.
export interface SelectionRef {
  readonly path: string;
  readonly hunkIndex: number;
}

// per-hunk 프로브 결과(§3). applied는 --reverse --check best-effort 뱃지.
export interface HunkProbe {
  readonly path: string;
  readonly hunkIndex: number;
  readonly applicable: boolean; // git apply --check 성공
  readonly alreadyApplied: boolean; // git apply --reverse --check 성공(best-effort)
}

export type DiffApplyResult =
  | { readonly ok: true; readonly appliedFiles: readonly string[] }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code:
        | 'drift' // 타겟 HEAD/브랜치 이동
        // The source diff moved: a selected file changed, left the diff, or the
        // selection points at hunks it no longer has. Distinct from 'drift',
        // which is about the target — the remedy here is reload + reselect.
        | 'stale'
        // The request itself is malformed: it carries a selection no diff read
        // could have produced (a missing fingerprint, a path or hunk listed
        // twice, a path with no hunks). That is a caller defect, not user-side
        // drift, so it is never reported as staleness — reloading cannot fix it.
        | 'malformed'
        | 'dirty' // 대상 파일 dirty
        | 'probe' // per-hunk 프로브 실패(failedProbes에 특정)
        | 'apply' // 최종 apply 실패
        | 'path' // 경로 검증 실패(.. 등)
        | 'unsupported'; // rename·binary 등 채택 불가
      // Measured per-hunk probe results. Only ever set for 'probe' — a refusal
      // that never ran a probe must not fill this in.
      readonly failedProbes?: readonly HunkProbe[];
      // Selections refused by the source integrity gate ('stale'). Unprobed, so
      // it says which selections were refused and claims nothing about whether
      // they would apply.
      readonly staleSelections?: readonly SelectionRef[];
    };

// hunk 헤더 파싱 정규식. "@@ -a,b +c,d @@" 또는 "@@ -a +c @@"(단일 라인).
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// unified diff 텍스트를 파일·hunk 단위로 파싱한다. 원문 보존.
export function parseUnifiedDiff(text: string): ParsedDiff {
  // 입력 개행을 보존하기 위해 '\n' 기준으로 쪼갠다. 각 라인의 '\n'은 재직렬화 때 복원.
  // CRLF는 라인 내용에 '\r'로 남아 원문 보존된다.
  const lines = text.length === 0 ? [] : text.split('\n');
  const files: DiffFile[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('diff --git')) {
      i += 1;
      continue;
    }

    // 파일 헤더 블록 수집: "diff --git" 부터 첫 "@@" hunk 헤더 직전 또는 다음
    // "diff --git" 직전까지.
    const headerStart = i;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let kind: FileChangeKind = 'modify';
    let isBinary = false;
    let isRename = false;
    let isCopy = false;
    let isModeOnly = true; // hunk나 ---/+++ 를 만나기 전까지는 mode-only 후보

    i += 1;
    while (i < lines.length) {
      const h = lines[i];
      if (h.startsWith('diff --git') || h.startsWith('@@ ')) break;
      if (h.startsWith('--- ')) {
        oldPath = parseHeaderPath(h.slice(4));
        isModeOnly = false;
      } else if (h.startsWith('+++ ')) {
        newPath = parseHeaderPath(h.slice(4));
        isModeOnly = false;
      } else if (h.startsWith('new file mode')) {
        kind = 'add';
      } else if (h.startsWith('deleted file mode')) {
        kind = 'delete';
      } else if (h.startsWith('rename from') || h.startsWith('rename to')) {
        isRename = true;
      } else if (h.startsWith('copy from') || h.startsWith('copy to')) {
        isCopy = true;
      } else if (h.startsWith('Binary files') || h.startsWith('GIT binary patch')) {
        isBinary = true;
        isModeOnly = false;
      } else if (h.startsWith('old mode') || h.startsWith('new mode')) {
        // mode change — isModeOnly 후보 유지
      }
      i += 1;
    }
    const headerEnd = i; // 첫 hunk 또는 다음 파일 시작

    // hunk 수집.
    const hunks: DiffHunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const hres = HUNK_HEADER_RE.exec(lines[i]);
      const headerLine = lines[i];
      i += 1;
      const bodyLines: string[] = [];
      // hunk 바디: 다음 hunk("@@ ") 또는 다음 파일("diff --git") 직전까지.
      // ' '/'+'/'-'/'\' 접두 라인만 바디. 그 외(빈 라인 포함) 판정은 아래.
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('@@ ') || b.startsWith('diff --git')) break;
        const c = b.charAt(0);
        if (c === ' ' || c === '+' || c === '-' || c === '\\') {
          bodyLines.push(b);
          i += 1;
        } else if (b === '') {
          // git diff의 빈 컨텍스트 라인은 ' '(공백 1자)로 나오므로 완전 빈 문자열은
          // split('\n')의 트레일링 원소다. F9: "마지막 원소일 때만" 종료로 한정한다 —
          // 중간의 빈 문자열(예: 다음 파일 헤더 앞 구분 공백)에서 hunk를 조기 종료하면
          // 뒤따르는 바디 라인을 유실할 수 있으므로, 마지막이 아니면 건너뛰고 계속.
          if (i === lines.length - 1) break;
          i += 1;
        } else {
          // 알 수 없는 라인(다음 섹션) — hunk 종료.
          break;
        }
      }

      const parsed = hres
        ? {
            oldStart: num(hres[1]),
            oldLines: hres[2] === undefined ? 1 : num(hres[2]),
            newStart: num(hres[3]),
            newLines: hres[4] === undefined ? 1 : num(hres[4]),
            section: hres[5] ?? '',
          }
        : { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, section: '' };

      hunks.push({
        header: headerLine,
        oldStart: parsed.oldStart,
        oldLines: parsed.oldLines,
        newStart: parsed.newStart,
        newLines: parsed.newLines,
        section: parsed.section,
        bodyLines,
      });
    }

    // 파일 헤더 블록 원문 재구성(원본 라인 그대로 + 개행).
    const headerBlock = lines.slice(headerStart, headerEnd).join('\n') + '\n';

    // 채택 가능성 분류.
    if (isBinary) kind = 'binary';
    else if (isRename) kind = 'rename';
    else if (isCopy) kind = 'copy';
    else if (kind === 'modify' && isModeOnly && hunks.length === 0) kind = 'mode';

    const hunkSelectable =
      (kind === 'modify' || kind === 'add' || kind === 'delete') && hunks.length > 0;

    // 표시 경로: a/ b/ 접두 제거(원문 oldPath/newPath는 접두 유지).
    // F4: delete는 newPath가 `/dev/null`이라 그대로 쓰면 dirty 게이트·numstat
    //   매칭이 실경로와 어긋난다(dirtySet.has('/dev/null')은 늘 false → delete
    //   파일이 타겟에서 dirty여도 거부 못 함). newPath가 /dev/null이면 oldPath를
    //   identity/display로 사용해 실경로가 dirty 검사 대상에 포함되게 한다.
    const rawDisplay =
      newPath && newPath !== '/dev/null' ? newPath : (oldPath ?? newPath ?? '(unknown)');
    const displayPath = stripDiffPrefix(rawDisplay);
    files.push({
      path: displayPath,
      oldPath,
      newPath,
      kind,
      hunkSelectable,
      headerBlock,
      hunks,
    });
  }

  return { files };
}

// 선택된 hunk들로 단일 파일의 패치를 재조립한다.
//   - 원본 파일 헤더 블록을 그대로 재부착.
//   - 각 선택 hunk의 바디는 원문 보존.
//   - hunk 헤더의 라인카운트만 바디에서 재계산(oldStart는 원본 좌표 유지 —
//     unified diff의 old 좌표는 원본 파일 기준이라 다른 hunk 적용 여부와 무관, §3).
//   - newStart는 이전 선택 hunk들의 (added-deleted) 누적 델타로 보정.
//
// 반환: 이 파일에 대한 패치 텍스트(헤더 + 선택 hunk들). 선택 0개면 빈 문자열.
export function reassembleFile(file: DiffFile, selectedHunkIndices: readonly number[]): string {
  const selected = [...selectedHunkIndices].sort((a, b) => a - b);
  if (selected.length === 0) return '';

  let out = file.headerBlock;
  let newLineDelta = 0; // 앞선 선택 hunk들의 순 라인 증감 누적.

  for (const idx of selected) {
    const hunk = file.hunks[idx];
    if (!hunk) continue;

    // 바디에서 실제 old/new 라인 수를 재계산(원문 보존 검증).
    let oldCount = 0;
    let newCount = 0;
    for (const bl of hunk.bodyLines) {
      const c = bl.charAt(0);
      if (c === ' ') {
        oldCount += 1;
        newCount += 1;
      } else if (c === '-') {
        oldCount += 1;
      } else if (c === '+') {
        newCount += 1;
      }
      // '\'(No newline) 라인은 카운트에 미포함.
    }

    // old 좌표는 원본 파일 기준으로 불변. new 좌표는 앞선 선택분 델타로 보정.
    const oldStart = hunk.oldStart;
    const newStart = hunk.oldStart + newLineDelta;

    const rebuiltHeader = formatHunkHeader(
      oldStart,
      oldCount,
      newStart,
      newCount,
      hunk.section,
    );

    out += rebuiltHeader + '\n';
    if (hunk.bodyLines.length > 0) {
      out += hunk.bodyLines.join('\n') + '\n';
    }

    newLineDelta += newCount - oldCount;
  }

  return out;
}

// 여러 파일의 선택을 하나의 패치로 합친다(단일 git apply용, §3 all-or-nothing).
export function reassemblePatch(
  selections: ReadonlyArray<{ file: DiffFile; hunkIndices: readonly number[] }>,
): string {
  let patch = '';
  for (const sel of selections) {
    patch += reassembleFile(sel.file, sel.hunkIndices);
  }
  return patch;
}

// hunk 헤더 포맷팅. 라인 수가 1이면 git 관례상 ",1"을 생략할 수 있으나
// git apply는 명시적 카운트를 수용하므로 안전하게 항상 명시한다.
// 단, oldCount/newCount가 0인 경우(순수 add/delete hunk)는 "start,0" 형식.
function formatHunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  section: string,
): string {
  const oldPart = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
  const newPart = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
  return `@@ -${oldPart} +${newPart} @@${section}`;
}

// "--- a/path" / "+++ b/path" 라인에서 경로 추출. 탭 이후(타임스탬프) 절단.
// a/ b/ 접두는 유지(원문 보존 목적). /dev/null 은 그대로.
function parseHeaderPath(rest: string): string {
  const tab = rest.indexOf('\t');
  const p = tab >= 0 ? rest.slice(0, tab) : rest;
  return p;
}

// a/ 또는 b/ 접두를 제거해 repo-relative 표시 경로를 얻는다. /dev/null은 그대로.
function stripDiffPrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function num(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

// untracked 파일을 정식 new-file diff 헤더로 합성(스펙 §2·R4).
// git apply가 수용하는 형식: diff --git + new file mode + index + --- /dev/null + +++ b/path.
// content는 파일 원문(바이트). 파일 단위 all-or-nothing.
export function synthesizeNewFileDiff(
  repoRelPath: string,
  content: string,
  mode = '100644',
): string {
  const lines = content.length === 0 ? [] : content.split('\n');
  // content가 트레일링 개행으로 끝나면 split 결과 마지막이 빈 문자열 → 실제 라인 아님.
  const endsWithNewline = content.endsWith('\n');
  const bodyLines = endsWithNewline ? lines.slice(0, -1) : lines;
  const lineCount = bodyLines.length;

  let out = '';
  out += `diff --git a/${repoRelPath} b/${repoRelPath}\n`;
  out += `new file mode ${mode}\n`;
  out += `index 0000000..0000000\n`;
  // 빈 파일은 hunk 없이 헤더만(git apply는 0라인 hunk를 corrupt로 거부).
  if (lineCount === 0) {
    return out;
  }
  out += `--- /dev/null\n`;
  out += `+++ b/${repoRelPath}\n`;
  out += `@@ -0,0 +1,${lineCount} @@\n`;
  for (const bl of bodyLines) {
    out += `+${bl}\n`;
  }
  if (!endsWithNewline) {
    out += `\\ No newline at end of file\n`;
  }
  return out;
}
