import { describe, expect, it } from 'vitest';
import {
  A2A_REMOTE_APPROVAL_COMMAND_MAX,
  capUtf8,
  parseA2aRemoteApproval,
  parseA2aRemoteStatus,
  shownRemoteStatus,
} from '../a2aRemote';

const OFFER = { promptId: '0123456789abcdef', tool: 'Bash', command: 'ls -la', redacted: false, cut: false, allowed: ['allow', 'deny'] };

describe('parseA2aRemoteApproval', () => {
  it('takes a prompt id and allow or deny, nothing else', () => {
    expect(parseA2aRemoteApproval({ promptId: '0123456789abcdef', decision: 'deny' })).toEqual({ promptId: '0123456789abcdef', decision: 'deny' });
    for (const raw of [
      { promptId: '0123456789ABCDEF', decision: 'allow' },
      { promptId: '0123456789abcde', decision: 'allow' },
      { promptId: '0123456789abcdef', decision: 'always' },
      { promptId: '0123456789abcdef', decision: 'allow', choiceKey: '2' },
      { promptId: '0123456789abcdef' },
      [],
      null,
    ]) {
      expect(parseA2aRemoteApproval(raw)).toBeNull();
    }
  });
});

describe('a status carrying a prompt offer', () => {
  const status = (detail: Record<string, unknown>) => parseA2aRemoteStatus({ kind: 'question', since: '2026-11-19T00:00:00.000Z', detail });

  it('keeps the offer only on a permission or plan question, in its checked shape', () => {
    expect(status({ question: 'permission', approval: OFFER })?.detail?.approval).toEqual(OFFER);
    expect(status({ question: 'menu', approval: OFFER })?.detail?.approval).toBeUndefined();
    expect(status({ question: 'permission', approval: { ...OFFER, tool: 'Bash; rm' } })?.detail?.approval).toBeUndefined();
    expect(status({ question: 'permission', approval: { ...OFFER, promptId: 'x' } })?.detail?.approval).toBeUndefined();
  });

  it('allow is never read for a command cut, redacted, or not shown', () => {
    expect(status({ question: 'permission', approval: { ...OFFER, cut: true } })?.detail?.approval?.allowed).toEqual(['deny']);
    expect(status({ question: 'permission', approval: { ...OFFER, redacted: true } })?.detail?.approval?.allowed).toEqual(['deny']);
    const { command: _command, ...toolOnly } = OFFER;
    expect(status({ question: 'permission', approval: toolOnly })?.detail?.approval?.allowed).toEqual(['deny']);
    const long = status({ question: 'permission', approval: { ...OFFER, command: 'x'.repeat(A2A_REMOTE_APPROVAL_COMMAND_MAX + 1) } })!.detail!.approval!;
    expect(long).toMatchObject({ cut: true, allowed: ['deny'] });
    expect(long.command).toHaveLength(A2A_REMOTE_APPROVAL_COMMAND_MAX);
  });

  it('the command is shown only as untrusted text; outcomes get this PC\'s own words', () => {
    const parsed = status({
      question: 'permission',
      approval: { ...OFFER, command: 'echo ‮hi\u0007' },
      approvals: [{ messageId: 'ap-1', outcome: 'not-done', reason: 'deny-only' }, { messageId: 'ap-2', outcome: 'not-done', reason: 'PEER TEXT' }],
    })!;
    expect(parsed.detail?.approval?.command).toBe('echo hi');
    expect(parsed.detail?.approvals).toEqual([{ messageId: 'ap-1', outcome: 'not-done', reason: 'deny-only' }]);
    const shown = shownRemoteStatus(parsed);
    expect(shown.detail?.approval).not.toHaveProperty('command');
    expect(shown.untrusted?.command).toBe('echo hi');
    expect(shown.detail?.approvals?.[0]?.reasonText).toMatch(/only deny/);
  });
});

describe('capUtf8', () => {
  it('cuts on a character boundary', () => {
    expect(capUtf8('abc', 3)).toEqual({ text: 'abc', cut: false });
    expect(capUtf8('a한', 3)).toEqual({ text: 'a', cut: true });
  });
});
