import { describe, expect, it } from 'vitest';
import {
  isReservedEnvKey,
  isValidEnvKey,
  normalizeCommand,
  normalizeEnv,
  normalizeWorkspaceProfile,
} from '../workspaceProfile';
import {
  WORKSPACE_PROFILE_COMMAND_MAX,
  WORKSPACE_PROFILE_ENV_VALUE_MAX,
  WORKSPACE_PROFILE_MAX_ENV_ENTRIES,
} from '../types';

describe('isValidEnvKey', () => {
  it('accepts shell-identifier-shaped keys', () => {
    expect(isValidEnvKey('CLAUDE_CONFIG_DIR')).toBe(true);
    expect(isValidEnvKey('_underscore')).toBe(true);
    expect(isValidEnvKey('a1')).toBe(true);
  });

  it('rejects empty, leading-digit, and illegal-char keys', () => {
    expect(isValidEnvKey('')).toBe(false);
    expect(isValidEnvKey('1ABC')).toBe(false);
    expect(isValidEnvKey('HAS SPACE')).toBe(false);
    expect(isValidEnvKey('HAS-DASH')).toBe(false);
    expect(isValidEnvKey('a=b')).toBe(false);
  });

  it('rejects reserved WMUX_* keys (any case)', () => {
    expect(isValidEnvKey('WMUX_WORKSPACE_ID')).toBe(false);
    expect(isValidEnvKey('WMUX_SURFACE_ID')).toBe(false);
    expect(isValidEnvKey('WMUX_SOCKET_PATH')).toBe(false);
    expect(isValidEnvKey('WMUX_AUTH_TOKEN')).toBe(false);
    expect(isValidEnvKey('wmux_workspace_id')).toBe(false);
    expect(isReservedEnvKey('WMUX_ANYTHING')).toBe(true);
    expect(isReservedEnvKey('PATH')).toBe(false);
  });
});

describe('normalizeEnv', () => {
  it('keeps valid string entries and drops invalid ones', () => {
    const env = normalizeEnv({
      CLAUDE_CONFIG_DIR: 'C:/a',
      '1BAD': 'x',
      WMUX_WORKSPACE_ID: 'spoof',
      NUMERIC: 123 as unknown as string,
      OK: 'yes',
    });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: 'C:/a', OK: 'yes' });
  });

  it('drops over-long values', () => {
    const env = normalizeEnv({ BIG: 'x'.repeat(WORKSPACE_PROFILE_ENV_VALUE_MAX + 1) });
    expect(env.BIG).toBeUndefined();
  });

  it('caps the number of entries', () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < WORKSPACE_PROFILE_MAX_ENV_ENTRIES + 10; i++) input[`K${i}`] = String(i);
    const env = normalizeEnv(input);
    expect(Object.keys(env)).toHaveLength(WORKSPACE_PROFILE_MAX_ENV_ENTRIES);
  });

  it('returns {} for non-object input', () => {
    expect(normalizeEnv(null)).toEqual({});
    expect(normalizeEnv('x')).toEqual({});
    expect(normalizeEnv(['a'])).toEqual({});
  });
});

describe('normalizeCommand', () => {
  it('preserves non-empty content verbatim', () => {
    expect(normalizeCommand('claude --dangerously-skip-permissions')).toBe(
      'claude --dangerously-skip-permissions',
    );
  });

  it('treats whitespace-only as absent', () => {
    expect(normalizeCommand('   ')).toBeUndefined();
    expect(normalizeCommand('')).toBeUndefined();
  });

  it('drops over-long commands and non-strings', () => {
    expect(normalizeCommand('x'.repeat(WORKSPACE_PROFILE_COMMAND_MAX + 1))).toBeUndefined();
    expect(normalizeCommand(42 as unknown as string)).toBeUndefined();
  });
});

describe('normalizeWorkspaceProfile', () => {
  it('builds a clean profile from mixed input', () => {
    const profile = normalizeWorkspaceProfile({
      env: { CLAUDE_CONFIG_DIR: 'C:/a', 'BAD KEY': 'x' } as Record<string, string>,
      defaultPaneCommand: 'claude',
      extra: 'ignored',
    });
    expect(profile).toEqual({
      env: { CLAUDE_CONFIG_DIR: 'C:/a' },
      defaultPaneCommand: 'claude',
    });
  });

  it('omits env when no valid entries remain', () => {
    const profile = normalizeWorkspaceProfile({ env: { '1BAD': 'x' }, defaultPaneCommand: 'go' });
    expect(profile).toEqual({ defaultPaneCommand: 'go' });
    expect(profile?.env).toBeUndefined();
  });

  it('returns undefined for an empty / invalid profile', () => {
    expect(normalizeWorkspaceProfile({})).toBeUndefined();
    expect(normalizeWorkspaceProfile({ env: {}, defaultPaneCommand: '  ' })).toBeUndefined();
    expect(normalizeWorkspaceProfile(null)).toBeUndefined();
    expect(normalizeWorkspaceProfile('nope')).toBeUndefined();
  });
});
