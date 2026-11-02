import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';

/**
 * A resize flushes xterm's pending write queue synchronously (xterm.js #5599).
 * When the write loop had already yielded after parsing part of the queue, the
 * flush replayed the parsed chunks too, so a pane resized while output was
 * streaming showed it twice ("> git statusgit status"). Fixed upstream in
 * xterm.js #6201; the daemon snapshot and the renderer share this core.
 */

function lineText(t: Terminal, y: number): string {
  return t.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

function writeAsync(t: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => t.write(data, resolve));
}

describe('headless resize during a streaming write', () => {
  it('keeps output written before the resize exactly once', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      await writeAsync(term, '> ');
      const callbacks: string[] = [];
      const realNow = performance.now;
      let time = 0;
      // Each clock read advances past the write time budget, so the write loop
      // yields after the echo chunk and leaves the command output queued.
      performance.now = () => (time += 20);
      try {
        await new Promise<void>((resolve) => {
          const listener = term.onWriteParsed(() => {
            listener.dispose();
            term.resize(40, 10);
            resolve();
          });
          term.write('git status', () => callbacks.push('echo'));
          term.write('\r\nOn branch main\r\n', () => callbacks.push('output'));
        });
      } finally {
        performance.now = realNow;
      }

      expect(lineText(term, 0)).toBe('> git status');
      expect(lineText(term, 1)).toBe('On branch main');
      expect(callbacks).toEqual(['echo', 'output']);
      await writeAsync(term, '> ');
      expect(lineText(term, 2)).toBe('> ');
    } finally {
      term.dispose();
    }
  });
});
