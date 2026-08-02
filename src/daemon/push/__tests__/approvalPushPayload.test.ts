import { describe, it, expect } from 'vitest';

import {
  APPROVAL_PUSH_FALLBACK_BODY,
  approvalPushCollapseId,
  buildApprovalPushPayload,
} from '../approvalPushPayload';
import { PUSH_RISK_NORMAL } from '../../../shared/push/pushEnvelope';
import type { ApprovalRequest } from '../../approvals/types';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap-1',
    sessionId: 'sess-1',
    agent: 'claude',
    kind: 'awaiting_input',
    createdAt: 1753420800000,
    state: 'pending',
    ...overrides,
  };
}

describe('buildApprovalPushPayload', () => {
  it('states risk even when nothing matched', () => {
    // The whole point: the extension withholds the lock-screen affirmative on
    // an absent risk, so an ordinary approval has to SAY it is ordinary.
    expect(buildApprovalPushPayload(request()).risk).toBe(PUSH_RISK_NORMAL);
  });

  it('carries a critical risk verbatim', () => {
    expect(buildApprovalPushPayload(request({ risk: 'critical' })).risk).toBe('critical');
  });

  it('★ the softer tier is critical HERE, even though the record says nothing', () => {
    // `ApprovalRequest.risk` is only ever set by `hasCriticalRisk`, which
    // ignores the `review` tier — so the record for a `DELETE FROM` carries no
    // risk at all. Copying that through would stamp `normal`, and `normal` is
    // not a description: the extension reads it as "one tap on a locked screen
    // is enough". A second look is exactly what a lock screen cannot give.
    for (const question of ['DELETE FROM users WHERE 1=1?', 'run kubectl delete pod api-7?']) {
      const payload = buildApprovalPushPayload(request({ question }));
      expect(payload.risk, question).toBe('critical');
    }
  });

  it('★ scans option and choice labels, not only the question', () => {
    // The question can be blandly worded while the thing being agreed to sits
    // in a label.
    expect(
      buildApprovalPushPayload(request({ question: 'Proceed?', options: ['rm -rf ./build'] })).risk,
    ).toBe('critical');
    expect(
      buildApprovalPushPayload(
        request({ question: 'Proceed?', choices: [{ key: '1', label: 'terraform destroy' }] }),
      ).risk,
    ).toBe('critical');
  });

  it('an ordinary question is still ordinary — the gate must not swallow everything', () => {
    // A rule that answered `critical` to everything would be the same bug in
    // the other direction: the button would never appear and the whole change
    // would be pointless.
    expect(buildApprovalPushPayload(request({ question: 'Write the file to src/a.ts?' })).risk)
      .toBe(PUSH_RISK_NORMAL);
  });

  it('quotes the question, and falls back when there is none', () => {
    expect(buildApprovalPushPayload(request({ question: 'Deploy to prod?' })).body).toBe(
      'Deploy to prod?',
    );
    expect(buildApprovalPushPayload(request()).body).toBe(APPROVAL_PUSH_FALLBACK_BODY);
  });

  it('prints the options when a button will act on one — the button says only "first option"', () => {
    const payload = buildApprovalPushPayload(
      request({
        question: 'Deploy to prod?',
        choices: [
          { key: '1', label: 'Yes, deploy' },
          { key: '2', label: 'No' },
        ],
      }),
    );
    expect(payload.body).toBe('Deploy to prod?\nYes, deploy · No');
  });

  it('keeps the body bare when no affirmative is offered', () => {
    // Three options means the person opens the app and reads the card there;
    // pasting them onto a lock screen would be noise, not consent.
    const payload = buildApprovalPushPayload(
      request({
        question: 'Which one?',
        choices: [
          { key: '1', label: 'A' },
          { key: '2', label: 'B' },
          { key: '3', label: 'C' },
        ],
      }),
    );
    expect(payload.body).toBe('Which one?');
  });

  it('★ a two-option question earns the affirmative, titled with the agent’s own label', () => {
    // The regression this exists to prevent: the rule used to be "has choices
    // at all", and since the only source of approvals is the AskUserQuestion
    // hook — which always carries choices — the lock-screen button was dark
    // for every approval that has ever existed.
    const payload = buildApprovalPushPayload(
      request({
        choices: [
          { key: '1', label: '승인' },
          { key: '2', label: '거부' },
        ],
      }),
    );
    expect(payload.requiresInAppChoice).toBeUndefined();
    expect(payload.firstOption).toBe('승인');
  });

  it('three or more options is a picker, and no single button can stand for it', () => {
    const payload = buildApprovalPushPayload(
      request({
        choices: [
          { key: '1', label: 'Yes' },
          { key: '2', label: 'Yes, and don’t ask again' },
          { key: '3', label: 'No' },
        ],
      }),
    );
    expect(payload.requiresInAppChoice).toBe(true);
    expect(payload.firstOption).toBeUndefined();
  });

  it('an unlabelled option cannot title a button, so it falls back rather than borrowing a word', () => {
    const payload = buildApprovalPushPayload(
      request({
        choices: [
          { key: '1', label: '   ' },
          { key: '2', label: 'No' },
        ],
      }),
    );
    expect(payload.requiresInAppChoice).toBe(true);
    expect(payload.firstOption).toBeUndefined();
  });

  it('no structured choices at all keeps the pre-existing shape', () => {
    const payload = buildApprovalPushPayload(request());
    expect(payload.requiresInAppChoice).toBeUndefined();
    expect(payload.firstOption).toBeUndefined();
  });

  it('a destructive label still loses the button, relaxed choice rule or not', () => {
    // Two labels, both readable — the choice rule alone would hand out the
    // affirmative. `risk` is the independent gate that must still refuse.
    const payload = buildApprovalPushPayload(
      request({
        question: 'Run this?',
        choices: [
          { key: '1', label: 'Yes, run rm -rf /' },
          { key: '2', label: 'No' },
        ],
      }),
    );
    expect(payload.risk).toBe('critical');
  });

  it('carries the ids the deep link is built from', () => {
    const payload = buildApprovalPushPayload(request());
    expect(payload.approvalId).toBe('ap-1');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.title).toBe('Approval needed');
  });
});

describe('approvalPushCollapseId', () => {
  it('collapses per pane', () => {
    expect(approvalPushCollapseId(request())).toBe('ap-sess-1');
    expect(approvalPushCollapseId(request({ id: 'ap-2' }))).toBe('ap-sess-1');
  });

  it('stays inside the APNs collapse-id limit', () => {
    const id = approvalPushCollapseId(request({ sessionId: 's'.repeat(200) }));
    expect(id.length).toBe(64);
  });
});
