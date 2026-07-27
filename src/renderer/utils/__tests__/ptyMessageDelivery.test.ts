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

  // The composer gate has to cover the PAYLOAD, not just the Enter. Guarding
  // only the deferred `\r` still pushed the user's text into an arrow-key
  // permission menu, where it is echoed into whatever the menu does with
  // printable input.
  it('writes NOTHING when the guard refuses at call time', () => {
    vi.useFakeTimers();
    const writes: Array<[string, string]> = [];
    const ok = submitBracketedPasteToPty(
      'pty-1',
      'delete everything',
      (ptyId, data) => { writes.push([ptyId, data]); },
      { submitGuard: () => false },
    );
    expect(ok).toBe(false);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(writes).toEqual([]);
    vi.useRealTimers();
  });

  it('still writes the payload and skips only the Enter when the gate engages mid-window', () => {
    vi.useFakeTimers();
    const writes: Array<[string, string]> = [];
    let locked = false;
    const ok = submitBracketedPasteToPty(
      'pty-1',
      'hello',
      (ptyId, data) => { writes.push([ptyId, data]); },
      { submitGuard: () => !locked },
    );
    expect(ok).toBe(true);
    expect(writes).toHaveLength(1);
    locked = true;
    vi.advanceTimersByTime(500);
    expect(writes).toHaveLength(1);
    vi.useRealTimers();
  });

  it('reports true and stays unguarded for callers that pass no gate', () => {
    vi.useFakeTimers();
    const writes: Array<[string, string]> = [];
    expect(submitBracketedPasteToPty('pty-1', 'x', (i, d) => { writes.push([i, d]); })).toBe(true);
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(2);
    vi.useRealTimers();
  });
});
