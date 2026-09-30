import { describe, it, expect } from 'vitest';
import {
  classifyClaudeStopFailure, classifyCodexTurnCompleted, clipProviderMessage, withoutMessage,
  TURN_FAILURE_MESSAGE_MAX_UNITS, turnFailureKey,
} from '../phoneTurnFailure';
import { projectCodexAuth, projectCodexRateLimits } from '../phoneCodexAccountStatus';
import { parsePaneAccountFields } from '../phonePaneAccount';
import { githubUrl, parseWorktreeCreateBody, phoneWorktreeAddArgs, phoneWorktreeNames, summarizeChecks } from '../phoneGitV1';
import { effectiveCancelProgress, normalizeCancelProgress } from '../phoneChatCancelOutcome';
import { sanitizeDisplayText } from '../phoneText';

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

  it('projects the shape a real ChatGPT account answers with (codex-cli 0.159.2: one weekly window, no secondary)', () => {
    // Every key of GetAccountRateLimitsResponse / RateLimitSnapshot, values
    // invented; the single-bucket and multi-bucket views describe one bucket.
    const snapshot = {
      limitId: 'codex', limitName: null, normalModelSlug: null,
      primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1_790_000_000 }, secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: '0' }, individualLimit: null, spendControlReached: null,
      planType: 'plus', rateLimitReachedType: null,
    };
    const out = projectCodexRateLimits({
      ordinaryUsageAllowed: true, rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot },
      rateLimitResetCredits: null, accountId: 'acct-0000', rateLimitUpsell: null,
    });
    expect(out).toEqual({
      ordinaryUsageAllowed: true, planType: 'plus',
      buckets: [{ limitId: 'codex', limitName: null, primary: { usedPercent: 7, windowMinutes: 10080, resetsAt: 1_790_000_000_000 },
        secondary: null, reachedType: null }],
    });
    expect(JSON.stringify(out)).not.toMatch(/acct-0000|balance|credits/);
    expect(projectCodexAuth({ authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true })).toEqual({ state: 'signed-in', method: 'chatgpt' });
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
    expect(effectiveCancelProgress({ outcome: { effect: 'interrupt-requested' }, progress: notEnded, createdAt: 1 }, true, 9)).toEqual(notEnded);
  });

  it('keys a failure by turn id, else by time', () => {
    expect(turnFailureKey('p', { turnId: 't1:a', at: 1 })).not.toBe(turnFailureKey('p', { at: 1 }));
    expect(turnFailureKey('p', { at: 1 })).toBe(turnFailureKey('p', { at: 1 }));
  });
});

