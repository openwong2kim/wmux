// The worker fence on a bot's worker launch (botWorkerFence.ts), through the
// merge-lane guard's own stages (botWorkerMergeGuard.ts): the settings file
// it writes, what refuses a launch, a resume and a re-fire, the platform's
// strength, the off switch and the self-test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  guardRefireLine,
  guardSessionLaunch,
  guardedLaunchOf,
  isFencedBotWorkerSession,
  noteBotWorkerSession,
  noteGuardedLaunchTyped,
  reloadBotWorkerSessionsForTests,
  withBotWorkerMergeGuard,
  type BotWorkerGuardDeps,
} from '../botWorkerMergeGuard';
import {
  __resetWorkerFenceSupportForTesting,
  WORKER_FENCE_SELF_TEST_RETRY_MS,
  claudeTempDenies,
  workerFenceDataDirSecrets,
  workerFenceSupportFor,
  fenceLauncher,
  linePermissionMode,
  readWorktreeGitFacts,
  runWorkerFenceSelfTest,
  workerFenceFolderRefusal,
  workerFenceSupport,
  worktreeComplementDenies,
  WORKER_FENCE_SELF_TEST_WORKTREE,
  type WorkerFenceSupport,
} from '../botWorkerFence';
import { getWorkerFencePolicyPath, isWorkerFenceOff, setWorkerFenceOff } from '../workerFencePolicy';
import { BOT_WORKER_DENY } from '../../../shared/botWorkerGuard';
import { wslClaudeHooks } from '../../../shared/wslIntegration';
import { plainStartFailure } from '../../factory/botNotices';

const isWin = process.platform === 'win32';
const RUNTIME = '/opt/wmux/wmux';
const BRIDGE = '/opt/wmux/hooks/wmux-bridge.mjs';
const EXE = '/opt/claude/bin/claude';
const FULL: WorkerFenceSupport = { capable: true, exe: EXE, version: '2.1.311', selfTest: { ok: true } };
const WEAK: WorkerFenceSupport = { capable: false, reason: 'bots do not run commands on win32' };
const LINE = 'claude --dangerously-skip-permissions -p hi';

let root: string;
let dir: string;
let home: string;
let repo: string;
let wt: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fence-')));
  dir = path.join(root, 'data');
  home = path.join(root, 'home');
  repo = path.join(root, 'repo');
  fs.mkdirSync(dir);
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'branch', 'other');
  wt = path.join(dir, 'worktrees', 'task-1');
  git(repo, 'worktree', 'add', '-q', '-b', 'wmux/task-1', wt);
  git(repo, 'worktree', 'add', '-q', '-b', 'wmux/task-2', path.join(dir, 'worktrees', 'task-2'));
  reloadBotWorkerSessionsForTests();
  __resetWorkerFenceSupportForTesting();
});
afterEach(() => {
  reloadBotWorkerSessionsForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function deps(over: Partial<BotWorkerGuardDeps> = {}): BotWorkerGuardDeps {
  return {
    dir,
    mcpEntry: () => '/opt/wmux/mcp/index.js',
    registeredLevel: () => null,
    isolatedBridge: () => null,
    bridge: () => BRIDGE,
    fenceSupport: FULL,
    taskFacts: () => ({ ownerWorkspaceId: 'ws-bot' }),
    fence: { runtime: RUNTIME, home, env: {} },
    ...over,
  };
}

const settingsOf = (line: string): Record<string, unknown> => {
  const m = /--settings="([^"]+)"/.exec(line);
  if (!m) throw new Error(`no settings: ${line}`);
  return JSON.parse(fs.readFileSync(m[1], 'utf8')) as Record<string, unknown>;
};
const hooksOf = (s: Record<string, unknown>) => s.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
const create = (line: string, d: BotWorkerGuardDeps = deps(), cwd = wt) =>
  withBotWorkerMergeGuard({ initialCommand: line, cwd }, { workspaceId: 'ws-task', strict: true }, d);
const refusalOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('not refused');
};

