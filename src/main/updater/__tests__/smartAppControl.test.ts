// #1525 — the pre-quit Smart App Control check. Pure parts only: nothing here
// spawns reg.exe or PowerShell (the machine running the suite may itself have
// SAC enforcing, which must not decide a test's outcome).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assessSmartAppControlBlock,
  isLikelyBlockedBySmartAppControl,
  parseSacPolicyState,
  SAC_STATE_ENFORCE,
} from '../smartAppControl';

const realPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

function onPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

describe('parseSacPolicyState', () => {
  it.each([
    ['0x1', 1],
    ['0x2', 2],
    ['0x0', 0],
  ])('reads REG_DWORD %s', (hex, expected) => {
    const out =
      '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n' +
      `    VerifiedAndReputablePolicyState    REG_DWORD    ${hex}\r\n\r\n`;
    expect(parseSacPolicyState(out)).toBe(expected);
  });

  it('answers null when the value is not in the output', () => {
    expect(parseSacPolicyState('')).toBeNull();
    expect(parseSacPolicyState('    SomethingElse    REG_DWORD    0x1')).toBeNull();
  });
});

describe('isLikelyBlockedBySmartAppControl', () => {
  it('blocks only when enforcing AND the signature is not Valid', () => {
    expect(isLikelyBlockedBySmartAppControl(SAC_STATE_ENFORCE, 'UnknownError')).toBe(true);
    expect(isLikelyBlockedBySmartAppControl(SAC_STATE_ENFORCE, 'NotSigned')).toBe(true);
    expect(isLikelyBlockedBySmartAppControl(SAC_STATE_ENFORCE, 'Valid')).toBe(false);
    expect(isLikelyBlockedBySmartAppControl(2, 'UnknownError')).toBe(false); // evaluation never blocks
    expect(isLikelyBlockedBySmartAppControl(0, 'NotSigned')).toBe(false); // off
    expect(isLikelyBlockedBySmartAppControl(null, 'NotSigned')).toBe(false); // no SAC on this build
  });
});

describe('assessSmartAppControlBlock', () => {
  it('enforcing + a test-signed installer (UnknownError) → likely blocked', async () => {
    onPlatform('win32');
    const probes = {
      readState: vi.fn(async () => 1),
      readSignatureStatus: vi.fn(async () => 'UnknownError'),
    };
    await expect(assessSmartAppControlBlock('C:\\t\\Setup.exe', probes)).resolves.toEqual({
      likelyBlocked: true, sacState: 1, signatureStatus: 'UnknownError',
    });
    expect(probes.readSignatureStatus).toHaveBeenCalledWith('C:\\t\\Setup.exe');
  });

  it.each([0, 2, null])('state %s → clear, without paying for the signature probe', async (state) => {
    onPlatform('win32');
    const probes = {
      readState: vi.fn(async () => state),
      readSignatureStatus: vi.fn(async () => 'NotSigned'),
    };
    const verdict = await assessSmartAppControlBlock('C:\\t\\Setup.exe', probes);
    expect(verdict.likelyBlocked).toBe(false);
    expect(probes.readSignatureStatus).not.toHaveBeenCalled();
  });

  it('enforcing + a Valid signature → clear', async () => {
    onPlatform('win32');
    const verdict = await assessSmartAppControlBlock('C:\\t\\Setup.exe', {
      readState: async () => 1,
      readSignatureStatus: async () => 'Valid',
    });
    expect(verdict.likelyBlocked).toBe(false);
  });

  it('a failing probe throws so the caller can fail open', async () => {
    onPlatform('win32');
    await expect(assessSmartAppControlBlock('C:\\t\\Setup.exe', {
      readState: async () => 1,
      readSignatureStatus: async () => { throw new Error('timed out'); },
    })).rejects.toThrow('timed out');
  });

  it('never probes off Windows', async () => {
    onPlatform('darwin');
    const probes = { readState: vi.fn(async () => 1), readSignatureStatus: vi.fn(async () => 'NotSigned') };
    const verdict = await assessSmartAppControlBlock('/tmp/x.zip', probes);
    expect(verdict.likelyBlocked).toBe(false);
    expect(probes.readState).not.toHaveBeenCalled();
  });
});
