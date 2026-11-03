// One test per entry of PLUGIN_FS_REFUSALS: each refused path, and a close
// neighbour that stays readable.
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
}));

import fs from 'node:fs';
import { PLUGIN_FS_REFUSALS, holdsRefusedRoot, insideRefusedByIdentity, isPluginRefusedPath, pluginFsRefusal, resolvePluginPath } from '../fsRefusals';

const home = path.resolve('/home-for-test/user');
const h = (...p: string[]) => path.join(home, ...p);
const elsewhere = (...p: string[]) => path.join(path.resolve('/srv/project'), ...p);

beforeEach(() => { vi.spyOn(os, 'homedir').mockReturnValue(home); });
afterEach(() => { vi.restoreAllMocks(); });

/** The rule that refuses `p`, by the start of its description. */
const ruleOf = (p: string) => pluginFsRefusal(p)?.what ?? null;

describe('plugin fs refusals', () => {
  it("refuses wmux's own data folders, sockets and tokens, any suffix", () => {
    for (const p of [h('.wmux'), h('.wmux', 'config.json'), h('.wmux-dev', 'sessions.json'),
      h('.wmux-auth-token'), h('.wmux-verify-x-auth-token'), h('.wmux.sock'), h('.wmux-mcpb.sock'), h('.wmux-tcp-port')]) {
      expect(ruleOf(p), p).toMatch(/^wmux's own data/);
    }
    expect(isPluginRefusedPath(h('wmux'))).toBe(false);
    expect(isPluginRefusedPath(h('git', '.wmux'))).toBe(false);
  });

  it("refuses wmux's Electron userData, any suffix", () => {
    const root = process.platform === 'darwin' ? h('Library', 'Application Support')
      : process.platform === 'win32' ? h('AppData', 'Roaming') : h('.config');
    for (const p of [path.join(root, 'wmux'), path.join(root, 'wmux-dev', 'Local Storage')]) {
      expect(ruleOf(p), p).toMatch(/^wmux's app data/);
    }
    expect(isPluginRefusedPath(path.join(root, 'Code'))).toBe(false);
  });

  it('refuses .env and .env.* at any depth', () => {
    for (const p of [h('.env'), elsewhere('.env'), elsewhere('apps', 'web', '.env.local'), elsewhere('.ENV.production')]) {
      expect(ruleOf(p), p).toMatch(/^\.env/);
    }
    expect(isPluginRefusedPath(elsewhere('env.ts'))).toBe(false);
    expect(isPluginRefusedPath(elsewhere('.envrc'))).toBe(false);
  });

  it('refuses *.pem and *.key at any depth', () => {
    for (const p of [elsewhere('certs', 'server.pem'), elsewhere('tls.KEY'), h('Downloads', 'aws.pem')]) {
      expect(ruleOf(p), p).toMatch(/^private keys/);
    }
    expect(isPluginRefusedPath(elsewhere('keys.ts'))).toBe(false);
    expect(isPluginRefusedPath(elsewhere('monkey.json'))).toBe(false);
  });

  it('refuses SSH key files outside ~/.ssh too', () => {
    for (const p of [elsewhere('id_rsa'), elsewhere('deploy', 'id_ed25519.pub'), h('backup', 'id_ecdsa_sk')]) {
      expect(ruleOf(p), p).toMatch(/^SSH key files/);
    }
    expect(isPluginRefusedPath(elsewhere('id_map.ts'))).toBe(false);
  });

  it('refuses ~/.git-credentials', () => {
    expect(ruleOf(h('.git-credentials'))).toBe('~/.git-credentials');
    expect(isPluginRefusedPath(h('.gitconfig'))).toBe(false);
  });

  it('refuses the GitHub CLI tokens: ~/.config/gh, $XDG_CONFIG_HOME/gh and %APPDATA%\\GitHub CLI', () => {
    for (const p of [h('.config', 'gh'), h('.config', 'gh', 'hosts.yml'), h('AppData', 'Roaming', 'GitHub CLI', 'hosts.yml')]) {
      expect(ruleOf(p), p).toMatch(/^GitHub CLI tokens/);
    }
    expect(isPluginRefusedPath(h('.config', 'ghostty', 'config'))).toBe(false);
    vi.stubEnv('XDG_CONFIG_HOME', h('cfg'));
    try {
      expect(ruleOf(h('cfg', 'gh', 'hosts.yml'))).toMatch(/^GitHub CLI tokens/);
      expect(isPluginRefusedPath(h('cfg', 'ghostty'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses gcloud credentials in %APPDATA%', () => {
    expect(ruleOf(h('AppData', 'Roaming', 'gcloud', 'application_default_credentials.json'))).toMatch(/^gcloud credentials/);
    expect(isPluginRefusedPath(h('AppData', 'Roaming', 'Code'))).toBe(false);
  });

  it('refuses the Claude Code credentials and ~/.claude.json', () => {
    expect(ruleOf(h('.claude', '.credentials.json'))).toMatch(/^~\/\.claude/);
    expect(ruleOf(h('.claude.json'))).toMatch(/^~\/\.claude/);
    expect(isPluginRefusedPath(h('.claude', 'settings.json'))).toBe(false);
  });

  it('refuses ~/.codex/auth.json', () => {
    expect(ruleOf(h('.codex', 'auth.json'))).toBe('~/.codex/auth.json');
    expect(isPluginRefusedPath(h('.codex', 'config.toml'))).toBe(false);
  });

  it('refuses ~/.pgpass', () => {
    expect(ruleOf(h('.pgpass'))).toBe('~/.pgpass');
  });

  it('refuses ~/.netrc', () => {
    expect(ruleOf(h('.netrc'))).toBe('~/.netrc');
  });

  it('refuses shell history files', () => {
    for (const p of [h('.bash_history'), h('.zsh_history'), h('.sh_history'), h('.history'),
      h('.local', 'share', 'fish', 'fish_history'), h('.zsh_sessions', 'A1.historynew'),
      h('AppData', 'Roaming', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'),
      elsewhere('zdotdir', '.zsh_history')]) {
      expect(ruleOf(p), p).toMatch(/^shell history/);
    }
    expect(isPluginRefusedPath(elsewhere('src', 'history.ts'))).toBe(false);
  });

  it('has a test above for every rule', () => {
    expect(PLUGIN_FS_REFUSALS).toHaveLength(13);
  });

  it('keeps the file tree list too', () => {
    expect(isPluginRefusedPath(h('.ssh', 'config'))).toBe(true);
    expect(isPluginRefusedPath(h('.aws', 'credentials'))).toBe(true);
  });

  it('refuses a WSL distro share, whose home the rules do not know', () => {
    for (const p of ['\\\\wsl.localhost\\Ubuntu\\home\\me\\.aws\\credentials', '//wsl$/Ubuntu/home/me/notes.txt', '\\\\WSL.LOCALHOST\\Ubuntu',
      '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\.netrc']) {
      expect(isPluginRefusedPath(p), p).toBe(true);
    }
  });

  it('refuses gh tokens and wmux data under an $XDG_CONFIG_HOME outside home, with a trailing slash too', () => {
    vi.stubEnv('XDG_CONFIG_HOME', `${elsewhere('cfg')}/`);
    try {
      expect(isPluginRefusedPath(elsewhere('cfg', 'gh', 'hosts.yml'))).toBe(true);
      expect(isPluginRefusedPath(elsewhere('cfg', 'wmux-dev', 'Local Storage'))).toBe(true);
      expect(isPluginRefusedPath(elsewhere('cfg', 'ghostty', 'config'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.runIf(process.platform === 'darwin')('refuses home files spelled through the /System/Volumes/Data firmlink', () => {
    const viaData = (...p: string[]) => path.join('/System/Volumes/Data', home, ...p);
    expect(isPluginRefusedPath(viaData('.ssh', 'config'))).toBe(true);
    expect(isPluginRefusedPath(viaData('.git-credentials'))).toBe(true);
    expect(isPluginRefusedPath(viaData('.wmux', 'config.json'))).toBe(true);
    expect(isPluginRefusedPath(viaData('git', 'README.md'))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('resolvePluginPath refuses a real home file read through the /System/Volumes/Data firmlink', async () => {
    const realHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fsref-home-')));
    try {
      fs.writeFileSync(path.join(realHome, '.git-credentials'), 'x');
      fs.writeFileSync(path.join(realHome, 'notes.txt'), 'x');
      vi.spyOn(os, 'homedir').mockReturnValue(realHome);
      expect(await resolvePluginPath(path.join('/System/Volumes/Data', realHome, '.git-credentials'))).toBeNull();
      expect(await resolvePluginPath(path.join('/System/Volumes/Data', realHome, 'notes.txt'))).not.toBeNull();
    } finally {
      fs.rmSync(realHome, { recursive: true, force: true });
    }
  });

  describe('resolvePluginPath matches the refused folders by identity, whatever the spelling', () => {
    let realHome: string;
    beforeEach(() => {
      realHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fsid-home-')));
      vi.spyOn(os, 'homedir').mockReturnValue(realHome);
      fs.mkdirSync(path.join(realHome, '.ssh'));
      fs.writeFileSync(path.join(realHome, '.ssh', 'known_hosts'), 'x');
      fs.writeFileSync(path.join(realHome, 'notes.txt'), 'x');
    });
    afterEach(() => { fs.rmSync(realHome, { recursive: true, force: true }); vi.unstubAllEnvs(); });

    it.runIf(process.platform === 'darwin')('refuses ~/.ssh through the /.nofollow prefix', async () => {
      expect(await resolvePluginPath(path.join('/.nofollow', realHome, '.ssh', 'known_hosts'))).toBeNull();
      expect(await resolvePluginPath(path.join('/.nofollow', realHome, 'notes.txt'))).not.toBeNull();
    });

    it.runIf(process.platform !== 'win32')('refuses a symlinked ~/.config/gh at its real place', async () => {
      fs.mkdirSync(path.join(realHome, 'dotfiles', 'gh'), { recursive: true });
      fs.writeFileSync(path.join(realHome, 'dotfiles', 'gh', 'hosts.yml'), 'x');
      fs.mkdirSync(path.join(realHome, '.config'));
      fs.symlinkSync(path.join(realHome, 'dotfiles', 'gh'), path.join(realHome, '.config', 'gh'));
      expect(await resolvePluginPath(path.join(realHome, 'dotfiles', 'gh', 'hosts.yml'))).toBeNull();
      expect(await resolvePluginPath(path.join(realHome, 'dotfiles'))).not.toBeNull();
    });

    it.runIf(process.platform === 'darwin')('refuses a home file through /.nofollow, also after it is replaced', async () => {
      const file = path.join(realHome, '.claude.json');
      fs.writeFileSync(file, 'x');
      expect(await resolvePluginPath(path.join('/.nofollow', file))).toBeNull();
      // Replaced by rename: a new inode, as an atomic writer leaves it.
      fs.writeFileSync(`${file}.tmp`, 'y');
      fs.renameSync(`${file}.tmp`, file);
      expect(await resolvePluginPath(path.join('/.nofollow', file))).toBeNull();
      expect(await resolvePluginPath(path.join('/.nofollow', '/System/Volumes/Data', file))).toBeNull();
    });

    it('refuses creating a refused file or folder that does not exist yet', async () => {
      expect(await insideRefusedByIdentity(path.join(realHome, '.git-credentials'))).toBe(true);
      expect(await insideRefusedByIdentity(path.join(realHome, '.aws', 'credentials'))).toBe(true);
      expect(await insideRefusedByIdentity(path.join(realHome, 'notes2.txt'))).toBe(false);
    });

    it.runIf(process.platform !== 'win32')('refuses moving a folder or link that holds a refused folder', async () => {
      fs.mkdirSync(path.join(realHome, 'dotfiles', 'config', 'gh'), { recursive: true });
      fs.symlinkSync(path.join(realHome, 'dotfiles', 'config'), path.join(realHome, '.config'));
      expect(await holdsRefusedRoot(path.join(realHome, '.config'))).toBe(true);
      expect(await holdsRefusedRoot(path.join(realHome, 'dotfiles'))).toBe(true);
      expect(await holdsRefusedRoot(realHome)).toBe(true);
      fs.mkdirSync(path.join(realHome, 'work'));
      expect(await holdsRefusedRoot(path.join(realHome, 'work'))).toBe(false);
    });

    it('refuses GH_CONFIG_DIR wherever it is', async () => {
      const ghDir = path.join(realHome, 'elsewhere-gh');
      fs.mkdirSync(ghDir);
      fs.writeFileSync(path.join(ghDir, 'hosts.yml'), 'x');
      vi.stubEnv('GH_CONFIG_DIR', ghDir);
      expect(await resolvePluginPath(path.join(ghDir, 'hosts.yml'))).toBeNull();
    });
  });

  it('resolvePluginPath refuses a WSL share before it touches the disk', async () => {
    expect(await resolvePluginPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\.aws\\credentials')).toBeNull();
  });

  it('leaves ordinary paths alone', () => {
    expect(isPluginRefusedPath(home)).toBe(false);
    expect(isPluginRefusedPath(elsewhere('README.md'))).toBe(false);
    expect(isPluginRefusedPath(h('git', 'wmux', 'src', 'main', 'index.ts'))).toBe(false);
  });
});
