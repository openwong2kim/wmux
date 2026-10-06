import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MoaShadowLedger, getShadowLedgerPath, shadowKey, type ShadowDecisionRow } from '../moaShadowLedger';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-shadow-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const T0 = new Date(2026, 9, 7, 10, 0, 0).getTime();

function row(overrides: Partial<Omit<ShadowDecisionRow, 'kind' | 'mode'>> = {}): Omit<ShadowDecisionRow, 'kind' | 'mode'> {
  return {
    key: shadowKey('pty-a', 'rec-1'),
    askedAt: T0,
    askerPtyId: 'pty-a',
    question: 'Merge PR #12?',
    options: ['Yes', 'No'],
    packetHash: 'h1',
    verdict: 'answer',
    choiceKey: '1',
    ruleId: 'R-merge-green',
    reasonCode: 'rule_match',
    why: 'green',
    tokens: { input: 1500, output: 120 },
    ms: 4200,
    ...overrides,
  };
}

function lines(): Array<Record<string, unknown>> {
  return fs.readFileSync(getShadowLedgerPath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('MoaShadowLedger', () => {
  it('is idempotent: the same key and hash returns the existing row and writes nothing', async () => {
    const ledger = new MoaShadowLedger(dir, { now: () => T0 });
    const first = await ledger.record(row());
    const again = await ledger.record(row({ verdict: 'escalate', reasonCode: 'different' }));
    expect(first.existing).toBe(false);
    expect(again.existing).toBe(true);
    expect(again.row.verdict).toBe('answer');
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ kind: 'decision', mode: 'shadow', key: 'moa:pty-a:rec-1' });
  });

  it('records a different hash under the same key as id-reused, never judged', async () => {
    const ledger = new MoaShadowLedger(dir, { now: () => T0 });
    await ledger.record(row());
    const reused = await ledger.record(row({ packetHash: 'h2' }));
    expect(reused.row).toMatchObject({ verdict: 'escalate', reasonCode: 'id-reused', choiceKey: null, tokens: { input: 0, output: 0 } });
    expect(lines()).toHaveLength(2);
    // The first decision stays the one outcomes join against.
    expect(ledger.get(row().key)?.packetHash).toBe('h1');
  });

  it('joins the owner outcome: agree true/false, null for an escalation', async () => {
    const ledger = new MoaShadowLedger(dir, { now: () => T0 });
    await ledger.record(row());
    await ledger.record(row({ key: shadowKey('pty-b', 'r2'), askerPtyId: 'pty-b', choiceKey: '2' }));
    await ledger.record(row({ key: shadowKey('pty-c', 'r3'), askerPtyId: 'pty-c', verdict: 'escalate', choiceKey: null, ruleId: null }));
    expect((await ledger.noteOutcome(shadowKey('pty-a', 'rec-1'), 'resolved', '1', T0 + 5))?.agree).toBe(true);
    expect((await ledger.noteOutcome(shadowKey('pty-b', 'r2'), 'answered-in-terminal', '1'))?.agree).toBe(false);
    expect((await ledger.noteOutcome(shadowKey('pty-c', 'r3'), 'resolved', '1'))?.agree).toBeNull();
    // Second outcome for a key, and an outcome for an unjudged key: no-ops.
    expect(await ledger.noteOutcome(shadowKey('pty-a', 'rec-1'), 'resolved', '2')).toBeNull();
    expect(await ledger.noteOutcome('moa:x:y', 'resolved', '1')).toBeNull();
    const outcome = lines().find((l) => l['kind'] === 'outcome' && l['key'] === 'moa:pty-a:rec-1');
    expect(outcome).toMatchObject({ ownerChoiceKey: '1', resolvedAt: T0 + 5, agree: true });
    expect(ledger.stats()).toMatchObject({ decisions: 3, answered: 2, escalations: 1, compared: 2, agreed: 1 });
    expect(ledger.openKeys()).toEqual([]);
  });

  it('replays the file on boot and skips a torn last line', async () => {
    const a = new MoaShadowLedger(dir, { now: () => T0 });
    await a.record(row());
    await a.noteOutcome(row().key, 'resolved', '1');
    fs.appendFileSync(getShadowLedgerPath(dir), '{"kind":"decision","key":"moa:p:torn"');
    const b = new MoaShadowLedger(dir, { now: () => T0, log: () => undefined });
    expect(b.get(row().key)?.choiceKey).toBe('1');
    expect(b.hasOutcome(row().key)).toBe(true);
    expect(b.get('moa:p:torn')).toBeNull();
    expect((await b.record(row())).existing).toBe(true);
  });

  it('counts tokens and model calls since local midnight only', async () => {
    const ledger = new MoaShadowLedger(dir, { now: () => T0 });
    await ledger.record(row({ key: 'moa:p:old', askedAt: T0 - 24 * 3600_000 }));
    await ledger.record(row({ key: 'moa:p:today' }));
    await ledger.record(row({ key: 'moa:p:pre', verdict: 'escalate', reasonCode: 'always-escalate-release', tokens: { input: 0, output: 0 } }));
    await ledger.record(row({ key: 'moa:p:fail', verdict: 'escalate', reasonCode: 'judge-failed', tokens: { input: 0, output: 0 } }));
    expect(ledger.stats()).toMatchObject({ tokensToday: 1620, callsToday: 2 });
  });
});
