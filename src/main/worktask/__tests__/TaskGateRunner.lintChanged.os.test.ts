// ─── The eslint step from a base ref: only errors the task adds fail it ────
//
// A default branch whose own `npm run lint` fails (wmux's: 288 errors on
// main, which CI never lints whole) failed every bot task's gate. From a base
// ref, a plain eslint script now lints the files the task changed and
// compares each one with its base version.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TaskGateRunner,
  newLintProblems,
  parseEslintScript,
  parseNameStatus,
  type ChangedFile,
  type GateExit,
  type GateProcess,
  type GateSpawn,
  type LintProblem,
} from '../TaskGateRunner';
import type { LedgerGateWrite, LedgerPort } from '../ledgerPort';
import { describeTaskGate } from '../../factory/taskGate';

const WT = '/tmp/wt-lint-1';
const BASE = 'b'.repeat(40);
const scripts = { lint: 'eslint --ext .ts,.tsx .', test: 'vitest run' };
const pkg = JSON.stringify({ name: 'x', scripts });

function fakeLedger(): LedgerPort & { writes: LedgerGateWrite[] } {
  const writes: LedgerGateWrite[] = [];
  return {
    writes,
    read: async () => ({ id: 'wtask-1', rev: 3 }),
    writeGate: async (w) => {
      writes.push(w);
      return { ok: true, rev: 4 };
    },
  };
}

const problem = (line: number, ruleId: string, message: string): LintProblem => ({ line, column: 1, ruleId, message });
const report = (files: Record<string, LintProblem[]>) =>
  JSON.stringify(Object.entries(files).map(([f, ps]) => ({ filePath: path.join(WT, f), messages: ps.map((p) => ({ ...p, severity: 2 })) })));

/** eslint as the gate runs it: the HEAD report for the files after `--`,
 *  the base report for a `--stdin` run. `exit` overrides eslint's own. */
function fakeEslint(opts: {
  head: Record<string, LintProblem[]>;
  base?: Record<string, LintProblem[]>;
  exit?: number;
  /** Replaces the HEAD report's stdout. */
  headOut?: string;
  seen: { argv: string[]; stdin?: string }[];
}): GateSpawn {
  return (cmd, args, o) => {
    const argv = [cmd, ...args];
    opts.seen.push({ argv, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}) });
    let out = '';
    let code = 0;
    if (argv[1]?.endsWith(path.join('eslint', 'bin', 'eslint.js'))) {
      if (args.includes('--stdin')) {
        const f = (args.find((a) => a.startsWith('--stdin-filename=')) as string).slice('--stdin-filename='.length);
        const ps = opts.base?.[f] ?? [];
        out = report({ [f]: ps });
        code = ps.length > 0 ? 1 : 0;
      } else {
        const files = args.slice(args.indexOf('--') + 1);
        const r = Object.fromEntries(files.map((f) => [f, opts.head[f] ?? []]));
        out = report(r);
        code = Object.values(r).some((ps) => ps.length > 0) ? 1 : 0;
        if (opts.headOut !== undefined) out = opts.headOut;
      }
      if (opts.exit !== undefined) {
        code = opts.exit;
        out = opts.exit === 2 ? '' : out;
      }
    }
    const proc: GateProcess = {
      onOutput(cb) {
        if (out) cb(out);
      },
      onStdio(stdout, stderr) {
        if (out) stdout(out);
        if (code === 2) stderr('Oops! Something went wrong!\n');
      },
      wait: async (): Promise<GateExit> => ({ kind: 'exited', code }),
      kill() {
        /* exits at once */
      },
    };
    return proc;
  };
}

