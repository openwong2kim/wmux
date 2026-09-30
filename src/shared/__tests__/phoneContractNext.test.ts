import { describe, it, expect } from 'vitest';
import {
  classifyClaudeStopFailure, classifyCodexTurnCompleted, clipProviderMessage, withoutMessage,
  TURN_FAILURE_MESSAGE_MAX_UNITS, turnFailureKey,
} from '../phoneTurnFailure';
import { projectCodexAuth, projectCodexRateLimits } from '../phoneCodexAccountStatus';
import { parsePaneAccountFields } from '../phonePaneAccount';
import { parseWorktreeCreateBody, phoneWorktreeAddArgs, phoneWorktreeNames, summarizeChecks } from '../phoneGitV1';
import { effectiveCancelProgress } from '../phoneChatCancelOutcome';

describe('classifyClaudeStopFailure', () => {
  it.each([
    ['rate_limit', 'rate-limited'],
    ['billing_error', 'quota'],
    ['authentication_failed', 'auth'],
    ['oauth_org_not_allowed', 'auth'],
    ['cloud_credential_error', 'auth'],
    ['account_on_hold', 'auth'],
    ['verification_required', 'auth'],
    ['overloaded', 'unknown'],
    ['server_error', 'unknown'],
    ['max_output_tokens', 'unknown'],
    ['unknown', 'unknown'],
    ['some_future_code', 'unknown'],
  ])('maps %s to %s and keeps the code verbatim', (code, reason) => {
    const f = classifyClaudeStopFailure({ hook_event_name: 'StopFailure', error: code }, 5);
    expect(f).toEqual({ reason, provider: 'claude', providerCode: code, at: 5 });
  });

  it('takes the message from last_assistant_message, never error_details', () => {
    const f = classifyClaudeStopFailure({ error: 'rate_limit', error_details: 'raw 429 body', last_assistant_message: "You've hit your limit\n· resets 3pm" }, 1);
    expect(f.message).toBe("You've hit your limit · resets 3pm");
    expect(JSON.stringify(f)).not.toContain('raw 429');
    // Known facts only: the reset time stays prose, never a field.
    expect(f.resetAt).toBeUndefined();
    expect(withoutMessage(f).message).toBeUndefined();
  });

  it('drops a code that is not an identifier', () => {
    expect(classifyClaudeStopFailure({ error: 'rate limit; rm -rf' }, 1)).toEqual({ reason: 'unknown', provider: 'claude', at: 1 });
    expect(classifyClaudeStopFailure({}, 1)).toEqual({ reason: 'unknown', provider: 'claude', at: 1 });
  });
});

describe('classifyCodexTurnCompleted', () => {
  const failed = (codexErrorInfo: unknown, message = 'boom') => ({ id: 'turn-1', status: 'failed', error: { message, codexErrorInfo, additionalDetails: 'secret' } });

  it('is undefined unless the turn failed', () => {
    expect(classifyCodexTurnCompleted({ status: 'completed' }, 1)).toBeUndefined();
    expect(classifyCodexTurnCompleted({ status: 'interrupted' }, 1)).toBeUndefined();
    expect(classifyCodexTurnCompleted(null, 1)).toBeUndefined();
  });

  it.each([
    ['usageLimitExceeded', 'quota'],
    ['sessionBudgetExceeded', 'unknown'],
    ['rateLimitExceeded', 'rate-limited'],
    ['unauthorized', 'auth'],
    ['serverOverloaded', 'unknown'],
    ['contextWindowExceeded', 'unknown'],
    ['other', 'unknown'],
  ])('maps %s to %s', (code, reason) => {
    expect(classifyCodexTurnCompleted(failed(code), 2)).toEqual({ reason, provider: 'codex', providerCode: code, message: 'boom', at: 2 });
  });

  it('reads transport variants and their HTTP status', () => {
    expect(classifyCodexTurnCompleted(failed({ httpConnectionFailed: { httpStatusCode: null } }), 1))
      .toMatchObject({ reason: 'network', providerCode: 'httpConnectionFailed' });
    expect(classifyCodexTurnCompleted(failed({ responseStreamDisconnected: { httpStatusCode: 429 } }), 1))
      .toMatchObject({ reason: 'rate-limited', httpStatus: 429 });
    expect(classifyCodexTurnCompleted(failed({ responseTooManyFailedAttempts: { httpStatusCode: 401 } }), 1))
      .toMatchObject({ reason: 'auth', httpStatus: 401 });
    expect(classifyCodexTurnCompleted(failed({ responseTooManyFailedAttempts: { httpStatusCode: 500 } }), 1))
      .toMatchObject({ reason: 'unknown', httpStatus: 500 });
  });

  it('never ships additionalDetails, and a null info is unknown with no code', () => {
    const f = classifyCodexTurnCompleted(failed(null), 1);
    expect(f).toEqual({ reason: 'unknown', provider: 'codex', message: 'boom', at: 1 });
    expect(JSON.stringify(f)).not.toContain('secret');
  });
});

