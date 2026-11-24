import { describe, expect, it } from 'vitest';
import { generateSnapshot, generateTextSnapshot } from '../HeadlessSnapshot';
import type { NativeFrozenRing } from '../../shared/nativeTerminalCore';
import { nativeAllocError } from '../../shared/__tests__/_nativeAllocError';

/**
 * #3440: copying a frozen native ring into a snapshot's input can be refused
 * (an error with `code: 'ALLOC_FAILED'`). The snapshot then fails with `error`
 * and `allocFailed`, which every caller already answers with its raw /
 * fail-open path, instead of rejecting.
 */
function frozen(readAll: () => Buffer): NativeFrozenRing {
  return { size: 64, writtenAt: 64, geometry: null, readAll, dispose: () => undefined };
}
const refused = () => { throw nativeAllocError('ALLOC_FAILED: could not allocate 8388608 bytes for frozen ring copy'); };

describe('HeadlessSnapshot: a refused native allocation while reading the input', () => {
  it('a text snapshot fails with error and the refusal as its detail', async () => {
    const out = await generateTextSnapshot({ cols: 80, rows: 24, initial: Buffer.alloc(0), nativeSource: frozen(refused) });
    expect(out).toEqual({ ok: false, reason: 'error', detail: 'ALLOC_FAILED: could not allocate 8388608 bytes for frozen ring copy', allocFailed: true });
  });

  it('an ANSI snapshot fails with error and the refusal as its detail', async () => {
    const out = await generateSnapshot({ cols: 80, rows: 24, initial: Buffer.alloc(0), nativeSource: frozen(refused) });
    expect(out).toMatchObject({ ok: false, reason: 'error', detail: expect.stringMatching(/^ALLOC_FAILED: /), allocFailed: true });
  });

  it('a refusal with an empty message is still one, described by its code', async () => {
    const out = await generateTextSnapshot({ cols: 80, rows: 24, initial: Buffer.alloc(0), nativeSource: frozen(() => { throw nativeAllocError(''); }) });
    expect(out).toEqual({ ok: false, reason: 'error', detail: 'ALLOC_FAILED', allocFailed: true });
  });

  it('a message that reads "ALLOC_FAILED:" without the code rejects as any other error', async () => {
    const lookalike = frozen(() => { throw new Error('ALLOC_FAILED: could not allocate 8 bytes'); });
    await expect(generateTextSnapshot({ cols: 80, rows: 24, initial: Buffer.alloc(0), nativeSource: lookalike })).rejects.toThrow('ALLOC_FAILED: could not allocate 8 bytes');
  });

  it('any other error still rejects as before', async () => {
    const broken = frozen(() => { throw new Error('frozen ring disposed'); });
    await expect(generateSnapshot({ cols: 80, rows: 24, initial: Buffer.alloc(0), nativeSource: broken })).rejects.toThrow('frozen ring disposed');
  });
});
