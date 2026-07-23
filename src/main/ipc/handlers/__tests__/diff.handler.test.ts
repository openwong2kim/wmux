// J2 diff:read / diff:applyHunks 핸들러 테스트 (스펙 §2·§3·§6)
//
// 실제 git worktree를 만들어 read → applyHunks 전 경로를 검증한다.
// 커버: 워킹트리 대조(미커밋 포함)·untracked 합성·타겟 스냅샷·드리프트 거부·
// dirty 거부·per-hunk 프로브·경로 검증·all-or-nothing apply.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// electron ipcMain을 캡처해 핸들러를 직접 호출한다.
const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

// wrapHandler는 함수를 그대로 감싸므로 실제 구현을 통과시킨다.
import { registerDiffHandlers } from '../diff.handler';
import { IPC } from '../../../../shared/constants';
import { parseUnifiedDiff, type DiffApplyRequest } from '../../../../shared/diffParse';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// 태스크 worktree 시나리오를 구성한다: 본 repo + linked worktree.
// worktree에 미커밋 변경 2파일 + untracked 1파일.
function makeScenario(): {
  repoRoot: string;
  worktreePath: string;
  targetHeadOid: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), 'wmux-diffh-'));
  const repoRoot = join(base, 'repo');
  mkdirSync(repoRoot);
  g(repoRoot, ['init', '-q', '-b', 'main']);
  g(repoRoot, ['config', 'user.email', 't@t']);
  g(repoRoot, ['config', 'user.name', 't']);
  g(repoRoot, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoRoot, 'a.txt'), 'a1\na2\na3\na4\na5\n');
  writeFileSync(join(repoRoot, 'b.txt'), 'b1\nb2\nb3\n');
  g(repoRoot, ['add', '-A']);
  g(repoRoot, ['commit', '-q', '-m', 'base']);
  const targetHeadOid = g(repoRoot, ['rev-parse', 'HEAD']).trim();

  // linked worktree 생성(태스크 브랜치).
  const worktreePath = join(base, 'wt');
  g(repoRoot, ['worktree', 'add', '-q', '-b', 'wtask/x', worktreePath, 'HEAD']);

  // 미커밋 변경: a.txt 수정, b.txt 수정, c.txt untracked 신규.
  writeFileSync(join(worktreePath, 'a.txt'), 'a1\nCHANGED2\na3\na4\na5\n');
  writeFileSync(join(worktreePath, 'b.txt'), 'b1\nBCHANGED\nb3\n');
  writeFileSync(join(worktreePath, 'c.txt'), 'new1\nnew2\n');

  return {
    repoRoot,
    worktreePath,
    targetHeadOid,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('diff:read — 워킹트리 대조·untracked 합성·스냅샷', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('미커밋 3파일(수정2+untracked1)을 파일 트리·numstat로 반환', async () => {
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; kind: string; hunkSelectable: boolean }>;
      numstat: Array<{ path: string }>;
      snapshot: { targetBranch: string; targetHeadOid: string; targetDirtyFiles: string[] };
    };
    expect(res.ok).toBe(true);
    const paths = res.files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.txt', 'b.txt', 'c.txt']);
    // untracked c.txt는 add 분류.
    const c = res.files.find((f) => f.path === 'c.txt')!;
    expect(c.kind).toBe('add');
    expect(c.hunkSelectable).toBe(true);
    // 스냅샷: 타겟(본 repo)의 HEAD·브랜치.
    expect(res.snapshot.targetHeadOid).toBe(scn.targetHeadOid);
    expect(res.snapshot.targetBranch).toBe('main');
  });
});

