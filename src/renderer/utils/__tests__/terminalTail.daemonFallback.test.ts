// @vitest-environment jsdom
//
// Fleet reads a background pane's tail from the daemon: a pane outside the
// active workspace has no renderer xterm buffer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAIL_POLL_FULL_MS, TAIL_POLL_MS, pollTail, tailForPtyOrDaemon } from '../terminalTail';

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.useRealTimers();
});

describe('tailForPtyOrDaemon', () => {
  it('falls back to the daemon snapshot, joining wrapped rows into lines', async () => {
    const readText = vi.fn(async () => ({
      success: true as const,
      rows: [
        { text: '> npm run build', wrapped: false },
        { text: 'Error: build fai', wrapped: false },
        { text: 'led with 1 error', wrapped: true },
        { text: '', wrapped: false },
      ],
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { readText } };
    expect(await tailForPtyOrDaemon('pty-bg', 20)).toEqual(['> npm run build', 'Error: build failed with 1 error']);
    expect(readText).toHaveBeenCalledWith('pty-bg', { scrollback: 80, tail: true });
  });

  it('answers [] when the daemon has nothing or the read throws', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { readText: async () => ({ success: false, code: 'session-gone' }) } };
    expect(await tailForPtyOrDaemon('pty-x', 20)).toEqual([]);
    (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { readText: async () => { throw new Error('boom'); } } };
    expect(await tailForPtyOrDaemon('pty-x', 20)).toEqual([]);
  });
});

describe('pollTail (Fleet preview)', () => {
  it('backs off to 3 s while the daemon reads the whole ring, and returns to 750 ms on the first tail answer', async () => {
    vi.useFakeTimers();
    const via: Array<'tail' | 'full'> = ['tail', 'full', 'full', 'tail', 'tail'];
    let reads = 0;
    const readText = vi.fn(async () => ({ success: true as const, rows: [{ text: `read ${reads}`, wrapped: false }], via: via[reads++] }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { readText } };
    const seen: string[][] = [];
    const poll = pollTail((onVia) => tailForPtyOrDaemon('pty-bg', 20, onVia), (lines) => seen.push(lines));
    const settle = () => vi.advanceTimersByTimeAsync(0);

    await settle();
    expect(readText).toHaveBeenCalledTimes(1); // via 'tail': next in 750 ms
    await vi.advanceTimersByTimeAsync(TAIL_POLL_MS);
    expect(readText).toHaveBeenCalledTimes(2); // via 'full': next in 3 s
    await vi.advanceTimersByTimeAsync(TAIL_POLL_FULL_MS - 1);
    expect(readText).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(readText).toHaveBeenCalledTimes(3); // 'full' again: still 3 s
    await vi.advanceTimersByTimeAsync(TAIL_POLL_FULL_MS);
    expect(readText).toHaveBeenCalledTimes(4); // 'tail': back to 750 ms
    await vi.advanceTimersByTimeAsync(TAIL_POLL_MS);
    expect(readText).toHaveBeenCalledTimes(5);
    expect(seen.map((lines) => lines[0])).toEqual(['read 0', 'read 1', 'read 2', 'read 3', 'read 4']);

    poll.stop();
    await vi.advanceTimersByTimeAsync(10 * TAIL_POLL_FULL_MS);
    expect(readText).toHaveBeenCalledTimes(5);
  });

  it('a daemon that predates `via` keeps the 750 ms poll; refresh reads now; nothing arrives after stop', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const readText = vi.fn(() => new Promise<{ success: true; rows: Array<{ text: string; wrapped: boolean }> }>((resolve) => {
      release = () => resolve({ success: true, rows: [{ text: 'old daemon', wrapped: false }] });
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { readText } };
    const seen: string[][] = [];
    const poll = pollTail((onVia) => tailForPtyOrDaemon('pty-bg', 20, onVia), (lines) => seen.push(lines));
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TAIL_POLL_MS);
    expect(readText).toHaveBeenCalledTimes(2);
    poll.refresh();
    expect(readText).toHaveBeenCalledTimes(3);
    poll.stop();
    release();
    await vi.advanceTimersByTimeAsync(10 * TAIL_POLL_MS);
    expect(seen).toHaveLength(1);
    expect(readText).toHaveBeenCalledTimes(3);
  });
});
