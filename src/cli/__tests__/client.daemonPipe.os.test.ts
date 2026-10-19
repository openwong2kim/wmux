/**
 * Daemon control-pipe resolution for `wmux doctor`.
 *
 * Regression guard for the doctor "down — Unknown method: daemon.ping" defect:
 * the doctor used to ping the daemon via the MAIN process pipe, where
 * `daemon.ping` is not registered. The fix routes the ping to the DAEMON pipe,
 * resolved by these helpers. These tests pin the four resolution cases the live
 * dogfood exercised:
 *   1. daemon-pipe hint file present → use its value (authoritative name)
 *   2. hint file absent              → fall back to the derived convention
 *   3. daemon auth token present     → returned trimmed
 *   4. daemon auth token absent      → undefined
 *
 * `fs` and `os` are mocked so the test is hermetic (no real ~/.wmux access).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/os BEFORE importing the module under test (hoisted by Vitest).
vi.mock('fs');
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(), userInfo: vi.fn() };
});

import * as fs from 'fs';
import * as os from 'os';
import {
  getDaemonPipeName,
  resolveDaemonPipeName,
  resolveDaemonAuthToken,
} from '../client';

const readFileSyncMock = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;
const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>;
const userInfoMock = os.userInfo as unknown as ReturnType<typeof vi.fn>;

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_SUFFIX = process.env.WMUX_DATA_SUFFIX;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  homedirMock.mockReturnValue('/home/u');
  userInfoMock.mockReturnValue({ username: 'tester' } as os.UserInfo<string>);
  delete process.env.WMUX_DATA_SUFFIX;
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  if (ORIGINAL_SUFFIX === undefined) delete process.env.WMUX_DATA_SUFFIX;
  else process.env.WMUX_DATA_SUFFIX = ORIGINAL_SUFFIX;
});

// P7: 파이프 이름 파생은 shared/constants의 getDaemonSocketPath로 위임됐다.
// shared 헬퍼는 `require('os')`/env 기반이라 이 파일의 os mock이 닿지 않으므로
// 정확한 username 대신 형태(shape)를 고정한다. unix 경로는 ~/.wmux{suffix}/
// 하위로 이동(구경로 `~/.wmux-daemon.sock` 회귀 방지 역-assertion 포함).
describe('getDaemonPipeName', () => {
  it('derives the win32 daemon pipe name (username 포함)', () => {
    setPlatform('win32');
    expect(getDaemonPipeName()).toMatch(/^\\\\\.\\pipe\\wmux-daemon-.+$/);
  });

  it('applies WMUX_DATA_SUFFIX to the win32 daemon pipe name', () => {
    setPlatform('win32');
    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(getDaemonPipeName()).toMatch(/^\\\\\.\\pipe\\wmux-daemon-dev-.+$/);
  });

  it('derives the unix daemon socket path under ~/.wmux (P7)', () => {
    setPlatform('linux');
    const ORIGINAL_HOME = process.env.HOME;
    const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
    process.env.HOME = '/home/u';
    delete process.env.USERPROFILE;
    try {
      expect(getDaemonPipeName()).toBe('/home/u/.wmux/daemon.sock');
    } finally {
      if (ORIGINAL_HOME === undefined) delete process.env.HOME;
      else process.env.HOME = ORIGINAL_HOME;
      if (ORIGINAL_USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
    }
  });
});

describe('resolveDaemonPipeName', () => {
  it('prefers the daemon-pipe hint file when present (authoritative name)', () => {
    setPlatform('win32');
    // The daemon may have fallen back to a renamed pipe; the hint file is the
    // source of truth, so its value must win over the derived convention.
    readFileSyncMock.mockReturnValue('\\\\.\\pipe\\wmux-daemon-fallback-xyz\n');
    expect(resolveDaemonPipeName()).toBe('\\\\.\\pipe\\wmux-daemon-fallback-xyz');
    // It read from the suffix-aware ~/.wmux<suffix>/daemon-pipe path.
    const readPath = String(readFileSyncMock.mock.calls[0][0]);
    expect(readPath).toContain('.wmux');
    expect(readPath).toContain('daemon-pipe');
  });

  it('falls back to the derived name when the hint file is absent', () => {
    setPlatform('win32');
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(resolveDaemonPipeName()).toMatch(/^\\\\\.\\pipe\\wmux-daemon-.+$/);
  });

  it('falls back to the derived name when the hint file is empty/whitespace', () => {
    setPlatform('win32');
    readFileSyncMock.mockReturnValue('   \n');
    expect(resolveDaemonPipeName()).toMatch(/^\\\\\.\\pipe\\wmux-daemon-.+$/);
  });
});

describe('resolveDaemonAuthToken', () => {
  // getDaemonAuthTokenPath / getLegacyDaemonAuthTokenPath resolve home from
  // USERPROFILE||HOME (not os.homedir), so pin them for a deterministic path.
  const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
  const ORIGINAL_HOME = process.env.HOME;

  beforeEach(() => {
    process.env.USERPROFILE = '/home/u';
    process.env.HOME = '/home/u';
  });

  afterEach(() => {
    if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  });

  it('returns the trimmed token; default (no suffix) reads ~/.wmux/daemon-auth-token', () => {
    readFileSyncMock.mockReturnValue('  SECRET123\n');
    expect(resolveDaemonAuthToken()).toBe('SECRET123');
    const readPath = String(readFileSyncMock.mock.calls[0][0]).replace(/\\/g, '/');
    expect(readPath).toBe('/home/u/.wmux/daemon-auth-token');
  });

  it('reads the SUFFIXED path first when WMUX_DATA_SUFFIX is set (isolation)', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    readFileSyncMock.mockReturnValue('DEVTOKEN\n');
    expect(resolveDaemonAuthToken()).toBe('DEVTOKEN');
    const readPath = String(readFileSyncMock.mock.calls[0][0]).replace(/\\/g, '/');
    expect(readPath).toBe('/home/u/.wmux-dev/daemon-auth-token');
  });

  it('falls back to the legacy unsuffixed path when the suffixed path is absent', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    // First candidate (suffixed) missing, second candidate (legacy) present —
    // a suffixed instance upgrading over a still-running older daemon.
    readFileSyncMock
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      })
      .mockReturnValueOnce('LEGACYTOKEN\n');
    expect(resolveDaemonAuthToken()).toBe('LEGACYTOKEN');
    expect(readFileSyncMock).toHaveBeenCalledTimes(2);
    const first = String(readFileSyncMock.mock.calls[0][0]).replace(/\\/g, '/');
    const second = String(readFileSyncMock.mock.calls[1][0]).replace(/\\/g, '/');
    expect(first).toBe('/home/u/.wmux-dev/daemon-auth-token');
    expect(second).toBe('/home/u/.wmux/daemon-auth-token');
  });

  it('returns undefined when the token file is absent', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(resolveDaemonAuthToken()).toBeUndefined();
  });

  it('returns undefined for an empty token file', () => {
    readFileSyncMock.mockReturnValue('\n');
    expect(resolveDaemonAuthToken()).toBeUndefined();
  });
});
