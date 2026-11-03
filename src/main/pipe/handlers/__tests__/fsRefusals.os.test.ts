// One test per entry of PLUGIN_FS_REFUSALS: each refused path, and a close
// neighbour that stays readable.
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(), getAllWindows: vi.fn(() => []) },
}));

import { PLUGIN_FS_REFUSALS, isPluginRefusedPath, pluginFsRefusal } from '../fsRefusals';

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
    for (const p of ['\\\\wsl.localhost\\Ubuntu\\home\\me\\.aws\\credentials', '//wsl$/Ubuntu/home/me/notes.txt', '\\\\WSL.LOCALHOST\\Ubuntu']) {
      expect(isPluginRefusedPath(p), p).toBe(true);
    }
  });

  it.runIf(process.platform === 'darwin')('refuses home files spelled through the /System/Volumes/Data firmlink', () => {
    const viaData = (...p: string[]) => path.join('/System/Volumes/Data', home, ...p);
    expect(isPluginRefusedPath(viaData('.ssh', 'config'))).toBe(true);
    expect(isPluginRefusedPath(viaData('.git-credentials'))).toBe(true);
    expect(isPluginRefusedPath(viaData('.wmux', 'config.json'))).toBe(true);
    expect(isPluginRefusedPath(viaData('git', 'README.md'))).toBe(false);
  });

  it('leaves ordinary paths alone', () => {
    expect(isPluginRefusedPath(home)).toBe(false);
    expect(isPluginRefusedPath(elsewhere('README.md'))).toBe(false);
    expect(isPluginRefusedPath(h('git', 'wmux', 'src', 'main', 'index.ts'))).toBe(false);
  });
});