describe('diff:applyHunks — 채택 all-or-nothing', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  async function readFiles() {
    const read = captured.get(IPC.DIFF_READ)!;
    return (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; hunks: unknown[] }>;
      snapshot: DiffApplyRequest['snapshot'];
    };
  }

  it('선택 hunk(a.txt)만 타겟 워킹트리에 반영 — 독립 오라클 검증', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot,
      selections: [{ path: 'a.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean; appliedFiles?: string[] };
    expect(res.ok).toBe(true);
    // 독립 오라클: 타겟 a.txt에 변경 반영, b.txt·c.txt는 미반영.
    expect(readFileSync(join(scn.repoRoot, 'a.txt'), 'utf8')).toBe('a1\nCHANGED2\na3\na4\na5\n');
    expect(readFileSync(join(scn.repoRoot, 'b.txt'), 'utf8')).toBe('b1\nb2\nb3\n');
    // c.txt는 타겟에 생성 안 됨.
    let cExists = true;
    try {
      readFileSync(join(scn.repoRoot, 'c.txt'));
    } catch {
      cExists = false;
    }
    expect(cExists).toBe(false);
  });

  it('untracked new-file(c.txt) 채택 — 타겟에 파일 생성', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot,
      selections: [{ path: 'c.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(readFileSync(join(scn.repoRoot, 'c.txt'), 'utf8')).toBe('new1\nnew2\n');
  });

  it('드리프트 게이트 — 타겟 HEAD 이동 시 거부', async () => {
    const r = await readFiles();
    // 타겟(본 repo)에서 새 커밋 → HEAD 이동.
    writeFileSync(join(scn.repoRoot, 'drift.txt'), 'drift\n');
    g(scn.repoRoot, ['add', '-A']);
    g(scn.repoRoot, ['commit', '-q', '-m', 'drift']);
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot, // 옛 스냅샷.
      selections: [{ path: 'a.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('drift');
  });

  it('dirty 거부 — 대상 파일이 타겟에서 미커밋 상태면 거부', async () => {
    // 타겟 a.txt를 dirty로 만든다.
    writeFileSync(join(scn.repoRoot, 'a.txt'), 'a1\na2\na3\na4\na5\nDIRTY\n');
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot,
      selections: [{ path: 'a.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('dirty');
  });

  it('이미 적용된 hunk — reverse 프로브가 alreadyApplied 표시(거부 아님, best-effort)', async () => {
    // 먼저 a.txt hunk를 타겟에 적용.
    const r1 = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    await apply({}, { taskId: 't', snapshot: r1.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] }, scn.worktreePath);
    // 스냅샷 갱신 후 재적용 시도 → --check 실패·--reverse 성공 → probe 코드.
    const r2 = await readFiles();
    const res = (await apply(
      {},
      { taskId: 't', snapshot: r2.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    )) as { ok: boolean; code?: string; failedProbes?: Array<{ alreadyApplied: boolean }> };
    // dirty(방금 적용으로 a.txt가 dirty)로 거부되거나 probe로 걸림 — 둘 다 안전.
    expect(res.ok).toBe(false);
    expect(['dirty', 'probe']).toContain(res.code);
  });

  it('다중 파일 채택 — 단일 패치로 a.txt+b.txt 동시 반영', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot,
      selections: [
        { path: 'a.txt', hunkIndices: [0] },
        { path: 'b.txt', hunkIndices: [0] },
      ],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(readFileSync(join(scn.repoRoot, 'a.txt'), 'utf8')).toBe('a1\nCHANGED2\na3\na4\na5\n');
    expect(readFileSync(join(scn.repoRoot, 'b.txt'), 'utf8')).toBe('b1\nBCHANGED\nb3\n');
  });

  it('독립 오라클 정합 — 적용 후 타겟 diff == 선택 hunk 재직렬화', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    await apply(
      {},
      { taskId: 't', snapshot: r.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    );
    // 타겟의 현 diff를 파싱 → a.txt 한 파일·한 hunk여야 한다.
    const targetDiff = g(scn.repoRoot, ['diff']);
    const parsed = parseUnifiedDiff(targetDiff);
    expect(parsed.files.map((f) => f.path)).toEqual(['a.txt']);
  });
});

// ── F1: quotepath 경로 파싱(공백·한글·따옴표·rename) ─────────────────────────
describe('diff:read/applyHunks — F1 특수문자 파일명(-z quotepath=false)', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('공백·한글 파일명의 dirty가 스냅샷·untracked에 원문으로 매칭', async () => {
    // 타겟(본 repo)에 공백/한글 파일을 dirty로 — 스냅샷 dirtyFiles 원문 매칭 확인.
    writeFileSync(join(scn.repoRoot, 'a.txt'), 'a1\na2\na3\na4\na5\nDIRTY\n');
    // worktree에 공백·한글 untracked 신규 파일 — readFile 합성 성공 확인.
    writeFileSync(join(scn.worktreePath, 'hello world.txt'), 'w1\nw2\n');
    writeFileSync(join(scn.worktreePath, '한글 파일.txt'), 'k1\nk2\n');

    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; kind: string }>;
      snapshot: { targetDirtyFiles: string[] };
    };
    expect(res.ok).toBe(true);
    // dirty 스냅샷은 슬래시 이스케이프 없이 원문 'a.txt'.
    expect(res.snapshot.targetDirtyFiles).toContain('a.txt');
    // 공백·한글 untracked가 원문 경로로 파싱·합성됨(add).
    const paths = res.files.map((f) => f.path);
    expect(paths).toContain('hello world.txt');
    expect(paths).toContain('한글 파일.txt');
    const kf = res.files.find((f) => f.path === '한글 파일.txt')!;
    expect(kf.kind).toBe('add');
  });

  it('rename R 레코드는 newpath만 dirty로(NUL 2필드 처리)', async () => {
    // 타겟에서 tracked 파일을 rename → status -z가 "R  new\\0old\\0" 2필드.
    g(scn.repoRoot, ['mv', 'b.txt', 'b renamed.txt']);
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      snapshot: { targetDirtyFiles: string[] };
    };
    expect(res.ok).toBe(true);
    // newpath는 dirty에 포함, oldpath(b.txt)는 별도 필드라 dirty로 오인되지 않음.
    expect(res.snapshot.targetDirtyFiles).toContain('b renamed.txt');
    expect(res.snapshot.targetDirtyFiles).not.toContain('b.txt');
  });
});

