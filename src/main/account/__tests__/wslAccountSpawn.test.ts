import { describe, expect, it } from 'vitest';
import { paneAccountKeys } from '../wslAccountSpawn';

const accounts = () => [
  { vendor: 'claude' as const, configDir: 'C:\\Users\\dev\\.wmux\\accounts\\work' },
  { vendor: 'codex' as const, configDir: 'C:\\Users\\dev\\.wmux\\accounts\\codex' },
];

describe('paneAccountKeys', () => {
  it('counts the account a pane names or rotated to, while its folder is the pane\'s', () => {
    const override = { vendor: 'claude' as const, configDir: 'C:\\Users\\dev\\.wmux\\accounts\\work' };
    expect(paneAccountKeys({ CLAUDE_CONFIG_DIR: override.configDir }, { override, accounts })).toEqual(['CLAUDE_CONFIG_DIR']);
    expect(paneAccountKeys({ CLAUDE_CONFIG_DIR: 'C:\\elsewhere' }, { override, accounts })).toEqual([]);
  });

  it('honours a re-sign-in tab only for a registered account\'s folder of that vendor', () => {
    const work = 'c:/users/dev/.wmux/accounts/work/';
    expect(paneAccountKeys({ CLAUDE_CONFIG_DIR: work }, { requested: 'CLAUDE_CONFIG_DIR', supplied: { CLAUDE_CONFIG_DIR: work }, accounts })).toEqual(['CLAUDE_CONFIG_DIR']);
    // Not an account, another vendor's folder, a profile that won, or a key that is not an account variable.
    expect(paneAccountKeys({ CLAUDE_CONFIG_DIR: 'C:\\x' }, { requested: 'CLAUDE_CONFIG_DIR', supplied: { CLAUDE_CONFIG_DIR: 'C:\\x' }, accounts })).toEqual([]);
    const codex = 'C:\\Users\\dev\\.wmux\\accounts\\codex';
    expect(paneAccountKeys({ CLAUDE_CONFIG_DIR: codex }, { requested: 'CLAUDE_CONFIG_DIR', supplied: { CLAUDE_CONFIG_DIR: codex }, accounts })).toEqual([]);
    expect(paneAccountKeys({ CLAUDE_CONFIG_DIR: 'C:\\profile' }, { requested: 'CLAUDE_CONFIG_DIR', supplied: { CLAUDE_CONFIG_DIR: work }, accounts })).toEqual([]);
    expect(paneAccountKeys({ PATH: work }, { requested: 'PATH', supplied: { PATH: work }, accounts })).toEqual([]);
  });
});
