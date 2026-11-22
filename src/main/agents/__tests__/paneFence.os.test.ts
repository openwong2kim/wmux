// A person's pane in the worker fence (paneFence.ts): the fenced line, every
// refusal, and the session record write-launch reads (paneFenceSessions.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PANE_FENCE_CLAUDE_ONLY, paneFenceCwdRefusal, paneFenceLaunch, spliceProjectSettingSources, type PaneFenceDeps } from '../paneFence';
import {
  PANE_FENCE_SESSIONS_MAX,
  __resetPaneFenceSessionsForTesting,
  getPaneFenceSession,
  getPaneFenceSessionsPath,
  notePaneFenceLaunch,
  paneFenceNamedPaths,
  setPaneFenceOn,
} from '../paneFenceSessions';
import { __resetWorkerFenceSupportForTesting, type WorkerFenceSupport } from '../botWorkerFence';
import { paneFenceRefusalReason } from '../../../shared/paneFence';

const isWin = process.platform === 'win32';
const RUNTIME = '/opt/wmux/wmux';
const BRIDGE = '/opt/wmux/hooks/wmux-bridge.mjs';
const EXE = '/opt/claude/bin/claude';
const FULL: WorkerFenceSupport = { capable: true, exe: EXE, version: '2.1.311', selfTest: { ok: true } };

let root: string;
let dir: string;
let home: string;
let repo: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pane-fence-')));
  dir = path.join(root, 'data');
  home = path.join(root, 'home');
  repo = path.join(home, 'code', 'project');
  fs.mkdirSync(dir);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  __resetWorkerFenceSupportForTesting();
  __resetPaneFenceSessionsForTesting();
});
afterEach(() => {
  __resetPaneFenceSessionsForTesting();
  fs.rmSync(root, { recursive: true, force: true });
});

function deps(over: Partial<PaneFenceDeps> = {}): PaneFenceDeps {
  return { dir, support: FULL, bridge: () => BRIDGE, platform: process.platform, fence: { runtime: RUNTIME, home, env: {}, accountConfigDirs: [] }, ...over };
}
const settingsOf = (line: string): Record<string, unknown> => {
  const m = /--settings="([^"]+)"/.exec(line);
  if (!m) throw new Error(`no settings: ${line}`);
  return JSON.parse(fs.readFileSync(m[1], 'utf8')) as Record<string, unknown>;
};
const refusalOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('not refused');
};