describe.skipIf(isWin)('a fenced launch', () => {
  it('writes one settings file: the fence first, the worker rules, wmux\'s status hooks, and no user settings', () => {
    const out = create(LINE);
    const line = out!.initialCommand!;
    // The full fence runs the claude its self-test ran, loading only project settings.
    expect(line.startsWith(`${EXE} --settings="`)).toBe(true);
    expect(line).toContain('--setting-sources=project');
    const s = settingsOf(line);
    const sandbox = s.sandbox as { enabled: boolean; filesystem: { allowWrite: string[]; denyWrite: string[] } };
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.filesystem.allowWrite).toContain(fs.realpathSync(wt));
    // The other worktree's metadata and the other branches are closed.
    const common = fs.realpathSync(path.join(repo, '.git'));
    expect(sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([path.join(common, 'worktrees', 'task-2'), path.join(common, 'refs', 'heads', 'other'), path.join(common, 'refs', 'heads', 'main')]));
    expect(sandbox.filesystem.denyWrite).not.toContain(path.join(common, 'refs', 'heads', 'wmux', 'task-1'));
    const deny = (s.permissions as { deny: string[] }).deny;
    expect(deny).toEqual(expect.arrayContaining([...BOT_WORKER_DENY, 'Read(~/.ssh/**)']));
    const hooks = hooksOf(s);
    // The fence's hook leads, on this build's runtime, rooted at the worktree.
    expect(hooks.PreToolUse[0].matcher).toBe('.*');
    expect(hooks.PreToolUse[0].hooks[0].command).toMatch(new RegExp(`^ELECTRON_RUN_AS_NODE=1 "${RUNTIME}" "[^"]+worker-hooks/[0-9a-f]{12}\\.cjs" "${fs.realpathSync(wt)}" "[^"]+worker-tmp/[0-9a-f]{32}" \\|\\| exit 2$`));
    // wmux's status hooks come from this file (user settings are not loaded).
    for (const event of ['SessionStart', 'Stop', 'UserPromptSubmit']) {
      expect(hooks[event].some((g) => g.hooks.some((h) => h.command.includes(BRIDGE))), event).toBe(true);
    }
    expect(s.disableAllHooks).toBe(false);
    expect(s).not.toHaveProperty('statusLine');
    // The record keeps the fence and its temp folder.
    const files = guardedLaunchOf(out).launch!;
    expect(files.fence?.strength).toBe('full');
    expect(path.dirname(files.fence!.tempDir!)).toBe(path.join(dir, 'factory', 'worker-tmp'));
    expect(files.settingSources).toBe('project');
  });

  it('a WSL pane: the worker rules with the WSL hooks, the permission denies and the weaker marker', () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const out = withBotWorkerMergeGuard({ initialCommand: LINE }, { workspaceId: 'ws-task', strict: true }, deps({ wslRuntime: () => RUNTIME }), { wsl: true });
    const s = settingsOf(out!.initialCommand!);
    const hooks = hooksOf(s);
    for (const [event, groups] of Object.entries(wslClaudeHooks())) {
      for (const g of groups) expect(hooks[event], event).toContainEqual(g);
    }
    expect((s.permissions as { deny: string[] }).deny).toEqual(expect.arrayContaining([...BOT_WORKER_DENY, 'Read(~/.ssh/**)']));
    expect(s).not.toHaveProperty('sandbox');
    expect(JSON.stringify(s.statusLine)).toContain('weaker worker fence');
    expect(guardedLaunchOf(out).launch?.fence).toEqual({ strength: 'weaker' });
  });

  it('a line that does not run unattended is not fenced', () => {
    for (const line of ['claude -p hi', 'claude --permission-mode acceptEdits -p hi', 'claude --permission-mode plan']) {
      const s = settingsOf(create(line)!.initialCommand!);
      expect(s, line).not.toHaveProperty('sandbox');
      expect(guardedLaunchOf(create(line)).launch?.fence, line).toBeUndefined();
    }
    expect(linePermissionMode('claude --permission-mode auto')).toBe('auto');
    // The skip flag wins over a later mode, as it does for claude.
    expect(linePermissionMode('claude --dangerously-skip-permissions --permission-mode default')).toBe('bypassPermissions');
    // Words inside a quoted argument never turn an unattended mode off.
    expect(linePermissionMode('claude --permission-mode bypassPermissions --append-system-prompt "never use --permission-mode default"')).toBe('bypassPermissions');
    expect(linePermissionMode('claude --permission-mode=bypassPermissions')).toBe('bypassPermissions');
    expect(settingsOf(create('claude --permission-mode auto -p hi')!.initialCommand!)).toHaveProperty('sandbox');
  });

  it('a line with no mode flag is fenced when its settings start it unattended', () => {
    fs.mkdirSync(path.join(wt, '.claude'));
    fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    expect(settingsOf(create('claude -p hi')!.initialCommand!)).toHaveProperty('sandbox');
    fs.unlinkSync(path.join(wt, '.claude', 'settings.local.json'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    expect(settingsOf(create('claude -p hi')!.initialCommand!)).toHaveProperty('sandbox');
  });

  it('carries how the worker reaches its model from the user settings it no longer loads', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', env: { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_TMPDIR: '/tmp/x', SANDBOX_X: '1' }, hooks: { Stop: [] }, permissions: { allow: ['Write(//**)'] } }));
    const s = settingsOf(create(LINE)!.initialCommand!);
    expect(s.model).toBe('opus');
    const env = s.env as Record<string, string>;
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.CLAUDE_CODE_TMPDIR).toMatch(/worker-tmp\/[0-9a-f]{32}$/);
    expect(env).not.toHaveProperty('SANDBOX_X');
    expect((s.permissions as { allow?: string[] }).allow ?? []).not.toContain('Write(//**)');
  });

  it('a claude whose path a shell would split runs through a plain link to it', () => {
    const spaced = path.join(root, 'Application Support', 'bin', 'claude');
    const link = fenceLauncher(dir, spaced)!;
    expect(link).toMatch(/\/factory\/claude-bin\/[0-9a-f]{12}\/claude$/);
    expect(fs.readlinkSync(link)).toBe(spaced);
    expect(fenceLauncher(dir, spaced)).toBe(link);
    expect(fenceLauncher(dir, EXE)).toBe(EXE);
    const line = create(LINE, deps({ fenceSupport: { ...FULL, exe: spaced } }))!.initialCommand!;
    expect(line.startsWith(`${link} --settings="`)).toBe(true);
  });
});

