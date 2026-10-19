import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyExeSearchGuard,
  clearResolveExecutableCache,
  EXE_SEARCH_GUARD_MARKER_ENV,
  findExecutable,
  NO_CWD_EXE_SEARCH_ENV,
  resolveExecutable,
  withoutExeSearchGuard,
} from '../exeSearch';

const isWin = process.platform === 'win32';

describe('applyExeSearchGuard', () => {
  it('sets the variable and the wmux marker on Windows when absent', () => {
    const env: Record<string, string | undefined> = { PATH: 'C:\\x' };
    applyExeSearchGuard(env, 'win32');
    expect(env[NO_CWD_EXE_SEARCH_ENV]).toBe('1');
    expect(env[EXE_SEARCH_GUARD_MARKER_ENV]).toBe('1');
  });

  it("leaves a user's own value (any case) alone and unmarked", () => {
    const env: Record<string, string | undefined> = { nodefaultcurrentdirectoryinexepath: 'yes' };
    applyExeSearchGuard(env, 'win32');
    expect(env).toEqual({ nodefaultcurrentdirectoryinexepath: 'yes' });
  });

  it('does nothing off Windows', () => {
    const env: Record<string, string | undefined> = {};
    applyExeSearchGuard(env, 'linux');
    applyExeSearchGuard(env, 'darwin');
    expect(env).toEqual({});
  });
});

describe('withoutExeSearchGuard', () => {
  it('removes the variable (any case) and the marker when wmux added it', () => {
    const own = { [NO_CWD_EXE_SEARCH_ENV]: '1', [EXE_SEARCH_GUARD_MARKER_ENV]: '1' };
    const env = { NoDefaultCurrentDirectoryInExePath: '1', NODEFAULTCURRENTDIRECTORYINEXEPATH: '1', WMUX_EXE_SEARCH_GUARD: '1', KEEP: 'x' };
    expect(withoutExeSearchGuard(env, own)).toEqual({ KEEP: 'x' });
  });

  it("keeps the variable when the user set it, dropping only a stray marker", () => {
    const own = { [NO_CWD_EXE_SEARCH_ENV]: '1' };
    const env = { NoDefaultCurrentDirectoryInExePath: '1', wmux_exe_search_guard: '1' };
    expect(withoutExeSearchGuard(env, own)).toEqual({ NoDefaultCurrentDirectoryInExePath: '1' });
  });
});

