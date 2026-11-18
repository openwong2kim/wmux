import { describe, expect, it } from 'vitest';
import {
  WSL_ACCOUNT_KEYS_ENV, accountSourcedKeys, isWslSafeSuffix, parseWslAccountKeys, setWslAccountKeys, wslAccountHomeKey,
  wslAccountLinuxHome,
} from '../wslAccountHome';

describe('the account mark', () => {
  it('reads only the two account variables, in a fixed order', () => {
    expect(parseWslAccountKeys('CODEX_HOME, CLAUDE_CONFIG_DIR,PATH')).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
    expect(parseWslAccountKeys(undefined)).toEqual([]);
  });

  it('marks keys that have a value, and drops the mark when none is left', () => {
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: 'C:\\a', CODEX_HOME: '' };
    setWslAccountKeys(env, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
    expect(env[WSL_ACCOUNT_KEYS_ENV]).toBe('CLAUDE_CONFIG_DIR');
    setWslAccountKeys(env, []);
    expect(env[WSL_ACCOUNT_KEYS_ENV]).toBeUndefined();
  });

  it('counts a variable as the binding\'s only while it still holds the binding\'s value', () => {
    const accountEnv = { CLAUDE_CONFIG_DIR: 'C:\\accounts\\work', CODEX_HOME: 'C:\\accounts\\codex' };
    expect(accountSourcedKeys({ CLAUDE_CONFIG_DIR: 'C:\\profile\\own', CODEX_HOME: 'C:\\accounts\\codex' }, accountEnv)).toEqual(['CODEX_HOME']);
    expect(accountSourcedKeys({ CLAUDE_CONFIG_DIR: 'C:\\inherited' }, undefined)).toEqual([]);
  });
});

describe('the Linux home of an account', () => {
  it('keys the same folder the same way whatever its case or trailing separator', () => {
    const key = wslAccountHomeKey('C:\\Users\\dev\\.wmux\\accounts\\work');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(wslAccountHomeKey('c:/users/DEV/.wmux/accounts/work/')).toBe(key);
    expect(wslAccountHomeKey('C:\\Users\\dev\\.wmux\\accounts\\other')).not.toBe(key);
  });

  it('is under ~/.wmux<suffix>/accounts for a marked account, and nothing otherwise', () => {
    const env = { CLAUDE_CONFIG_DIR: 'C:\\accounts\\work', WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR', WMUX_DATA_SUFFIX: '-s1' };
    const key = wslAccountHomeKey('C:\\accounts\\work');
    expect(wslAccountLinuxHome(env, 'claude', 'dev')).toBe(`/home/dev/.wmux-s1/accounts/claude-${key}`);
    expect(wslAccountLinuxHome(env, 'claude', 'root')).toBe(`/root/.wmux-s1/accounts/claude-${key}`);
    expect(wslAccountLinuxHome(env, 'codex', 'dev')).toBeNull();
    expect(wslAccountLinuxHome({ ...env, WMUX_WSL_ACCOUNT_KEYS: '' }, 'claude', 'dev')).toBeNull();
    expect(wslAccountLinuxHome(env, 'claude', '../x')).toBeNull();
    expect(wslAccountLinuxHome({ ...env, WMUX_DATA_SUFFIX: '/../x' }, 'claude', 'dev')).toBeNull();
  });

  it('takes a data suffix only when it can name a folder', () => {
    for (const ok of ['', '-dev', '-verify-a1', 'x.y_z']) expect(isWslSafeSuffix(ok)).toBe(true);
    for (const bad of ['/x', '..', 'a b', 'a\\b', '$(x)']) expect(isWslSafeSuffix(bad)).toBe(false);
  });
});
