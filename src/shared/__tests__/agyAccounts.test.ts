import { describe, expect, it } from 'vitest';
import {
  AGY_DEFAULT_COOLDOWN_MS,
  agyAccountRow,
  agyModelFamily,
  chooseAgyAccount,
  evaluateAgyQuota,
  type AgyAccount,
  type AgyAccountQuotaSnapshot,
} from '../agyAccounts';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const LATER = '2026-10-02T15:00:00Z';
const EARLIER = '2026-10-02T11:00:00Z';

function snap(buckets: Record<string, [number, string?]>): AgyAccountQuotaSnapshot {
  return {
    quota: Object.fromEntries(Object.entries(buckets).map(([k, [f, r]]) => [k, { remaining_fraction: f, ...(r ? { reset_time: r } : {}) }])),
    quotaCapturedAtMs: NOW - 60_000,
  };
}

function acct(email: string, extra: Partial<AgyAccount> = {}): AgyAccount {
  return { id: email, email, label: '', addedAt: 0, ...extra };
}

describe('evaluateAgyQuota', () => {
  it('treats a missing snapshot as usable with unknown remaining', () => {
    expect(evaluateAgyQuota(null, NOW)).toEqual({ usable: true, remaining: null, availableAtMs: null });
  });

  it('reports the lowest gating bucket', () => {
    const v = evaluateAgyQuota(snap({ 'gemini-5h': [0.8, LATER], 'gemini-weekly': [0.4, LATER] }), NOW);
    expect(v).toEqual({ usable: true, remaining: 0.4, availableAtMs: null });
  });

  it('blocks an exhausted bucket until its reset time', () => {
    const v = evaluateAgyQuota(snap({ 'gemini-5h': [0, LATER], 'gemini-weekly': [0.5, LATER] }), NOW);
    expect(v.usable).toBe(false);
    expect(v.availableAtMs).toBe(Date.parse(LATER));
  });

  it('counts a bucket whose reset has passed as refilled', () => {
    const v = evaluateAgyQuota(snap({ 'gemini-5h': [0, EARLIER] }), NOW);
    expect(v).toEqual({ usable: true, remaining: 1, availableAtMs: null });
  });

  it('blocks for the default window when no reset time is known', () => {
    const v = evaluateAgyQuota(snap({ 'gemini-5h': [0.01] }), NOW);
    expect(v.usable).toBe(false);
    expect(v.availableAtMs).toBe(NOW - 60_000 + AGY_DEFAULT_COOLDOWN_MS);
  });

  it('uses reset_in_seconds from the capture time when no reset_time is reported', () => {
    const captured = NOW - 60_000;
    const s: AgyAccountQuotaSnapshot = { quota: { 'gemini-5h': { remaining_fraction: 0, reset_in_seconds: 600 } }, quotaCapturedAtMs: captured };
    expect(evaluateAgyQuota(s, NOW)).toMatchObject({ usable: false, availableAtMs: captured + 600_000 });
    expect(evaluateAgyQuota(s, captured + 601_000).usable).toBe(true);
  });

  it('keeps a weekly reset_in_seconds held past the default 5-hour window', () => {
    const captured = NOW - 60_000;
    const twoDays = 2 * 24 * 3600;
    const s: AgyAccountQuotaSnapshot = { quota: { 'gemini-weekly': { remaining_fraction: 0, reset_in_seconds: twoDays } }, quotaCapturedAtMs: captured };
    const v = evaluateAgyQuota(s, captured + AGY_DEFAULT_COOLDOWN_MS + 1000);
    expect(v).toMatchObject({ usable: false, availableAtMs: captured + twoDays * 1000 });
  });

  it('does not hold a Gemini launch on spent third-party quota', () => {
    const s = snap({ 'gemini-5h': [0.9, LATER], 'gemini-weekly': [0.8, LATER], '3p-5h': [0.5, LATER], '3p-weekly': [0, LATER] });
    expect(evaluateAgyQuota(s, NOW)).toEqual({ usable: true, remaining: 0.8, availableAtMs: null });
    expect(evaluateAgyQuota(s, NOW, '3p')).toMatchObject({ usable: false, availableAtMs: Date.parse(LATER) });
  });

  it('holds a third-party launch on its own buckets only', () => {
    const s = snap({ 'gemini-5h': [0, LATER], '3p-5h': [0.7, LATER] });
    expect(evaluateAgyQuota(s, NOW, '3p')).toEqual({ usable: true, remaining: 0.7, availableAtMs: null });
  });

  it('ignores buckets that do not gate a launch', () => {
    expect(evaluateAgyQuota(snap({ 'image-daily': [0, LATER] }), NOW).usable).toBe(true);
  });
});

