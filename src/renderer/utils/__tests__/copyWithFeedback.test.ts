/**
 * Tests for `runCopyWithFeedback` — the pure branching core that decides
 * whether to clear the selection / show the success toast or keep the
 * selection / show an error toast based on whether the clipboard write
 * resolved or rejected.
 */
import { describe, it, expect, vi } from 'vitest';
import { runCopyWithFeedback } from '../copyWithFeedback';

function makeDeps(overrides: Partial<Parameters<typeof runCopyWithFeedback>[1]> = {}) {
  // Default `write` impl: async no-op that records the call via vi.fn. We
  // assert the arg via toHaveBeenCalledWith elsewhere, so no need to bind a
  // named parameter inside the impl.
  const write = vi.fn((): Promise<void> => Promise.resolve());
  return {
    write,
    clearSelection: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('runCopyWithFeedback — success path', () => {
  it('forwards selection to write()', async () => {
    const deps = makeDeps();
    await runCopyWithFeedback('hello', deps);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith('hello');
  });

  it('clears selection and shows success toast when write resolves', async () => {
    const deps = makeDeps();
    await runCopyWithFeedback('text', deps);
    expect(deps.clearSelection).toHaveBeenCalledTimes(1);
    expect(deps.onSuccess).toHaveBeenCalledTimes(1);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('still resolves (does not throw) when caller passes empty string', async () => {
    const deps = makeDeps();
    await expect(runCopyWithFeedback('', deps)).resolves.toBeUndefined();
    expect(deps.write).toHaveBeenCalledWith('');
  });
});

describe('runCopyWithFeedback — failure path', () => {
  it('shows error toast and KEEPS selection when write rejects', async () => {
    const err = new Error('CLIPBOARD_TOO_LARGE');
    const deps = makeDeps({
      write: vi.fn(async () => {
        throw err;
      }),
    });
    await runCopyWithFeedback('huge', deps);
    expect(deps.clearSelection).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledTimes(1);
  });

  it('does not propagate the rejection to the caller', async () => {
    const deps = makeDeps({
      write: vi.fn(async () => {
        const e = new Error('CLIPBOARD_WRITE_FAILED') as Error & { code?: string };
        e.code = 'CLIPBOARD_WRITE_FAILED';
        throw e;
      }),
    });
    await expect(runCopyWithFeedback('x', deps)).resolves.toBeUndefined();
  });

  it('handles synchronous throws from write', async () => {
    const deps = makeDeps({
      write: vi.fn(() => {
        throw new Error('sync boom');
      }) as unknown as (t: string) => Promise<void>,
    });
    await runCopyWithFeedback('x', deps);
    expect(deps.onError).toHaveBeenCalledTimes(1);
    expect(deps.clearSelection).not.toHaveBeenCalled();
  });
});

describe('runCopyWithFeedback — ordering guarantees', () => {
  it('clears selection BEFORE showing success toast (no race for users who key-mash)', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      clearSelection: vi.fn(() => {
        order.push('clear');
      }),
      onSuccess: vi.fn(() => {
        order.push('toast');
      }),
    });
    await runCopyWithFeedback('s', deps);
    expect(order).toEqual(['clear', 'toast']);
  });
});

describe('runCopyWithFeedback — clean copy', () => {
  it('writes the resolved text, not the raw selection', async () => {
    const deps = makeDeps({ resolve: vi.fn(async () => 'clean') });
    await runCopyWithFeedback('│ raw  ', deps);
    expect(deps.resolve).toHaveBeenCalledWith('│ raw  ');
    expect(deps.write).toHaveBeenCalledWith('clean');
    expect(deps.clearSelection).toHaveBeenCalledTimes(1);
    expect(deps.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('a copy that starts during the write keeps its selection', async () => {
    let current = true;
    const deps = makeDeps({
      resolve: async () => 'clean',
      isCurrent: () => current,
      write: vi.fn(async () => { current = false; }), // copy-on-select of a new selection started
    });
    await runCopyWithFeedback('old', deps);
    expect(deps.write).toHaveBeenCalledWith('clean');
    expect(deps.clearSelection).not.toHaveBeenCalled();
  });

  it('a copy superseded while it resolved writes nothing and shows no toast', async () => {
    let finish!: (text: string) => void;
    let current = true;
    const deps = makeDeps({
      resolve: () => new Promise<string>((r) => { finish = r; }),
      isCurrent: () => current,
    });
    const run = runCopyWithFeedback('old', deps);
    current = false; // a newer copy started
    finish('old clean');
    await run;
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.clearSelection).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });
});
