import { describe, expect, it } from 'vitest';
import { parseWslAuthRef, wslAccountAuthRef, wslAuthRef } from '../wslAccountMark';
import { authConfigDir, authLostKey, isWindowsReadableAccount, parseAgentAuthLost } from '../agentAuthLost';

const wslPane = { CLAUDE_CONFIG_DIR: 'C:\\acc\\work', WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR', WMUX_WSL_ACCOUNT_DISTRO: 'Ubuntu' };

describe('the sign-in key of a WSL account home', () => {
  it('round-trips the distro and the Windows folder', () => {
    expect(parseWslAuthRef(wslAuthRef('Ubuntu-24.04', 'C:\\acc\\work'))).toEqual({ distro: 'Ubuntu-24.04', configDir: 'C:\\acc\\work' });
    // Any name WSL takes: inner spaces and non-ASCII letters too.
    expect(parseWslAuthRef(wslAuthRef('My Distro', 'C:\\acc'))?.distro).toBe('My Distro');
    expect(parseWslAuthRef(wslAuthRef('우분투', 'C:\\acc'))?.distro).toBe('우분투');
    for (const bad of [null, 'C:\\acc\\work', 'wsl:', 'wsl::C:\\x', 'wsl:-bad:C:\\x', 'wsl:Ubuntu:']) expect(parseWslAuthRef(bad)).toBeNull();
  });

  it('is a marked WSL pane\'s only: no distro (not a WSL pane) or no mark means the folder', () => {
    expect(wslAccountAuthRef(wslPane, 'CLAUDE_CONFIG_DIR')).toBe('wsl:Ubuntu:C:\\acc\\work');
    expect(wslAccountAuthRef({ ...wslPane, WMUX_WSL_ACCOUNT_DISTRO: '' }, 'CLAUDE_CONFIG_DIR')).toBeNull();
    expect(wslAccountAuthRef({ ...wslPane, WMUX_WSL_ACCOUNT_KEYS: 'CODEX_HOME' }, 'CLAUDE_CONFIG_DIR')).toBeNull();
  });

  it('keys the auth-lost notice apart from the same account\'s Windows panes, and crosses the pipe', () => {
    expect(authConfigDir('claude', wslPane)).toBe('wsl:Ubuntu:C:\\acc\\work');
    expect(authConfigDir('claude', { CLAUDE_CONFIG_DIR: 'C:\\acc\\work' })).toBe('C:\\acc\\work');
    expect(authLostKey('claude', authConfigDir('claude', wslPane))).not.toBe(authLostKey('claude', 'C:\\acc\\work'));
    expect(isWindowsReadableAccount('wsl:Ubuntu:C:\\acc\\work')).toBe(false);
    expect(isWindowsReadableAccount('C:\\acc\\work')).toBe(true);
    expect(isWindowsReadableAccount(null)).toBe(true);
    expect(parseAgentAuthLost({ agent: 'claude', configDir: 'wsl:Ubuntu:C:\\acc\\work', origin: 'turn', at: 1 })?.configDir).toBe('wsl:Ubuntu:C:\\acc\\work');
  });
});
