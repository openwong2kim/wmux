// @vitest-environment jsdom
//
// Fleet reads a background pane's tail from the daemon: a pane outside the
// active workspace has no renderer xterm buffer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tailForPtyOrDaemon } from '../terminalTail';

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
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
    expect(readText).toHaveBeenCalledWith('pty-bg', { scrollback: 80 });
  });

  it('answers [] when the daemon has nothing or the read throws', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { readText: async () => ({ success: false, code: 'session-gone' }) } };
    expect(await tailForPtyOrDaemon('pty-x', 20)).toEqual([]);
    (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { readText: async () => { throw new Error('boom'); } } };
    expect(await tailForPtyOrDaemon('pty-x', 20)).toEqual([]);
  });
});
