import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  raiseDecision,
  replaceStaleDecision,
  resolveDecision,
  clearDecision,
  clearResolvedDecision,
  loadWorkspaceDecision,
  hasPendingDecision,
  renderDecisionBlock,
  renderStaleDecisionBlock,
  isDecisionStale,
  getDeckDecisionPath,
  DECISION_LIMITS,
  type WorkspaceDecision,
} from '../deckDecisionStore';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-decision-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deckDecisionStore', () => {
  it('raises a pending decision and loads it back', async () => {
    const d = await raiseDecision('ws-1', { question: 'A or B?', options: ['A', 'B'], context: 'ctx' }, dir);
    expect(d).toMatchObject({ question: 'A or B?', options: ['A', 'B'], status: 'pending' });
    expect(d!.id).toBeTruthy();
    expect(loadWorkspaceDecision('ws-1', dir)).toMatchObject({ status: 'pending' });
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
    expect(hasPendingDecision('ws-2', dir)).toBe(false);
  });

  it('survives a fresh read from disk (durability)', async () => {
    await raiseDecision('ws-1', { question: 'persist?' }, dir);
    // A brand-new load (as a fresh process would do) sees the pending decision.
    expect(loadWorkspaceDecision('ws-1', dir)).toMatchObject({ question: 'persist?', status: 'pending' });
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
  });

  it('resolves only on a matching id + still-pending, and stops being pending', async () => {
    const d = (await raiseDecision('ws-1', { question: 'Q?' }, dir))!;
    // wrong id → no-op
    await resolveDecision('ws-1', 'not-the-id', 'X', dir);
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
    // empty answer → no-op
    await resolveDecision('ws-1', d.id, '   ', dir);
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
    // real resolve
    const r = await resolveDecision('ws-1', d.id, 'go with A', dir);
    expect(r).toMatchObject({ status: 'resolved', resolution: 'go with A' });
    expect(hasPendingDecision('ws-1', dir)).toBe(false);
    expect(loadWorkspaceDecision('ws-1', dir)!.status).toBe('resolved');
    // resolving again is a no-op (already resolved)
    await resolveDecision('ws-1', d.id, 'change', dir);
    expect(loadWorkspaceDecision('ws-1', dir)!.resolution).toBe('go with A');
  });

  it('clears a decision', async () => {
    await raiseDecision('ws-1', { question: 'Q?' }, dir);
    await clearDecision('ws-1', dir);
    expect(loadWorkspaceDecision('ws-1', dir)).toBeNull();
  });

  it('rejects bad workspace ids and caps oversized fields', async () => {
    expect(await raiseDecision('bad id!', { question: 'Q' }, dir)).toBeNull();
    expect(loadWorkspaceDecision('bad id!', dir)).toBeNull();
    const long = 'x'.repeat(5000);
    const d = (await raiseDecision(
      'ws-1',
      { question: long, options: Array.from({ length: 20 }, () => 'o'), context: long },
      dir,
    ))!;
    expect(d.question.length).toBe(DECISION_LIMITS.MAX_QUESTION_CHARS);
    expect(d.options.length).toBe(DECISION_LIMITS.MAX_OPTIONS);
    expect(d.context.length).toBe(DECISION_LIMITS.MAX_CONTEXT_CHARS);
  });

  it('a resolved record that lost its resolution loads back as pending (fail-closed)', async () => {
    writeFileSync(
      getDeckDecisionPath(dir),
      JSON.stringify({ 'ws-1': { id: 'x', question: 'Q', options: [], context: '', status: 'resolved', raisedAt: 1 } }),
    );
    expect(loadWorkspaceDecision('ws-1', dir)!.status).toBe('pending');
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
  });

  it('fails open on a torn file — no decision, never throws', () => {
    writeFileSync(getDeckDecisionPath(dir), '{ not json');
    expect(loadWorkspaceDecision('ws-1', dir)).toBeNull();
    expect(hasPendingDecision('ws-1', dir)).toBe(false);
  });

  it('renders pending and resolved blocks for the prompt seam', async () => {
    const d = (await raiseDecision('ws-1', { question: 'Ship it?', options: ['yes', 'no'] }, dir))!;
    const pending = renderDecisionBlock(d);
    expect(pending).toContain('BLOCKED');
    expect(pending).toContain('yes | no');
    const r = (await resolveDecision('ws-1', d.id, 'yes', dir))!;
    const resolved = renderDecisionBlock(r);
    expect(resolved).toContain('RESOLVED');
    expect(resolved).toContain('yes');
  });

  it('resolveDecision returns null on a stale resolve (no double-transition kick)', async () => {
    const d = (await raiseDecision('ws-1', { question: 'Q?' }, dir))!;
    expect(await resolveDecision('ws-1', d.id, 'answer', dir)).toMatchObject({ status: 'resolved' });
    // A second resolve of the now-resolved decision returns null so the caller
    // does not kick a duplicate resume turn (double-resume guard).
    expect(await resolveDecision('ws-1', d.id, 'again', dir)).toBeNull();
    expect(loadWorkspaceDecision('ws-1', dir)!.resolution).toBe('answer');
    // Wrong id → null, and the pending decision stays pending.
    const e = (await raiseDecision('ws-2', { question: 'Q2?' }, dir))!;
    expect(await resolveDecision('ws-2', 'wrong-id', 'x', dir)).toBeNull();
    expect(hasPendingDecision('ws-2', dir)).toBe(true);
    expect(e.id).toBeTruthy();
  });

  it('clearResolvedDecision consumes ONLY the matching resolved id, never a pending one', async () => {
    const d = (await raiseDecision('ws-1', { question: 'Q?' }, dir))!;
    await resolveDecision('ws-1', d.id, 'answer', dir);
    // A different id must not clear it (guards the "turn that raised a new
    // decision deletes the resolution it never carried" P1).
    await clearResolvedDecision('ws-1', 'other-id', dir);
    expect(loadWorkspaceDecision('ws-1', dir)?.status).toBe('resolved');
    // The matching id clears it.
    await clearResolvedDecision('ws-1', d.id, dir);
    expect(loadWorkspaceDecision('ws-1', dir)).toBeNull();
    // Never clears a PENDING decision, even with a matching id.
    const p = (await raiseDecision('ws-2', { question: 'P?' }, dir))!;
    await clearResolvedDecision('ws-2', p.id, dir);
    expect(hasPendingDecision('ws-2', dir)).toBe(true);
  });

  it('renderDecisionBlock output is byte-identical to the pre-WP3 wording (no drift for existing callers)', async () => {
    // The stale variant is a SIBLING — the plain pending/resolved output must not
    // have shifted, or withLoopContext / the UI hydrate would see different text.
    const d = (await raiseDecision('ws-1', { question: 'Ship it?', options: ['yes', 'no'], context: 'why' }, dir))!;
    expect(renderDecisionBlock(d)).toBe(
      [
        '[decision] BLOCKED — you are waiting on a human decision and must NOT proceed:',
        '  Ship it?',
        '  options: yes | no',
        '  context: why',
        'Do not act until the human resolves this. If they just messaged you, they may be answering — otherwise wait.',
      ].join('\n'),
    );
  });
});

