// @vitest-environment jsdom
/**
 * Phase 3 PR-A — the hydrate-before-read parse barrier.
 *
 * hydrateTerminalForRead ends with `terminal.write('', resolve)`: the empty
 * write's callback must fire only after xterm has parsed everything handed
 * over before it, so an MCP buffer read scans a settled buffer. This pins the
 * xterm contract the barrier depends on (callback fires for empty writes, and
 * strictly after earlier queued writes have been parsed) against the real
 * (headless) Terminal — if an xterm upgrade ever changes either property, the
 * hydrate path would silently return stale reads.
 */
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';

const bufferLine = (term: Terminal, y: number): string =>
  term.buffer.active.getLine(y)?.translateToString(true) ?? '';

describe('hydrate parse barrier — empty-write callback contract (headless xterm)', () => {
  it('fires the callback for an empty write', async () => {
    const term = new Terminal();
    try {
      await new Promise<void>((resolve) => term.write('', resolve));
    } finally {
      term.dispose();
    }
  });

  it('resolves only after previously handed-over bytes are parsed into the buffer', async () => {
    const term = new Terminal();
    try {
      term.write('retained-backlog');
      await new Promise<void>((resolve) => term.write('', resolve));
      expect(bufferLine(term, 0)).toBe('retained-backlog');
    } finally {
      term.dispose();
    }
  });
});