describe('resolveExecutable / findExecutable (injected file system)', () => {
  beforeEach(() => clearResolveExecutableCache());

  const files = (...present: string[]) => {
    const set = new Set(present.map((p) => p.toLowerCase()));
    return (p: string) => set.has(p.toLowerCase());
  };

  it('returns the first PATH match and never consults the working directory', () => {
    const isFile = files('C:\\cwd\\git.exe', 'C:\\Tools\\Git\\cmd\\git.exe');
    const env = { PATH: 'C:\\Tools\\Git\\cmd;C:\\Windows' };
    expect(resolveExecutable('git', { env, platform: 'win32', isFile })).toBe('C:\\Tools\\Git\\cmd\\git.exe');
  });

  it('skips relative PATH entries, which libuv would resolve against the working directory', () => {
    const isFile = files('.\\git.exe', 'bin\\git.exe', 'C:bin\\git.exe', '\\bin\\git.exe', 'D:\\real\\git.exe');
    const env = { Path: '.;bin;C:bin;\\bin;"D:\\real"' };
    expect(resolveExecutable('git', { env, platform: 'win32', isFile })).toBe('D:\\real\\git.exe');
  });

  it('tries .com before .exe, and only those by default', () => {
    expect(resolveExecutable('tool', { env: { PATH: 'C:\\a' }, platform: 'win32', isFile: files('C:\\a\\tool.com', 'C:\\a\\tool.exe') }))
      .toBe('C:\\a\\tool.com');
    expect(findExecutable('codex', { env: { PATH: 'C:\\npm' }, platform: 'win32', isFile: files('C:\\npm\\codex.cmd') })).toBeNull();
  });

  it("walks PATHEXT in 'pathext' mode, for cross-spawn callers", () => {
    const env = { PATH: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(findExecutable('codex', { env, platform: 'win32', extensions: 'pathext', isFile: files('C:\\npm\\codex.cmd') }))
      .toBe('C:\\npm\\codex.CMD');
  });

  it('accepts a name that already has an extension', () => {
    expect(resolveExecutable('gh.exe', { env: { PATH: 'C:\\gh' }, platform: 'win32', isFile: files('C:\\gh\\gh.exe') }))
      .toBe('C:\\gh\\gh.exe');
  });

  it('on a miss: resolveExecutable returns the name, findExecutable returns null', () => {
    const opts = { env: { PATH: 'C:\\a' }, platform: 'win32' as const, isFile: files() };
    expect(resolveExecutable('git', opts)).toBe('git');
    expect(findExecutable('git', opts)).toBeNull();
  });

  it('leaves names with a directory unchanged, and every name off Windows', () => {
    const isFile = files('C:\\a\\git.exe');
    expect(resolveExecutable('C:\\b\\git.exe', { env: { PATH: 'C:\\a' }, platform: 'win32', isFile })).toBe('C:\\b\\git.exe');
    expect(resolveExecutable('git', { env: { PATH: '/usr/bin' }, platform: 'linux', isFile })).toBe('git');
    expect(findExecutable('git', { env: { PATH: '/usr/bin' }, platform: 'darwin', isFile })).toBe('git');
  });

  it('re-checks a cached hit on disk', () => {
    const present = new Set(['c:\\a\\git.exe', 'c:\\b\\git.exe']);
    const isFile = (p: string) => present.has(p.toLowerCase());
    const env = { PATH: 'C:\\a;C:\\b' };
    expect(resolveExecutable('git', { env, platform: 'win32', isFile })).toBe('C:\\a\\git.exe');
    present.delete('c:\\a\\git.exe');
    expect(resolveExecutable('git', { env, platform: 'win32', isFile })).toBe('C:\\b\\git.exe');
  });
});

// Live on Windows: a harmless system executable is copied into a directory as
// git.exe, and that directory is used as the working directory. The real git
// on PATH must be the one that runs. The test runner may itself have the
// variable set (some hosts do), so it is removed for the duration.
describe.runIf(isWin)('Windows: an executable in the working directory is never started', () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  const KEYS = [NO_CWD_EXE_SEARCH_ENV, EXE_SEARCH_GUARD_MARKER_ENV];

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    clearResolveExecutableCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-exesearch-'));
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    fs.copyFileSync(whoami, path.join(dir, 'git.exe'));
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const gitVersion = (file: string) => new Promise<string>((resolve) =>
    execFile(file, ['--version'], { cwd: dir, windowsHide: true }, (_e, stdout) => resolve(String(stdout).trim())));

  it('control: without the guard, a bare execFile starts the copy in cwd', async () => {
    expect(await gitVersion('git')).not.toMatch(/^git version/);
  });

  it('applyExeSearchGuard on this process makes a bare execFile skip cwd', async () => {
    applyExeSearchGuard();
    expect(await gitVersion('git')).toMatch(/^git version/);
  });

  it('resolveExecutable gives the PATH git even without the guard', async () => {
    const resolved = resolveExecutable('git');
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(path.dirname(resolved).toLowerCase()).not.toBe(dir.toLowerCase());
    expect(await gitVersion(resolved)).toMatch(/^git version/);
  });

  it('the main-process git() helper runs the PATH git', async () => {
    const { git } = await import('../../main/git/git');
    const res = await git(['--version'], dir);
    expect(res.stdout.trim()).toMatch(/^git version/);
  });

  it("the daemon's git runner runs the PATH git", async () => {
    const { createGitRunner } = await import('../../daemon/web/sessionDiff');
    const res = await createGitRunner()(['--version'], dir);
    expect(res.stdout.trim()).toMatch(/^git version/);
  });

  it('spawnAgent (cross-spawn) runs the PATH shim, not a .cmd in the working directory', async () => {
    const onPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-exesearch-path-'));
    try {
      fs.writeFileSync(path.join(dir, 'wmuxagentprobe.cmd'), '@echo off\r\necho FROM-CWD\r\n');
      fs.writeFileSync(path.join(onPath, 'wmuxagentprobe.cmd'), '@echo off\r\necho FROM-PATH\r\n');
      const { spawnAgent } = await import('../../daemon/chat/agentProcess');
      const env = { ...process.env, PATH: `${onPath};${process.env.PATH ?? ''}` };
      const child = spawnAgent('wmuxagentprobe', [], dir, env);
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      await new Promise((resolve) => child.on('close', resolve));
      expect(out.trim()).toBe('FROM-PATH');
    } finally {
      fs.rmSync(onPath, { recursive: true, force: true });
    }
  });

  it('runCli (cross-spawn) refuses to start a .cmd from the working directory when PATH has none', async () => {
    const prev = process.cwd();
    fs.writeFileSync(path.join(dir, 'wmuxclprobe.cmd'), '@echo off\r\necho FROM-CWD\r\n');
    process.chdir(dir);
    try {
      const { runCli } = await import('../runCli');
      await expect(runCli('wmuxclprobe', [], { timeoutMs: 10_000, maxBuffer: 4096 })).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      process.chdir(prev);
    }
  });
});

// Entry wiring: the guard must be the first import of every process entry that
// spawns tools, so it runs before any other module is evaluated.
describe('entries import the guard first', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  it.each(['src/daemon/index.ts', 'src/main/index.ts', 'src/mcp/entry.ts', 'src/mcp/broker.ts', 'src/cli/index.ts'])('%s', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const firstImport = src.split(/\r?\n/).find((l) => /^import\b/.test(l));
    expect(firstImport).toBe("import '../shared/exeSearchGuard';");
  });
});
