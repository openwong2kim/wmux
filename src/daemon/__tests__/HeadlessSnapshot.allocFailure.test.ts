import { describe, expect, it } from 'vitest';
import { generateSnapshot, generateTextSnapshot } from '../HeadlessSnapshot';
import type { NativeFrozenRing } from '../../shared/nativeTerminalCore';

/**
 * #3440: copying a frozen native ring into a snapshot's input can be refused
 * (`ALLOC_FAILED: ...`). The snapshot then fails with `error`, which every
 * caller already answers with its raw / fail-open path, instead of rejecting.
 */
function frozen(readAll: () => Buffer): NativeFrozenRing {
  return { size: 64, writtenAt: 64, geometry: null, readAll, dispose: () => undefined };
}
const refused = () => { throw new Error('ALLOC_FAILED: could not allocate 8388608 bytes for frozen ring copy'); };

describe('HeadlessSnapshot: a refused native allocation while reading the input', () => {
  it('a text snapshot fails with error and the refusal as its detail', async () => {
    const out = await generateTextSnapshot({ cols: 80, rows: 24, initial: Buffer.alloc(0), nativeSource: frozen(refused) });
    expect(out).toEqual({ ok: false, reason: 'error', detail: 'ALLOC_FAILED: could not allocate 8388608 bytes for frozen ring copy' });
  });

  it('an ANSI snapshot fails with error and the refusal as its detail', async () => {
    const out = await generateSnapshot({ cols: 80, rows: 24, initial: Buffer.alloc(0), nativeSource: frozen(refused) });
    expect(out).toMatchObject({ ok: false, reason: 'error', detail: expect.stringMatching(/^ALLOC_FAILED: /) });
  });

  it('any other error still rejects as before', async () => {
    const broken = frozen(() => { throw new Error('frozen ring disposed'); });
    await expect(generateSnapshot({ cols: 80, rows: 24, initial: Buffer.alloc(0), nativeSource: broken })).rejects.toThrow('frozen ring disposed');
  });
});