describe.skipIf(isWin)('what refuses a fenced launch, in words that reach the owner', () => {
  const card = (msg: string) => plainStartFailure(`renderer spawn failed: Error invoking remote method 'pty:create': Error: ${msg}`);

  it('a wrapper, a line of its own settings, --add-dir, a launcher that is not claude', () => {
    const cases: Array<[string, RegExp]> = [
      [`env FOO=1 ${LINE}`, /through another program/],
      [`sh -c "${LINE}"`, /through another program/],
      [`${LINE} --settings=/tmp/mine.json`, /its own --settings/],
      [`${LINE} --add-dir /etc`, /--add-dir/],
      ['node run.js --dangerously-skip-permissions', /does not start claude/],
    ];
    for (const [line, why] of cases) {
      const msg = refusalOf(() => create(line));
      expect(msg, line).toMatch(/^PTY_CREATE: worker fence: /);
      expect(msg, line).toMatch(why);
      expect(card(msg), line).toMatch(/^worker fence: /);
    }
  });

  it('project settings that would loosen the fence', () => {
    fs.mkdirSync(path.join(wt, '.claude'));
    const settings = path.join(wt, '.claude', 'settings.json');
    for (const [doc, why] of [
      [{ sandbox: { enabled: false } }, /sets sandbox/],
      [{ disableAllHooks: true }, /sets disableAllHooks/],
      [{ permissions: { additionalDirectories: ['/'] } }, /permissions\.additionalDirectories/],
      [{ permissions: { allow: ['Edit(//etc/**)'] } }, /allows a file tool/],
    ] as const) {
      fs.writeFileSync(settings, JSON.stringify(doc));
      const msg = refusalOf(() => create(LINE));
      expect(msg).toMatch(/^PTY_CREATE: worker fence: /);
      expect(msg).toMatch(why);
    }
    fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
    expect(() => create(LINE)).not.toThrow();
  });

  it('a .claude or .mcp.json that links out of the worktree, at launch and at resume', () => {
    const outside = path.join(root, 'planted');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(wt, '.claude'));
    expect(workerFenceFolderRefusal(wt)).toBe('.claude is a link out of the worktree');
    expect(refusalOf(() => create(LINE))).toMatch(/worker fence: \.claude is a link out of the worktree/);
    fs.unlinkSync(path.join(wt, '.claude'));
    const out = create(LINE);
    noteBotWorkerSession('pty-1', 'ws-task', dir, guardedLaunchOf(out));
    // A command inside the fence swapped it for a link: the resume is refused.
    fs.symlinkSync(path.join(outside, 'mcp.json'), path.join(wt, '.mcp.json'));
    expect(refusalOf(() => guardSessionLaunch('pty-1', 'claude --resume 11111111-2222-3333-4444-555555555555 --dangerously-skip-permissions', deps()))).toMatch(/worker fence: \.mcp\.json is a link that leads nowhere/);
    // A link inside the worktree is its own business.
    fs.unlinkSync(path.join(wt, '.mcp.json'));
    fs.writeFileSync(path.join(wt, 'mcp.real.json'), '{}');
    fs.symlinkSync(path.join(wt, 'mcp.real.json'), path.join(wt, '.mcp.json'));
    expect(workerFenceFolderRefusal(wt)).toBeNull();
  });

  it('a worktree that is not the repository its task was started in', () => {
    const msg = refusalOf(() => create(LINE, deps({ taskFacts: () => ({ ownerWorkspaceId: 'ws-bot', gitCommonDir: path.join(root, 'elsewhere', '.git') }) })));
    expect(msg).toMatch(/worker fence: the worktree's repository is not the one its task was started in/);
  });
});

