import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROCESSENTRY32W_SIZE,
  isGoneAfterOpenFailure,
  readProcessExitState,
  setNativeBindingsForTests,
  tryProcessHandleApi,
  tryProcessIdentity,
  type NativeBindings,
} from '../winSnapshotNative';

const ERROR_ACCESS_DENIED = 5;
const ERROR_NO_MORE_FILES = 18;
const ERROR_INVALID_PARAMETER = 87;
const PID = 4321;

/**
 * Bindings where OpenProcess fails with the given codes (one per call, the
 * last repeating) and the Toolhelp walk lists `listed` (plus this process,
 * which the walk's self-check requires), or fails when `listed` is 'fail'.
 */
function fakeBindings(openErrors: number[], listed: number[] | 'fail') {
  let lastError = 0;
  let opens = 0;
  const rows = listed === 'fail' ? [] : [process.pid, ...listed];
  let cursor = 0;
  const writeRow = (entry: Buffer): number => {
    entry.writeUInt32LE(rows[cursor], 8);
    entry.writeUInt32LE(0, 32);
    return 1;
  };
  const snapshot = vi.fn(() => (listed === 'fail' ? -1n : 77n));
  const unused = () => { throw new Error('not used here'); };
  const b = {
    OpenProcess: () => {
      lastError = openErrors[Math.min(opens++, openErrors.length - 1)];
      return 0n;
    },
    GetLastError: () => lastError,
    CreateToolhelp32Snapshot: snapshot,
    Process32FirstW: (_s: unknown, entry: Buffer) => {
      expect(entry.length).toBe(PROCESSENTRY32W_SIZE);
      cursor = 0;
      return writeRow(entry);
    },
    Process32NextW: (_s: unknown, entry: Buffer) => {
      cursor++;
      if (cursor >= rows.length) {
        lastError = ERROR_NO_MORE_FILES;
        return 0;
      }
      return writeRow(entry);
    },
    CloseHandle: () => 1,
    GetExtendedTcpTable: unused,
    GetProcessTimes: unused,
    QueryFullProcessImageNameW: unused,
    TerminateProcess: unused,
    WaitForSingleObject: unused,
    GetSystemTimeAsFileTime: unused,
    GetExitCodeProcess: unused,
  } as unknown as NativeBindings;
  return { b, snapshot };
}

afterEach(() => setNativeBindingsForTests(undefined));

describe('isGoneAfterOpenFailure', () => {
  it('is gone only for error 87 with the pid missing from the table', () => {
    expect(isGoneAfterOpenFailure(ERROR_INVALID_PARAMETER, false)).toBe(true);
    expect(isGoneAfterOpenFailure(ERROR_INVALID_PARAMETER, true)).toBe(false);
    expect(isGoneAfterOpenFailure(ERROR_INVALID_PARAMETER, null)).toBe(false);
    expect(isGoneAfterOpenFailure(ERROR_ACCESS_DENIED, false)).toBe(false);
    expect(isGoneAfterOpenFailure(0, false)).toBe(false);
  });
});

describe('a failed OpenProcess is confirmed against the process table', () => {
  it('tryProcessIdentity: gone only when the pid is not listed', () => {
    setNativeBindingsForTests(fakeBindings([ERROR_INVALID_PARAMETER], [PID]).b);
    expect(tryProcessIdentity(PID)).toEqual({ failure: 'OpenProcess failed (error 87)', gone: false });

    setNativeBindingsForTests(fakeBindings([ERROR_INVALID_PARAMETER], []).b);
    expect(tryProcessIdentity(PID)).toEqual({ failure: 'OpenProcess failed (error 87)', gone: true });

    setNativeBindingsForTests(fakeBindings([ERROR_INVALID_PARAMETER], 'fail').b);
    expect(tryProcessIdentity(PID)).toEqual({ failure: 'OpenProcess failed (error 87)', gone: false });
  });

  it('readProcessExitState: exited only when the pid is not listed', () => {
    setNativeBindingsForTests(fakeBindings([ERROR_INVALID_PARAMETER], [PID]).b);
    expect(readProcessExitState(PID)).toBe('unknown');

    setNativeBindingsForTests(fakeBindings([ERROR_INVALID_PARAMETER], []).b);
    expect(readProcessExitState(PID)).toBe('exited');

    setNativeBindingsForTests(fakeBindings([ERROR_INVALID_PARAMETER], 'fail').b);
    expect(readProcessExitState(PID)).toBe('unknown');
  });

  it('ProcessHandleApi.open: gone only when the pid is not listed, on either open', () => {
    setNativeBindingsForTests(fakeBindings([ERROR_INVALID_PARAMETER], [PID]).b);
    expect(tryProcessHandleApi()?.open(PID)).toEqual({ failure: 'OpenProcess failed (error 87)' });

    setNativeBindingsForTests(fakeBindings([ERROR_INVALID_PARAMETER], []).b);
    expect(tryProcessHandleApi()?.open(PID)).toEqual({ gone: true });

    // Access denied for terminate, then 87 on the query-only open.
    setNativeBindingsForTests(fakeBindings([ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER], [PID]).b);
    expect(tryProcessHandleApi()?.open(PID)).toEqual({ failure: 'OpenProcess failed (error 87)' });

    setNativeBindingsForTests(fakeBindings([ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER], []).b);
    expect(tryProcessHandleApi()?.open(PID)).toEqual({ gone: true });
  });

  it('reads the table only for error 87', () => {
    const { b, snapshot } = fakeBindings([ERROR_ACCESS_DENIED], []);
    setNativeBindingsForTests(b);
    expect(readProcessExitState(PID)).toBe('unknown');
    expect(tryProcessIdentity(PID)).toEqual({ failure: 'OpenProcess failed (error 5)', gone: false });
    expect(snapshot).not.toHaveBeenCalled();
  });
});
