import { describe, expect, it } from 'vitest';
import { parseApprovalResolveRequest } from '../resolveRequest';

const APPROVE = { id: 'req-1', decision: 'approve' };

describe('parseApprovalResolveRequest — who is answering', () => {
  // The whole point: `resolver: 'human'` bypasses decideApprovalPress, so a
  // caller that could set it could turn the press scope off for itself.
  it('ignores a non-first-party client claiming to be human', () => {
    const parsed = parseApprovalResolveRequest(
      { ...APPROVE, resolver: 'human' },
      { isFirstParty: false },
    );
    expect(parsed).toMatchObject({ resolver: 'automated' });
  });

  it('defaults to automated — an unidentified client is scoped, not trusted', () => {
    expect(parseApprovalResolveRequest({ ...APPROVE }, { isFirstParty: false })).toMatchObject({
      resolver: 'automated',
    });
  });

  it('calls the first-party client human, and ignores its claim too', () => {
    expect(parseApprovalResolveRequest({ ...APPROVE }, { isFirstParty: true })).toMatchObject({
      resolver: 'human',
    });
    expect(
      parseApprovalResolveRequest({ ...APPROVE, resolver: 'automated' }, { isFirstParty: true }),
    ).toMatchObject({ resolver: 'human' });
  });
});

describe('parseApprovalResolveRequest — shape', () => {
  it('refuses a missing id or a decision that is not exactly approve/deny', () => {
    for (const bad of [
      { decision: 'approve' },
      { id: 'req-1' },
      { id: 'req-1', decision: 'yes' },
      { id: 'req-1', decision: true },
    ]) {
      expect(parseApprovalResolveRequest(bad, { isFirstParty: true })).toEqual({
        ok: false,
        reason: 'not-found',
      });
    }
  });

  it('never lets a deny carry an affirmative choice digit, or a malformed one press option 1', () => {
    for (const bad of [
      { id: 'req-1', decision: 'deny', choiceKey: '1' },
      { id: 'req-1', decision: 'approve', choiceKey: '' },
      { id: 'req-1', decision: 'approve', choiceKey: 'x' },
      { id: 'req-1', decision: 'approve', choiceKey: 1 },
    ]) {
      expect(parseApprovalResolveRequest(bad, { isFirstParty: true })).toEqual({
        ok: false,
        reason: 'invalid-choice-key',
      });
    }
    expect(
      parseApprovalResolveRequest({ ...APPROVE, choiceKey: '2' }, { isFirstParty: true }),
    ).toMatchObject({ choiceKey: '2' });
    // Absent stays absent — the registry's default mapping, not an empty string.
    expect(parseApprovalResolveRequest(APPROVE, { isFirstParty: true })).not.toHaveProperty('choiceKey');
  });

  it('coerces a non-string resolvedBy to empty rather than passing it through', () => {
    expect(parseApprovalResolveRequest({ ...APPROVE, resolvedBy: 42 }, { isFirstParty: true })).toMatchObject({
      resolvedBy: '',
    });
  });
});
