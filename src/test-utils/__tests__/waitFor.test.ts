import { describe, it, expect } from 'vitest';
import { waitFor, DEFAULT_WAIT_TIMEOUT_MS } from '../waitFor';

describe('waitFor', () => {
  it('returns as soon as the condition holds, without waiting out the timeout', async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 20);

    const started = Date.now();
    await waitFor(() => ready, 2_000);
    // The point of polling over sleeping: a fast machine pays ~nothing.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('returns immediately when the condition already holds', async () => {
    const started = Date.now();
    await waitFor(() => true, 2_000);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('★ names what it was waiting for when it times out', async () => {
    // The whole reason this replaced `setTimeout(50)`: the failure that started
    // this was an anonymous "timed out in 5000ms" that said nothing about the
    // condition, so diagnosing it meant reading CI logs line by line.
    // `let`, not `const`: a const 0 narrows to the literal type and `=== 1`
    // becomes a compile error rather than a condition that never holds.
    let connectionCount = 0;
    connectionCount += 0;
    await expect(waitFor(() => connectionCount === 1, 30)).rejects.toThrow(
      /waitFor: \(\) => connectionCount === 1 did not hold within 30ms/,
    );
  });

  it('prefers an explicit label when one is given', async () => {
    await expect(waitFor(() => false, 30, 'the pane to attach')).rejects.toThrow(
      'waitFor: the pane to attach did not hold within 30ms',
    );
  });

  it('bounds a long predicate so the message stays readable', async () => {
    // The literal has to be in the arrow's SOURCE, not behind a variable — a
    // long value with a short expression produces a short label, which is
    // correct and is what an earlier version of this test failed to check.
    // And the expression has to survive the transform: vite 6's esbuild
    // constant-folds a static concat-and-compare ('xx' + 'yy' === 'z') down
    // to `() => false`, which un-longs the source. A method call on the
    // literal is not folded, so the long source reaches toString().
    const predicate = (): boolean =>
      'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.includes(
        'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
      );
    let message = '';
    await waitFor(predicate, 30).catch((err: Error) => { message = err.message; });
    expect(message).toContain('…');
    expect(message.length).toBeLessThan(200);
  });

  it('has a default timeout that fits under a 5s vitest timeout', () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBeLessThan(5_000);
  });
});