function runnerFor(opts: {
  files: ChangedFile[] | { error: string };
  removed?: boolean;
  headOut?: string;
  extra?: Record<string, string>;
  head: Record<string, LintProblem[]>;
  base?: Record<string, LintProblem[]>;
  baseText?: Record<string, string>;
  exit?: number;
  lint?: string;
}) {
  const seen: { argv: string[]; stdin?: string }[] = [];
  const ledger = fakeLedger();
  const lintScripts = { ...scripts, ...(opts.lint ? { lint: opts.lint } : {}), ...opts.extra };
  const runner = new TaskGateRunner({
    ledger,
    spawn: fakeEslint({ head: opts.head, ...(opts.base ? { base: opts.base } : {}), ...(opts.exit !== undefined ? { exit: opts.exit } : {}), ...(opts.headOut !== undefined ? { headOut: opts.headOut } : {}), seen }),
    readPackageScripts: () => lintScripts,
    depsState: () => 'ok',
    fileExists: (p) => !p.endsWith('.npmrc'),
    readHead: async () => null,
    readBaseFile: async (_wt, _ref, file) => (file === 'package.json' ? JSON.stringify({ name: 'x', scripts: lintScripts }) : file === '.npmrc' ? null : opts.baseText?.[file] ?? `// ${file} at base`),
    changedFiles: async () => (Array.isArray(opts.files) ? { base: BASE, files: opts.files, ...(opts.removed ? { removed: true } : {}) } : opts.files),
    now: () => 1,
  });
  return {
    seen,
    ledger,
    run: () => runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon', gateBaseRef: 'origin/main' }),
  };
}

const lintRuns = (seen: { argv: string[]; stdin?: string }[]) => seen.filter((s) => s.argv[1]?.endsWith('eslint.js'));
const npmRuns = (seen: { argv: string[] }[]) => seen.filter((s) => !s.argv[1]?.endsWith('eslint.js')).map((s) => s.argv.slice(1).join(' '));

describe('parseEslintScript', () => {
  it('takes eslint with an --ext list and directories, nothing else', () => {
    expect(parseEslintScript('eslint --ext .ts,.tsx .')).toEqual({ ext: ['.ts', '.tsx'], paths: [''] });
    expect(parseEslintScript('eslint --ext=.ts ./src src/. tests/')).toEqual({ ext: ['.ts'], paths: ['src', 'src', 'tests'] });
    for (const s of [
      'eslint .', 'eslint --ext .ts . --max-warnings 0', 'eslint --ext .ts . && rm x', 'eslint --ext .ts', 'next lint', 'eslint --ext .ts --ext .js .',
      // A second command on a new line, a named file, a path outside.
      'eslint --ext .ts .\nfalse', 'eslint --ext .ts\t.', 'eslint --ext .ts src/a.js', 'eslint --ext .ts ../other', undefined,
    ]) {
      expect(parseEslintScript(s), String(s)).toBeNull();
    }
  });
});

describe('newLintProblems and parseNameStatus', () => {
  it('an error that only moved is not new; a second one of the same kind is', () => {
    const base = [problem(3, 'no-empty', 'Empty block statement.')];
    expect(newLintProblems([problem(40, 'no-empty', 'Empty block statement.')], base)).toEqual([]);
    expect(newLintProblems([problem(40, 'no-empty', 'Empty block statement.'), problem(50, 'no-empty', 'Empty block statement.')], base)).toHaveLength(1);
    expect(newLintProblems([problem(1, 'prefer-const', 'x')], null)).toHaveLength(1);
  });

  it('reads added, modified and renamed paths from -z output', () => {
    expect(parseNameStatus('M\0src/a.ts\0A\0src/b.ts\0R087\0src/old.ts\0src/new.ts\0')).toEqual({
      files: [
        { path: 'src/a.ts', basePath: 'src/a.ts' },
        { path: 'src/b.ts', basePath: null },
        { path: 'src/new.ts', basePath: 'src/old.ts' },
      ],
      removed: true,
    });
    expect(parseNameStatus('D\0src/gone.ts\0C100\0src/a.ts\0src/c.ts\0')).toEqual({ files: [{ path: 'src/c.ts', basePath: 'src/a.ts' }], removed: true });
    expect(parseNameStatus('M\0src/a.ts\0')).toEqual({ files: [{ path: 'src/a.ts', basePath: 'src/a.ts' }], removed: false });
    expect(parseNameStatus('')).toEqual({ files: [], removed: false });
    expect(parseNameStatus('X\0what')).toBeNull();
  });
});

