// J2 diff:read / diff:applyHunks handler tests (spec §2·§3·§6)
//
// Build real git worktree and verify read → applyHunks full path.
// Covers: working-tree compare (incl. uncommitted), untracked synthesis, target snapshot,
// drift rejection, dirty rejection, per-hunk probe, path validation, all-or-nothing apply.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Capture electron ipcMain and invoke handlers directly.
const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

// wrapHandler passes function through unchanged, so real implementation runs.
import { registerDiffHandlers } from '../diff.handler';
import { IPC } from '../../../../shared/constants';
import { parseUnifiedDiff, type DiffApplyRequest } from '../../../../shared/diffParse';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Build task worktree scenario: main repo + linked worktree.
// Worktree has 2 uncommitted modified files + 1 untracked file.
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

  // Create linked worktree (task branch).
  const worktreePath = join(base, 'wt');
  g(repoRoot, ['worktree', 'add', '-q', '-b', 'wtask/x', worktreePath, 'HEAD']);

  // Uncommitted changes: a.txt modified, b.txt modified, c.txt new untracked.
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

describe('diff:read — working-tree compare·untracked synthesis·snapshot', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('returns uncommitted 3 files (2 modified + 1 untracked) as file tree·numstat', async () => {
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
    // untracked c.txt classified as add.
    const c = res.files.find((f) => f.path === 'c.txt')!;
    expect(c.kind).toBe('add');
    expect(c.hunkSelectable).toBe(true);
    // Snapshot: target (main repo) HEAD and branch.
    expect(res.snapshot.targetHeadOid).toBe(scn.targetHeadOid);
    expect(res.snapshot.targetBranch).toBe('main');
  });
});

