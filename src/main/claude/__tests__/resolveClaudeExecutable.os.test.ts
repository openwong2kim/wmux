import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentCandidates, claudeCandidates, claudeInstalls, claudeInstallsWith, programOnPath, resolveAgentExecutableWith, resolveClaudeExecutableWith, type ResolveClaudeEnv } from '../resolveClaudeExecutable';

// The PATH a new pane receives (pty.handler): on Windows re-read from the
// registry. A test sets `freshPath.dir` to stand for a folder only that PATH has.
const freshPath = vi.hoisted(() => ({ dir: null as string | null }));
vi.mock('../../../shared/windowsPathEnv', () => ({
  withFreshWindowsPath: (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    if (!freshPath.dir) return env;
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    return { ...env, [key]: `${freshPath.dir}${path.delimiter}${env[key] ?? ''}` };
  },
}));

function posix(files: string[], env: Record<string, string> = {}, platform: NodeJS.Platform = 'linux'): ResolveClaudeEnv {
  const set = new Set(files);
  return { platform, env, homedir: '/home/u', isFile: (p) => set.has(p) };
}

describe('resolveClaudeExecutable', () => {
  it('finds claude on PATH (npm global / any install the terminal would run)', () => {
    const r = posix(['/opt/node/bin/claude'], { PATH: '/usr/bin:/opt/node/bin' });
    expect(resolveClaudeExecutableWith(r)).toBe('/opt/node/bin/claude');
  });

  it('prefers the PATH hit over the native-installer location', () => {
    const r = posix(['/opt/node/bin/claude', '/home/u/.local/bin/claude'], { PATH: '/opt/node/bin' });
    expect(resolveClaudeExecutableWith(r)).toBe('/opt/node/bin/claude');
  });

  it('falls back to ~/.local/bin when PATH misses it (GUI launch, minimal PATH)', () => {
    const r = posix(['/home/u/.local/bin/claude'], { PATH: '/usr/bin' });
    expect(resolveClaudeExecutableWith(r)).toBe('/home/u/.local/bin/claude');
  });

  it('checks Homebrew locations on macOS even with an empty PATH', () => {
    expect(resolveClaudeExecutableWith(posix(['/opt/homebrew/bin/claude'], {}, 'darwin'))).toBe('/opt/homebrew/bin/claude');
    expect(resolveClaudeExecutableWith(posix(['/usr/local/bin/claude'], {}, 'darwin'))).toBe('/usr/local/bin/claude');
  });

  it('checks the npm global prefix from npm_config_prefix', () => {
    const r = posix(['/srv/npm/bin/claude'], { npm_config_prefix: '/srv/npm' });
    expect(resolveClaudeExecutableWith(r)).toBe('/srv/npm/bin/claude');
  });

  it('returns null when nothing exists', () => {
    expect(resolveClaudeExecutableWith(posix([], { PATH: '/usr/bin' }))).toBeNull();
  });

  it('keeps scanning past a path whose check throws', () => {
    const r: ResolveClaudeEnv = { platform: 'linux', env: { PATH: '/a:/b' }, homedir: '/home/u',
      isFile: (p) => { if (p === '/a/claude') throw new Error('EACCES'); return p === '/b/claude'; } };
    expect(resolveClaudeExecutableWith(r)).toBe('/b/claude');
  });

  it('never picks a claude planted in the current folder via empty or relative PATH entries', () => {
    const planted = ['claude', './claude', 'node_modules/.bin/claude', '/home/u/.local/bin/claude'];
    const r = posix(planted, { PATH: ':.:node_modules/.bin::/usr/bin' });
    expect(resolveClaudeExecutableWith(r)).toBe('/home/u/.local/bin/claude');
    expect(claudeCandidates(r).every((c) => c.startsWith('/'))).toBe(true);
  });

  describe('Windows', () => {
    const win = (files: string[], env: Record<string, string>): ResolveClaudeEnv => {
      const set = new Set(files.map((f) => f.toLowerCase()));
      return { platform: 'win32', env, homedir: 'C:\\Users\\u', isFile: (p) => set.has(p.toLowerCase()) };
    };

    it('respects PATHEXT and finds claude.exe on PATH', () => {
      const r = win(['C:\\tools\\claude.exe'], { PATH: 'C:\\Windows;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' });
      expect(resolveClaudeExecutableWith(r)).toBe('C:\\tools\\claude.exe');
    });

    it('skips an unspawnable claude.cmd shim and uses the npm package entrypoint', () => {
      const appData = 'C:\\Users\\u\\AppData\\Roaming';
      const cli = `${appData}\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
      const r = win([`${appData}\\npm\\claude.cmd`, cli], { PATH: `${appData}\\npm`, PATHEXT: '.EXE;.CMD', APPDATA: appData });
      expect(resolveClaudeExecutableWith(r)).toBe(cli);
    });

    it('does not search the cwd first and ignores relative / drive-relative entries', () => {
      const r = win(['claude.exe', '.\\claude.exe', 'tools\\claude.exe', '\\x\\claude.exe'], { PATH: ';.;tools;\\x', PATHEXT: '.EXE' });
      expect(resolveClaudeExecutableWith(r)).toBeNull();
      expect(claudeCandidates(r).filter((c) => !/^[A-Za-z]:\\/.test(c))).toEqual([]);
    });

    it('never lists .cmd or .bat candidates', () => {
      const c = claudeCandidates(win([], { PATH: 'C:\\x', PATHEXT: '.EXE;.BAT;.CMD' }));
      expect(c.some((p) => /\.(cmd|bat)$/i.test(p))).toBe(false);
      expect(c).toContain('C:\\Users\\u\\.local\\bin\\claude.exe');
    });
  });
});

describe('version managers, login shell, executability', () => {
  const env = (files: string[], dirs: Record<string, string[]>, texts: Record<string, string> = {}, extra: Partial<ResolveClaudeEnv> = {}, e: Record<string, string> = {}, platform: NodeJS.Platform = 'darwin'): ResolveClaudeEnv => {
    const set = new Set(files);
    return { platform, env: e, homedir: '/Users/u', isFile: (p) => set.has(p), readDir: (p) => dirs[p] ?? [], readText: (p) => texts[p] ?? null, ...extra };
  };

  it('nvm: prefers the default alias over a newer version', () => {
    const root = '/Users/u/.nvm/versions/node';
    const r = env([`${root}/v20.11.1/bin/claude`, `${root}/v22.3.0/bin/claude`], { [root]: ['v22.3.0', 'v20.11.1'] }, { '/Users/u/.nvm/alias/default': '20\n' });
    expect(resolveClaudeExecutableWith(r)).toBe(`${root}/v20.11.1/bin/claude`);
  });

  it('nvm: without an alias, picks the newest version (numeric, not lexical)', () => {
    const root = '/Users/u/.nvm/versions/node';
    const r = env([`${root}/v9.0.0/bin/claude`, `${root}/v18.0.0/bin/claude`], { [root]: ['v9.0.0', 'v18.0.0'] });
    expect(resolveClaudeExecutableWith(r)).toBe(`${root}/v18.0.0/bin/claude`);
  });

  it('nvm: honours NVM_DIR', () => {
    const root = '/opt/nvm/versions/node';
    const r = env([`${root}/v22.0.0/bin/claude`], { [root]: ['v22.0.0'] }, {}, {}, { NVM_DIR: '/opt/nvm' });
    expect(resolveClaudeExecutableWith(r)).toBe(`${root}/v22.0.0/bin/claude`);
  });

  it('fnm: macOS Application Support, Linux ~/.local/share and FNM_DIR', () => {
    const mac = '/Users/u/Library/Application Support/fnm/node-versions';
    expect(resolveClaudeExecutableWith(env([`${mac}/v22.1.0/installation/bin/claude`], { [mac]: ['v22.1.0'] }))).toBe(`${mac}/v22.1.0/installation/bin/claude`);
    const lin = '/Users/u/.local/share/fnm/node-versions';
    expect(resolveClaudeExecutableWith(env([`${lin}/v20.0.0/installation/bin/claude`], { [lin]: ['v20.0.0'] }, {}, {}, {}, 'linux'))).toBe(`${lin}/v20.0.0/installation/bin/claude`);
    const custom = '/srv/fnm/node-versions';
    expect(resolveClaudeExecutableWith(env([`${custom}/v21.0.0/installation/bin/claude`], { [custom]: ['v21.0.0'] }, {}, {}, { FNM_DIR: '/srv/fnm' }))).toBe(`${custom}/v21.0.0/installation/bin/claude`);
  });

  it('volta: ~/.volta/bin and VOLTA_HOME', () => {
    expect(resolveClaudeExecutableWith(env(['/Users/u/.volta/bin/claude'], {}))).toBe('/Users/u/.volta/bin/claude');
    expect(resolveClaudeExecutableWith(env(['/opt/volta/bin/claude'], {}, {}, {}, { VOLTA_HOME: '/opt/volta' }))).toBe('/opt/volta/bin/claude');
  });

  it('login shell PATH is read only when nothing else is found, and only absolute entries count', () => {
    let calls = 0;
    const login = () => { calls++; return '.:relative/bin:/Users/u/custom/bin'; };
    const found = env(['/Users/u/.local/bin/claude', '/Users/u/custom/bin/claude'], {}, {}, { loginShellPath: login });
    expect(resolveClaudeExecutableWith(found)).toBe('/Users/u/.local/bin/claude');
    expect(calls).toBe(0);
    const viaLogin = env(['/Users/u/custom/bin/claude', 'claude', 'relative/bin/claude'], {}, {}, { loginShellPath: login });
    expect(resolveClaudeExecutableWith(viaLogin)).toBe('/Users/u/custom/bin/claude');
    expect(calls).toBe(1);
  });

  it('skips a non-executable claude earlier on PATH (isFile is the X_OK check)', () => {
    const executable = new Set(['/b/claude']);
    const r: ResolveClaudeEnv = { platform: 'linux', env: { PATH: '/a:/b' }, homedir: '/home/u', isFile: (p) => executable.has(p) };
    expect(resolveClaudeExecutableWith(r)).toBe('/b/claude');
  });
});

describe.skipIf(process.platform === 'win32')('isExecutableFile (real fs)', () => {
  it('rejects a non-executable file and a folder, accepts chmod +x', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { isExecutableFile } = await import('../resolveClaudeExecutable');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-x-'));
    try {
      const f = path.join(dir, 'claude');
      fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o644 });
      expect(isExecutableFile(f)).toBe(false);
      fs.chmodSync(f, 0o755);
      expect(isExecutableFile(f)).toBe(true);
      expect(isExecutableFile(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('loadLoginShellPath (real child process)', () => {
  const setup = async (script: string) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-shell-'));
    const shell = path.join(dir, 'fake-shell');
    fs.writeFileSync(shell, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-home-'));
    return { shell, home: fs.realpathSync(home), cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } };
  };

  it('parses only the text between the markers in noisy rc output', async () => {
    const { loadLoginShellPath } = await import('../resolveClaudeExecutable');
    const t = await setup(`echo "Welcome! oh-my-zsh loaded"; printf '__WMUX_PATH_START__%s__WMUX_PATH_END__' "/opt/a/bin:/opt/b/bin"; echo; echo "bye /x/y"`);
    try {
      expect(await loadLoginShellPath({ shell: t.shell, home: t.home })).toBe('/opt/a/bin:/opt/b/bin');
    } finally { t.cleanup(); }
  });

  it('runs with cwd = home, never the current folder', async () => {
    const { loadLoginShellPath } = await import('../resolveClaudeExecutable');
    const t = await setup(`printf '__WMUX_PATH_START__%s__WMUX_PATH_END__' "$(pwd -P)"`);
    try {
      expect(await loadLoginShellPath({ shell: t.shell, home: t.home })).toBe(t.home);
    } finally { t.cleanup(); }
  });

  it('a hanging shell times out and resolves null', async () => {
    const { loadLoginShellPath } = await import('../resolveClaudeExecutable');
    const t = await setup('sleep 30');
    try {
      const started = Date.now();
      expect(await loadLoginShellPath({ shell: t.shell, home: t.home, timeoutMs: 300 })).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally { t.cleanup(); }
  });

  it('output without markers resolves null', async () => {
    const { parseMarkedPath } = await import('../resolveClaudeExecutable');
    expect(parseMarkedPath('/usr/bin:/bin')).toBeNull();
    expect(parseMarkedPath('x__WMUX_PATH_START__/a__WMUX_PATH_END__y')).toBe('/a');
  });
});

describe('Codex candidates', () => {
  it('finds codex at the standalone installer location when PATH misses it', () => {
    const files = new Set(['/home/u/.local/bin/codex']);
    const r: ResolveClaudeEnv = { platform: 'darwin', env: { PATH: '/usr/bin' }, homedir: '/home/u', isFile: (p) => files.has(p) };
    expect(resolveAgentExecutableWith(r, 'codex')).toBe('/home/u/.local/bin/codex');
  });

  it('looks in the Windows installer folder and the npm entrypoint, never a .cmd shim', () => {
    const r: ResolveClaudeEnv = {
      platform: 'win32',
      env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      homedir: 'C:\\Users\\u',
      isFile: () => false,
    };
    expect(agentCandidates(r, 'codex')).toEqual([
      'C:\\npm\\codex.exe',
      'C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    ]);
  });

  it('runs the npm entrypoint next to a codex.cmd shim in any PATH folder (custom npm prefix)', () => {
    const files = new Set(['d:\\npm\\codex.cmd', 'd:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js']);
    const r: ResolveClaudeEnv = {
      platform: 'win32',
      env: { PATH: 'D:\\npm', PATHEXT: '.EXE;.CMD' },
      homedir: 'C:\\Users\\u',
      isFile: (p) => files.has(p.toLowerCase()),
    };
    expect(resolveAgentExecutableWith(r, 'codex')).toBe('D:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
  });
});

describe('Grok and Antigravity candidates', () => {
  it('Windows: each vendor installer\'s folder, and the WinGet link for Grok, never an npm path', () => {
    const r: ResolveClaudeEnv = {
      platform: 'win32',
      env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      homedir: 'C:\\Users\\u',
      isFile: () => false,
    };
    expect(agentCandidates(r, 'grok')).toEqual([
      'C:\\tools\\grok.exe',
      'C:\\Users\\u\\.grok\\bin\\grok.exe',
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\grok.exe',
    ]);
    expect(agentCandidates(r, 'agy')).toEqual([
      'C:\\tools\\agy.exe',
      'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe',
    ]);
  });

  it('macOS and Linux: ~/.grok/bin/grok and ~/.local/bin/agy when PATH misses them', () => {
    const files = new Set(['/home/u/.grok/bin/grok', '/home/u/.local/bin/agy']);
    const r: ResolveClaudeEnv = { platform: 'linux', env: { PATH: '/usr/bin' }, homedir: '/home/u', isFile: (p) => files.has(p) };
    expect(resolveAgentExecutableWith(r, 'grok')).toBe('/home/u/.grok/bin/grok');
    expect(resolveAgentExecutableWith(r, 'agy')).toBe('/home/u/.local/bin/agy');
  });
});

describe('Qwen Code and Kimi Code CLI candidates', () => {
  const LOCAL = 'C:\\Users\\u\\AppData\\Local';
  const SHIM = `${LOCAL}\\qwen-code\\qwen-code\\bin\\qwen.cmd`;
  const win = (files: string[]): ResolveClaudeEnv => {
    const set = new Set(files.map((f) => f.toLowerCase()));
    return {
      platform: 'win32',
      env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD', LOCALAPPDATA: LOCAL, APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      homedir: 'C:\\Users\\u',
      isFile: (p) => set.has(p.toLowerCase()),
    };
  };

  it('Windows: the standalone archive\'s own qwen.cmd, kimi.exe, and the npm entrypoints', () => {
    expect(agentCandidates(win([]), 'qwen')).toEqual([
      'C:\\tools\\qwen.exe',
      SHIM,
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@qwen-code\\qwen-code\\cli-entry.js',
    ]);
    expect(agentCandidates(win([]), 'kimi')).toEqual([
      'C:\\tools\\kimi.exe',
      'C:\\Users\\u\\.kimi-code\\bin\\kimi.exe',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs',
    ]);
  });

  it('Windows: picks the archive\'s qwen.cmd (which runs its bundled node.exe), not the PATH shim that calls it', () => {
    const r = win([SHIM, `${LOCAL}\\qwen-code\\bin\\qwen.cmd`]);
    expect(resolveAgentExecutableWith({ ...r, env: { ...r.env, PATH: `${LOCAL}\\qwen-code\\bin` } }, 'qwen')).toBe(SHIM);
  });

  it('macOS and Linux: ~/.local/bin/qwen and ~/.kimi-code/bin/kimi when PATH misses them', () => {
    const r = posix(['/home/u/.local/bin/qwen', '/home/u/.kimi-code/bin/kimi'], { PATH: '/usr/bin' });
    expect(resolveAgentExecutableWith(r, 'qwen')).toBe('/home/u/.local/bin/qwen');
    expect(resolveAgentExecutableWith(r, 'kimi')).toBe('/home/u/.kimi-code/bin/kimi');
  });
});

describe('claudeInstallsWith (every claude a shell might run)', () => {
  it('lists each existing candidate, then each claude on the login shell PATH, once and absolute only', () => {
    const r: ResolveClaudeEnv = {
      ...posix(['/usr/local/bin/claude', '/home/u/.local/bin/claude', '/home/u/.nvm/versions/node/v18.0.0/bin/claude', 'claude'], { PATH: '/usr/local/bin:.' }, 'darwin'),
      loginShellPath: () => '/home/u/.nvm/versions/node/v18.0.0/bin:/usr/local/bin:relative',
    };
    expect(claudeInstallsWith(r)).toEqual(['/usr/local/bin/claude', '/home/u/.local/bin/claude', '/home/u/.nvm/versions/node/v18.0.0/bin/claude']);
    expect(claudeInstallsWith({ ...r, loginShellPath: () => null })).toEqual(['/usr/local/bin/claude', '/home/u/.local/bin/claude']);
  });

  it('on this machine, lists a claude only the PATH a new pane receives holds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fresh-path-'));
    const exe = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    fs.writeFileSync(exe, '');
    fs.chmodSync(exe, 0o755);
    // No login shell is asked: its PATH is not what this checks.
    vi.stubEnv('SHELL', '');
    try {
      expect(await claudeInstalls()).not.toContain(exe);
      freshPath.dir = dir;
      expect(await claudeInstalls()).toContain(exe);
    } finally {
      freshPath.dir = null;
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('programOnPath (what an install line needs)', () => {
  it('Windows: npm is npm.cmd, found through PATHEXT', () => {
    const r: ResolveClaudeEnv = {
      platform: 'win32',
      env: { Path: 'C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      homedir: 'C:\\Users\\u',
      isFile: (p) => p === 'C:\\Program Files\\nodejs\\npm.cmd',
    };
    expect(programOnPath(r, 'npm')).toBe(true);
    expect(programOnPath(r, 'pnpm')).toBe(false);
  });

  it('macOS: Homebrew\'s folder from the login shell PATH counts when a Finder launch\'s PATH lacks it', () => {
    const r: ResolveClaudeEnv = {
      ...posix(['/opt/homebrew/bin/brew', '/usr/bin/curl'], { PATH: '/usr/bin:/bin' }, 'darwin'),
      loginShellPath: () => '/opt/homebrew/bin:/usr/bin',
    };
    expect(programOnPath(r, 'brew')).toBe(true);
    expect(programOnPath(r, 'curl')).toBe(true);
    expect(programOnPath({ ...r, loginShellPath: () => null }, 'brew')).toBe(false);
  });
});