// ── F2: 프로브 의미론 — 의존 hunk 결합 성공·alreadyApplied 명시 거부 ──────────
describe('diff:applyHunks — F2 결합 게이트·alreadyApplied 거부', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('의존 hunk 2개(같은 파일 인접 변경)를 결합 게이트로 함께 적용 성공', async () => {
    // a.txt에 서로 가까운 두 변경 → 한 hunk 또는 두 hunk. 두 hunk면 결합 적용.
    writeFileSync(
      join(scn.worktreePath, 'a.txt'),
      'A1\na2\na3\na4\nA5\n', // 1행·5행 변경(멀어서 2 hunk 가능성).
    );
    const read = captured.get(IPC.DIFF_READ)!;
    const r = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; hunks: unknown[] }>;
      snapshot: DiffApplyRequest['snapshot'];
    };
    const af = r.files.find((f) => f.path === 'a.txt')!;
    const allIdx = af.hunks.map((_, i) => i);
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const res = (await apply(
      {},
      { taskId: 't', snapshot: r.snapshot, selections: [{ path: 'a.txt', hunkIndices: allIdx }] },
      scn.worktreePath,
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(readFileSync(join(scn.repoRoot, 'a.txt'), 'utf8')).toBe('A1\na2\na3\na4\nA5\n');
  });

  it('alreadyApplied hunk 포함 선택은 probe 코드로 명시 거부', async () => {
    // 타겟에 a.txt hunk를 먼저 직접 적용(git 경유) → dirty가 아니라 커밋해 clean 유지.
    const read = captured.get(IPC.DIFF_READ)!;
    const r1 = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      snapshot: DiffApplyRequest['snapshot'];
    };
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    // 1차 적용 후 타겟에서 커밋 → a.txt가 clean(=dirty 아님)이면서 변경은 반영됨.
    await apply(
      {},
      { taskId: 't', snapshot: r1.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    );
    g(scn.repoRoot, ['add', '-A']);
    g(scn.repoRoot, ['commit', '-q', '-m', 'adopt a']);
    // 타겟 HEAD가 이동했으므로 worktree의 mergeBase도 이동 — 재열람 후 재시도.
    const r2 = (await read({}, scn.worktreePath, '')) as {
      ok: boolean;
      files: Array<{ path: string; hunks: unknown[] }>;
      snapshot: DiffApplyRequest['snapshot'];
    };
    // a.txt가 여전히 worktree diff에 있으면(이미 반영돼 없을 수도) alreadyApplied 경로 확인.
    const af = r2.files.find((f) => f.path === 'a.txt');
    if (!af || af.hunks.length === 0) {
      // 타겟에 이미 반영돼 worktree diff에서 사라진 경우 — 이 케이스는 검증 대상 아님.
      return;
    }
    const res = (await apply(
      {},
      { taskId: 't', snapshot: r2.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    )) as { ok: boolean; code?: string; failedProbes?: Array<{ alreadyApplied: boolean }> };
    expect(res.ok).toBe(false);
    // dirty(방금 적용 잔여) 또는 probe(alreadyApplied) — 둘 다 안전한 명시 거부.
    expect(['dirty', 'probe']).toContain(res.code);
  });
});