describe('TaskGateRunner — the eslint step lints only what the task changed', () => {
  const touched: ChangedFile[] = [{ path: 'src/a.ts', basePath: 'src/a.ts' }];
  const old = problem(10, '@typescript-eslint/no-empty-function', 'Unexpected empty arrow function.');

  it('a task whose only lint errors are pre-existing passes, and the tests run', async () => {
    const r = runnerFor({ files: touched, head: { 'src/a.ts': [old] }, base: { 'src/a.ts': [{ ...old, line: 4 }] } });
    const res = await r.run();
    expect(res).toMatchObject({ ok: true, status: 'completed', result: { exitCode: 0 } });
    if (res.status !== 'completed') throw new Error('unreachable');
    expect(res.newLintErrors).toBeUndefined();
    expect(res.result.tail).toContain('1 error in them, 0 new');
    // HEAD's files, then the base version of the one with errors (its text on stdin).
    expect(lintRuns(r.seen).map((s) => s.argv.slice(2))).toEqual([
      ['--ext', '.ts,.tsx', '--format', 'json', '--quiet', '--', 'src/a.ts'],
      ['--ext', '.ts,.tsx', '--format', 'json', '--quiet', '--stdin', '--stdin-filename=src/a.ts'],
    ]);
    expect(lintRuns(r.seen)[1]?.stdin).toBe('// src/a.ts at base');
    expect(npmRuns(r.seen)).toEqual(['test']);
  });

  it('a task that adds one error fails, and the card names it', async () => {
    const added = problem(22, 'prefer-const', "'x' is never reassigned. Use 'const' instead.");
    const r = runnerFor({ files: touched, head: { 'src/a.ts': [old, added] }, base: { 'src/a.ts': [old] } });
    const res = await r.run();
    expect(res).toMatchObject({ ok: true, status: 'completed', result: { exitCode: 1 }, recorded: true });
    if (res.status !== 'completed') throw new Error('unreachable');
    const line = "src/a.ts:22:1 prefer-const: 'x' is never reassigned. Use 'const' instead.";
    expect(res.newLintErrors).toEqual([line]);
    expect(res.result.command).toBe(`eslint on 1 file changed since ${BASE.slice(0, 12)}`);
    expect(res.result.tail).toContain(line);
    expect(npmRuns(r.seen)).toEqual([]); // first failure stops
    const card = describeTaskGate(res);
    expect(card.notice).toEqual({ code: 'gate.failed', args: { exit: 1 } });
    expect(card.body).toContain(`- ${line}`);
    expect(card.body).not.toContain('no-empty-function');
  });

  it('a file the task added has no base: its errors are all new', async () => {
    const r = runnerFor({ files: [{ path: 'src/new.ts', basePath: null }], head: { 'src/new.ts': [old] } });
    const res = await r.run();
    expect(res).toMatchObject({ status: 'completed', result: { exitCode: 1 }, newLintErrors: [expect.stringContaining('src/new.ts:10:1')] });
    expect(lintRuns(r.seen)).toHaveLength(1);
  });

  it('a renamed file is compared with its old path at the base', async () => {
    const r = runnerFor({ files: [{ path: 'src/b.ts', basePath: 'src/old.ts' }], head: { 'src/b.ts': [old] }, base: { 'src/b.ts': [old] }, baseText: { 'src/old.ts': 'old text' } });
    expect(await r.run()).toMatchObject({ status: 'completed', result: { exitCode: 0 } });
    expect(lintRuns(r.seen)[1]?.stdin).toBe('old text');
  });

  it('eslint failing for a non-lint reason (exit 2, no report) still fails the gate', async () => {
    const r = runnerFor({ files: touched, head: { 'src/a.ts': [] }, exit: 2 });
    const res = await r.run();
    expect(res).toMatchObject({ ok: true, status: 'completed', result: { exitCode: 2 } });
    if (res.status !== 'completed') throw new Error('unreachable');
    expect(res.newLintErrors).toBeUndefined();
    expect(res.result.tail).toContain('eslint exited 2; the lint step fails');
    expect(res.result.tail).toContain('Oops! Something went wrong!');
    expect(npmRuns(r.seen)).toEqual([]);
  });

  it('a file whose name starts with a dash is linted after --', async () => {
    const r = runnerFor({ files: [{ path: '-a.ts', basePath: null }], head: { '-a.ts': [old] } });
    expect(await r.run()).toMatchObject({ status: 'completed', result: { exitCode: 1 }, newLintErrors: [expect.stringContaining('-a.ts:10:1')] });
    expect(lintRuns(r.seen)[0]?.argv.slice(-2)).toEqual(['--', '-a.ts']);
  });

  it('with a file removed, an import error in a changed file is never taken as old', async () => {
    const unresolved = problem(1, 'import/no-unresolved', "Unable to resolve path to module './b'.");
    const r = runnerFor({ files: touched, removed: true, head: { 'src/a.ts': [old, unresolved] }, base: { 'src/a.ts': [old, unresolved] } });
    const res = await r.run();
    expect(res).toMatchObject({ status: 'completed', result: { exitCode: 1 }, newLintErrors: [expect.stringContaining('import/no-unresolved')] });
    // Without a removal it is the base's own.
    const kept = runnerFor({ files: touched, head: { 'src/a.ts': [old, unresolved] }, base: { 'src/a.ts': [old, unresolved] } });
    expect(await kept.run()).toMatchObject({ status: 'completed', result: { exitCode: 0 } });
  });

  it('a report that disagrees with the exit code, or names other files, fails the step', async () => {
    for (const headOut of [
      '[]',
      JSON.stringify([{ filePath: path.join(WT, 'src/other.ts'), messages: [{ severity: 2, message: 'x', ruleId: 'r', line: 1, column: 1 }] }]),
      JSON.stringify([{ filePath: path.join(WT, 'src/a.ts'), messages: [{}] }]),
    ]) {
      // eslint said 1 (errors), the report shows none on src/a.ts.
      const r = runnerFor({ files: touched, head: { 'src/a.ts': [old] }, headOut });
      const res = await r.run();
      expect(res, headOut).toMatchObject({ status: 'completed', result: { exitCode: 2 } });
      if (res.status !== 'completed') throw new Error('unreachable');
      expect(res.result.tail).toContain('eslint gave no report on the files it was given; the lint step fails');
    }
  });

  it('a lint script npm runs with a prelint or postlint hook runs npm run lint whole', async () => {
    for (const extra of [{ prelint: 'node check.js' }, { postlint: 'node check.js' }] as Record<string, string>[]) {
      const r = runnerFor({ files: touched, head: {}, extra });
      await r.run();
      expect(lintRuns(r.seen)).toEqual([]);
      expect(npmRuns(r.seen)).toEqual(['run lint', 'test']);
    }
  });

  it('no changed file eslint lints: no eslint run, the tests still run', async () => {
    const r = runnerFor({ files: [{ path: 'README.md', basePath: 'README.md' }, { path: 'src/a.js', basePath: null }], head: {} });
    const res = await r.run();
    expect(res).toMatchObject({ status: 'completed', result: { exitCode: 0, command: expect.stringMatching(/test$/) } });
    expect(lintRuns(r.seen)).toEqual([]);
    expect(npmRuns(r.seen)).toEqual(['test']);
  });

  it('a base that cannot be read is gate_unavailable, not a pass', async () => {
    const r = runnerFor({ files: { error: 'the commit the task started from could not be read' }, head: {} });
    const res = await r.run();
    expect(res).toMatchObject({ ok: true, status: 'skipped', skipped: 'gate_unavailable' });
    expect(r.seen).toEqual([]);
    expect(r.ledger.writes).toHaveLength(0);
  });

  it('a lint script that is not plain eslint runs npm run lint whole, as before', async () => {
    const r = runnerFor({ files: touched, head: {}, lint: 'eslint --ext .ts . --max-warnings 0' });
    await r.run();
    expect(lintRuns(r.seen)).toEqual([]);
    expect(npmRuns(r.seen)).toEqual(['run lint', 'test']);
  });

  it('without a base ref the gate runs npm run lint whole', async () => {
    const seen: { argv: string[] }[] = [];
    const runner = new TaskGateRunner({
      ledger: fakeLedger(),
      spawn: fakeEslint({ head: {}, seen }),
      readPackageScripts: () => scripts,
      depsState: () => 'ok',
      readHead: async () => null,
    });
    await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    expect(npmRuns(seen)).toEqual(['run lint', 'test']);
  });
});