describe.skipIf(isWin)('a resume and a re-fire keep the fence', () => {
  const RESUME = 'claude --resume 11111111-2222-3333-4444-555555555555 --dangerously-skip-permissions';

  it('the same fence, the same temp folder, after a restart', () => {
    const first = create(LINE);
    const files = guardedLaunchOf(first).launch!;
    noteBotWorkerSession('pty-1', 'ws-task', dir, guardedLaunchOf(first));
    reloadBotWorkerSessionsForTests();
    for (const line of [guardSessionLaunch('pty-1', RESUME, deps()), guardRefireLine('pty-1', LINE, deps())]) {
      const s = settingsOf(line);
      expect((s.sandbox as { enabled: boolean }).enabled).toBe(true);
      expect(hooksOf(s).PreToolUse[0].hooks[0].command).toContain(`"${files.fence!.tempDir}"`);
      expect(line.startsWith(`${EXE} `)).toBe(true);
    }
  });

  it('the branch is the one the first launch recorded: a HEAD on another branch refuses the resume and the re-fire', () => {
    const first = create(LINE);
    expect(guardedLaunchOf(first).launch!.fence!.branch).toBe('wmux/task-1');
    noteBotWorkerSession('pty-1', 'ws-task', dir, guardedLaunchOf(first));
    reloadBotWorkerSessionsForTests();
    // The pipe refuses this pane what its fence refuses (RpcRouter.ts).
    expect(isFencedBotWorkerSession('pty-1', dir)).toBe(true);
    expect(isFencedBotWorkerSession('pty-2', dir)).toBe(false);
    git(wt, 'checkout', '-q', 'other');
    expect(refusalOf(() => guardSessionLaunch('pty-1', RESUME, deps()))).toMatch(/worker fence: the worktree is on branch other, not on branch wmux\/task-1 it started on/);
    expect(refusalOf(() => guardRefireLine('pty-1', LINE, deps()))).toMatch(/worker fence: the worktree is on branch other/);
    git(wt, 'checkout', '-q', '--detach');
    expect(refusalOf(() => guardSessionLaunch('pty-1', RESUME, deps()))).toMatch(/worker fence: the worktree is on a detached HEAD, not on branch wmux\/task-1/);
    git(wt, 'checkout', '-q', 'wmux/task-1');
    const s = settingsOf(guardSessionLaunch('pty-1', RESUME, deps()));
    const fsx = (s.sandbox as { filesystem: { allowWrite: string[]; denyWrite: string[] } }).filesystem;
    const common = fs.realpathSync(path.join(repo, '.git'));
    expect(fsx.allowWrite).toContain(path.join(common, 'refs', 'heads', 'wmux'));
    expect(fsx.allowWrite).not.toContain(common);
    expect(fsx.denyWrite).toContain(path.join(common, 'worktrees', 'task-1', 'HEAD'));
    expect(fsx.denyWrite).toContain(path.join(common, 'refs', 'heads', 'other'));
  });

  it('a fenced record with no branch refuses the resume', () => {
    const first = create(LINE);
    const launch = guardedLaunchOf(first);
    noteBotWorkerSession('pty-1', 'ws-task', dir, { ...launch, launch: { ...launch.launch!, fence: { strength: 'full', tempDir: launch.launch!.fence!.tempDir } } });
    reloadBotWorkerSessionsForTests();
    expect(refusalOf(() => guardSessionLaunch('pty-1', RESUME, deps()))).toMatch(/worker fence: the worker's branch was not recorded at its first launch/);
  });

  it('a branch kept only in packed-refs: its ref and reflog folders are made before launch', () => {
    git(repo, 'pack-refs', '--all');
    const common = fs.realpathSync(path.join(repo, '.git'));
    fs.rmSync(path.join(common, 'logs', 'refs', 'heads', 'wmux'), { recursive: true, force: true });
    expect(fs.existsSync(path.join(common, 'refs', 'heads', 'wmux', 'task-1'))).toBe(false);
    create(LINE);
    expect(fs.statSync(path.join(common, 'refs', 'heads', 'wmux')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(common, 'logs', 'refs', 'heads', 'wmux')).isDirectory()).toBe(true);
  });

  it('on Linux the git denies name only paths that exist; elsewhere all of them', () => {
    git(repo, 'pack-refs', '--all');
    const common = fs.realpathSync(path.join(repo, '.git'));
    const denyOf = (platform: NodeJS.Platform) => {
      const s = settingsOf(create(LINE, deps({ fence: { runtime: RUNTIME, home, env: {}, platform, claudeTempRoots: [] } }))!.initialCommand!);
      return (s.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite;
    };
    const packedOnly = path.join(common, 'refs', 'heads', 'other');
    expect(denyOf('darwin')).toContain(packedOnly);
    expect(denyOf('darwin')).toContain(path.join(common, 'shallow'));
    const linux = denyOf('linux');
    expect(linux).not.toContain(packedOnly);
    expect(linux).not.toContain(path.join(common, 'shallow'));
    expect(linux).toContain(path.join(common, 'config'));
    expect(linux).toContain(path.join(common, 'packed-refs'));
  });

  it('on Linux, a packed-only branch in the worker\'s ref folder is written loose before launch and keeps its deny', () => {
    git(repo, 'pack-refs', '--all');
    const common = fs.realpathSync(path.join(repo, '.git'));
    const sibling = path.join(common, 'refs', 'heads', 'wmux', 'task-2');
    const sha = git(repo, 'rev-parse', 'wmux/task-2').trim();
    expect(fs.existsSync(sibling)).toBe(false);
    const linux = deps({ fence: { runtime: RUNTIME, home, env: {}, platform: 'linux', claudeTempRoots: [] } });
    // Git holds the ref's lock: refused, the lock left alone.
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(`${sibling}.lock`, '');
    expect(refusalOf(() => create(LINE, linux))).toMatch(/worker fence: branch wmux\/task-2, kept only in packed-refs, could not be written as its own ref file before launch/);
    expect(fs.existsSync(`${sibling}.lock`)).toBe(true);
    fs.unlinkSync(`${sibling}.lock`);
    const s = settingsOf(create(LINE, linux)!.initialCommand!);
    expect(fs.readFileSync(sibling, 'utf8')).toBe(`${sha}\n`);
    expect(git(repo, 'rev-parse', 'wmux/task-2').trim()).toBe(sha);
    const deny = (s.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite;
    expect(deny).toContain(sibling);
    // Outside the worker's ref folder: left packed (nothing there is writable).
    expect(fs.existsSync(path.join(common, 'refs', 'heads', 'other'))).toBe(false);
    expect(git(repo, 'status', '--short')).toBe('');
  });

  it('a session main fenced stays fenced for the pipe while the record is unreadable; an unknown pane does not', () => {
    const first = create(LINE);
    noteBotWorkerSession('pty-1', 'ws-task', dir, guardedLaunchOf(first));
    fs.writeFileSync(path.join(dir, 'factory', 'bot-worker-sessions.json'), '{ not json');
    reloadBotWorkerSessionsForTests({ keepFenced: true });
    expect(isFencedBotWorkerSession('pty-1', dir)).toBe(true);
    expect(isFencedBotWorkerSession('pty-9', dir)).toBe(false);
    // A restart reads the record again: an unreadable one adds no pane.
    reloadBotWorkerSessionsForTests();
    expect(isFencedBotWorkerSession('pty-1', dir)).toBe(false);
  });

  it('never weaker than its first launch: the switch turned off later, or the platform no longer capable', async () => {
    const first = create(LINE);
    noteBotWorkerSession('pty-1', 'ws-task', dir, guardedLaunchOf(first));
    await setWorkerFenceOff('ws-bot', true, dir);
    expect((settingsOf(guardSessionLaunch('pty-1', RESUME, deps())).sandbox as { enabled: boolean }).enabled).toBe(true);
    expect(refusalOf(() => guardSessionLaunch('pty-1', RESUME, deps({ fenceSupport: WEAK })))).toMatch(/worker fence: this worker started inside the full fence, which cannot run now/);
  });

  it('a session that started with the fence off is fenced again once it is back on, and stays fenced', async () => {
    await setWorkerFenceOff('ws-bot', true, dir);
    const first = create(LINE);
    expect(guardedLaunchOf(first).launch?.fence).toEqual({ strength: 'off' });
    noteBotWorkerSession('pty-1', 'ws-task', dir, guardedLaunchOf(first));
    await setWorkerFenceOff('ws-bot', false, dir);
    const fenced = guardSessionLaunch('pty-1', RESUME, deps());
    expect(settingsOf(fenced)).toHaveProperty('sandbox');
    // Recorded only once the line is typed (and only that line).
    const recFence = () => JSON.parse(fs.readFileSync(path.join(dir, 'factory', 'bot-worker-sessions.json'), 'utf8')).sessions['pty-1'].launch?.fence;
    expect(recFence()).toEqual({ strength: 'off' });
    noteGuardedLaunchTyped('pty-1', 'claude --resume other');
    expect(recFence()).toEqual({ strength: 'off' });
    noteGuardedLaunchTyped('pty-1', fenced);
    expect(recFence().strength).toBe('full');
    // Recorded: off again, a later resume keeps the fence and its temp folder.
    await setWorkerFenceOff('ws-bot', true, dir);
    reloadBotWorkerSessionsForTests();
    const again = guardRefireLine('pty-1', LINE, deps());
    expect(settingsOf(again)).toHaveProperty('sandbox');
    // The record names the fenced files the running claude reads.
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'factory', 'bot-worker-sessions.json'), 'utf8')).sessions['pty-1'];
    expect(rec.launch.fence.strength).toBe('full');
    expect(fenced).toContain(`--settings="${rec.launch.settingsFile}"`);
    const temp = (line: string) => /"([^"]+worker-tmp\/[0-9a-f]{32})"/.exec(hooksOf(settingsOf(line)).PreToolUse[0].hooks[0].command)?.[1];
    expect(temp(again)).toBe(temp(fenced));
  });
});

