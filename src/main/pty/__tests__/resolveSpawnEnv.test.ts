import { describe, expect, it } from 'vitest';
import { resolveSpawnEnv } from '../resolveSpawnEnv';

describe('resolveSpawnEnv', () => {
  it('strips inherited secrets from the baseline', () => {
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-x', WMUX_AUTH_TOKEN: 't' },
      undefined,
      {},
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.WMUX_AUTH_TOKEN).toBeUndefined();
  });

  it('applies any profile key verbatim (spawn mechanism — policy is one layer up)', () => {
    // resolveSpawnEnv applies whatever the profile contains; it does NOT re-run
    // the denylist on profile keys. WHICH keys a profile may contain is decided
    // by the editor policy (workspaceProfile: secret-named keys dropped on
    // save), tested separately. Here we only assert the mechanism: a key that
    // reaches this layer survives even if its name matches the baseline denylist.
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin' },
      { GEMINI_API_KEY: 'x', CLAUDE_CONFIG_DIR: 'C:/a' },
      {},
    );
    expect(env.GEMINI_API_KEY).toBe('x');
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:/a');
  });

  it('applies accountEnv (CLAUDE_CONFIG_DIR) as a layer between baseline and profile', () => {
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin' },
      undefined,
      {},
      undefined,
      'gated',
      { CLAUDE_CONFIG_DIR: 'C:/accounts/work' },
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:/accounts/work');
  });

  it('lets a MANUAL profile CLAUDE_CONFIG_DIR win over the account binding', () => {
    // The existing contributor workflow (manual profile env) must keep working:
    // profile overlay is applied AFTER accountEnv, so it wins on conflict.
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin' },
      { CLAUDE_CONFIG_DIR: 'C:/manual/override' },
      {},
      undefined,
      'gated',
      { CLAUDE_CONFIG_DIR: 'C:/accounts/work' },
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:/manual/override');
  });

  it('3-layer precedence: baseline < accountEnv < profile', () => {
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin', CODEX_HOME: 'C:/inherited' },
      { A_ONLY_PROFILE: 'p' },
      {},
      undefined,
      'passthrough',
      { CODEX_HOME: 'C:/accounts/codex', A_ONLY_ACCOUNT: 'a' },
    );
    // accountEnv overrides inherited baseline; profile-only + account-only both survive.
    expect(env.CODEX_HOME).toBe('C:/accounts/codex');
    expect(env.A_ONLY_ACCOUNT).toBe('a');
    expect(env.A_ONLY_PROFILE).toBe('p');
  });

  // Windows env vars are case-insensitive; a manual profile 'claude_config_dir'
  // must still beat a bound 'CLAUDE_CONFIG_DIR' without both surviving.
  (process.platform === 'win32' ? it : it.skip)(
    'win32: manual profile beats account even with different key casing', () => {
      const env = resolveSpawnEnv(
        { PATH: '/usr/bin' },
        { claude_config_dir: 'C:/manual' },
        {},
        undefined,
        'gated',
        { CLAUDE_CONFIG_DIR: 'C:/account' },
      );
      // Only one case-variant survives, and it is the profile's value.
      const keys = Object.keys(env).filter((k) => k.toLowerCase() === 'claude_config_dir');
      expect(keys).toHaveLength(1);
      expect(env[keys[0]]).toBe('C:/manual');
    });

  it('accountEnv cannot spoof reserved WMUX_* identity', () => {
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin' },
      undefined,
      { WMUX_WORKSPACE_ID: 'real-ws' },
      undefined,
      'gated',
      { WMUX_WORKSPACE_ID: 'spoof', CLAUDE_CONFIG_DIR: 'C:/a' },
    );
    expect(env.WMUX_WORKSPACE_ID).toBe('real-ws');
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:/a');
  });

  it('forces identity last so a profile cannot spoof it', () => {
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin' },
      { WMUX_WORKSPACE_ID: 'spoof', WMUX_SOCKET_PATH: 'spoof' },
      { WMUX_WORKSPACE_ID: 'real-ws', WMUX_SURFACE_ID: 'real-surface' },
    );
    expect(env.WMUX_WORKSPACE_ID).toBe('real-ws');
    expect(env.WMUX_SURFACE_ID).toBe('real-surface');
    // applyProfileEnv already skips reserved keys, so the spoof never even
    // reaches the identity step — but identity-last is the belt to that braces.
    expect(env.WMUX_SOCKET_PATH).toBeUndefined();
  });

  it('carries the display-only workspace NAME with the same forced-identity ordering as the id', () => {
    // WMUX_WORKSPACE_NAME is a label (wmux web shows "Workspace 1 · claude"
    // instead of a bare cwd), but it rides in the identity block, so a profile
    // or an account overlay cannot rewrite what a pane claims its workspace is.
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin', WMUX_WORKSPACE_NAME: 'inherited-parent-ws' },
      { WMUX_WORKSPACE_NAME: 'spoof-profile' },
      { WMUX_WORKSPACE_ID: 'ws-1', WMUX_WORKSPACE_NAME: 'Workspace 1' },
      undefined,
      'gated',
      { WMUX_WORKSPACE_NAME: 'spoof-account' },
    );
    expect(env.WMUX_WORKSPACE_NAME).toBe('Workspace 1');
    expect(env.WMUX_WORKSPACE_ID).toBe('ws-1');
  });

  it('omits the workspace name when the caller has none (never fabricated downstream)', () => {
    // The name is optional: main only stamps it when the workspace mirror knows
    // one. Its absence is what tells wmux web to fall back to the cwd label —
    // so a stale inherited value must not survive to fill the gap.
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin', WMUX_WORKSPACE_NAME: 'parent-pane-ws' },
      undefined,
      { WMUX_WORKSPACE_ID: 'ws-1' },
    );
    expect(env.WMUX_WORKSPACE_NAME).toBeUndefined();
  });

  it('lets identity carry a socket path (local-mode shape) without profile spoofing', () => {
    const env = resolveSpawnEnv({}, undefined, {
      WMUX_SOCKET_PATH: '\\\\.\\pipe\\wmux',
      WMUX_WORKSPACE_ID: 'ws-1',
    });
    expect(env.WMUX_SOCKET_PATH).toBe('\\\\.\\pipe\\wmux');
    expect(env.WMUX_WORKSPACE_ID).toBe('ws-1');
  });

  it('drops STALE inherited WMUX_* identity the caller does not force (nested-wmux launch)', () => {
    // Simulates `npm start` from inside a wmux pane: the child main process
    // inherits the parent pane's identity in its own env. The new child must
    // NOT carry that stale identity forward — only what we force survives.
    const env = resolveSpawnEnv(
      {
        PATH: '/usr/bin',
        WMUX_WORKSPACE_ID: 'parent-ws',
        WMUX_SURFACE_ID: 'parent-surface',
        WMUX_SOCKET_PATH: '\\\\.\\pipe\\parent',
      },
      undefined,
      // Daemon-mode shape: only workspace id is forced (no socket path, no surface id).
      { WMUX_WORKSPACE_ID: 'child-ws' },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.WMUX_WORKSPACE_ID).toBe('child-ws');     // forced wins
    expect(env.WMUX_SURFACE_ID).toBeUndefined();        // stale parent value dropped
    expect(env.WMUX_SOCKET_PATH).toBeUndefined();       // stale parent socket dropped
  });

  it('strips the reserved namespace case-insensitively', () => {
    const env = resolveSpawnEnv({ wmux_socket_path: 'stale', PATH: '/p' }, undefined, {});
    expect(env.wmux_socket_path).toBeUndefined();
    expect(env.PATH).toBe('/p');
  });

  it('propagates the instance-isolation suffix from the spawning env (dogfood pipe, not prod)', () => {
    // WMUX_DATA_SUFFIX selects which instance a child joins; unlike identity it
    // must SURVIVE the WMUX_* strip, else an isolated pane's agent/MCP/CLI
    // computes an empty suffix and connects to the PRODUCTION control pipe.
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin', WMUX_DATA_SUFFIX: '-rc35' },
      undefined,
      { WMUX_WORKSPACE_ID: 'child-ws' },
    );
    expect(env.WMUX_DATA_SUFFIX).toBe('-rc35'); // re-keyed onto THIS instance
    expect(env.WMUX_WORKSPACE_ID).toBe('child-ws');
  });

  it('never lets a profile set the isolation suffix (only the spawning env)', () => {
    // A profile cannot redirect a child onto another instance's pipe:
    // applyProfileEnv skips reserved WMUX_*, and the suffix is re-applied ONLY
    // from baseEnv (the spawning process's real env).
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin' },              // real env has NO suffix
      { WMUX_DATA_SUFFIX: '-attacker' }, // profile tries to inject one
      {},
    );
    expect(env.WMUX_DATA_SUFFIX).toBeUndefined();
  });

  it('omits the suffix when the spawning env has none (production child stays on the prod pipe)', () => {
    const env = resolveSpawnEnv({ PATH: '/usr/bin' }, undefined, {});
    expect(env.WMUX_DATA_SUFFIX).toBeUndefined();
  });

  // issue #321 — Dock-launched macOS 앱은 LANG을 상속하지 않아 셸이 C 로케일로
  // 떨어지고 한글 입력이 <0085> 식으로 깨진다. 폴백 주입을 검증한다.
  it('injects the fallback locale as LANG when no locale var is set', () => {
    const env = resolveSpawnEnv({ PATH: '/usr/bin' }, undefined, {}, 'ko_KR.UTF-8');
    expect(env.LANG).toBe('ko_KR.UTF-8');
  });

  it('never overrides a LANG/LC_ALL/LC_CTYPE the user already set', () => {
    const withLang = resolveSpawnEnv({ LANG: 'ja_JP.UTF-8' }, undefined, {}, 'ko_KR.UTF-8');
    expect(withLang.LANG).toBe('ja_JP.UTF-8');

    const withLcAll = resolveSpawnEnv({ LC_ALL: 'en_GB.UTF-8' }, undefined, {}, 'ko_KR.UTF-8');
    expect(withLcAll.LANG).toBeUndefined();
    expect(withLcAll.LC_ALL).toBe('en_GB.UTF-8');

    const withCtype = resolveSpawnEnv({ LC_CTYPE: 'en_US.UTF-8' }, undefined, {}, 'ko_KR.UTF-8');
    expect(withCtype.LANG).toBeUndefined();
  });

  it('does not touch locale when no fallback is provided (Windows / opt-out)', () => {
    const env = resolveSpawnEnv({ PATH: '/usr/bin' }, undefined, {});
    expect(env.LANG).toBeUndefined();
  });
});