describe('agyAccountRow', () => {
  it('marks the active account by email', () => {
    expect(agyAccountRow(acct('a@x.com'), null, 'a@x.com', NOW).state).toBe('active');
    expect(agyAccountRow(acct('b@x.com'), null, 'a@x.com', NOW).state).toBe('ready');
  });

  it('puts reauth before quota', () => {
    const out = { quota: { 'gemini-5h': { remaining_fraction: 0, reset_time: new Date(NOW + 1000).toISOString() } } };
    expect(agyAccountRow(acct('a@x.com', { needsReauth: true }), out, null, NOW).state).toBe('needs-reauth');
    const exhausted = agyAccountRow(acct('a@x.com'), out, null, NOW);
    expect(exhausted.state).toBe('exhausted');
    expect(exhausted.availableAtMs).toBe(NOW + 1000);
  });

  it('ignores a cooldown left in an older accounts file: only the sensor marks an account out', () => {
    const legacy = { ...acct('a@x.com'), cooldownUntil: NOW + 1000 } as AgyAccount;
    expect(agyAccountRow(legacy, null, null, NOW).state).toBe('ready');
  });
});

describe('chooseAgyAccount', () => {
  const row = (email: string, s: AgyAccountQuotaSnapshot | null, active = false, extra: Partial<AgyAccount> = {}) =>
    agyAccountRow(acct(email, extra), s, active ? email : null, NOW);

  it('passes through with no accounts registered', () => {
    expect(chooseAgyAccount([])).toEqual({ ok: true, account: null, switched: false });
  });

  it('keeps the active account while it has quota', () => {
    const d = chooseAgyAccount([row('a@x.com', snap({ 'gemini-5h': [0.1, LATER] }), true), row('b@x.com', snap({ 'gemini-5h': [0.9, LATER] }))]);
    expect(d).toMatchObject({ ok: true, switched: false, account: { email: 'a@x.com' } });
  });

  it('switches to the account with the most quota when the active one is out', () => {
    const d = chooseAgyAccount([
      row('a@x.com', snap({ 'gemini-5h': [0, LATER] }), true),
      row('b@x.com', snap({ 'gemini-5h': [0.3, LATER] })),
      row('c@x.com', snap({ 'gemini-5h': [0.7, LATER] })),
      row('d@x.com', null),
    ]);
    expect(d).toMatchObject({ ok: true, switched: true, account: { email: 'c@x.com' } });
  });

  it('never holds a launch only because accounts need signing in again', () => {
    const d = chooseAgyAccount([row('a@x.com', null, true, { needsReauth: true }), row('b@x.com', null, false, { needsReauth: true })]);
    expect(d).toEqual({ ok: true, account: null, switched: false });
  });

  it('holds when the accounts left are out of quota or need signing in again', () => {
    const d = chooseAgyAccount([row('a@x.com', snap({ 'gemini-5h': [0, LATER] }), true), row('b@x.com', null, false, { needsReauth: true })]);
    expect(d).toEqual({ ok: false, reason: 'all-exhausted', availableAtMs: Date.parse(LATER) });
  });

  it('never switches to a never-measured account, and never holds while one is left', () => {
    const d = chooseAgyAccount([row('a@x.com', snap({ 'gemini-5h': [0, LATER] }), true), row('d@x.com', null)]);
    expect(d).toEqual({ ok: true, account: null, switched: false });
  });

  it('refuses when every account is out and names the earliest reset', () => {
    const d = chooseAgyAccount([
      row('a@x.com', snap({ 'gemini-5h': [0, LATER] }), true),
      row('b@x.com', snap({ 'gemini-weekly': [0, '2026-10-02T13:00:00Z'] })),
      row('c@x.com', null, false, { needsReauth: true }),
    ]);
    expect(d).toEqual({ ok: false, reason: 'all-exhausted', availableAtMs: Date.parse('2026-10-02T13:00:00Z') });
  });
});

describe('agy quota error in pane output', () => {
  it('shows as the pane status only', async () => {
    const { AgentDetector } = await import('../../main/pty/AgentDetector');
    const det = new AgentDetector();
    const events: Array<{ agent: string; status: string; message: string }> = [];
    det.onEvent((e) => events.push(e));
    det.feed('Antigravity CLI 1.2.14\r\n');
    det.feed('Error: RESOURCE_EXHAUSTED: you are out of quota for this model\r\n');
    expect(events.some((e) => e.agent === 'Antigravity CLI' && e.status === 'error' && e.message === 'Quota exhausted')).toBe(true);
  });
});

describe('agyModelFamily', () => {
  it.each([
    [null, 'gemini'],
    ['', 'gemini'],
    ['gemini-3.8-flash-low', 'gemini'],
    ['Gemini-3-pro', 'gemini'],
    ['claude-sonnet-4-5', '3p'],
    ['gpt-oss-120b-medium', '3p'],
  ])('%s → %s', (id, family) => {
    expect(agyModelFamily(id)).toBe(family);
  });
});
