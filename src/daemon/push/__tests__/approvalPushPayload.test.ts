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

  it('quotes the question, and falls back when there is none', () => {
    expect(buildApprovalPushPayload(request({ question: 'Deploy to prod?' })).body).toBe(
      'Deploy to prod?',
    );
    expect(buildApprovalPushPayload(request()).body).toBe(APPROVAL_PUSH_FALLBACK_BODY);
  });

  it('flags structured choices, and omits the flag otherwise', () => {
    const withChoices = buildApprovalPushPayload(
      request({ choices: [{ key: '1', label: 'Yes' }] }),
    );
    expect(withChoices.requiresInAppChoice).toBe(true);
    expect(buildApprovalPushPayload(request()).requiresInAppChoice).toBeUndefined();
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