describe('resolveSpawnEnv — execution-context policy', () => {
  it('passthrough keeps credential-named vars (reported KAD_GATEWAY_KEY case)', () => {
    // 사용자가 직접 연 셸: 자격증명 투과(tmux 동형). 신고 사건 해결 경로.
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin', KAD_GATEWAY_KEY: 'secret', GITHUB_TOKEN: 'ghp', WMUX_AUTH_TOKEN: 't' },
      undefined,
      {},
      undefined,
      'passthrough',
    );
    expect(env.KAD_GATEWAY_KEY).toBe('secret');
    expect(env.GITHUB_TOKEN).toBe('ghp');
    expect(env.PATH).toBe('/usr/bin');
    // 내부 auth는 passthrough여도 무조건 strip.
    expect(env.WMUX_AUTH_TOKEN).toBeUndefined();
  });

  it('gated strips credential-named vars — and is the default (fail-closed)', () => {
    const base = { PATH: '/usr/bin', KAD_GATEWAY_KEY: 'secret', GITHUB_TOKEN: 'ghp' };
    const explicitGated = resolveSpawnEnv(base, undefined, {}, undefined, 'gated');
    const defaultGated = resolveSpawnEnv(base, undefined, {}); // 정책 미지정 → gated
    for (const env of [explicitGated, defaultGated]) {
      expect(env.KAD_GATEWAY_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.PATH).toBe('/usr/bin');
    }
  });

  it('passthrough still forces identity + drops stale WMUX_* (policy only swaps the credential baseline)', () => {
    const env = resolveSpawnEnv(
      { PATH: '/p', WMUX_WORKSPACE_ID: 'stale', API_KEY: 'k' },
      undefined,
      { WMUX_WORKSPACE_ID: 'real' },
      undefined,
      'passthrough',
    );
    expect(env.API_KEY).toBe('k');               // 자격증명 투과
    expect(env.WMUX_WORKSPACE_ID).toBe('real');  // 정체성은 여전히 강제
  });
});