describe('isDecisionStale', () => {
  const pending = (raisedAt: number): WorkspaceDecision => ({
    id: 'd1',
    question: 'Q?',
    options: [],
    context: '',
    status: 'pending',
    raisedAt,
  });

  it('is false before the TTL elapses and true strictly after', () => {
    const ttl = 30 * 60_000;
    const d = pending(1_000_000);
    expect(isDecisionStale(d, ttl, 1_000_000)).toBe(false); // age 0
    expect(isDecisionStale(d, ttl, 1_000_000 + ttl)).toBe(false); // exactly TTL — not yet stale
    expect(isDecisionStale(d, ttl, 1_000_000 + ttl + 1)).toBe(true); // one ms past
  });

  it('a resolved decision is never stale', () => {
    const d: WorkspaceDecision = { ...pending(0), status: 'resolved', resolution: 'x', resolvedAt: 1 };
    expect(isDecisionStale(d, 1_000, 10_000_000)).toBe(false);
  });

  it('a non-positive / non-finite TTL is never stale (guards a misconfigured 0)', () => {
    expect(isDecisionStale(pending(0), 0, 10_000_000)).toBe(false);
    expect(isDecisionStale(pending(0), Number.NaN, 10_000_000)).toBe(false);
  });

  it('a raisedAt of 0 (lost clock) reads as stale immediately (conservative)', () => {
    expect(isDecisionStale(pending(0), 30 * 60_000, 30 * 60_000 + 1)).toBe(true);
  });
});

describe('renderStaleDecisionBlock', () => {
  const base: WorkspaceDecision = {
    id: 'dec-42',
    question: 'Force-push to main?',
    options: ['yes', 'no'],
    context: 'CI is red',
    status: 'pending',
    raisedAt: 0,
  };

  it('auto mode carries the self-resolve instruction and the id', () => {
    const out = renderStaleDecisionBlock(base, { ttlMinutes: 30, mode: 'auto' });
    expect(out).toContain('STALE');
    expect(out).toContain('30+ minutes');
    expect(out).toContain('Force-push to main?');
    expect(out).toContain('options: yes | no');
    expect(out).toContain('id: dec-42');
    expect(out).toContain('deck_resolve_decision');
    expect(out).toContain('AUTO mode');
  });

  it('assist mode does NOT offer self-resolve (restate/wait only)', () => {
    const out = renderStaleDecisionBlock(base, { ttlMinutes: 30, mode: 'assist' });
    expect(out).toContain('STALE');
    expect(out).not.toContain('deck_resolve_decision');
    expect(out).toContain('may NOT resolve this yourself');
  });

  it('off mode also withholds self-resolve', () => {
    const out = renderStaleDecisionBlock(base, { ttlMinutes: 30, mode: 'off' });
    expect(out).not.toContain('deck_resolve_decision');
  });
});

