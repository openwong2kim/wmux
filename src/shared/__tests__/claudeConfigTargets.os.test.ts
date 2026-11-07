import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeConfigTargets, envClaudeConfigDir } from '../claudeConfigTargets';

let tmp: string;
let defaultSettingsPath: string;
let wmuxDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-targets-'));
  defaultSettingsPath = path.join(tmp, 'home', '.claude', 'settings.json');
  wmuxDir = path.join(tmp, 'home', '.wmux-x');
  fs.mkdirSync(wmuxDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeAccounts(rows: unknown[]): void {
  fs.writeFileSync(path.join(wmuxDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: rows }), 'utf8');
}

const kinds = (targets: ReturnType<typeof claudeConfigTargets>) => targets.map((t) => `${t.kind}:${t.settingsPath}`);

describe('envClaudeConfigDir', () => {
  it('takes an absolute folder, refuses a relative one with the reason, and reads empty as unset', () => {
    const abs = path.join(tmp, 'cfg');
    expect(envClaudeConfigDir(abs)).toEqual({ dir: abs, refused: null });
    expect(envClaudeConfigDir('  ')).toEqual({ dir: null, refused: null });
    expect(envClaudeConfigDir(undefined)).toEqual({ dir: null, refused: null });
    const relative = envClaudeConfigDir('cfg');
    expect(relative.dir).toBeNull();
    expect(relative.refused).toContain('not an absolute path');
  });
});

describe('claudeConfigTargets', () => {
  it('env unset: ~/.claude first, then each Claude account from this instance accounts.json', () => {
    const a = path.join(tmp, 'acct-a');
    fs.mkdirSync(a, { recursive: true });
    writeAccounts([
      { name: 'A', vendor: 'claude', configDir: a },
      { name: 'C', vendor: 'codex', configDir: path.join(tmp, 'codex') },
      { name: 'empty', vendor: 'claude', configDir: '' },
    ]);
    const targets = claudeConfigTargets({ envDir: null, defaultSettingsPath, wmuxDir, includeDefault: () => false });
    expect(kinds(targets)).toEqual([`default:${defaultSettingsPath}`, `account:${path.join(a, 'settings.json')}`]);
    expect(targets[1].label).toBe('account A');
  });

  it('env set: the env folder first; ~/.claude only when the caller includes it', () => {
    const env = path.join(tmp, 'cfg');
    expect(kinds(claudeConfigTargets({ envDir: env, defaultSettingsPath, wmuxDir, includeDefault: () => false })))
      .toEqual([`env:${path.join(env, 'settings.json')}`]);
    expect(kinds(claudeConfigTargets({ envDir: env, defaultSettingsPath, wmuxDir, includeDefault: () => true })))
      .toEqual([`env:${path.join(env, 'settings.json')}`, `default:${defaultSettingsPath}`]);
  });

  it('lists one file once: two accounts on one folder under another letter case, where that is one file', () => {
    const dir = path.join(tmp, 'shared');
    fs.mkdirSync(dir, { recursive: true });
    const variant = process.platform === 'win32' || process.platform === 'darwin' ? dir.toUpperCase() : dir;
    writeAccounts([{ name: 'one', vendor: 'claude', configDir: dir }, { name: 'case', vendor: 'claude', configDir: variant }]);
    expect(kinds(claudeConfigTargets({ envDir: null, defaultSettingsPath, wmuxDir, includeDefault: () => false })))
      .toEqual([`default:${defaultSettingsPath}`, `account:${path.join(dir, 'settings.json')}`]);
  });

  it('skips a UNC account folder and reads a missing accounts.json as none', () => {
    writeAccounts([{ name: 'wsl', vendor: 'claude', configDir: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude' }]);
    expect(kinds(claudeConfigTargets({ envDir: null, defaultSettingsPath, wmuxDir, includeDefault: () => false })))
      .toEqual([`default:${defaultSettingsPath}`]);
    fs.rmSync(path.join(wmuxDir, 'accounts.json'));
    expect(claudeConfigTargets({ envDir: null, defaultSettingsPath, wmuxDir, includeDefault: () => false })).toHaveLength(1);
  });

  it('takes the accounts from the caller when given, without reading accounts.json', () => {
    writeAccounts([{ name: 'file', vendor: 'claude', configDir: path.join(tmp, 'from-file') }]);
    const given = path.join(tmp, 'given');
    fs.mkdirSync(given, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'from-file'), { recursive: true });
    expect(kinds(claudeConfigTargets({ envDir: null, defaultSettingsPath, wmuxDir, includeDefault: () => false, accounts: [{ label: 'g', configDir: given }] })))
      .toEqual([`default:${defaultSettingsPath}`, `account:${path.join(given, 'settings.json')}`]);
  });
});

describe('claudeConfigTargets: folders wmux set or lost', () => {
  it('an env that names an account folder (wmux set it in that account pane) is not the primary: ~/.claude is', () => {
    const a = path.join(tmp, 'acct-a');
    fs.mkdirSync(a, { recursive: true });
    writeAccounts([{ name: 'A', vendor: 'claude', configDir: a }]);
    expect(kinds(claudeConfigTargets({ envDir: a, defaultSettingsPath, wmuxDir, includeDefault: () => false })))
      .toEqual([`default:${defaultSettingsPath}`, `account:${path.join(a, 'settings.json')}`]);
  });

  it('skips an account folder that no longer exists, so nothing recreates it', () => {
    writeAccounts([{ name: 'gone', vendor: 'claude', configDir: path.join(tmp, 'gone') }]);
    expect(kinds(claudeConfigTargets({ envDir: null, defaultSettingsPath, wmuxDir, includeDefault: () => false })))
      .toEqual([`default:${defaultSettingsPath}`]);
  });
});