describe('PR review round 1', () => {
  const protoNames = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

  it('never resolves a provider code to an Object.prototype member', () => {
    for (const error of protoNames.filter((n) => /^[A-Za-z]/.test(n))) {
      expect(classifyClaudeStopFailure({ error }, 1).reason).toBe('unknown');
      expect(classifyCodexTurnCompleted({ status: 'failed', error: { codexErrorInfo: error } }, 1)?.reason).toBe('unknown');
    }
    const s = summarizeChecks([
      { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'constructor' },
      { __typename: 'StatusContext', context: 'b', state: 'toString' },
    ]);
    expect(s.checks.map((c) => c.state)).toEqual(['unknown', 'unknown']);
  });

  it('refuses every Object.prototype name as an id, session ids included', () => {
    for (const n of protoNames) {
      expect(parsePaneAccountFields({ workspaceId: 'ws', accountId: n }).ok).toBe(false);
      expect(parsePaneAccountFields({ handoffFrom: { sessionId: n } }).ok).toBe(false);
      expect(parsePaneAccountFields({ handoffFrom: { sessionId: 'p', agentSessionId: n } }).ok).toBe(false);
    }
  });

  it('sanitizes invisible and direction-changing text and clips on a pair boundary', () => {
    expect(sanitizeDisplayText('pay\u202Eevil\u200B\uFEFF ok\u0007', 100)).toBe('pay evil ok');
    expect(sanitizeDisplayText('a\ud800b\udc00c', 100)).toBe('abc');
    expect(sanitizeDisplayText('ab😀', 3)).toBe('ab…');
    expect(sanitizeDisplayText('😀😀', 2)).toBeUndefined();
    expect(clipProviderMessage('\u2066\u2069')).toBeUndefined();
    expect(projectCodexRateLimits({ rateLimits: { limitName: '  \u202E ', primary: null } })?.buckets[0].limitName).toBeNull();
  });

  it('accepts only real github.com URLs', () => {
    expect(githubUrl('https://github.com/o/r/actions/runs/1')).toBe('https://github.com/o/r/actions/runs/1');
    for (const u of ['https://github.com.evil.io/x', 'https://evil.io/https://github.com/', 'https://u:p@github.com/x',
      'http://github.com/x', 'https://github.com/x y', 'https://github.com/\nx', 'javascript:alert(1)']) {
      expect(githubUrl(u)).toBeUndefined();
    }
  });

  it('guards a non-object Claude payload and finds a known Codex variant among several keys', () => {
    expect(classifyClaudeStopFailure(null as unknown as Record<string, unknown>, 1)).toEqual({ reason: 'unknown', provider: 'claude', at: 1 });
    expect(classifyCodexTurnCompleted({ status: 'failed', error: { codexErrorInfo: { futureHint: {}, httpConnectionFailed: { httpStatusCode: 429 } } } }, 1))
      .toMatchObject({ reason: 'rate-limited', providerCode: 'httpConnectionFailed', httpStatus: 429 });
  });

  it('drops implausible reset times and reads planType from the multi-bucket view', () => {
    const out = projectCodexRateLimits({ rateLimits: null, rateLimitsByLimitId: {
      codex: { limitId: 'codex', planType: 'plus', primary: { usedPercent: 1, windowDurationMins: 60, resetsAt: 9_007_199_254_740 } },
      other: { limitId: 'x', primary: { usedPercent: 1, windowDurationMins: 60, resetsAt: 1 } },
    } });
    expect(out?.planType).toBe('plus');
    expect(out?.buckets.map((b) => b.primary?.resetsAt)).toEqual([null, null]);
  });

  it('never reads an unreadable finished check as pending, and counts the whole rollup', () => {
    const rows = [
      { __typename: 'CheckRun', name: 'done', status: 'COMPLETED' },
      { __typename: 'CheckRun', name: 'new', status: 'SOMETHING_NEW' },
      ...Array.from({ length: 101 }, (_, i) => ({ __typename: 'CheckRun', name: `c${i}`, status: 'COMPLETED', conclusion: 'SUCCESS' })),
    ];
    const s = summarizeChecks(rows);
    expect(s.checks[0].state).toBe('unknown');
    expect(s.checks[1].state).toBe('pending');
    expect(s.overall).toBe('failure');
    expect(s.counts).toEqual({ total: 103, passed: 101, failed: 1, pending: 1, skipped: 0 });
    expect(s.checks).toHaveLength(100);
    expect(s.truncated).toBe(true);
  });

  it('normalizes stored cancel progress and keeps a live pending entry requested', () => {
    expect(normalizeCancelProgress({ state: 'bogus', at: 5 }, 1)).toEqual({ state: 'unknown', at: 5 });
    expect(normalizeCancelProgress({ state: 'ended', endedAs: 'nope', evidence: 'screen', reason: 'x', at: -1 }, 7))
      .toEqual({ state: 'ended', evidence: 'screen', at: 7 });
    expect(effectiveCancelProgress({ createdAt: 3 }, false, 9)).toEqual({ state: 'requested', at: 3 });
    expect(effectiveCancelProgress({ createdAt: 3 }, true, 9)).toEqual({ state: 'unknown', reason: 'daemon-restart', at: 9 });
  });

  it('accepts an uppercase request id and lowercases it', () => {
    const upper = '3F1C2E4A-0B6D-4C1E-9A7F-2D8E5B6C7A90';
    expect(parseWorktreeCreateBody({ slug: 'a', requestId: upper })).toEqual({ ok: true, value: { slug: 'a', requestId: upper.toLowerCase() } });
  });
});