describe('clipProviderMessage', () => {
  it('clips to the unit budget without splitting a surrogate pair', () => {
    const clipped = clipProviderMessage('a'.repeat(TURN_FAILURE_MESSAGE_MAX_UNITS - 2) + '😀😀😀') ?? '';
    expect(clipped.length).toBeLessThanOrEqual(TURN_FAILURE_MESSAGE_MAX_UNITS);
    expect(clipped.endsWith('…')).toBe(true);
    expect(/[\ud800-\udbff]…$/.test(clipped)).toBe(false);
    expect(clipProviderMessage('  \u0007 ')).toBeUndefined();
    expect(clipProviderMessage(42)).toBeUndefined();
  });
});

describe('Codex account status projections', () => {
  it('never reads the auth token', () => {
    expect(projectCodexAuth({ authMethod: 'chatgpt', authToken: 'tok', requiresOpenaiAuth: true })).toEqual({ state: 'signed-in', method: 'chatgpt' });
    expect(projectCodexAuth({ authMethod: 'apikey', authToken: 'sk-x' })).toEqual({ state: 'signed-in', method: 'apikey' });
    expect(projectCodexAuth({ authMethod: 'bedrockApiKey' })).toEqual({ state: 'signed-in', method: 'other' });
    expect(projectCodexAuth({ authMethod: null })).toEqual({ state: 'signed-out' });
    expect(projectCodexAuth('nope')).toEqual({ state: 'unknown' });
  });

  it('projects buckets allowlist-only and converts reset seconds to ms', () => {
    const out = projectCodexRateLimits({
      ordinaryUsageAllowed: false,
      accountId: 'acct-secret',
      rateLimitUpsell: { banner: 'buy' },
      rateLimits: { limitId: 'codex', limitName: 'Codex', planType: 'pro', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_760_000_000 },
        secondary: null, credits: { hasCredits: true, unlimited: false, balance: '12.00' }, rateLimitReachedType: 'rate_limit_reached' },
      rateLimitsByLimitId: null,
    });
    expect(out).toEqual({
      ordinaryUsageAllowed: false,
      planType: 'pro',
      buckets: [{ limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 100, windowMinutes: 300, resetsAt: 1_760_000_000_000 },
        secondary: null, reachedType: 'rate_limit_reached' }],
    });
    expect(JSON.stringify(out)).not.toMatch(/acct-secret|buy|12\.00/);
    expect(projectCodexRateLimits(undefined)).toBeNull();
  });
});

describe('parsePaneAccountFields', () => {
  it('accepts absent, well-formed and refuses malformed fields', () => {
    expect(parsePaneAccountFields({})).toEqual({ ok: true, value: {} });
    expect(parsePaneAccountFields({ workspaceId: 'ws-1', accountId: '3f1c2e4a-0b6d-4c1e-9a7f-2d8e5b6c7a90', handoffFrom: { sessionId: 'web-1', agentSessionId: 'ses_1' } }))
      .toEqual({ ok: true, value: { accountId: '3f1c2e4a-0b6d-4c1e-9a7f-2d8e5b6c7a90', handoffFrom: { sessionId: 'web-1', agentSessionId: 'ses_1' } } });
    for (const accountId of ['', '/Users/me/.codex', '__proto__', 42, null]) {
      expect(parsePaneAccountFields({ workspaceId: 'ws-1', accountId })).toEqual({ ok: false, error: 'invalid-account-id' });
    }
    expect(parsePaneAccountFields({ accountId: 'acct-1' })).toEqual({ ok: false, error: 'workspace-required' });
    expect(parsePaneAccountFields({ workspaceId: ' ', accountId: 'acct-1' })).toEqual({ ok: false, error: 'workspace-required' });
    for (const handoffFrom of [null, [], {}, { sessionId: 'a/b' }, { sessionId: 'p', path: '/tmp' }, { sessionId: 'p', agentSessionId: '' }]) {
      expect(parsePaneAccountFields({ handoffFrom })).toEqual({ ok: false, error: 'invalid-handoff' });
    }
  });
});