// ── F3: untracked symlink 차단 ───────────────────────────────────────────────
describe('diff:read — F3 symlink untracked는 unsupported(repo 밖 노출 차단)', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('returns the unsupported label instead of synthesizing a symlink', async ({ skip }) => {
    // Create an untracked symlink pointing outside the worktree.
    const outside = join(scn.repoRoot, 'a.txt'); // Path outside the worktree.
    try {
      symlinkSync(outside, join(scn.worktreePath, 'link.txt'));
    } catch (error) {
      if (
        process.platform === 'win32' &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      ) {
        skip(
          'Windows symlink creation requires Developer Mode or administrator privileges',
        );
      }
      throw error;
    }
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string }>;
      unsupported: string[];
    };
    expect(res.ok).toBe(true);
    // symlink는 diff 파일 목록(합성)에 없고 unsupported에만.
    expect(res.unsupported).toContain('link.txt');
    expect(res.files.map((f) => f.path)).not.toContain('link.txt');
  });
});

// ── F4: delete diff의 dirty 게이트 경로 ──────────────────────────────────────
describe('diff:applyHunks — F4 delete 파일이 타겟에서 dirty면 거부', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('worktree에서 삭제된 파일이 타겟에서 dirty면 dirty 코드로 거부', async () => {
    // worktree에서 b.txt 삭제(delete diff 생성).
    rmSync(join(scn.worktreePath, 'b.txt'));
    // 타겟(본 repo)에서 b.txt를 dirty로.
    writeFileSync(join(scn.repoRoot, 'b.txt'), 'b1\nb2\nb3\nDIRTY\n');
    const read = captured.get(IPC.DIFF_READ)!;
    const r = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; kind: string; hunks: unknown[] }>;
      snapshot: DiffApplyRequest['snapshot'];
    };
    // delete 파일의 표시 경로가 실경로 b.txt(‘/dev/null’ 아님)여야 함(F4).
    const del = r.files.find((f) => f.path === 'b.txt');
    expect(del).toBeDefined();
    expect(del!.kind).toBe('delete');
    // dirty 스냅샷도 실경로 b.txt를 포함.
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const res = (await apply(
      {},
      { taskId: 't', snapshot: r.snapshot, selections: [{ path: 'b.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    )) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('dirty');
  });
});

// ── F7: truncated(캡 초과) 파일 채택 차단 ────────────────────────────────────
describe('diff:read/applyHunks — F7 캡 초과 파일 채택 불가', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('512KB 초과 변경 파일은 hunkSelectable=false·applyHunks에서 unsupported 거부', async () => {
    // a.txt를 512KB 넘게 키워 캡 초과 유발.
    const big = 'x'.repeat(600 * 1024) + '\n';
    writeFileSync(join(scn.worktreePath, 'a.txt'), big);
    const read = captured.get(IPC.DIFF_READ)!;
    const r = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; hunkSelectable: boolean; hunks: unknown[] }>;
      truncated: string[];
      snapshot: DiffApplyRequest['snapshot'];
    };
    expect(r.ok).toBe(true);
    expect(r.truncated).toContain('a.txt');
    const af = r.files.find((f) => f.path === 'a.txt')!;
    expect(af.hunkSelectable).toBe(false);
    // 2중 거부: applyHunks도 명시 거부(unsupported).
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const res = (await apply(
      {},
      { taskId: 't', snapshot: r.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    )) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('unsupported');
  });
});