// ─── 3-way review round 2 — CAS replace + resolution provenance ──────────────

describe('replaceStaleDecision (compare-and-swap)', () => {
  const TTL = 30 * 60_000;

  const seedPending = (raisedAt: number, id = 'dec-old'): void => {
    writeFileSync(
      getDeckDecisionPath(dir),
      JSON.stringify({
        'ws-1': {
          id,
          question: 'Old question?',
          options: [],
          context: '',
          status: 'pending',
          raisedAt,
        },
      }),
    );
  };

  it('replaces a STALE pending decision atomically', async () => {
    seedPending(Date.now() - TTL - 60_000);
    const next = await replaceStaleDecision(
      'ws-1',
      'dec-old',
      TTL,
      { question: 'Sharper question?' },
      dir,
    );
    expect(next).toMatchObject({ question: 'Sharper question?', status: 'pending' });
    expect(next!.id).not.toBe('dec-old');
    expect(loadWorkspaceDecision('ws-1', dir)).toMatchObject({ question: 'Sharper question?' });
  });

  it('refuses a FRESH pending decision (CAS re-checks staleness at write time)', async () => {
    seedPending(Date.now() - 60_000); // 1 min old
    const next = await replaceStaleDecision(
      'ws-1',
      'dec-old',
      TTL,
      { question: 'Sharper question?' },
      dir,
    );
    expect(next).toBeNull();
    expect(loadWorkspaceDecision('ws-1', dir)).toMatchObject({ question: 'Old question?' });
  });

  it('refuses an id mismatch (decision was already replaced)', async () => {
    seedPending(Date.now() - TTL - 60_000, 'dec-other');
    const next = await replaceStaleDecision(
      'ws-1',
      'dec-old',
      TTL,
      { question: 'Sharper question?' },
      dir,
    );
    expect(next).toBeNull();
  });

  it("NEVER overwrites the human's concurrent resolve — their answer survives", async () => {
    seedPending(Date.now() - TTL - 60_000);
    // The human resolves between the brain's check and its replace attempt.
    await resolveDecision('ws-1', 'dec-old', 'Human said: use the worktree.', dir);
    const next = await replaceStaleDecision(
      'ws-1',
      'dec-old',
      TTL,
      { question: 'Sharper question?' },
      dir,
    );
    expect(next).toBeNull(); // CAS lost
    expect(loadWorkspaceDecision('ws-1', dir)).toMatchObject({
      status: 'resolved',
      resolution: 'Human said: use the worktree.',
    });
  });
});

describe('resolution provenance (resolvedBy)', () => {
  it('defaults to human, tags brain when asked, and round-trips through sanitize', async () => {
    const d1 = (await raiseDecision('ws-1', { question: 'Q1?' }, dir))!;
    await resolveDecision('ws-1', d1.id, 'the human answer', dir);
    expect(loadWorkspaceDecision('ws-1', dir)).toMatchObject({ resolvedBy: 'human' });
    await clearDecision('ws-1', dir);

    const d2 = (await raiseDecision('ws-1', { question: 'Q2?' }, dir))!;
    await resolveDecision('ws-1', d2.id, 'per policy rule X, settled', dir, 'brain');
    // A fresh read from disk exercises sanitizeDecision — the tag must survive.
    expect(loadWorkspaceDecision('ws-1', dir)).toMatchObject({ resolvedBy: 'brain' });
  });
});

describe('renderDecisionBlock provenance (round 3)', () => {
  it('presents a brain self-resolution as the brain own answer, never the human', async () => {
    const d = (await raiseDecision('ws-1', { question: 'Q?' }, dir))!;
    await resolveDecision('ws-1', d.id, 'per policy rule, settled', dir, 'brain');
    const block = renderDecisionBlock(loadWorkspaceDecision('ws-1', dir)!);
    expect(block).toContain('RESOLVED (self)');
    expect(block).toContain('YOURSELF');
    expect(block).not.toContain('the human decided');
  });

  it('keeps the human-resolved wording byte-identical for human resolutions', async () => {
    const d = (await raiseDecision('ws-1', { question: 'Q?' }, dir))!;
    await resolveDecision('ws-1', d.id, 'human answer', dir);
    const block = renderDecisionBlock(loadWorkspaceDecision('ws-1', dir)!);
    expect(block).toContain('the human decided: human answer');
    expect(block).not.toContain('(self)');
  });
});
