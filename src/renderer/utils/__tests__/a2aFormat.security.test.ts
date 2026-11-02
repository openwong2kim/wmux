import { describe, expect, it } from 'vitest';
import { formatA2aMessage, sanitizeA2aName } from '../a2aFormat';

const ATTACK = 'hello\nprintf VULNERABLE\r\n\x1b[201~printf ESCAPED';

describe('inter-agent PTY message formatting', () => {
  it('neutralizes CR/LF and ESC in A2A message bodies before PTY delivery', () => {
    const formatted = formatA2aMessage('sender\nspoof', 'target\tname', ATTACK);

    expect(formatted).not.toContain('hello\nprintf VULNERABLE');
    expect(formatted).not.toContain('\r');
    expect(formatted).not.toContain('\x1b');
    expect(formatted).toContain('hello␤printf VULNERABLE␤printf ESCAPED');
    expect(formatted).toContain('From: sender spoof');
    expect(formatted).toContain('To: target name');
  });

  // The live-TUI silent-default nudge (buildA2aNudge) interpolates a
  // user-editable workspace name into a SINGLE line that is submitted to the
  // receiver's prompt. sanitizeA2aName is the shared guard that keeps that line
  // single: a CR/LF in the sender name must collapse to a space, never split
  // the nudge into an injected multi-line bracketed paste.
  it('collapses CR/LF/TAB and strips ESC from a sender name (single-line nudge invariant)', () => {
    const dirty = 'evil\rprintf\nPWNED\tname\x1b[201~';
    const clean = sanitizeA2aName(dirty);
    expect(clean).not.toContain('\n');
    expect(clean).not.toContain('\r');
    expect(clean).not.toContain('\t');
    expect(clean).not.toContain('\x1b');
    expect(clean).toBe('evil printf PWNED name');
  });

  it('caps a sender name at 100 chars (nudge stays short)', () => {
    expect(sanitizeA2aName('x'.repeat(500))).toHaveLength(100);
  });
});
