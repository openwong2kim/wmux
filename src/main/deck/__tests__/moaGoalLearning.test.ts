import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MoaGoalLearning, draftTerms, failureSignature, normalizeLine, type GateOutcome } from '../moaGoalLearning';
import { MOA_GOAL_LIMITS } from '../../../shared/moaGoal';

let file: string;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'moa-learn-')), 'learning.json');
});

const TAIL_A = '> proj@1 test\n> node test.js\nFAIL /tmp/wt-aaa/feature.txt is broken (12ms)\nnpm ERR! code 1\n';
const TAIL_B = '> proj@1 test\n> node test.js\nFAIL /home/x/wt-bbb/feature.txt is broken (40ms)\n';
const out = (over: Partial<GateOutcome>): GateOutcome => ({ kind: 'failure', goalId: 'G-000001', repoRoot: '/repo', taskId: 't1', command: 'npm test', tail: TAIL_A, at: 1, ...over });

describe('failure signatures', () => {
  it('the same mistake on another path, time or hash has the same signature', () => {
    expect(failureSignature('npm test', TAIL_A).signature).toBe(failureSignature('npm test', TAIL_B).signature);
    expect(failureSignature('npm test', TAIL_A).summary).toBe('FAIL feature.txt is broken (<time>)');
  });
  it('a different failure or command has a different signature', () => {
    expect(failureSignature('npm test', 'FAIL other.txt missing').signature).not.toBe(failureSignature('npm test', TAIL_A).signature);
    expect(failureSignature('npm run lint', TAIL_A).signature).not.toBe(failureSignature('npm test', TAIL_A).signature);
  });
  it('a crash reads as its error line, not a stack frame', () => {
    const tail = 'test.js:2\nconst fs = x;\n      ^\n\nSyntaxError: Identifier fs has already been declared\n    at wrapSafe (node:internal/modules/cjs/loader:1515:18)\n\nNode.js v22.12.0\n';
    expect(failureSignature('npm test', tail).summary).toBe('SyntaxError: Identifier fs has already been declared');
  });
  it('normalizeLine strips colour, hashes and numbers', () => {
    expect(normalizeLine('\u001b[31mnot ok 3\u001b[0m at deadbeefcafe')).toBe('not ok N at <hash>');
  });
});

describe('learning loop', () => {
  it('one failure drafts nothing; the same failure in a second goal drafts one goal', () => {
    const l = new MoaGoalLearning(file, () => 5);
    expect(l.record(out({}))).toBeNull();
    // Same place again (a retry of the same goal/task) is not a repeat.
    expect(l.record(out({}))).toBeNull();
    const d = l.record(out({ goalId: 'G-000002', tail: TAIL_B }));
    expect(d).toMatchObject({ status: 'draft', repoRoot: '/repo', command: 'npm test', seen: [{ goalId: 'G-000001' }, { goalId: 'G-000002' }] });
    expect(d!.doneCriteria.join('\n')).toMatch(/FAILS on the original buggy code/);
    expect(d!.doneCriteria.join('\n')).toMatch(/PASSES with the fix/);
    // A third occurrence does not draft again.
    expect(l.record(out({ goalId: 'G-000003' }))).toBeNull();
    expect(l.drafts()).toHaveLength(1);
    // Persisted.
    expect(new MoaGoalLearning(file).drafts().map((x) => x.id)).toEqual([d!.id]);
  });

  it('two tasks of one goal also count as two places', () => {
    const l = new MoaGoalLearning(file);
    l.record(out({ taskId: 't1' }));
    expect(l.record(out({ taskId: 't2' }))).not.toBeNull();
  });

  it('flakes are recorded apart and never drafted, even when repeated', () => {
    const l = new MoaGoalLearning(file);
    expect(l.record(out({ kind: 'flake' }))).toBeNull();
    expect(l.record(out({ kind: 'flake', goalId: 'G-000002' }))).toBeNull();
    expect(l.flakes()).toHaveLength(2);
    expect(l.failures()).toHaveLength(0);
    expect(l.drafts()).toHaveLength(0);
    // A signature known to be flaky is not drafted from real failures either.
    l.record(out({}));
    expect(l.record(out({ goalId: 'G-000009' }))).toBeNull();
  });

  it('other repositories do not add up', () => {
    const l = new MoaGoalLearning(file);
    l.record(out({ repoRoot: '/a' }));
    expect(l.record(out({ repoRoot: '/b', goalId: 'G-000002' }))).toBeNull();
  });

  it('dismiss and approve settle a draft once; a dismissed signature is not drafted again', () => {
    const l = new MoaGoalLearning(file);
    l.record(out({}));
    const d = l.record(out({ goalId: 'G-000002' }))!;
    expect(l.dismiss(d.id)).toBe(true);
    expect(l.dismiss(d.id)).toBe(false);
    expect(l.markApproved(d.id, 'G-x')).toBe(false);
    expect(l.drafts()).toHaveLength(0);
    expect(l.record(out({ goalId: 'G-000004' }))).toBeNull();
  });

  it('draft terms fit the goal limits', () => {
    const t = draftTerms('npm test', 'x'.repeat(1000));
    expect(t.goal.length).toBeLessThanOrEqual(MOA_GOAL_LIMITS.GOAL_MAX_CHARS);
    for (const c of [...t.doneCriteria, ...t.evidence, ...t.constraints]) expect(c.length).toBeLessThanOrEqual(MOA_GOAL_LIMITS.TERMS_ITEM_MAX_CHARS);
    expect(t.doneCriteria.length).toBeLessThanOrEqual(MOA_GOAL_LIMITS.TERMS_MAX);
  });
});
