import { afterEach, describe, expect, it } from 'vitest';
import {
  dataSuffix,
  getPipeName,
  getAuthTokenPath,
  getWmuxHomeDir,
  getPidMapDir,
  getTcpPortPath,
  getDaemonAuthTokenPath,
  getLegacyDaemonAuthTokenPath,
} from '../constants';

// WMUX_DATA_SUFFIX 기반 인스턴스 격리. dev 빌드와 packaged 빌드(또는 다른
// 체크아웃의 빌드)가 같은 소켓·토큰·~/.wmux를 두고 충돌하던 문제를 막는다.
describe('dataSuffix 인스턴스 격리', () => {
  const orig = process.env.WMUX_DATA_SUFFIX;
  afterEach(() => {
    if (orig === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = orig;
  });

  it('suffix 미설정(packaged 기본) 시 기존 경로를 그대로 유지한다', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    expect(dataSuffix()).toBe('');
    expect(getAuthTokenPath()).toMatch(/\.wmux-auth-token$/);
    expect(getWmuxHomeDir()).toMatch(/\.wmux$/);
    expect(getPidMapDir()).toMatch(/\.wmux[\\/]pid-map$/);
    if (process.platform !== 'win32') {
      expect(getPipeName()).toMatch(/\.wmux\.sock$/);
    }
  });

  it('suffix 설정 시 모든 경로(소켓/토큰/홈/pid-map/tcp)에 격리가 반영된다', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(dataSuffix()).toBe('-dev');
    expect(getAuthTokenPath()).toMatch(/\.wmux-dev-auth-token$/);
    expect(getWmuxHomeDir()).toMatch(/\.wmux-dev$/);
    expect(getPidMapDir()).toMatch(/\.wmux-dev[\\/]pid-map$/);
    expect(getTcpPortPath()).toMatch(/\.wmux-dev-tcp-port$/);
    if (process.platform === 'win32') {
      expect(getPipeName()).toContain('wmux-dev-');
    } else {
      expect(getPipeName()).toMatch(/\.wmux-dev\.sock$/);
    }
  });

  it('핵심 불변식: packaged 경로와 dev 경로는 절대 겹치지 않는다', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    const packagedPipe = getPipeName();
    const packagedHome = getWmuxHomeDir();
    const packagedToken = getAuthTokenPath();

    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(getPipeName()).not.toBe(packagedPipe);
    expect(getWmuxHomeDir()).not.toBe(packagedHome);
    expect(getAuthTokenPath()).not.toBe(packagedToken);
  });
});

// The daemon control-pipe auth token. Unlike the main token (a
// ~/.wmux${suffix}-auth-token FILE) this lives INSIDE the ~/.wmux dir, so the
// suffix rides on the DIRECTORY. The daemon WRITES it, the launcher + CLI READ
// it — all three route through getDaemonAuthTokenPath so they cannot drift.
describe('daemon auth token path (suffix-aware, 3-way lockstep)', () => {
  const orig = process.env.WMUX_DATA_SUFFIX;
  afterEach(() => {
    if (orig === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = orig;
  });

  it('default (no suffix) is byte-identical to the legacy path — no stranding on upgrade', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    expect(getDaemonAuthTokenPath()).toBe(getLegacyDaemonAuthTokenPath());
    expect(getDaemonAuthTokenPath()).toMatch(/\.wmux[\\/]daemon-auth-token$/);
  });

  it('lives inside the suffix-aware home dir (co-located with config.json / daemon pipe)', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    expect(getDaemonAuthTokenPath()).toBe(`${getWmuxHomeDir()}/daemon-auth-token`);
  });

  it('a suffix isolates the token from production; the legacy fallback stays unsuffixed', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(getDaemonAuthTokenPath()).toMatch(/\.wmux-dev[\\/]daemon-auth-token$/);
    // Isolation: a suffixed instance must NOT resolve to the shared prod file.
    expect(getDaemonAuthTokenPath()).not.toBe(getLegacyDaemonAuthTokenPath());
    expect(getLegacyDaemonAuthTokenPath()).toMatch(/\.wmux[\\/]daemon-auth-token$/);
    expect(getLegacyDaemonAuthTokenPath()).not.toContain('.wmux-dev');
  });
});

// P7 — 데몬/세션 소켓을 ~/.wmux{suffix}/ 하위로 이동. 바인더(daemon)와
// 클라이언트(main/cli)가 전부 이 헬퍼를 쓰므로 여기서 경로 형태를 고정한다.
describe('P7 소켓 경로 (~/.wmux 하위 + sun_path 한계)', () => {
  const orig = process.env.WMUX_DATA_SUFFIX;
  afterEach(() => {
    if (orig === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = orig;
  });

  it('신규 소켓은 ~/.wmux{suffix}/ 하위, legacy는 홈 직하 형태를 유지한다', async () => {
    if (process.platform === 'win32') return; // named pipe는 경로 규칙 대상 아님
    // Mock HOME to a deterministic short value so the socket-path length assert
    // below doesn't depend on the real $HOME (flaky on CI with long profile
    // names). getWmuxHomeDir prefers USERPROFILE over HOME, so drop USERPROFILE
    // to make HOME authoritative. Both are restored in the finally.
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = '/tmp/wmux-test-home';
    delete process.env.USERPROFILE;
    delete process.env.WMUX_DATA_SUFFIX;
    try {
      const {
        getDaemonSocketPath, getLegacyDaemonSocketPath,
        getSessionSocketPath, getLegacySessionSocketPath, getWmuxHomeDir,
      } = await import('../constants');
      const sessionId = '123e4567-e89b-42d3-a456-426614174000'; // uuid 36자
      expect(getDaemonSocketPath()).toBe(`${getWmuxHomeDir()}/daemon.sock`);
      expect(getSessionSocketPath(sessionId)).toBe(`${getWmuxHomeDir()}/session-${sessionId}.sock`);
      // legacy 경로는 구버전 코드와 byte-동일해야 폴백/마이그레이션 판정이 맞는다
      expect(getLegacyDaemonSocketPath()).toMatch(/\/\.wmux-daemon\.sock$/);
      expect(getLegacySessionSocketPath(sessionId)).toMatch(/\/\.wmux-session-.*\.sock$/);
      // sun_path 104바이트 한계(macOS) — uuid 세션 id 기준으로 여유 확인
      expect(Buffer.byteLength(getSessionSocketPath(sessionId))).toBeLessThanOrEqual(104);
      // suffix는 디렉토리에만 반영(파일명 중복 없음 → 경로 단축)
      process.env.WMUX_DATA_SUFFIX = '-dev';
      expect(getDaemonSocketPath()).toMatch(/\/\.wmux-dev\/daemon\.sock$/);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    }
  });
});