describe.skipIf(isWin)('the platform decides the strength', () => {
  it('without the OS sandbox: the hook and the permission denies, and the weaker marker', () => {
    const out = create(LINE, deps({ fenceSupport: WEAK }));
    const line = out!.initialCommand!;
    // The pane's own claude: not pinned to a checked binary.
    expect(line.startsWith('claude --settings="')).toBe(true);
    const s = settingsOf(line);
    expect(s).not.toHaveProperty('sandbox');
    expect(hooksOf(s).PreToolUse[0].matcher).toBe('.*');
    expect(JSON.stringify(s.statusLine)).toContain('weaker worker fence: no OS sandbox here (bots do not run commands on win32)');
    expect(guardedLaunchOf(out).launch?.fence?.strength).toBe('weaker');
  });

  it('a launch before the support was checked is refused, not run unfenced', () => {
    expect(refusalOf(() => create(LINE, deps({ fenceSupport: null })))).toMatch(/worker fence: this computer's fence support was not checked yet/);
  });
});

describe.skipIf(isWin)('the off switch', () => {
  it('only a literal true under a workspace turns it off; anything unreadable leaves it on', async () => {
    expect(isWorkerFenceOff('ws-bot', dir)).toBe(false);
    expect(await setWorkerFenceOff('ws-bot', 'yes', dir)).toBe(false);
    expect(await setWorkerFenceOff('ws-bot', true, dir)).toBe(true);
    expect(isWorkerFenceOff('ws-bot', dir)).toBe(true);
    expect(isWorkerFenceOff('ws-other', dir)).toBe(false);
    fs.writeFileSync(getWorkerFencePolicyPath(dir), JSON.stringify({ off: { 'ws-bot': 'true', 'ws-x': 1 } }));
    expect(isWorkerFenceOff('ws-bot', dir)).toBe(false);
    fs.writeFileSync(getWorkerFencePolicyPath(dir), '{not json');
    expect(isWorkerFenceOff('ws-bot', dir)).toBe(false);
    // Quick toggles land in order: the last one wins.
    await Promise.all([setWorkerFenceOff('ws-bot', true, dir), setWorkerFenceOff('ws-bot', false, dir), setWorkerFenceOff('ws-2', true, dir)]);
    expect(isWorkerFenceOff('ws-bot', dir)).toBe(false);
    expect(isWorkerFenceOff('ws-2', dir)).toBe(true);
  });

  it('a worker launched while it is off is unfenced and says so in its pane', async () => {
    await setWorkerFenceOff('ws-bot', true, dir);
    const s = settingsOf(create(LINE)!.initialCommand!);
    expect(s).not.toHaveProperty('sandbox');
    expect(JSON.stringify(s.statusLine)).toContain('the worker fence is off for this workspace');
    // The fan-out's own owner workspace is the one asked.
    const other = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: wt }, { workspaceId: 'ws-task', strict: true, ownerWorkspaceId: 'ws-elsewhere' }, deps());
    expect(settingsOf(other!.initialCommand!)).toHaveProperty('sandbox');
  });
});