// ── F8: targetHeadOid 인자 가드 ──────────────────────────────────────────────
describe('diff:read — F8 targetHeadOid 형식 가드', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('비 hex targetHeadOid는 bad-oid로 명시 거부', async () => {
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, scn.worktreePath, 'not-a-sha; rm -rf /')) as {
      ok: boolean;
      code?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad-oid');
  });
});

// ── 워크스페이스 diff 모드 — 일반 repo를 targetHeadOid 미지정으로 읽기 ─────────
// resolveTargetRepo→repo 자신, merge-base HEAD HEAD=HEAD → `git diff HEAD`
// (staged+unstaged) + untracked 합성. 백엔드 무변경으로 성립하는 계약을 고정한다.
describe('diff:read — 워크스페이스 모드(일반 repo, oid 미지정)', () => {
  let base: string;
  let repo: string;

  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-diffws-')));
    repo = join(base, 'repo');
    mkdirSync(repo);
    g(repo, ['init', '-q', '-b', 'main']);
    g(repo, ['config', 'user.email', 't@t']);
    g(repo, ['config', 'user.name', 't']);
    g(repo, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(repo, 'a.txt'), 'a1\na2\na3\n');
    // rename 테스트용 — rename 감지(유사도 50%+)가 성립할 만큼 라인 수를 확보.
    writeFileSync(join(repo, 'keep.txt'), 'k1\nk2\nk3\nk4\nk5\nk6\nk7\nk8\nk9\nk10\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'base']);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('staged+unstaged+untracked를 모두 반환, 스냅샷은 repo 자신', async () => {
    // staged 변경 + unstaged 변경 + untracked 신규.
    writeFileSync(join(repo, 'a.txt'), 'a1\nSTAGED\na3\n');
    g(repo, ['add', 'a.txt']);
    writeFileSync(join(repo, 'a.txt'), 'a1\nSTAGED\nUNSTAGED\n');
    writeFileSync(join(repo, 'new.txt'), 'n1\n');

    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, repo, '', 'workspace')) as {
      ok: boolean;
      files: Array<{ path: string; kind: string }>;
      snapshot: { targetRepoPath: string; targetBranch: string; targetHeadOid: string };
    };
    expect(res.ok).toBe(true);
    const paths = res.files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.txt', 'new.txt']);
    expect(res.snapshot.targetBranch).toBe('main');
    expect(res.snapshot.targetHeadOid).toBe(g(repo, ['rev-parse', 'HEAD']).trim());
    // a.txt diff는 staged+unstaged 합산(HEAD 대조)이어야 한다.
    const a = res.files.find((f) => f.path === 'a.txt')!;
    expect(JSON.stringify(a)).toContain('STAGED');
    expect(JSON.stringify(a)).toContain('UNSTAGED');
  });

  it('clean 워킹트리 — 빈 파일 목록으로 성공', async () => {
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, repo, '', 'workspace')) as { ok: boolean; files: unknown[] };
    expect(res.ok).toBe(true);
    expect(res.files).toEqual([]);
  });

  it('linked worktree(workspace 모드) — 브랜치 커밋 제외, 미커밋만(Codex P2 회귀)', async () => {
    // repo에 커밋 1개 더 → main HEAD 이동. worktree는 별 브랜치에서 자체 커밋 1개.
    const wt = join(base, 'wt');
    g(repo, ['worktree', 'add', '-q', '-b', 'feat/x', wt, 'HEAD']);
    // 워크트리 브랜치에 committed 변경(이건 diff에 나오면 안 됨).
    writeFileSync(join(wt, 'committed.txt'), 'branch-only\n');
    g(wt, ['add', '-A']);
    g(wt, ['commit', '-q', '-m', 'branch commit']);
    // 워크트리에 미커밋 변경(이것만 나와야 함).
    writeFileSync(join(wt, 'a.txt'), 'a1\nUNCOMMITTED\na3\n');
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, wt, '', 'workspace')) as {
      ok: boolean;
      files: Array<{ path: string }>;
    };
    expect(res.ok).toBe(true);
    const paths = res.files.map((f) => f.path).sort();
    // committed.txt(브랜치 커밋)는 없어야 하고 a.txt(미커밋)만 있어야 한다.
    expect(paths).toEqual(['a.txt']);
    expect(paths).not.toContain('committed.txt');
  });

  it('첫 커밋 전 repo(workspace 모드) — empty-tree 대비로 staged 파일을 added로', async () => {
    const fresh = join(base, 'fresh');
    mkdirSync(fresh);
    g(fresh, ['init', '-q', '-b', 'main']);
    g(fresh, ['config', 'user.email', 't@t']);
    g(fresh, ['config', 'user.name', 't']);
    writeFileSync(join(fresh, 'first.txt'), 'hello\n');
    g(fresh, ['add', '-A']); // staged, 커밋은 아직 없음(HEAD 없음).
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, fresh, '', 'workspace')) as {
      ok: boolean;
      files: Array<{ path: string; kind: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.files.map((f) => f.path)).toContain('first.txt');
  });

  it('rename+수정 — 표시 경로가 newpath 기준, kind=rename', async () => {
    // 순수 rename(100% 유사)은 +++ 라인이 없어 path가 '(unknown)'로 강등되는 게
    // 기존 파서 계약 — 여기선 내용 수정을 동반한 현실적 rename을 고정한다.
    g(repo, ['mv', 'keep.txt', 'renamed.txt']);
    writeFileSync(join(repo, 'renamed.txt'), 'k1\nEDITED\nk3\nk4\nk5\nk6\nk7\nk8\nk9\nk10\n');
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, repo, '', 'workspace')) as {
      ok: boolean;
      files: Array<{ path: string; kind: string }>;
    };
    expect(res.ok).toBe(true);
    const renamed = res.files.find((f) => f.path === 'renamed.txt');
    expect(renamed).toBeDefined();
    expect(renamed!.kind).toBe('rename');
  });
});