describe('phone git v1', () => {
  const rid = '3f1c2e4a-0b6d-4c1e-9a7f-2d8e5b6c7a90';

  it('accepts only a strict slug and a UUID request id', () => {
    expect(parseWorktreeCreateBody({ slug: 'fix-login', requestId: rid })).toEqual({ ok: true, value: { slug: 'fix-login', requestId: rid } });
    for (const slug of ['', '-a', 'a-', 'a--b', 'A', 'a/b', 'a_b', '..', 'x'.repeat(41), 'refs/heads/main']) {
      expect(parseWorktreeCreateBody({ slug, requestId: rid })).toEqual({ ok: false, error: 'invalid-slug' });
    }
    expect(parseWorktreeCreateBody({ slug: 'a', requestId: 'nope' })).toEqual({ ok: false, error: 'invalid-git-request' });
    expect(parseWorktreeCreateBody({ slug: 'a', requestId: rid, cwd: '/tmp' })).toEqual({ ok: false, error: 'invalid-git-request' });
    expect(phoneWorktreeNames('fix-login', 'abcdef012345')).toEqual({ branch: 'phone/fix-login', relativeDir: 'worktrees/abcdef012345/phone-fix-login' });
  });

  it('projects the gh statusCheckRollup shape and summarizes it', () => {
    const summary = summarizeChecks([
      { __typename: 'CheckRun', name: 'validate', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI',
        detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2', startedAt: '2026-09-29T22:35:20Z', completedAt: '2026-09-29T22:51:11Z' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '', detailsUrl: 'https://evil.example/x',
        startedAt: '2026-09-29T22:35:20Z', completedAt: '0001-01-01T00:00:00Z' },
      { __typename: 'StatusContext', context: 'CodeRabbit', state: 'FAILURE', targetUrl: '' },
      { __typename: 'Other' },
    ]);
    expect(summary.overall).toBe('failure');
    expect(summary.counts).toEqual({ total: 3, passed: 1, failed: 1, pending: 1, skipped: 0 });
    expect(summary.checks[0]).toEqual({ kind: 'check-run', name: 'validate', state: 'success', workflow: 'CI',
      url: 'https://github.com/o/r/actions/runs/1/job/2', startedAt: Date.parse('2026-09-29T22:35:20Z'), completedAt: Date.parse('2026-09-29T22:51:11Z') });
    expect(summary.checks[1]).toEqual({ kind: 'check-run', name: 'e2e', state: 'in_progress', startedAt: Date.parse('2026-09-29T22:35:20Z') });
    expect(summary.checks[2]).toEqual({ kind: 'status', name: 'CodeRabbit', state: 'failure' });
    expect(summarizeChecks(null)).toEqual({ overall: 'none', counts: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 }, checks: [], truncated: false });
  });
});

describe('contract v-next review follow-ups', () => {
  it('builds the worktree argv from a pinned oid only', () => {
    const oid = 'a'.repeat(40);
    expect(phoneWorktreeAddArgs('phone/x', '/h/worktrees/p/phone-x', oid)).toEqual(['worktree', 'add', '-b', 'phone/x', '--', '/h/worktrees/p/phone-x', oid]);
    expect(() => phoneWorktreeAddArgs('phone/x', '/d', 'HEAD')).toThrow();
  });

  it('derives cancel progress without touching the stored effect', () => {
    expect(effectiveCancelProgress({ outcome: { effect: 'interrupt-requested' }, createdAt: 1 }, false, 9)).toEqual({ state: 'requested', at: 1 });
    expect(effectiveCancelProgress({ outcome: { effect: 'interrupt-requested' }, createdAt: 1 }, true, 9)).toEqual({ state: 'unknown', reason: 'daemon-restart', at: 9 });
    expect(effectiveCancelProgress({ outcome: { effect: 'uncertain' }, createdAt: 1 }, true, 9)).toEqual({ state: 'unknown', reason: 'write-uncertain', at: 1 });
    const notEnded = { state: 'not-ended' as const, at: 5 };
    expect(effectiveCancelProgress({ outcome: { effect: 'interrupt-requested' }, progress: notEnded, createdAt: 1 }, true, 9)).toBe(notEnded);
  });

  it('keys a failure by turn id, else by time', () => {
    expect(turnFailureKey('p', { turnId: 't1:a', at: 1 })).not.toBe(turnFailureKey('p', { at: 1 }));
    expect(turnFailureKey('p', { at: 1 })).toBe(turnFailureKey('p', { at: 1 }));
  });
});
