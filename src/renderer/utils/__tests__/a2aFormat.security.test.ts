import { describe, expect, it } from 'vitest';
import { formatA2aMessage } from '../a2aFormat';
import { formatMessage } from '../../company/messageTemplates';

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

  it('neutralizes CR/LF and ESC in company message bodies before PTY delivery', () => {
    const formatted = formatMessage('CEO\nspoof', 'agent\tname', ATTACK, 'high');

    expect(formatted).not.toContain('hello\nprintf VULNERABLE');
    expect(formatted).not.toContain('\r');
    expect(formatted).not.toContain('\x1b');
    expect(formatted).toContain('hello␤printf VULNERABLE␤printf ESCAPED');
    expect(formatted).toContain('From: CEO spoof');
    expect(formatted).toContain('To: agent name');
  });
});
