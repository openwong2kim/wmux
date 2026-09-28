import { describe, it, expect } from 'vitest';
import { DECISION_TEXT_MAX_UNITS, parseDecisionAnswerBody } from '../decisionAnswer';

const FP = 'ab'.repeat(16);
const ID = 'phone-answer-0001';
const ok = { formFingerprint: FP, clientAnswerId: ID, action: 'approve' };

describe('parseDecisionAnswerBody', () => {
  it('accepts an action, answers and text', () => {
    expect(parseDecisionAnswerBody(ok)).toEqual({ ok: true, answer: ok });
    const full = {
      formFingerprint: FP, clientAnswerId: ID, action: 'feedback',
      answers: [{ questionId: 'q0', keys: ['1', '3'] }, { questionId: 'q1', keys: [], other: '다른 답 🙂' }],
      text: 'Use the staging database instead.',
    };
    expect(parseDecisionAnswerBody(full)).toEqual({ ok: true, answer: full });
    expect(parseDecisionAnswerBody({ ...ok, text: 'x'.repeat(DECISION_TEXT_MAX_UNITS) }).ok).toBe(true);
  });

  it.each([
    ['not an object', [ok], 'invalid-body'],
    ['null', null, 'invalid-body'],
    ['an unknown field', { ...ok, decision: 'approve' }, 'invalid-body'],
    ['an unknown answer field', { ...ok, answers: [{ questionId: 'q0', keys: ['1'], label: 'A' }] }, 'invalid-body'],
    ['no fingerprint', { clientAnswerId: ID, action: 'approve' }, 'invalid-prompt-fingerprint'],
    ['an uppercase fingerprint', { ...ok, formFingerprint: FP.toUpperCase() }, 'invalid-prompt-fingerprint'],
    ['a short fingerprint', { ...ok, formFingerprint: 'ab' }, 'invalid-prompt-fingerprint'],
    ['a short answer id', { ...ok, clientAnswerId: 'short' }, 'invalid-body'],
    ['an answer id with a slash', { ...ok, clientAnswerId: 'phone/answer/0001' }, 'invalid-body'],
    ['neither action nor answers', { formFingerprint: FP, clientAnswerId: ID }, 'invalid-body'],
    ['a malformed question id', { ...ok, answers: [{ questionId: 'x', keys: ['1'] }] }, 'invalid-body'],
    ['a repeated question', { ...ok, answers: [{ questionId: 'q0', keys: ['1'] }, { questionId: 'q0', keys: ['2'] }] }, 'invalid-body'],
    ['a repeated key', { ...ok, answers: [{ questionId: 'q0', keys: ['1', '1'] }] }, 'invalid-body'],
    ['an empty answer', { ...ok, answers: [{ questionId: 'q0', keys: [] }] }, 'invalid-body'],
    ['a newline in the text', { ...ok, text: 'first\nsecond' }, 'invalid-text'],
    ['a CR in the text', { ...ok, text: 'first\rsecond' }, 'invalid-text'],
    ['a tab in the text', { ...ok, text: 'a\tb' }, 'invalid-text'],
    ['an Esc in the text', { ...ok, text: 'nope\u001b' }, 'invalid-text'],
    ['a DEL in the text', { ...ok, text: 'nope\u007f' }, 'invalid-text'],
    ['a NUL in the text', { ...ok, text: 'nope\u0000' }, 'invalid-text'],
    ['a C1 CSI in the text', { ...ok, text: 'nope\u009b31m' }, 'invalid-text'],
    ['a C1 NEL in the text', { ...ok, text: 'a\u0085b' }, 'invalid-text'],
    ['a line separator in the text', { ...ok, text: 'a\u2028b' }, 'invalid-text'],
    ['a paragraph separator in the text', { ...ok, text: 'a\u2029b' }, 'invalid-text'],
    ['whitespace-only text', { ...ok, text: '   ' }, 'invalid-text'],
    ['text over the limit', { ...ok, text: 'x'.repeat(DECISION_TEXT_MAX_UNITS + 1) }, 'invalid-text'],
    ['a non-string text', { ...ok, text: 5 }, 'invalid-text'],
    ['a newline in an Other answer', { ...ok, answers: [{ questionId: 'q0', keys: [], other: 'a\nb' }] }, 'invalid-text'],
  ])('400 for %s', (_label, body, error) => {
    expect(parseDecisionAnswerBody(body)).toEqual({ ok: false, error });
  });
});