describe('TaskGateRunner — a linked node_modules', () => {
  it('stays a deps_missing skip, and says what to do', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gate-link-'));
    try {
      fs.mkdirSync(path.join(dir, 'other', 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'wt'));
      fs.symlinkSync(path.join(dir, 'other', 'node_modules'), path.join(dir, 'wt', 'node_modules'), 'dir');
      const ledger = fakeLedger();
      const runner = new TaskGateRunner({ ledger, spawn: fakeEslint({ head: {}, seen: [] }), readPackageScripts: () => scripts, readHead: async () => null });
      const res = await runner.run({ taskId: 'wtask-1', worktreePath: path.join(dir, 'wt'), systemWorkspaceId: 'ws-daemon' });
      expect(res).toMatchObject({ ok: true, status: 'skipped', skipped: 'deps_missing' });
      if (res.status !== 'skipped') throw new Error('unreachable');
      expect(res.detail).toContain(`(to ${path.join(dir, 'other', 'node_modules')})`);
      expect(res.detail).toContain(`in ${path.join(dir, 'wt')}, remove the link (only the link, not the folder it points to) and run npm ci`);
      expect(res.detail).toContain('send the task back');
      expect(ledger.writes).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TaskGateRunner — the changed files on a real repository', () => {
  it('diffs from the merge-base, or from a newer dispatch base HEAD holds, to the working tree', { timeout: 30_000 }, async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gate-diff-'));
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    };
    const commit = (file: string, text: string) => {
      write(file, text);
      g('add', '.');
      g('commit', '-q', '-m', file);
      return g('rev-parse', 'HEAD');
    };
    const byPath = (list: ChangedFile[]) => [...list].sort((x, y) => (x.path < y.path ? -1 : 1));
    try {
      g('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(dir, 'package.json'), pkg);
      commit('src/keep.ts', 'a\n'.repeat(20));
      const mainTip = commit('src/a.ts', 'one\n');
      // A commit off the merge-base that HEAD does not hold.
      g('checkout', '-q', '-b', 'elsewhere');
      const elsewhere = commit('src/elsewhere.ts', 'x\n');
      g('checkout', '-q', 'main');
      g('checkout', '-q', '-b', 'local');
      // A commit the task started from that `main` does not have.
      const dispatch = commit('src/local.ts', 'local\n');
      g('checkout', '-q', '-b', 'task');
      commit('src/a.ts', 'two\n');
      g('mv', 'src/keep.ts', 'src/moved.ts');
      commit('src/added.ts', 'new\n');
      // Not committed: an edit, and a new file outside .gitignore.
      write('src/added.ts', 'newer\n');
      write('src/untracked.ts', 'u\n');
      const files: ChangedFile[] = [
        { path: 'src/a.ts', basePath: 'src/a.ts' },
        { path: 'src/added.ts', basePath: null },
        { path: 'src/moved.ts', basePath: 'src/keep.ts' },
        { path: 'src/untracked.ts', basePath: null },
      ];
      const runner = new TaskGateRunner({ ledger: fakeLedger(), depsState: () => 'ok' });
      // The default changedFiles, through the runner's own seam.
      const changed = (runner as unknown as { changedFiles: (wt: string, ref: string, d?: string) => Promise<{ base: string; files: ChangedFile[]; removed?: boolean } | { error: string }> }).changedFiles;
      const sorted = async (ref: string, d?: string) => {
        const r = await changed(dir, ref, d);
        return 'files' in r ? { ...r, files: byPath(r.files) } : r;
      };
      expect(await sorted('main')).toEqual({ base: mainTip, files: byPath([...files, { path: 'src/local.ts', basePath: null }]), removed: true });
      expect(await sorted('main', dispatch)).toEqual({ base: dispatch, files, removed: true });
      // A dispatch base HEAD does not hold, or one that is not a commit, is not used.
      expect(await changed(dir, 'main', elsewhere)).toMatchObject({ base: mainTip });
      expect(await changed(dir, 'main', 'c'.repeat(40))).toMatchObject({ base: mainTip });
      expect(await changed(dir, 'no-such-ref')).toMatchObject({ error: expect.any(String) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