describe.skipIf(isWin)('an opted-in pane\'s launch', () => {
  it('is fenced in every permission mode, loads only project settings, and carries wmux\'s status hooks', () => {
    for (const line of ['claude', 'claude --permission-mode acceptEdits', 'claude --dangerously-skip-permissions']) {
      const out = paneFenceLaunch(line, repo, {}, deps());
      expect(out, line).not.toBeNull();
      expect(out!.line.startsWith(`${EXE} --setting-sources=project --settings="`), out!.line).toBe(true);
      const s = settingsOf(out!.line);
      const sandbox = s.sandbox as { enabled: boolean; autoAllowBashIfSandboxed: boolean; filesystem: { allowWrite: string[]; denyRead: string[] } };
      expect(sandbox.enabled).toBe(true);
      expect(sandbox.filesystem.allowWrite).toContain(fs.realpathSync(repo));
      expect(sandbox.filesystem.denyRead).toContain(path.join(home, '.ssh'));
      // Only a bypass line has no other judge for a command.
      expect(sandbox.autoAllowBashIfSandboxed, line).toBe(line.includes('--dangerously-skip-permissions'));
      const hooks = s.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
      expect(hooks.PreToolUse[0].matcher).toBe('.*');
      expect(hooks.Stop.some((g) => g.hooks.some((h) => h.command.includes(BRIDGE)))).toBe(true);
      expect(out!.record.cwd).toBe(repo);
    }
  });

  it('leaves a plain shell command alone', () => {
    expect(paneFenceLaunch('ls -la', repo, {}, deps())).toBeNull();
  });

  it('refuses codex and any other agent: Claude Code only for now', () => {
    for (const line of ['codex', 'codex --yolo', 'gemini']) {
      const why = refusalOf(() => paneFenceLaunch(line, repo, {}, deps()));
      expect(why, line).toContain(PANE_FENCE_CLAUDE_ONLY);
      expect(why).toContain('Claude Code only for now');
    }
  });

  it('refuses where only a weaker fence would run, never starting unfenced', () => {
    expect(refusalOf(() => paneFenceLaunch('claude', repo, {}, deps({ support: { capable: false, reason: 'the sandbox needs bwrap and socat on PATH' } })))).toMatch(/^worker fence: it needs the OS sandbox, which cannot run here \(the sandbox needs bwrap/);
    expect(refusalOf(() => paneFenceLaunch('claude', repo, { wsl: true }, deps()))).toContain('a WSL pane cannot run the OS sandbox');
    expect(refusalOf(() => paneFenceLaunch('claude', repo, {}, deps({ platform: 'win32' })))).toContain('Windows does not have');
  });

  it('refuses a self-test failure (no toolless claude) and asks again after a transient one', () => {
    expect(refusalOf(() => paneFenceLaunch('claude', repo, {}, deps({ support: { ...FULL, selfTest: { ok: false, reason: 'the write landed' } } })))).toContain('failed its self-test');
    expect(refusalOf(() => paneFenceLaunch('claude', repo, {}, deps({ support: { ...FULL, selfTest: { ok: false, reason: 'timed out', transient: true } } })))).toContain('try again');
    expect(refusalOf(() => paneFenceLaunch('claude', repo, {}, deps({ support: { capable: false, reason: 'no claude executable', transient: true } })))).toContain('try again');
    expect(refusalOf(() => paneFenceLaunch('claude', repo, {}, deps({ support: null })))).toContain('not checked yet');
  });

  it('refuses a folder that is the home folder, the disk root, or holds a credential path', () => {
    expect(refusalOf(() => paneFenceLaunch('claude', home, {}, deps()))).toContain('the fence keeps unreadable');
    expect(refusalOf(() => paneFenceLaunch('claude', '/', {}, deps()))).toContain('root of the disk');
    expect(refusalOf(() => paneFenceLaunch('claude', root, {}, deps()))).toContain('the fence keeps unreadable');
    expect(refusalOf(() => paneFenceLaunch('claude', undefined, {}, deps()))).toContain('no folder');
  });

  it('refuses a line the fence cannot be attached to', () => {
    expect(refusalOf(() => paneFenceLaunch('claude --add-dir /tmp', repo, {}, deps()))).toContain('--add-dir');
    expect(refusalOf(() => paneFenceLaunch('claude --settings=/x.json', repo, {}, deps()))).toContain('--settings');
    expect(refusalOf(() => paneFenceLaunch('claude --setting-sources=user', repo, {}, deps()))).toContain('--setting-sources');
    expect(refusalOf(() => paneFenceLaunch('claude', repo, {}, deps({ bridge: () => null })))).toContain('hook bridge');
  });

  it('every refusal reads back as the fence\'s own sentence', () => {
    const why = refusalOf(() => paneFenceLaunch('codex', repo, {}, deps()));
    expect(paneFenceRefusalReason(`PTY_WRITE_LAUNCH: ${why}`)).toBe(PANE_FENCE_CLAUDE_ONLY);
    expect(paneFenceRefusalReason('PTY_WRITE_LAUNCH: the session is not live')).toBeNull();
  });
});

describe('spliceProjectSettingSources', () => {
  it('goes right after the launcher, keeping the model marker', () => {
    expect(spliceProjectSettingSources('claude -p hi')).toBe('claude --setting-sources=project -p hi');
    expect(spliceProjectSettingSources('claude --setting-sources user')).toBeNull();
  });
});

describe('paneFenceCwdRefusal', () => {
  it('refuses a create that would start in another folder than the fenced one', () => {
    expect(paneFenceCwdRefusal(undefined, { source: 'home' })).toBeNull();
    expect(paneFenceCwdRefusal({ cwd: '/w/p' }, { source: 'requested', safeCwd: '/w/p' })).toBeNull();
    expect(paneFenceCwdRefusal({ cwd: '/w/p' }, { source: 'home', safeCwd: '/home/u' })).toContain('worker fence:');
    expect(paneFenceCwdRefusal({ cwd: '/w/p' }, { source: 'requested', safeCwd: '/w/q' })).toContain('worker fence:');
  });
});

describe('the session record', () => {
  it('keeps a fenced launch and the switch across a reload', () => {
    notePaneFenceLaunch('daemon-1', { cwd: '/w/p', settingsFile: '/d/f.json', tempDir: '/d/t' }, dir, 1);
    expect(setPaneFenceOn('daemon-2', true, dir, 2)).toBe(true);
    __resetPaneFenceSessionsForTesting();
    expect(getPaneFenceSession('daemon-1', dir)).toMatchObject({ on: true, cwd: '/w/p' });
    expect(getPaneFenceSession('daemon-2', dir)?.on).toBe(true);
    expect(setPaneFenceOn('daemon-1', false, dir, 3)).toBe(false);
    expect(getPaneFenceSession('daemon-1', dir)?.on).toBe(false);
    expect(paneFenceNamedPaths(dir)).toEqual({ tempDirs: new Set(['/d/t']), files: new Set(['/d/f.json']) });
  });

  it('takes only a literal boolean, and an unreadable file is an empty record', () => {
    expect(setPaneFenceOn('daemon-1', 'yes', dir)).toBe(false);
    expect(getPaneFenceSession('daemon-1', dir)).toBeNull();
    fs.mkdirSync(path.dirname(getPaneFenceSessionsPath(dir)), { recursive: true });
    fs.writeFileSync(getPaneFenceSessionsPath(dir), '{not json');
    __resetPaneFenceSessionsForTesting();
    expect(getPaneFenceSession('daemon-1', dir)).toBeNull();
  });

  it('keeps at most PANE_FENCE_SESSIONS_MAX sessions, dropping the oldest', () => {
    for (let i = 0; i <= PANE_FENCE_SESSIONS_MAX; i++) setPaneFenceOn(`daemon-${i}`, true, dir, i);
    expect(getPaneFenceSession('daemon-0', dir)).toBeNull();
    expect(getPaneFenceSession(`daemon-${PANE_FENCE_SESSIONS_MAX}`, dir)?.on).toBe(true);
  });
});