describe.skipIf(isWin)('the self-test', () => {
  it('a failed self-test: the worker starts with no tools, and its pane says why', () => {
    const failed: WorkerFenceSupport = { ...FULL, selfTest: { ok: false, reason: 'a command wrote outside the fence\'s folders, so the OS sandbox is not holding' } };
    const s = settingsOf(create(LINE, deps({ fenceSupport: failed }))!.initialCommand!);
    const first = hooksOf(s).PreToolUse[0];
    expect(first.matcher).toBe('.*');
    expect(first.hooks[0].command).toMatch(/^echo 'wmux fence: the fence failed its self-test, so this worker has no tools \(a command wrote outside .*\)' >&2; exit 2$/);
    expect(JSON.stringify(s.statusLine)).toContain('the fence failed its self-test, so this worker has no tools');
  });

  it('a self-test that did not finish is run once more at once; still unfinished, the launch is refused and nothing is kept', async () => {
    let runs = 0;
    const d = { exe: () => EXE, platform: 'darwin' as const, probe: async () => ({ ok: true as const, version: '2.1.311' }), selfTest: async () => { runs += 1; return { ok: false as const, reason: 'claude did not run a command inside the fence (timed out)', transient: true as const }; } };
    const support = await workerFenceSupport(d);
    expect(runs).toBe(2);
    expect(refusalOf(() => create(LINE, deps({ fenceSupport: support })))).toMatch(/worker fence: the fence's self-test did not finish \(claude did not run a command inside the fence \(timed out\)\); try again/);
    await workerFenceSupport(d);
    expect(runs).toBe(4);
    // A second run that finishes is what counts.
    let n = 0;
    const flaky = await workerFenceSupport({ ...d, exe: () => '/opt/other/claude', selfTest: async () => (++n === 1 ? { ok: false as const, reason: 'x', transient: true as const } : { ok: true as const }) });
    expect(flaky.capable && flaky.selfTest.ok).toBe(true);
  });

  it('a pass whose pattern run did not finish is kept a few minutes, then tried again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let runs = 0;
    const asked: Array<boolean | undefined> = [];
    const d = {
      exe: () => EXE, platform: 'darwin' as const, probe: async () => ({ ok: true as const, version: '2.1.311' }),
      selfTest: async (_exe: string, o?: { patternsOnly?: boolean }) => {
        runs += 1;
        asked.push(o?.patternsOnly);
        return runs === 1 ? { ok: true as const, patternsRetry: true as const } : { ok: true as const, worktreePatterns: true as const };
      },
    };
    try {
      await workerFenceSupport(d);
      await workerFenceSupport(d);
      expect(runs).toBe(1);
      vi.setSystemTime(Date.now() + WORKER_FENCE_SELF_TEST_RETRY_MS + 1);
      const after = await workerFenceSupport(d);
      expect(runs).toBe(2);
      expect(after.capable && after.selfTest).toEqual({ ok: true, worktreePatterns: true });
      await workerFenceSupport(d);
      expect(runs).toBe(2);
      // The retry is the pattern run alone: the plain run passed already.
      expect(asked).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pattern run alone never fails the self-test, whatever it finds', async () => {
    const fake = path.join(root, 'fake-none');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await runWorkerFenceSelfTest(fake, { dir, runtime: RUNTIME, timeoutMs: 10_000, platform: 'darwin', patternsOnly: true, log: () => undefined, paneEnv: async () => ({ PATH: '/usr/bin:/bin' }) })).toEqual({ ok: true });
  });

  it('an attended line asks for no fence support at all', async () => {
    expect(await workerFenceSupportFor('claude -p hi', wt, { probe: async () => { throw new Error('probed'); } })).toBeUndefined();
    expect(await workerFenceSupportFor('ls -la', wt)).toBeUndefined();
  });

  it('a pass is kept for the session; a failure stands a few minutes, then is tried again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let runs = 0;
    let result: { ok: true } | { ok: false; reason: string } = { ok: false, reason: 'x' };
    const d = { exe: () => EXE, platform: 'darwin' as const, probe: async () => ({ ok: true as const, version: '2.1.311' }), selfTest: async () => { runs += 1; return result; } };
    try {
      expect((await workerFenceSupport(d)).capable).toBe(true);
      await workerFenceSupport(d);
      expect(runs).toBe(1);
      result = { ok: true };
      vi.setSystemTime(Date.now() + WORKER_FENCE_SELF_TEST_RETRY_MS + 1);
      await workerFenceSupport(d);
      await workerFenceSupport(d);
      expect(runs).toBe(2);
    } finally {
      vi.useRealTimers();
    }
    // No sandbox on the platform, or a claude too old for it: the weaker fence.
    expect(await workerFenceSupport({ ...d, probe: async () => ({ ok: false as const, reason: 'no bwrap' }), platformRefusal: () => 'no bwrap' })).toEqual({ capable: false, reason: 'no bwrap' });
    expect(await workerFenceSupport({ ...d, probe: async () => ({ ok: false as const, reason: 'Claude Code 2.1.100 is older than 2.1.246' }), platformRefusal: () => null })).toEqual({ capable: false, reason: 'Claude Code 2.1.100 is older than 2.1.246' });
    // A platform that has the sandbox whose check did not finish: no launch at all.
    const flaky = await workerFenceSupport({ ...d, probe: async () => ({ ok: false as const, reason: 'claude --version failed: timed out' }), platformRefusal: () => null });
    expect(flaky).toEqual({ capable: false, reason: 'claude --version failed: timed out', transient: true });
    expect(refusalOf(() => create(LINE, deps({ fenceSupport: flaky })))).toMatch(/worker fence: this computer has the OS sandbox, but the fence cannot start now \(claude --version failed: timed out\); try again/);
    // No claude found on such a platform: refused, not weakened, and checked again next time.
    const none = await workerFenceSupport({ ...d, exe: () => null, probe: async () => ({ ok: false as const, reason: 'no claude executable' }), platformRefusal: () => null });
    expect(none).toEqual({ capable: false, reason: 'no claude executable', transient: true });
    expect(refusalOf(() => create(LINE, deps({ fenceSupport: none })))).toMatch(/worker fence: this computer has the OS sandbox, but the fence cannot start now \(no claude executable\); try again/);
    expect(await workerFenceSupport({ ...d, exe: () => null, probe: async () => ({ ok: true as const, version: '2.1.311' }), platformRefusal: () => null })).toMatchObject({ capable: false, transient: true });
    expect((await workerFenceSupport(d)).capable).toBe(true);
  });

  it('a claude that runs no command fails it, and its files are removed', async () => {
    const fake = path.join(root, 'fake-claude');
    fs.writeFileSync(fake, '#!/bin/sh\necho "sandbox unavailable" >&2\nexit 1\n', { mode: 0o755 });
    const r = await runWorkerFenceSelfTest(fake, { dir, runtime: RUNTIME, timeoutMs: 10_000, paneEnv: async () => ({ PATH: '/usr/bin:/bin' }) });
    expect(r).toEqual({ ok: false, reason: 'claude did not run a command inside the fence (sandbox unavailable)' });
    expect(fs.readdirSync(path.join(dir, 'factory', 'fence-self-test'))).toEqual([]);
  });

  it('a claude that does not end is stopped at the deadline', async () => {
    const fake = path.join(root, 'slow-claude');
    fs.writeFileSync(fake, '#!/bin/sh\nsleep 30 &\nwait\n', { mode: 0o755 });
    const r = await runWorkerFenceSelfTest(fake, { dir, runtime: RUNTIME, timeoutMs: 500, paneEnv: async () => ({ PATH: '/usr/bin:/bin' }) });
    expect(r).toEqual({ ok: false, reason: 'claude did not run a command inside the fence (timed out)', transient: true });
  });
});

