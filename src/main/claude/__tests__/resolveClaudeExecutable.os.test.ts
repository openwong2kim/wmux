import { describe, it, expect } from 'vitest';
import { claudeCandidates, resolveClaudeExecutableWith, type ResolveClaudeEnv } from '../resolveClaudeExecutable';

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