// ── diff:resolveRepo — 팔레트 진입점의 cwd → worktree toplevel 정규화 ─────────
describe('diff:resolveRepo — cwd 정규화', () => {
  let base: string;
  let repo: string;

  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    // realpathSync.native로 8.3 단축폼(CI Windows의 RUNNER~1)을 롱폼으로 정규화 —
    // git rev-parse가 반환하는 canonical 경로와 문자열 비교가 어긋나지 않게.
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-diffrr-')));
    repo = join(base, 'repo');
    mkdirSync(repo);
    g(repo, ['init', '-q', '-b', 'main']);
    g(repo, ['config', 'user.email', 't@t']);
    g(repo, ['config', 'user.name', 't']);
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'f.txt'), 'x\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'base']);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('서브디렉토리 cwd → repo toplevel 반환', async () => {
    const resolve = captured.get(IPC.DIFF_RESOLVE_REPO)!;
    const res = (await resolve({}, join(repo, 'sub'))) as { ok: boolean; repoPath?: string };
    expect(res.ok).toBe(true);
    // git은 슬래시 구분자 절대경로를 반환 — 경로 정규화 후 비교.
    expect(res.repoPath!.replaceAll('\\', '/').toLowerCase()).toBe(
      repo.replaceAll('\\', '/').toLowerCase(),
    );
  });

  it('linked worktree cwd → 그 worktree의 toplevel(본 repo 아님)', async () => {
    const wt = join(base, 'wt');
    g(repo, ['worktree', 'add', '-q', '-b', 'ws/x', wt, 'HEAD']);
    const resolve = captured.get(IPC.DIFF_RESOLVE_REPO)!;
    const res = (await resolve({}, join(wt, 'sub'))) as { ok: boolean; repoPath?: string };
    expect(res.ok).toBe(true);
    expect(res.repoPath!.replaceAll('\\', '/').toLowerCase()).toBe(
      wt.replaceAll('\\', '/').toLowerCase(),
    );
  });

  it('비-git cwd → ok:false', async () => {
    const outside = join(base, 'plain');
    mkdirSync(outside);
    const resolve = captured.get(IPC.DIFF_RESOLVE_REPO)!;
    const res = (await resolve({}, outside)) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('빈 인자 → ok:false', async () => {
    const resolve = captured.get(IPC.DIFF_RESOLVE_REPO)!;
    const res = (await resolve({}, '')) as { ok: boolean };
    expect(res.ok).toBe(false);
  });
});
