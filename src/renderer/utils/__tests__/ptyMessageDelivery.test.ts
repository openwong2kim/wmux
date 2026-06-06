import { describe, expect, it, vi } from 'vitest';
import { formatBracketedPastePayload, submitBracketedPasteToPty } from '../ptyMessageDelivery';

describe('PTY message delivery', () => {
  it('wraps inter-agent messages in bracketed paste and neutralizes ESC bytes', () => {
    const payload = formatBracketedPastePayload('line 1\n\x1b[201~printf ESCAPED');

    expect(payload).toBe('\x1b[200~line 1\n␛[201~printf ESCAPED\x1b[201~');
  });

  it('submits bracketed paste separately from Enter', () => {
    vi.useFakeTimers();
    const writes: Array<[string, string]> = [];

    submitBracketedPasteToPty('pty-1', 'line 1\nline 2', (ptyId, data) => {
      writes.push([ptyId, data]);
    });

    expect(writes).toEqual([['pty-1', '\x1b[200~line 1\nline 2\x1b[201~']]);
    vi.advanceTimersByTime(100);
    expect(writes).toEqual([
      ['pty-1', '\x1b[200~line 1\nline 2\x1b[201~'],
      ['pty-1', '\r\r'],
    ]);
    vi.useRealTimers();
  });
});