describe.skipIf(isWin)('the worktree patterns on macOS', () => {
  const darwin = { runtime: RUNTIME, home, env: {}, platform: 'darwin' as const, claudeTempRoots: [] };
  const denyOf = (support: WorkerFenceSupport, platform: NodeJS.Platform = 'darwin') =>
    (settingsOf(create(LINE, deps({ fenceSupport: support, fence: { ...darwin, home, platform } }))?.initialCommand ?? '').sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite;
  const common = () => fs.realpathSync(path.join(repo, '.git'));

  it('a launch adds them where the self-test applied them, beside the snapshot of other worktrees', () => {
    const d = denyOf({ ...FULL, selfTest: { ok: true, worktreePatterns: true } });
    expect(d).toEqual(expect.arrayContaining([`${common()}/worktrees/[0-9A-SU-Za-su-z]*`, `${common()}/worktrees/task-1?*`, path.join(common(), 'worktrees', 'task-2')]));
    expect(d).not.toContain(`${common()}/worktrees/task-1`);
    // A self-test that did not apply them, or another platform: the snapshot alone.
    for (const other of [denyOf(FULL), denyOf({ ...FULL, selfTest: { ok: true, worktreePatterns: true } }, 'linux')]) {
      expect(other.filter((p) => p.includes('*') && p.includes(`${path.sep}worktrees${path.sep}`))).toEqual([]);
      expect(other).toContain(path.join(common(), 'worktrees', 'task-2'));
    }
  });

  it('a name they cannot take keeps to the snapshot, logged once', () => {
    const logs: string[] = [];
    const facts = { gitCommonDir: common(), isLinkedWorktree: true, ownWorktreeName: 'task 1' };
    expect(worktreeComplementDenies(facts, 'darwin', (l) => logs.push(l))).toEqual([]);
    expect(worktreeComplementDenies(facts, 'darwin', (l) => logs.push(l))).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(worktreeComplementDenies({ ...facts, isLinkedWorktree: false, ownWorktreeName: null }, 'darwin', (l) => logs.push(l))).toEqual([]);
    expect(worktreeComplementDenies({ ...facts, ownWorktreeName: 'task-1' }, 'linux', (l) => logs.push(l))).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it('the self-test applies them only when claude opened the common dir, its own git folder took a write and no other did', async () => {
    const logs: string[] = [];
    const run = async (linked: string) => {
      const fake = path.join(root, `fake-${Math.random().toString(36).slice(2)}`);
      // The plain run has no `.git` in its worktree; the macOS run does.
      fs.writeFileSync(fake, `#!/bin/sh\ntouch ran\nif [ -f .git ]; then\n${linked || ':'}\nfi\n`, { mode: 0o755 });
      return runWorkerFenceSelfTest(fake, { dir, runtime: RUNTIME, timeoutMs: 10_000, platform: 'darwin', log: (l) => logs.push(l), paneEnv: async () => ({ PATH: '/usr/bin:/bin' }) });
    };
    const git = '../repo/.git';
    const control = `touch ${git}/control && touch control`;
    const own = `touch ${git}/worktrees/${WORKER_FENCE_SELF_TEST_WORKTREE}/probe && touch own`;
    expect(await run(`${control}; ${own}`)).toEqual({ ok: true, worktreePatterns: true });
    expect(logs).toEqual([]);
    // One that does not hold leaves them out, and the workers keep their tools.
    for (const [body, why] of [
      [`${control}; ${own}; touch ${git}/worktrees/sibling/probe`, /wrote another worktree's git folder/],
      [`${control}; ${own}; touch ${git}/worktrees/WMUX/probe`, /wrote another worktree's git folder/],
      [`${control}; ${own}; mkdir ${git}/worktrees/added`, /wrote another worktree's git folder/],
      [own, /did not open the linked worktree's git folder/],
      [control, /could not write its own worktree's git folder/],
    ] as const) {
      logs.length = 0;
      expect(await run(body)).toEqual({ ok: true });
      expect(logs).toEqual([expect.stringMatching(why)]);
    }
    // A pattern run that did not finish is tried again later.
    const slow = path.join(root, 'fake-slow');
    fs.writeFileSync(slow, '#!/bin/sh\ntouch ran\nif [ -f .git ]; then exec sleep 30; fi\n', { mode: 0o755 });
    expect(await runWorkerFenceSelfTest(slow, { dir, runtime: RUNTIME, timeoutMs: 1_500, platform: 'darwin', log: () => undefined, paneEnv: async () => ({ PATH: '/usr/bin:/bin' }) })).toEqual({ ok: true, patternsRetry: true });
    // The plain run failing fails the self-test, as before; elsewhere there is no second run.
    const none = path.join(root, 'fake-none');
    fs.writeFileSync(none, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await runWorkerFenceSelfTest(none, { dir, runtime: RUNTIME, timeoutMs: 10_000, platform: 'darwin', paneEnv: async () => ({ PATH: '/usr/bin:/bin' }) })).toMatchObject({ ok: false });
    const plain = path.join(root, 'fake-plain');
    fs.writeFileSync(plain, '#!/bin/sh\ntouch ran\n', { mode: 0o755 });
    expect(await runWorkerFenceSelfTest(plain, { dir, runtime: RUNTIME, timeoutMs: 10_000, platform: 'linux', paneEnv: async () => ({ PATH: '/usr/bin:/bin' }) })).toEqual({ ok: true });
    expect(fs.readdirSync(path.join(dir, 'factory', 'fence-self-test'))).toEqual([]);
  });

  it('a launch whose denies would grow too large keeps to the snapshot', () => {
    // Hundreds of branches: one deny each, beside the patterns.
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const packed = Array.from({ length: 700 }, (_, i) => `${head} refs/heads/wmux/a-rather-long-branch-name-to-fill-the-profile-${i}`).join('\n');
    fs.appendFileSync(path.join(repo, '.git', 'packed-refs'), `${packed}\n`);
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (l: string) => { logged.push(l); };
    try {
      const d = denyOf({ ...FULL, selfTest: { ok: true, worktreePatterns: true } });
      expect(d.filter((p) => p.includes('*') && p.includes(`${path.sep}worktrees${path.sep}`))).toEqual([]);
      expect(d).toContain(path.join(common(), 'worktrees', 'task-2'));
    } finally {
      console.warn = warn;
    }
    expect(logged).toEqual([expect.stringMatching(/too large/)]);
  });
});

describe.skipIf(isWin)('what else the fence closes', () => {
  it('other sessions\' folders in claude\'s temp folder: one pattern on macOS, each but its own elsewhere', () => {
    expect(claudeTempDenies('/w/t', 'darwin', ['/tmp/claude-501', '/private/tmp/claude-501'])).toEqual(['/tmp/claude-501/-*', '/private/tmp/claude-501/-*']);
    expect(claudeTempDenies('/w/t', 'linux', ['/tmp/claude-1000'], () => ['-w-t', '-other-session', 'tasks'])).toEqual(['/tmp/claude-1000/-other-session']);
    // A worktree path past 200 characters: Claude cuts its folder's name and adds a hash, and that folder stays open.
    const long = `/home/me/.wmux/worktrees/${'nested-folder/'.repeat(14)}task`;
    const ownLong = `${long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-${Math.abs([...long].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)).toString(36)}`;
    expect(claudeTempDenies(long, 'linux', ['/tmp/claude-1000'], () => [ownLong, '-other-session'])).toEqual(['/tmp/claude-1000/-other-session']);
    const s = settingsOf(create(LINE, deps({ fence: { runtime: RUNTIME, home, env: {}, platform: 'darwin', claudeTempRoots: ['/tmp/claude-501', '/private/tmp/claude-501'] } }))!.initialCommand!);
    expect((s.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite).toEqual(expect.arrayContaining(['/tmp/claude-501/-*', '/private/tmp/claude-501/-*']));
  });

  it('the data folder\'s secrets: denied to the file tools and to commands; the worktree stays readable', () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'factory', 'secrets.json.bak'), '{}');
    const secrets = workerFenceDataDirSecrets(dir);
    for (const rel of ['daemon-auth-token', 'accounts', 'a2a', 'lanlink', 'factory/secrets.json', 'factory/secrets.json.bak', 'factory/claude-api-key.json', 'factory/worker-settings']) {
      expect(secrets, rel).toContain(path.join(dir, ...rel.split('/')));
    }
    const s = settingsOf(create(LINE)!.initialCommand!);
    const fsRules = (s.sandbox as { filesystem: { denyRead: string[]; allowRead: string[] } }).filesystem;
    expect(fsRules.denyRead).toEqual(expect.arrayContaining([path.join(dir, 'factory', 'secrets.json'), path.join(dir, 'factory', 'worker-settings')]));
    expect(fsRules.allowRead).toContain(fs.realpathSync(wt));
    const deny = (s.permissions as { deny: string[] }).deny;
    const rule = (p: string) => (p.startsWith(home) ? `~/${path.relative(home, p)}` : `/${p}`);
    expect(deny).toEqual(expect.arrayContaining([`Read(${rule(path.join(dir, 'factory', 'secrets.json'))})`, `Read(${rule(path.join(dir, 'daemon-auth-token'))})`]));
  });
});

describe.skipIf(isWin)('the worktree\'s git layout', () => {
  it('a linked worktree: its branch, every other branch (packed too) and worktree', () => {
    git(repo, 'pack-refs', '--all');
    git(repo, 'branch', 'loose');
    const f = readWorktreeGitFacts(wt);
    expect(f.gitCommonDir).toBe(fs.realpathSync(path.join(repo, '.git')));
    expect(f.isLinkedWorktree).toBe(true);
    expect(f.ownWorktreeName).toBe('task-1');
    expect(f.ownBranch).toBe('wmux/task-1');
    expect(f.otherBranches.sort()).toEqual(['loose', 'main', 'other', 'wmux/task-1', 'wmux/task-2']);
    expect(f.otherWorktrees.sort()).toEqual(['task-1', 'task-2']);
  });

  it('the main checkout and a folder that is not a repository', () => {
    const f = readWorktreeGitFacts(repo);
    expect(f.isLinkedWorktree).toBe(false);
    expect(f.ownBranch).toBe('main');
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(readWorktreeGitFacts(plain)).toMatchObject({ isLinkedWorktree: false, otherBranches: [] });
  });
});
