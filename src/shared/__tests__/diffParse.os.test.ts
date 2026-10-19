// J2 diffParse 왕복 오라클 테스트 (스펙 §3·§6 R11)
//
// 핵심 원칙: 파서 자기합의 금지. 재직렬화 결과는 실제 `git apply`로
// 임시 repo에 적용해 git을 오라클로 검증한다.
//
// 케이스(스펙 §6 tests 행): no-newline·CRLF·untracked new-file·앞 hunk 생략·
// 중복 컨텍스트.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseUnifiedDiff,
  reassembleFile,
  reassemblePatch,
  synthesizeNewFileDiff,
} from '../diffParse';

// Every case spins a real temp git repo and shells out to git many times
// (init, config×2, add, commit, apply, …). On a loaded GitHub Windows runner
// that serial spawn chain can exceed vitest's 5s default per-test timeout,
// flaking with "Test timed out in 5000ms" — a runner-speed artifact, not a
// logic failure (the suite passes locally and on faster runners). Raise the
// ceiling file-wide so slow spawns get room without masking real hangs.
vi.setConfig({ testTimeout: 30000 });

// 임시 git repo에서 base 콘텐츠를 커밋하고, 주어진 패치를 `git apply`로 적용해
// 적용 후 파일 내용을 반환한다. git이 오라클.
function applyPatchInRepo(
  files: Record<string, string>,
  patch: string,
): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'diffparse-'));
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    git(['config', 'core.autocrlf', 'false']);
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    if (Object.keys(files).length > 0) {
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
    }
    // 패치 파일로 저장 후 apply(원문 바이트 보존).
    const patchPath = join(dir, '__patch.diff');
    writeFileSync(patchPath, patch);
    git(['apply', patchPath]);

    // 적용 후 tracked+새 파일 내용 수집.
    const out: Record<string, string> = {};
    const tracked = git(['ls-files'])
      .split('\n')
      .filter((l) => l.length > 0 && l !== '__patch.diff');
    for (const f of tracked) {
      out[f] = readFileSync(join(dir, f), 'utf8');
    }
    // untracked(새로 추가된 파일 중 아직 add 안 된 것) 확인. -uall로 디렉토리가 아닌
    // 개별 파일 경로를 얻는다.
    const status = git(['status', '--porcelain', '-uall']).split('\n').filter(Boolean);
    for (const line of status) {
      const p = line.slice(3);
      if (p === '__patch.diff' || out[p] !== undefined) continue;
      try {
        out[p] = readFileSync(join(dir, p), 'utf8');
      } catch {
        /* deleted */
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// git diff 생성 헬퍼: base → after 로 파일을 바꾸고 `git diff` 원문을 얻는다.
function makeDiff(
  base: Record<string, string>,
  after: Record<string, string>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffgen-'));
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    git(['config', 'core.autocrlf', 'false']);
    for (const [path, content] of Object.entries(base)) {
      writeFileSync(join(dir, path), content);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    // after 적용(파일 덮어쓰기 — delete는 별도 처리 필요 없음, 여기선 modify만).
    for (const [path, content] of Object.entries(after)) {
      writeFileSync(join(dir, path), content);
    }
    return git(['diff']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('parseUnifiedDiff — 기본 파싱', () => {
  it('단순 modify diff를 파일·hunk로 파싱', () => {
    const diff = makeDiff({ 'a.txt': 'l1\nl2\nl3\n' }, { 'a.txt': 'l1\nCHANGED\nl3\n' });
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].path).toBe('a.txt');
    expect(parsed.files[0].kind).toBe('modify');
    expect(parsed.files[0].hunkSelectable).toBe(true);
    expect(parsed.files[0].hunks.length).toBeGreaterThan(0);
  });

  it('new file를 add로 분류', () => {
    // 실제 git이 만든 new-file diff.
    const dir = mkdtempSync(join(tmpdir(), 'newf-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      writeFileSync(join(dir, 'seed.txt'), 'seed\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      writeFileSync(join(dir, 'new.txt'), 'hello\nworld\n');
      git(['add', 'new.txt']);
      const diff = git(['diff', '--cached']);
      const parsed = parseUnifiedDiff(diff);
      expect(parsed.files[0].kind).toBe('add');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binary·rename는 채택 불가 라벨', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bin-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      writeFileSync(join(dir, 'orig.txt'), 'content here\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      git(['mv', 'orig.txt', 'renamed.txt']);
      const diff = git(['diff', '--cached', '-M']);
      const parsed = parseUnifiedDiff(diff);
      expect(parsed.files[0].kind).toBe('rename');
      expect(parsed.files[0].hunkSelectable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('왕복 오라클 — reassemble → git apply (R11)', () => {
  it('전체 hunk 재직렬화가 원본 diff와 동일 결과 적용', () => {
    const base = { 'a.txt': 'l1\nl2\nl3\nl4\nl5\n' };
    const after = { 'a.txt': 'l1\nX2\nl3\nl4\nY5\n' };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const allIdx = file.hunks.map((_, i) => i);
    const patch = reassembleFile(file, allIdx);
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
  });

  it('앞 hunk 생략 — 뒤 hunk만 선택 적용', () => {
    // 두 개의 분리된 변경 → 2 hunk 기대. 두 번째만 선택.
    const base = {
      'a.txt': Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n',
    };
    const afterLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    afterLines[1] = 'CHANGED2'; // 앞 hunk
    afterLines[17] = 'CHANGED18'; // 뒤 hunk
    const after = { 'a.txt': afterLines.join('\n') + '\n' };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    expect(file.hunks.length).toBe(2);
    // 뒤 hunk(index 1)만 선택.
    const patch = reassembleFile(file, [1]);
    const result = applyPatchInRepo(base, patch);
    // 기대: line2는 원본 유지, line18만 CHANGED18.
    const expectedLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    expectedLines[17] = 'CHANGED18';
    expect(result['a.txt']).toBe(expectedLines.join('\n') + '\n');
  });

  it('앞 hunk만 선택 — 오프셋 보정 검증', () => {
    const base = {
      'a.txt': Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n',
    };
    const afterLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    afterLines[1] = 'CHANGED2';
    afterLines[17] = 'CHANGED18';
    const after = { 'a.txt': afterLines.join('\n') + '\n' };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const patch = reassembleFile(file, [0]);
    const result = applyPatchInRepo(base, patch);
    const expectedLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    expectedLines[1] = 'CHANGED2';
    expect(result['a.txt']).toBe(expectedLines.join('\n') + '\n');
  });

  it('no-newline at end of file — 마커 원문 보존 통과', () => {
    // base는 개행 없이 끝남 → 수정 후에도 개행 없음.
    const base = { 'a.txt': 'l1\nl2\nl3' }; // 트레일링 개행 없음
    const after = { 'a.txt': 'l1\nCHANGED\nl3' }; // 여전히 개행 없음
    const diff = makeDiff(base, after);
    // no-newline 마커가 diff에 실제로 있는지 확인(전제 검증).
    expect(diff).toContain('\\ No newline at end of file');
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const patch = reassembleFile(file, file.hunks.map((_, i) => i));
    // 재직렬화 패치에도 마커가 보존돼야 한다.
    expect(patch).toContain('\\ No newline at end of file');
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
    // 결과가 개행으로 끝나지 않아야 한다(오염 방지).
    expect(result['a.txt'].endsWith('\n')).toBe(false);
  });

  it('CRLF — 원문 보존 통과', () => {
    const base = { 'a.txt': 'l1\r\nl2\r\nl3\r\n' };
    const after = { 'a.txt': 'l1\r\nCHANGED\r\nl3\r\n' };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const patch = reassembleFile(file, file.hunks.map((_, i) => i));
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
    // CRLF가 보존됐는지.
    expect(result['a.txt']).toContain('\r\n');
  });

  it('중복 컨텍스트 — 동일 라인 반복 파일에서 특정 hunk 적용', () => {
    // 같은 내용 라인이 반복돼 컨텍스트 모호성이 있는 경우.
    const base = {
      'a.txt': 'x\nx\nx\nMARKER\nx\nx\nx\n',
    };
    const after = {
      'a.txt': 'x\nx\nx\nCHANGED\nx\nx\nx\n',
    };
    const diff = makeDiff(base, after);
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const patch = reassembleFile(file, file.hunks.map((_, i) => i));
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
  });
});

describe('synthesizeNewFileDiff — untracked new-file 합성 (R4)', () => {
  it('개행으로 끝나는 파일 — git apply 수용', () => {
    const patch = synthesizeNewFileDiff('sub/new.txt', 'alpha\nbeta\n');
    const result = applyPatchInRepo({ 'seed.txt': 'seed\n' }, patch);
    expect(result['sub/new.txt']).toBe('alpha\nbeta\n');
  });

  it('no-newline로 끝나는 파일 — 마커 합성', () => {
    const patch = synthesizeNewFileDiff('new.txt', 'alpha\nbeta');
    expect(patch).toContain('\\ No newline at end of file');
    const result = applyPatchInRepo({ 'seed.txt': 'seed\n' }, patch);
    expect(result['new.txt']).toBe('alpha\nbeta');
    expect(result['new.txt'].endsWith('\n')).toBe(false);
  });

  it('빈 파일 합성', () => {
    const patch = synthesizeNewFileDiff('empty.txt', '');
    const result = applyPatchInRepo({ 'seed.txt': 'seed\n' }, patch);
    expect(result['empty.txt']).toBe('');
  });
});

describe('reassemblePatch — 다중 파일 all-or-nothing', () => {
  it('두 파일의 선택 hunk를 단일 패치로 결합 적용', () => {
    const base = { 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b1\nb2\nb3\n' };
    const after = { 'a.txt': 'a1\nAX\na3\n', 'b.txt': 'b1\nBX\nb3\n' };
    // 각 파일 diff를 개별 생성 후 파서로 합침.
    const diffA = makeDiff({ 'a.txt': base['a.txt'] }, { 'a.txt': after['a.txt'] });
    const diffB = makeDiff({ 'b.txt': base['b.txt'] }, { 'b.txt': after['b.txt'] });
    const fileA = parseUnifiedDiff(diffA).files[0];
    const fileB = parseUnifiedDiff(diffB).files[0];
    const patch = reassemblePatch([
      { file: fileA, hunkIndices: fileA.hunks.map((_, i) => i) },
      { file: fileB, hunkIndices: fileB.hunks.map((_, i) => i) },
    ]);
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
    expect(result['b.txt']).toBe(after['b.txt']);
  });

  it('선택 0개면 빈 패치', () => {
    const diff = makeDiff({ 'a.txt': 'l1\nl2\n' }, { 'a.txt': 'l1\nX\n' });
    const file = parseUnifiedDiff(diff).files[0];
    expect(reassembleFile(file, [])).toBe('');
  });
});

// ── F4: delete 파일의 표시 경로는 실경로(‘/dev/null’ 아님) ────────────────────
describe('parseUnifiedDiff — F4 delete display path', () => {
  it('delete diff의 path는 oldPath 실경로', () => {
    // gone.txt를 커밋 후 rm → 실제 git이 만든 delete diff. newPath는 /dev/null.
    const dir = mkdtempSync(join(tmpdir(), 'del-'));
    try {
      const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      git(['config', 'core.autocrlf', 'false']);
      writeFileSync(join(dir, 'gone.txt'), 'x1\nx2\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      rmSync(join(dir, 'gone.txt'));
      const diff = git(['diff']);
      const parsed = parseUnifiedDiff(diff);
      const f = parsed.files.find((ff) => ff.kind === 'delete')!;
      expect(f).toBeDefined();
      // 표시·매칭 경로가 /dev/null이 아니라 실경로 gone.txt.
      expect(f.path).toBe('gone.txt');
      expect(f.path).not.toBe('/dev/null');
      expect(f.hunkSelectable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── F9: hunk 바디의 빈 문자열 종료는 마지막 원소일 때만 ──────────────────────
describe('parseUnifiedDiff — F9 빈 문자열 라인 처리', () => {
  it('트레일링 개행 산물(마지막 빈 원소)은 종료, 왕복 apply 정합', () => {
    // 마지막 라인이 개행으로 끝나는 표준 파일 → split 마지막 원소가 빈 문자열.
    const base = { 'a.txt': 'l1\nl2\nl3\n' };
    const after = { 'a.txt': 'l1\nCHANGED\nl3\n' };
    const diff = makeDiff(base, after);
    const file = parseUnifiedDiff(diff).files[0];
    const patch = reassemblePatch([{ file, hunkIndices: file.hunks.map((_, i) => i) }]);
    // git 오라클: 재직렬화 결과가 실제로 적용되어 after와 일치.
    const result = applyPatchInRepo(base, patch);
    expect(result['a.txt']).toBe(after['a.txt']);
  });
});
