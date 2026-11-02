// The worktree patterns against a real claude on macOS: a fenced worker in a
// linked worktree commits on its own branch, and cannot write a sibling
// worktree's git folder or make a new one. Runs only where WMUX_TEST_CLAUDE
// names a claude (measured on 2.1.311); it uses a home and config folder of
// its own and a local stand-in for the Messages API, no sign-in.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { shellQuote } from '../../../shared/resumeShell';
import {
  __startScriptedApiForTesting,
  readWorktreeGitFacts,
  runWorkerFenceSelfTest,
  worktreeComplementDenies,
  writeWorkerFenceHookScript,
} from '../botWorkerFence';
import { buildWorkerFence, workerFenceHookCommand } from '../workerFence';

const CLAUDE = process.env.WMUX_TEST_CLAUDE ?? '';
const live = process.platform === 'darwin' && CLAUDE !== '';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Not in the temp folder, which the sandbox lets every command write (the
// self-test's canary would land): in the checkout the tests run from.
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.wmux-fence-live-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!live)('the worktree patterns, live', () => {
  it('the self-test applies them', async () => {
    expect(await runWorkerFenceSelfTest(CLAUDE, { dir: path.join(root, 'data') })).toEqual({ ok: true, worktreePatterns: true });
  }, 120_000);

  it('the worker commits on its own branch; a sibling worktree and a new one stay closed', async () => {
    const base = root;
    let api: { url: string; close: () => void } | null = null;
    try {
      const repo = path.join(base, 'repo');
      fs.mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
      const wt = path.join(base, 'task-1');
      git(repo, 'worktree', 'add', '-q', '-b', 'wmux/task-1', wt);
      git(repo, 'worktree', 'add', '-q', '-b', 'wmux/task-2', path.join(base, 'task-2'));
      git(repo, 'branch', 'other');
      const facts = readWorktreeGitFacts(wt);
      const denies = worktreeComplementDenies(facts, 'darwin');
      expect(denies.length).toBeGreaterThan(0);
      const tmp = path.join(base, 'tmp');
      const home = path.join(base, 'home');
      const dataDir = path.join(base, 'data');
      for (const d of [tmp, home, dataDir]) fs.mkdirSync(d);
      const hookCommand = workerFenceHookCommand(process.execPath, writeWorkerFenceHookScript(dataDir), [wt, tmp]);
      if (!hookCommand) throw new Error('no hook command');
      const fence = buildWorkerFence({
        worktree: wt, workerTempDir: tmp, ...facts, platformCapable: true, repoTestWritePaths: [], permissionMode: 'bypassPermissions',
        hookCommand, credentialPaths: [], home, extraDenyWrite: denies,
      });
      const settings = path.join(base, 'settings.json');
      fs.writeFileSync(settings, JSON.stringify(fence.settings));
      const worktrees = path.join(facts.gitCommonDir, 'worktrees');
      const refsHeads = path.join(facts.gitCommonDir, 'refs', 'heads');
      const otherRefBefore = fs.readFileSync(path.join(refsHeads, 'other'), 'utf8');
      const committed = path.join(wt, 'committed');
      const control = path.join(wt, 'control');
      // Made after launch, so no snapshot names them: one per kind of pattern.
      const later = ['task', 'TASK-', 'task-12', 'task_1', '.x', 'zz', 'Task-9'];
      for (const n of later) fs.mkdirSync(path.join(worktrees, n));
      api = await __startScriptedApiForTesting([
        `git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m work && touch ${shellQuote(committed)}`,
        // The common dir is open to commands (claude's own rule for a linked worktree).
        `touch ${shellQuote(path.join(facts.gitCommonDir, 'control'))} && touch ${shellQuote(control)}`,
        `touch ${shellQuote(path.join(worktrees, 'task-2', 'probe'))}`,
        ...later.map((n) => `touch ${shellQuote(path.join(worktrees, n, 'probe'))}`),
        `mkdir ${shellQuote(path.join(worktrees, 'added'))}`,
        // Ancestor directories of denied paths can't be renamed either: the
        // profile denies create/unlink on every ancestor, so moving the
        // `worktrees` dir away (and writing a sibling via the moved path)
        // stays closed. A move back is denied too.
        `mv ${shellQuote(worktrees)} ${shellQuote(path.join(facts.gitCommonDir, 'wt-moved'))} && touch ${shellQuote(path.join(wt, 'renamed'))}`,
        `touch ${shellQuote(path.join(facts.gitCommonDir, 'wt-moved', 'task-2', 'probe'))}`,
        // The same for `refs/heads`: an ancestor of each other branch's denied
        // ref file, so it can't be renamed to reach a denied ref through it.
        `mv ${shellQuote(refsHeads)} ${shellQuote(path.join(facts.gitCommonDir, 'refs', 'h2'))} && touch ${shellQuote(path.join(wt, 'renamed-refs'))}`,
        `echo x >> ${shellQuote(path.join(facts.gitCommonDir, 'refs', 'h2', 'other'))}`,
      ].join('; '));
      const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_CODE_TMPDIR: tmp,
        ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'wmux-fence-live-test', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      };
      await new Promise<void>((resolve) => {
        const child = spawn(CLAUDE, ['-p', 'go', '--dangerously-skip-permissions', '--setting-sources', 'project', '--settings', settings,
          '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '2', '--output-format', 'json'], { cwd: wt, env, stdio: 'ignore' });
        child.on('close', () => resolve());
      });
      expect(fs.existsSync(committed)).toBe(true);
      expect(git(wt, 'log', '-1', '--format=%s').trim()).toBe('work');
      expect(fs.existsSync(control)).toBe(true);
      expect(fs.existsSync(path.join(worktrees, 'task-2', 'probe'))).toBe(false);
      for (const n of later) expect(fs.existsSync(path.join(worktrees, n, 'probe')), n).toBe(false);
      expect(fs.existsSync(path.join(worktrees, 'added'))).toBe(false);
      // The rename of the ancestor dir did not happen, and nothing leaked through a moved path.
      expect(fs.existsSync(path.join(wt, 'renamed'))).toBe(false);
      expect(fs.existsSync(path.join(facts.gitCommonDir, 'wt-moved'))).toBe(false);
      expect(fs.existsSync(path.join(worktrees, 'task-2'))).toBe(true);
      // refs/heads is unmoved and another branch's ref is untouched.
      expect(fs.existsSync(path.join(wt, 'renamed-refs'))).toBe(false);
      expect(fs.existsSync(path.join(facts.gitCommonDir, 'refs', 'h2'))).toBe(false);
      expect(fs.readFileSync(path.join(refsHeads, 'other'), 'utf8')).toBe(otherRefBefore);
    } finally {
      api?.close();
    }
  }, 120_000);
});
