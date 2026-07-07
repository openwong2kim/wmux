import { describe, it, expect } from 'vitest';
import {
  buildSafeChildEnv,
  isSensitiveEnvKey,
  buildInteractiveShellEnv,
  buildGatedAutomationEnv,
  withheldCredentialNames,
  isInternalEnvKey,
  isCredentialEnvKey,
} from '../envFilter';

describe('isSensitiveEnvKey', () => {
  it('blocks Electron build/runtime internals', () => {
    expect(isSensitiveEnvKey('ELECTRON_RUN_AS_NODE')).toBe(true);
    expect(isSensitiveEnvKey('ELECTRON_FOO')).toBe(true);
    expect(isSensitiveEnvKey('VITE_DEV_SERVER_URL')).toBe(true);
    expect(isSensitiveEnvKey('NODE_OPTIONS')).toBe(true);
    expect(isSensitiveEnvKey('ORIGINAL_XDG_DATA_HOME')).toBe(true);
  });

  it('blocks wmux internal auth tokens', () => {
    expect(isSensitiveEnvKey('WMUX_AUTH_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('WMUX_AUTH_FOO')).toBe(true);
  });

  it('blocks suffix-pattern credentials', () => {
    expect(isSensitiveEnvKey('GITHUB_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('NPM_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('CLIENT_SECRET')).toBe(true);
    expect(isSensitiveEnvKey('DB_PASSWORD')).toBe(true);
    expect(isSensitiveEnvKey('STRIPE_API_KEY')).toBe(true);
    expect(isSensitiveEnvKey('AWS_CREDENTIALS')).toBe(true);
  });

  it('blocks well-known credential exact names', () => {
    expect(isSensitiveEnvKey('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isSensitiveEnvKey('AWS_SESSION_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSensitiveEnvKey('OPENAI_API_KEY')).toBe(true);
    expect(isSensitiveEnvKey('DATABASE_URL')).toBe(true);
    expect(isSensitiveEnvKey('GH_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('DOCKER_PASSWORD')).toBe(true);
  });

  it('passes through SAFE_PASSTHROUGH overrides even when they match a pattern', () => {
    // SSH_AUTH_SOCK ends in nothing sensitive, but COLORTERM doesn't either —
    // these are explicit allowlist entries. Ensure they're not blocked even
    // if a future regex would match them.
    expect(isSensitiveEnvKey('SSH_AUTH_SOCK')).toBe(false);
    expect(isSensitiveEnvKey('COLORTERM')).toBe(false);
  });

  it('passes through unrelated user environment', () => {
    expect(isSensitiveEnvKey('PATH')).toBe(false);
    expect(isSensitiveEnvKey('HOME')).toBe(false);
    expect(isSensitiveEnvKey('USERPROFILE')).toBe(false);
    expect(isSensitiveEnvKey('TERM')).toBe(false);
    expect(isSensitiveEnvKey('LANG')).toBe(false);
    expect(isSensitiveEnvKey('SHELL')).toBe(false);
  });
});

describe('buildSafeChildEnv', () => {
  it('strips sensitive keys and keeps the rest', () => {
    const env = buildSafeChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      WMUX_AUTH_TOKEN: 'leaky',
      GITHUB_TOKEN: 'ghs_xxx',
      ANTHROPIC_API_KEY: 'sk-xxx',
      ELECTRON_RUN_AS_NODE: '1',
      VITE_DEV_SERVER_URL: 'http://localhost:5173',
      DATABASE_URL: 'postgres://u:p@host/db',
      SSH_AUTH_SOCK: '/tmp/ssh-agent',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent');

    expect(env.WMUX_AUTH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.VITE_DEV_SERVER_URL).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('drops undefined values', () => {
    const env = buildSafeChildEnv({ PATH: '/usr/bin', UNDEFINED_VAR: undefined });
    expect(env.PATH).toBe('/usr/bin');
    expect('UNDEFINED_VAR' in env).toBe(false);
  });

  it('returns a fresh object — caller can mutate without polluting baseEnv', () => {
    const base = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    const env = buildSafeChildEnv(base);
    env.WMUX_SOCKET_PATH = '/tmp/sock';
    expect(base).not.toHaveProperty('WMUX_SOCKET_PATH');
  });

  it('defaults to process.env when no base provided', () => {
    // Just ensure it doesn't throw and returns an object
    const env = buildSafeChildEnv();
    expect(env).toBeTypeOf('object');
  });
});

describe('execution-context env builders', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    KAD_GATEWAY_KEY: 'k',
    GITHUB_TOKEN: 'g',
    ANTHROPIC_API_KEY: 'a',
    WMUX_AUTH_TOKEN: 'leak',
    ELECTRON_RUN_AS_NODE: '1',
    VITE_DEV_SERVER_URL: 'http://x',
    SSH_AUTH_SOCK: '/s',
  };

  it('interactive shell keeps credentials, strips only wmux/Electron internals', () => {
    const env = buildInteractiveShellEnv(base);
    // 자격증명 투과 (신고 사건 해결)
    expect(env.KAD_GATEWAY_KEY).toBe('k');
    expect(env.GITHUB_TOKEN).toBe('g');
    expect(env.ANTHROPIC_API_KEY).toBe('a');
    expect(env.SSH_AUTH_SOCK).toBe('/s');
    expect(env.PATH).toBe('/usr/bin');
    // 내부는 항상 strip
    expect(env.WMUX_AUTH_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.VITE_DEV_SERVER_URL).toBeUndefined();
  });

  it('gated automation strips both internals and credentials (== buildSafeChildEnv)', () => {
    const env = buildGatedAutomationEnv(base);
    expect(env.KAD_GATEWAY_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.WMUX_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SSH_AUTH_SOCK).toBe('/s'); // safe-passthrough는 gated에서도 생존
  });
});

describe('case-insensitive matching (lower/mixed-case bypass fix)', () => {
  it('matches lowercase credential + internal names', () => {
    expect(isCredentialEnvKey('github_token')).toBe(true);
    expect(isCredentialEnvKey('my_api_key')).toBe(true);
    expect(isInternalEnvKey('electron_run_as_node')).toBe(true);
    expect(isSensitiveEnvKey('secret_token')).toBe(true);
  });

  it('gated build strips a lowercase-named credential', () => {
    const env = buildGatedAutomationEnv({ PATH: '/p', secret_token: 's' });
    expect(env.secret_token).toBeUndefined();
    expect(env.PATH).toBe('/p');
  });
});

describe('withheldCredentialNames', () => {
  it('lists credential names present, excluding internals and safe-passthrough', () => {
    const names = withheldCredentialNames({
      PATH: '/p',
      KAD_GATEWAY_KEY: 'k',
      GITHUB_TOKEN: 'g',
      WMUX_AUTH_TOKEN: 'x',   // internal → 제외
      SSH_AUTH_SOCK: '/s',    // safe-passthrough → 제외
    });
    expect(names.sort()).toEqual(['GITHUB_TOKEN', 'KAD_GATEWAY_KEY']);
  });

  it('is empty when no credentials are present', () => {
    expect(withheldCredentialNames({ PATH: '/p', HOME: '/h' })).toEqual([]);
  });
});