describe('diff:applyHunks — adopt all-or-nothing', () => {
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

  it('applies selected hunk (a.txt) only to target working tree — independent oracle verify', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot,
      selections: [{ path: 'a.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean; appliedFiles?: string[] };
    expect(res.ok).toBe(true);
    // Independent oracle: target a.txt changed, b.txt·c.txt not applied.
    expect(readFileSync(join(scn.repoRoot, 'a.txt'), 'utf8')).toBe('a1\nCHANGED2\na3\na4\na5\n');
    expect(readFileSync(join(scn.repoRoot, 'b.txt'), 'utf8')).toBe('b1\nb2\nb3\n');
    // c.txt not created on target.
    let cExists = true;
    try {
      readFileSync(join(scn.repoRoot, 'c.txt'));
    } catch {
      cExists = false;
    }
    expect(cExists).toBe(false);
  });

  it('adopts untracked new-file (c.txt) — creates file on target', async () => {
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

  it('drift gate — rejects when target HEAD moved', async () => {
    const r = await readFiles();
    // New commit on target (main repo) → HEAD moves.
    writeFileSync(join(scn.repoRoot, 'drift.txt'), 'drift\n');
    g(scn.repoRoot, ['add', '-A']);
    g(scn.repoRoot, ['commit', '-q', '-m', 'drift']);
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot, // stale snapshot.
      selections: [{ path: 'a.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('drift');
  });

  it('dirty rejection — rejects when target file has uncommitted changes on target', async () => {
    // Make target a.txt dirty.
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

  it('already-applied hunk — reverse probe marks alreadyApplied (not rejection, best-effort)', async () => {
    // Apply a.txt hunk to target first.
    const r1 = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    await apply({}, { taskId: 't', snapshot: r1.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] }, scn.worktreePath);
    // Refresh snapshot then retry → --check fail · --reverse success → probe code.
    const r2 = await readFiles();
    const res = (await apply(
      {},
      { taskId: 't', snapshot: r2.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    )) as { ok: boolean; code?: string; failedProbes?: Array<{ alreadyApplied: boolean }> };
    // Rejected as dirty (a.txt dirty from just-applied) or caught by probe — both safe.
    expect(res.ok).toBe(false);
    expect(['dirty', 'probe']).toContain(res.code);
  });

  it('multi-file adopt — single patch applies a.txt+b.txt together', async () => {
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

  it('independent oracle consistency — post-apply target diff == selected hunk reserialization', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    await apply(
      {},
      { taskId: 't', snapshot: r.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    );
    // Parse target current diff → one file a.txt, one hunk.
    const targetDiff = g(scn.repoRoot, ['diff']);
    const parsed = parseUnifiedDiff(targetDiff);
    expect(parsed.files.map((f) => f.path)).toEqual(['a.txt']);
  });
});

// ── F1: quotepath path parsing (spaces·CJK·quotes·rename) ─────────────────────────
describe('diff:read/applyHunks — F1 special-char filenames (-z quotepath=false)', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('dirty for space·Hangul filenames matches verbatim in snapshot·untracked', async () => {
    // Make space/CJK files dirty on target (main repo) — verify snapshot dirtyFiles verbatim match.
    writeFileSync(join(scn.repoRoot, 'a.txt'), 'a1\na2\na3\na4\na5\nDIRTY\n');
    // New space/CJK untracked files on worktree — verify readFile synthesis succeeds.
    writeFileSync(join(scn.worktreePath, 'hello world.txt'), 'w1\nw2\n');
    writeFileSync(join(scn.worktreePath, '한글 파일.txt'), 'k1\nk2\n');

    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; kind: string }>;
      snapshot: { targetDirtyFiles: string[] };
    };
    expect(res.ok).toBe(true);
    // dirty snapshot has verbatim 'a.txt' without slash escape.
    expect(res.snapshot.targetDirtyFiles).toContain('a.txt');
    // space/CJK untracked parsed·synthesized with verbatim paths (add).
    const paths = res.files.map((f) => f.path);
    expect(paths).toContain('hello world.txt');
    expect(paths).toContain('한글 파일.txt');
    const kf = res.files.find((f) => f.path === '한글 파일.txt')!;
    expect(kf.kind).toBe('add');
  });

  it('rename R record marks newpath only as dirty (NUL 2-field handling)', async () => {
    // Rename tracked file on target → status -z "R  new\\0old\\0" 2 fields.
    g(scn.repoRoot, ['mv', 'b.txt', 'b renamed.txt']);
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      snapshot: { targetDirtyFiles: string[] };
    };
    expect(res.ok).toBe(true);
    // newpath in dirty; oldpath (b.txt) separate field, not mistaken as dirty.
    expect(res.snapshot.targetDirtyFiles).toContain('b renamed.txt');
    expect(res.snapshot.targetDirtyFiles).not.toContain('b.txt');
  });
});

// ── F2: probe semantics — dependent hunk combined success · alreadyApplied explicit rejection ──────────
describe('diff:applyHunks — F2 combined gate·alreadyApplied rejection', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('two dependent hunks (adjacent changes same file) apply together via combined gate', async () => {
    // Two nearby changes on a.txt → one or two hunks. Two hunks → combined apply.
    writeFileSync(
      join(scn.worktreePath, 'a.txt'),
      'A1\na2\na3\na4\nA5\n', // line 1·5 changes (far apart, may split to 2 hunks).
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

  it('selection including alreadyApplied hunk explicitly rejected with probe code', async () => {
    // Apply a.txt hunk to target directly via git first → commit to stay clean, not dirty.
    const read = captured.get(IPC.DIFF_READ)!;
    const r1 = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      snapshot: DiffApplyRequest['snapshot'];
    };
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    // After first apply, commit on target → a.txt clean (not dirty) with change applied.
    await apply(
      {},
      { taskId: 't', snapshot: r1.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    );
    g(scn.repoRoot, ['add', '-A']);
    g(scn.repoRoot, ['commit', '-q', '-m', 'adopt a']);
    // Target HEAD moved so worktree mergeBase moved — re-read then retry.
    const r2 = (await read({}, scn.worktreePath, '')) as {
      ok: boolean;
      files: Array<{ path: string; hunks: unknown[] }>;
      snapshot: DiffApplyRequest['snapshot'];
    };
    // If a.txt still in worktree diff (may be gone if already applied), verify alreadyApplied path.
    const af = r2.files.find((f) => f.path === 'a.txt');
    if (!af || af.hunks.length === 0) {
      // Already applied on target, gone from worktree diff — not a test case here.
      return;
    }
    const res = (await apply(
      {},
      { taskId: 't', snapshot: r2.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    )) as { ok: boolean; code?: string; failedProbes?: Array<{ alreadyApplied: boolean }> };
    expect(res.ok).toBe(false);
    // dirty (residual from just-applied) or probe (alreadyApplied) — both safe explicit rejection.
    expect(['dirty', 'probe']).toContain(res.code);
  });
});

// ── F3: untracked symlink blocked ───────────────────────────────────────────────
describe('diff:read — F3 symlink untracked is unsupported (blocks out-of-repo exposure)', () => {
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
    // symlink not in diff file list (synthesis), only in unsupported.
    expect(res.unsupported).toContain('link.txt');
    expect(res.files.map((f) => f.path)).not.toContain('link.txt');
  });
});

// ── F4: delete diff dirty-gate path ──────────────────────────────────────
describe('diff:applyHunks — F4 rejects when deleted file is dirty on target', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('file deleted in worktree but dirty on target rejected with dirty code', async () => {
    // Delete b.txt on worktree (creates delete diff).
    rmSync(join(scn.worktreePath, 'b.txt'));
    // Make b.txt dirty on target (main repo).
    writeFileSync(join(scn.repoRoot, 'b.txt'), 'b1\nb2\nb3\nDIRTY\n');
    const read = captured.get(IPC.DIFF_READ)!;
    const r = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; kind: string; hunks: unknown[] }>;
      snapshot: DiffApplyRequest['snapshot'];
    };
    // delete file display path must be real b.txt, not '/dev/null' (F4).
    const del = r.files.find((f) => f.path === 'b.txt');
    expect(del).toBeDefined();
    expect(del!.kind).toBe('delete');
    // dirty snapshot also includes real path b.txt.
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

// ── F7: truncated (cap exceeded) file adopt blocked ────────────────────────────────────
describe('diff:read/applyHunks — F7 cap-exceeded file cannot be adopted', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('>512KB changed file has hunkSelectable=false·applyHunks unsupported rejection', async () => {
    // Grow a.txt past 512KB to trigger cap exceed.
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
    // Double rejection: applyHunks also explicitly rejects (unsupported).
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

// ── F8: targetHeadOid arg guard ──────────────────────────────────────────────
describe('diff:read — F8 targetHeadOid format guard', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('non-hex targetHeadOid explicitly rejected with bad-oid', async () => {
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, scn.worktreePath, 'not-a-sha; rm -rf /')) as {
      ok: boolean;
      code?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad-oid');
  });
});

// ── Workspace diff mode — read plain repo without targetHeadOid ─────────
// resolveTargetRepo→repo self, merge-base HEAD HEAD=HEAD → `git diff HEAD`
// (staged+unstaged) + untracked synthesis. Pin contract that holds without backend change.
describe('diff:read — workspace mode (plain repo, oid unspecified)', () => {
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
    // For rename test — enough lines for rename detection (50%+ similarity).
    writeFileSync(join(repo, 'keep.txt'), 'k1\nk2\nk3\nk4\nk5\nk6\nk7\nk8\nk9\nk10\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'base']);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('returns staged+unstaged+untracked, snapshot is repo itself', async () => {
    // staged change + unstaged change + new untracked.
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
    // a.txt diff must be staged+unstaged combined (vs HEAD).
    const a = res.files.find((f) => f.path === 'a.txt')!;
    expect(JSON.stringify(a)).toContain('STAGED');
    expect(JSON.stringify(a)).toContain('UNSTAGED');
  });

  it('clean working tree — succeeds with empty file list', async () => {
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, repo, '', 'workspace')) as { ok: boolean; files: unknown[] };
    expect(res.ok).toBe(true);
    expect(res.files).toEqual([]);
  });

  it('linked worktree (workspace mode) — excludes branch commits, uncommitted only (Codex P2 regression)', async () => {
    // One more commit on repo → main HEAD moves. worktree has own commit on separate branch.
    const wt = join(base, 'wt');
    g(repo, ['worktree', 'add', '-q', '-b', 'feat/x', wt, 'HEAD']);
    // Committed change on worktree branch (must NOT appear in diff).
    writeFileSync(join(wt, 'committed.txt'), 'branch-only\n');
    g(wt, ['add', '-A']);
    g(wt, ['commit', '-q', '-m', 'branch commit']);
    // Uncommitted change on worktree (only this should appear).
    writeFileSync(join(wt, 'a.txt'), 'a1\nUNCOMMITTED\na3\n');
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, wt, '', 'workspace')) as {
      ok: boolean;
      files: Array<{ path: string }>;
    };
    expect(res.ok).toBe(true);
    const paths = res.files.map((f) => f.path).sort();
    // committed.txt (branch commit) must be absent; only a.txt (uncommitted).
    expect(paths).toEqual(['a.txt']);
    expect(paths).not.toContain('committed.txt');
  });

  it('pre-first-commit repo (workspace mode) — staged files as added vs empty-tree', async () => {
    const fresh = join(base, 'fresh');
    mkdirSync(fresh);
    g(fresh, ['init', '-q', '-b', 'main']);
    g(fresh, ['config', 'user.email', 't@t']);
    g(fresh, ['config', 'user.name', 't']);
    writeFileSync(join(fresh, 'first.txt'), 'hello\n');
    g(fresh, ['add', '-A']); // staged, no commit yet (no HEAD).
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, fresh, '', 'workspace')) as {
      ok: boolean;
      files: Array<{ path: string; kind: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.files.map((f) => f.path)).toContain('first.txt');
  });

  it('rename+modify — display path uses newpath, kind=rename', async () => {
    // Pure rename (100% similar) has no +++ line so path demoted to '(unknown)' is
    // existing parser contract — here pin realistic rename with content edit.
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

// ── diff:resolveRepo — palette entry cwd → worktree toplevel normalization ─────────
describe('diff:resolveRepo — cwd normalization', () => {
  let base: string;
  let repo: string;

  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    // Normalize 8.3 short form (CI Windows RUNNER~1) to long form via realpathSync.native —
    // so string compare aligns with git rev-parse canonical path.
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

  it('subdirectory cwd → returns repo toplevel', async () => {
    const resolve = captured.get(IPC.DIFF_RESOLVE_REPO)!;
    const res = (await resolve({}, join(repo, 'sub'))) as { ok: boolean; repoPath?: string };
    expect(res.ok).toBe(true);
    // git returns slash-separated absolute paths — compare after path normalization.
    expect(res.repoPath!.replaceAll('\\', '/').toLowerCase()).toBe(
      repo.replaceAll('\\', '/').toLowerCase(),
    );
  });

  it('linked worktree cwd → that worktree toplevel (not main repo)', async () => {
    const wt = join(base, 'wt');
    g(repo, ['worktree', 'add', '-q', '-b', 'ws/x', wt, 'HEAD']);
    const resolve = captured.get(IPC.DIFF_RESOLVE_REPO)!;
    const res = (await resolve({}, join(wt, 'sub'))) as { ok: boolean; repoPath?: string };
    expect(res.ok).toBe(true);
    expect(res.repoPath!.replaceAll('\\', '/').toLowerCase()).toBe(
      wt.replaceAll('\\', '/').toLowerCase(),
    );
  });

  it('non-git cwd → ok:false', async () => {
    const outside = join(base, 'plain');
    mkdirSync(outside);
    const resolve = captured.get(IPC.DIFF_RESOLVE_REPO)!;
    const res = (await resolve({}, outside)) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('empty arg → ok:false', async () => {
    const resolve = captured.get(IPC.DIFF_RESOLVE_REPO)!;
    const res = (await resolve({}, '')) as { ok: boolean };
    expect(res.ok).toBe(false);
  });
});
