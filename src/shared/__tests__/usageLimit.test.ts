import { describe, expect, it } from 'vitest';
import {
  claudeUsageLimitFromStopFailure,
  CodexUsageLimitLineScanner,
  exhaustedWindowResetAt,
  formatResetDuration,
  isCodexUsageLimitLine,
  parseUsageLimitReset,
  usageLimitHolds,
  usageLimitResumeDue,
  USAGE_LIMIT_RESUME_GRACE_MS,
  USAGE_LIMIT_UNKNOWN_HOLD_MS,
} from '../usageLimit';

// 2026-10-03T10:00:00Z = 19:00 in Asia/Seoul (UTC+9, no DST).
const NOW = Date.UTC(2026, 9, 3, 10, 0);

describe('parseUsageLimitReset', () => {
  it('reads a bare time in a named zone as its next occurrence', () => {
    // 3pm Seoul already passed today (19:00 there) → tomorrow 15:00 KST = 06:00Z.
    expect(parseUsageLimitReset("You've hit your limit · resets 3pm (Asia/Seoul)", NOW)).toBe(Date.UTC(2026, 9, 4, 6, 0));
    // 11:30pm Seoul is still ahead today → 14:30Z.
    expect(parseUsageLimitReset('5-hour limit reached ∙ resets 11:30pm (Asia/Seoul)', NOW)).toBe(Date.UTC(2026, 9, 3, 14, 30));
  });

  it('reads a dated reset, the epoch suffix and a relative duration', () => {
    expect(parseUsageLimitReset("You've hit your weekly limit · resets Oct 7, 9am (Asia/Seoul)", NOW)).toBe(Date.UTC(2026, 9, 7, 0, 0));
    expect(parseUsageLimitReset('Claude AI usage limit reached|1791000000', NOW)).toBe(1_791_000_000_000);
    expect(parseUsageLimitReset("You've hit your usage limit. Try again in 2 hours 13 minutes.", NOW)).toBe(NOW + (2 * 60 + 13) * 60_000);
    expect(parseUsageLimitReset('or try again at Oct 5th, 2026 3:05 PM.', NOW)).not.toBeNull();
  });

  it('returns null when nothing names a reset', () => {
    expect(parseUsageLimitReset("You've hit your limit", NOW)).toBeNull();
    expect(parseUsageLimitReset('resets 25pm', NOW)).toBeNull();
  });
});

describe('claudeUsageLimitFromStopFailure', () => {
  it('promotes a rate_limit StopFailure only when the text names a usage cap', () => {
    const hit = claudeUsageLimitFromStopFailure({ error: 'rate_limit', last_assistant_message: "You've hit your limit\n· resets 3pm (Asia/Seoul)" }, NOW);
    expect(hit).toEqual({ resetsAt: Date.UTC(2026, 9, 4, 6, 0), message: "You've hit your limit · resets 3pm (Asia/Seoul)" });
    // A plain 429 that exhausted retries is not a usage cap.
    expect(claudeUsageLimitFromStopFailure({ error: 'rate_limit', last_assistant_message: 'API Error: 429 rate_limit_error' }, NOW)).toBeNull();
    expect(claudeUsageLimitFromStopFailure({ error: 'billing_error', last_assistant_message: "You've hit your limit" }, NOW)).toBeNull();
  });
});

describe('Codex screen rows', () => {
  it('anchors the head at the row start so quoted text does not trigger', () => {
    expect(isCodexUsageLimitLine("■ You've hit your usage limit. Upgrade to Pro")).toBe(true);
    expect(isCodexUsageLimitLine("const CODEX = /You've hit your usage limit/;")).toBe(false);
  });

  it('picks the reset clause up from a wrapped following row', () => {
    const scanner = new CodexUsageLimitLineScanner(() => NOW);
    expect(scanner.feed("■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or")).toEqual({
      message: "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or",
    });
    const update = scanner.feed('try again in 45 minutes.');
    expect(update?.resetsAt).toBe(NOW + 45 * 60_000);
    expect(scanner.feed('try again in 10 minutes.')).toBeNull();
  });
});

describe('hold and resume', () => {
  it('holds until the reset plus grace, and caps an unknown reset', () => {
    const limit = { ptyId: 'p', provider: 'claude' as const, detectedAt: NOW, resetsAt: NOW + 60_000, source: 'hook' as const };
    expect(usageLimitHolds(limit, NOW + 60_000)).toBe(true);
    expect(usageLimitHolds(limit, NOW + 60_000 + USAGE_LIMIT_RESUME_GRACE_MS)).toBe(false);
    const unknown = { ...limit, resetsAt: undefined };
    expect(usageLimitHolds(unknown, NOW + USAGE_LIMIT_UNKNOWN_HOLD_MS - 1)).toBe(true);
    expect(usageLimitHolds(unknown, NOW + USAGE_LIMIT_UNKNOWN_HOLD_MS)).toBe(false);
  });

  it('never resumes unless armed explicitly', () => {
    const limit = { ptyId: 'p', provider: 'codex' as const, detectedAt: NOW, resetsAt: NOW, source: 'screen' as const };
    const later = NOW + USAGE_LIMIT_RESUME_GRACE_MS;
    expect(usageLimitResumeDue(limit, later)).toBe(false);
    expect(usageLimitResumeDue({ ...limit, autoResume: true }, later)).toBe(true);
    expect(usageLimitResumeDue({ ...limit, autoResume: true, resetsAt: undefined }, later)).toBe(false);
  });

  it('formats durations and finds the exhausted window', () => {
    expect(formatResetDuration(4 * 3_600_000 + 42 * 60_000)).toBe('4h 42m');
    expect(formatResetDuration(28 * 3_600_000)).toBe('1d 4h');
    expect(exhaustedWindowResetAt([{ pct: 100, resetsAt: 5 }, { pct: 40, resetsAt: 9 }, { pct: 101, resetsAt: 7 }])).toBe(7);
    expect(exhaustedWindowResetAt([{ pct: 99, resetsAt: 5 }])).toBeNull();
  });
});
