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

describe('getDaemonPipeName', () => {
  it('derives the win32 daemon pipe name (suffix + username)', () => {
    setPlatform('win32');
    expect(getDaemonPipeName()).toBe('\\\\.\\pipe\\wmux-daemon-tester');
  });

  it('applies WMUX_DATA_SUFFIX to the win32 daemon pipe name', () => {
    setPlatform('win32');
    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(getDaemonPipeName()).toBe('\\\\.\\pipe\\wmux-daemon-dev-tester');
  });

  it('derives the unix daemon socket path under the home dir', () => {
    setPlatform('linux');
    // path.join uses the host separator (the test host is Windows), so assert
    // the segments rather than a hardcoded forward-slash literal. The real code
    // mirrors src/main/DaemonClient.ts getDaemonPipeName (path.join on unix).
    const result = getDaemonPipeName();
    expect(result).toContain('home');
    expect(result).toContain('.wmux-daemon.sock');
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
    expect(resolveDaemonPipeName()).toBe('\\\\.\\pipe\\wmux-daemon-tester');
  });

  it('falls back to the derived name when the hint file is empty/whitespace', () => {
    setPlatform('win32');
    readFileSyncMock.mockReturnValue('   \n');
    expect(resolveDaemonPipeName()).toBe('\\\\.\\pipe\\wmux-daemon-tester');
  });
});

describe('resolveDaemonAuthToken', () => {
  it('returns the trimmed token from ~/.wmux/daemon-auth-token', () => {
    readFileSyncMock.mockReturnValue('  SECRET123\n');
    expect(resolveDaemonAuthToken()).toBe('SECRET123');
    // NOTE: the daemon token path is NOT suffix-aware (hardcoded ~/.wmux).
    const readPath = String(readFileSyncMock.mock.calls[0][0]);
    expect(readPath).toContain('.wmux');
    expect(readPath).toContain('daemon-auth-token');
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
